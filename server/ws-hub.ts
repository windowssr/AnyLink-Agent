import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { ApiError, type Db } from './db.js';
import { OWNER_ID } from './config.js';
import { authenticateEdgeToken, type EdgeIdentity } from './edge-auth.js';

export type WsTaskDelegate = {
  claimTask: (me: EdgeIdentity, key: string, taskId?: string) => Promise<{ task: any | null }>;
  heartbeatTask: (me: EdgeIdentity, taskId: string, extendSeconds?: number, leaseToken?: string) => Promise<any>;
  reportProgress: (me: EdgeIdentity, taskId: string, progress: Record<string, unknown>, leaseToken?: string) => Promise<any>;
  completeTask: (me: EdgeIdentity, taskId: string, key: string, body: unknown) => Promise<any>;
  cancelTask: (me: EdgeIdentity, taskId: string, key: string) => Promise<any>;
  ackReceipt: (me: EdgeIdentity, taskId: string) => Promise<any>;
  suspendTask: (me: EdgeIdentity, taskId: string, body: unknown) => Promise<any>;
  replyTask: (me: EdgeIdentity, taskId: string, key: string, body: unknown) => Promise<any>;
  pendingTasksFor: (me: EdgeIdentity) => Promise<any[]>;
  unackedReceiptsFor: (me: EdgeIdentity) => Promise<any[]>;
};

export type WsHubOptions = {
  pingIntervalMs?: number;
  maxMissedPongs?: number;
  maxBufferedBytes?: number;
};

const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), ts: z.number().optional() }),
  z.object({ type: z.literal('task.claim'), request_id: z.string().max(120).optional(), idempotency_key: z.string().min(1).max(160), task_id: z.uuid().optional() }),
  z.object({ type: z.literal('task.heartbeat'), request_id: z.string().max(120).optional(), task_id: z.uuid(), extend_seconds: z.number().int().min(10).max(3600).optional(), lease_token: z.uuid().optional() }),
  z.object({ type: z.literal('task.progress'), request_id: z.string().max(120).optional(), task_id: z.uuid(), progress: z.record(z.string(), z.unknown()), lease_token: z.uuid().optional() }),
  z.object({ type: z.literal('task.result'), request_id: z.string().max(120).optional(), task_id: z.uuid(), idempotency_key: z.string().min(1).max(160), result: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('task.cancel'), request_id: z.string().max(120).optional(), task_id: z.uuid(), idempotency_key: z.string().min(1).max(160) }),
  z.object({ type: z.literal('task.receipt_ack'), request_id: z.string().max(120).optional(), task_id: z.uuid() }),
  z.object({
    type: z.literal('task.suspend'),
    request_id: z.string().max(120).optional(),
    task_id: z.uuid(),
    state: z.enum(['awaiting_input', 'awaiting_approval']),
    prompt: z.string().trim().min(1).max(2000),
    choices: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
    risk_level: z.enum(['low', 'medium', 'high']).optional(),
    timeout_seconds: z.number().int().min(10).max(86400).optional(),
    lease_token: z.uuid().optional(),
  }),
  z.object({
    type: z.literal('task.reply'),
    request_id: z.string().max(120).optional(),
    task_id: z.uuid(),
    idempotency_key: z.string().min(1).max(160),
    message: z.string().max(4000).optional(),
    choice: z.string().max(120).optional(),
    approved: z.boolean().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const authFrameSchema = z.object({
  type: z.literal('auth'),
  token: z.string().min(1).max(200),
  resume_after_seq: z.number().int().nonnegative().optional(),
});

const FEATURES = ['events_cursor', 'receipt_ack', 'fencing_token', 'suspend_reply', 'artifacts', 'sse_resume', 'queue_priority'] as const;

export class WsHub {
  private wss: WebSocketServer;
  private byAgent = new Map<string, Set<WebSocket>>();
  private byDevice = new Map<string, Set<WebSocket>>();
  private meta = new WeakMap<WebSocket, EdgeIdentity>();
  private missedPongs = new WeakMap<WebSocket, number>();
  private delegate?: WsTaskDelegate;
  private pingInterval?: ReturnType<typeof setInterval>;
  private pingIntervalMs: number;
  private maxMissedPongs: number;
  private maxBufferedBytes: number;

  constructor(private db: Db, options: WsHubOptions = {}) {
    this.pingIntervalMs = options.pingIntervalMs ?? 25000;
    this.maxMissedPongs = options.maxMissedPongs ?? 2;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  }

  setTaskDelegate(delegate: WsTaskDelegate) {
    this.delegate = delegate;
  }

  attach(app: FastifyInstance) {
    const onUpgrade = async (req: IncomingMessage, socket: any, head: Buffer) => {
      const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (parsedUrl.pathname !== '/edge/v1/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const rawResume = parsedUrl.searchParams.get('resume_after_seq');
      const resumeAfterSeq = rawResume !== null && /^\d+$/.test(rawResume) ? Number(rawResume) : undefined;
      const headerAuth = req.headers.authorization;
      let preAuth: EdgeIdentity | null = null;
      if (headerAuth) {
        try {
          preAuth = await authenticateEdgeToken(this.db, headerAuth, { touchLastSeen: true });
        } catch {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      this.wss.handleUpgrade(req, socket, head, ws => {
        this.handleSocket(ws, preAuth, resumeAfterSeq);
      });
    };

    app.server.on('upgrade', onUpgrade);
    this.pingInterval = setInterval(() => {
      for (const sockets of [...this.byAgent.values()]) {
        for (const ws of [...sockets]) {
          if (ws.readyState !== WebSocket.OPEN) {
            this.unregister(ws);
            continue;
          }
          const missed = this.missedPongs.get(ws) ?? 0;
          if (missed >= this.maxMissedPongs) {
            this.unregister(ws);
            try { ws.terminate(); } catch {}
            continue;
          }
          this.missedPongs.set(ws, missed + 1);
          try { ws.ping(); } catch { this.unregister(ws); }
        }
      }
    }, this.pingIntervalMs);
    this.pingInterval.unref();

    app.addHook('preClose', async () => {
      app.server.off('upgrade', onUpgrade);
      await this.close();
    });
  }

  private send(ws: WebSocket, payload: Record<string, unknown>) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.maxBufferedBytes) {
      // Drop slow consumer to prevent OOM; client will reconnect and replay via resume_after_seq.
      this.unregister(ws);
      try { ws.close(1008, 'Slow consumer'); } catch { try { ws.terminate(); } catch {} }
      return;
    }
    try { ws.send(JSON.stringify(payload)); } catch {}
  }

  async listEventsFor(me: EdgeIdentity, afterSeq = 0, limit = 100): Promise<any[]> {
    const rows = (await this.db.query(
      `SELECT seq, event_type, payload, created_at FROM edge_events
       WHERE owner_id=$1 AND seq>$2
         AND (target_agent_id=$3 OR (target_agent_id IS NULL AND target_device_id=$4) OR (target_agent_id IS NULL AND target_device_id IS NULL))
       ORDER BY seq ASC LIMIT $5`,
      [OWNER_ID, afterSeq, me.agent_id, me.device_id, Math.min(Math.max(1, limit), 200)],
    )).rows;
    return rows.map(r => ({ ...(r.payload ?? {}), seq: Number(r.seq), type: r.event_type }));
  }

  async latestEventSeq(): Promise<number> {
    try {
      const row = (await this.db.query('SELECT COALESCE(MAX(seq),0) AS s FROM edge_events WHERE owner_id=$1', [OWNER_ID])).rows[0];
      return Number(row?.s ?? 0);
    } catch {
      return 0;
    }
  }

  async pruneOldEvents(): Promise<void> {
    await this.db.query("DELETE FROM edge_events WHERE owner_id=$1 AND created_at < now() - interval '24 hours'", [OWNER_ID]).catch(() => {});
  }

  private async persistEvent(targetAgentId: string | null, targetDeviceId: string | null, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const row = (await this.db.query(
        `INSERT INTO edge_events(owner_id,target_agent_id,target_device_id,event_type,payload)
         VALUES($1,$2,$3,$4,$5) RETURNING seq`,
        [OWNER_ID, targetAgentId, targetDeviceId, String(frame.type ?? 'event'), JSON.stringify(frame)],
      )).rows[0];
      return { ...frame, seq: Number(row.seq) };
    } catch {
      return frame;
    }
  }

  private register(ws: WebSocket, identity: EdgeIdentity, resumeAfterSeq?: number) {
    this.meta.set(ws, identity);
    this.missedPongs.set(ws, 0);
    const agentSet = this.byAgent.get(identity.agent_id) ?? new Set<WebSocket>();
    agentSet.add(ws);
    this.byAgent.set(identity.agent_id, agentSet);
    const devSet = this.byDevice.get(identity.device_id) ?? new Set<WebSocket>();
    devSet.add(ws);
    this.byDevice.set(identity.device_id, devSet);

    void this.bootstrapSession(ws, identity, resumeAfterSeq).catch(() => {});
  }

  private async bootstrapSession(ws: WebSocket, identity: EdgeIdentity, resumeAfterSeq?: number) {
    const latestSeq = await this.latestEventSeq();
    if (ws.readyState !== WebSocket.OPEN) return;

    this.send(ws, {
      type: 'hello',
      protocol: '3.2',
      features: [...FEATURES],
      agent_id: identity.agent_id,
      device_id: identity.device_id,
      heartbeat_interval_ms: this.pingIntervalMs,
      latest_event_seq: latestSeq,
      server_time: new Date().toISOString(),
    });

    const replayedAvailable = new Set<string>();
    const replayedCompleted = new Set<string>();
    if (resumeAfterSeq !== undefined && Number.isFinite(resumeAfterSeq)) {
      const missed = await this.listEventsFor(identity, resumeAfterSeq, 200).catch(() => []);
      for (const evt of missed) {
        if (evt.type === 'task.available' && evt.task_id) replayedAvailable.add(String(evt.task_id));
        if (evt.type === 'task.completed' && evt.task?.id) replayedCompleted.add(String(evt.task.id));
        this.send(ws, evt);
      }
    }

    if (!this.delegate || ws.readyState !== WebSocket.OPEN) return;

    // 1. Immediately push pending queued tasks targeting this agent.
    const tasks = await this.delegate.pendingTasksFor(identity).catch(() => []);
    for (const t of tasks) {
      if (replayedAvailable.has(t.id)) continue;
      this.send(ws, {
        type: 'task.available',
        task_id: t.id,
        target_agent_id: t.target_agent_id,
        target_device_id: t.target_device_id,
        capability: t.capability,
        instruction: t.instruction ?? t.input?.instruction ?? null,
        priority: t.priority ?? 5,
      });
    }

    // 2. Immediately push unacknowledged terminal receipts created by this agent (offline delivery guarantee).
    const unacked = await this.delegate.unackedReceiptsFor(identity).catch(() => []);
    for (const t of unacked) {
      if (replayedCompleted.has(t.id)) continue;
      this.send(ws, { type: 'task.completed', task: t, replayed_receipt: true });
    }
  }

  private unregister(ws: WebSocket) {
    const identity = this.meta.get(ws);
    if (!identity) return;
    this.meta.delete(ws);
    this.missedPongs.delete(ws);
    const aSet = this.byAgent.get(identity.agent_id);
    if (aSet) {
      aSet.delete(ws);
      if (aSet.size === 0) this.byAgent.delete(identity.agent_id);
    }
    const dSet = this.byDevice.get(identity.device_id);
    if (dSet) {
      dSet.delete(ws);
      if (dSet.size === 0) this.byDevice.delete(identity.device_id);
    }
  }

  private handleSocket(ws: WebSocket, preAuth: EdgeIdentity | null, initialResumeSeq?: number) {
    let identity: EdgeIdentity | null = preAuth;
    let authTimer: ReturnType<typeof setTimeout> | undefined;

    ws.on('pong', () => {
      this.missedPongs.set(ws, 0);
    });

    if (identity) {
      this.register(ws, identity, initialResumeSeq);
    } else {
      authTimer = setTimeout(() => {
        if (!identity && ws.readyState === WebSocket.OPEN) {
          this.send(ws, { type: 'error', code: 'AUTH_TIMEOUT', message: 'Send auth frame within 5s' });
          ws.close(4001, 'Auth timeout');
        }
      }, 5000);
    }

    ws.on('message', async raw => {
      this.missedPongs.set(ws, 0);
      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        this.send(ws, { type: 'error', code: 'INVALID_JSON', message: 'WebSocket frame must be valid JSON' });
        return;
      }

      if (!identity) {
        const parsedAuth = authFrameSchema.safeParse(json);
        if (!parsedAuth.success) {
          this.send(ws, { type: 'error', code: 'EDGE_AUTH_REQUIRED', message: 'First frame must authenticate with {type:"auth",token}' });
          ws.close(4001, 'Unauthorized');
          return;
        }
        try {
          identity = await authenticateEdgeToken(this.db, parsedAuth.data.token, { touchLastSeen: true });
          if (authTimer) clearTimeout(authTimer);
          this.register(ws, identity, parsedAuth.data.resume_after_seq ?? initialResumeSeq);
        } catch {
          this.send(ws, { type: 'error', code: 'EDGE_AUTH_REQUIRED', message: 'Invalid or revoked device credential' });
          ws.close(4001, 'Unauthorized');
        }
        return;
      }

      const parsed = clientFrameSchema.safeParse(json);
      if (!parsed.success) {
        const reqId = (json && typeof json === 'object' && typeof (json as any).request_id === 'string') ? (json as any).request_id : undefined;
        this.send(ws, { type: 'error', request_id: reqId, code: 'VALIDATION_ERROR', message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
        return;
      }

      const frame = parsed.data;
      if (frame.type === 'ping') {
        this.send(ws, { type: 'pong', ts: frame.ts ?? Date.now() });
        return;
      }

      if (!this.delegate) return;
      try {
        if (frame.type === 'task.claim') {
          const claimed = await this.delegate.claimTask(identity, frame.idempotency_key, frame.task_id);
          this.send(ws, { type: 'task.claimed', request_id: frame.request_id, task: claimed.task });
        } else if (frame.type === 'task.heartbeat') {
          const hb = await this.delegate.heartbeatTask(identity, frame.task_id, frame.extend_seconds, frame.lease_token);
          this.send(ws, { type: 'task.ack', request_id: frame.request_id, task_id: frame.task_id, ok: true, heartbeat: hb });
        } else if (frame.type === 'task.progress') {
          const task = await this.delegate.reportProgress(identity, frame.task_id, frame.progress, frame.lease_token);
          this.send(ws, { type: 'task.ack', request_id: frame.request_id, task_id: frame.task_id, ok: true, task });
        } else if (frame.type === 'task.result') {
          const task = await this.delegate.completeTask(identity, frame.task_id, frame.idempotency_key, frame.result);
          this.send(ws, { type: 'task.ack', request_id: frame.request_id, task_id: frame.task_id, ok: true, task });
        } else if (frame.type === 'task.cancel') {
          const task = await this.delegate.cancelTask(identity, frame.task_id, frame.idempotency_key);
          this.send(ws, { type: 'task.ack', request_id: frame.request_id, task_id: frame.task_id, ok: true, task });
        } else if (frame.type === 'task.receipt_ack') {
          const receipt = await this.delegate.ackReceipt(identity, frame.task_id);
          this.send(ws, { type: 'task.ack', request_id: frame.request_id, task_id: frame.task_id, ok: true, receipt });
        } else if (frame.type === 'task.suspend') {
          const { type: _t, request_id, task_id, ...body } = frame;
          const task = await this.delegate.suspendTask(identity, task_id, body);
          this.send(ws, { type: 'task.ack', request_id, task_id, ok: true, task });
        } else if (frame.type === 'task.reply') {
          const { type: _t, request_id, task_id, idempotency_key, ...body } = frame;
          const task = await this.delegate.replyTask(identity, task_id, idempotency_key, body);
          this.send(ws, { type: 'task.ack', request_id, task_id, ok: true, task });
        }
      } catch (e) {
        const code = e instanceof ApiError ? e.code : (e instanceof z.ZodError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR');
        const message = e instanceof Error ? e.message : 'Operation failed';
        this.send(ws, { type: 'error', request_id: frame.request_id, code, message });
      }
    });

    ws.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
      this.unregister(ws);
    });
    ws.on('error', () => {
      if (authTimer) clearTimeout(authTimer);
      this.unregister(ws);
    });
  }

  isOnline(agentId: string): boolean {
    const set = this.byAgent.get(agentId);
    if (!set) return false;
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) return true;
    return false;
  }

  isDeviceOnline(deviceId: string): boolean {
    const set = this.byDevice.get(deviceId);
    if (!set) return false;
    for (const ws of set) if (ws.readyState === WebSocket.OPEN) return true;
    return false;
  }

  disconnectAgent(agentId: string) {
    const set = this.byAgent.get(agentId);
    if (!set) return;
    for (const ws of [...set]) {
      this.send(ws, { type: 'error', code: 'AGENT_REVOKED', message: 'Credential revoked' });
      ws.close(4003, 'Revoked');
    }
  }

  private sendToAgent(agentId: string, payload: Record<string, unknown>) {
    const set = this.byAgent.get(agentId);
    if (!set) return;
    for (const ws of [...set]) this.send(ws, payload);
  }

  private sendToDevice(deviceId: string, payload: Record<string, unknown>) {
    const set = this.byDevice.get(deviceId);
    if (!set) return;
    for (const ws of [...set]) this.send(ws, payload);
  }

  notifyTaskAvailable(task: any) {
    const baseFrame = {
      type: 'task.available',
      task_id: task.id,
      target_agent_id: task.target_agent_id,
      target_device_id: task.target_device_id,
      capability: task.capability,
      instruction: task.instruction ?? task.input?.instruction ?? null,
      priority: task.priority ?? 5,
    };
    void this.persistEvent(task.target_agent_id ?? null, task.target_agent_id ? null : (task.target_device_id ?? null), baseFrame).then(frame => {
      if (task.target_agent_id) {
        this.sendToAgent(task.target_agent_id, frame);
      } else if (task.target_device_id) {
        this.sendToDevice(task.target_device_id, frame);
      } else {
        for (const [agentId, sockets] of this.byAgent) {
          if (agentId === task.source_agent_id) continue;
          for (const ws of [...sockets]) this.send(ws, frame);
        }
      }
    });
  }

  notifyTaskProgress(task: any, progress: Record<string, unknown>) {
    const baseFrame = { type: 'task.progress', task_id: task.id, progress };
    void this.persistEvent(task.source_agent_id, null, baseFrame).then(frame => {
      this.sendToAgent(task.source_agent_id, frame);
    });
  }

  notifyTaskCompleted(task: any) {
    const baseFrame = { type: 'task.completed', task };
    void this.persistEvent(task.source_agent_id, null, baseFrame).then(frame => {
      this.sendToAgent(task.source_agent_id, frame);
    });
  }

  notifyTaskSuspended(task: any) {
    const eventType = task.state === 'awaiting_approval' ? 'task.awaiting_approval' : 'task.awaiting_input';
    const baseFrame = { type: eventType, task_id: task.id, task, interaction: task.pending_interaction };
    void this.persistEvent(task.source_agent_id, null, baseFrame).then(frame => {
      this.sendToAgent(task.source_agent_id, frame);
    });
  }

  notifyTaskResumed(task: any, reply: Record<string, unknown>) {
    if (!task.claimed_by_agent_id) return;
    const baseFrame = { type: 'task.resumed', task_id: task.id, task, reply };
    void this.persistEvent(task.claimed_by_agent_id, null, baseFrame).then(frame => {
      this.sendToAgent(task.claimed_by_agent_id, frame);
    });
  }

  notifyTaskCancel(task: any) {
    if (!task.claimed_by_agent_id) return;
    const baseFrame = { type: 'task.cancel', task_id: task.id };
    void this.persistEvent(task.claimed_by_agent_id, null, baseFrame).then(frame => {
      this.sendToAgent(task.claimed_by_agent_id, frame);
    });
  }

  notifyMemoryUpdated(event: { episode_id: string; actions: unknown[] }) {
    const baseFrame = { type: 'memory.updated', ...event };
    void this.persistEvent(null, null, baseFrame).then(frame => {
      for (const sockets of this.byAgent.values()) {
        for (const ws of [...sockets]) this.send(ws, frame);
      }
    });
  }

  async close() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
    for (const sockets of this.byAgent.values()) {
      for (const ws of sockets) {
        try { ws.close(1001, 'Server shutting down'); } catch {}
      }
    }
    this.byAgent.clear();
    this.byDevice.clear();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
  }
}
