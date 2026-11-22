import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {MobileAgent} from '../core/agent.mjs';
import {Journal} from '../core/journal.mjs';
import {AgentFailure, SSEParser, validateConnection} from '../core/protocol.mjs';
import {createTransport} from '../runtime/transport.mjs';

// Only this probe's tagged facts may be changed. Ordinary owner memories are
// read for normal context but never printed or written into the public report.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const connection = validateConnection(JSON.parse(fs.readFileSync(path.join(root, 'secrets/android-preview-connection.json'))));
const transport = createTransport(connection), probeId = randomUUID(), marker = 'ANYLINK_ANDROID_PROBE_' + probeId;
const title = marker + '_global', original = marker + '：验收用的全局口令是海风青柠。', revised = marker + '：验收用的全局口令已更正为月光蓝莓。';
const startedAt = Date.now(), tracked = new Map(), checks = {}, runs = [], metrics = {model_requests: 0, text_events: 0, first_text_ms: null};
let failure;
const persistState = (extra = {}) => fs.writeFileSync(path.join(root, 'artifacts/android-memory-probe-state.json'), JSON.stringify({probe_id: probeId, device_id: connection.device_id, marker, memories: [...tracked.values()].map(m => ({id: m.id, revision: m.revision, scope: m.scope})), checked_at: new Date().toISOString(), ...extra}, null, 2) + '\n', {mode: 0o600});
fs.mkdirSync(path.join(root, 'artifacts'), {recursive: true});
const owns = m => m.source_device_id === connection.device_id && (m.title?.includes(marker) || m.content?.includes(marker));
const request = async (route, options = {}) => {
  if (/^\/(edge|model)\//.test(route) && !route.startsWith('/model/') && ['POST', 'PATCH', 'DELETE'].includes(options.method) && !route.endsWith('/search')) {
    if (route === '/edge/v1/memories') {
      if (!options.body?.title?.includes(marker) || !options.body?.content?.includes(marker)) throw new AgentFailure('TEST_SCOPE_REJECTED', '验收仅允许创建本次标记的测试记忆');
    } else {
      const id = route.split('/').at(-1);
      if (!tracked.has(id) || (options.method === 'PATCH' && !options.body?.content?.includes(marker))) throw new AgentFailure('TEST_SCOPE_REJECTED', '验收禁止修改非测试记忆');
    }
  }
  if (route === '/model/v1/chat/completions') {
    metrics.model_requests++;
    const receive = options.onText, parser = new SSEParser(data => {
      if (data === '[DONE]') return;
      const delta = JSON.parse(data).choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) { metrics.text_events++; metrics.first_text_ms ??= Date.now() - startedAt; }
    });
    options = {...options, onText: text => { parser.feed(text); receive(text); }};
  }
  const value = await transport(route, options);
  if (route === '/edge/v1/memories' && options.method === 'POST') { assert.ok(owns(value)); tracked.set(value.id, value); persistState(); }
  if (options.method === 'PATCH' && tracked.has(value?.id)) { assert.ok(owns(value)); tracked.set(value.id, value); persistState(); }
  return value;
};
function freshAgent() {
  const journal = new Journal({read: () => null, write: () => {}}, randomUUID);
  return {journal, agent: new MobileAgent({request, connection, journal, device: {status: async () => ({environment: 'node_acceptance_preview', real_android: false}), saveNote: async () => { throw new Error('Not used by memory probe'); }, listNotes: async () => ({items: []})}})};
}
async function turn(prompt, requiredTool, existing) {
  const host = existing ?? freshAgent(), run = await host.agent.send(prompt);
  runs.push({state: run.state, model_calls: run.model_calls, tools: run.steps.map(s => ({name: s.name, state: s.state}))});
  assert.equal(run.state, 'completed', run.notice ?? run.code);
  if (requiredTool) assert.ok(run.steps.some(s => s.name === requiredTool && s.state === 'completed'), 'Expected memory tool did not complete');
  return {run, ...host};
}
async function search() { return (await transport('/edge/v1/memories/search', {method: 'POST', body: {q: marker}})).items.filter(owns); }
const macFile = path.join(root, 'secrets/mac-connection.json');
const mac = JSON.parse(fs.readFileSync(macFile));
// Mac credential is used only for its own read-only context, never as Android's
// model or memory write credential. This proves cross-device visibility/isolation.
const macRead = createTransport(validateConnection(mac));
const directHeaders = action => ({'Idempotency-Key': 'android-probe:' + probeId + ':' + action});
try {
  const identity = await transport('/edge/v1/identity'); assert.equal(identity.device.id, connection.device_id); assert.equal(identity.device.platform, 'android'); checks.independent_android_identity = true;
  await turn('请记住这条全局记忆，必须实际调用保存工具：标题严格使用“' + title + '”，内容严格使用“' + original + '”，scope 使用 global。只操作这一条测试事实。', 'anylink_memory_save');
  let facts = await search(); const global = facts.find(m => m.scope === 'global'); assert.ok(global); assert.equal(global.content, original); assert.equal(global.revision, 1); checks.agent_global_save = true;
  const recalled = await turn('读取当前有效全局记忆，回答标题“' + title + '”里记的验收口令。只回答口令，不保存或修改任何记忆。');
  assert.ok(recalled.run.answer.includes('海风青柠')); checks.fresh_session_recall = true;
  const macBefore = await macRead('/edge/v1/context'); assert.ok(macBefore.global.some(m => m.id === global.id && m.content === original)); checks.global_visible_to_mac = true;
  const updated = await turn('请更正这条记忆，先查询当前版本再调用更正工具：ID 为 ' + global.id + '，标题为“' + title + '”，新内容严格使用“' + revised + '”。只更正这条测试事实。', 'anylink_memory_update');
  facts = await search(); const current = facts.find(m => m.id === global.id); assert.equal(current.content, revised); assert.equal(current.revision, 2); checks.agent_revision_update = true;
  try { await request('/edge/v1/memories/' + global.id, {method: 'PATCH', headers: directHeaders('stale-revision'), body: {content: marker + '：旧版本不得写入', expected_revision: 1}}); assert.fail('Stale revision should be rejected'); }
  catch (error) { assert.equal(error.code, 'REVISION_CONFLICT'); checks.stale_revision_rejected = true; }
  const fresh = await turn('读取当前有效全局记忆，只回答“' + title + '”现在的口令。不要修改记忆。'); assert.ok(fresh.run.answer.includes('月光蓝莓')); assert.ok(!fresh.run.answer.includes('海风青柠')); checks.updated_fact_recalled = true;
  const deviceFact = await request('/edge/v1/memories', {method: 'POST', headers: directHeaders('device-fact'), body: {title: marker + '_device', content: marker + '：仅适用于 Android 预览设备的临时测试事实。', scope: 'device', applicable_device_id: connection.device_id}});
  const duplicate = await request('/edge/v1/memories', {method: 'POST', headers: directHeaders('device-fact'), body: {title: marker + '_device', content: marker + '：仅适用于 Android 预览设备的临时测试事实。', scope: 'device', applicable_device_id: connection.device_id}});
  assert.equal(duplicate.id, deviceFact.id); assert.equal((await search()).filter(m => m.id === deviceFact.id).length, 1); checks.idempotent_memory_write = true;
  const androidContext = await transport('/edge/v1/context'), macContext = await macRead('/edge/v1/context');
  assert.ok(androidContext.device.some(m => m.id === deviceFact.id)); assert.ok(!macContext.device.some(m => m.id === deviceFact.id)); assert.ok(macContext.global.some(m => m.id === global.id && m.content === revised)); checks.device_fact_isolated = true;
  await turn('请遗忘这条全局测试记忆，先查当前版本再实际调用删除工具：ID 为 ' + global.id + '，标题为“' + title + '”。只删除这一条测试记忆。', 'anylink_memory_delete', updated);
  assert.ok(!(await search()).some(m => m.id === global.id)); assert.ok(!(await macRead('/edge/v1/context')).global.some(m => m.id === global.id)); checks.agent_delete_and_cross_device_invalidation = true;
  const afterDelete = await turn('查询标题“' + title + '”的当前有效记忆，调用查询工具确认是否存在。已经删除的事实不能从旧聊天恢复，查询后只说明是否仍存在。', 'anylink_memory_search');
  const found = afterDelete.run.steps.filter(s => s.name === 'anylink_memory_search').flatMap(s => s.result?.items ?? []); assert.ok(!found.some(m => m.id === global.id)); checks.deleted_fact_not_returned = true;
} catch (error) { failure = error; }
finally {
  // Read before cleaning up, including if a model call lost its response. Never
  // retry inference, and never touch a fact without the probe marker + source.
  try {
    for (const fact of await search()) {
      tracked.set(fact.id, fact); persistState();
      await transport('/edge/v1/memories/' + fact.id, {method: 'DELETE', headers: {...directHeaders('cleanup:' + fact.id), 'If-Match': String(fact.revision)}});
    }
    assert.equal((await search()).length, 0); checks.test_facts_cleaned = true;
  } catch { checks.test_facts_cleaned = false; failure ??= new Error('Test fact cleanup not confirmed; inspect probe state before retrying'); }
  const report = {passed: !failure, checked_at: new Date().toISOString(), probe_id: probeId, preview_only: true, android_hardware_tested: false, model: 'deepseek-flash', duration_ms: Date.now() - startedAt, metrics, checks, runs, ...(failure ? {failure_code: failure.code ?? 'ASSERTION_OR_PROBE_FAILURE', failure: failure instanceof AgentFailure ? failure.message : 'Probe assertion failed; inspect tagged test state.'} : {})};
  persistState({cleanup_confirmed: checks.test_facts_cleaned === true, finished_at: report.checked_at});
  fs.writeFileSync(path.join(root, 'artifacts/android-memory-acceptance.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600}); console.log(JSON.stringify(report));
}
if (failure) process.exitCode = 1;
