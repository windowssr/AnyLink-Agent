import { readFileSync } from 'node:fs';
import { z } from 'zod';
export const OWNER_ID = '00000000-0000-4000-8000-000000000001';
function secret(name: string) {
  const path = process.env[`${name}_FILE`];
  return path ? readFileSync(path, 'utf8').trim() : process.env[name];
}
export function loadConfig() {
  return z.object({
    databaseUrl: z.string().min(1), ownerToken: z.string().min(24), gatewayToken: z.string().min(24),
    gatewayUrl: z.url().default('http://openclaw:18789'), origin: z.url().default('http://127.0.0.1:3180'),
    host: z.string().default('127.0.0.1'), port: z.coerce.number().int().min(1).max(65535).default(3180),
  }).parse({
    databaseUrl: secret('DATABASE_URL'), ownerToken: secret('OWNER_TOKEN'), gatewayToken: secret('GATEWAY_TOKEN'),
    gatewayUrl: process.env.GATEWAY_URL, origin: process.env.APP_ORIGIN,
    host: process.env.HOST, port: process.env.PORT,
  });
}
export type Config = ReturnType<typeof loadConfig>;
