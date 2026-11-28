import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export type QwenSpeechConfig = { apiKey: string; region?: 'beijing' | 'singapore'; model?: string; voice?: string; speechRate?: number };
export type QwenSocketFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;
const MAX_PCM = 6 * 1024 * 1024;

type SpeechJob = { text: string; chunks: Buffer[]; bytes: number; response: string; pcm?: (pcm: Buffer) => void;
  resolve: (audio: Buffer) => void; reject: (error: Error) => void; dispose: () => void; first?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout> };
type SessionOptions = { createSocket?: QwenSocketFactory; firstAudioTimeoutMs?: number; idleTimeoutMs?: number; totalTimeoutMs?: number; keepAliveMs?: number };

/** One configured Momo session per authenticated conversation, with serialized, bounded commits.
 * Reopening a socket for every comma discards synthesis context and can change delivery between clauses. */
export function createQwenSpeechPool(config: QwenSpeechConfig, options: SessionOptions = {}) {
  const sessions = new Map<string, { id: string; submit: (text: string, signal?: AbortSignal, pcm?: (pcm: Buffer) => void) => Promise<Buffer>; close: () => void }>();
  const single = createQwenSpeech(config, options);
  const create = (key: string) => {
    const id = randomUUID(), queue: SpeechJob[] = [];
    let active: SpeechJob | undefined, ready = false, closed = false, retire: ReturnType<typeof setTimeout> | undefined;
    const endpoint = config.region === 'singapore' ? 'dashscope-intl.aliyuncs.com' : 'dashscope.aliyuncs.com';
    const socket = (options.createSocket ?? ((url, opts) => new WebSocket(url, opts)))(`wss://${endpoint}/api-ws/v1/realtime?model=${encodeURIComponent(config.model ?? 'qwen3-tts-flash-realtime')}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` }, handshakeTimeout: 3000, followRedirects: false, perMessageDeflate: false, maxPayload: MAX_PCM * 2,
    });
    const send = (event: Record<string, unknown>) => socket.send(JSON.stringify({ event_id: randomUUID(), ...event }));
    const dispose = (job: SpeechJob) => { clearTimeout(job.first); clearTimeout(job.idle); job.dispose(); };
    const close = (reason = 'TTS_CANCELLED') => {
      if (closed) return;
      const graceful = !active && queue.length === 0 && reason === 'TTS_CANCELLED' && socket.readyState === WebSocket.OPEN;
      closed = true; clearTimeout(retire);
      if (sessions.get(key)?.id === id) sessions.delete(key);
      for (const job of [...(active ? [active] : []), ...queue]) { dispose(job); job.reject(new Error(reason)); }
      active = undefined; queue.length = 0;
      if (graceful) {
        try { send({ type: 'session.finish' }); socket.close(1000); } catch { socket.terminate(); }
        const deadline = setTimeout(() => socket.terminate(), 1000); deadline.unref(); socket.once('close', () => clearTimeout(deadline));
      } else socket.terminate();
    };
    const pump = () => {
      if (closed || !ready || active) return;
      clearTimeout(retire);
      active = queue.shift();
      if (!active) { retire = setTimeout(() => close(), options.keepAliveMs ?? 30000); retire.unref(); return; }
      active.first = setTimeout(() => close('TTS_FIRST_AUDIO_TIMEOUT'), options.firstAudioTimeoutMs ?? 5000);
      try { send({ type: 'input_text_buffer.append', text: active.text }); send({ type: 'input_text_buffer.commit' }); } catch { close('TTS_CONNECTION_FAILED'); }
    };
    socket.on('open', () => {
      if (!closed) send({ type: 'session.update', session: { voice: config.voice ?? 'Momo', mode: 'commit', language_type: 'Chinese', response_format: 'pcm', sample_rate: 24000, speech_rate: config.speechRate ?? 1.12, pitch_rate: 1.0 } });
    });
    socket.on('message', raw => {
      if (closed) return;
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'error') { close('TTS_PROVIDER_ERROR'); return; }
        if (event.type === 'session.updated') { if (ready) throw new Error(); ready = true; pump(); }
        else if (event.type === 'response.created') {
          if (!active || active.response || !event.response?.id) throw new Error();
          active.response = String(event.response.id);
        } else if (event.type === 'response.audio.delta') {
          if (!active?.response || event.response_id !== active.response || typeof event.delta !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.delta)) throw new Error();
          const pcm = Buffer.from(event.delta, 'base64'); active.bytes += pcm.length;
          if (active.bytes > MAX_PCM || !pcm.length) throw new Error();
          active.chunks.push(pcm); active.pcm?.(pcm); clearTimeout(active.first); clearTimeout(active.idle);
          active.idle = setTimeout(() => close('TTS_AUDIO_STALLED'), options.idleTimeoutMs ?? 3000);
        } else if (event.type === 'response.done') {
          if (!active?.response || event.response?.id !== active.response || event.response?.status !== 'completed') throw new Error();
          const job = active, wav = pcmWave(Buffer.concat(job.chunks));
          active = undefined; dispose(job); job.resolve(wav); pump();
        } else if (event.type === 'session.finished') close('TTS_INCOMPLETE');
      } catch { close('TTS_INVALID_RESPONSE'); }
    });
    socket.on('error', () => close('TTS_CONNECTION_FAILED')); socket.on('close', () => close('TTS_CONNECTION_CLOSED'));
    return { id, close, submit: (text: string, signal?: AbortSignal, pcm?: (pcm: Buffer) => void) => new Promise<Buffer>((resolve, reject) => {
      if (signal?.aborted || closed) { reject(new Error('TTS_CANCELLED')); return; }
      if (queue.length >= 3) { reject(new Error('TTS_QUEUE_FULL')); return; }
      const abort = () => close();
      const deadline = setTimeout(() => close('TTS_TOTAL_TIMEOUT'), options.totalTimeoutMs ?? 20000);
      const job: SpeechJob = { text, chunks: [], bytes: 0, response: '', pcm, resolve, reject, dispose: () => { clearTimeout(deadline); signal?.removeEventListener('abort', abort); } };
      signal?.addEventListener('abort', abort, { once: true }); queue.push(job); pump();
    }) };
  };
  const synthesize = (text: string, signal?: AbortSignal, pcm?: (pcm: Buffer) => void, key?: string) => {
    if (!config.apiKey || !text.trim()) return Promise.reject(new Error('TTS_NOT_CONFIGURED'));
    if (!key) return single(text, signal, pcm);
    if (signal?.aborted) return Promise.reject(new Error('TTS_CANCELLED'));
    let session = sessions.get(key);
    if (!session) {
      if (sessions.size >= 32) return Promise.reject(new Error('TTS_SESSION_LIMIT'));
      try { session = create(key); sessions.set(key, session); } catch { return Promise.reject(new Error('TTS_CONNECTION_FAILED')); }
    }
    return session.submit(text, signal, pcm);
  };
  return Object.assign(synthesize, { sessionId: (key: string) => sessions.get(key)?.id, close: () => { for (const session of sessions.values()) session.close(); sessions.clear(); } });
}

export function pcmWave(pcm: Buffer, sampleRate = 24000): Buffer {
  if (!pcm.length || pcm.length % 2 || pcm.length > MAX_PCM) throw new Error('INVALID_TTS_AUDIO');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Official Qwen realtime protocol. Credentials stay on the hub; one bounded utterance owns its socket. */
export function createQwenSpeech(config: QwenSpeechConfig, options: {
  createSocket?: QwenSocketFactory; firstAudioTimeoutMs?: number; idleTimeoutMs?: number; totalTimeoutMs?: number;
} = {}) {
  const createSocket = options.createSocket ?? ((url, opts) => new WebSocket(url, opts));
  const endpoint = config.region === 'singapore' ? 'dashscope-intl.aliyuncs.com' : 'dashscope.aliyuncs.com';
  const model = config.model ?? 'qwen3-tts-flash-realtime';
  return (text: string, signal?: AbortSignal, onPcm?: (pcm: Buffer) => void): Promise<Buffer> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('TTS_CANCELLED')); return; }
    if (!config.apiKey || !text.trim()) { reject(new Error('TTS_NOT_CONFIGURED')); return; }
    let socket: WebSocket;
    try { socket = createSocket(`wss://${endpoint}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` }, handshakeTimeout: 3000, followRedirects: false,
      perMessageDeflate: false, maxPayload: MAX_PCM * 2,
    }); } catch { reject(new Error('TTS_CONNECTION_FAILED')); return; }
    let settled = false, submitted = false, responseId = '', bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, audio?: Buffer) => {
      if (settled) return;
      settled = true; clearTimeout(first); clearTimeout(total); if (idle) clearTimeout(idle);
      signal?.removeEventListener('abort', cancel);
      if (!error && socket.readyState === WebSocket.OPEN) {
        const closing = setTimeout(() => socket.terminate(), 1000); closing.unref(); socket.once('close', () => clearTimeout(closing)); socket.close(1000);
      } else socket.terminate();
      if (error) reject(error); else resolve(audio!);
    };
    const cancel = () => finish(new Error('TTS_CANCELLED'));
    const first = setTimeout(() => finish(new Error('TTS_FIRST_AUDIO_TIMEOUT')), options.firstAudioTimeoutMs ?? 5000);
    const total = setTimeout(() => finish(new Error('TTS_TOTAL_TIMEOUT')), options.totalTimeoutMs ?? 15000);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const send = (event: Record<string, unknown>) => socket.send(JSON.stringify({ event_id: randomUUID(), ...event }));
    signal?.addEventListener('abort', cancel, { once: true });
    socket.on('open', () => {
      if (settled) return;
      send({ type: 'session.update', session: { voice: config.voice ?? 'Momo', mode: 'commit', language_type: 'Chinese',
        response_format: 'pcm', sample_rate: 24000, speech_rate: config.speechRate ?? 1.12, pitch_rate: 1.0 } });
    });
    socket.on('message', raw => {
      if (settled) return;
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'error') { finish(new Error('TTS_PROVIDER_ERROR')); return; }
        if (event.type === 'session.updated' && !submitted) {
          submitted = true;
          send({ type: 'input_text_buffer.append', text }); send({ type: 'input_text_buffer.commit' });
        } else if (event.type === 'response.created') {
          if (!submitted || responseId) throw new Error('UNEXPECTED_TTS_RESPONSE');
          responseId = String(event.response?.id ?? '');
          if (!responseId) throw new Error('UNEXPECTED_TTS_RESPONSE');
        } else if (event.type === 'response.audio.delta') {
          if (!submitted || !responseId || typeof event.delta !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.delta)) throw new Error('INVALID_TTS_AUDIO');
          if (responseId && event.response_id !== responseId) throw new Error('UNEXPECTED_TTS_RESPONSE');
          const pcm = Buffer.from(event.delta, 'base64'); bytes += pcm.length;
          if (bytes > MAX_PCM) throw new Error('TTS_AUDIO_TOO_LARGE');
          chunks.push(pcm); onPcm?.(pcm); clearTimeout(first); if (idle) clearTimeout(idle);
          idle = setTimeout(() => finish(new Error('TTS_AUDIO_STALLED')), options.idleTimeoutMs ?? 3000);
        } else if (event.type === 'response.done') {
          if (!responseId || event.response?.status !== 'completed' || event.response?.id !== responseId) throw new Error('TTS_INCOMPLETE');
          const wave = pcmWave(Buffer.concat(chunks));
          send({ type: 'session.finish' }); finish(undefined, wave);
        } else if (event.type === 'session.finished') finish(new Error('TTS_INCOMPLETE'));
      } catch { finish(new Error('TTS_INVALID_RESPONSE')); }
    });
    socket.on('error', () => finish(new Error('TTS_CONNECTION_FAILED')));
    socket.on('close', () => { if (!settled) finish(new Error('TTS_CONNECTION_CLOSED')); });
    if (signal?.aborted) cancel();
  });
}
