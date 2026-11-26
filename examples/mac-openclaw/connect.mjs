import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { configure, paths } from './configure.mjs';
import { AnyLinkClient } from '../../sdk/src/client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    'credential-file': { type: 'string' },
    'join-key-file': { type: 'string' },
    password: { type: 'string' },
    'ssh-host': { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
  },
});

const authCount = [values['credential-file'], values['join-key-file'], values.password].filter(Boolean).length;
if (!values.server || authCount !== 1) {
  throw new Error('Usage: node examples/mac-openclaw/connect.mjs --server URL (--password PASS | --join-key-file FILE | --credential-file FILE) [--ssh-host SSH_ALIAS] [--name NAME] [--slug SLUG]');
}
if (values['ssh-host'] && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(values['ssh-host'])) throw new Error('Use a simple SSH config alias');

let connection, existing = null;
try { existing = JSON.parse(fs.readFileSync(paths.connection, 'utf8')); } catch {}
if (values['credential-file'] && existing) throw new Error('Preserving existing Mac connection and profile; use its existing update workflow');

if (values['credential-file']) {
  const credential = JSON.parse(fs.readFileSync(values['credential-file'], 'utf8'));
  if (!/^[0-9a-f-]{36}$/i.test(credential.device_id ?? '') || typeof credential.token !== 'string' || !credential.token.startsWith('ak_')) {
    throw new Error('Expected a one-time device credential response');
  }
  const client = new AnyLinkClient({ baseUrl: values.server, token: credential.token });
  if ((await client.identity()).device.id !== credential.device_id) throw new Error('The device credential does not match the declared identity');
  connection = { server: values.server.replace(/\/$/, ''), ssh_host: values['ssh-host'] ?? null, device_id: credential.device_id, credential_id: credential.credential_id, token: credential.token };
} else {
  const joinKey = values.password ? values.password.trim() : fs.readFileSync(values['join-key-file'], 'utf8').trim();
  if (joinKey.length < 6) throw new Error('Expected a login password (>=6 chars) or owner join key');
  let installId = existing?.install_id ?? null;
  if (existing?.token && !existing.worker) {
    if (!installId) {
      installId = `mac-${randomUUID()}`;
      fs.writeFileSync(paths.connection, JSON.stringify({ ...existing, install_id: installId }, null, 2) + '\n', { mode: 0o600 });
    }
    const legacy = new AnyLinkClient({ baseUrl: values.server, token: existing.token });
    try { await legacy.adoptInstallId(installId); }
    catch (e) { if (e.code === 'INSTALL_ID_ALREADY_SET') throw new Error('The existing device already uses a different install_id; refusing to create a new device'); throw e; }
  }
  installId ??= `mac-${randomUUID()}`;
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(installId)) throw new Error('Stored install_id is not a valid connect identifier');
  const device = { name: (values.name ?? 'Mac').slice(0, 80), platform: 'macos', ...(values.slug ? { slug: values.slug } : {}) };
  const openclaw = await AnyLinkClient.connect({
    baseUrl: values.server, joinKey, installId, device,
    agent: { key: 'mac-openclaw', name: 'Mac 大肥鱼', kind: 'openclaw', summary: 'Mac 主机大肥鱼：可管理开放目录里的文件、整理文档与协助桌面事务' },
  });
  const files = await AnyLinkClient.connect({
    baseUrl: values.server, joinKey, installId, device,
    agent: { key: 'mac-files', name: 'Mac 文件搜索', kind: 'worker', summary: 'Mac 开放目录只读文件名搜索 Worker' },
  });
  for (const [joined, agentId] of [[openclaw, openclaw.agent_id], [files, files.agent_id]]) {
    const identity = await new AnyLinkClient({ baseUrl: values.server, token: joined.token }).identity();
    if (identity.device.id !== joined.device_id || identity.agent.id !== agentId) throw new Error('The joined agent identity does not match the connect response');
  }
  connection = {
    server: values.server.replace(/\/$/, ''),
    ssh_host: values['ssh-host'] ?? null,
    install_id: installId,
    device_id: openclaw.device_id,
    device_slug: openclaw.device_slug ?? null,
    agent_id: openclaw.agent_id,
    credential_id: openclaw.credential_id,
    token: openclaw.token,
    worker: { agent_id: files.agent_id, credential_id: files.credential_id, token: files.token },
  };
}

if (existing) {
  fs.writeFileSync(paths.connection, JSON.stringify(connection, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(paths.connection, 0o600);
  console.log(JSON.stringify({ configured: true, rejoined: true, device_id: connection.device_id, device_slug: connection.device_slug ?? null, profile_preserved: true }));
} else {
  configure(connection);
}

const policyFile = path.join(root, 'secrets/mac-peer-policy.json');
if (fs.existsSync(policyFile)) {
  const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  if (policy.device_id !== connection.device_id) {
    fs.writeFileSync(policyFile, JSON.stringify({ ...policy, device_id: connection.device_id }, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ event: 'peer_policy_rebound', device_id: connection.device_id }));
  }
}
