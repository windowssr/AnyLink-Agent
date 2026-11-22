import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../core/journal.mjs';
import {MobileAgent} from '../core/agent.mjs';
import {AgentFailure, SSEParser, memoryIntent, validateConnection, wireMessages} from '../core/protocol.mjs';

function fixture(request) {
  let state, n = 0, writes = 0;
  const storage = {read: () => state && structuredClone(state), write: value => { state = structuredClone(value); }};
  const journal = new Journal(storage, () => 'id-' + (++n));
  const device = {status: async () => ({environment: 'test', battery: 80}), saveNote: async p => { writes++; return {id: 'note-1', ...p}; }, listNotes: async () => ({items: []})};
  const connection = {device_id: '11111111-1111-4111-8111-111111111111'};
  const agent = new MobileAgent({request: async (path, options) => path === '/edge/v1/context' ? {device_id: connection.device_id, global: [], device: []} : request(path, options), connection, device, journal});
  return {agent, journal, storage, device, get writes() { return writes; }};
}
function reply(options, {text, calls, finish = calls ? 'tool_calls' : 'stop', done = true}) {
  const delta = {...(text ? {content: text} : {}), ...(calls ? {tool_calls: calls.map((c, index) => ({index, id: c.id, function: {name: c.name, arguments: JSON.stringify(c.args)}}))} : {})};
  const raw = 'data: ' + JSON.stringify({choices: [{delta, finish_reason: null}]}) + '\r\n\r\n' + 'data: ' + JSON.stringify({choices: [{delta: {}, finish_reason: finish}]}) + '\n\n' + (done ? 'data: [DONE]\n\n' : '');
  for (let i = 0; i < raw.length; i += 7) options.onText(raw.slice(i, i + 7));
  return {};
}

test('SSE fragmentation, CRLF, comments and multiline data', () => {
  const values = [], parser = new SSEParser(data => values.push(data));
  for (const chunk of [': ping\r\n\r\ndata: 你', '好\r', '\ndata: 世界\r\n', '\r\ndata: [DONE]\n\n']) parser.feed(chunk);
  assert.deepEqual(values, ['你好\n世界', '[DONE]']);
});
test('only HTTPS or a developer loopback may receive a device credential', () => {
  const good = {server: 'https://agent.example.com', device_id: '11111111-1111-4111-8111-111111111111', token: 'ak_' + 'a'.repeat(43)};
  assert.equal(validateConnection(good).server, good.server);
  for (const server of ['http://public.example.com', 'https://good.com@evil.com', 'https://good.com/path', 'https://good.com?token=x', 'http://127.0.0.1:99999']) assert.throws(() => validateConnection({...good, server}));
});
test('Pi owns the tool loop, persists a local receipt, then returns the result to the same transcript', async () => {
  let calls = 0;
  const f = fixture(async (path, options) => {
    assert.equal(path, '/model/v1/chat/completions'); calls++;
    assert.ok(options.body.messages[0].content.includes('大肥鱼')); assert.ok(options.body.tools.some(t => t.function.name === 'anylink_note_save'));
    if (calls === 1) return reply(options, {calls: [{id: 'call-a', name: 'anylink_note_save', args: {title: '试用', content: '手机本地保存'}}]});
    assert.equal(options.body.messages.at(-1).role, 'tool'); assert.equal(options.body.messages.at(-1).tool_call_id, 'call-a');
    return reply(options, {text: '已写入这台设备的便笺。'});
  });
  const run = await f.agent.send('帮我保存一条手机便笺');
  assert.equal(run.state, 'completed'); assert.equal(calls, 2); assert.equal(f.writes, 1); assert.equal(run.steps[0].state, 'completed'); assert.equal(run.answer, '已写入这台设备的便笺。');
  assert.equal(Object.values(f.journal.value.tools)[0].state, 'completed');
});
test('a model cannot write cloud memory without an explicit current user request', async () => {
  let calls = 0, cloudWrites = 0;
  const f = fixture(async (path, options) => {
    if (path !== '/model/v1/chat/completions') { cloudWrites++; return {}; }
    calls++; if (calls === 1) return reply(options, {calls: [{id: 'call-m', name: 'anylink_memory_save', args: {title: '偏好', content: '伪造事实', scope: 'global'}}]});
    assert.match(options.body.messages.at(-1).content, /没有要求/); return reply(options, {text: '没有修改记忆。'});
  });
  const run = await f.agent.send('你好'); assert.equal(run.state, 'completed'); assert.equal(cloudWrites, 0); assert.equal(run.steps[0].state, 'failed');
});
test('an explicit memory save sends current device scope and an idempotency key', async () => {
  let calls = 0, write;
  const f = fixture(async (path, options) => {
    if (path === '/edge/v1/memories') { write = options; return {id: 'memory', revision: 1}; }
    calls++; return calls === 1 ? reply(options, {calls: [{id: 'call-memory', name: 'anylink_memory_save', args: {title: '设备', content: '测试事实', scope: 'device'}}]}) : reply(options, {text: '已保存。'});
  });
  const run = await f.agent.send('记住这台手机的测试事实'); assert.equal(run.state, 'completed'); assert.equal(write.body.applicable_device_id, '11111111-1111-4111-8111-111111111111'); assert.ok(write.headers['Idempotency-Key']);
});
test('truncated model stream never executes proposed tools or retries the model', async () => {
  let calls = 0; const f = fixture(async (_path, options) => { calls++; return reply(options, {calls: [{id: 'call-a', name: 'anylink_note_save', args: {title: '不应保存', content: '不应执行'}}], done: false}); });
  const run = await f.agent.send('写便笺'); assert.equal(run.state, 'submission_unknown'); assert.equal(calls, 1); assert.equal(f.writes, 0); assert.equal(f.journal.value.messages.length, 0);
});
test('cancel a pending model request, without resubmission or local side effects', async () => {
  let entered; const pending = new Promise(resolve => { entered = resolve; }); let calls = 0;
  const f = fixture(async (_path, options) => { calls++; entered(); await new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(new AgentFailure('CANCELLED', '已停止', true))); }); });
  const result = f.agent.send('先想一想'); await pending; f.agent.stop(); const run = await result;
  assert.equal(run.state, 'submission_unknown'); assert.equal(calls, 1); assert.equal(f.writes, 0); assert.equal(f.agent.busy, false);
});
test('reboot marks submitted work unknown; duplicate tool IDs return receipts and never repeat effects', async () => {
  const f = fixture(async () => {}), run = f.journal.begin('test'); let count = 0;
  const execute = async () => { count++; return {ok: true}; };
  assert.deepEqual(await f.journal.tool(run, 't', 'note', {x: 1}, execute), {ok: true});
  assert.deepEqual(await f.journal.tool(run, 't', 'note', {x: 1}, execute), {ok: true}); assert.equal(count, 1);
  const recovered = new Journal(f.storage, () => 'never-run'); assert.equal(recovered.value.runs[0].state, 'submission_unknown'); assert.equal(count, 1);
  await assert.rejects(f.journal.tool(run, 't', 'note', {x: 2}, execute), /冲突/);
});
test('wire transcript preserves function call IDs and tool replies', () => {
  const wire = wireMessages({messages: [{role: 'system', content: '系统'}, {role: 'assistant', content: [{type: 'toolCall', id: 'x', name: 'status', arguments: {}}]}, {role: 'toolResult', toolCallId: 'x', content: [{type: 'text', text: 'ok'}]}]});
  assert.equal(wire[0].content, '系统'); assert.equal(wire[1].tool_calls[0].id, 'x'); assert.equal(wire[2].tool_call_id, 'x');
});
test('negative memory instruction does not grant a write', () => {
  assert.equal(memoryIntent('不要记住这句话'), false); assert.equal(memoryIntent('不保存记忆，只搜索文件'), false); assert.equal(memoryIntent('记住我喜欢蓝色'), true);
});
test('a tool loop is bounded and leaves a clear continuation boundary', async () => {
  let calls = 0; const f = fixture(async (_path, options) => { calls++; return reply(options, {calls: [{id: 'call-' + calls, name: 'anylink_device_status', args: {}}]}); });
  const run = await f.agent.send('连续看看状态'); assert.equal(calls, 6); assert.equal(run.state, 'waiting_user'); assert.equal(run.steps.length, 6); assert.ok(run.notice);
});
test('an uncertain write terminates the loop before the model can request another execution', async () => {
  let modelCalls = 0, writes = 0;
  const f = fixture(async (path, options) => {
    if (path === '/edge/v1/memories') { writes++; throw new AgentFailure('TRANSPORT_UNKNOWN', '结果未确认', true); }
    modelCalls++; return reply(options, {calls: [{id: 'call-unknown', name: 'anylink_memory_save', args: {title: '偏好', content: '试验', scope: 'global'}}]});
  });
  const run = await f.agent.send('记住这个试验'); assert.equal(run.state, 'submission_unknown'); assert.equal(modelCalls, 1); assert.equal(writes, 1);
});
