import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {searchFiles, searchInput} from './search.mjs';
async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'anylink-peer-test-'));
  t.after(() => fs.rm(folder, {recursive: true, force: true}));
  const root = path.join(folder, 'allowed'), outside = path.join(folder, 'outside'); await fs.mkdir(root); await fs.mkdir(outside);
  return {root, outside, policy: {roots: [{id: 'documents', label: '文稿', path: root}]}};
}
test('literal Unicode filename search returns evidence but never file contents', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'ＡＢＣ报告.md'), 'PRIVATE_FILE_CONTENT_MUST_NOT_BE_RETURNED');
  const value = await searchFiles({query: 'abc 报告', scope: 'documents'}, f.policy);
  assert.equal(value.matches.length, 1); assert.equal(value.matches[0].name, 'ＡＢＣ报告.md'); assert.equal(value.read_only, true); assert.equal(value.name_only, true); assert.ok(!JSON.stringify(value).includes('PRIVATE_FILE_CONTENT')); assert.equal(value.partial, false);
});
test('symlinks, hidden files and credential directories never enter peer results', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.outside, 'report-private.md'), 'outside'); await fs.symlink(f.outside, path.join(f.root, 'linked')); await fs.symlink(path.join(f.outside, 'report-private.md'), path.join(f.root, 'report-link.md'));
  await fs.mkdir(path.join(f.root, 'secrets')); await fs.writeFile(path.join(f.root, 'secrets/report-key.txt'), 'credential'); await fs.writeFile(path.join(f.root, '.report-hidden'), 'hidden');
  assert.equal((await searchFiles({query: 'report'}, f.policy)).matches.length, 0);
});
test('traversal, path overrides, extra operations and unknown scopes are rejected', async t => {
  const f = await fixture(t);
  for (const input of [{query: '../'}, {query: '/etc/passwd'}, {query: 'x', root: '/'}, {query: 'x', action: 'write'}, {query: 'x', limit: 1000}]) assert.throws(() => searchInput(input));
  await assert.rejects(searchFiles({query: 'x', scope: 'downloads'}, f.policy), e => e.code === 'SEARCH_SCOPE_DENIED');
});
test('a bounded result is explicitly partial, and cancellation stops the search', async t => {
  const f = await fixture(t); for (let i = 0; i < 4; i++) await fs.writeFile(path.join(f.root, 'report-' + i), 'x');
  const value = await searchFiles({query: 'report', limit: 2}, f.policy); assert.equal(value.matches.length, 2); assert.equal(value.partial, true); assert.equal(value.partial_reason, 'result_limit');
  const controller = new AbortController(); controller.abort(); await assert.rejects(searchFiles({query: 'report'}, f.policy, {signal: controller.signal}), e => e.code === 'SEARCH_CANCELLED');
});
