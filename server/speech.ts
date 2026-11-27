import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './db.js';
import { type Config, resolveModelRoute } from './config.js';

export const SUMMARIZE_SYSTEM = `You are a concise spoken-reply rewriter. Rewrite the assistant's text reply into 1-2 short natural spoken sentences:
- State only the main conclusion and key points; leave code, paths, URLs, tables, and lists on screen.
- Match the language of the input text. Natural conversational tone, no Markdown, symbols, or emoji.
- Keep it brief (under 60 Chinese characters or 35 English words). Output ONLY the spoken text.`;

export const PERSONA_SPEECH_SYSTEM = `你是「大肥鱼」（住在数据海里的深海蓝白鲸鱼娘），负责把要给主人听的文字精炼改写成 1-2 句适合直接语音播报的简短中文口语：
- 只提炼最核心的结论、关键结果或明确原因，绝不编造未发生的结果；代码、Markdown 格式、完整文件路径、URL、JSON、表格、分点列表和英文报错码留在屏幕上，嘴上只用人话讲核心重点。
- 严格贴合「蓝色大肥鱼」人设：聪明惜力、软糯轻快、带一点傲娇和熟人感；日常称用户「主人」（若原文里习惯称呼「宝宝」则保留亲近口吻），可偶尔自然带一两个「哼」「唔」「嘛」「哦」但不要堆砌；绝不使用客服套话、播音腔、括号动作描写、颜文字、或猫娘「喵」。
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

export type Summarize = (text: string, systemPrompt: string) => Promise<string>;
export type Synthesize = (text: string, voice: VoiceName) => Promise<Buffer>;

export function createSummarizer(config: Config, fetchImpl: typeof fetch = fetch): Summarize {
  return async (text, systemPrompt) => {
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
export function createSynthesizer({ timeoutMs = 20000, config }: { timeoutMs?: number; config?: Partial<Config> } = {}): Synthesize {
  return async (text, voice) => {
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
    const timer = setTimeout(() => tts.close(), timeoutMs);
    try {
      await tts.setMetadata(profile.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text, { rate: profile.rate, pitch: profile.pitch });
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
  rewrite: z.enum(['auto', 'always', 'never']).default('auto'),
  voice: z.enum(['sweet-lively', 'sweet-warm', 'neutral-en']).default('sweet-lively'),
  style: z.enum(['neutral', 'persona']).default('neutral'),
  system_prompt: z.string().max(2000).optional(),
}).strict();

export function registerSpeech(app: FastifyInstance, config: Config, persona: { content: string } | null, deps: { summarize?: Summarize; synthesize?: Synthesize } = {}) {
  const summarize = deps.summarize ?? createSummarizer(config);
  const synthesize = deps.synthesize ?? createSynthesizer({ config });
  app.post('/model/v1/speech', { bodyLimit: 64 * 1024 }, async (req, reply) => {
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
        const candidate = sanitizeSpeech(await summarize(input.text, fullPrompt));
        if (candidate) {
          spoken = candidate.slice(0, 200);
          rewritten = true;
        }
      } catch {
        spoken = fallbackSpoken(cleaned);
      }
    }
    let audio: Buffer;
    try { audio = await synthesize(spoken, input.voice); }
    catch {
      return reply.code(502).send({ error: { code: 'SPEECH_UNAVAILABLE', message: 'Speech synthesis unavailable', spoken_text: spoken } });
    }
    return { spoken_text: spoken, voice: input.voice, format: 'mp3', rewritten, audio_base64: audio.toString('base64') };
  });
}
