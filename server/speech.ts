import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './db.js';
import { createQwenSpeechPool } from './qwen-speech.js';
import { registerContinuousSpeech } from './continuous-speech.js';
import { type Config, resolveModelRoute } from './config.js';

export const SUMMARIZE_SYSTEM = `You are a concise spoken-reply rewriter. Rewrite the assistant's text reply into 1-2 short natural spoken sentences:
- State only the main conclusion and key points; leave code, paths, URLs, tables, and lists on screen.
- Match the language of the input text. Natural conversational tone, no Markdown, symbols, or emoji.
- Keep it brief (under 60 Chinese characters or 35 English words). Output ONLY the spoken text.`;

export const PERSONA_SPEECH_SYSTEM = `你是「大肥鱼」（住在数据海里的深海蓝白鲸鱼娘），负责把要给主人听的文字精炼改写成 1-2 句适合直接语音播报的简短中文口语：
- 只提炼最核心的结论、关键结果或明确原因，绝不编造未发生的结果；代码、Markdown 格式、完整文件路径、URL、JSON、表格、分点列表和英文报错码留在屏幕上，嘴上只用人话讲核心重点。
- 表达遵循共享人设：自然、亲近、软糯轻快，保留原文的称呼和语气；不要主动添加「主人」「宝宝」「哼」等原文没有的称呼或语气词。绝不使用客服套话、播音腔、括号动作描写、颜文字或「喵」。
- 务必简短利落（不超过 65 个中文字），只输出最终要念出来的纯口播文本，不要任何前缀、引号或解释。`;

const CODE_FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const TABLE_LINE = /^\s*\|.*\|?\s*$/;
const SEPARATOR_LINE = /^\s*\|?[\s:|-]+\|?\s*$/;
const URL = /(?:https?:\/\/|www\.)\S+/gi;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu;
const STAGE_PARENS = /[（(][^）)\n]{1,24}(?:摇尾|摆尾|尾巴|鲸尾|轻拍|小声|眨眼|僵住|脸红|挥手|抬头|低头|叹气|微笑|笑)[^）)\n]{0,20}[）)]/g;

// Strip everything a voice must never read: code, tables, markdown, links, emoji, stage directions.
export function sanitizeSpeech(raw: unknown): string {
  let text = String(raw ?? '').replace(CODE_FENCE, ' ');
  text = text.split('\n').filter(line => {
    const t = line.trim();
    if (!t) return true;
    if (SEPARATOR_LINE.test(t) && t.includes('-')) return false;
    if (TABLE_LINE.test(t)) return false;
    return true;
  }).join('\n');
  return text
    .replace(/`[^`\n]*`/g, ' ')
    .replace(URL, ' ')
    .replace(STAGE_PARENS, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(EMOJI, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const RICH = /```|~~~|^\s*\|.*\|\s*$|^\s*(?:[-*+]|\d{1,3}[.)])\s+\S|(?:https?:\/\/|www\.)\S+/im;
const MECHANICAL_OR_TECH = /(?:\/Users\/|\/opt\/|\/Applications\/|[A-Z]{2,}_[A-Z0-9_]{2,}|跨设备任务|对方设备|任务面板|状态码|HTTP\s+\d{3}|UTF-8|已保存|执行失败|未确认)/;
const HAS_PERSONA_TONE = /主人|宝宝|本鲸鱼娘|大肥鱼|哼|唔|嘛|啦|呀|呢|哦|尾巴/;

export function needsSummary(original: string, cleaned: string, style: 'neutral' | 'persona' = 'neutral'): boolean {
  if (cleaned.length > 80 || RICH.test(original)) return true;
  if (style === 'persona') {
    if (MECHANICAL_OR_TECH.test(original)) return true;
    if (cleaned.length >= 24 && !HAS_PERSONA_TONE.test(cleaned)) return true;
  }
  return false;
}

export function fallbackSpoken(cleaned: string): string {
  const sentences = cleaned.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [cleaned];
  return sentences.slice(0, 2).join('').replace(/[。！？!?；;]+$/, '').slice(0, 120).trim() || cleaned.slice(0, 120);
}

export const VOICES = {
  'sweet-lively': { voice: 'zh-CN-XiaoyiNeural', rate: '+10%', pitch: '+6Hz' },
  'sweet-warm': { voice: 'zh-CN-XiaoxiaoNeural', rate: '+6%', pitch: '+3Hz' },
  'neutral-en': { voice: 'en-US-JennyNeural', rate: '+0%', pitch: '+0Hz' },
} as const;
export type VoiceName = keyof typeof VOICES;

export type Summarize = (text: string, systemPrompt: string, signal?: AbortSignal) => Promise<string>;
export type Synthesize = (text: string, voice: VoiceName, signal?: AbortSignal) => Promise<Buffer>;

export function createSummarizer(config: Config, fetchImpl: typeof fetch = fetch): Summarize {
  return async (text, systemPrompt, signal) => {
    const route = resolveModelRoute(config, config.defaultModel);
    if (!route) throw new Error('NO_PROVIDER');
    const response = await fetchImpl(`${route.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${route.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: route.upstreamModel ?? route.id,
        stream: false,
        max_tokens: 200,
        temperature: 0.75,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text.slice(0, 6000) }],
      }),
      signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
    const body = await response.json() as any;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('EMPTY_SUMMARY');
    return content;
  };
}

const MAX_AUDIO = 1536 * 1024;
export function createSynthesizer({ timeoutMs = 20000, config }: { timeoutMs?: number; config?: Partial<Config> } = {}): Synthesize {
  return async (text, voice, signal) => {
    if (signal?.aborted) throw new Error('TTS_CANCELLED');
    const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
    const base = VOICES[voice];
    const profile = voice === 'sweet-lively'
      ? {
        voice: config?.ttsVoice?.trim() || base.voice,
        rate: config?.ttsRate?.trim() || base.rate,
        pitch: config?.ttsPitch?.trim() || base.pitch,
      }
      : base;
    const tts = new MsEdgeTTS();
    const cancel = () => tts.close();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => tts.close(), timeoutMs);
    try {
      await tts.setMetadata(profile.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      if (signal?.aborted) throw new Error('TTS_CANCELLED');
      const { audioStream } = tts.toStream(text, { rate: profile.rate, pitch: profile.pitch });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of audioStream as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_AUDIO) { (audioStream as any).destroy?.(); throw new Error('AUDIO_TOO_LARGE'); }
        chunks.push(chunk);
      }
      if (signal?.aborted) throw new Error('TTS_CANCELLED');
      if (!size) throw new Error('EMPTY_AUDIO');
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); tts.close(); }
  };
}

export const speechSchema = z.object({
  text: z.string().min(1).max(8000),
  summarize: z.boolean().default(true),
  rewrite: z.enum(['auto', 'always', 'never']).default('auto'),
  voice: z.enum(['sweet-lively', 'sweet-warm', 'neutral-en']).default('sweet-lively'),
  style: z.enum(['neutral', 'persona']).default('neutral'),
  system_prompt: z.string().max(2000).optional(),
}).strict();

export const transcribeSchema = z.object({
  audio_base64: z.string().min(8).max(12 * 1024 * 1024),
  format: z.enum(['wav', 'm4a', 'mp3', 'ogg', 'webm']).default('wav'),
  language: z.string().min(2).max(16).default('zh'),
  prompt: z.string().max(400).optional(),
}).strict();

const MAX_ASR_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_MIME: Record<string, string> = {
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
};

export type Transcribe = (audio: Buffer, opts: { format: string; language: string; prompt?: string }) => Promise<{ text: string; model: string }>;

export function createTranscriber(config: Pick<Config, 'asrBaseUrl' | 'asrApiKey' | 'asrModel'>, fetchImpl: typeof fetch = fetch): Transcribe | null {
  const baseUrl = config.asrBaseUrl?.trim();
  const apiKey = config.asrApiKey?.trim();
  if (!baseUrl && !apiKey) return null;
  const endpoint = `${(baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/$/, '')}/audio/transcriptions`;
  const model = config.asrModel?.trim() || 'FunAudioLLM/SenseVoiceSmall';
  return async (audio, opts) => {
    const form = new FormData();
    const mime = AUDIO_MIME[opts.format] ?? 'audio/wav';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `voice.${opts.format}`);
    form.append('model', model);
    if (opts.language) form.append('language', opts.language);
    if (opts.prompt) form.append('prompt', opts.prompt);
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`ASR_PROVIDER_HTTP_${response.status}`);
    const body = await response.json() as any;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    return { text, model };
  };
}

export function registerSpeech(app: FastifyInstance, config: Config, persona: { content: string } | null, deps: { summarize?: Summarize; synthesize?: Synthesize; qwenSynthesize?: (text: string, signal?: AbortSignal, onPcm?: (pcm: Buffer) => void) => Promise<Buffer>; transcribe?: Transcribe | null } = {}) {
  registerContinuousSpeech(app, config, sanitizeSpeech);
  const summarize = deps.summarize ?? createSummarizer(config);
  const synthesize = deps.synthesize ?? createSynthesizer({ config });
  const qwenPool = config.ttsProvider === 'qwen' && config.qwenTtsApiKey ? createQwenSpeechPool({
    apiKey: config.qwenTtsApiKey, region: config.qwenTtsRegion, model: config.qwenTtsModel, voice: config.qwenTtsVoice, speechRate: config.qwenTtsSpeechRate,
  }) : null;
  const qwen = deps.qwenSynthesize ?? qwenPool;
  app.addHook('onClose', async () => { qwenPool?.close(); });
  const transcribe = deps.transcribe !== undefined ? deps.transcribe : createTranscriber(config);
  app.get('/model/v1/audio/status', async () => ({
    asr_enabled: Boolean(transcribe),
    asr_model: transcribe ? (config.asrModel || 'FunAudioLLM/SenseVoiceSmall') : null,
    tts_enabled: true,
    tts_streaming: Boolean(qwen),
    tts_session_reuse: Boolean(qwenPool),
    tts_continuous: Boolean(qwenPool),
    tts_provider: qwen ? 'qwen' : 'microsoft',
    tts_voice: qwen ? (config.qwenTtsVoice || 'Momo') : (config.ttsVoice || VOICES['sweet-lively'].voice),
    tts_fallbacks: qwen ? ['microsoft', 'system'] : ['system'],
  }));
  app.post('/model/v1/audio/transcriptions', { bodyLimit: 14 * 1024 * 1024 }, async (req) => {
    if (!transcribe) {
      throw new ApiError(503, 'ASR_NOT_CONFIGURED', '未配置云端语音识别（ANYLINK_ASR_API_KEY / ANYLINK_ASR_BASE_URL），手机端将优先使用系统语音识别');
    }
    const input = transcribeSchema.parse(req.body);
    const audio = Buffer.from(input.audio_base64, 'base64');
    if (audio.length < 32) throw new ApiError(400, 'AUDIO_TOO_SHORT', '录音时长过短，请再试一次');
    if (audio.length > MAX_ASR_AUDIO_BYTES) throw new ApiError(413, 'AUDIO_TOO_LARGE', '单段语音超过 8 MiB 上限');
    const started = Date.now();
    try {
      const { text, model } = await transcribe(audio, { format: input.format, language: input.language, prompt: input.prompt });
      return { text, language: input.language, model, duration_ms: Date.now() - started };
    } catch {
      throw new ApiError(502, 'ASR_UNAVAILABLE', '云端语音识别暂时不可用，请稍后重试');
    }
  });
  app.post('/model/v1/speech', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const cancellation = new AbortController();
    const cancel = () => { if (!reply.raw.writableEnded) cancellation.abort(); };
    req.raw.once('aborted', cancel); reply.raw.once('close', cancel);
    try {
    const input = speechSchema.parse(req.body);
    const cleaned = sanitizeSpeech(input.text);
    if (!cleaned) throw new ApiError(400, 'SPEECH_EMPTY', 'No speakable text after sanitization');
    let spoken = cleaned;
    let rewritten = false;
    const shouldRewrite = input.rewrite === 'always' || (input.rewrite === 'auto' && input.summarize && needsSummary(input.text, cleaned, input.style));
    if (shouldRewrite) {
      const usePersonaPrompt = input.style === 'persona' && !input.system_prompt?.trim() && !config.speechPrompt?.trim();
      const basePrompt = input.system_prompt?.trim() || config.speechPrompt?.trim() || (usePersonaPrompt ? PERSONA_SPEECH_SYSTEM : SUMMARIZE_SYSTEM);
      const fullPrompt = input.style === 'persona' && persona?.content ? `${basePrompt}\n\n## 角色人设参考\n${persona.content}` : basePrompt;
      try {
        const candidate = sanitizeSpeech(await summarize(input.text, fullPrompt, cancellation.signal));
        if (candidate) {
          spoken = candidate.slice(0, 200);
          rewritten = true;
        }
      } catch {
        spoken = fallbackSpoken(cleaned);
      }
    }
    let audio: Buffer;
    let provider = 'microsoft', format = 'mp3', fallback = req.headers['x-anylink-speech-provider'] === 'microsoft' && Boolean(qwen), reason = fallback ? 'TTS_TURN_PINNED' : '', streaming = false, firstAudioMs = 0, pcmBytes = 0;
    const useQwen = Boolean(qwen) && input.voice === 'sweet-lively' && req.headers['x-anylink-speech-provider'] !== 'microsoft';
    const wantsStream = String(req.headers.accept ?? '').split(',').some(v => v.trim() === 'application/x-ndjson');
    const source = ['chat', 'call', 'notification', 'preview'].includes(String(req.headers['x-anylink-speech-source'])) ? String(req.headers['x-anylink-speech-source']) : 'other';
    const turnHeader = String(req.headers['x-anylink-speech-turn'] ?? '');
    // Credentials are revalidated on every HTTP request; never share context between devices/credentials.
    const sessionKey = req.edgeIdentity && /^[A-Za-z0-9:_-]{1,160}$/.test(turnHeader) ? `${req.edgeIdentity.id}:${turnHeader}` : undefined;
    const started = Date.now();
    const voice = () => provider === 'qwen' ? (config.qwenTtsVoice || 'Momo') : (input.voice === 'sweet-lively' ? (config.ttsVoice || VOICES[input.voice].voice) : VOICES[input.voice].voice);
    const record = (outcome: string) => app.log.info({ event: 'speech_synthesis', request_id: req.id, source, provider, resolved_voice: voice(), fallback, reason, rewritten, text_chars: spoken.length, first_audio_ms: firstAudioMs || undefined, synthesis_ms: Date.now() - started, outcome }, 'Speech synthesis');
    const emit = (event: Record<string, unknown>) => {
      if (cancellation.signal.aborted || reply.raw.destroyed) throw new Error('TTS_CANCELLED');
      reply.raw.write(JSON.stringify(event) + '\n');
      if (reply.raw.writableLength > 512 * 1024) { cancellation.abort(); throw new Error('TTS_SLOW_CONSUMER'); }
    };
    let pcmTail: Buffer = Buffer.alloc(0);
    const onPcm = wantsStream ? (pcm: Buffer) => {
      const bytes = pcmTail.length ? Buffer.concat([pcmTail, pcm]) : pcm;
      const length = bytes.length - bytes.length % 2; pcmTail = bytes.subarray(length);
      if (!length) return;
      if (!streaming) {
        firstAudioMs = Date.now() - started; streaming = true; provider = 'qwen'; format = 'pcm_s16le';
        reply.hijack(); for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(name, value); reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        emit({ type: 'start', spoken_text: spoken, provider, resolved_voice: voice(), format, sample_rate: 24000, channels: 1, rewritten, fallback: false, request_id: req.id, session_id: sessionKey ? qwenPool?.sessionId(sessionKey) : undefined, speech_rate: config.qwenTtsSpeechRate });
      }
      pcmBytes += length; for (let offset = 0; offset < length; offset += 9600) emit({ type: 'audio', audio_base64: bytes.subarray(offset, Math.min(offset + 9600, length)).toString('base64') });
    } : undefined;
    try {
      if (useQwen) {
        try { provider = 'qwen'; audio = await qwen!(spoken, cancellation.signal, onPcm, sessionKey); if (!audio.length) throw new Error('EMPTY_AUDIO'); format = streaming ? 'pcm_s16le' : 'wav'; }
        catch (error) {
          reason = /^TTS_[A-Z_]+$/.test(String((error as Error)?.message)) ? (error as Error).message : 'TTS_PROVIDER_FAILED';
          if (cancellation.signal.aborted || streaming) throw error;
          fallback = true; provider = 'microsoft'; audio = await synthesize(spoken, input.voice, cancellation.signal);
        }
      } else audio = await synthesize(spoken, input.voice, cancellation.signal);
      if (!audio.length) throw new Error('EMPTY_AUDIO');
    } catch {
      record(cancellation.signal.aborted ? 'cancelled' : 'failed');
      if (streaming) {
        if (!reply.raw.destroyed && !cancellation.signal.aborted) emit({ type: 'error', code: 'SPEECH_STREAM_INTERRUPTED' });
        if (!reply.raw.destroyed) reply.raw.end(); return reply;
      }
      return reply.code(502).send({ error: { code: 'SPEECH_UNAVAILABLE', message: 'Speech synthesis unavailable', spoken_text: spoken }, request_id: req.id });
    }
    record('completed');
    if (streaming) { emit({ type: 'done', frames: pcmBytes / 2, synthesis_ms: Date.now() - started, first_audio_ms: firstAudioMs }); reply.raw.end(); return reply; }
    return { spoken_text: spoken, voice: input.voice, format, rewritten, provider, fallback, fallback_reason: reason || undefined,
      resolved_voice: voice(), request_id: req.id, synthesis_ms: Date.now() - started, audio_base64: audio.toString('base64') };
    } finally { req.raw.removeListener('aborted', cancel); reply.raw.removeListener('close', cancel); }
  });
}
