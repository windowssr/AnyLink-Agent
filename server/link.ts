import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, idempotent, type Db } from './db.js';
import { OWNER_ID } from './config.js';
import type { EdgeIdentity } from './edge-auth.js';
import type { MemoryBrain } from './memory-brain.js';
import { deviceSlugSchema } from './store.js';
import type { WsHub, WsTaskDelegate } from './ws-hub.js';

export const capabilityName = z.string().regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/).max(100);
export const capabilitiesSchema = z.object({
  capabilities: z.array(z.object({ name: capabilityName, description: z.string().max(500) }).strict()).max(32),
}).strict().refine(v => new Set(v.capabilities.map(c => c.name)).size === v.capabilities.length, 'Duplicate capability');

const payloadSchema = z.record(z.string(), z.unknown()).refine(v => Buffer.byteLength(JSON.stringify(v)) <= 65536, 'Payload exceeds 64 KiB');
const agentTarget = z.object({ agent_id: z.uuid() }).strict();
const deviceTarget = z.object({ device_id: z.uuid() }).strict();
const deviceSlugTarget = z.object({ device_slug: deviceSlugSchema }).strict();
const deviceNameTarget = z.object({ device_name: z.string().trim().min(1).max(80) }).strict();
const agentKeyTarget = z.object({ agent_key: z.string().trim().min(1).max(64) }).strict();

export const taskCreateSchema = z.object({
  target: z.union([agentTarget, deviceTarget, deviceSlugTarget, deviceNameTarget, agentKeyTarget]).optional(),
  target_device_id: z.uuid().optional(),
  instruction: z.string().trim().min(1).max(8000).optional(),
  capability: capabilityName.optional(),
  input: payloadSchema.optional(),
  ttl_seconds: z.number().int().min(10).max(86400).default(1800),
  lease_seconds: z.number().int().min(10).max(3600).default(120),
}).strict().superRefine((v, c) => {
  if (v.target && v.target_device_id !== undefined) c.addIssue({ code: 'custom', message: 'target and target_device_id are mutually exclusive' });
  if (!v.instruction && !v.capability) c.addIssue({ code: 'custom', message: 'Provide instruction or capability' });
});

export const taskResultSchema = z.object({
  state: z.enum(['succeeded', 'failed', 'declined', 'cancelled', 'unknown']),
  output: payloadSchema.optional(),
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().max(1000),
    learn_boundary: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const taskHeartbeatSchema = z.object({
  extend_seconds: z.number().int().min(10).max(3600).optional(),
}).strict();

export const taskProgressSchema = z.object({
  stage: z.string().max(80).optional(),
  message: z.string().max(1000).optional(),
  percent: z.number().min(0).max(100).optional(),
  data: payloadSchema.optional(),
}).strict();

const idParams = z.object({ id: z.uuid() });
const states = ['queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'declined', 'cancelled', 'unknown', 'expired'] as const;
const finalStates = new Set(['succeeded', 'failed', 'declined', 'cancelled', 'unknown', 'expired']);

export const taskSchema = z.object({
  id: z.uuid(),
  source_device_id: z.uuid(),
  source_agent_id: z.uuid(),
  target_agent_id: z.uuid().nullable(),
  claimed_by_agent_id: z.uuid().nullable(),
  target_device_id: z.uuid().nullable(),
  capability: capabilityName,
  instruction: z.string().nullable(),
  input: z.record(z.string(), z.unknown()),
  state: z.enum(states),
  progress: z.record(z.string(), z.unknown()).nullable(),
  result: taskResultSchema.nullable(),
  lease_seconds: z.number().int(),
  lease_expires_at: z.string().nullable(),
  heartbeat_at: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

function present(row: any) {
  const { owner_id: _, source_credential_id: __, memory_recorded: ___, ...task } = row;
  let state = task.state;
  let result = task.result;
  if (state === 'queued' && new Date(task.expires_at).getTime() <= Date.now()) {
    state = 'expired';
  } else if ((state === 'running' || state === 'cancel_requested') && task.lease_expires_at && new Date(task.lease_expires_at).getTime() <= Date.now()) {
    state = 'unknown';
    result = result ?? { state: 'unknown', error: { code: 'LEASE_EXPIRED', message: 'Worker heartbeat lease expired; inspect target host before retrying' } };
  }
  return { ...task, state, result };
}

export class LinkService implements WsTaskDelegate {
  private reaperTimer?: ReturnType<typeof setInterval>;

  constructor(private db: Db, private wsHub?: WsHub, private memoryBrain?: MemoryBrain) {}

  startLeaseReaper(intervalMs = 15000) {
    this.reaperTimer = setInterval(() => {
      void this.reapExpiredLeases().catch(() => {});
    }, intervalMs);
    this.reaperTimer.unref();
  }

  stopLeaseReaper() {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
  }

  async reapExpiredLeases(): Promise<any[]> {
    const expiredResult = JSON.stringify({
      state: 'unknown',
      error: { code: 'LEASE_EXPIRED', message: 'Worker heartbeat lease expired; inspect target host before retrying' },
    });
    const rows = (await this.db.query(
      `UPDATE link_tasks SET state='unknown',result=COALESCE(result,$1::jsonb),finished_at=now()
       WHERE owner_id=$2 AND state IN ('running','cancel_requested') AND lease_expires_at IS NOT NULL AND lease_expires_at<=now()
       RETURNING *`,
      [expiredResult, OWNER_ID],
    )).rows;
    const presented = rows.map(present);
    for (const task of presented) this.wsHub?.notifyTaskCompleted(task);
    return presented;
  }

  private async targetLabelFor(task: any): Promise<string> {
    const agentId = task.claimed_by_agent_id ?? task.target_agent_id;
    if (agentId) {
      const r = (await this.db.query('SELECT a.name AS agent_name, d.name AS device_name, d.slug AS device_slug FROM agents a JOIN devices d ON d.id=a.device_id WHERE a.id=$1', [agentId])).rows[0];
      if (r) return r.device_slug ? `${r.device_name} [${r.device_slug}] (${r.agent_name})` : `${r.device_name} (${r.agent_name})`;
    }
    if (task.target_device_id) {
      const r = (await this.db.query('SELECT name, slug FROM devices WHERE id=$1', [task.target_device_id])).rows[0];
      if (r) return r.slug ? `${r.name} [${r.slug}]` : r.name;
    }
    return '远程设备';
  }

  async taskFor(me: EdgeIdentity, taskId: string, claimerOnly = false) {
    const row = (await this.db.query('SELECT * FROM link_tasks WHERE id=$1 AND owner_id=$2', [taskId, OWNER_ID])).rows[0];
    const visible = claimerOnly
      ? row?.claimed_by_agent_id === me.agent_id
      : [row?.source_agent_id, row?.target_agent_id, row?.claimed_by_agent_id].includes(me.agent_id)
        || (row?.target_agent_id === null && row?.target_device_id === me.device_id);
    if (!row || !visible) throw new ApiError(404, 'TASK_NOT_FOUND', 'Task does not exist for this agent');
    return row;
  }

  async createTask(me: EdgeIdentity, idempotencyKey: string, rawBody: unknown) {
    const body = taskCreateSchema.parse(rawBody);
    const capability = body.capability ?? 'agent.invoke';
    const input = body.input ?? (body.instruction ? { instruction: body.instruction } : {});
    const instruction = body.instruction ?? (typeof input.instruction === 'string' ? input.instruction : null);

    const outcome = await idempotent(this.db, `${me.agent_id}:link:create`, idempotencyKey, body, async c => {
      let targetAgentId: string | null = null;
      let targetDeviceId: string | null = null;

      if (body.target && 'agent_id' in body.target) {
        const agent = (await c.query(
          `SELECT a.id,a.device_id FROM agents a JOIN devices d ON d.id=a.device_id AND d.revoked_at IS NULL
           WHERE a.id=$1 AND a.owner_id=$2 AND a.revoked_at IS NULL`,
          [body.target.agent_id, OWNER_ID],
        )).rows[0];
        if (!agent) throw new ApiError(404, 'TARGET_AGENT_NOT_FOUND', 'Target agent does not exist or has been revoked');
        targetAgentId = agent.id;
        targetDeviceId = agent.device_id;
      } else if (body.target && 'device_slug' in body.target) {
        const dev = (await c.query(
          'SELECT id FROM devices WHERE owner_id=$1 AND revoked_at IS NULL AND lower(slug)=lower($2)',
          [OWNER_ID, body.target.device_slug],
        )).rows[0];
        if (!dev) throw new ApiError(404, 'TARGET_DEVICE_NOT_FOUND', `No active device with slug "${body.target.device_slug}"`);
        targetDeviceId = dev.id;
      } else if (body.target && 'device_name' in body.target) {
        const devices = (await c.query(
          `SELECT id,name,slug FROM devices WHERE owner_id=$1 AND revoked_at IS NULL AND lower(name)=lower($2) ORDER BY created_at`,
          [OWNER_ID, body.target.device_name],
        )).rows;
        if (!devices.length) throw new ApiError(404, 'TARGET_DEVICE_NOT_FOUND', `No active device named "${body.target.device_name}"`);
        if (devices.length > 1) {
          const choices = devices.map(d => d.slug || d.id).join(', ');
          throw new ApiError(409, 'AMBIGUOUS_TARGET_DEVICE', `Multiple active devices named "${body.target.device_name}"; target by device_slug instead: ${choices}`);
        }
        targetDeviceId = devices[0].id;
      } else if (body.target && 'agent_key' in body.target) {
        const agents = (await c.query(
          `SELECT a.id,a.device_id FROM agents a JOIN devices d ON d.id=a.device_id AND d.revoked_at IS NULL
           WHERE a.owner_id=$1 AND a.revoked_at IS NULL AND a.key=$2 ORDER BY a.last_seen_at DESC NULLS LAST`,
          [OWNER_ID, body.target.agent_key],
        )).rows;
        if (!agents.length) throw new ApiError(404, 'TARGET_AGENT_NOT_FOUND', `No active agent with key "${body.target.agent_key}"`);
        const onlineMatch = agents.find(a => this.wsHub?.isOnline(a.id)) ?? agents[0];
        targetAgentId = onlineMatch.id;
        targetDeviceId = onlineMatch.device_id;
      } else {
        const deviceId = body.target && 'device_id' in body.target ? body.target.device_id : body.target_device_id ?? null;
        if (deviceId) {
          if (!(await c.query('SELECT 1 FROM devices WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL', [deviceId, OWNER_ID])).rowCount) {
            throw new ApiError(404, 'TARGET_DEVICE_NOT_FOUND', 'Target device does not exist or has been revoked');
          }
          targetDeviceId = deviceId;
        }
      }

      const row = (await c.query(
        `INSERT INTO link_tasks(id,owner_id,source_device_id,source_agent_id,target_device_id,target_agent_id,capability,instruction,input,lease_seconds,expires_at,source_credential_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+$11*interval '1 second',$12) RETURNING *`,
        [randomUUID(), OWNER_ID, me.device_id, me.agent_id, targetDeviceId, targetAgentId, capability, instruction, JSON.stringify(input), body.lease_seconds, body.ttl_seconds, me.id],
      )).rows[0];
      return present(row);
    });

    if (!outcome.replayed) this.wsHub?.notifyTaskAvailable(outcome.value);
    return outcome.value;
  }

  async pendingTasksFor(me: EdgeIdentity) {
    const rows = (await this.db.query(
      `SELECT t.* FROM link_tasks t
       JOIN agents sa ON sa.id=t.source_agent_id AND sa.revoked_at IS NULL
       JOIN agents me ON me.id=$1
       WHERE t.owner_id=$3 AND t.state='queued' AND t.expires_at>now()
       AND (
         t.target_agent_id=$1
         OR (t.target_agent_id IS NULL AND t.target_device_id=$2 AND (t.capability='agent.invoke' OR jsonb_array_length(me.capabilities)=0 OR me.capabilities @> jsonb_build_array(jsonb_build_object('name',t.capability))))
         OR (t.target_agent_id IS NULL AND t.target_device_id IS NULL AND t.source_agent_id<>$1 AND (t.capability='agent.invoke' OR me.capabilities @> jsonb_build_array(jsonb_build_object('name',t.capability))))
       )
       ORDER BY CASE WHEN t.target_agent_id IS NOT NULL THEN 0 WHEN t.target_device_id IS NOT NULL THEN 1 ELSE 2 END, t.created_at, t.id LIMIT 20`,
      [me.agent_id, me.device_id, OWNER_ID],
    )).rows;
    return rows.map(present);
  }

  async claimTask(me: EdgeIdentity, idempotencyKey: string, taskId?: string) {
    await this.reapExpiredLeases();
    return (await idempotent(this.db, `${me.agent_id}:link:claim`, idempotencyKey, taskId ? { task_id: taskId } : {}, async c => {
      const routable = `(target_agent_id=$1 OR (target_agent_id IS NULL AND target_device_id=$2) OR (target_agent_id IS NULL AND target_device_id IS NULL))`;
      await c.query(`UPDATE link_tasks SET state='expired',finished_at=now() WHERE state='queued' AND expires_at<=now() AND ${routable}`, [me.agent_id, me.device_id]);

      const row = (await c.query(
        `SELECT t.* FROM link_tasks t
         JOIN agents sa ON sa.id=t.source_agent_id AND sa.revoked_at IS NULL
         JOIN agents me ON me.id=$1
         WHERE t.owner_id=$3 AND t.state='queued' AND t.expires_at>now()
         AND ($4::uuid IS NULL OR t.id=$4)
         AND (
           t.target_agent_id=$1
           OR (t.target_agent_id IS NULL AND t.target_device_id=$2 AND (t.capability='agent.invoke' OR jsonb_array_length(me.capabilities)=0 OR me.capabilities @> jsonb_build_array(jsonb_build_object('name',t.capability))))
           OR (t.target_agent_id IS NULL AND t.target_device_id IS NULL AND t.source_agent_id<>$1 AND (t.capability='agent.invoke' OR me.capabilities @> jsonb_build_array(jsonb_build_object('name',t.capability))))
         )
         ORDER BY CASE WHEN t.target_agent_id IS NOT NULL THEN 0 WHEN t.target_device_id IS NOT NULL THEN 1 ELSE 2 END, t.created_at, t.id
         FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
        [me.agent_id, me.device_id, OWNER_ID, taskId ?? null],
      )).rows[0];

      if (!row) return { task: null };
      const claimed = (await c.query(
        `UPDATE link_tasks
         SET state='running',started_at=now(),heartbeat_at=now(),lease_expires_at=now()+lease_seconds*interval '1 second',claimed_by_agent_id=$2
         WHERE id=$1 RETURNING *`,
        [row.id, me.agent_id],
      )).rows[0];
      return { task: present(claimed) };
    }, { cacheResult: value => value.task !== null })).value;
  }

  async heartbeatTask(me: EdgeIdentity, taskId: string, extendSeconds?: number) {
    const row = await this.taskFor(me, taskId, true);
    if (!['running', 'cancel_requested'].includes(row.state)) {
      throw new ApiError(409, 'TASK_NOT_ACTIVE', 'Cannot heartbeat a task that is not running');
    }
    const seconds = extendSeconds ?? row.lease_seconds ?? 120;
    const updated = (await this.db.query(
      `UPDATE link_tasks SET heartbeat_at=now(), lease_expires_at=now()+$2*interval '1 second'
       WHERE id=$1 AND state IN ('running','cancel_requested') RETURNING id,state,heartbeat_at,lease_expires_at`,
      [row.id, seconds],
    )).rows[0];
    if (!updated) throw new ApiError(409, 'TASK_NOT_ACTIVE', 'Task already finished');
    return {
      task_id: updated.id,
      state: updated.state,
      cancel_requested: updated.state === 'cancel_requested',
      heartbeat_at: updated.heartbeat_at,
      lease_expires_at: updated.lease_expires_at,
    };
  }

  async reportProgress(me: EdgeIdentity, taskId: string, rawProgress: unknown) {
    const progress = taskProgressSchema.parse(rawProgress);
    const row = await this.taskFor(me, taskId, true);
    if (!['running', 'cancel_requested'].includes(row.state)) {
      throw new ApiError(409, 'TASK_NOT_ACTIVE', 'Cannot report progress for a non-running task');
    }
    const updated = (await this.db.query(
      `UPDATE link_tasks SET progress=$2, heartbeat_at=now(), lease_expires_at=now()+lease_seconds*interval '1 second'
       WHERE id=$1 RETURNING *`,
      [row.id, JSON.stringify({ ...progress, updated_at: new Date().toISOString() })],
    )).rows[0];
    const task = present(updated);
    this.wsHub?.notifyTaskProgress(task, task.progress);
    return task;
  }

  async completeTask(me: EdgeIdentity, taskId: string, idempotencyKey: string, rawBody: unknown) {
    const row = await this.taskFor(me, taskId, true);
    const body = taskResultSchema.parse(rawBody);
    const outcome = await idempotent(this.db, `${me.agent_id}:link:result:${row.id}`, idempotencyKey, body, async c => {
      const current = (await c.query('SELECT * FROM link_tasks WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
      if (finalStates.has(current.state)) throw new ApiError(409, 'TASK_TERMINAL', 'Task already has a terminal result');
      if (!['running', 'cancel_requested'].includes(current.state)) throw new ApiError(409, 'TASK_NOT_CLAIMED', 'Claim the task before reporting a result');
      const updated = (await c.query(
        'UPDATE link_tasks SET state=$2,result=$3,finished_at=now(),lease_expires_at=NULL WHERE id=$1 RETURNING *',
        [row.id, body.state, JSON.stringify(body)],
      )).rows[0];
      return present(updated);
    });

    if (!outcome.replayed) {
      if (this.memoryBrain && ['declined', 'failed', 'succeeded'].includes(outcome.value.state)) {
        this.memoryBrain.scheduleTaskOutcome(outcome.value, () => this.targetLabelFor(outcome.value));
      }
      this.wsHub?.notifyTaskCompleted(outcome.value);
    }
    return outcome.value;
  }

  async cancelTask(me: EdgeIdentity, taskId: string, idempotencyKey: string) {
    const row = await this.taskFor(me, taskId);
    if (row.source_agent_id !== me.agent_id) throw new ApiError(403, 'TASK_SOURCE_REQUIRED', 'Only the source agent can cancel a task');
    const outcome = await idempotent(this.db, `${me.agent_id}:link:cancel:${row.id}`, idempotencyKey, {}, async c => {
      const updated = (await c.query(
        `UPDATE link_tasks SET state=CASE WHEN state='queued' AND expires_at<=now() THEN 'expired' WHEN state='queued' THEN 'cancelled' WHEN state='running' THEN 'cancel_requested' ELSE state END,
         finished_at=CASE WHEN state='queued' THEN now() ELSE finished_at END WHERE id=$1 RETURNING *`,
        [row.id],
      )).rows[0];
      return present(updated);
    });
    if (!outcome.replayed && outcome.value.state === 'cancel_requested') {
      this.wsHub?.notifyTaskCancel(outcome.value);
    }
    return outcome.value;
  }
}

export function registerLink(app: FastifyInstance, db: Db, linkService: LinkService, wsHub?: WsHub) {
  const key = (req: FastifyRequest) => z.string().min(1).max(160).parse(req.headers['idempotency-key']);
  const who = (req: FastifyRequest) => req.edgeIdentity!;

  const protocolInfo = () => ({
    protocol: 'anylink',
    version: '3.0',
    transport: { http: '/edge/v1', ws: '/edge/v1/ws', model: '/model/v1' },
    delivery: 'at-most-once-claim-with-lease',
    requeue: false,
    capabilities: ['memory', 'memory_brain', 'model', 'tasks', 'directory', 'ws', 'persona'],
    routing: ['agent', 'device', 'device_slug', 'device_name', 'agent_key', 'any'],
  });

  app.get('/edge/v1/protocol', async () => protocolInfo());
  app.get('/edge/v1/link/protocol', async () => protocolInfo());

  const directoryHandler = async (req: FastifyRequest) => {
    const me = who(req);
    const rows = (await db.query(`SELECT d.id AS device_id,d.name AS device_name,d.slug AS device_slug,d.platform,a.id AS agent_id,a.key,a.name AS agent_name,a.kind,a.summary,a.capabilities,a.last_seen_at
      FROM devices d JOIN agents a ON a.device_id=d.id AND a.revoked_at IS NULL
      WHERE d.owner_id=$1 AND d.revoked_at IS NULL ORDER BY d.name,d.id,a.key`, [OWNER_ID])).rows;
    const items = new Map<string, any>();
    for (const row of rows) {
      const item = items.get(row.device_id) ?? { device: { id: row.device_id, name: row.device_name, slug: row.device_slug ?? null, platform: row.platform }, agents: [] };
      const wsOnline = wsHub?.isOnline(row.agent_id) ?? false;
      const httpRecent = !!row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() < 60000;
      item.agents.push({
        id: row.agent_id,
        key: row.key,
        name: row.agent_name,
        kind: row.kind,
        summary: row.summary ?? '',
        capabilities: row.capabilities,
        last_seen_at: row.last_seen_at,
        ws_online: wsOnline,
        transport: wsOnline ? 'ws' : httpRecent ? 'http' : 'offline',
        online: wsOnline || httpRecent,
        self: row.agent_id === me.agent_id,
      });
      items.set(row.device_id, item);
    }
    return { items: [...items.values()] };
  };

  app.get('/edge/v1/directory', directoryHandler);
  app.get('/edge/v1/link/directory', directoryHandler);

  // Deprecated compatibility shim for clients that only understand devices.
  app.get('/edge/v1/link/peers', async req => {
    const rows = (await db.query(`SELECT d.id,d.name,d.platform,a.capabilities,a.last_seen_at FROM devices d
      JOIN agents a ON a.device_id=d.id AND a.revoked_at IS NULL
      WHERE d.owner_id=$1 AND d.revoked_at IS NULL AND d.id<>$2 ORDER BY d.name,d.id`, [OWNER_ID, who(req).device_id])).rows;
    const items = new Map<string, any>();
    for (const row of rows) {
      const item = items.get(row.id) ?? { id: row.id, name: row.name, platform: row.platform, capabilities: [], last_seen_at: null };
      const seen = new Set(item.capabilities.map((c: any) => c.name));
      for (const c of row.capabilities) if (!seen.has(c.name)) { seen.add(c.name); item.capabilities.push(c); }
      if (!item.last_seen_at || new Date(row.last_seen_at) > new Date(item.last_seen_at)) item.last_seen_at = row.last_seen_at;
      items.set(row.id, item);
    }
    return { items: [...items.values()] };
  });

  app.post('/edge/v1/link/capabilities', async req => {
    const body = capabilitiesSchema.parse(req.body), me = who(req);
    return (await idempotent(db, `${me.agent_id}:link:capabilities`, key(req), body, async c => {
      await c.query('UPDATE agents SET capabilities=$2,capabilities_updated_at=now() WHERE id=$1', [me.agent_id, JSON.stringify(body.capabilities)]);
      return { agent_id: me.agent_id, device_id: me.device_id, ...body };
    })).value;
  });

  // Register both clean v3 `/edge/v1/tasks*` and v2-compatible `/edge/v1/link/tasks*` routes.
  for (const base of ['/edge/v1/tasks', '/edge/v1/link/tasks']) {
    app.post(base, async req => linkService.createTask(who(req), key(req), req.body));
    app.get(base, async req => {
      const query = z.object({ role: z.enum(['source', 'target']).default('source'), state: z.enum(states).optional() }).strict().parse(req.query);
      const me = who(req);
      const rows = (await db.query(
        `SELECT * FROM link_tasks WHERE owner_id=$1
         AND (($2='source' AND source_agent_id=$3) OR ($2='target' AND (claimed_by_agent_id=$3 OR target_agent_id=$3 OR (target_agent_id IS NULL AND target_device_id=$4))))
         AND ($5::text IS NULL OR CASE WHEN state='queued' AND expires_at<=now() THEN 'expired' ELSE state END=$5)
         ORDER BY created_at DESC LIMIT 100`,
        [OWNER_ID, query.role, me.agent_id, me.device_id, query.state ?? null],
      )).rows.map(present);
      return { items: rows };
    });
    app.get(`${base}/:id`, async req => present(await linkService.taskFor(who(req), idParams.parse(req.params).id)));
    app.post(`${base}/claim`, async req => {
      const body = z.object({ task_id: z.uuid().optional() }).strict().parse(req.body ?? {});
      return linkService.claimTask(who(req), key(req), body.task_id);
    });
    app.post(`${base}/:id/heartbeat`, async req => {
      const { id } = idParams.parse(req.params);
      const body = taskHeartbeatSchema.parse(req.body ?? {});
      return linkService.heartbeatTask(who(req), id, body.extend_seconds);
    });
    app.post(`${base}/:id/progress`, async req => {
      const { id } = idParams.parse(req.params);
      return linkService.reportProgress(who(req), id, req.body);
    });
    app.post(`${base}/:id/result`, async req => {
      const { id } = idParams.parse(req.params);
      return linkService.completeTask(who(req), id, key(req), req.body);
    });
    app.post(`${base}/:id/cancel`, async req => {
      const { id } = idParams.parse(req.params);
      z.object({}).strict().parse(req.body ?? {});
      return linkService.cancelTask(who(req), id, key(req));
    });
  }
}
