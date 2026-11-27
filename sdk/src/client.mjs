import fs from 'node:fs';
import path from 'node:path';

export class AnyLinkError extends Error {
  constructor(message, { code = 'ANYLINK_ERROR', status = 0, requestId, idempotencyKey, submissionUnknown = false, cause } = {}) {
    super(message, { cause });
    this.name = 'AnyLinkError';
    Object.assign(this, { code, status, requestId, idempotencyKey, submissionUnknown });
  }
}

function checkBaseUrl(baseUrl) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || !['http:', 'https:'].includes(base.protocol)) {
    throw new TypeError('Use an HTTP(S) base URL without credentials, query or fragment');
  }
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new TypeError('Remote AnyLink connections require HTTPS or a loopback tunnel');
  }
  return base.href.replace(/\/$/, '') + '/';
}

const fullJitterDelay = (attempt, baseMs = 1000, capMs = 30000) =>
  Math.max(100, Math.floor(Math.random() * Math.min(capMs, baseMs * Math.pow(2, Math.min(attempt, 5)))));

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const onAbort = () => { clearTimeout(t); reject(signal.reason); };
  const t = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** Persistent JSONL offline outbox for edge memory ingestion when the network is temporarily unreachable. */
export class MemoryOutbox {
  #file; #maxItems;
  constructor(filePath, { maxItems = 100 } = {}) {
    this.#file = filePath;
    this.#maxItems = maxItems;
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 });
  }

  enqueue(payload) {
    const items = this.list();
    items.push({ queued_at: new Date().toISOString(), payload });
    while (items.length > this.#maxItems) items.shift();
    fs.writeFileSync(this.#file, items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), { mode: 0o600 });
  }

  list() {
    if (!fs.existsSync(this.#file)) return [];
    return fs.readFileSync(this.#file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }

  async flush(client) {
    const items = this.list();
    if (!items.length) return 0;
    let sent = 0;
    const remaining = [];
    for (let i = 0; i < items.length; i++) {
      try {
        await client.ingestMemory(items[i].payload);
        sent++;
      } catch {
        remaining.push(...items.slice(i));
        break;
      }
    }
    fs.writeFileSync(this.#file, remaining.map(r => JSON.stringify(r)).join('\n') + (remaining.length ? '\n' : ''), { mode: 0o600 });
    return sent;
  }
}

/** Real-time WebSocket connection to /edge/v1/ws with automatic auth, pong watchdog, Full Jitter reconnect & seq cursor resume. */
export class AnyLinkSocket extends EventTarget {
  #wsUrl; #token; #WebSocketImpl; #ws = null; #closed = false; #pending = new Map();
  #pingTimer = null; #pongTimer = null; #reconnectTimer = null; #attempt = 0;
  #lastSeq = 0; #pingIntervalMs; #pongTimeoutMs; #reconnectEnabled = false;

  constructor({ wsUrl, token, WebSocketImpl = globalThis.WebSocket, resumeAfterSeq = 0, pingIntervalMs = 20000, pongTimeoutMs = 15000 }) {
    super();
    if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket implementation is unavailable in this runtime');
    this.#wsUrl = wsUrl;
    this.#token = token;
    this.#WebSocketImpl = WebSocketImpl;
    this.#lastSeq = Number.isInteger(resumeAfterSeq) && resumeAfterSeq > 0 ? resumeAfterSeq : 0;
    this.#pingIntervalMs = pingIntervalMs;
    this.#pongTimeoutMs = pongTimeoutMs;
  }

  get connected() { return this.#ws?.readyState === 1; }
  get lastSeq() { return this.#lastSeq; }

  async connect({ timeoutMs = 15000, autoReconnect = true } = {}) {
    this.#closed = false;
    await this.#openOnce(timeoutMs);
    if (autoReconnect && !this.#reconnectEnabled) {
      this.#reconnectEnabled = true;
      this.#enableReconnect(timeoutMs);
    }
    return this;
  }

  #clearPongWatchdog() {
    if (this.#pongTimer) { clearTimeout(this.#pongTimer); this.#pongTimer = null; }
  }

  #openOnce(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { ws.close(); } catch {} reject(new AnyLinkError('WebSocket auth timeout', { code: 'WS_TIMEOUT' })); }
      }, timeoutMs);
      const ws = new this.#WebSocketImpl(this.#wsUrl);
      this.#ws = ws;

      const onMessage = event => {
        this.#clearPongWatchdog();
        let frame;
        try { frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
        if (typeof frame.seq === 'number' && frame.seq > this.#lastSeq) this.#lastSeq = frame.seq;
        if (frame.type === 'hello') {
          this.#attempt = 0;
          if (typeof frame.latest_event_seq === 'number' && this.#lastSeq === 0) {
            this.#lastSeq = frame.latest_event_seq;
          }
          if (!settled) { settled = true; clearTimeout(timer); resolve(frame); }
          this.#startPing();
          this.dispatchEvent(new CustomEvent('hello', { detail: frame }));
          return;
        }
        if (frame.type === 'error' && !settled) {
          settled = true; clearTimeout(timer);
          reject(new AnyLinkError(frame.message ?? 'WebSocket auth failed', { code: frame.code ?? 'WS_AUTH_FAILED' }));
          return;
        }
        if (frame.request_id && this.#pending.has(frame.request_id)) {
          const waiter = this.#pending.get(frame.request_id);
          this.#pending.delete(frame.request_id);
          clearTimeout(waiter.timer);
          if (frame.type === 'error') waiter.reject(new AnyLinkError(frame.message ?? 'WS request failed', { code: frame.code ?? 'WS_ERROR' }));
          else waiter.resolve(frame);
        }
        this.dispatchEvent(new CustomEvent(frame.type, { detail: frame }));
        this.dispatchEvent(new CustomEvent('frame', { detail: frame }));
      };

      ws.addEventListener('open', () => {
        const authFrame = { type: 'auth', token: this.#token };
        if (this.#lastSeq > 0) authFrame.resume_after_seq = this.#lastSeq;
        ws.send(JSON.stringify(authFrame));
      });
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', err => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new AnyLinkError('WebSocket connection error', { code: 'WS_ERROR', cause: err })); }
      });
      ws.addEventListener('close', ev => {
        this.#stopPing();
        if (this.#ws === ws) this.#ws = null;
        for (const [id, waiter] of this.#pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new AnyLinkError('WebSocket closed before response', { code: 'WS_CLOSED', submissionUnknown: true }));
          this.#pending.delete(id);
        }
        if (!settled) { settled = true; clearTimeout(timer); reject(new AnyLinkError(`WebSocket closed (${ev.code})`, { code: 'WS_CLOSED' })); }
        if (ev.code === 4001 || ev.code === 4003) {
          this.#closed = true;
          this.dispatchEvent(new CustomEvent('auth_error', { detail: { code: ev.code, reason: ev.reason } }));
        }
        this.dispatchEvent(new CustomEvent('close', { detail: { code: ev.code, reason: ev.reason } }));
      });
    });
  }

  #enableReconnect(timeoutMs) {
    this.addEventListener('close', ev => {
      const code = ev.detail?.code;
      if (this.#closed || code === 4001 || code === 4003) return;
      const delayMs = fullJitterDelay(this.#attempt++);
      this.#reconnectTimer = setTimeout(() => {
        if (this.#closed) return;
        this.#openOnce(timeoutMs).catch(() => {});
      }, delayMs);
      this.#reconnectTimer.unref?.();
    });
  }

  #startPing() {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      if (!this.connected) return;
      try {
        this.#ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        if (!this.#pongTimer) {
          this.#pongTimer = setTimeout(() => {
            this.#pongTimer = null;
            try { this.#ws?.close(4000, 'Pong timeout'); } catch {}
          }, this.#pongTimeoutMs);
          this.#pongTimer.unref?.();
        }
      } catch {
        try { this.#ws?.close(4000, 'Ping failed'); } catch {}
      }
    }, this.#pingIntervalMs);
    this.#pingTimer.unref?.();
  }

  #stopPing() {
    if (this.#pingTimer) { clearInterval(this.#pingTimer); this.#pingTimer = null; }
    this.#clearPongWatchdog();
  }

  on(type, listener) {
    const wrapped = ev => listener(ev.detail);
    this.addEventListener(type, wrapped);
    return () => this.removeEventListener(type, wrapped);
  }

  sendRpc(frame, { timeoutMs = 15000 } = {}) {
    if (!this.connected) return Promise.reject(new AnyLinkError('WebSocket is not connected', { code: 'WS_DISCONNECTED' }));
    const requestId = frame.request_id ?? crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new AnyLinkError('WebSocket RPC timed out', { code: 'WS_TIMEOUT', submissionUnknown: true }));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ ...frame, request_id: requestId }));
    });
  }

  claimTask({ taskId, idempotencyKey = crypto.randomUUID(), timeoutMs = 15000 } = {}) {
    return this.sendRpc({ type: 'task.claim', idempotency_key: idempotencyKey, ...(taskId ? { task_id: taskId } : {}) }, { timeoutMs });
  }

  heartbeatTask(taskId, { extendSeconds, leaseToken, timeoutMs = 10000 } = {}) {
    return this.sendRpc({
      type: 'task.heartbeat',
      task_id: taskId,
      ...(extendSeconds ? { extend_seconds: extendSeconds } : {}),
      ...(leaseToken ? { lease_token: leaseToken } : {}),
    }, { timeoutMs });
  }

  reportProgress(taskId, progress, { leaseToken, timeoutMs = 10000 } = {}) {
    return this.sendRpc({
      type: 'task.progress',
      task_id: taskId,
      progress,
      ...(leaseToken ? { lease_token: leaseToken } : {}),
    }, { timeoutMs });
  }

  suspendTask(taskId, body, { leaseToken, timeoutMs = 10000 } = {}) {
    return this.sendRpc({
      type: 'task.suspend',
      task_id: taskId,
      ...body,
      ...(leaseToken ? { lease_token: leaseToken } : {}),
    }, { timeoutMs });
  }

  replyTask(taskId, body, { idempotencyKey = crypto.randomUUID(), timeoutMs = 10000 } = {}) {
    return this.sendRpc({
      type: 'task.reply',
      task_id: taskId,
      idempotency_key: idempotencyKey,
      ...body,
    }, { timeoutMs });
  }

  ackReceipt(taskId, { timeoutMs = 10000 } = {}) {
    return this.sendRpc({ type: 'task.receipt_ack', task_id: taskId }, { timeoutMs });
  }

  completeTask(taskId, result, { idempotencyKey = `result:${taskId}`, leaseToken, timeoutMs = 15000 } = {}) {
    const payload = leaseToken ? { ...result, lease_token: leaseToken } : result;
    return this.sendRpc({ type: 'task.result', task_id: taskId, idempotency_key: idempotencyKey, result: payload }, { timeoutMs });
  }

  cancelTask(taskId, { idempotencyKey = crypto.randomUUID(), timeoutMs = 10000 } = {}) {
    return this.sendRpc({ type: 'task.cancel', task_id: taskId, idempotency_key: idempotencyKey }, { timeoutMs });
  }

  close() {
    this.#closed = true;
    this.#stopPing();
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    try { this.#ws?.close(1000, 'Client closed'); } catch {}
    this.#ws = null;
  }
}

/** Harness-independent client for AnyLink Protocol v3.2 (HTTP + WebSocket + Cloud Memory Brain + Model Gateway + Artifacts). */
export class AnyLinkClient {
  #base; #token; #fetch; #timeout; #WebSocketImpl; #outbox;
  get baseUrl() { return this.#base; }

  constructor({ baseUrl, token, fetch: transport = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timeoutMs = 30000, outboxPath } = {}) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new TypeError('A device credential is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    this.#base = checkBaseUrl(baseUrl);
    this.#token = token;
    this.#fetch = transport;
    this.#WebSocketImpl = WebSocketImpl;
    this.#timeout = timeoutMs;
    this.#outbox = outboxPath ? new MemoryOutbox(outboxPath) : null;
  }

  /** Join with the owner join key or login password: upserts the install's device and agent, returns a fresh credential. */
  static async connect({ baseUrl, joinKey, password, installId, device, agent, fetch: transport = globalThis.fetch, timeoutMs = 30000 }) {
    const base = checkBaseUrl(baseUrl);
    const secret = joinKey ?? password;
    if (typeof secret !== 'string' || !secret.trim() || /[\r\n]/.test(secret)) throw new TypeError('A join key or login password is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    let response;
    try {
      response = await transport(new URL('edge/v1/connect', base), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device: {
            install_id: installId,
            name: device?.name,
            platform: device?.platform ?? 'other',
            ...(device?.slug !== undefined ? { slug: device.slug } : {}),
          },
          agent: {
            key: agent?.key,
            name: agent?.name,
            ...(agent?.kind !== undefined ? { kind: agent.kind } : {}),
            ...(agent?.summary !== undefined ? { summary: agent.summary } : {}),
          },
        }),
      });
    } catch (cause) {
      throw new AnyLinkError('AnyLink connect failed', { code: 'TRANSPORT_ERROR', cause });
    }
    const requestId = response.headers.get('x-anylink-request-id') ?? undefined;
    if (!response.ok) {
      let data; try { data = await response.json(); } catch {}
      throw new AnyLinkError(data?.error?.message ?? `AnyLink HTTP ${response.status}`, { code: data?.error?.code ?? 'HTTP_ERROR', status: response.status, requestId: data?.request_id ?? requestId });
    }
    try { return await response.json(); } catch (cause) { throw new AnyLinkError('AnyLink response was incomplete', { code: 'INVALID_RESPONSE', requestId, cause }); }
  }

  wsUrl() {
    const u = new URL('edge/v1/ws', this.#base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.href;
  }

  async connectWebSocket(options = {}) {
    const sock = new AnyLinkSocket({
      wsUrl: this.wsUrl(),
      token: this.#token,
      WebSocketImpl: options.WebSocketImpl ?? this.#WebSocketImpl,
      resumeAfterSeq: options.resumeAfterSeq ?? 0,
      pingIntervalMs: options.pingIntervalMs,
      pongTimeoutMs: options.pongTimeoutMs,
    });
    if (this.#outbox) {
      sock.on('hello', () => { void this.#outbox.flush(this).catch(() => {}); });
    }
    return sock.connect(options);
  }

  async #request(method, reqPath, body, { idempotencyKey, signal, raw = false, headers = {}, safeRetry = false } = {}) {
    const writing = !['GET', 'HEAD'].includes(method);
    const key = writing && idempotencyKey !== false ? (idempotencyKey ?? crypto.randomUUID()) : undefined;
    const retryable = !writing || safeRetry;
    const maxAttempts = retryable ? 3 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const requestSignal = AbortSignal.any([AbortSignal.timeout(this.#timeout), ...(signal ? [signal] : [])]);
      let response;
      try {
        const isRawBody = body instanceof Uint8Array || Buffer.isBuffer(body);
        response = await this.#fetch(new URL(reqPath, this.#base), {
          method,
          redirect: 'error',
          signal: requestSignal,
          headers: {
            Authorization: `Bearer ${this.#token}`,
            ...(body !== undefined && !isRawBody ? { 'Content-Type': 'application/json' } : {}),
            ...(key ? { 'Idempotency-Key': key } : {}),
            ...headers,
          },
          ...(body !== undefined ? { body: isRawBody ? body : JSON.stringify(body) } : {}),
        });
      } catch (cause) {
        if (retryable && attempt + 1 < maxAttempts && !signal?.aborted) {
          await sleep(fullJitterDelay(attempt, 200, 1000), signal);
          continue;
        }
        throw new AnyLinkError(writing ? 'Submission outcome is unknown; do not repeat execution blindly' : 'AnyLink request failed', { code: writing ? 'SUBMISSION_UNKNOWN' : 'TRANSPORT_ERROR', idempotencyKey: key, submissionUnknown: writing, cause });
      }
      if (retryable && [502, 503, 504].includes(response.status) && attempt + 1 < maxAttempts && !signal?.aborted) {
        await response.body?.cancel?.().catch(() => {});
        await sleep(fullJitterDelay(attempt, 200, 1000), signal);
        continue;
      }
      const requestId = response.headers.get('x-anylink-request-id') ?? undefined;
      if (!response.ok) {
        let data; try { data = await response.json(); } catch {}
        throw new AnyLinkError(data?.error?.message ?? `AnyLink HTTP ${response.status}`, { code: data?.error?.code ?? 'HTTP_ERROR', status: response.status, requestId: data?.request_id ?? requestId, idempotencyKey: key, submissionUnknown: writing && response.status >= 500 && data?.error?.code !== 'PROVIDER_NOT_CONFIGURED' });
      }
      if (raw) return response;
      try { return await response.json(); } catch (cause) { throw new AnyLinkError('AnyLink response was incomplete', { code: writing ? 'SUBMISSION_UNKNOWN' : 'INVALID_RESPONSE', requestId, idempotencyKey: key, submissionUnknown: writing, cause }); }
    }
  }

  // Identity & discovery
  protocol(options) { return this.#request('GET', 'edge/v1/protocol', undefined, options); }
  directory(options) { return this.#request('GET', 'edge/v1/directory', undefined, options); }
  /** @deprecated Compatibility shim; use directory(). */
  peers(options) { return this.#request('GET', 'edge/v1/link/peers', undefined, options); }
  persona(options) { return this.#request('GET', 'edge/v1/persona', undefined, options); }
  identity(options) { return this.#request('GET', 'edge/v1/identity', undefined, options); }
  events({ afterSeq = 0, limit = 100 } = {}, options) {
    return this.#request('GET', `edge/v1/events?after_seq=${encodeURIComponent(afterSeq)}&limit=${encodeURIComponent(limit)}`, undefined, options);
  }
  updateProfile(profile, options = {}) { return this.#request('PATCH', 'edge/v1/agent/profile', profile, { idempotencyKey: false, ...options }); }
  updateDeviceProfile(profile, options = {}) { return this.#request('PATCH', 'edge/v1/device/profile', profile, { idempotencyKey: false, ...options }); }
  adoptInstallId(installId, options = {}) { return this.#request('POST', 'edge/v1/device/install-id', { install_id: installId }, { idempotencyKey: false, ...options }); }

  // Cloud Memory Brain v3
  assembleMemory(query = {}, options = {}) { return this.#request('POST', 'edge/v1/memory/assemble', query, { idempotencyKey: false, safeRetry: true, ...options }); }
  async ingestMemory(payload, options = {}) {
    try {
      return await this.#request('POST', 'edge/v1/memory/ingest', payload, { idempotencyKey: false, ...options });
    } catch (err) {
      if (this.#outbox && (!err.status || err.status >= 500)) {
        this.#outbox.enqueue(payload);
        return { queued_offline: true };
      }
      throw err;
    }
  }
  flushMemoryOutbox() { return this.#outbox ? this.#outbox.flush(this) : Promise.resolve(0); }
  episodes(query = {}, options) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    return this.#request('GET', 'edge/v1/memory/episodes' + (qs ? '?' + qs : ''), undefined, options);
  }
  context(options) { return this.#request('GET', 'edge/v1/context', undefined, options); }
  searchMemories(query = {}, options) { return this.#request('POST', 'edge/v1/memories/search', query, { safeRetry: true, ...options, idempotencyKey: false }); }
  saveMemory(memory, options) { return this.#request('POST', 'edge/v1/memories', memory, options); }
  updateMemory(id, revision, patch, options) { return this.#request('PATCH', `edge/v1/memories/${encodeURIComponent(id)}`, { ...patch, expected_revision: revision }, options); }
  deleteMemory(id, revision, options) { return this.#request('DELETE', `edge/v1/memories/${encodeURIComponent(id)}`, undefined, { ...options, headers: { 'If-Match': String(revision) } }); }

  // Binary Artifacts (Protocol v3.2)
  uploadArtifact({ data, filename = 'attachment.bin', contentType = 'application/octet-stream', taskId, ttlSeconds }, options = {}) {
    const buf = Buffer.isBuffer(data) ? data : (data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(String(data)));
    return this.#request('POST', 'edge/v1/artifacts', buf, {
      idempotencyKey: false,
      ...options,
      headers: {
        'Content-Type': contentType,
        'X-AnyLink-Filename': encodeURIComponent(filename),
        ...(taskId ? { 'X-AnyLink-Task-Id': taskId } : {}),
        ...(ttlSeconds !== undefined ? { 'X-AnyLink-TTL': String(ttlSeconds) } : {}),
        ...(options.headers ?? {}),
      },
    });
  }
  artifactMeta(id, options) { return this.#request('GET', `edge/v1/artifacts/${encodeURIComponent(id)}/meta`, undefined, options); }
  async downloadArtifact(id, options) {
    const res = await this.#request('GET', `edge/v1/artifacts/${encodeURIComponent(id)}`, undefined, { ...options, raw: true });
    const data = Buffer.from(await res.arrayBuffer());
    return {
      data,
      filename: res.headers.get('x-anylink-filename') ? decodeURIComponent(res.headers.get('x-anylink-filename')) : 'attachment.bin',
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      sha256: res.headers.get('x-anylink-sha256') ?? undefined,
    };
  }
  deleteArtifact(id, options) { return this.#request('DELETE', `edge/v1/artifacts/${encodeURIComponent(id)}`, undefined, { idempotencyKey: false, ...options }); }

  // Multi-model Gateway
  models(options) { return this.#request('GET', 'model/v1/models', undefined, options); }
  modelRequest(id, options) { return this.#request('GET', `model/v1/requests/${encodeURIComponent(id)}`, undefined, options); }
  chatCompletions(input, { autoMemory, detachOnDisconnect, headers = {}, ...options } = {}) {
    const extraHeaders = {
      ...headers,
      ...(autoMemory !== undefined ? { 'X-AnyLink-Auto-Memory': autoMemory ? 'on' : 'off' } : {}),
      ...(detachOnDisconnect !== undefined ? { 'X-AnyLink-Detach-On-Disconnect': detachOnDisconnect ? 'on' : 'off' } : {}),
    };
    return this.#request('POST', 'model/v1/chat/completions', { ...input, stream: false }, { ...options, headers: extraHeaders, idempotencyKey: false });
  }
  speech(input, options) { return this.#request('POST', 'model/v1/speech', input, { ...options, idempotencyKey: false }); }
  async *streamChatCompletions(input, { autoMemory, detachOnDisconnect, onRequestId, headers = {}, ...options } = {}) {
    const extraHeaders = {
      ...headers,
      ...(autoMemory !== undefined ? { 'X-AnyLink-Auto-Memory': autoMemory ? 'on' : 'off' } : {}),
      ...(detachOnDisconnect !== undefined ? { 'X-AnyLink-Detach-On-Disconnect': detachOnDisconnect ? 'on' : 'off' } : {}),
    };
    const response = await this.#request('POST', 'model/v1/chat/completions', { ...input, stream: true }, { ...options, headers: extraHeaders, idempotencyKey: false, raw: true });
    const reqId = response.headers.get('x-anylink-request-id');
    if (reqId) onRequestId?.(reqId);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new AnyLinkError('Expected an SSE model response', { code: 'INVALID_STREAM', requestId: reqId ?? undefined, submissionUnknown: true });
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', done = false;
    try {
      while (!done) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        pending = pending.replaceAll('\r\n', '\n');
        if (pending.length > 2 * 1024 * 1024) throw new AnyLinkError('SSE event exceeded 2 MiB', { code: 'INVALID_STREAM', requestId: reqId ?? undefined, submissionUnknown: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (data === '[DONE]') { done = true; break; }
          if (data) {
            let parsed;
            try { parsed = JSON.parse(data); } catch (cause) { throw new AnyLinkError('Invalid model SSE data', { code: 'INVALID_STREAM', requestId: reqId ?? undefined, submissionUnknown: true, cause }); }
            yield parsed;
          }
        }
        if (chunk.done && !done) throw new AnyLinkError('Model stream ended without [DONE]; it will not be retried', { code: 'STREAM_INCOMPLETE', requestId: reqId ?? undefined, submissionUnknown: true });
      }
    } catch (cause) {
      if (cause instanceof AnyLinkError) throw cause;
      throw new AnyLinkError('Model stream was interrupted', { code: 'STREAM_INCOMPLETE', requestId: reqId ?? undefined, submissionUnknown: true, cause });
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  // Capability-free cross-device tasks (Protocol v3.2)
  registerCapabilities(capabilities, options) { return this.#request('POST', 'edge/v1/link/capabilities', { capabilities }, options); }
  invoke({
    target, instruction, input, capability, ttlSeconds, leaseSeconds,
    executionTimeoutSeconds, priority, requireOnline, idempotent, maxRetries,
    concurrencyKey, traceId, parentTaskId, allowReentry,
  } = {}, options) {
    return this.createTask({
      ...(target ? { target } : {}),
      ...(instruction !== undefined ? { instruction } : {}),
      ...(capability !== undefined ? { capability } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}),
      ...(leaseSeconds !== undefined ? { lease_seconds: leaseSeconds } : {}),
      ...(executionTimeoutSeconds !== undefined ? { execution_timeout_seconds: executionTimeoutSeconds } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(requireOnline !== undefined ? { require_online: requireOnline } : {}),
      ...(idempotent !== undefined ? { idempotent } : {}),
      ...(maxRetries !== undefined ? { max_retries: maxRetries } : {}),
      ...(concurrencyKey !== undefined ? { concurrency_key: concurrencyKey } : {}),
      ...(traceId !== undefined ? { trace_id: traceId } : {}),
      ...(parentTaskId !== undefined ? { parent_task_id: parentTaskId } : {}),
      ...(allowReentry !== undefined ? { allow_reentry: allowReentry } : {}),
    }, options);
  }
  createTask(task, options) { return this.#request('POST', 'edge/v1/tasks', task, options); }
  task(id, options) { return this.#request('GET', `edge/v1/tasks/${encodeURIComponent(id)}`, undefined, options); }
  listTasks(query = {}, options) { return this.#request('GET', 'edge/v1/tasks?' + new URLSearchParams(query), undefined, options); }
  claimTask({ taskId, ...options } = {}) { return this.#request('POST', 'edge/v1/tasks/claim', taskId ? { task_id: taskId } : {}, options); }
  heartbeatTask(id, { extendSeconds, leaseToken, ...options } = {}) {
    return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/heartbeat`, {
      ...(extendSeconds ? { extend_seconds: extendSeconds } : {}),
      ...(leaseToken ? { lease_token: leaseToken } : {}),
    }, { idempotencyKey: false, ...options });
  }
  reportProgress(id, progress, { leaseToken, ...options } = {}) {
    return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/progress`, {
      ...progress,
      ...(leaseToken ? { lease_token: leaseToken } : {}),
    }, { idempotencyKey: false, ...options });
  }
  suspendTask(id, body, { leaseToken, ...options } = {}) {
    return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/suspend`, {
      ...body,
      ...(leaseToken ? { lease_token: leaseToken } : {}),
    }, { idempotencyKey: false, ...options });
  }
  replyTask(id, body, options) {
    return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/reply`, body, options);
  }
  ackReceipt(id, options = {}) {
    return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/ack`, {}, { idempotencyKey: false, ...options });
  }
  completeTask(id, result, { leaseToken, ...options } = {}) {
    return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/result`, {
      ...result,
      ...(leaseToken ? { lease_token: leaseToken } : {}),
    }, options);
  }
  cancelTask(id, options) { return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/cancel`, {}, options); }

  /** Wait until a task reaches a terminal state; reconnect-safe (re-queries on WS hello & polls while disconnected) and auto-ACKs receipts. */
  async waitForTask(taskId, { socket, timeoutMs = 120000, pollIntervalMs = 1500, signal, onProgress, onInteraction, autoAck = true } = {}) {
    const terminal = new Set(['succeeded', 'failed', 'declined', 'cancelled', 'unknown', 'expired']);
    const deadline = Date.now() + timeoutMs;

    const finalize = async task => {
      if (autoAck) {
        if (socket?.connected) void socket.ackReceipt(task.id).catch(() => this.ackReceipt(task.id).catch(() => {}));
        else void this.ackReceipt(task.id).catch(() => {});
      }
      return task;
    };

    if (socket) {
      const result = await new Promise((resolve, reject) => {
        let done = false;
        let fallbackPoll = null;
        const stopFallback = () => { if (fallbackPoll) { clearInterval(fallbackPoll); fallbackPoll = null; } };
        const checkNow = () => {
          if (done) return;
          this.task(taskId, { signal }).then(cur => {
            if (done) return;
            if (cur.progress) onProgress?.(cur.progress);
            if ((cur.state === 'awaiting_input' || cur.state === 'awaiting_approval') && cur.pending_interaction && !cur.pending_interaction.resolved) {
              onInteraction?.(cur);
            }
            if (terminal.has(cur.state)) finish(resolve, cur);
          }).catch(() => {});
        };
        const startFallback = () => {
          if (fallbackPoll || done) return;
          fallbackPoll = setInterval(checkNow, Math.max(pollIntervalMs, 1500));
          fallbackPoll.unref?.();
        };
        const cleanup = () => {
          stopFallback();
          offComplete(); offProgress(); offAwaitInput(); offAwaitApproval(); offHello(); offClose();
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const finish = (fn, val) => { if (done) return; done = true; cleanup(); fn(val); };
        const onAbort = () => finish(reject, new AnyLinkError('Wait aborted', { code: 'ABORTED' }));
        const timer = setTimeout(() => finish(reject, new AnyLinkError('Timed out waiting for task', { code: 'TASK_WAIT_TIMEOUT' })), timeoutMs);
        const offComplete = socket.on('task.completed', frame => { if (frame.task?.id === taskId) finish(resolve, frame.task); });
        const offProgress = socket.on('task.progress', frame => { if (frame.task_id === taskId) onProgress?.(frame.progress); });
        const offAwaitInput = socket.on('task.awaiting_input', frame => { if (frame.task_id === taskId) onInteraction?.(frame.task); });
        const offAwaitApproval = socket.on('task.awaiting_approval', frame => { if (frame.task_id === taskId) onInteraction?.(frame.task); });
        const offHello = socket.on('hello', () => { stopFallback(); checkNow(); });
        const offClose = socket.on('close', () => { startFallback(); });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (!socket.connected) startFallback();
        checkNow();
      });
      return finalize(result);
    }

    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const cur = await this.task(taskId, { signal });
      if (cur.progress) onProgress?.(cur.progress);
      if ((cur.state === 'awaiting_input' || cur.state === 'awaiting_approval') && cur.pending_interaction && !cur.pending_interaction.resolved) {
        onInteraction?.(cur);
      }
      if (terminal.has(cur.state)) return finalize(cur);
      await sleep(Math.min(pollIntervalMs, Math.max(50, deadline - Date.now())), signal);
    }
    throw new AnyLinkError('Timed out waiting for task', { code: 'TASK_WAIT_TIMEOUT' });
  }
}
