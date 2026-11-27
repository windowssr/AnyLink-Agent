import Fastify, { type FastifyRequest } from 'fastify';
import staticPlugin from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type Config, listModelRoutes, OWNER_ID } from './config.js';
import { ApiError, createDb, hash, idempotent, migrate, transaction } from './db.js';
import { createDevice, deleteMemory, devicePatchSchema, deviceSchema, editMemory, getMemory, listDevices, memoryDirectory, memoryPatchSchema, memorySchema, memorySearchSchema, saveMemory, searchMemories, updateDevice } from './store.js';
import { authenticateEdge, registerConnectRoute, registerCredentialRoutes } from './edge-auth.js';
import { registerModelProxy, pruneModelSnapshots } from './model-proxy.js';
import { registerSpeech } from './speech.js';
import { LinkService, registerLink } from './link.js';
import { registerArtifacts, pruneExpiredArtifacts } from './artifacts.js';
import { MemoryBrain, memoryAssembleSchema, memoryIngestSchema } from './memory-brain.js';
import { WsHub } from './ws-hub.js';

const idParams = z.object({ id: z.uuid() });
const tokenFromCookie = (r: FastifyRequest) => (r.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('anylink_session='))?.slice('anylink_session='.length);

export async function createApp(config: Config, { logger = true, fetchImpl }: { logger?: boolean; fetchImpl?: typeof fetch } = {}) {
  const app = Fastify({
    trustProxy: config.trustProxy,
    logger: logger
      ? {
        level: 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        serializers: { req: r => ({ method: r.method, url: r.url?.split('?')[0] }), err: e => ({ type: e.name, code: e.code, message: 'Details redacted', stack: '' }) },
      }
      : false,
    bodyLimit: 2097152,
    forceCloseConnections: true,
    disableRequestLogging: true,
  });

  const db = createDb(config.databaseUrl);
  await migrate(db);

  let persona: null | { name: string; sha256: string; content: string } = null;
  if (config.personaFile) {
    for (const candidate of [resolve(config.personaFile), resolve('examples', config.personaFile)]) {
      try {
        if (!existsSync(candidate)) continue;
        const content = readFileSync(candidate, 'utf8');
        persona = { name: basename(candidate).replace(/\.[^.]*$/, ''), sha256: createHash('sha256').update(content).digest('hex'), content };
        break;
      } catch {}
    }
  }

  const wsHub = new WsHub(db, {
    pingIntervalMs: config.wsPingIntervalMs,
    maxMissedPongs: config.wsMaxMissedPongs,
    maxBufferedBytes: config.wsMaxBufferedBytes,
  });
  const memoryBrain = new MemoryBrain(db, config, {
    fetchImpl,
    onMemoryUpdated: event => wsHub.notifyMemoryUpdated(event),
  });
  const linkService = new LinkService(db, wsHub, memoryBrain, {
    maxQueuedPerAgent: config.maxQueuedPerAgent,
    maxQueuedGlobal: config.maxQueuedGlobal,
    maxCallDepth: config.maxCallDepth,
    onReapTick: async () => {
      await Promise.all([wsHub.pruneOldEvents(), pruneExpiredArtifacts(db, config.artifactDir), pruneModelSnapshots(db)]);
    },
  });
  wsHub.setTaskDelegate(linkService);
  wsHub.attach(app);
  linkService.startLeaseReaper(config.leaseReaperIntervalMs);
  void memoryBrain.recoverPending().catch(() => {});

  const loginAttempts = new Map<string, { count: number; until: number }>();

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && req.headers.origin && req.headers.origin !== config.origin) {
      throw new ApiError(403, 'ORIGIN_REJECTED', 'Cross-origin write requests are not accepted');
    }
    const path = req.url.split('?')[0];
    if (path === '/edge/v1/connect' || path === '/edge/v1/ws') return;
    if (path.startsWith('/edge/v1/') || path.startsWith('/model/v1/')) {
      await authenticateEdge(db, req);
      return;
    }
    if (!path.startsWith('/v1/') || path === '/v1/auth/login') return;
    const token = tokenFromCookie(req);
    if (!token || token.length > 200) throw new ApiError(401, 'AUTH_REQUIRED', 'Login required');
    if (!(await db.query('SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND expires_at>now()', [hash(token)])).rowCount) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Session expired; please log in again');
    }
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: { code: error.code, message: error.message }, request_id: req.id });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, request_id: req.id });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request format' }, request_id: req.id });
    app.log.error({ code: (error as { code?: string }).code, requestId: req.id }, 'Request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Request temporarily unavailable' }, request_id: req.id });
  });

  const key = (r: FastifyRequest) => z.string().min(1).max(160).parse(r.headers['idempotency-key']);
  async function mutate(req: FastifyRequest, scope: string, body: unknown, fn: Parameters<typeof idempotent>[4]) {
    return (await idempotent(db, scope, key(req), body, fn)).value;
  }

  app.get('/healthz', async () => ({ ok: true, service: 'anylink-agent', version: '0.9.0', protocol: '3.2', role: 'personal-agent-hub' }));
  app.get('/readyz', async (_req, reply) => {
    let database = false;
    try { await db.query('SELECT 1'); database = true; } catch {}
    const provider_configured = listModelRoutes(config).length > 0;
    return reply.code(database ? 200 : 503).send({
      ok: database,
      database,
      provider_configured,
      cloud_memory_brain: true,
      ws_enabled: true,
    });
  });

  const secretMatches = (provided: string, expected?: string) => Boolean(expected) && timingSafeEqual(Buffer.from(hash(provided)), Buffer.from(hash(expected!)));

  app.post('/v1/auth/login', async (req, reply) => {
    const input = z.object({ token: z.string().min(1).max(200).optional(), password: z.string().min(1).max(200).optional() }).strict()
      .refine(v => Boolean(v.token || v.password), 'Provide token or password').parse(req.body);
    const provided = (input.token ?? input.password ?? '').trim();
    const now = Date.now(), old = loginAttempts.get(req.ip);
    if (old && old.until > now && old.count >= 5) throw new ApiError(429, 'LOGIN_RATE_LIMIT', 'Too many failed attempts; try again in 15 minutes');
    if (!secretMatches(provided, config.ownerToken) && !secretMatches(provided, config.loginPassword)) {
      loginAttempts.set(req.ip, { count: old && old.until > now ? old.count + 1 : 1, until: old && old.until > now ? old.until : now + 900000 });
      throw new ApiError(401, 'INVALID_TOKEN', 'Invalid login password or owner token');
    }
    loginAttempts.delete(req.ip);
    const token = randomBytes(32).toString('base64url');
    await db.query('DELETE FROM auth_sessions WHERE expires_at<=now()');
    await db.query("INSERT INTO auth_sessions(token_hash,expires_at) VALUES($1,now()+interval '7 days')", [hash(token)]);
    reply.header('Set-Cookie', `anylink_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${config.origin.startsWith('https:') ? '; Secure' : ''}`);
    return { ok: true };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    await db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [hash(tokenFromCookie(req) ?? '')]);
    reply.header('Set-Cookie', 'anylink_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });

  app.get('/v1/status', async () => ({
    version: '0.9.0',
    protocol: '3.2',
    assistant: 'AnyLink',
    default_model: config.defaultModel,
    models: listModelRoutes(config).map(m => m.id),
    cloud_memory_brain: true,
    ws_enabled: true,
    artifacts_enabled: true,
    owner_id: OWNER_ID,
    join_enabled: !!(config.joinKey || config.loginPassword),
    login_password_enabled: !!config.loginPassword,
  }));

  app.get('/v1/devices', async () => {
    const devices = (await db.query('SELECT *,false AS executor_connected FROM devices WHERE owner_id=$1 ORDER BY created_at', [OWNER_ID])).rows;
    const agents = (await db.query(`SELECT a.id,a.device_id,a.key,a.name,a.kind,a.summary,a.capabilities,a.file_policy,a.last_seen_at,a.revoked_at,c.id AS credential_id,c.created_at AS bound_at,c.last_used_at,(a.last_seen_at IS NOT NULL AND a.last_seen_at>now()-interval '60 seconds') AS http_online
      FROM agents a JOIN devices d ON d.id=a.device_id LEFT JOIN edge_credentials c ON c.agent_id=a.id AND c.revoked_at IS NULL WHERE d.owner_id=$1 ORDER BY a.key`, [OWNER_ID])).rows;
    const byDevice = new Map<string, any[]>();
    for (const a of agents) {
      const { device_id, http_online, ...agent } = a;
      const wsOnline = wsHub.isOnline(agent.id);
      const list = byDevice.get(device_id) ?? [];
      list.push({ ...agent, ws_online: wsOnline, online: wsOnline || Boolean(http_online) });
      byDevice.set(device_id, list);
    }
    return { items: devices.map(d => ({ ...d, agents: byDevice.get(d.id) ?? [] })) };
  });

  app.post('/v1/devices', async req => { const v = deviceSchema.parse(req.body); return mutate(req, 'devices:create', v, c => createDevice(c, v)); });
  app.patch('/v1/devices/:id', async req => { const { id } = idParams.parse(req.params), v = devicePatchSchema.parse(req.body); return mutate(req, `devices:edit:${id}`, v, c => updateDevice(c, id, v)); });

  registerConnectRoute(app, db, config, loginAttempts);
  registerCredentialRoutes(app, db, id => wsHub.isOnline(id), id => wsHub.disconnectAgent(id));
  registerModelProxy(app, db, config, memoryBrain);
  registerSpeech(app, config, persona);
  registerLink(app, db, linkService, wsHub, config);
  registerArtifacts(app, db, config);

  app.get('/edge/v1/events', async req => {
    const query = z.object({
      after_seq: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).strict().parse(req.query ?? {});
    const items = await wsHub.listEventsFor(req.edgeIdentity!, query.after_seq, query.limit);
    const latest_seq = items.length ? items[items.length - 1].seq : await wsHub.latestEventSeq();
    return { items, latest_seq };
  });

  app.get('/edge/v1/identity', async req => {
    const me = req.edgeIdentity!;
    const agent = (await db.query('SELECT id,key,name,kind,summary,capabilities,file_policy FROM agents WHERE id=$1', [me.agent_id])).rows[0];
    return { device: (await listDevices(db)).find(d => d.id === me.device_id), agent, scopes: ['memory', 'memory_brain', 'model', 'tasks', 'ws', 'persona', 'artifacts'], protocol: { name: 'anylink', version: '3.2' } };
  });

  app.post('/edge/v1/device/install-id', async req => {
    const me = req.edgeIdentity!;
    const { install_id } = z.object({ install_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) }).strict().parse(req.body);
    return transaction(db, async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`connect:${install_id}`]);
      const device = (await c.query('SELECT id,install_id,revoked_at FROM devices WHERE id=$1 FOR UPDATE', [me.device_id])).rows[0];
      if (!device) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
      if (device.install_id === install_id) return { device_id: device.id, install_id };
      if (device.install_id) throw new ApiError(409, 'INSTALL_ID_ALREADY_SET', 'This device already has a different install_id');
      if ((await c.query('SELECT 1 FROM devices WHERE install_id=$1', [install_id])).rowCount) throw new ApiError(409, 'INSTALL_ID_IN_USE', 'Another device already uses this install_id');
      await c.query('UPDATE devices SET install_id=$1 WHERE id=$2', [install_id, device.id]);
      return { device_id: device.id, install_id };
    });
  });

  app.get('/edge/v1/persona', async () => {
    if (!persona) throw new ApiError(404, 'PERSONA_NOT_CONFIGURED', 'Persona is not configured on this deployment');
    return persona;
  });

  // Cloud Memory Brain v3 endpoints
  app.post('/edge/v1/memory/assemble', async req => {
    const me = req.edgeIdentity!;
    const input = memoryAssembleSchema.parse(req.body ?? {});
    return memoryBrain.assemble({ device_id: me.device_id, agent_id: me.agent_id }, input, persona);
  });

  app.post('/edge/v1/memory/ingest', async (req, reply) => {
    const me = req.edgeIdentity!;
    const input = memoryIngestSchema.parse(req.body);
    const outcome = await memoryBrain.ingest({ device_id: me.device_id, agent_id: me.agent_id }, input);
    reply.code(input.consolidate_now ? 200 : 202);
    return outcome;
  });

  app.get('/edge/v1/memory/episodes', async req => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query ?? {});
    return { items: await memoryBrain.listEpisodes(limit) };
  });

  app.get('/v1/memory/episodes', async req => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query ?? {});
    return { items: await memoryBrain.listEpisodes(limit) };
  });

  app.get('/edge/v1/context', async req => {
    const me = req.edgeIdentity!;
    const [global, device, agent, boundaries, episodes] = await Promise.all([
      searchMemories(db, { scope: 'global', limit: 30 }),
      searchMemories(db, { scope: 'device', device_id: me.device_id, limit: 30 }),
      searchMemories(db, { scope: 'agent', viewer: { agentId: me.agent_id, deviceId: me.device_id }, limit: 30 }),
      searchMemories(db, { scope: 'global', kind: 'boundary', limit: 20 }),
      memoryBrain.listEpisodes(10),
    ]);
    return {
      device_id: me.device_id,
      agent_id: me.agent_id,
      global,
      device,
      agent,
      boundaries,
      episodes,
      persona,
      directory: { device_id: me.device_id, entries: device.map(m => ({ id: m.id, title: m.title, revision: m.revision })) },
    };
  });

  for (const prefix of ['/v1', '/edge/v1']) {
    const source = (req: FastifyRequest) => ({ kind: req.edgeIdentity ? 'edge_owner_statement' : 'owner_edit', deviceId: req.edgeIdentity?.device_id, agentId: req.edgeIdentity?.agent_id });
    const viewer = (req: FastifyRequest) => req.edgeIdentity ? { agentId: req.edgeIdentity.agent_id, deviceId: req.edgeIdentity.device_id } : undefined;
    const scope = (req: FastifyRequest, op: string) => `${req.edgeIdentity?.id ?? 'owner'}:${op}`;

    app.get(prefix + '/devices/:id/memory-directory', async req => memoryDirectory(db, idParams.parse(req.params).id));
    app.get(prefix + '/memories', async req => ({ items: await searchMemories(db, { ...memorySearchSchema.parse(req.query), viewer: viewer(req) }) }));
    app.post(prefix + '/memories/search', async req => ({ items: await searchMemories(db, { ...memorySearchSchema.parse(req.body), viewer: viewer(req) }) }));
    app.get(prefix + '/memories/:id', async req => getMemory(db, idParams.parse(req.params).id, viewer(req)));
    app.get(prefix + '/memories/:id/revisions', async req => {
      const { id } = idParams.parse(req.params);
      await getMemory(db, id, viewer(req));
      return { items: (await db.query('SELECT revision,snapshot,created_at FROM memory_revisions WHERE memory_id=$1 ORDER BY revision DESC', [id])).rows };
    });
    app.post(prefix + '/memories', async req => {
      const raw = (req.body && typeof req.body === 'object') ? { ...(req.body as Record<string, unknown>) } : req.body;
      // Default applicable_device_id for edge callers writing device scope.
      if (req.edgeIdentity && raw && typeof raw === 'object' && (raw as any).scope === 'device') {
        if ((raw as any).applicable_device_id && (raw as any).applicable_device_id !== req.edgeIdentity.device_id) {
          throw new ApiError(403, 'DEVICE_SCOPE_FORBIDDEN', 'Device memory can only be written for the caller device');
        }
        (raw as any).applicable_device_id = req.edgeIdentity.device_id;
      }
      const v = memorySchema.parse(raw);
      if (v.scope === 'agent') {
        if (req.edgeIdentity) {
          if (v.applicable_agent_id && v.applicable_agent_id !== req.edgeIdentity.agent_id) throw new ApiError(403, 'AGENT_SCOPE_FORBIDDEN', 'Agent memory can only be written for the caller agent');
          v.applicable_agent_id = req.edgeIdentity.agent_id;
        } else if (!v.applicable_agent_id) {
          throw new ApiError(400, 'AGENT_REQUIRED', 'Agent memory requires applicable_agent_id');
        }
      }
      return mutate(req, scope(req, 'memories:create'), v, c => saveMemory(c, v, source(req)));
    });
    app.patch(prefix + '/memories/:id', async req => {
      const { id } = idParams.parse(req.params), v = memoryPatchSchema.parse(req.body);
      return mutate(req, scope(req, `memories:edit:${id}`), v, c => editMemory(c, id, v, source(req), viewer(req)));
    });
    app.delete(prefix + '/memories/:id', async req => {
      const { id } = idParams.parse(req.params), revision = z.coerce.number().int().positive().parse(String(req.headers['if-match'] ?? '').replaceAll('"', ''));
      return mutate(req, scope(req, `memories:delete:${id}`), { revision }, c => deleteMemory(c, id, revision, viewer(req)));
    });
  }

  app.get('/v1/model-requests', async () => ({
    items: (await db.query('SELECT id,device_id,agent_id,model,state,prompt_tokens,completion_tokens,error_code,created_at,finished_at FROM model_requests ORDER BY created_at DESC LIMIT 50')).rows,
  }));

  const webRoot = resolve('dist/web');
  if (existsSync(webRoot)) await app.register(staticPlugin, { root: webRoot, prefix: '/', index: ['index.html'] });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Endpoint or page not found' } }));
  app.addHook('preClose', async () => {
    linkService.stopLeaseReaper();
    await memoryBrain.drain();
  });
  app.addHook('onClose', async () => {
    linkService.stopLeaseReaper();
    await memoryBrain.drain();
    await db.end();
  });

  return { app, db, wsHub, memoryBrain, linkService };
}
