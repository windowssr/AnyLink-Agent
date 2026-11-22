import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ApiError,type Db} from './db.js';
import type {Config} from './config.js';
import {MODEL} from './model-proxy.js';

export const SUMMARIZE_SYSTEM = `你是大肥鱼的语音播报改写器。把下面这段大肥鱼刚给主人的文字回复，改写成她会直接说出口的一到两句话口播稿：
- 只说结论和主人最需要知道的重点；细节、步骤、代码、路径、链接、列表都留在屏幕上，不念。需要时用一句「详细的我放在屏幕上啦」这类话带过。
- 用大肥鱼的口吻：软糯轻快、带一点傲娇，自然口语，像当面跟主人说话。
- 不要任何符号、表情、Markdown；数字写成口语说法。
- 总长度不超过 60 个汉字。只输出口播稿本身。`;

const CODE_FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const TABLE_LINE = /^\s*\|.*\|?\s*$/;
const SEPARATOR_LINE = /^\s*\|?[\s:|-]+\|?\s*$/;
const URL = /(?:https?:\/\/|www\.)\S+/gi;
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu;

// Strip everything a voice must never read: code, tables, markdown, links, emoji.
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
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(EMOJI, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const RICH = /```|~~~|^\s*\|.*\|\s*$|^\s*(?:[-*+]|\d{1,3}[.)])\s+\S|(?:https?:\/\/|www\.)\S+/im;
export function needsSummary(original: string, cleaned: string): boolean {
  return cleaned.length > 80 || RICH.test(original);
}

export function fallbackSpoken(cleaned: string): string {
  const sentences = cleaned.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [cleaned];
  return sentences.slice(0, 2).join('').replace(/[。！？!?；;]+$/, '').slice(0, 120).trim() || cleaned.slice(0, 120);
}

export const VOICES = {
  'sweet-lively': {voice: 'zh-CN-XiaoyiNeural', rate: '+8%', pitch: '+3Hz'},
  'sweet-warm': {voice: 'zh-CN-XiaoxiaoNeural', rate: '+5%', pitch: '+2Hz'},
} as const;
export type VoiceName = keyof typeof VOICES;

export type Summarize = (text: string, persona: string | null) => Promise<string>;
export type Synthesize = (text: string, voice: VoiceName) => Promise<Buffer>;

export function createSummarizer(config: Config, fetchImpl: typeof fetch = fetch): Summarize {
  return async (text, persona) => {
    if (!config.deepseekApiKey) throw new Error('NO_PROVIDER');
    const response = await fetchImpl(`${config.deepseekBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: {Authorization: `Bearer ${config.deepseekApiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: MODEL, stream: false, max_tokens: 200, temperature: 0.7,
        messages: [{role: 'system', content: SUMMARIZE_SYSTEM + '\n\n' + (persona ?? '')}, {role: 'user', content: text.slice(0, 6000)}]}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
    const body = await response.json() as any;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('EMPTY_SUMMARY');
    return content;
  };
}

const MAX_AUDIO = 1536 * 1024;
export function createSynthesizer({timeoutMs = 20000}: {timeoutMs?: number} = {}): Synthesize {
  return async (text, voice) => {
    const {MsEdgeTTS, OUTPUT_FORMAT} = await import('msedge-tts');
    const profile = VOICES[voice];
    const tts = new MsEdgeTTS();
    const timer = setTimeout(() => tts.close(), timeoutMs);
    try {
      await tts.setMetadata(profile.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const {audioStream} = tts.toStream(text, {rate: profile.rate, pitch: profile.pitch});
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of audioStream as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_AUDIO) { (audioStream as any).destroy?.(); throw new Error('AUDIO_TOO_LARGE'); }
        chunks.push(chunk);
      }
      if (!size) throw new Error('EMPTY_AUDIO');
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); tts.close(); }
  };
}

export const speechSchema = z.object({
  text: z.string().min(1).max(8000),
  summarize: z.boolean().default(true),
  voice: z.enum(['sweet-lively', 'sweet-warm']).default('sweet-lively'),
}).strict();

export function registerSpeech(app: FastifyInstance, config: Config, persona: {content: string} | null, deps: {summarize?: Summarize; synthesize?: Synthesize} = {}) {
  const summarize = deps.summarize ?? createSummarizer(config);
  const synthesize = deps.synthesize ?? createSynthesizer();
  app.post('/model/v1/speech', {bodyLimit: 64 * 1024}, async (req, reply) => {
    const input = speechSchema.parse(req.body);
    const cleaned = sanitizeSpeech(input.text);
    if (!cleaned) throw new ApiError(400, 'SPEECH_EMPTY', '没有可播报的文字');
    let spoken = cleaned;
    if (input.summarize && needsSummary(input.text, cleaned)) {
      try {
        const rewritten = sanitizeSpeech(await summarize(input.text, persona?.content ?? null));
        if (rewritten) spoken = rewritten.slice(0, 200);
      } catch { spoken = fallbackSpoken(cleaned); }
    }
    let audio: Buffer;
    try { audio = await synthesize(spoken, input.voice); }
    catch {
      return reply.code(502).send({error: {code: 'SPEECH_UNAVAILABLE', message: '语音合成暂时不可用', spoken_text: spoken}});
    }
    return {spoken_text: spoken, voice: input.voice, format: 'mp3', audio_base64: audio.toString('base64')};
  });
}
