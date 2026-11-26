import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, hash, type Db, transaction } from './db.js';
import { OWNER_ID, type Config } from './config.js';
import { devicePatchSchema, deviceSlugSchema, PLATFORMS, resolveDeviceSlug, updateDevice } from './store.js';

export type EdgeIdentity = { id: string; device_id: string; agent_id: string };
declare module 'fastify' { interface FastifyRequest { edgeIdentity?: EdgeIdentity } }

export async function authenticateEdgeToken(db: Db, rawToken: string, { touchLastSeen = true }: { touchLastSeen?: boolean } = {}): Promise<EdgeIdentity> {
  const token = rawToken.replace(/^Bearer /i, '').trim();
  if (!token.startsWith('ak_') || token.length > 150) throw new ApiError(401, 'EDGE_AUTH_REQUIRED', 'Device credential required');
  const row = touchLastSeen
    ? (await db.query('UPDATE edge_credentials SET last_used_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING id,device_id,agent_id', [hash(token)])).rows[0]
    : (await db.query('SELECT id,device_id,agent_id FROM edge_credentials WHERE token_hash=$1 AND revoked_at IS NULL', [hash(token)])).rows[0];
  if (!row) throw new ApiError(401, 'EDGE_AUTH_REQUIRED', 'Invalid or revoked device credential');
  const agent = touchLastSeen
    ? (await db.query('UPDATE agents SET last_seen_at=now() WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND device_id IN(SELECT id FROM devices WHERE revoked_at IS NULL) RETURNING id', [row.agent_id, OWNER_ID])).rows[0]
    : (await db.query('SELECT id FROM agents WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND device_id IN(SELECT id FROM devices WHERE revoked_at IS NULL)', [row.agent_id, OWNER_ID])).rows[0];
  if (!agent) throw new ApiError(401, 'EDGE_AUTH_REQUIRED', 'Agent or device is revoked');
  return { id: row.id, device_id: row.device_id, agent_id: row.agent_id };
}

export async function authenticateEdge(db: Db, req: FastifyRequest) {
  const identity = await authenticateEdgeToken(db, req.headers.authorization ?? '');
  req.edgeIdentity = identity;
  return identity;
}

export const connectSchema = z.object({
  device: z.object({
    install_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    name: z.string().trim().min(1).max(80),
    platform: z.enum(PLATFORMS),
    slug: deviceSlugSchema.optional(),
  }).strict(),
  agent: z.object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    name: z.string().trim().min(1).max(80),
    kind: z.string().min(1).max(40).default('agent'),
    summary: z.string().max(400).default(''),
  }).strict(),
}).strict();

export const agentProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  summary: z.string().max(400).optional(),
  kind: z.string().min(1).max(40).optional(),
}).strict().refine(v => v.name !== undefined || v.summary !== undefined || v.kind !== undefined, 'Provide at least one profile field');

export function registerConnectRoute(app: FastifyInstance, db: Db, config: Config, attempts: Map<string, { count: number; until: number }>) {
  const matches = (provided: string, expected?: string) => Boolean(expected) && timingSafeEqual(Buffer.from(hash(provided)), Buffer.from(hash(expected!)));

  app.post('/edge/v1/connect', async (req, reply) => {
    if (!config.joinKey && !config.loginPassword) throw new ApiError(503, 'JOIN_DISABLED', 'Join is disabled on this deployment');
    const now = Date.now(), old = attempts.get(req.ip);
    if (old && old.until > now && old.count >= 5) throw new ApiError(429, 'JOIN_RATE_LIMIT', 'Too many failed attempts; try again in 15 minutes');
    const token = (req.headers.authorization ?? '').replace(/^Bearer /i, '').trim();
    if (token.length > 300 || (!matches(token, config.joinKey) && !matches(token, config.loginPassword))) {
      attempts.set(req.ip, { count: old && old.until > now ? old.count + 1 : 1, until: old && old.until > now ? old.until : now + 900000 });
      throw new ApiError(401, 'JOIN_KEY_INVALID', 'Login password or join key is invalid');
    }
    attempts.delete(req.ip);
    const body = connectSchema.parse(req.body);
    const result = await transaction(db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`connect:${body.device.install_id}`]);
      const existingDev = (await c.query('SELECT id,slug,revoked_at FROM devices WHERE install_id=$1 FOR UPDATE', [body.device.install_id])).rows[0];
      if (existingDev?.revoked_at) throw new ApiError(403, 'DEVICE_REVOKED', 'This device has been revoked by the owner');
      const slug = body.device.slug !== undefined || !existingDev?.slug
        ? await resolveDeviceSlug(c, body.device.slug, body.device.name, body.device.platform, existingDev?.id)
        : existingDev.slug;
      const device = (await c.query(`INSERT INTO devices(id,owner_id,name,platform,install_id,slug) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(install_id) DO UPDATE SET name=EXCLUDED.name,platform=EXCLUDED.platform,slug=EXCLUDED.slug RETURNING *`,
      [randomUUID(), OWNER_ID, body.device.name, body.device.platform, body.device.install_id, slug])).rows[0];
      if (device.revoked_at) throw new ApiError(403, 'DEVICE_REVOKED', 'This device has been revoked by the owner');
      const agent = (await c.query(`INSERT INTO agents(id,owner_id,device_id,key,name,kind,summary) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(device_id,key) DO UPDATE SET name=EXCLUDED.name,kind=EXCLUDED.kind,summary=CASE WHEN EXCLUDED.summary<>'' THEN EXCLUDED.summary ELSE agents.summary END RETURNING *`,
      [randomUUID(), OWNER_ID, device.id, body.agent.key, body.agent.name, body.agent.kind, body.agent.summary])).rows[0];
      if (agent.revoked_at) throw new ApiError(403, 'AGENT_REVOKED', 'This agent key has been revoked');
      await c.query('UPDATE edge_credentials SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL', [agent.id]);
      const credentialId = randomUUID(), edgeToken = 'ak_' + randomBytes(32).toString('base64url');
      await c.query('INSERT INTO edge_credentials(id,device_id,agent_id,token_hash) VALUES($1,$2,$3,$4)', [credentialId, device.id, agent.id, hash(edgeToken)]);
      return { device_id: device.id, device_slug: device.slug, agent_id: agent.id, credential_id: credentialId, token: edgeToken, protocol: { name: 'anylink', version: '3.0' } };
    });
    reply.code(201);
    return result;
  });

  app.patch('/edge/v1/device/profile', async req => {
    const me = req.edgeIdentity!;
    const body = devicePatchSchema.parse(req.body);
    return transaction(db, c => updateDevice(c, me.device_id, body));
  });

  app.patch('/edge/v1/agent/profile', async req => {
    const me = req.edgeIdentity!;
    const body = agentProfileSchema.parse(req.body);
    const row = (await db.query(
      'UPDATE agents SET name=COALESCE($2,name),summary=COALESCE($3,summary),kind=COALESCE($4,kind) WHERE id=$1 RETURNING id,device_id,key,name,kind,summary,capabilities',
      [me.agent_id, body.name ?? null, body.summary ?? null, body.kind ?? null],
    )).rows[0];
    return row;
  });
}

async function defaultAgent(c: Pick<Db, 'query'>, deviceId: string) {
  const device = (await c.query('SELECT id,name FROM devices WHERE id=$1 AND owner_id=$2 FOR UPDATE', [deviceId, OWNER_ID])).rows[0];
  if (!device) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
  const existing = (await c.query(`SELECT * FROM agents WHERE device_id=$1 AND key='default'`, [deviceId])).rows[0];
  if (existing) return existing;
  return (await c.query(`INSERT INTO agents(id,owner_id,device_id,key,name,kind) VALUES($1,$2,$3,'default',$4,'legacy') RETURNING *`, [randomUUID(), OWNER_ID, deviceId, device.name])).rows[0];
}

export function registerCredentialRoutes(app: FastifyInstance, db: Db, isWsOnline?: (agentId: string) => boolean, onRevoke?: (agentId: string) => void) {
  app.post('/v1/devices/:id/credential', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const result = await transaction(db, async c => {
      const agent = await defaultAgent(c, id);
      if ((await c.query('SELECT 1 FROM edge_credentials WHERE agent_id=$1 AND revoked_at IS NULL', [agent.id])).rowCount) throw new ApiError(409, 'DEVICE_ALREADY_BOUND', 'Revoke existing credential first');
      const token = 'ak_' + randomBytes(32).toString('base64url'), credentialId = randomUUID();
      await c.query('INSERT INTO edge_credentials(id,device_id,agent_id,token_hash) VALUES($1,$2,$3,$4)', [credentialId, id, agent.id, hash(token)]);
      return { credential_id: credentialId, device_id: id, agent_id: agent.id, token };
    });
    reply.code(201);
    return result;
  });

  app.post('/v1/devices/:id/revoke', async req => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await db.query('SELECT id FROM devices WHERE id=$1 AND owner_id=$2', [id, OWNER_ID])).rowCount) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
    const agents = (await db.query('SELECT id FROM agents WHERE device_id=$1', [id])).rows;
    await db.query('UPDATE devices SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [id]);
    await db.query('UPDATE agents SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL', [id]);
    await db.query('UPDATE edge_credentials SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL', [id]);
    for (const a of agents) onRevoke?.(a.id);
    return { device_id: id, revoked: true };
  });

  app.post('/v1/devices/:id/restore', async req => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await db.query('SELECT id FROM devices WHERE id=$1 AND owner_id=$2', [id, OWNER_ID])).rowCount) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
    await db.query('UPDATE devices SET revoked_at=NULL WHERE id=$1', [id]);
    await db.query('UPDATE agents SET revoked_at=NULL WHERE device_id=$1', [id]);
    return { device_id: id, restored: true };
  });

  app.get('/v1/agents', async () => {
    const rows = (await db.query(`SELECT a.id,a.device_id,a.key,a.name,a.kind,a.summary,a.capabilities,a.last_seen_at,a.revoked_at,a.created_at,d.name AS device_name,d.platform AS device_platform,(a.last_seen_at IS NOT NULL AND a.last_seen_at>now()-interval '60 seconds') AS http_online
      FROM agents a JOIN devices d ON d.id=a.device_id WHERE d.owner_id=$1 ORDER BY d.name,d.id,a.key`, [OWNER_ID])).rows;
    return {
      items: rows.map(r => {
        const wsOnline = isWsOnline?.(r.id) ?? false;
        return { ...r, ws_online: wsOnline, online: wsOnline || Boolean(r.http_online) };
      }),
    };
  });

  app.post('/v1/agents/:id/revoke', async req => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await db.query('SELECT a.id FROM agents a JOIN devices d ON d.id=a.device_id WHERE a.id=$1 AND d.owner_id=$2', [id, OWNER_ID])).rowCount) throw new ApiError(404, 'AGENT_NOT_FOUND', 'Agent not found');
    await db.query('UPDATE agents SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [id]);
    await db.query('UPDATE edge_credentials SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL', [id]);
    onRevoke?.(id);
    return { agent_id: id, revoked: true };
  });

  app.post('/v1/agents/:id/restore', async req => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (!(await db.query('SELECT a.id FROM agents a JOIN devices d ON d.id=a.device_id WHERE a.id=$1 AND d.owner_id=$2', [id, OWNER_ID])).rowCount) throw new ApiError(404, 'AGENT_NOT_FOUND', 'Agent not found');
    await db.query('UPDATE agents SET revoked_at=NULL WHERE id=$1', [id]);
    return { agent_id: id, restored: true };
  });
}
