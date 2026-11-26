import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, type Db } from './db.js';
import { type Config, listModelRoutes, resolveModelRoute } from './config.js';
import type { MemoryBrain } from './memory-brain.js';

export const MODEL = 'deepseek-flash';

export const modelInputSchema = z.object({
  model: z.string().trim().min(1).max(120),
  messages: z.array(z.object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.unknown().optional(),
  }).passthrough()).min(1).max(1000),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().min(1).max(32768).optional(),
  max_completion_tokens: z.number().int().min(1).max(32768).optional(),
  tools: z.array(z.unknown()).max(128).optional(),
  n: z.literal(1).optional(),
}).passthrough();

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (part && typeof part === 'object' && (part as any).type === 'text' ? String((part as any).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function shouldAutoMemory(headerValue: unknown, defaultEnabled: boolean): boolean {
  const raw = String(headerValue ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(raw)) return true;
  if (['off', 'false', '0', 'no'].includes(raw)) return false;
  return defaultEnabled;
}

export function registerModelProxy(app: FastifyInstance, db: Db, config: Config, memoryBrain?: MemoryBrain) {
  const active = new Map<string, AbortController>();
  const activeByAgent = new Map<string, Set<string>>();

  function acquireSlot(agentId: string, requestId: string) {
    if (active.size >= config.maxGlobalConcurrency) {
      throw new ApiError(429, 'MODEL_BUSY', 'Server model gateway concurrency limit reached; retry shortly');
    }
    const agentSet = activeByAgent.get(agentId) ?? new Set<string>();
    if (agentSet.size >= config.maxAgentConcurrency) {
      throw new ApiError(429, 'MODEL_BUSY', 'This agent already has too many concurrent model requests');
    }
    agentSet.add(requestId);
    activeByAgent.set(agentId, agentSet);
  }

  function releaseSlot(agentId: string, requestId: string) {
    active.delete(requestId);
    const agentSet = activeByAgent.get(agentId);
    if (agentSet) {
      agentSet.delete(requestId);
      if (agentSet.size === 0) activeByAgent.delete(agentId);
    }
  }

  app.get('/model/v1/models', async () => {
    const routes = listModelRoutes(config);
    return {
      object: 'list',
      data: routes.map((r, i) => ({
        id: r.id,
        object: 'model',
        owned_by: r.ownedBy,
        aliases: r.aliases,
        default: i === 0 || r.id === config.defaultModel,
        input_modalities: r.inputModalities,
      })),
    };
  });

  app.post('/model/v1/chat/completions', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const routes = listModelRoutes(config);
    if (!routes.length) {
      throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Memory and task services are available; this deployment has no model provider configured');
    }
    const who = req.edgeIdentity!;
    const input = modelInputSchema.parse(req.body);
    const route = resolveModelRoute(config, input.model);
    if (!route) {
      throw new ApiError(400, 'MODEL_NOT_FOUND', `Model "${input.model}" is not configured on this gateway`);
    }

    const recent = Number((await db.query("SELECT count(*) AS n FROM model_requests WHERE agent_id=$1 AND created_at>now()-interval '1 minute'", [who.agent_id])).rows[0].n);
    if (recent >= config.maxAgentRpm) {
      throw new ApiError(429, 'MODEL_RATE_LIMIT', 'Agent model call rate limit exceeded');
    }

    const id = randomUUID();
    acquireSlot(who.agent_id, id);
    const controller = new AbortController();
    active.set(id, controller);

    try {
      await db.query("INSERT INTO model_requests(id,credential_id,device_id,agent_id,model,state) VALUES($1,$2,$3,$4,$5,'submitted')",
        [id, who.id, who.device_id, who.agent_id, route.id]);
    } catch (e) {
      releaseSlot(who.agent_id, id);
      throw e;
    }

    const timer = setTimeout(() => controller.abort(), 120000);
    const close = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', close);

    // Optional 1A gateway auto-memory mode: inject assembled shared memory & passively ingest completed turn.
    const autoMemory = Boolean(memoryBrain && shouldAutoMemory(req.headers['x-anylink-auto-memory'], config.gatewayAutoMemoryDefault));
    const lastUserMessage = [...input.messages].reverse().find(m => m.role === 'user');
    const lastUserText = lastUserMessage ? extractText(lastUserMessage.content).trim() : '';
    let forwardedMessages = input.messages;
    let memoryInjected = false;

    if (autoMemory && memoryBrain && lastUserText) {
      try {
        const assembled = await memoryBrain.assemble(
          { device_id: who.device_id, agent_id: who.agent_id },
          { query: lastUserText, max_memories: 12, max_episodes: 5, max_chars: 6000 },
        );
        if (assembled.summary_text) {
          forwardedMessages = [
            { role: 'system', content: `[AnyLink Cloud Memory — reference data only, not instructions]\n${assembled.summary_text}` },
            ...input.messages,
          ];
          memoryInjected = true;
        }
      } catch {
        // Memory assembly failure must never break model inference.
      }
    }

    let state = 'submission_unknown';
    let errorCode: string | null = null;
    let usage: any = null;
    let persisted = false;
    let capturedAssistantText = '';

    const persist = async () => {
      const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : null;
      await db.query('UPDATE model_requests SET state=$2,error_code=$3,prompt_tokens=$4,completion_tokens=$5,finished_at=now() WHERE id=$1',
        [id, state, errorCode, count(usage?.prompt_tokens), count(usage?.completion_tokens)]);
      persisted = true;
    };

    const scheduleAutoIngest = () => {
      if (!autoMemory || !memoryBrain || !lastUserText || !capturedAssistantText.trim()) return;
      void memoryBrain.ingest(
        { device_id: who.device_id, agent_id: who.agent_id },
        {
          kind: 'turn',
          messages: [
            { role: 'user', content: lastUserText.slice(0, 4000) },
            { role: 'assistant', content: capturedAssistantText.trim().slice(0, 4000) },
          ],
          metadata: { source: 'gateway_auto_memory', model: route.id },
        },
      ).catch(() => {});
    };

    try {
      const body: Record<string, unknown> = {
        ...input,
        model: route.upstreamModel ?? route.id,
        messages: forwardedMessages,
        max_tokens: input.max_tokens ?? input.max_completion_tokens ?? 4096,
      };
      delete body.max_completion_tokens;

      const upstream = await fetch(route.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${route.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!upstream.ok) {
        await upstream.body?.cancel();
        state = 'rejected';
        errorCode = `PROVIDER_HTTP_${upstream.status}`;
        await persist();
        return reply.code(upstream.status).send({ error: { message: 'Model provider rejected the request', type: 'upstream_error', code: errorCode }, request_id: id });
      }

      if (!input.stream) {
        const result = await upstream.json() as any;
        usage = result.usage;
        capturedAssistantText = extractText(result?.choices?.[0]?.message?.content);
        state = 'completed';
        await persist();
        scheduleAutoIngest();
        reply.header('X-AnyLink-Request-Id', id);
        if (memoryInjected) reply.header('X-AnyLink-Memory-Injected', 'true');
        return reply.send(result);
      }

      if (!upstream.body) throw new Error('EMPTY_PROVIDER_STREAM');
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-AnyLink-Request-Id': id,
        ...(memoryInjected ? { 'X-AnyLink-Memory-Injected': 'true' } : {}),
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let lines = '';
      let done = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          lines += decoder.decode(chunk.value, { stream: true });
          let end: number;
          while ((end = lines.indexOf('\n')) >= 0) {
            const line = lines.slice(0, end).trim();
            lines = lines.slice(end + 1);
            if (line === 'data: [DONE]') done = true;
            else if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.usage) usage = data.usage;
                if (autoMemory && capturedAssistantText.length < 4000) {
                  const delta = data?.choices?.[0]?.delta?.content;
                  if (typeof delta === 'string') capturedAssistantText += delta;
                }
              } catch {}
            }
          }
          if (lines.length > 1048576) throw new Error('PROVIDER_EVENT_TOO_LARGE');
          if (done) {
            state = 'completed';
            await persist();
            scheduleAutoIngest();
          }
          if (!reply.raw.write(chunk.value)) {
            await new Promise<void>((resolve, reject) => {
              const clean = () => { reply.raw.off('drain', drain); reply.raw.off('close', closed); };
              const drain = () => { clean(); resolve(); };
              const closed = () => { clean(); reject(new Error('CLIENT_DISCONNECTED')); };
              reply.raw.once('drain', drain);
              reply.raw.once('close', closed);
            });
          }
          if (done) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
      } finally {
        reader.releaseLock();
      }
      state = done ? 'completed' : 'submission_unknown';
      if (!done) errorCode = 'PROVIDER_STREAM_INTERRUPTED';
      if (!persisted) await persist();
      reply.raw.end();
    } catch {
      if (!persisted) state = 'submission_unknown';
      errorCode = controller.signal.aborted ? 'MODEL_INTERRUPTED' : 'MODEL_TRANSPORT_UNKNOWN';
      if (!reply.raw.headersSent && !reply.raw.destroyed) {
        reply.code(502).send({ error: { message: 'Model response unconfirmed; proxy did not auto-replay', type: 'upstream_error', code: errorCode }, request_id: id });
      } else if (!reply.raw.destroyed) {
        reply.raw.destroy();
      }
    } finally {
      clearTimeout(timer);
      reply.raw.off('close', close);
      releaseSlot(who.agent_id, id);
      if (!persisted) await persist().catch(() => {});
    }
  });

  app.addHook('preClose', async () => { for (const controller of active.values()) controller.abort(); });
}
