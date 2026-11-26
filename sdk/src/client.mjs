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

/** Real-time WebSocket connection to /edge/v1/ws with automatic auth, heartbeat and typed events. */
export class AnyLinkSocket extends EventTarget {
  #wsUrl; #token; #WebSocketImpl; #ws = null; #closed = false; #pending = new Map(); #pingTimer = null; #reconnectTimer = null; #attempt = 0;

  constructor({ wsUrl, token, WebSocketImpl = globalThis.WebSocket }) {
    super();
    if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket implementation is unavailable in this runtime');
    this.#wsUrl = wsUrl;
    this.#token = token;
    this.#WebSocketImpl = WebSocketImpl;
  }

  get connected() { return this.#ws?.readyState === 1; }

  async connect({ timeoutMs = 15000, autoReconnect = true } = {}) {
    this.#closed = false;
    await this.#openOnce(timeoutMs);
    if (autoReconnect) this.#enableReconnect(timeoutMs);
    return this;
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
        let frame;
        try { frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
        if (frame.type === 'hello') {
          this.#attempt = 0;
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
        ws.send(JSON.stringify({ type: 'auth', token: this.#token }));
      });
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', err => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new AnyLinkError('WebSocket connection error', { code: 'WS_ERROR', cause: err })); }
      });
      ws.addEventListener('close', ev => {
        this.#stopPing();
        for (const [id, waiter] of this.#pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new AnyLinkError('WebSocket closed before response', { code: 'WS_CLOSED', submissionUnknown: true }));
          this.#pending.delete(id);
        }
        if (!settled) { settled = true; clearTimeout(timer); reject(new AnyLinkError(`WebSocket closed (${ev.code})`, { code: 'WS_CLOSED' })); }
        this.dispatchEvent(new CustomEvent('close', { detail: { code: ev.code, reason: ev.reason } }));
      });
    });
  }

  #enableReconnect(timeoutMs) {
    this.addEventListener('close', () => {
      if (this.#closed) return;
      const delayMs = Math.min(30000, 1000 * Math.pow(2, Math.min(this.#attempt++, 5)));
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
      if (this.connected) this.#ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }, 20000);
    this.#pingTimer.unref?.();
  }

  #stopPing() {
    if (this.#pingTimer) { clearInterval(this.#pingTimer); this.#pingTimer = null; }
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

  heartbeatTask(taskId, { extendSeconds, timeoutMs = 10000 } = {}) {
    return this.sendRpc({ type: 'task.heartbeat', task_id: taskId, ...(extendSeconds ? { extend_seconds: extendSeconds } : {}) }, { timeoutMs });
  }

  reportProgress(taskId, progress, { timeoutMs = 10000 } = {}) {
    return this.sendRpc({ type: 'task.progress', task_id: taskId, progress }, { timeoutMs });
  }

  completeTask(taskId, result, { idempotencyKey = `result:${taskId}`, timeoutMs = 15000 } = {}) {
    return this.sendRpc({ type: 'task.result', task_id: taskId, idempotency_key: idempotencyKey, result }, { timeoutMs });
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

/** Harness-independent client for AnyLink Protocol v3 (HTTP + WebSocket + Cloud Memory Brain + Model Gateway). */
export class AnyLinkClient {
  #base; #token; #fetch; #timeout; #WebSocketImpl;
  get baseUrl() { return this.#base; }

  constructor({ baseUrl, token, fetch: transport = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timeoutMs = 30000 }) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new TypeError('A device credential is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    this.#base = checkBaseUrl(baseUrl);
    this.#token = token;
    this.#fetch = transport;
    this.#WebSocketImpl = WebSocketImpl;
    this.#timeout = timeoutMs;
  }

  /** Join with the owner key: upserts the install's device and agent, returns a fresh credential. */
  static async connect({ baseUrl, joinKey, installId, device, agent, fetch: transport = globalThis.fetch, timeoutMs = 30000 }) {
    const base = checkBaseUrl(baseUrl);
    if (typeof joinKey !== 'string' || !joinKey.trim() || /[\r\n]/.test(joinKey)) throw new TypeError('A join key is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
    let response;
    try {
      response = await transport(new URL('edge/v1/connect', base), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${joinKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device: { install_id: installId, name: device?.name, platform: device?.platform ?? 'other' },
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
    const sock = new AnyLinkSocket({ wsUrl: this.wsUrl(), token: this.#token, WebSocketImpl: options.WebSocketImpl ?? this.#WebSocketImpl });
    return sock.connect(options);
  }

  async #request(method, path, body, { idempotencyKey, signal, raw = false, headers = {} } = {}) {
    const writing = !['GET', 'HEAD'].includes(method);
    const key = writing && idempotencyKey !== false ? (idempotencyKey ?? crypto.randomUUID()) : undefined;
    const requestSignal = AbortSignal.any([AbortSignal.timeout(this.#timeout), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await this.#fetch(new URL(path, this.#base), {
        method,
        redirect: 'error',
        signal: requestSignal,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      throw new AnyLinkError(writing ? 'Submission outcome is unknown; do not repeat execution blindly' : 'AnyLink request failed', { code: writing ? 'SUBMISSION_UNKNOWN' : 'TRANSPORT_ERROR', idempotencyKey: key, submissionUnknown: writing, cause });
    }
    const requestId = response.headers.get('x-anylink-request-id') ?? undefined;
    if (!response.ok) {
      let data; try { data = await response.json(); } catch {}
      throw new AnyLinkError(data?.error?.message ?? `AnyLink HTTP ${response.status}`, { code: data?.error?.code ?? 'HTTP_ERROR', status: response.status, requestId: data?.request_id ?? requestId, idempotencyKey: key, submissionUnknown: writing && response.status >= 500 && data?.error?.code !== 'PROVIDER_NOT_CONFIGURED' });
    }
    if (raw) return response;
    try { return await response.json(); } catch (cause) { throw new AnyLinkError('AnyLink response was incomplete', { code: writing ? 'SUBMISSION_UNKNOWN' : 'INVALID_RESPONSE', requestId, idempotencyKey: key, submissionUnknown: writing, cause }); }
  }

  // Identity & discovery
  protocol(options) { return this.#request('GET', 'edge/v1/protocol', undefined, options); }
  directory(options) { return this.#request('GET', 'edge/v1/directory', undefined, options); }
  /** @deprecated Compatibility shim; use directory(). */
  peers(options) { return this.#request('GET', 'edge/v1/link/peers', undefined, options); }
  persona(options) { return this.#request('GET', 'edge/v1/persona', undefined, options); }
  identity(options) { return this.#request('GET', 'edge/v1/identity', undefined, options); }
  updateProfile(profile, options = {}) { return this.#request('PATCH', 'edge/v1/agent/profile', profile, { idempotencyKey: false, ...options }); }
  adoptInstallId(installId, options = {}) { return this.#request('POST', 'edge/v1/device/install-id', { install_id: installId }, { idempotencyKey: false, ...options }); }

  // Cloud Memory Brain v3
  assembleMemory(query = {}, options = {}) { return this.#request('POST', 'edge/v1/memory/assemble', query, { idempotencyKey: false, ...options }); }
  ingestMemory(payload, options = {}) { return this.#request('POST', 'edge/v1/memory/ingest', payload, { idempotencyKey: false, ...options }); }
  episodes(query = {}, options) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    return this.#request('GET', 'edge/v1/memory/episodes' + (qs ? '?' + qs : ''), undefined, options);
  }
  context(options) { return this.#request('GET', 'edge/v1/context', undefined, options); }
  searchMemories(query = {}, options) { return this.#request('POST', 'edge/v1/memories/search', query, { ...options, idempotencyKey: false }); }
  saveMemory(memory, options) { return this.#request('POST', 'edge/v1/memories', memory, options); }
  updateMemory(id, revision, patch, options) { return this.#request('PATCH', `edge/v1/memories/${encodeURIComponent(id)}`, { ...patch, expected_revision: revision }, options); }
  deleteMemory(id, revision, options) { return this.#request('DELETE', `edge/v1/memories/${encodeURIComponent(id)}`, undefined, { ...options, headers: { 'If-Match': String(revision) } }); }

  // Multi-model Gateway
  models(options) { return this.#request('GET', 'model/v1/models', undefined, options); }
  chatCompletions(input, { autoMemory, headers = {}, ...options } = {}) {
    const extraHeaders = { ...headers, ...(autoMemory !== undefined ? { 'X-AnyLink-Auto-Memory': autoMemory ? 'on' : 'off' } : {}) };
    return this.#request('POST', 'model/v1/chat/completions', { ...input, stream: false }, { ...options, headers: extraHeaders, idempotencyKey: false });
  }
  speech(input, options) { return this.#request('POST', 'model/v1/speech', input, { ...options, idempotencyKey: false }); }
  async *streamChatCompletions(input, { autoMemory, headers = {}, ...options } = {}) {
    const extraHeaders = { ...headers, ...(autoMemory !== undefined ? { 'X-AnyLink-Auto-Memory': autoMemory ? 'on' : 'off' } : {}) };
    const response = await this.#request('POST', 'model/v1/chat/completions', { ...input, stream: true }, { ...options, headers: extraHeaders, idempotencyKey: false, raw: true });
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new AnyLinkError('Expected an SSE model response', { code: 'INVALID_STREAM', submissionUnknown: true });
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', done = false;
    try {
      while (!done) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        pending = pending.replaceAll('\r\n', '\n');
        if (pending.length > 2 * 1024 * 1024) throw new AnyLinkError('SSE event exceeded 2 MiB', { code: 'INVALID_STREAM', submissionUnknown: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (data === '[DONE]') { done = true; break; }
          if (data) {
            let parsed;
            try { parsed = JSON.parse(data); } catch (cause) { throw new AnyLinkError('Invalid model SSE data', { code: 'INVALID_STREAM', submissionUnknown: true, cause }); }
            yield parsed;
          }
        }
        if (chunk.done && !done) throw new AnyLinkError('Model stream ended without [DONE]; it will not be retried', { code: 'STREAM_INCOMPLETE', submissionUnknown: true });
      }
    } catch (cause) {
      if (cause instanceof AnyLinkError) throw cause;
      throw new AnyLinkError('Model stream was interrupted', { code: 'STREAM_INCOMPLETE', submissionUnknown: true, cause });
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  // Capability-free cross-device tasks
  registerCapabilities(capabilities, options) { return this.#request('POST', 'edge/v1/link/capabilities', { capabilities }, options); }
  invoke({ target, instruction, input, capability, ttlSeconds, leaseSeconds } = {}, options) {
    return this.createTask({
      ...(target ? { target } : {}),
      ...(instruction !== undefined ? { instruction } : {}),
      ...(capability !== undefined ? { capability } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}),
      ...(leaseSeconds !== undefined ? { lease_seconds: leaseSeconds } : {}),
    }, options);
  }
  createTask(task, options) { return this.#request('POST', 'edge/v1/tasks', task, options); }
  task(id, options) { return this.#request('GET', `edge/v1/tasks/${encodeURIComponent(id)}`, undefined, options); }
  listTasks(query = {}, options) { return this.#request('GET', 'edge/v1/tasks?' + new URLSearchParams(query), undefined, options); }
  claimTask({ taskId, ...options } = {}) { return this.#request('POST', 'edge/v1/tasks/claim', taskId ? { task_id: taskId } : {}, options); }
  heartbeatTask(id, { extendSeconds, ...options } = {}) { return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/heartbeat`, extendSeconds ? { extend_seconds: extendSeconds } : {}, { idempotencyKey: false, ...options }); }
  reportProgress(id, progress, options = {}) { return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/progress`, progress, { idempotencyKey: false, ...options }); }
  completeTask(id, result, options) { return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/result`, result, options); }
  cancelTask(id, options) { return this.#request('POST', `edge/v1/tasks/${encodeURIComponent(id)}/cancel`, {}, options); }

  /** Wait until a task reaches a terminal state (uses WebSocket push when socket is provided, otherwise HTTP polling). */
  async waitForTask(taskId, { socket, timeoutMs = 120000, pollIntervalMs = 1500, signal, onProgress } = {}) {
    const terminal = new Set(['succeeded', 'failed', 'declined', 'cancelled', 'unknown', 'expired']);
    const deadline = Date.now() + timeoutMs;
    if (socket?.connected) {
      return await new Promise((resolve, reject) => {
        let done = false;
        const cleanup = () => { offComplete(); offProgress(); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
        const finish = (fn, val) => { if (done) return; done = true; cleanup(); fn(val); };
        const onAbort = () => finish(reject, new AnyLinkError('Wait aborted', { code: 'ABORTED' }));
        const timer = setTimeout(() => finish(reject, new AnyLinkError('Timed out waiting for task', { code: 'TASK_WAIT_TIMEOUT' })), timeoutMs);
        const offComplete = socket.on('task.completed', frame => { if (frame.task?.id === taskId) finish(resolve, frame.task); });
        const offProgress = socket.on('task.progress', frame => { if (frame.task_id === taskId) onProgress?.(frame.progress); });
        signal?.addEventListener('abort', onAbort, { once: true });
        this.task(taskId, { signal }).then(cur => { if (terminal.has(cur.state)) finish(resolve, cur); }).catch(err => finish(reject, err));
      });
    }
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const cur = await this.task(taskId, { signal });
      if (cur.progress) onProgress?.(cur.progress);
      if (terminal.has(cur.state)) return cur;
      await new Promise((r, rej) => {
        const t = setTimeout(r, Math.min(pollIntervalMs, Math.max(50, deadline - Date.now())));
        signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
      });
    }
    throw new AnyLinkError('Timed out waiting for task', { code: 'TASK_WAIT_TIMEOUT' });
  }
}
