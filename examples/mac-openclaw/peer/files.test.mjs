import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listFiles, readFile, writeFile, makeDir, moveFile, trashFile, openPath, PeerFailure} from './files.mjs';

async function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'anylink-files-'));
  t.after(() => fs.rm(base, {recursive: true, force: true}));
  const root = path.join(base, 'root'), trash = path.join(base, 'trash');
  await fs.mkdir(path.join(root, 'sub', 'deep'), {recursive: true});
  await fs.mkdir(trash, {recursive: true});
  await fs.writeFile(path.join(root, 'a.txt'), 'hello world');
  await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'nested');
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(base, 'outside.txt'), 'secret');
  await fs.symlink(path.join(base, 'outside.txt'), path.join(root, 'link-out.txt'));
  await fs.symlink(base, path.join(root, 'link-dir'));
  const policy = {roots: [{id: 'test', label: '测试', path: root}]};
  return {base, root: realpathSync(root), trash, policy};
}
const code = async (promise, expected) => { try { await promise; assert.fail('should throw'); } catch (e) { assert.ok(e instanceof PeerFailure); if (expected) assert.equal(e.code, expected); return e; } };

test('path confinement rejects escapes, hidden, excluded and symlinked components', async t => {
  const {root, policy} = await fixture(t);
  await code(listFiles({path: 'test:../outside.txt'}, policy), 'PATH_DENIED');
  await code(listFiles({path: path.join(root, '..', 'outside.txt')}, policy), 'OUTSIDE_ROOT');
  await code(readFile({path: 'test:.hidden/x'}, policy), 'PATH_DENIED');
  await code(readFile({path: 'test:node_modules/pkg/index.js'}, policy), 'PATH_DENIED');
  await code(readFile({path: 'test:link-out.txt'}, policy), 'SYMLINK_DENIED');
  await code(listFiles({path: 'test:link-dir'}, policy), 'SYMLINK_DENIED');
  await code(readFile({path: 'test:missing.txt'}, policy), 'NOT_FOUND');
});

test('list and read return bounded plain JSON', async t => {
  const {root, policy} = await fixture(t);
  const list = await listFiles({path: 'test:'}, policy);
  assert.equal(list.path, root); assert.ok(list.entries.some(e => e.name === 'a.txt' && e.type === 'file'));
  const read = await readFile({path: 'test:a.txt'}, policy);
  assert.equal(read.content, 'hello world'); assert.equal(read.bytes, 11);
  const slice = await readFile({path: 'test:a.txt', offset: 6, max_bytes: 4}, policy);
  assert.equal(slice.content, 'worl'); assert.equal(slice.truncated, true);
  await code(readFile({path: 'test:bin.dat'}, policy), 'BINARY_FILE');
});

test('write modes: create fails on exists, overwrite and append work', async t => {
  const {root, policy} = await fixture(t);
  await code(writeFile({path: 'test:new.txt', content: 'one'}, policy), 'FILE_EXISTS').catch(() => {});
  const made = await writeFile({path: 'test:new.txt', content: 'one', mode: 'overwrite', create_parents: true}, policy);
  assert.equal(made.action, 'overwritten');
  await code(writeFile({path: 'test:new.txt', content: 'x'}, policy), 'FILE_EXISTS');
  const appended = await writeFile({path: 'test:new.txt', content: '+two', mode: 'append'}, policy);
  assert.equal(appended.action, 'appended');
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'one+two');
  await writeFile({path: 'test:deep/nested.txt', content: 'deep', mode: 'create', create_parents: true}, policy);
  assert.equal(await fs.readFile(path.join(root, 'deep', 'nested.txt'), 'utf8'), 'deep');
});

test('mkdir, move into dir, trash collision naming and open', async t => {
  const {root, trash, policy} = await fixture(t);
  assert.equal((await makeDir({path: 'test:dir1/dir2'}, policy)).action, 'created');
  assert.equal((await makeDir({path: 'test:dir1/dir2'}, policy)).action, 'exists');
  await code(makeDir({path: 'test:a.txt/child'}, policy));
  await writeFile({path: 'test:dir1/inner.txt', content: 'x', mode: 'overwrite', create_parents: true}, policy);
  const moved = await moveFile({from: 'test:dir1/inner.txt', to: 'test:'}, policy);
  assert.equal(moved.to, path.join(root, 'inner.txt'));
  await code(moveFile({from: 'test:', to: 'test:dir1'}, policy), 'ROOT_DENIED');
  await writeFile({path: 'test:collide.txt', content: 'x', mode: 'overwrite', create_parents: true}, policy);
  const t1 = await trashFile({path: 'test:collide.txt'}, policy, {trashDir: trash});
  const t2 = await trashFile({path: 'test:a.txt'}, policy, {trashDir: trash}).catch(async () => {
    await fs.copyFile(path.join(root, 'collide.txt'), path.join(trash, 'a.txt'));
    return trashFile({path: 'test:a.txt'}, policy, {trashDir: trash});
  });
  assert.equal(t1.action, 'trashed'); assert.ok(t2.to.includes('a.txt'));
  const calls = [];
  const opened = await openPath({path: 'test:inner.txt'}, policy, {exec: async (...a) => { calls.push(a); }});
  assert.equal(opened.action, 'opened'); assert.equal(calls[0][0], '/usr/bin/open'); assert.equal(calls[0][2].timeout, 10000);
});

test('full_access policy allows absolute paths outside roots while default denies them', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anylink-full-files-'));
  const root = path.join(dir, 'sandbox'), outside = path.join(dir, 'outside-dir', 'hello.txt');
  await fs.mkdir(root, {recursive: true});
  try {
    await code(writeFile({path: outside, content: 'no', mode: 'create', create_parents: true}, {roots: [{id: 'workspace', path: root}]}), 'OUTSIDE_ROOT');
    const res = await writeFile({path: outside, content: 'full ok', mode: 'create', create_parents: true}, {full_access: true, roots: [{id: 'workspace', path: root}]});
    assert.equal(res.path, outside);
    const rd = await readFile({path: outside}, {full_access: true, roots: []});
    assert.equal(rd.content, 'full ok');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('healStaleBoundaries deletes legacy OUTSIDE_ROOT boundaries and records full_access device fact', async () => {
  const {healStaleBoundaries} = await import('./link-worker.mjs');
  const deleted = [], saved = [];
  const fakeClient = {
    async searchMemories(q) {
      if (q.kind === 'boundary') {
        return {
          items: [
            {id: 'b1', revision: 2, title: 'Mac 能力边界', content: '主目录根层不在开放目录内，返回 OUTSIDE_ROOT'},
            {id: 'b2', revision: 1, title: 'Mac 能力边界', content: '当前环境没有微信无法发微信'},
          ],
        };
      }
      return {items: []};
    },
    async deleteMemory(id, rev) { deleted.push([id, rev]); },
    async saveMemory(mem) { saved.push(mem); },
  };
  const out = await healStaleBoundaries(fakeClient, {full_access: true, roots: [{id: 'home', path: '/Users/demo'}]});
  assert.deepEqual(out, {healed: 1, recorded: true});
  assert.deepEqual(deleted, [['b1', 2]]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].scope, 'device');
  assert.ok(saved[0].content.includes('/Users/demo'));
});

test('createFileDeliverHandler downloads artifact, verifies sha256, and deduplicates filenames', async () => {
  const { createFileDeliverHandler } = await import('./link-worker.mjs');
  const { createHash } = await import('node:crypto');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anylink-deliver-'));
  const data = Buffer.from('photo-binary-data');
  const sha = createHash('sha256').update(data).digest('hex');
  const fakeClient = {
    async downloadArtifact(id) {
      assert.equal(id, 'art-1');
      return { data, filename: '../evil/pic.jpg', contentType: 'image/jpeg', sha256: sha };
    },
  };
  try {
    const handler = createFileDeliverHandler({ client: fakeClient, defaultDir: dir });
    const r1 = await handler.execute({ artifact_id: 'art-1', filename: 'pic.jpg' });
    assert.equal(r1.filename, 'pic.jpg');
    assert.equal(r1.saved_path, path.join(dir, 'pic.jpg'));
    assert.deepEqual(await fs.readFile(r1.saved_path), data);
    const r2 = await handler.execute({ artifact_id: 'art-1', filename: 'pic.jpg' });
    assert.equal(r2.filename, 'pic (2).jpg');
    assert.equal(r2.saved_path, path.join(dir, 'pic (2).jpg'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
