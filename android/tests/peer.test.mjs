import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileAgent} from '../core/agent.mjs';
import {Journal} from '../core/journal.mjs';
import {validateConnection} from '../core/protocol.mjs';
import {createTransport} from '../runtime/transport.mjs';
import {createTools} from '../core/tools.mjs';
const connection = {server: 'http://127.0.0.1:5180', device_id: '11111111-1111-4111-8111-111111111111', token: 'ak_' + 'a'.repeat(43), mac_peer: {server: 'http://127.0.0.1:5180', device_id: '22222222-2222-4222-8222-222222222222', token: 'ap_' + 'b'.repeat(43), name: 'Mac'}};
test('connection keeps a separately scoped peer credential and rejects unsafe peer endpoints', () => {
  assert.equal(validateConnection(connection).mac_peer.token, connection.mac_peer.token);
  assert.throws(() => validateConnection({...connection, mac_peer: {...connection.mac_peer, server: 'http://public.example.com'}}));
  assert.throws(() => validateConnection({...connection, mac_peer: {...connection.mac_peer, device_id: connection.device_id}}));
});
test('transport never sends the cloud credential to Mac, or the peer credential to the model', async t => {
  const original = globalThis.fetch, seen = []; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => { seen.push({url, ...options}); return new Response('{}'); };
  const request = createTransport(connection); await request('/anylink-peer/v1/files/search', {method: 'POST', body: {query: 'x'}}); await request('/model/v1/models');
  assert.equal(seen[0].headers.Authorization, 'Bearer ' + connection.mac_peer.token); assert.equal(seen[0].headers['X-AnyLink-Peer-Device'], connection.device_id); assert.equal(seen[0].headers['X-AnyLink-Target-Device'], connection.mac_peer.device_id);
  assert.equal(seen[1].headers.Authorization, 'Bearer ' + connection.token); assert.equal(seen[1].headers['X-AnyLink-Peer-Device'], undefined);
});
test('Pi sends a structured Mac search, returns its receipt, and uses the verified path', async () => {
  let ids = 0, calls = 0, peerCalls = 0;
  const journal = new Journal({read: () => null, write: () => {}}, () => 'id-' + (++ids));
  const request = async (route, options) => {
    if (route === '/edge/v1/context') return {device_id: connection.device_id, global: [], device: []};
    if (route.startsWith('/anylink-peer')) { peerCalls++; assert.ok(options.headers['Idempotency-Key']); return {read_only: true, name_only: true, origin_device_id: connection.device_id, target_device_id: connection.mac_peer.device_id, matches: [{name: '报告.pdf', path: '/allowed/报告.pdf'}], request_id: 'mac-receipt'}; }
    calls++; const delta = calls === 1 ? {tool_calls: [{index: 0, id: 'find-1', function: {name: 'anylink_mac_search_files', arguments: JSON.stringify({query: '报告', scope: 'documents'})}}]} : {content: '找到了：/allowed/报告.pdf'};
    options.onText('data: ' + JSON.stringify({choices: [{delta, finish_reason: null}]}) + '\n\n'); options.onText('data: ' + JSON.stringify({choices: [{delta: {}, finish_reason: calls === 1 ? 'tool_calls' : 'stop'}]}) + '\n\n'); options.onText('data: [DONE]\n\n'); return {};
  };
  const agent = new MobileAgent({request, connection, journal, device: {}}), run = await agent.send('帮我在 Mac 文稿找报告');
  assert.equal(run.state, 'completed'); assert.equal(peerCalls, 1); assert.ok(run.answer.includes('/allowed/报告.pdf')); assert.equal(run.steps[0].result.request_id, 'mac-receipt');
});
test('a mismatched Mac receipt is not trusted or followed by more execution', async () => {
  let n = 0; const journal = new Journal({read: () => null, write: () => {}}, () => 'id-' + (++n)), run = journal.begin('找文件');
  const tools = createTools({request: async () => ({read_only: true, name_only: true, origin_device_id: connection.device_id, target_device_id: 'wrong-mac', matches: []}), connection, device: {}, journal, run, expression: () => {}});
  await assert.rejects(tools.find(t => t.name === 'anylink_mac_search_files').execute('one', {query: '报告'}), e => e.code === 'MAC_RESULT_UNVERIFIED'); assert.equal(run.uncertain, true);
});
