import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installRemoteAgent, REMOTE_TOOLS} from './configure-remote.mjs';

test('installRemoteAgent writes the remote agent, persona and peer plugin without touching other agents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anylink-remote-'));
  const configFile = path.join(dir, 'openclaw.json'), folder = path.join(dir, 'data/mac/remote');
  const config = {gateway: {port: 18791, bind: 'loopback'}, plugins: {allow: [], load: {paths: []}, entries: {}}, agents: {entries: {main: {name: 'main'}, companion: {name: 'companion', tools: {allow: ['x']}}}}};
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.mkdirSync(path.join(dir, 'persona'), {recursive: true}); fs.mkdirSync(path.join(dir, 'mac'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'persona/dafeiyu.md'), 'BASE PERSONA'); fs.writeFileSync(path.join(dir, 'mac/persona-remote.md'), 'REMOTE APPENDIX');
  const result = installRemoteAgent({configFile, folder, root: dir, baseFile: path.join(dir, 'persona/dafeiyu.md'), appendixFile: path.join(dir, 'mac/persona-remote.md')});
  const after = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(after.agents.entries.remote.name, '大肥鱼 · 跨设备任务');
  assert.deepEqual(after.agents.entries.remote.tools.allow, REMOTE_TOOLS);
  assert.ok(after.agents.entries.remote.tools.allow.includes('anylink_files_trash'));
  assert.equal(after.agents.entries.main.name, 'main'); assert.equal(after.agents.entries.companion.name, 'companion');
  assert.ok(after.plugins.allow.includes('anylink-peer-search'));
  assert.ok(after.plugins.load.paths.some(p => p.endsWith('mac/peer')));
  assert.equal(after.plugins.entries['anylink-peer-search'].enabled, true);
  const soul = fs.readFileSync(path.join(folder, 'workspace', 'SOUL.md'), 'utf8');
  assert.ok(soul.includes('BASE PERSONA') && soul.includes('REMOTE APPENDIX'));
  assert.equal(fs.statSync(path.join(folder, 'workspace', 'SOUL.md')).mode & 0o777, 0o600);
  assert.ok(fs.readdirSync(dir).some(f => f.includes('before-remote-')), 'timestamped backup written');
  // Second run preserves an explicitly customized remote entry's other fields.
  after.agents.entries.remote.custom = true; fs.writeFileSync(configFile, JSON.stringify(after));
  installRemoteAgent({configFile, folder, root: dir, baseFile: path.join(dir, 'persona/dafeiyu.md'), appendixFile: path.join(dir, 'mac/persona-remote.md')});
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).agents.entries.remote.custom, true);
});

test('installRemoteAgent refuses a non-loopback profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anylink-remote-bad-'));
  const configFile = path.join(dir, 'openclaw.json');
  fs.writeFileSync(configFile, JSON.stringify({gateway: {port: 8080, bind: 'loopback'}}));
  assert.throws(() => installRemoteAgent({configFile, folder: dir, root: dir, baseFile: 'x', appendixFile: 'y'}), /Unexpected Mac profile/);
});
