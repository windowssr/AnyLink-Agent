import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
export const OWNER_ID = '00000000-0000-4000-8000-000000000001';
function secret(name: string) {
  const path = process.env[`${name}_FILE`];
  return path ? readFileSync(path, 'utf8').trim() : process.env[name];
}
export function loadConfig() {
  const providerKey=secret('DEEPSEEK_API_KEY')??'';
  const joinKey=secret('ANYLINK_JOIN_KEY')??'';
  return z.object({
    databaseUrl: z.string().min(1), ownerToken: z.string().min(24), deepseekApiKey:z.string().refine(v=>v===''||v.length>=20,'Configure a provider key or leave it empty').default(''),
    deepseekBaseUrl:z.url().default('https://api.deepseek.com/v1'),origin: z.url().default('http://127.0.0.1:3180'),
    host: z.string().default('127.0.0.1'), port: z.coerce.number().int().min(1).max(65535).default(3180),
    joinKey:z.string().refine(v=>v===''||v.length>=24,'Configure a join key of at least 24 characters or leave it empty to disable joins').default(''),
    personaFile:z.string().min(1).default('persona/dafeiyu.md'),
  }).parse({
    databaseUrl: secret('DATABASE_URL'), ownerToken: secret('OWNER_TOKEN'),deepseekApiKey:/^(REPLACE_|CONFIGURE_)/.test(providerKey)?'':providerKey,
    deepseekBaseUrl:process.env.DEEPSEEK_BASE_URL, origin: process.env.APP_ORIGIN,
    host: process.env.HOST, port: process.env.PORT,
    joinKey:/^(?:|REPLACE_|CONFIGURE_)/.test(joinKey)?'':joinKey,
    personaFile:process.env.ANYLINK_PERSONA_FILE??'persona/dafeiyu.md',
  });
}
export type Config = ReturnType<typeof loadConfig>;
