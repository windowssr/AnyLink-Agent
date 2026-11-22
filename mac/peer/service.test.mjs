import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createPeerHandler, digest, prefix} from './service.mjs';
async function fixture(t, search) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'anylink-peer-http-')); t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const policyFile = path.join(folder, 'policy.json'), receiptDirectory = path.join(folder, 'receipts'), token = 'ap_' + 'a'.repeat(43);
  const policy = {device_id: 'target', name: 'Test Mac', roots: [], peers: [{device_id: 'sender', token_hash: digest(token), capabilities: ['files.search'], enabled: true}]};
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  const server = http.createServer(createPeerHandler({policyFile, receiptDirectory, search})); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const headers = {Authorization: 'Bearer ' + token, 'X-AnyLink-Peer-Device': 'sender', 'X-AnyLink-Target-Device': 'target', 'Idempotency-Key': 'one', 'Content-Type': 'application/json'};
  const request = (body = {query: 'file'}, extra = {}) => fetch('http://127.0.0.1:' + server.address().port + prefix + '/files/search', {method: 'POST', ...extra, headers: {...headers, ...extra.headers}, body: JSON.stringify(body)});
  return {request, policy, policyFile, headers, receiptDirectory, url: 'http://127.0.0.1:' + server.address().port + prefix + '/files/search'};
}
test('unpaired credentials, wrong sender/target and browser origins do not run search', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return {}; });
  for (const headers of [{Authorization: 'Bearer ak_' + 'b'.repeat(43)}, {'X-AnyLink-Peer-Device': 'other'}, {'X-AnyLink-Target-Device': 'other'}, {Origin: 'https://evil.invalid'}]) assert.ok((await f.request(undefined, {headers})).status >= 400);
  assert.equal(calls, 0);
});
test('receipts bind to device and request, dedupe search and reject changed arguments', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return {read_only: true, name_only: true, matches: []}; });
  const first = await (await f.request()).json(), again = await (await f.request()).json();
  assert.equal(first.executed_by, 'mac_openclaw_plugin'); assert.equal(first.origin_device_id, 'sender'); assert.equal(first.target_device_id, 'target'); assert.equal(first.request_id, again.request_id); assert.equal(again.replayed_receipt, true); assert.equal(calls, 1);
  assert.equal((await f.request({query: 'different'})).status, 409);
  const record = JSON.parse(fs.readFileSync(path.join(f.receiptDirectory, digest('sender:one') + '.json'))); assert.equal(record.state, 'completed');
  assert.equal(fs.statSync(path.join(f.receiptDirectory, digest('sender:one') + '.json')).mode & 0o777, 0o600);
});
test('revoking a pairing immediately denies even a previously cached result', async t => {
  const f = await fixture(t, async () => ({matches: []})); assert.equal((await f.request()).status, 200);
  f.policy.peers[0].enabled = false; fs.writeFileSync(f.policyFile, JSON.stringify(f.policy)); assert.equal((await f.request()).status, 403);
});
test('an interrupted receipt is not automatically executed again after restart', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return {}; });
  fs.writeFileSync(path.join(f.receiptDirectory, digest('sender:one') + '.json'), JSON.stringify({fingerprint: digest(JSON.stringify({query: 'file', scope: 'all', limit: 20})), state: 'submitted'}));
  const response = await f.request(); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'SEARCH_RESULT_UNKNOWN'); assert.equal(calls, 0);
});
test('only bounded search parameters are accepted; no arbitrary tool operation', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return {}; });
  for (const body of [{query: 'file', command: 'cat /etc/passwd'}, {query: 'file', scope: '/'}, {query: 'file', limit: 1000}]) assert.equal((await f.request(body)).status, 400);
  assert.equal(calls, 0);
});
test('Chinese queries survive HTTP chunks that split UTF-8 characters', async t => {
  let query; const f = await fixture(t, async input => { query = input.query; return {matches: []}; });
  const response = new Promise((resolve, reject) => {
    const req = http.request(f.url, {method: 'POST', headers: f.headers}, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject);
    (async () => { for (const byte of Buffer.from(JSON.stringify({query: '中文报告'}))) { req.write(Buffer.from([byte])); await new Promise(resolve => setImmediate(resolve)); } req.end(); })().catch(reject);
  });
  assert.equal(await response, 200); assert.equal(query, '中文报告');
});
