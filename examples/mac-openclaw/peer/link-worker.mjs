import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AnyLinkClient } from '../../../sdk/src/client.mjs';
import { AnyLinkWorker, TaskDeclined, TaskFailure } from '../../../sdk/src/worker.mjs';
import { searchFiles, PeerFailure } from './search.mjs';
import { createAgentAskHandler } from './agent-ask.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const STALE_FULL_ACCESS_BOUNDARY = /OUTSIDE_ROOT|开放目录内|不在.*开放目录|主目录根层|仅限.*开放目录|无法.*主目录|不能.*\/Users\/|MAC_CONTROL_HANDSHAKE_FAILED|控制主机握手暂未完成/i;
const FULL_ACCESS_FACT_TITLE = 'Mac 跨设备全权限模式已开启';

/** When Mac has full_access enabled, automatically delete stale OUTSIDE_ROOT / sandbox boundary memories
 * learned before full access was granted, and record an accurate device capability fact once. */
export async function healStaleBoundaries(client, policy) {
  if (!policy || policy.full_access !== true) return { healed: 0, recorded: false };
  let healed = 0;
  try {
    const { items = [] } = await client.searchMemories({ kind: 'boundary', limit: 50 });
    for (const mem of items) {
      const text = `${mem.title ?? ''}\n${mem.content ?? ''}`;
      if (STALE_FULL_ACCESS_BOUNDARY.test(text)) {
        try {
          await client.deleteMemory(mem.id, mem.revision);
          healed++;
        } catch {}
      }
    }
  } catch {}
  let recorded = false;
  try {
    const { items = [] } = await client.searchMemories({ scope: 'device', q: FULL_ACCESS_FACT_TITLE, limit: 10 });
    const exists = items.some(m => m.title === FULL_ACCESS_FACT_TITLE);
    if (!exists) {
      const homeRoot = (policy.roots ?? []).find(r => r.id === 'home')?.path ?? '用户主目录';
      await client.saveMemory({
        title: FULL_ACCESS_FACT_TITLE,
        content: `该 Mac 已由主人开启全权限模式（full_access=true），跨设备任务可直接读写、移动和创建 ${homeRoot} 主目录及本机任意授权路径下的文件，并可执行本机命令与打开应用。`,
        scope: 'device',
        kind: 'fact',
        tags: ['mac', 'full_access', 'capabilities'],
        importance: 0.9,
      });
      recorded = true;
    }
  } catch {}
  return { healed, recorded };
}

const filesSearch = async (input, { signal }, policy) => {
  try { return await searchFiles(input, policy(), { signal }); }
  catch (e) { if (e instanceof PeerFailure) throw new TaskFailure(e.code, e.message); throw e; }
};

export function createMacLinkWorker({ connection, policyFile, journalPath }) {
  const policy = () => {
    const value = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    if (value.device_id !== connection.device_id || !Array.isArray(value.roots) || !value.roots.length) {
      throw new Error('Local Mac search policy is unavailable for this identity');
    }
    return value;
  };
  policy();
  return new AnyLinkWorker({
    client: new AnyLinkClient({ baseUrl: connection.server, token: connection.worker?.token ?? connection.token, timeoutMs: 20000 }),
    journalPath,
    handlers: { 'files.search': { description: 'Read-only filename search in Mac roots (including home when enabled)', execute: (input, context) => filesSearch(input, context, policy) } },
  });
}

const sanitizeDeliverName = raw => (path.basename(String(raw ?? 'attachment.bin').replaceAll('\\', '/')).replace(/[\x00-\x1f"<>|:*?]/g, '_').trim() || 'attachment.bin').slice(0, 200);

function uniqueFileInDir(dir, rawName) {
  const clean = sanitizeDeliverName(rawName);
  const ext = path.extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  let target = path.join(dir, clean);
  let idx = 2;
  while (fs.existsSync(target) && idx < 1000) {
    target = path.join(dir, `${stem} (${idx++})${ext}`);
  }
  return target;
}

const DEFAULT_MAC_MAX_RECEIVE_BYTES = 500 * 1024 * 1024;
const MAC_STORAGE_HEADROOM_BYTES = 100 * 1024 * 1024;
const formatMacBytes = b => b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GiB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MiB` : `${(b / 1024).toFixed(1)} KiB`;

function macAvailableBytes(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export function buildMacFilePolicy(policy, defaultDir = path.join(os.homedir(), 'Downloads', 'AnyLink')) {
  const custom = policy?.file_policy && typeof policy.file_policy === 'object' ? policy.file_policy : {};
  const accepts = custom.accepts_files !== false;
  const maxBytes = typeof custom.max_file_bytes === 'number' && custom.max_file_bytes >= 0 ? custom.max_file_bytes : DEFAULT_MAC_MAX_RECEIVE_BYTES;
  const avail = macAvailableBytes(defaultDir);
  return {
    accepts_files: accepts,
    max_file_bytes: maxBytes,
    ...(typeof custom.confirm_over_bytes === 'number' && custom.confirm_over_bytes >= 0 ? { confirm_over_bytes: custom.confirm_over_bytes } : {}),
    ...(avail !== null ? { available_bytes: Math.max(0, Math.floor(avail - MAC_STORAGE_HEADROOM_BYTES)) } : {}),
  };
}

/** Handles incoming cross-device `file.deliver` tasks on Mac: validates receiver file_policy & disk space,
 * streams artifact directly to disk, verifies SHA-256, and saves cleanly to ~/Downloads/AnyLink with O(1) RAM. */
export function createFileDeliverHandler({ client, defaultDir = path.join(os.homedir(), 'Downloads', 'AnyLink'), policy } = {}) {
  return {
    description: 'Receive a file uploaded via /edge/v1/artifacts (streaming) and save it to Mac ~/Downloads/AnyLink',
    async execute(input, { signal } = {}) {
      const artifactId = String(input?.artifact_id ?? '').trim();
      if (!artifactId) throw new TaskFailure('BAD_TOOL_INPUT', 'file.deliver 需要 artifact_id');
      const curPolicy = typeof policy === 'function' ? policy() : policy;
      const fp = buildMacFilePolicy(curPolicy, defaultDir);
      if (!fp.accepts_files) {
        throw new TaskDeclined('TARGET_FILE_RECEIVE_DISABLED', 'Mac 端当前已关闭接收文件功能', { learnBoundary: false });
      }
      let targetDir = defaultDir;
      if (typeof input?.destination_dir === 'string' && input.destination_dir.trim()) {
        const rawDir = input.destination_dir.trim();
        const expanded = rawDir === '~' ? os.homedir() : rawDir.startsWith('~/') ? path.join(os.homedir(), rawDir.slice(2)) : path.resolve(rawDir);
        const allowed = curPolicy?.full_access === true || (curPolicy?.roots ?? []).some(r => expanded === r.path || expanded.startsWith(r.path + path.sep));
        if (allowed) targetDir = expanded;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      const meta = (input?.size_bytes === undefined || !input?.filename) && typeof client.artifactMeta === 'function'
        ? await client.artifactMeta(artifactId, { signal }).catch(() => null)
        : null;
      const expectedSize = typeof input?.size_bytes === 'number' ? input.size_bytes : (typeof meta?.size_bytes === 'number' ? meta.size_bytes : null);
      if (expectedSize !== null && fp.max_file_bytes !== undefined && expectedSize > fp.max_file_bytes) {
        throw new TaskDeclined('TARGET_FILE_TOO_LARGE', `文件大小 ${formatMacBytes(expectedSize)} 超过 Mac 端单文件接收上限 ${formatMacBytes(fp.max_file_bytes)}`, { learnBoundary: false });
      }
      const avail = macAvailableBytes(targetDir);
      if (expectedSize !== null && avail !== null && expectedSize + MAC_STORAGE_HEADROOM_BYTES > avail) {
        throw new TaskFailure('INSUFFICIENT_STORAGE', `Mac 磁盘剩余空间不足（剩余 ${formatMacBytes(avail)}，文件 ${formatMacBytes(expectedSize)}）`);
      }
      if (typeof client.downloadArtifactToFile === 'function') {
        const metaName = input?.filename || meta?.filename || 'attachment.bin';
        const finalPath = uniqueFileInDir(targetDir, metaName);
        const dl = await client.downloadArtifactToFile(artifactId, finalPath, { expectedSha256: input?.sha256, signal });
        const finalName = path.basename(dl.path);
        return {
          saved_path: dl.path,
          filename: finalName,
          content_type: input?.content_type || dl.contentType,
          size_bytes: dl.sizeBytes,
          sha256: dl.sha256,
          reply: `已收到并保存文件《${finalName}》到 ${dl.path}`,
        };
      }
      const downloaded = await client.downloadArtifact(artifactId, { signal });
      const actualSha = createHash('sha256').update(downloaded.data).digest('hex');
      const expectedSha = input?.sha256 || downloaded.sha256;
      if (expectedSha && expectedSha !== actualSha) {
        throw new TaskFailure('SHA256_MISMATCH', '文件下载校验和不一致，已拒绝保存');
      }
      const finalPath = uniqueFileInDir(targetDir, input?.filename || downloaded.filename);
      fs.writeFileSync(finalPath, downloaded.data, { mode: 0o644 });
      const finalName = path.basename(finalPath);
      return {
        saved_path: finalPath,
        filename: finalName,
        content_type: input?.content_type || downloaded.contentType,
        size_bytes: downloaded.data.length,
        sha256: actualSha,
        reply: `已收到并保存文件《${finalName}》到 ${finalPath}`,
      };
    },
  };
}

// Protocol v3.2: mac-openclaw handles `agent.invoke`, legacy `agent.ask`, AND `file.deliver` over WebSocket, advertising file_policy!
export function createMacAskWorker({ connection, journalPath, gatewayToken, gatewayUrl, fetchImpl, policyFile }) {
  const client = new AnyLinkClient({ baseUrl: connection.server, token: connection.token, timeoutMs: 30000 });
  const handler = createAgentAskHandler({ client, gatewayToken, gatewayUrl, fetchImpl });
  const readPolicy = () => {
    try { return policyFile ? JSON.parse(fs.readFileSync(policyFile, 'utf8')) : null; } catch { return null; }
  };
  const fileDeliver = createFileDeliverHandler({ client, policy: readPolicy });
  return new AnyLinkWorker({
    client,
    journalPath,
    handlers: { 'agent.ask': handler, 'file.deliver': fileDeliver },
    filePolicy: () => buildMacFilePolicy(readPolicy()),
    onInvoke: (task, ctx) => handler.execute(task.input, { ...ctx, task }),
  });
}

async function loop(worker, abort, maxConcurrency = 2, onConnected = null) {
  let connectedOnce = false;
  while (!abort.signal.aborted) {
    try {
      await worker.recoverResults();
      if (!connectedOnce) {
        connectedOnce = true;
        process.stdout.write('{"event":"link_worker_connected"}\n');
        if (onConnected) void onConnected().catch(() => {});
      }
      await worker.run({ signal: abort.signal, pollIntervalMs: 3000, useWebSocket: true, maxConcurrency });
    } catch {
      if (!abort.signal.aborted) process.stdout.write('{"event":"link_worker_connection_unavailable_no_execution_replay"}\n');
    }
    try { await delay(5000, undefined, { signal: abort.signal }); } catch {}
  }
}

async function main() {
  const connection = JSON.parse(fs.readFileSync(path.join(root, 'secrets/mac-connection.json'), 'utf8'));
  const policyFile = path.join(root, 'secrets/mac-peer-policy.json');
  if (!fs.existsSync(policyFile)) { process.stdout.write('{"event":"link_worker_needs_local_search_policy"}\n'); return; }
  const directory = path.join(root, 'data/mac/link');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const agentId = connection.worker?.agent_id;
  const journal = agentId ? `executions-${agentId}.jsonl` : 'executions.jsonl';
  const workers = [createMacLinkWorker({ connection, policyFile, journalPath: path.join(directory, journal) })];
  if (connection.agent_id && connection.worker) {
    const gatewayToken = fs.readFileSync(path.join(root, 'secrets/mac-gateway-token'), 'utf8').trim();
    workers.push(createMacAskWorker({ connection, journalPath: path.join(directory, `executions-${connection.agent_id}.jsonl`), gatewayToken, policyFile }));
  }

  // Automatically clear stale sandbox OUTSIDE_ROOT boundary memories once cloud connection is ready.
  const runBoundaryHeal = async () => {
    const currentPolicy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    if (currentPolicy?.full_access !== true) return;
    const healClient = new AnyLinkClient({ baseUrl: connection.server, token: connection.token, timeoutMs: 15000 });
    const res = await healStaleBoundaries(healClient, currentPolicy);
    if (res.healed > 0 || res.recorded) process.stdout.write(JSON.stringify({ event: 'mac_full_access_boundaries_healed', ...res }) + '\n');
  };

  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try { await Promise.all(workers.map((w, idx) => loop(w, abort, 2, idx === 0 ? runBoundaryHeal : null).finally(() => w.close()))); }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
