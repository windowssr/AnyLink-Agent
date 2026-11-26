import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { ApiError, type Db } from './db.js';
import { authenticateEdgeToken, type EdgeIdentity } from './edge-auth.js';

export type WsTaskDelegate = {
  claimTask: (me: EdgeIdentity, key: string, taskId?: string) => Promise<{ task: any | null }>;
  heartbeatTask: (me: EdgeIdentity, taskId: string, extendSeconds?: number) => Promise<any>;
  reportProgress: (me: EdgeIdentity, taskId: string, progress: Record<string, unknown>) => Promise<any>;
  completeTask: (me: EdgeIdentity, taskId: string, key: string, body: unknown) => Promise<any>;
  cancelTask: (me: EdgeIdentity, taskId: string, key: string) => Promise<any>;
  pendingTasksFor: (me: EdgeIdentity) => Promise<any[]>;
};

const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), ts: z.number().optional() }),
  z.object({ type: z.literal('task.claim'), request_id: z.string().max(120).optional(), idempotency_key: z.string().min(1).max(160), task_id: z.uuid().optional() }),
  z.object({ type: z.literal('task.heartbeat'), request_id: z.string().max(120).optional(), task_id: z.uuid(), extend_seconds: z.number().int().min(10).max(3600).optional() }),
  z.object({ type: z.literal('task.progress'), request_id: z.string().max(120).optional(), task_id: z.uuid(), progress: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('task.result'), request_id: z.string().max(120).optional(), task_id: z.uuid(), idempotency_key: z.string().min(1).max(160), result: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('task.cancel'), request_id: z.string().max(120).optional(), task_id: z.uuid(), idempotency_key: z.string().min(1).max(160) }),
]);

const authFrameSchema = z.object({ type: z.literal('auth'), token: z.string().min(1).max(200) });

export class WsHub {
  private wss: WebSocketServer;
  private byAgent = new Map<string, Set<WebSocket>>();
  private byDevice = new Map<string, Set<WebSocket>>();
  private meta = new WeakMap<WebSocket, EdgeIdentity>();
  private delegate?: WsTaskDelegate;
  private pingInterval?: ReturnType<typeof setInterval>;

  constructor(private db: Db) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  }

  setTaskDelegate(delegate: WsTaskDelegate) {
    this.delegate = delegate;
  }

  attach(app: FastifyInstance) {
    const onUpgrade = async (req: IncomingMessage, socket: any, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== '/edge/v1/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
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
        this.handleSocket(ws, preAuth);
      });
    };

    app.server.on('upgrade', onUpgrade);
    this.pingInterval = setInterval(() => {
      for (const sockets of this.byAgent.values()) {
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        }
      }
    }, 25000);
    this.pingInterval.unref();

    app.addHook('preClose', async () => {
      app.server.off('upgrade', onUpgrade);
      await this.close();
    });
  }

  private send(ws: WebSocket, payload: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private register(ws: WebSocket, identity: EdgeIdentity) {
    this.meta.set(ws, identity);
    const agentSet = this.byAgent.get(identity.agent_id) ?? new Set<WebSocket>();
    agentSet.add(ws);
    this.byAgent.set(identity.agent_id, agentSet);
    const devSet = this.byDevice.get(identity.device_id) ?? new Set<WebSocket>();
    devSet.add(ws);
    this.byDevice.set(identity.device_id, devSet);

    this.send(ws, {
      type: 'hello',
      protocol: '3.0',
      agent_id: identity.agent_id,
      device_id: identity.device_id,
      server_time: new Date().toISOString(),
    });

    // Immediately notify about any queued tasks waiting for this agent.
    if (this.delegate) {
      void this.delegate.pendingTasksFor(identity).then(tasks => {
        for (const t of tasks) {
          this.send(ws, {
            type: 'task.available',
            task_id: t.id,
            target_agent_id: t.target_agent_id,
            target_device_id: t.target_device_id,
            capability: t.capability,
            instruction: t.instruction ?? t.input?.instruction ?? null,
          });
        }
      }).catch(() => {});
    }
  }

  private unregister(ws: WebSocket) {
    const identity = this.meta.get(ws);
    if (!identity) return;
    this.meta.delete(ws);
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

  private handleSocket(ws: WebSocket, preAuth: EdgeIdentity | null) {
    let identity: EdgeIdentity | null = preAuth;
    let authTimer: ReturnType<typeof setTimeout> | undefined;

    if (identity) {
      this.register(ws, identity);
    } else {
      authTimer = setTimeout(() => {
        if (!identity && ws.readyState === WebSocket.OPEN) {
          this.send(ws, { type: 'error', code: 'AUTH_TIMEOUT', message: 'Send auth frame within 5s' });
          ws.close(4001, 'Auth timeout');
        }
      }, 5000);
    }

    ws.on('message', async raw => {
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
          this.register(ws, identity);
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
          const hb = await this.delegate.heartbeatTask(identity, frame.task_id, frame.extend_seconds);
          this.send(ws, { type: 'task.ack', request_id: frame.request_id, task_id: frame.task_id, ok: true, heartbeat: hb });
        } else if (frame.type === 'task.progress') {
          const task = await this.delegate.reportProgress(identity, frame.task_id, frame.progress);
          this.send(ws, { type: 'task.ack', request_id: frame.request_id, task_id: frame.task_id, ok: true, task });
        } else if (frame.type === 'task.result') {
          const task = await this.delegate.completeTask(identity, frame.task_id, frame.idempotency_key, frame.result);
          this.send(ws, { type: 'task.ack', request_id: frame.request_id, task_id: frame.task_id, ok: true, task });
        } else if (frame.type === 'task.cancel') {
          const task = await this.delegate.cancelTask(identity, frame.task_id, frame.idempotency_key);
          this.send(ws, { type: 'task.ack', request_id: frame.request_id, task_id: frame.task_id, ok: true, task });
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
    for (const ws of set) this.send(ws, payload);
  }

  private sendToDevice(deviceId: string, payload: Record<string, unknown>) {
    const set = this.byDevice.get(deviceId);
    if (!set) return;
    for (const ws of set) this.send(ws, payload);
  }

  notifyTaskAvailable(task: any) {
    const frame = {
      type: 'task.available',
      task_id: task.id,
      target_agent_id: task.target_agent_id,
      target_device_id: task.target_device_id,
      capability: task.capability,
      instruction: task.instruction ?? task.input?.instruction ?? null,
    };
    if (task.target_agent_id) {
      this.sendToAgent(task.target_agent_id, frame);
    } else if (task.target_device_id) {
      this.sendToDevice(task.target_device_id, frame);
    } else {
      for (const [agentId, sockets] of this.byAgent) {
        if (agentId === task.source_agent_id) continue;
        for (const ws of sockets) this.send(ws, frame);
      }
    }
  }

  notifyTaskProgress(task: any, progress: Record<string, unknown>) {
    this.sendToAgent(task.source_agent_id, { type: 'task.progress', task_id: task.id, progress });
  }

  notifyTaskCompleted(task: any) {
    this.sendToAgent(task.source_agent_id, { type: 'task.completed', task });
  }

  notifyTaskCancel(task: any) {
    if (task.claimed_by_agent_id) {
      this.sendToAgent(task.claimed_by_agent_id, { type: 'task.cancel', task_id: task.id });
    }
  }

  notifyMemoryUpdated(event: { episode_id: string; actions: unknown[] }) {
    const frame = { type: 'memory.updated', ...event };
    for (const sockets of this.byAgent.values()) {
      for (const ws of sockets) this.send(ws, frame);
    }
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
