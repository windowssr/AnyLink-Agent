import fs from 'node:fs';
import { z } from 'zod';
import { capabilitiesSchema, taskCreateSchema, taskHeartbeatSchema, taskProgressSchema, taskResultSchema, taskSchema } from '../server/link.ts';
import { agentProfileSchema, connectSchema } from '../server/edge-auth.ts';
import { memorySchema, memoryPatchSchema, memorySearchSchema, deviceSchema } from '../server/store.ts';
import { memoryAssembleSchema, memoryIngestSchema } from '../server/memory-brain.ts';
import { modelInputSchema } from '../server/model-proxy.ts';
import { speechSchema } from '../server/speech.ts';

const installIdSchema = z.object({ install_id: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) }).strict();

const schemas = {
  Connect: connectSchema,
  AgentProfile: agentProfileSchema,
  InstallId: installIdSchema,
  Capabilities: capabilitiesSchema,
  TaskInput: taskCreateSchema,
  TaskHeartbeat: taskHeartbeatSchema,
  TaskProgress: taskProgressSchema,
  TaskResult: taskResultSchema,
  Task: taskSchema,
  MemoryAssemble: memoryAssembleSchema,
  MemoryIngest: memoryIngestSchema,
  MemoryInput: memorySchema,
  MemoryPatch: memoryPatchSchema,
  MemorySearch: memorySearchSchema,
  ChatCompletions: modelInputSchema,
  Speech: speechSchema,
  Device: deviceSchema,
};

const paths = {};
function route(url, method, { schema, owner = false, key = false, summary, response, join = false }) {
  const params = [];
  if (url.includes('{id}')) params.push({ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
  if (key) params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 160 } });
  if (method === 'delete') params.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string', description: 'Current memory revision' } });
  paths[url] ??= {};
  paths[url][method] = {
    summary,
    security: [{ [join ? 'joinKey' : owner ? 'ownerSession' : 'deviceBearer']: [] }],
    parameters: params,
    ...(schema ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/' + schema } } } } } : {}),
    responses: {
      '200': { description: 'Successful operation', ...(response ? { content: { 'application/json': { schema: { $ref: '#/components/schemas/' + response } } } } : {}) },
      '201': { description: 'Created; one-time secret when issuing credentials' },
      '202': { description: 'Accepted for asynchronous cloud processing' },
      '400': { description: 'Invalid input' },
      '401': { description: 'Invalid or revoked credential' },
      '403': { description: 'Not permitted for this identity' },
      '404': { description: 'Not found or not visible to this agent' },
      '409': { description: 'Revision, idempotency, or terminal-state conflict' },
      ...(join ? { '503': { description: 'Join disabled' } } : {}),
    },
  };
}

route('/edge/v1/connect', 'post', { schema: 'Connect', join: true, summary: 'Join with owner key: upsert device and agent, rotate credential (201)' });
route('/edge/v1/protocol', 'get', { summary: 'Negotiate AnyLink protocol 3.0, transport endpoints and routing modes' });
route('/edge/v1/directory', 'get', { summary: 'List devices and agents with live WebSocket presence and optional summaries' });
route('/edge/v1/agent/profile', 'patch', { schema: 'AgentProfile', summary: 'Update informational agent name, kind, or summary' });
route('/edge/v1/device/install-id', 'post', { schema: 'InstallId', summary: 'Adopt an install_id for the credential device' });
for (const name of ['identity', 'context', 'persona']) {
  route('/edge/v1/' + name, 'get', { summary: 'Read authenticated ' + (name === 'persona' ? 'persona document' : 'agent ' + name) });
}

// Cloud Memory Brain v3
route('/edge/v1/memory/assemble', 'post', { schema: 'MemoryAssemble', summary: 'Hybrid retrieval and context assembly (memories, boundaries, cross-device episodes)' });
route('/edge/v1/memory/ingest', 'post', { schema: 'MemoryIngest', summary: 'Ingest conversation turn, task outcome, or observation for cloud memory consolidation' });
route('/edge/v1/memory/episodes', 'get', { summary: 'List recent cross-device episodic summaries' });
route('/edge/v1/memories', 'post', { schema: 'MemoryInput', key: true, summary: 'Save explicit memory; device and agent scopes bind caller identity' });
route('/edge/v1/memories/{id}', 'patch', { schema: 'MemoryPatch', key: true, summary: 'Revise memory with expected_revision' });
route('/edge/v1/memories/{id}', 'delete', { key: true, summary: 'Tombstone memory using If-Match' });
route('/edge/v1/memories/search', 'post', { schema: 'MemorySearch', summary: 'Hybrid tokenized memory search' });

// Capability-free cross-device tasks (with /edge/v1/link/tasks* aliases preserved)
route('/edge/v1/tasks', 'get', { summary: 'List agent tasks (role=source|target, optional state; newest 100)' });
route('/edge/v1/tasks', 'post', { schema: 'TaskInput', key: true, summary: 'Create cross-device task by instruction or capability without capability-manifest gate', response: 'Task' });
route('/edge/v1/tasks/{id}', 'get', { summary: 'Read a task visible to source, target or claiming agent', response: 'Task' });
route('/edge/v1/tasks/claim', 'post', { key: true, summary: 'Atomically claim a routed task with lease tracking (HTTP fallback for WS)' });
route('/edge/v1/tasks/{id}/heartbeat', 'post', { schema: 'TaskHeartbeat', summary: 'Extend running task lease and check cooperative cancellation status' });
route('/edge/v1/tasks/{id}/progress', 'post', { schema: 'TaskProgress', summary: 'Report live task progress (pushed over WebSocket to sender)', response: 'Task' });
route('/edge/v1/tasks/{id}/result', 'post', { schema: 'TaskResult', key: true, summary: 'Persist terminal result (succeeded|failed|declined|cancelled|unknown); declined/failed feeds Cloud Memory Brain', response: 'Task' });
route('/edge/v1/tasks/{id}/cancel', 'post', { key: true, summary: 'Cancel queued work or push cooperative cancellation to claiming agent', response: 'Task' });
route('/edge/v1/link/capabilities', 'post', { schema: 'Capabilities', key: true, summary: 'Optional compatibility capability manifest update' });

paths['/edge/v1/tasks'].get.parameters.push(
  { name: 'role', in: 'query', schema: { type: 'string', enum: ['source', 'target'], default: 'source' } },
  { name: 'state', in: 'query', schema: { type: 'string', enum: ['queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'declined', 'cancelled', 'unknown', 'expired'] } },
);

// Model Gateway
route('/model/v1/models', 'get', { summary: 'List configured gateway models and aliases' });
route('/model/v1/chat/completions', 'post', { schema: 'ChatCompletions', summary: 'Multi-model OpenAI Chat Completions passthrough (JSON/SSE) with optional X-AnyLink-Auto-Memory header' });
route('/model/v1/speech', 'post', { schema: 'Speech', summary: 'Optional spoken reply TTS endpoint with configurable neutral or persona style' });

// Owner admin
route('/v1/devices', 'get', { owner: true, summary: 'List owner devices and agents with live WS presence' });
route('/v1/devices', 'post', { schema: 'Device', owner: true, key: true, summary: 'Register a logical device' });
route('/v1/agents', 'get', { owner: true, summary: 'List all agents across devices' });
route('/v1/memory/episodes', 'get', { owner: true, summary: 'Inspect recent cross-device memory episodes' });
route('/v1/agents/{id}/revoke', 'post', { owner: true, summary: 'Revoke an agent, drop its WS sessions and invalidate credentials' });
route('/v1/agents/{id}/restore', 'post', { owner: true, summary: 'Restore a revoked agent' });
route('/v1/devices/{id}/restore', 'post', { owner: true, summary: 'Restore a revoked device and its agents' });
route('/v1/devices/{id}/credential', 'post', { owner: true, summary: 'Issue a one-time credential for the device default agent (201)' });
paths['/v1/devices/{id}/credential'].post.responses['201'] = { description: 'One-time secret: device_id, agent_id, credential_id and token.' };
delete paths['/v1/devices/{id}/credential'].post.responses['200'];
paths['/v1/auth/login'] = {
  post: {
    summary: 'Log in as the single deployment owner',
    security: [],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', minLength: 1, maxLength: 200 } } } } } },
    responses: { '200': { description: 'Authenticated; Set-Cookie supplies anylink_session' }, '401': { description: 'Invalid owner token' } },
  },
};

const document = {
  openapi: '3.1.0',
  info: {
    title: 'AnyLink Protocol',
    version: '3.0.0',
    description: 'Harness-independent Personal Agent Network protocol. Cloud Hub provides multi-model gateway, Cloud Memory Brain (hybrid retrieval, async consolidation, automatic device-boundary learning), and real-time WebSocket task routing (/edge/v1/ws). Edge agents manage only their own local environments.',
  },
  servers: [{ url: 'http://127.0.0.1:3180', description: 'Local service or HTTPS reverse proxy' }],
  paths,
  components: {
    securitySchemes: {
      deviceBearer: { type: 'http', scheme: 'bearer', description: 'Revocable agent credential issued by POST /edge/v1/connect or owner console' },
      joinKey: { type: 'http', scheme: 'bearer', description: 'Owner join key from server secrets' },
      ownerSession: { type: 'apiKey', in: 'cookie', name: 'anylink_session', description: 'Session cookie from POST /v1/auth/login' },
    },
    schemas: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => {
      const { $schema: _, ...value } = z.toJSONSchema(schema);
      return [name, value];
    })),
  },
};

const output = JSON.stringify(document, null, 2) + '\n', file = 'protocol/openapi.json';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(file, 'utf8') !== output) throw new Error('Run npm run protocol:generate and commit the updated contract');
} else {
  fs.writeFileSync(file, output);
}
console.log(process.argv.includes('--check') ? 'Protocol matches the server schemas' : 'Generated protocol/openapi.json');
