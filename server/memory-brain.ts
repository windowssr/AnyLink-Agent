import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Config, OWNER_ID, resolveModelRoute } from './config.js';
import { type Db, transaction } from './db.js';
import { cosineSimilarity, deleteMemory, editMemory, lexicalScore, MEMORY_KINDS, MEMORY_SCOPES, saveMemory } from './store.js';

export const episodeMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().min(1).max(8000),
  name: z.string().max(80).optional(),
}).strict();

export const memoryAssembleSchema = z.object({
  query: z.string().max(2000).optional(),
  max_memories: z.number().int().min(1).max(50).default(15),
  max_episodes: z.number().int().min(0).max(20).default(6),
  max_chars: z.number().int().min(500).max(40000).default(12000),
  include_scopes: z.array(z.enum(MEMORY_SCOPES)).min(1).max(3).default(['global', 'device', 'agent']),
  include_boundaries: z.boolean().default(true),
  include_persona: z.boolean().default(false),
}).strict();

export const memoryIngestSchema = z.object({
  kind: z.enum(['turn', 'task_outcome', 'observation']).default('turn'),
  session_key: z.string().max(160).optional(),
  messages: z.array(episodeMessageSchema).min(1).max(50),
  metadata: z.record(z.string(), z.unknown()).default({}),
  consolidate_now: z.boolean().default(false),
}).strict();

const llmOperationSchema = z.object({
  op: z.enum(['create', 'update', 'delete']),
  id: z.uuid().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().trim().min(1).max(4000).optional(),
  scope: z.enum(MEMORY_SCOPES).default('global'),
  kind: z.enum(['fact', 'preference', 'boundary']).default('fact'),
  tags: z.array(z.string().trim().min(1).max(40)).max(16).default([]),
  importance: z.number().min(0).max(1).default(0.65),
});

const llmConsolidationSchema = z.object({
  episode_summary: z.string().max(500).default(''),
  operations: z.array(llmOperationSchema).max(10).default([]),
});

const MEMORY_MANAGER_PROMPT = `You are the AnyLink Cloud Memory Manager for a personal multi-device Agent Network.
Your sole responsibility is managing shared cross-device memory cleanly and accurately.

Given an incoming episode (conversation turn, cross-device task outcome, or observation) from one edge device/agent, plus existing candidate memories:
1. Write a concise 1-sentence "episode_summary" in the user's language describing what happened (useful for cross-device continuity). Return "" if purely trivial chitchat (e.g. "hi", "ok").
2. Decide memory "operations" (create / update / delete) ONLY for durable, useful knowledge:
   - User preferences, profile facts, ongoing projects/goals -> scope: "global", kind: "preference" or "fact"
   - Device-specific paths, environment, installed tools -> scope: "device", kind: "fact"
   - Cross-device capability boundaries (what a specific device/agent CAN or CANNOT do, especially when a task was declined or failed due to missing capability/permission) -> scope: "global", kind: "boundary", clearly naming the device/agent in title and content so other devices learn not to repeat impossible requests!
   - Agent-private working conventions -> scope: "agent", kind: "fact"
3. Deduplicate & consolidate: if an existing candidate memory covers the same topic, emit "update" with its exact "id" instead of creating a duplicate! If an existing memory is explicitly contradicted or forgotten by the user, emit "update" or "delete" with its exact "id".
4. Never fabricate facts. Return ONLY valid JSON matching:
{"episode_summary":"...","operations":[{"op":"create|update|delete","id":"uuid-if-update-or-delete","title":"...","content":"...","scope":"global|device|agent","kind":"fact|preference|boundary","tags":["..."],"importance":0.7}]}`;

export type MemoryBrainDeps = {
  fetchImpl?: typeof fetch;
  onMemoryUpdated?: (event: { episode_id: string; actions: unknown[] }) => void;
};

async function computeEmbedding(config: Config, text: string, fetchImpl: typeof fetch = fetch): Promise<number[] | null> {
  if (!config.embeddingModel || !config.embeddingApiKey) return null;
  try {
    const res = await fetchImpl(config.embeddingBaseUrl.replace(/\/$/, '') + '/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.embeddingApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.embeddingModel, input: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const vec = data?.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.every((n: unknown) => typeof n === 'number') ? vec : null;
  } catch {
    return null;
  }
}

function recencyScore(iso: string | Date): number {
  const ageHours = Math.max(0, (Date.now() - new Date(iso).getTime()) / 3600000);
  // Half-life ~14 days (336 hours)
  return Math.exp(-ageHours / 480);
}

function parseJsonObject(raw: string): unknown {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('NO_JSON_OBJECT');
  return JSON.parse(stripped.slice(start, end + 1));
}

function deterministicSummary(kind: string, messages: Array<{ role: string; content: string }>, metadata: Record<string, unknown>, deviceName: string): string {
  if (kind === 'task_outcome') {
    const state = String(metadata.state ?? '');
    const target = String(metadata.target_label ?? metadata.target_device_name ?? '远程设备');
    const instruction = String(metadata.instruction ?? messages[0]?.content ?? '').slice(0, 120);
    const reason = String(metadata.error_message ?? metadata.reply ?? messages.at(-1)?.content ?? '').slice(0, 180);
    return `[${deviceName} → ${target}] (${state}) ${instruction}${reason ? `：${reason}` : ''}`.slice(0, 320);
  }
  const userMsg = messages.find(m => m.role === 'user')?.content?.trim() ?? messages[0]?.content?.trim() ?? '';
  const assistantMsg = [...messages].reverse().find(m => m.role === 'assistant')?.content?.trim() ?? '';
  if (!userMsg) return '';
  const compactUser = userMsg.replace(/\s+/g, ' ').slice(0, 120);
  const compactAssistant = assistantMsg.replace(/\s+/g, ' ').slice(0, 140);
  return compactAssistant ? `[${deviceName}] ${compactUser} → ${compactAssistant}` : `[${deviceName}] ${compactUser}`;
}

const TRIVIAL_CHITCHAT = /^(?:hi|hello|hey|ok|okay|k|thx|thanks|thank you|bye|goodbye|yes|no|yep|nope|lol|haha|你好|您好|哈喽|嗨|在吗|在不在|好的|好呀|好哒|嗯|嗯嗯|哦|哦哦|行|可以|收到|明白|了解|谢谢|多谢|感谢|哈哈|哈哈哈|拜拜|再见|早|早安|晚安|没问题)[!！?？。.~～\s]*$/i;

/** Detect purely trivial short greetings/acks so we don't burn cloud memory LLM tokens on noise. */
export function isTrivialTurn(messages: Array<{ role: string; content: string }>): boolean {
  if (messages.length === 0 || messages.length > 2) return false;
  const userMsgs = messages.filter(m => m.role === 'user').map(m => m.content.trim());
  if (!userMsgs.length) return false;
  const userText = userMsgs.join(' ');
  if (userText.length > 16) return false;
  if (!TRIVIAL_CHITCHAT.test(userText)) return false;
  const assistantText = messages.filter(m => m.role === 'assistant').map(m => m.content.trim()).join(' ');
  return assistantText.length <= 120;
}

export class MemoryBrain {
  private pending = new Set<Promise<void>>();
  private debounceBatches = new Map<string, { episodeIds: string[]; timer: ReturnType<typeof setTimeout> }>();
  private ownerChain: Promise<unknown> = Promise.resolve();
  private fetchImpl: typeof fetch;
  private onMemoryUpdated?: MemoryBrainDeps['onMemoryUpdated'];

  constructor(private db: Db, private config: Config, deps: MemoryBrainDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.onMemoryUpdated = deps.onMemoryUpdated;
  }

  /** Serialize consolidation passes per owner so concurrent updates never clobber memory revisions. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.ownerChain.then(fn, fn);
    this.ownerChain = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Re-enqueue any pending episodes left behind by an unexpected server restart. */
  async recoverPending(): Promise<number> {
    const rows = (await this.db.query(
      "SELECT id FROM memory_episodes WHERE owner_id=$1 AND status='pending' ORDER BY created_at ASC LIMIT 50",
      [OWNER_ID],
    )).rows;
    if (!rows.length) return 0;
    for (const r of rows) {
      this.track(this.consolidateEpisode(r.id).then(() => {}).catch(() => {}));
    }
    return rows.length;
  }

  private track(promise: Promise<void>) {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  /** Immediately flush all buffered debounce batches into background consolidation jobs. */
  flushDebounced(): void {
    for (const [key, batch] of [...this.debounceBatches]) {
      clearTimeout(batch.timer);
      this.debounceBatches.delete(key);
      if (batch.episodeIds.length) {
        this.track(this.consolidateBatch(batch.episodeIds).then(() => {}).catch(() => {}));
      }
    }
  }

  /** Flush all debounce timers and wait for all background memory consolidation jobs. */
  async drain(): Promise<void> {
    this.flushDebounced();
    while (this.pending.size > 0 || this.debounceBatches.size > 0) {
      if (this.debounceBatches.size > 0) this.flushDebounced();
      await Promise.allSettled([...this.pending]);
    }
  }

  /** Hybrid context assembly: combines lexical CJK+Latin matching, optional embeddings, recency, importance, boundaries & recent episodes. */
  async assemble(
    identity: { device_id: string; agent_id: string },
    rawInput: z.input<typeof memoryAssembleSchema> = {},
    persona: { name: string; sha256: string; content: string } | null = null,
  ) {
    const input = memoryAssembleSchema.parse(rawInput);
    const query = (input.query ?? '').trim();
    const scopes = new Set(input.include_scopes);

    const [memRows, epRows, queryVec] = await Promise.all([
      this.db.query(`SELECT m.*, d.name AS device_name FROM memories m LEFT JOIN devices d ON d.id=m.applicable_device_id
        WHERE m.owner_id=$1 AND NOT m.deleted
        AND (
          (m.scope='global')
          OR (m.scope='device' AND m.applicable_device_id=$2)
          OR (m.scope='agent' AND m.applicable_agent_id=$3)
        )
        ORDER BY m.updated_at DESC LIMIT 300`, [OWNER_ID, identity.device_id, identity.agent_id]),
      input.max_episodes > 0
        ? this.db.query(`SELECT e.id,e.source_device_id,e.source_agent_id,e.kind,e.summary,e.status,e.metadata,e.created_at,d.name AS device_name,a.name AS agent_name
            FROM memory_episodes e
            LEFT JOIN devices d ON d.id=e.source_device_id
            LEFT JOIN agents a ON a.id=e.source_agent_id
            WHERE e.owner_id=$1 AND e.summary <> ''
            ORDER BY e.created_at DESC LIMIT $2`, [OWNER_ID, input.max_episodes])
        : Promise.resolve({ rows: [] as any[] }),
      query ? computeEmbedding(this.config, query, this.fetchImpl) : Promise.resolve(null),
    ]);

    const filtered = memRows.rows.filter(r => scopes.has(r.scope) || (input.include_boundaries && r.kind === 'boundary'));

    const scored = filtered.map(row => {
      const tags = Array.isArray(row.tags) ? row.tags : [];
      const lex = query ? lexicalScore(query, row.title ?? '', row.content ?? '', tags) : 0;
      const vec = queryVec && Array.isArray(row.embedding) ? cosineSimilarity(queryVec, row.embedding) : 0;
      const rec = recencyScore(row.updated_at ?? row.created_at);
      const imp = typeof row.importance === 'number' ? row.importance : 0.6;
      const scopeBoost = row.scope === 'agent' ? 0.06 : row.scope === 'device' ? 0.04 : 0.02;
      const boundaryBoost = row.kind === 'boundary' ? 0.08 : 0;
      const score = query
        ? (queryVec ? (0.42 * lex + 0.36 * vec) : (0.72 * lex)) + 0.14 * rec + 0.10 * imp + scopeBoost + boundaryBoost
        : 0.50 * rec + 0.38 * imp + scopeBoost + boundaryBoost;
      return { row, score, lex };
    });

    // Split boundaries so edge agents always remember what remote devices cannot do.
    const boundaries = input.include_boundaries
      ? scored
        .filter(s => s.row.kind === 'boundary')
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(8, input.max_memories))
      : [];
    const boundaryIds = new Set(boundaries.map(b => b.row.id));

    const regular = scored
      .filter(s => !boundaryIds.has(s.row.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, input.max_memories);

    // Budget characters across sections.
    let remaining = input.max_chars;
    const pick = <T extends { row: any; score: number }>(items: T[]) => {
      const out: any[] = [];
      for (const item of items) {
        const len = (item.row.title?.length ?? 0) + (item.row.content?.length ?? 0) + 40;
        if (remaining - len < 0 && out.length > 0) break;
        remaining -= len;
        const { search_tokens: _st, embedding: _emb, ...clean } = item.row;
        out.push({ ...clean, score: Number(item.score.toFixed(4)) });
      }
      return out;
    };

    const selectedBoundaries = pick(boundaries);
    const selectedMemories = pick(regular);
    const selectedEpisodes: any[] = [];
    for (const ep of epRows.rows) {
      const len = (ep.summary?.length ?? 0) + 40;
      if (remaining - len < 0 && selectedEpisodes.length > 0) break;
      remaining -= len;
      selectedEpisodes.push(ep);
    }

    // Track memory access asynchronously without blocking response.
    const touchedIds = [...selectedMemories, ...selectedBoundaries].map(m => m.id);
    if (touchedIds.length) {
      void this.db.query('UPDATE memories SET access_count=access_count+1,last_accessed_at=now() WHERE id=ANY($1::uuid[])', [touchedIds]).catch(() => {});
    }

    const lines: string[] = [];
    if (selectedMemories.length) {
      lines.push('## Shared Cloud Memory');
      for (const m of selectedMemories) {
        lines.push(`- [${m.scope}/${m.kind}] ${m.title}: ${m.content} (id=${m.id}, rev=${m.revision})`);
      }
    }
    if (selectedBoundaries.length) {
      lines.push('## Learned Device Boundaries');
      for (const b of selectedBoundaries) {
        lines.push(`- [boundary] ${b.title}: ${b.content}`);
      }
    }
    if (selectedEpisodes.length) {
      lines.push('## Recent Cross-Device Activity');
      for (const e of selectedEpisodes) {
        lines.push(`- (${e.device_name ?? 'device'}) ${e.summary}`);
      }
    }

    return {
      device_id: identity.device_id,
      agent_id: identity.agent_id,
      memories: selectedMemories,
      boundaries: selectedBoundaries,
      episodes: selectedEpisodes,
      summary_text: lines.join('\n'),
      ...(input.include_persona ? { persona } : {}),
    };
  }

  /** Ingest an episode (conversation turn, task outcome, or observation) with trivial-turn filtering and session debouncing. */
  async ingest(
    identity: { device_id: string; agent_id: string },
    rawInput: z.input<typeof memoryIngestSchema>,
  ) {
    const input = memoryIngestSchema.parse(rawInput);
    const episodeId = randomUUID();
    const deviceRow = (await this.db.query('SELECT name FROM devices WHERE id=$1', [identity.device_id])).rows[0];
    const initialSummary = deterministicSummary(input.kind, input.messages, input.metadata, deviceRow?.name ?? 'device');

    // Skip trivial greetings/acks immediately without burning an LLM call.
    if (input.kind === 'turn' && !input.consolidate_now && isTrivialTurn(input.messages)) {
      await this.db.query(
        `INSERT INTO memory_episodes(id,owner_id,source_device_id,source_agent_id,session_key,kind,messages,metadata,summary,status,consolidation_result,consolidated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'','skipped',$9,now())`,
        [episodeId, OWNER_ID, identity.device_id, identity.agent_id, input.session_key ?? null, input.kind, JSON.stringify(input.messages), JSON.stringify(input.metadata), JSON.stringify({ skipped_reason: 'trivial_chitchat', actions: [] })],
      );
      return { episode_id: episodeId, status: 'skipped' as const, summary: '', debounced: false };
    }

    await this.db.query(
      `INSERT INTO memory_episodes(id,owner_id,source_device_id,source_agent_id,session_key,kind,messages,metadata,summary,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
      [episodeId, OWNER_ID, identity.device_id, identity.agent_id, input.session_key ?? null, input.kind, JSON.stringify(input.messages), JSON.stringify(input.metadata), initialSummary],
    );

    if (input.consolidate_now) {
      const outcome = await this.consolidateEpisode(episodeId);
      return { episode_id: episodeId, ...outcome, debounced: false };
    }

    // Immediate consolidation for critical device capability boundaries or when debounce is disabled.
    const isUrgentBoundary = input.kind === 'task_outcome' && ['declined', 'failed'].includes(String(input.metadata?.state ?? '')) && input.metadata?.learn_boundary !== false;
    const debounceMs = this.config.memoryDebounceMs ?? 15000;
    const batchMax = this.config.memoryBatchMax ?? 6;
    if (isUrgentBoundary || debounceMs <= 0) {
      this.track(this.consolidateEpisode(episodeId).then(() => {}).catch(() => {}));
      return { episode_id: episodeId, status: 'pending' as const, summary: initialSummary, debounced: false };
    }

    // Session-level debounced batching: merge bursty turns into a single Cloud Memory LLM call!
    const batchKey = `${identity.agent_id}:${input.session_key || 'default'}`;
    const existing = this.debounceBatches.get(batchKey);
    const episodeIds = existing ? [...existing.episodeIds, episodeId] : [episodeId];
    if (existing) clearTimeout(existing.timer);

    if (episodeIds.length >= batchMax) {
      this.debounceBatches.delete(batchKey);
      this.track(this.consolidateBatch(episodeIds).then(() => {}).catch(() => {}));
      return { episode_id: episodeId, status: 'pending' as const, summary: initialSummary, debounced: true, flushed: true };
    }

    const timer = setTimeout(() => {
      const entry = this.debounceBatches.get(batchKey);
      if (!entry) return;
      this.debounceBatches.delete(batchKey);
      if (entry.episodeIds.length) {
        this.track(this.consolidateBatch(entry.episodeIds).then(() => {}).catch(() => {}));
      }
    }, debounceMs);
    timer.unref();
    this.debounceBatches.set(batchKey, { episodeIds, timer });
    return { episode_id: episodeId, status: 'pending' as const, summary: initialSummary, debounced: true, debounce_ms: debounceMs };
  }

  /** Consolidate a debounced burst of episodes from the same session in ONE single LLM pass. */
  async consolidateBatch(episodeIds: string[]): Promise<{ status: 'consolidated' | 'skipped' | 'failed'; summary: string; actions: unknown[] }> {
    if (episodeIds.length === 0) return { status: 'skipped', summary: '', actions: [] };
    if (episodeIds.length === 1) return this.consolidateEpisode(episodeIds[0]);
    return this.serialize(async () => {
      const rows = (await this.db.query(
        `SELECT e.*, d.name AS device_name, a.name AS agent_name, a.key AS agent_key
         FROM memory_episodes e
         LEFT JOIN devices d ON d.id=e.source_device_id
         LEFT JOIN agents a ON a.id=e.source_agent_id
         WHERE e.id = ANY($1::uuid[]) AND e.owner_id=$2 AND e.status='pending'
         ORDER BY e.created_at ASC`,
        [episodeIds, OWNER_ID],
      )).rows;
      if (!rows.length) return { status: 'skipped', summary: '', actions: [] };

      const anchor = rows[rows.length - 1];
      const combinedMessages = rows.flatMap(r => Array.isArray(r.messages) ? r.messages : []);
      const combinedMetadata = Object.assign({}, ...rows.map(r => (r.metadata && typeof r.metadata === 'object' ? r.metadata : {})), { batched_episodes: rows.map(r => r.id) });
      const outcome = await this.consolidateRow({ ...anchor, messages: combinedMessages, metadata: combinedMetadata });

      const otherIds = rows.slice(0, -1).map(r => r.id);
      if (otherIds.length) {
        await this.db.query(
          `UPDATE memory_episodes SET status=$2,consolidation_result=$3,consolidated_at=now() WHERE id=ANY($1::uuid[])`,
          [otherIds, outcome.status, JSON.stringify({ batched_into: anchor.id, actions: outcome.actions })],
        );
      }
      return outcome;
    });
  }

  /** Run Cloud Memory Manager Agent on a stored episode (LLM-driven with deterministic fallback). */
  async consolidateEpisode(episodeId: string): Promise<{ status: 'consolidated' | 'skipped' | 'failed'; summary: string; actions: unknown[] }> {
    return this.serialize(async () => {
      const ep = (await this.db.query(
        `SELECT e.*, d.name AS device_name, a.name AS agent_name, a.key AS agent_key
         FROM memory_episodes e
         LEFT JOIN devices d ON d.id=e.source_device_id
         LEFT JOIN agents a ON a.id=e.source_agent_id
         WHERE e.id=$1 AND e.owner_id=$2`,
        [episodeId, OWNER_ID],
      )).rows[0];
      if (!ep) return { status: 'failed', summary: '', actions: [] };
      if (ep.status !== 'pending') return { status: ep.status, summary: ep.summary ?? '', actions: [] };
      return this.consolidateRow(ep);
    });
  }

  private async consolidateRow(ep: any): Promise<{ status: 'consolidated' | 'skipped' | 'failed'; summary: string; actions: unknown[] }> {
    const episodeId = ep.id as string;

    const messages = Array.isArray(ep.messages) ? ep.messages : [];
    const metadata = (ep.metadata && typeof ep.metadata === 'object') ? ep.metadata : {};
    const route = resolveModelRoute(this.config, this.config.memoryModel);

    // Load top candidate existing memories for deduplication / conflict resolution.
    const combinedText = messages.map((m: any) => String(m.content ?? '')).join('\n');
    const candidateRows = (await this.db.query(
      `SELECT id,title,content,scope,kind,tags,importance,revision,applicable_device_id,applicable_agent_id
       FROM memories WHERE owner_id=$1 AND NOT deleted
       AND (scope='global' OR applicable_device_id=$2 OR applicable_agent_id=$3)
       ORDER BY updated_at DESC LIMIT 80`,
      [OWNER_ID, ep.source_device_id, ep.source_agent_id],
    )).rows;
    const candidates = candidateRows
      .map(r => ({ r, s: lexicalScore(combinedText, r.title, r.content, Array.isArray(r.tags) ? r.tags : []) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .map(x => x.r);

    let summary = ep.summary || deterministicSummary(ep.kind, messages, metadata, ep.device_name ?? 'device');
    let ops: z.infer<typeof llmOperationSchema>[] = [];
    let usedLlm = false;

    if (route) {
      try {
        const userPayload = JSON.stringify({
          episode_kind: ep.kind,
          source_device: { id: ep.source_device_id, name: ep.device_name },
          source_agent: { id: ep.source_agent_id, key: ep.agent_key, name: ep.agent_name },
          metadata,
          messages: messages.slice(-20),
          existing_memories: candidates.map(c => ({ id: c.id, title: c.title, content: c.content, scope: c.scope, kind: c.kind, revision: c.revision })),
        });
        const res = await this.fetchImpl(route.baseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${route.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: route.upstreamModel ?? route.id,
            stream: false,
            temperature: 0.1,
            max_tokens: 1200,
            messages: [
              { role: 'system', content: MEMORY_MANAGER_PROMPT },
              { role: 'user', content: userPayload },
            ],
          }),
          signal: AbortSignal.timeout(25000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const content = data?.choices?.[0]?.message?.content;
          if (typeof content === 'string' && content.trim()) {
            const parsed = llmConsolidationSchema.parse(parseJsonObject(content));
            if (parsed.episode_summary.trim()) summary = parsed.episode_summary.trim();
            ops = parsed.operations;
            usedLlm = true;
          }
        }
      } catch {
        // Gracefully degrade to deterministic boundary/summary handling below.
      }
    }

    // Deterministic cross-device boundary learning: even without LLM (or if LLM skipped it),
    // A declined/unsupported task teaches the network what the target device cannot do, UNLESS explicitly opted out via learn_boundary: false (e.g. one-off file too large or owner rejected a single transfer).
    const isBoundaryOutcome = ep.kind === 'task_outcome' && (metadata.state === 'declined' || metadata.state === 'failed') && metadata.learn_boundary !== false;
    if (isBoundaryOutcome && !ops.some(o => o.kind === 'boundary')) {
      const targetLabel = String(metadata.target_label ?? metadata.target_device_name ?? 'Target device');
      const reason = String(metadata.error_message ?? 'Cannot handle this request in its environment').slice(0, 400);
      const instruction = String(metadata.instruction ?? '').slice(0, 200);
      const title = `${targetLabel} 能力边界`;
      const content = instruction
        ? `${targetLabel} 无法完成「${instruction}」：${reason}`
        : `${targetLabel} 边界限制：${reason}`;
      const existingBoundary = candidates.find(c => c.kind === 'boundary' && c.title === title);
      if (existingBoundary) {
        const merged = existingBoundary.content.includes(reason) ? existingBoundary.content : `${existingBoundary.content}；${content}`.slice(0, 3800);
        ops.push({ op: 'update', id: existingBoundary.id, title, content: merged, scope: 'global', kind: 'boundary', tags: ['boundary', targetLabel], importance: 0.85 });
      } else {
        ops.push({ op: 'create', title, content, scope: 'global', kind: 'boundary', tags: ['boundary', targetLabel], importance: 0.85 });
      }
    }

    // Deterministic observation ingestion when caller explicitly gives structured title+content without LLM.
    if (!usedLlm && ep.kind === 'observation' && typeof metadata.title === 'string' && typeof metadata.content === 'string') {
      const scope = MEMORY_SCOPES.includes(metadata.scope as any) ? metadata.scope as typeof MEMORY_SCOPES[number] : 'global';
      const kind = (['fact', 'preference', 'boundary'].includes(String(metadata.kind)) ? metadata.kind : 'fact') as 'fact' | 'preference' | 'boundary';
      ops.push({ op: 'create', title: metadata.title.slice(0, 120), content: metadata.content.slice(0, 4000), scope, kind, tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 10).map(String) : [], importance: 0.7 });
    }

    const actions: unknown[] = [];
    const source = { kind: usedLlm ? 'cloud_memory_agent' : 'cloud_memory_rule', deviceId: ep.source_device_id, agentId: ep.source_agent_id };
    const candidateById = new Map(candidates.map(c => [c.id, c]));

    for (const op of ops) {
      try {
        if (op.op === 'create' && op.title && op.content) {
          const emb = await computeEmbedding(this.config, `${op.title} ${op.content}`, this.fetchImpl);
          const applicable_device_id = op.scope === 'device' ? ep.source_device_id : null;
          const applicable_agent_id = op.scope === 'agent' ? ep.source_agent_id : null;
          if (op.scope === 'device' && !applicable_device_id) continue;
          if (op.scope === 'agent' && !applicable_agent_id) continue;
          const saved = await transaction(this.db, c => saveMemory(c, {
            title: op.title!, content: op.content!, scope: op.scope, kind: op.kind, tags: op.tags, importance: op.importance,
            applicable_device_id, applicable_agent_id,
          }, source, emb));
          actions.push({ op: 'create', id: saved.id, title: saved.title, scope: saved.scope, kind: saved.kind });
        } else if (op.op === 'update' && op.id) {
          const existing = candidateById.get(op.id);
          if (!existing || (!op.title && !op.content)) continue;
          const emb = await computeEmbedding(this.config, `${op.title ?? existing.title} ${op.content ?? existing.content}`, this.fetchImpl);
          const updated = await transaction(this.db, c => editMemory(c, op.id!, {
            ...(op.title ? { title: op.title } : {}),
            ...(op.content ? { content: op.content } : {}),
            kind: op.kind,
            tags: op.tags.length ? op.tags : undefined,
            importance: op.importance,
            expected_revision: existing.revision,
          }, source, undefined, emb));
          actions.push({ op: 'update', id: updated.id, revision: updated.revision, title: updated.title });
        } else if (op.op === 'delete' && op.id) {
          const existing = candidateById.get(op.id);
          if (!existing) continue;
          await transaction(this.db, c => deleteMemory(c, op.id!, existing.revision));
          actions.push({ op: 'delete', id: op.id });
        }
      } catch {
        // Never fail the entire episode because one speculative op conflicted.
      }
    }

    const status = summary || actions.length ? 'consolidated' : 'skipped';
    await this.db.query(
      `UPDATE memory_episodes SET summary=$2,status=$3,consolidation_result=$4,consolidated_at=now() WHERE id=$1`,
      [episodeId, summary, status, JSON.stringify({ used_llm: usedLlm, actions })],
    );
    if (actions.length) this.onMemoryUpdated?.({ episode_id: episodeId, actions });
    return { status, summary, actions };
  }

  /** Schedule task outcome recording inside the tracked pending queue so drain() awaits it reliably. */
  scheduleTaskOutcome(task: any, resolveTargetLabel: () => Promise<string>): void {
    const job = (async () => {
      const label = await resolveTargetLabel().catch(() => '远程设备');
      await this.recordTaskOutcome(task, label);
    })().catch(() => {});
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** Automatically record a cross-device task outcome so the sender and other devices learn boundaries & recent activity. */
  async recordTaskOutcome(task: any, targetLabel: string): Promise<void> {
    if (!task || task.memory_recorded) return;
    const marked = await this.db.query('UPDATE link_tasks SET memory_recorded=true WHERE id=$1 AND NOT memory_recorded RETURNING id', [task.id]);
    if (!marked.rowCount) return;
    const state = String(task.state ?? '');
    if (!['succeeded', 'failed', 'declined'].includes(state)) return;
    const instruction = String(task.instruction ?? task.input?.instruction ?? `${task.capability}: ${JSON.stringify(task.input ?? {}).slice(0, 300)}`);
    const result = task.result ?? {};
    const errorMessage = result?.error?.message ?? '';
    const reply = result?.output?.reply ?? result?.output?.text ?? (result?.output ? JSON.stringify(result.output).slice(0, 400) : '');
    const summaryMsg = state === 'succeeded'
      ? `Target ${targetLabel} completed task: ${reply || 'succeeded'}`
      : `Target ${targetLabel} could not complete task (${state}): ${errorMessage || 'unknown error'}`;

    await this.ingest(
      { device_id: task.source_device_id, agent_id: task.source_agent_id },
      {
        kind: 'task_outcome',
        session_key: `task:${task.id}`,
        messages: [
          { role: 'user', content: `Task to ${targetLabel}: ${instruction}` },
          { role: 'assistant', content: summaryMsg },
        ],
        metadata: {
          task_id: task.id,
          state,
          capability: task.capability,
          instruction,
          target_label: targetLabel,
          target_device_id: task.target_device_id,
          target_agent_id: task.claimed_by_agent_id ?? task.target_agent_id,
          error_code: result?.error?.code,
          error_message: errorMessage,
          learn_boundary: result?.error?.learn_boundary ?? (state === 'declined'),
          reply,
        },
        consolidate_now: false,
      },
    );
  }

  async listEpisodes(limit = 30) {
    return (await this.db.query(
      `SELECT e.id,e.source_device_id,e.source_agent_id,e.session_key,e.kind,e.summary,e.status,e.consolidation_result,e.created_at,e.consolidated_at,d.name AS device_name,a.name AS agent_name
       FROM memory_episodes e
       LEFT JOIN devices d ON d.id=e.source_device_id
       LEFT JOIN agents a ON a.id=e.source_agent_id
       WHERE e.owner_id=$1
       ORDER BY e.created_at DESC LIMIT $2`,
      [OWNER_ID, Math.min(limit, 100)],
    )).rows;
  }
}
