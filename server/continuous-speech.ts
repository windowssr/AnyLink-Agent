import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './db.js';
import type { Config } from './config.js';
import { openQwenLive, type LiveSpeech, type LiveSpeechEvents } from './qwen-live.js';

const createSchema = z.object({ id: z.uuid(), text: z.string().min(1).max(1000), source: z.enum(['call', 'chat']) }).strict();
const appendSchema = z.object({ text: z.string().max(2000).default(''), finish: z.boolean().default(false) }).strict();
type OpenLive = (events: LiveSpeechEvents) => LiveSpeech;

/** Ephemeral, credential-scoped duplex text/PCM sessions over the existing authenticated HTTPS API. */
export function registerContinuousSpeech(app: FastifyInstance, config: Config, sanitize: (text: string) => string, open?: OpenLive) {
  const sessions = new Map<string, { owner: string; append: (text: string, finish: boolean) => void; cancel: () => void }>();
  const configured = config.ttsProvider === 'qwen' && Boolean(config.qwenTtsApiKey);
  app.addHook('onClose', async () => { for (const session of sessions.values()) session.cancel(); sessions.clear(); });
  app.post('/model/v1/speech/live', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    if (!configured && !open) throw new ApiError(503, 'SPEECH_LIVE_UNAVAILABLE', 'Continuous speech is unavailable');
    const owner = req.edgeIdentity?.id;
    if (!owner) throw new ApiError(401, 'EDGE_AUTH_REQUIRED', 'Device credential required');
    const input = createSchema.parse(req.body), initial = sanitize(input.text);
    if (!initial) throw new ApiError(400, 'SPEECH_EMPTY', 'No speakable text');
    if (sessions.has(input.id)) throw new ApiError(409, 'SPEECH_ID_IN_USE', 'Speech session already exists');
    if (sessions.size >= 32 || [...sessions.values()].filter(session => session.owner === owner).length >= 2) throw new ApiError(429, 'SPEECH_SESSION_LIMIT', 'Too many speech sessions');
    let closed = false, paused = false, frames = 0, chars = initial.length, inputFinished = false, pcmTail: Buffer = Buffer.alloc(0), upstream: LiveSpeech | undefined;
    const began = Date.now();
    const cleanup = () => { if (closed) return; closed = true; sessions.delete(input.id); upstream?.cancel(); };
    const emit = (event: Record<string, unknown>) => {
      if (closed || reply.raw.destroyed) throw new Error('TTS_CANCELLED');
      return reply.raw.write(JSON.stringify(event) + '\n');
    };
    const fail = (code: string) => {
      if (closed) return;
      if (!reply.raw.destroyed) { emit({ type: 'error', code }); reply.raw.end(); }
      cleanup();
    };
    reply.hijack(); for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value);
    reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    reply.raw.once('close', cleanup);
    emit({ type: 'start', format: 'pcm_s16le', sample_rate: 24000, channels: 1, provider: 'qwen', resolved_voice: config.qwenTtsVoice || 'Momo', speech_rate: config.qwenTtsSpeechRate ?? 1.12, session_id: input.id, request_id: req.id, spoken_text: initial });
    try {
      const events: LiveSpeechEvents = {
        pcm: pcm => {
          const bytes = pcmTail.length ? Buffer.concat([pcmTail, pcm]) : pcm, length = bytes.length - bytes.length % 2;
          pcmTail = bytes.subarray(length); frames += length / 2;
          let accepted = true;
          for (let offset = 0; offset < length; offset += 9600) accepted = emit({ type: 'audio', audio_base64: bytes.subarray(offset, Math.min(offset + 9600, length)).toString('base64') }) && accepted;
          if (reply.raw.writableLength > 512 * 1024) { fail('TTS_SLOW_CONSUMER'); return; }
          if (!accepted && !paused) {
            paused = true; upstream?.pause(); reply.raw.once('drain', () => { if (!closed) { paused = false; upstream?.resume(); } });
          }
        },
        done: () => {
          if (closed) return;
          if (pcmTail.length) { fail('TTS_INVALID_AUDIO'); return; }
          emit({ type: 'done', frames, synthesis_ms: Date.now() - began }); reply.raw.end(); cleanup();
          app.log.info({ event: 'speech_continuous', source: input.source, provider: 'qwen', resolved_voice: config.qwenTtsVoice || 'Momo', speech_rate: config.qwenTtsSpeechRate ?? 1.12, session_id: input.id, text_chars: chars, frames, outcome: 'completed' }, 'Continuous speech');
        },
        error: code => fail(/^TTS_[A-Z_]+$/.test(code) ? code : 'TTS_PROVIDER_FAILED'),
      };
      upstream = open ? open(events) : openQwenLive({ apiKey: config.qwenTtsApiKey, region: config.qwenTtsRegion, model: config.qwenTtsModel, voice: config.qwenTtsVoice, speechRate: config.qwenTtsSpeechRate }, events);
      sessions.set(input.id, { owner, cancel: () => { cleanup(); if (!reply.raw.destroyed) reply.raw.end(); }, append: (text, finish) => {
        if (closed || inputFinished || chars + text.length > 8000) throw new ApiError(409, 'SPEECH_INPUT_CLOSED', 'Speech input is closed');
        if (text) { chars += text.length; upstream!.append(text); emit({ type: 'text', text }); }
        if (finish) { inputFinished = true; upstream!.finish(); }
      } });
      upstream.append(initial);
    } catch { fail('TTS_CONNECTION_FAILED'); }
    return reply;
  });
  app.patch('/model/v1/speech/live/:id', { bodyLimit: 16 * 1024 }, async req => {
    const id = z.uuid().parse((req.params as { id: string }).id), input = appendSchema.parse(req.body);
    const session = sessions.get(id);
    if (!req.edgeIdentity || !session || session.owner !== req.edgeIdentity.id) throw new ApiError(404, 'SPEECH_SESSION_NOT_FOUND', 'Speech session is unavailable');
    const text = sanitize(input.text); session.append(text, input.finish); return { accepted: true };
  });
}
