import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

/** Throw TaskFailure when the failure is definite and safe to report as `failed`. */
export class TaskFailure extends Error {
  constructor(code, message, { learnBoundary = false } = {}) {
    super(message);
    this.name = 'TaskFailure';
    this.code = code;
    this.taskFailure = true;
    this.learnBoundary = learnBoundary;
  }
}

/** Throw TaskDeclined when this edge agent cannot perform the requested task in its local environment.
 * By default the server's Cloud Memory Brain learns this boundary; pass `{ learnBoundary: false }` for
 * transient / per-file rejections (e.g. a single file exceeding receiver max_file_bytes or owner rejection). */
export class TaskDeclined extends Error {
  constructor(code, message, { learnBoundary = true } = {}) {
    super(message);
    this.name = 'TaskDeclined';
    this.code = code;
    this.taskDeclined = true;
    this.learnBoundary = learnBoundary;
  }
}

/** Zero-dependency durable JSONL execution journal (no experimental node:sqlite required). */
export class FileJournal {
  #file; #binding = null; #records = new Map();

  constructor(journalPath) {
    if (!journalPath || journalPath === ':memory:') throw new TypeError('Use a persistent private journalPath');
    this.#file = journalPath;
    fs.mkdirSync(path.dirname(path.resolve(journalPath)), { recursive: true, mode: 0o700 });
    fs.closeSync(fs.openSync(journalPath, 'a', 0o600));
    fs.chmodSync(journalPath, 0o600);
    this.#load();
  }

  #load() {
    const raw = fs.readFileSync(this.#file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'binding') this.#binding = entry;
        else if (entry.type === 'exec' && entry.task_id) this.#records.set(entry.task_id, entry);
      } catch {
        // Ignore truncated trailing line after an abrupt power loss.
      }
    }
  }

  #append(entry) {
    fs.appendFileSync(this.#file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  bind(server, deviceId, agentId) {
    if (!this.#binding) {
      this.#binding = { type: 'binding', server, device_id: deviceId, agent_id: agentId ?? null };
      this.#append(this.#binding);
      return;
    }
    if (this.#binding.server !== server || this.#binding.device_id !== deviceId || (this.#binding.agent_id !== null && agentId !== null && this.#binding.agent_id !== agentId)) {
      throw new Error('Journal belongs to another service or device; use its original identity or a separate journal');
    }
    if (this.#binding.agent_id === null && agentId !== null) {
      this.#binding = { ...this.#binding, agent_id: agentId };
      this.#append(this.#binding);
    }
  }

  markStarted(taskId, attempt = 1) {
    const prev = this.#records.get(taskId);
    if (prev && (prev.attempt ?? 1) >= attempt) return false;
    const entry = { type: 'exec', task_id: taskId, attempt, state: 'started', result: null };
    this.#records.set(taskId, entry);
    this.#append(entry);
    return true;
  }

  markFinished(taskId, result, leaseToken) {
    const prev = this.#records.get(taskId);
    const entry = { type: 'exec', task_id: taskId, attempt: prev?.attempt ?? 1, lease_token: leaseToken ?? null, state: 'finished', result };
    this.#records.set(taskId, entry);
    this.#append(entry);
  }

  markReported(taskId) {
    const prev = this.#records.get(taskId);
    const entry = { type: 'exec', task_id: taskId, attempt: prev?.attempt ?? 1, lease_token: prev?.lease_token ?? null, state: 'reported', result: prev?.result ?? null };
    this.#records.set(taskId, entry);
    this.#append(entry);
  }

  unfinishedResults() {
    const out = [];
    for (const r of this.#records.values()) {
      if (r.state === 'finished' && r.result) out.push({ task_id: r.task_id, result: r.result, lease_token: r.lease_token ?? undefined });
    }
    return out;
  }

  close() {}
}

const FENCE_ERROR_CODES = new Set(['TASK_NOT_ACTIVE', 'LEASE_FENCED', 'TASK_TERMINAL']);

/** Edge task worker supporting Protocol v3.2 WebSocket push, fencing lease heartbeats, concurrent slots,
 * interactive suspend/reply (askInput / requestApproval), explicit TaskDeclined, and crash-safe journaling. */
export class AnyLinkWorker {
  #client; #handlers; #onInvoke; #journal; #binding; #filePolicy;

  constructor({ client, handlers = {}, onInvoke, journalPath, journal, filePolicy }) {
    this.#client = client;
    this.#handlers = handlers;
    this.#onInvoke = onInvoke;
    this.#journal = journal ?? new FileJournal(journalPath);
    this.#filePolicy = filePolicy;
  }

  async #bound() {
    this.#binding ??= (async () => {
      const { device, agent } = await this.#client.identity();
      this.#journal.bind(this.#client.baseUrl, device.id, agent?.id ?? null);
    })();
    const binding = this.#binding;
    try {
      await binding;
    } catch (error) {
      if (this.#binding === binding) this.#binding = undefined;
      throw error;
    }
  }

  async advertise(options) {
    await this.#bound();
    const entries = Object.entries(this.#handlers);
    const resolvedPolicy = typeof this.#filePolicy === 'function' ? this.#filePolicy() : this.#filePolicy;
    if (!entries.length && resolvedPolicy === undefined) return { capabilities: [] };
    return this.#client.registerCapabilities(
      entries.map(([name, h]) => ({ name, description: h.description ?? '' })),
      { ...options, ...(resolvedPolicy !== undefined ? { filePolicy: resolvedPolicy } : {}) },
    );
  }

  async #executeClaimed(task, { signal, socket } = {}) {
    const attempt = task.attempt ?? 1;
    const leaseToken = task.lease_token ?? undefined;
    if (!this.#journal.markStarted(task.id, attempt)) return { task, replayed: true, execution_unknown: true };

    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    let active = true;
    let suspended = false;
    const offCancel = socket?.on('task.cancel', frame => {
      if (frame.task_id === task.id) controller.abort(new Error('Task cancelled'));
    });

    // Periodic fencing lease heartbeat: extends lease, checks cooperative cancel, and aborts immediately if fenced (409).
    const hbIntervalMs = Math.max(2000, Math.floor(((task.lease_seconds ?? 120) * 1000) / 3));
    const heartbeatLoop = (async () => {
      while (active && !controller.signal.aborted) {
        try {
          await delay(hbIntervalMs, undefined, { signal: controller.signal });
        } catch {
          break;
        }
        if (!active || controller.signal.aborted) break;
        if (suspended) continue;
        try {
          const hb = socket?.connected
            ? (await socket.heartbeatTask(task.id, { leaseToken })).heartbeat
            : await this.#client.heartbeatTask(task.id, { leaseToken, signal: controller.signal });
          if (hb?.cancel_requested) controller.abort(new Error('Task cancelled'));
        } catch (err) {
          if (err?.status === 409 || FENCE_ERROR_CODES.has(err?.code)) {
            controller.abort(err);
            break;
          }
          // Transient network blip: retry next interval rather than killing healthy in-flight work.
        }
      }
    })();

    const reportProgress = async progress => {
      if (!active) return;
      try {
        if (socket?.connected) await socket.reportProgress(task.id, progress, { leaseToken });
        else await this.#client.reportProgress(task.id, progress, { leaseToken, signal: controller.signal });
      } catch {}
    };

    const waitForInteraction = async (state, payload, timeoutSeconds = 600) => {
      suspended = true;
      try {
        if (socket?.connected) {
          await socket.suspendTask(task.id, { state, ...payload, timeout_seconds: timeoutSeconds }, { leaseToken });
        } else {
          await this.#client.suspendTask(task.id, { state, ...payload, timeout_seconds: timeoutSeconds }, { leaseToken, signal: controller.signal });
        }

        const deadline = Date.now() + timeoutSeconds * 1000;
        const reply = await new Promise((resolve, reject) => {
          let done = false;
          const finish = (fn, val) => {
            if (done) return;
            done = true;
            offResumed?.();
            clearInterval(poller);
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', onAbort);
            fn(val);
          };
          const onAbort = () => finish(reject, new Error('Task aborted while awaiting interaction'));
          const timer = setTimeout(() => finish(reject, new TaskFailure('INTERACTION_TIMEOUT', 'Timed out waiting for reply')), Math.max(1000, deadline - Date.now()));
          const offResumed = socket?.on('task.resumed', frame => {
            if (frame.task_id === task.id) finish(resolve, frame.reply ?? frame.task?.pending_interaction?.reply ?? {});
          });
          const poller = setInterval(() => {
            this.#client.task(task.id, { signal: controller.signal }).then(cur => {
              if (cur.state === 'running' && cur.pending_interaction?.resolved) {
                finish(resolve, cur.pending_interaction.reply ?? {});
              } else if (cur.state === 'declined') {
                finish(resolve, { approved: false, message: cur.result?.error?.message ?? 'Declined' });
              } else if (['cancelled', 'expired', 'unknown', 'failed'].includes(cur.state)) {
                finish(reject, new TaskFailure(cur.result?.error?.code ?? 'INTERACTION_ENDED', cur.result?.error?.message ?? `Task ended (${cur.state})`));
              }
            }).catch(() => {});
          }, 1500);
          poller.unref?.();
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        return reply;
      } finally {
        suspended = false;
      }
    };

    const askInput = (prompt, { choices, timeoutSeconds = 600 } = {}) =>
      waitForInteraction('awaiting_input', { prompt, ...(choices ? { choices } : {}) }, timeoutSeconds);

    const requestApproval = async (prompt, { riskLevel = 'medium', timeoutSeconds = 600 } = {}) => {
      const reply = await waitForInteraction('awaiting_approval', { prompt, risk_level: riskLevel }, timeoutSeconds);
      return { approved: reply?.approved !== false, message: reply?.message ?? '', data: reply?.data };
    };

    const resultKey = attempt > 1 ? `result:${task.id}:${attempt}` : `result:${task.id}`;
    try {
      const handler = this.#handlers[task.capability];
      let result;
      try {
        controller.signal.throwIfAborted();
        if (handler) {
          const output = await handler.execute(task.input, { task, signal: controller.signal, reportProgress, askInput, requestApproval });
          result = { state: 'succeeded', output: output ?? {} };
        } else if (this.#onInvoke) {
          const output = await this.#onInvoke(task, { signal: controller.signal, reportProgress, askInput, requestApproval });
          result = { state: 'succeeded', output: typeof output === 'string' ? { reply: output } : (output ?? {}) };
        } else {
          result = {
            state: 'declined',
            error: {
              code: 'CAPABILITY_UNAVAILABLE',
              message: `This agent cannot handle "${task.capability}" in its environment`,
              learn_boundary: true,
            },
          };
        }
      } catch (error) {
        if (error instanceof TaskDeclined || error?.taskDeclined === true) {
          result = {
            state: 'declined',
            error: { code: error.code ?? 'TASK_DECLINED', message: String(error.message ?? error).slice(0, 500), ...(error.learnBoundary === false ? { learn_boundary: false } : { learn_boundary: true }) },
          };
        } else if (error instanceof TaskFailure || error?.taskFailure === true) {
          result = {
            state: 'failed',
            error: { code: error.code ?? 'TASK_FAILED', message: String(error.message ?? error).slice(0, 500), ...(error.learnBoundary ? { learn_boundary: true } : {}) },
          };
        } else {
          result = {
            state: 'unknown',
            error: {
              code: controller.signal.aborted ? 'INTERRUPTED_OUTCOME_UNKNOWN' : 'HANDLER_OUTCOME_UNKNOWN',
              message: 'The host handler did not return a durable result; inspect its effects before retrying',
            },
          };
        }
      }

      this.#journal.markFinished(task.id, result, leaseToken);
      let completed;
      try {
        if (socket?.connected) {
          try {
            completed = (await socket.completeTask(task.id, result, { idempotencyKey: resultKey, leaseToken })).task;
          } catch (wsErr) {
            if (FENCE_ERROR_CODES.has(wsErr?.code)) throw wsErr;
            completed = await this.#client.completeTask(task.id, result, { idempotencyKey: resultKey, leaseToken });
          }
        } else {
          completed = await this.#client.completeTask(task.id, result, { idempotencyKey: resultKey, leaseToken });
        }
        this.#journal.markReported(task.id);
      } catch (err) {
        if (err?.status === 409 || FENCE_ERROR_CODES.has(err?.code)) {
          // Server already finalized/fenced this attempt (e.g. approval declined or lease expired); mark reported so we never spam retries.
          this.#journal.markReported(task.id);
          return { task, replayed: false, fenced: true, execution_unknown: result.state === 'unknown' };
        }
        throw err;
      }
      return { task: completed, replayed: false, execution_unknown: result.state === 'unknown' };
    } finally {
      active = false;
      offCancel?.();
      controller.abort();
      await heartbeatLoop;
      signal?.removeEventListener('abort', abort);
    }
  }

  /** Claim and execute at most one queued task over HTTP (or provided WS socket). */
  async runNext({ signal, taskId, socket } = {}) {
    await this.#bound();
    const claimed = socket?.connected
      ? await socket.claimTask({ taskId })
      : await this.#client.claimTask({ taskId, signal });
    const task = claimed?.task;
    if (!task) return null;
    if (!socket?.connected) {
      const current = await this.#client.task(task.id, { signal });
      if (current.state !== 'running') return { task: current, replayed: true, execution_unknown: current.state === 'unknown' };
    }
    return this.#executeClaimed(task, { signal, socket });
  }

  /** Re-send any durable finished results whose server confirmation was lost; never re-run started rows. */
  async recoverResults() {
    await this.#bound();
    const results = [];
    for (const row of this.#journal.unfinishedResults()) {
      try {
        results.push(await this.#client.completeTask(row.task_id, row.result, { idempotencyKey: `result:${row.task_id}`, leaseToken: row.lease_token }));
        this.#journal.markReported(row.task_id);
      } catch (err) {
        if (err?.status === 409 || FENCE_ERROR_CODES.has(err?.code)) {
          this.#journal.markReported(row.task_id);
        } else {
          throw err;
        }
      }
    }
    return results;
  }

  /** Main worker loop: recovers pending results on start & reconnect, dispatches concurrently up to maxConcurrency over WS (with HTTP fallback). */
  async run({ signal, pollIntervalMs = 2000, useWebSocket = true, maxConcurrency = 2 } = {}) {
    if (Object.keys(this.#handlers).length > 0) await this.advertise({ signal });
    else await this.#bound();
    await this.recoverResults().catch(() => {});

    const concurrency = Math.max(1, Math.min(16, Number(maxConcurrency) || 1));

    if (useWebSocket && typeof globalThis.WebSocket === 'function') {
      let socket = null;
      try {
        socket = await this.#client.connectWebSocket({ autoReconnect: true });
      } catch {
        socket = null;
      }
      if (socket) {
        let wakeup = null;
        const inFlight = new Set();
        const trigger = () => { if (wakeup) { const fn = wakeup; wakeup = null; fn(); } };
        const offAvail = socket.on('task.available', trigger);
        const offHello = socket.on('hello', () => {
          void this.recoverResults().catch(() => {});
          trigger();
        });
        const onAbort = () => { trigger(); socket.close(); };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          while (!signal?.aborted) {
            let claimedAny = false;
            while (!signal?.aborted && inFlight.size < concurrency) {
              let task = null;
              try {
                const claimed = socket.connected
                  ? await socket.claimTask()
                  : await this.#client.claimTask({ signal });
                task = claimed?.task ?? null;
              } catch {
                task = null;
              }
              if (!task) break;
              claimedAny = true;
              const job = this.#executeClaimed(task, { signal, socket })
                .catch(() => {})
                .finally(() => { inFlight.delete(job); trigger(); });
              inFlight.add(job);
            }
            if (claimedAny && inFlight.size < concurrency) continue;
            await Promise.race([
              new Promise(resolve => { wakeup = resolve; }),
              delay(Math.max(pollIntervalMs, 15000), undefined, { signal }).catch(() => {}),
            ]);
          }
          await Promise.allSettled([...inFlight]);
        } finally {
          offAvail();
          offHello();
          signal?.removeEventListener('abort', onAbort);
          socket.close();
        }
        return;
      }
    }

    while (!signal?.aborted) {
      await this.runNext({ signal });
      try { await delay(pollIntervalMs, undefined, { signal }); }
      catch (error) { if (!signal?.aborted) throw error; }
    }
  }

  close() { this.#journal.close(); }
}
