import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const OWNER_ID = '00000000-0000-4000-8000-000000000001';

function secret(name: string) {
  const path = process.env[`${name}_FILE`];
  return path ? readFileSync(path, 'utf8').trim() : process.env[name];
}

const modelRouteSchema = z.object({
  id: z.string().min(1).max(120),
  upstreamModel: z.string().min(1).max(120).optional(),
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  ownedBy: z.string().min(1).max(80).default('custom'),
  inputModalities: z.array(z.enum(['text', 'image', 'audio'])).default(['text']),
  aliases: z.array(z.string().min(1).max(120)).default([]),
});

export type ModelRoute = z.infer<typeof modelRouteSchema>;

function parseModels(fallbackBaseUrl: string, fallbackKey: string, defaultModel: string): ModelRoute[] {
  const raw = process.env.ANYLINK_MODELS_JSON?.trim();
  const routes: ModelRoute[] = [];
  if (raw) {
    const parsed = z.array(modelRouteSchema).parse(JSON.parse(raw));
    routes.push(...parsed);
  }
  if (!routes.length && fallbackKey) {
    // Backward-compatible default routes when only DEEPSEEK_API_KEY / MODEL_API_KEY is set.
    routes.push(
      {
        id: defaultModel,
        upstreamModel: defaultModel,
        baseUrl: fallbackBaseUrl,
        apiKey: fallbackKey,
        ownedBy: fallbackBaseUrl.includes('deepseek') ? 'deepseek' : 'provider',
        inputModalities: ['text', 'image'],
        aliases: defaultModel === 'deepseek-flash' ? ['default'] : ['default', 'deepseek-flash'],
      },
      ...(defaultModel !== 'deepseek-chat' ? [{
        id: 'deepseek-chat',
        upstreamModel: 'deepseek-chat',
        baseUrl: fallbackBaseUrl,
        apiKey: fallbackKey,
        ownedBy: fallbackBaseUrl.includes('deepseek') ? 'deepseek' : 'provider',
        inputModalities: ['text' as const, 'image' as const],
        aliases: [] as string[],
      }] : []),
    );
  }
  return routes;
}

export function loadConfig() {
  const rawProviderKey = secret('MODEL_API_KEY') ?? secret('DEEPSEEK_API_KEY') ?? '';
  const providerKey = /^(REPLACE_|CONFIGURE_)/.test(rawProviderKey) ? '' : rawProviderKey;
  const rawJoinKey = secret('ANYLINK_JOIN_KEY') ?? '';
  const joinKey = /^(REPLACE_|CONFIGURE_|GENERATE_)/.test(rawJoinKey) ? '' : rawJoinKey;
  const rawLoginPassword = secret('ANYLINK_LOGIN_PASSWORD') ?? '';
  const loginPassword = /^(REPLACE_|CONFIGURE_|GENERATE_)/.test(rawLoginPassword) ? '' : rawLoginPassword;
  const deepseekBaseUrl = process.env.MODEL_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1';
  const defaultModel = process.env.ANYLINK_DEFAULT_MODEL?.trim() || 'deepseek-flash';
  const memoryModel = process.env.ANYLINK_MEMORY_MODEL?.trim() || defaultModel;
  const embeddingModel = process.env.ANYLINK_EMBEDDING_MODEL?.trim() || '';
  const embeddingBaseUrl = process.env.ANYLINK_EMBEDDING_BASE_URL?.trim() || deepseekBaseUrl;
  const embeddingApiKey = secret('ANYLINK_EMBEDDING_API_KEY') ?? providerKey;
  const models = parseModels(deepseekBaseUrl, providerKey, defaultModel);

  return z.object({
    databaseUrl: z.string().min(1),
    ownerToken: z.string().min(24),
    deepseekApiKey: z.string().refine(v => v === '' || v.length >= 20, 'Configure a provider key or leave it empty').default(''),
    deepseekBaseUrl: z.url().default('https://api.deepseek.com/v1'),
    defaultModel: z.string().min(1).max(120).default('deepseek-flash'),
    memoryModel: z.string().min(1).max(120).default('deepseek-flash'),
    embeddingModel: z.string().max(120).default(''),
    embeddingBaseUrl: z.url().default('https://api.deepseek.com/v1'),
    embeddingApiKey: z.string().default(''),
    models: z.array(modelRouteSchema).default([]),
    allowAnyModel: z.boolean().default(false),
    gatewayAutoMemoryDefault: z.boolean().default(false),
    maxGlobalConcurrency: z.number().int().min(1).max(200).default(16),
    maxAgentConcurrency: z.number().int().min(1).max(50).default(4),
    maxAgentRpm: z.number().int().min(1).max(600).default(60),
    trustProxy: z.union([z.boolean(), z.string()]).default('loopback'),
    origin: z.url().default('http://127.0.0.1:3180'),
    host: z.string().default('127.0.0.1'),
    port: z.coerce.number().int().min(1).max(65535).default(3180),
    joinKey: z.string().refine(v => v === '' || v.length >= 24, 'Configure a join key of at least 24 characters or leave it empty to disable joins').default(''),
    loginPassword: z.string().refine(v => v === '' || v.length >= 6, 'Configure a login password of at least 6 characters or leave it empty').default(''),
    personaFile: z.string().default(''),
    speechPrompt: z.string().default(''),
    leaseReaperIntervalMs: z.number().int().min(1000).max(300000).default(15000),
    memoryDebounceMs: z.number().int().min(0).max(300000).default(15000),
    memoryBatchMax: z.number().int().min(1).max(30).default(6),
  }).parse({
    databaseUrl: secret('DATABASE_URL'),
    ownerToken: secret('OWNER_TOKEN'),
    deepseekApiKey: providerKey,
    deepseekBaseUrl,
    defaultModel,
    memoryModel,
    embeddingModel,
    embeddingBaseUrl,
    embeddingApiKey,
    models,
    allowAnyModel: process.env.ANYLINK_ALLOW_ANY_MODEL === 'true',
    gatewayAutoMemoryDefault: process.env.ANYLINK_AUTO_MEMORY_DEFAULT === 'true',
    maxGlobalConcurrency: process.env.ANYLINK_MAX_CONCURRENCY ? Number(process.env.ANYLINK_MAX_CONCURRENCY) : 16,
    maxAgentConcurrency: process.env.ANYLINK_MAX_AGENT_CONCURRENCY ? Number(process.env.ANYLINK_MAX_AGENT_CONCURRENCY) : 4,
    maxAgentRpm: process.env.ANYLINK_MAX_AGENT_RPM ? Number(process.env.ANYLINK_MAX_AGENT_RPM) : 60,
    trustProxy: process.env.ANYLINK_TRUST_PROXY === 'false' ? false : (process.env.ANYLINK_TRUST_PROXY || 'loopback'),
    origin: process.env.APP_ORIGIN,
    host: process.env.HOST,
    port: process.env.PORT,
    joinKey,
    loginPassword,
    personaFile: process.env.ANYLINK_PERSONA_FILE ?? 'examples/persona/dafeiyu.md',
    speechPrompt: process.env.ANYLINK_SPEECH_PROMPT ?? '',
    leaseReaperIntervalMs: process.env.ANYLINK_LEASE_REAPER_MS ? Number(process.env.ANYLINK_LEASE_REAPER_MS) : 15000,
    memoryDebounceMs: process.env.ANYLINK_MEMORY_DEBOUNCE_MS !== undefined ? Number(process.env.ANYLINK_MEMORY_DEBOUNCE_MS) : 15000,
    memoryBatchMax: process.env.ANYLINK_MEMORY_BATCH_MAX ? Number(process.env.ANYLINK_MEMORY_BATCH_MAX) : 6,
  });
}

export type Config = ReturnType<typeof loadConfig>;

/** Resolve a requested model name or alias to an upstream ModelRoute. */
export function resolveModelRoute(config: Pick<Config, 'models' | 'deepseekApiKey' | 'deepseekBaseUrl' | 'allowAnyModel' | 'defaultModel'>, requested?: string): ModelRoute | null {
  const routes = config.models?.length ? config.models : parseModels(config.deepseekBaseUrl, config.deepseekApiKey, config.defaultModel || 'deepseek-flash');
  if (!routes.length) return null;
  const name = (requested || config.defaultModel || 'default').trim();
  const exact = routes.find(r => r.id === name || r.aliases.includes(name));
  if (exact) return exact;
  if (config.allowAnyModel) {
    const base = routes[0];
    return { ...base, id: name, upstreamModel: name, aliases: [] };
  }
  return null;
}

/** List all publicly exposed model entries for GET /model/v1/models. */
export function listModelRoutes(config: Pick<Config, 'models' | 'deepseekApiKey' | 'deepseekBaseUrl' | 'defaultModel'>): ModelRoute[] {
  return config.models?.length ? config.models : parseModels(config.deepseekBaseUrl, config.deepseekApiKey, config.defaultModel || 'deepseek-flash');
}
