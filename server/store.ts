import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError } from './db.js';
import { OWNER_ID } from './config.js';

export type Queryable = Pick<PoolClient, 'query'>;

export const PLATFORMS = ['macos', 'android', 'linux', 'windows', 'ios', 'web', 'other'] as const;
export const MEMORY_SCOPES = ['global', 'device', 'agent'] as const;
export const MEMORY_KINDS = ['fact', 'preference', 'boundary', 'episode'] as const;

export const deviceSlugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'Slug must be 2-40 lowercase alphanumeric, hyphen or underscore characters');

export const deviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  platform: z.enum(PLATFORMS),
  slug: deviceSlugSchema.optional(),
}).strict();

export const devicePatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  slug: deviceSlugSchema.optional(),
}).strict().refine(v => v.name !== undefined || v.slug !== undefined, 'Provide name or slug');

/** Derive a clean base slug from a device name, falling back to platform when name has no ASCII alphanumerics. */
export function deriveSlugBase(name: string, platform: string): string {
  const cleaned = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (cleaned.length >= 2) return cleaned;
  return (platform || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Validate an explicit slug or generate the first unused unique slug for active devices. */
export async function resolveDeviceSlug(db: Queryable, preferred: string | undefined, name: string, platform: string, excludeDeviceId?: string): Promise<string> {
  if (preferred) {
    const slug = deviceSlugSchema.parse(preferred);
    const conflict = await db.query(
      'SELECT id FROM devices WHERE owner_id=$1 AND revoked_at IS NULL AND lower(slug)=lower($2) AND ($3::uuid IS NULL OR id<>$3)',
      [OWNER_ID, slug, excludeDeviceId ?? null],
    );
    if (conflict.rowCount) throw new ApiError(409, 'DEVICE_SLUG_TAKEN', `Device slug "${slug}" is already in use`);
    return slug;
  }
  const base = deriveSlugBase(name, platform);
  for (let i = 1; i <= 100; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 34)}-${i}`;
    const taken = await db.query(
      'SELECT 1 FROM devices WHERE owner_id=$1 AND revoked_at IS NULL AND lower(slug)=lower($2) AND ($3::uuid IS NULL OR id<>$3)',
      [OWNER_ID, candidate, excludeDeviceId ?? null],
    );
    if (!taken.rowCount) return candidate;
  }
  return `${base.slice(0, 30)}-${randomUUID().slice(0, 6)}`;
}

export const memorySearchSchema = z.object({
  q: z.string().max(300).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  device_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const memorySchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(4000),
  scope: z.enum(MEMORY_SCOPES),
  kind: z.enum(MEMORY_KINDS).default('fact'),
  tags: z.array(z.string().trim().min(1).max(40)).max(16).default([]),
  importance: z.number().min(0).max(1).default(0.6),
  applicable_device_id: z.uuid().nullable().optional(),
  applicable_agent_id: z.uuid().nullable().optional(),
}).strict().superRefine((v, c) => {
  if (v.scope === 'global' && (v.applicable_device_id || v.applicable_agent_id)) c.addIssue({ code: 'custom', message: 'Global memory cannot bind applicable_device_id or applicable_agent_id' });
  if (v.scope === 'device' && (!v.applicable_device_id || v.applicable_agent_id)) c.addIssue({ code: 'custom', message: 'Device memory requires applicable_device_id and cannot bind applicable_agent_id' });
  if (v.scope === 'agent' && v.applicable_device_id) c.addIssue({ code: 'custom', message: 'Agent memory derives device from agent and cannot specify applicable_device_id' });
});

export const memoryPatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().trim().min(1).max(4000).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
  importance: z.number().min(0).max(1).optional(),
  expected_revision: z.number().int().positive(),
}).strict().refine(v => v.title !== undefined || v.content !== undefined || v.kind !== undefined || v.tags !== undefined || v.importance !== undefined, 'At least one field must be updated');

export type Source = { deviceId?: string | null; agentId?: string | null; requestId?: string | null; kind: string };
export type Viewer = { agentId?: string | null; deviceId?: string | null };

/** Tokenize mixed CJK + Latin/number text into normalized search tokens (CJK unigrams + bigrams, Latin words). */
export function tokenizeText(raw: string): string[] {
  const text = String(raw ?? '').toLowerCase().normalize('NFKC');
  const tokens = new Set<string>();
  const latin = text.match(/[a-z0-9][a-z0-9_.-]{1,}/g) ?? [];
  for (const word of latin) {
    tokens.add(word);
    if (word.includes('.') || word.includes('-') || word.includes('_')) {
      for (const part of word.split(/[._-]+/)) if (part.length >= 2) tokens.add(part);
    }
  }
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length; i++) {
      tokens.add(run[i]);
      if (i + 1 < run.length) tokens.add(run.slice(i, i + 2));
    }
  }
  return [...tokens];
}

export function buildSearchTokens(title: string, content: string, tags: string[] = []): string {
  return tokenizeText(`${title} ${content} ${tags.join(' ')}`).slice(0, 400).join(' ');
}

export function lexicalScore(query: string, title: string, content: string, tags: string[] = []): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const hay = `${title} ${content} ${tags.join(' ')}`.toLowerCase();
  const qTokens = tokenizeText(q);
  if (!qTokens.length) return hay.includes(q) ? 1 : 0;
  const docTokens = new Set(tokenizeText(hay));
  let hits = 0;
  let weightedHits = 0;
  let totalWeight = 0;
  for (const tok of qTokens) {
    // Bigrams and multi-char words carry higher weight than single CJK chars.
    const w = tok.length >= 2 ? 2.0 : 0.6;
    totalWeight += w;
    if (docTokens.has(tok)) {
      hits++;
      weightedHits += w;
    }
  }
  if (hits === 0 && !hay.includes(q)) return 0;
  const exactBonus = hay.includes(q) ? 0.35 : 0;
  const titleBonus = title.toLowerCase().includes(q) ? 0.2 : 0;
  return Math.min(1, (totalWeight > 0 ? weightedHits / totalWeight : 0) * 0.75 + exactBonus + titleBonus);
}

export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? Math.max(0, Math.min(1, dot / denom)) : 0;
}

export async function requireDevice(db: Queryable, id?: string | null) {
  if (!id) return;
  if (!(await db.query('SELECT id FROM devices WHERE id=$1 AND owner_id=$2', [id, OWNER_ID])).rowCount) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
}

export async function requireAgent(db: Queryable, id?: string | null) {
  if (!id) return null;
  const row = (await db.query('SELECT id,device_id,key,name,kind,summary,capabilities FROM agents WHERE id=$1 AND owner_id=$2', [id, OWNER_ID])).rows[0];
  if (!row) throw new ApiError(404, 'AGENT_NOT_FOUND', 'Agent not found');
  return row;
}

export async function createDevice(db: Queryable, input: z.infer<typeof deviceSchema>) {
  const slug = await resolveDeviceSlug(db, input.slug, input.name, input.platform);
  return (await db.query('INSERT INTO devices(id,owner_id,name,platform,slug) VALUES($1,$2,$3,$4,$5) RETURNING *,false AS executor_connected', [randomUUID(), OWNER_ID, input.name, input.platform, slug])).rows[0];
}

export async function updateDevice(db: Queryable, id: string, input: z.infer<typeof devicePatchSchema>) {
  const existing = (await db.query('SELECT * FROM devices WHERE id=$1 AND owner_id=$2', [id, OWNER_ID])).rows[0];
  if (!existing) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
  const slug = input.slug !== undefined ? await resolveDeviceSlug(db, input.slug, input.name ?? existing.name, existing.platform, id) : existing.slug;
  return (await db.query('UPDATE devices SET name=COALESCE($2,name),slug=$3,revision=revision+1 WHERE id=$1 RETURNING *,false AS executor_connected', [id, input.name ?? null, slug])).rows[0];
}

export async function listDevices(db: Queryable) {
  return (await db.query('SELECT *,false AS executor_connected FROM devices WHERE owner_id=$1 ORDER BY created_at,id', [OWNER_ID])).rows;
}

export async function searchMemories(db: Queryable, input: { q?: string; scope?: string; kind?: string; device_id?: string; limit?: number; context?: boolean; viewer?: Viewer }) {
  if (input.device_id) await requireDevice(db, input.device_id);
  const limit = Math.min(input.limit ?? 100, 100);
  const query = (input.q ?? '').trim();
  const rows = (await db.query(`SELECT m.*,d.name AS device_name FROM memories m LEFT JOIN devices d ON d.id=m.applicable_device_id
    WHERE m.owner_id=$1 AND NOT m.deleted
    AND ($2='' OR m.scope=$2)
    AND ($3='' OR m.kind=$3)
    AND ($4::uuid IS NULL OR m.applicable_device_id=$4 OR ($5 AND m.scope='global'))
    AND ($6::uuid IS NULL OR m.scope<>'agent' OR m.applicable_agent_id=$6)
    ORDER BY m.updated_at DESC,m.id LIMIT $7`,
  [OWNER_ID, input.scope ?? '', input.kind ?? '', input.device_id ?? null, input.context ?? false, input.viewer?.agentId ?? null, query ? 300 : limit])).rows;

  if (!query) return rows.slice(0, limit);

  const scored = rows
    .map(row => {
      const tags = Array.isArray(row.tags) ? row.tags : [];
      const lex = lexicalScore(query, row.title ?? '', row.content ?? '', tags);
      return { row, lex };
    })
    .filter(item => item.lex > 0)
    .sort((a, b) => b.lex - a.lex || new Date(b.row.updated_at).getTime() - new Date(a.row.updated_at).getTime());

  return scored.slice(0, limit).map(s => ({ ...s.row, score: Number(s.lex.toFixed(4)) }));
}

export async function saveMemory(db: Queryable, input: z.infer<typeof memorySchema>, source: Source, embedding: number[] | null = null) {
  let applicableDeviceId = input.applicable_device_id ?? null;
  const applicableAgentId = input.applicable_agent_id ?? null;
  if (input.scope === 'agent') {
    const agent = await requireAgent(db, applicableAgentId);
    if (!agent) throw new ApiError(400, 'AGENT_REQUIRED', 'Agent memory requires applicable_agent_id');
    applicableDeviceId = agent.device_id;
  }
  await requireDevice(db, applicableDeviceId);
  await requireDevice(db, source.deviceId);
  const existing = (await db.query(`SELECT * FROM memories WHERE owner_id=$1 AND NOT deleted AND scope=$2 AND applicable_device_id IS NOT DISTINCT FROM $3::uuid AND applicable_agent_id IS NOT DISTINCT FROM $4::uuid AND title=$5 AND content=$6 LIMIT 1`,
    [OWNER_ID, input.scope, applicableDeviceId, applicableAgentId, input.title, input.content])).rows[0];
  if (existing) return existing;
  const tags = input.tags ?? [];
  const kind = input.kind ?? 'fact';
  const importance = input.importance ?? 0.6;
  const searchTokens = buildSearchTokens(input.title, input.content, tags);
  const row = (await db.query(`INSERT INTO memories(id,owner_id,title,content,scope,kind,tags,importance,embedding,search_tokens,applicable_device_id,applicable_agent_id,source_device_id,source_agent_id,source_request_id,source_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
  [randomUUID(), OWNER_ID, input.title, input.content, input.scope, kind, JSON.stringify(tags), importance, embedding ? JSON.stringify(embedding) : null, searchTokens, applicableDeviceId, applicableAgentId, source.deviceId ?? null, source.agentId ?? null, source.requestId ?? null, source.kind])).rows[0];
  await db.query('INSERT INTO memory_revisions(memory_id,revision,snapshot) VALUES($1,$2,$3)', [row.id, row.revision, JSON.stringify(row)]);
  return row;
}

export async function getMemory(db: Queryable, id: string, viewer?: Viewer) {
  const row = (await db.query(`SELECT m.*,d.name AS device_name FROM memories m LEFT JOIN devices d ON d.id=m.applicable_device_id WHERE m.id=$1 AND m.owner_id=$2 AND NOT m.deleted AND ($3::uuid IS NULL OR m.scope<>'agent' OR m.applicable_agent_id=$3)`,
    [id, OWNER_ID, viewer?.agentId ?? null])).rows[0];
  if (!row) throw new ApiError(404, 'MEMORY_NOT_FOUND', 'Memory not found or deleted');
  return row;
}

function assertWritableScope(current: any, viewer?: Viewer) {
  if (!viewer) return;
  if (current.scope === 'agent' && viewer.agentId && current.applicable_agent_id !== viewer.agentId) {
    throw new ApiError(404, 'MEMORY_NOT_FOUND', 'Memory not found or deleted');
  }
  if (current.scope === 'device' && viewer.deviceId && current.applicable_device_id !== viewer.deviceId) {
    throw new ApiError(403, 'DEVICE_SCOPE_FORBIDDEN', 'Edge device cannot modify another device memory');
  }
}

export async function editMemory(db: Queryable, id: string, input: z.infer<typeof memoryPatchSchema>, source: Source, viewer?: Viewer, embedding: number[] | null = null) {
  const existing = await getMemory(db, id, viewer);
  assertWritableScope(existing, viewer);
  const nextTitle = input.title ?? existing.title;
  const nextContent = input.content ?? existing.content;
  const nextKind = input.kind ?? existing.kind ?? 'fact';
  const nextTags = input.tags ?? (Array.isArray(existing.tags) ? existing.tags : []);
  const nextImportance = input.importance ?? existing.importance ?? 0.6;
  const searchTokens = buildSearchTokens(nextTitle, nextContent, nextTags);
  const row = (await db.query(`UPDATE memories SET title=$1,content=$2,kind=$3,tags=$4,importance=$5,search_tokens=$6,embedding=COALESCE($7,embedding),revision=revision+1,updated_at=now(),source_device_id=$8,source_agent_id=COALESCE($9,source_agent_id),source_request_id=$10,source_kind=$11
    WHERE id=$12 AND owner_id=$13 AND NOT deleted AND revision=$14 AND ($15::uuid IS NULL OR scope<>'agent' OR applicable_agent_id=$15) AND ($16::uuid IS NULL OR scope<>'device' OR applicable_device_id=$16) RETURNING *`,
  [nextTitle, nextContent, nextKind, JSON.stringify(nextTags), nextImportance, searchTokens, embedding ? JSON.stringify(embedding) : null, source.deviceId ?? null, source.agentId ?? null, source.requestId ?? null, source.kind, id, OWNER_ID, input.expected_revision, viewer?.agentId ?? null, viewer?.deviceId ?? null])).rows[0];
  if (!row) {
    await getMemory(db, id, viewer);
    throw new ApiError(409, 'REVISION_CONFLICT', 'Memory was modified; refresh and retry');
  }
  await db.query('INSERT INTO memory_revisions(memory_id,revision,snapshot) VALUES($1,$2,$3)', [id, row.revision, JSON.stringify(row)]);
  return row;
}

export async function deleteMemory(db: Queryable, id: string, revision: number, viewer?: Viewer) {
  const existing = await getMemory(db, id, viewer);
  assertWritableScope(existing, viewer);
  const row = (await db.query(`UPDATE memories SET deleted=true,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 AND revision=$3 AND NOT deleted AND ($4::uuid IS NULL OR scope<>'agent' OR applicable_agent_id=$4) AND ($5::uuid IS NULL OR scope<>'device' OR applicable_device_id=$5) RETURNING *`,
    [id, OWNER_ID, revision, viewer?.agentId ?? null, viewer?.deviceId ?? null])).rows[0];
  if (!row) {
    await getMemory(db, id, viewer);
    throw new ApiError(409, 'REVISION_CONFLICT', 'Memory was modified; refresh and retry');
  }
  await db.query('INSERT INTO memory_revisions(memory_id,revision,snapshot) VALUES($1,$2,$3)', [id, row.revision, JSON.stringify(row)]);
  return { id, revision: row.revision, deleted: true };
}

export async function memoryDirectory(db: Queryable, id: string) {
  await requireDevice(db, id);
  const facts = await searchMemories(db, { device_id: id, scope: 'device' });
  return { device_id: id, executor_connected: false, source: 'current_active_facts', entries: facts.map(m => ({ id: m.id, title: m.title, revision: m.revision, updated_at: m.updated_at })) };
}
