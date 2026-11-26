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
 * The server's Cloud Memory Brain will automatically record this boundary so other devices learn it. */
export class TaskDeclined extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaskDeclined';
    this.code = code;
    this.taskDeclined = true;
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

  markStarted(taskId) {
    if (this.#records.has(taskId)) return false;
    const entry = { type: 'exec', task_id: taskId, state: 'started', result: null };
    this.#records.set(taskId, entry);
    this.#append(entry);
    return true;
  }

  markFinished(taskId, result) {
    const entry = { type: 'exec', task_id: taskId, state: 'finished', result };
    this.#records.set(taskId, entry);
    this.#append(entry);
  }

  markReported(taskId) {
    const prev = this.#records.get(taskId);
    const entry = { type: 'exec', task_id: taskId, state: 'reported', result: prev?.result ?? null };
    this.#records.set(taskId, entry);
    this.#append(entry);
  }

  unfinishedResults() {
    const out = [];
    for (const r of this.#records.values()) {
      if (r.state === 'finished' && r.result) out.push({ task_id: r.task_id, result: r.result });
    }
    return out;
  }

  close() {}
}

/** Edge task worker supporting Protocol v3 WebSocket push, automatic lease heartbeats,
 * capability-free `onInvoke` handling, explicit `TaskDeclined`, and durable crash-safe journaling. */
export class AnyLinkWorker {
  #client; #handlers; #onInvoke; #journal; #binding;

  constructor({ client, handlers = {}, onInvoke, journalPath, journal }) {
    this.#client = client;
    this.#handlers = handlers;
    this.#onInvoke = onInvoke;
    this.#journal = journal ?? new FileJournal(journalPath);
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
    if (!entries.length) return { capabilities: [] };
    return this.#client.registerCapabilities(entries.map(([name, h]) => ({ name, description: h.description ?? '' })), options);
  }

  async #executeClaimed(task, { signal, socket } = {}) {
    if (!this.#journal.markStarted(task.id)) return { task, replayed: true, execution_unknown: true };
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    let active = true;
    const offCancel = socket?.on('task.cancel', frame => {
      if (frame.task_id === task.id) controller.abort(new Error('Task cancelled'));
    });

    // Periodic lease heartbeat: extends lease on the server AND detects cooperative cancellation.
    // Transient network blips do NOT abort a running handler (fixes v2 watch bug).
    const hbIntervalMs = Math.max(2000, Math.floor(((task.lease_seconds ?? 120) * 1000) / 3));
    const heartbeatLoop = (async () => {
      while (active && !controller.signal.aborted) {
        try {
          await delay(hbIntervalMs, undefined, { signal: controller.signal });
        } catch {
          break;
        }
        if (!active || controller.signal.aborted) break;
        try {
          const hb = socket?.connected
            ? (await socket.heartbeatTask(task.id)).heartbeat
            : await this.#client.heartbeatTask(task.id, { signal: controller.signal });
          if (hb?.cancel_requested) controller.abort(new Error('Task cancelled'));
        } catch {
          // Transient heartbeat error: retry next interval rather than killing in-flight work.
        }
      }
    })();

    const reportProgress = async progress => {
      if (!active) return;
      try {
        if (socket?.connected) await socket.reportProgress(task.id, progress);
        else await this.#client.reportProgress(task.id, progress, { signal: controller.signal });
      } catch {}
    };

    const resultKey = `result:${task.id}`;
    try {
      const handler = this.#handlers[task.capability];
      let result;
      try {
        controller.signal.throwIfAborted();
        if (handler) {
          const output = await handler.execute(task.input, { task, signal: controller.signal, reportProgress });
          result = { state: 'succeeded', output: output ?? {} };
        } else if (this.#onInvoke) {
          const output = await this.#onInvoke(task, { signal: controller.signal, reportProgress });
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
            error: { code: error.code ?? 'TASK_DECLINED', message: String(error.message ?? error).slice(0, 500), learn_boundary: true },
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

      this.#journal.markFinished(task.id, result);
      let completed;
      if (socket?.connected) {
        try {
          completed = (await socket.completeTask(task.id, result, { idempotencyKey: resultKey })).task;
        } catch {
          completed = await this.#client.completeTask(task.id, result, { idempotencyKey: resultKey });
        }
      } else {
        completed = await this.#client.completeTask(task.id, result, { idempotencyKey: resultKey });
      }
      this.#journal.markReported(task.id);
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
      results.push(await this.#client.completeTask(row.task_id, row.result, { idempotencyKey: `result:${row.task_id}` }));
      this.#journal.markReported(row.task_id);
    }
    return results;
  }

  /** Main worker loop: connects over WebSocket for instant task dispatch, falling back cleanly to HTTP polling. */
  async run({ signal, pollIntervalMs = 2000, useWebSocket = true } = {}) {
    if (Object.keys(this.#handlers).length > 0) await this.advertise({ signal });
    else await this.#bound();

    if (useWebSocket && typeof globalThis.WebSocket === 'function') {
      let socket = null;
      try {
        socket = await this.#client.connectWebSocket({ autoReconnect: true });
      } catch {
        socket = null;
      }
      if (socket) {
        let wakeup = null;
        const trigger = () => { if (wakeup) { const fn = wakeup; wakeup = null; fn(); } };
        const offAvail = socket.on('task.available', trigger);
        const offHello = socket.on('hello', trigger);
        const onAbort = () => { trigger(); socket.close(); };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          while (!signal?.aborted) {
            const ran = await this.runNext({ signal, socket }).catch(() => null);
            if (ran) continue;
            await Promise.race([
              new Promise(resolve => { wakeup = resolve; }),
              delay(Math.max(pollIntervalMs, 15000), undefined, { signal }).catch(() => {}),
            ]);
          }
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
