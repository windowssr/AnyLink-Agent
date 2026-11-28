import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { QwenSpeechConfig, QwenSocketFactory } from './qwen-speech.js';

export type LiveSpeech = { append: (text: string) => void; finish: () => void; cancel: () => void; pause: () => void; resume: () => void };
export type LiveSpeechEvents = { pcm: (audio: Buffer) => void; done: () => void; error: (code: string) => void };

/** Text and PCM both stream for an entire reply. Never manually commit individual sentences. */
export function openQwenLive(config: QwenSpeechConfig, events: LiveSpeechEvents, options: { createSocket?: QwenSocketFactory; timeoutMs?: number } = {}): LiveSpeech {
  const endpoint = config.region === 'singapore' ? 'dashscope-intl.aliyuncs.com' : 'dashscope.aliyuncs.com';
  const socket = (options.createSocket ?? ((url, opts) => new WebSocket(url, opts)))(`wss://${endpoint}/api-ws/v1/realtime?model=${encodeURIComponent(config.model ?? 'qwen3-tts-flash-realtime')}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` }, handshakeTimeout: 3000, followRedirects: false, maxPayload: 512 * 1024, perMessageDeflate: false,
  });
  let ready = false, finished = false, closed = false, queued = '', chars = 0, bytes = 0, response = '';
  const send = (event: Record<string, unknown>) => socket.send(JSON.stringify({ event_id: randomUUID(), ...event }));
  const close = (code?: string) => {
    if (closed) return;
    closed = true; clearTimeout(deadline); clearTimeout(inputIdle); clearTimeout(first); socket.terminate();
    if (code) events.error(code);
  };
  const deadline = setTimeout(() => close('TTS_TOTAL_TIMEOUT'), options.timeoutMs ?? 180000);
  const first = setTimeout(() => close('TTS_FIRST_AUDIO_TIMEOUT'), Math.min(options.timeoutMs ?? 8000, 8000));
  let inputIdle = setTimeout(() => close('TTS_INPUT_TIMEOUT'), 30000);
  const flush = () => {
    if (!ready || closed) return;
    try {
      if (queued) { send({ type: 'input_text_buffer.append', text: queued }); queued = ''; }
      if (finished) send({ type: 'session.finish' });
    } catch { close('TTS_CONNECTION_FAILED'); }
  };
  socket.on('open', () => {
    try { send({ type: 'session.update', session: { voice: config.voice ?? 'Momo', mode: 'server_commit', language_type: 'Chinese', response_format: 'pcm', sample_rate: 24000, speech_rate: config.speechRate ?? 1.12, pitch_rate: 1.0 } }); }
    catch { close('TTS_CONNECTION_FAILED'); }
  });
  socket.on('message', raw => {
    if (closed) return;
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === 'error') { close('TTS_PROVIDER_ERROR'); return; }
      if (event.type === 'session.updated') {
        if (ready) throw new Error();
        if (event.session?.voice && event.session.voice !== (config.voice ?? 'Momo')) throw new Error();
        if (event.session?.mode && event.session.mode !== 'server_commit') throw new Error();
        if (event.session?.sample_rate && event.session.sample_rate !== 24000) throw new Error();
        if (event.session?.speech_rate && Math.abs(event.session.speech_rate - (config.speechRate ?? 1.12)) > .001) throw new Error();
        ready = true; flush();
      } else if (event.type === 'response.created') {
        if (response || !event.response?.id) throw new Error(); response = String(event.response.id);
      } else if (event.type === 'response.audio.delta') {
        if (!response || event.response_id !== response || typeof event.delta !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.delta)) throw new Error();
        const pcm = Buffer.from(event.delta, 'base64'); bytes += pcm.length; clearTimeout(first);
        if (!pcm.length || pcm.length > 256 * 1024 || bytes > 6 * 1024 * 1024) throw new Error(); events.pcm(pcm);
      } else if (event.type === 'response.done') {
        if (!response || event.response?.id !== response || event.response?.status !== 'completed') throw new Error(); response = '';
      } else if (event.type === 'session.finished') {
        if (!finished || !bytes || bytes % 2 || response) throw new Error();
        close(); events.done();
      }
    } catch { close('TTS_INVALID_RESPONSE'); }
  });
  socket.on('error', () => close('TTS_CONNECTION_FAILED')); socket.on('close', () => close('TTS_CONNECTION_CLOSED'));
  return {
    append: text => {
      if (closed || finished || !text || (chars += text.length) > 8000) throw new Error('TTS_INPUT_CLOSED');
      queued += text; clearTimeout(inputIdle); inputIdle = setTimeout(() => close('TTS_INPUT_TIMEOUT'), 30000); flush();
    },
    finish: () => { if (closed || finished) return; finished = true; clearTimeout(inputIdle); flush(); },
    cancel: () => close(), pause: () => socket.pause(), resume: () => socket.resume(),
  };
}
