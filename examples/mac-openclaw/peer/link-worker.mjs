import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AnyLinkClient } from '../../../sdk/src/client.mjs';
import { AnyLinkWorker, TaskFailure } from '../../../sdk/src/worker.mjs';
import { searchFiles, PeerFailure } from './search.mjs';
import { createAgentAskHandler } from './agent-ask.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const STALE_FULL_ACCESS_BOUNDARY = /OUTSIDE_ROOT|开放目录内|不在.*开放目录|主目录根层|仅限.*开放目录|无法.*主目录|不能.*\/Users\//i;
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

// Protocol v3.2: mac-openclaw handles BOTH capability-free `agent.invoke` (via onInvoke) and legacy `agent.ask` over WebSocket!
export function createMacAskWorker({ connection, journalPath, gatewayToken, gatewayUrl, fetchImpl }) {
  const client = new AnyLinkClient({ baseUrl: connection.server, token: connection.token, timeoutMs: 20000 });
  const handler = createAgentAskHandler({ client, gatewayToken, gatewayUrl, fetchImpl });
  return new AnyLinkWorker({
    client,
    journalPath,
    handlers: { 'agent.ask': handler },
    onInvoke: (task, ctx) => handler.execute(task.input, { ...ctx, task }),
  });
}

async function loop(worker, abort, maxConcurrency = 2) {
  while (!abort.signal.aborted) {
    try {
      await worker.recoverResults();
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
    workers.push(createMacAskWorker({ connection, journalPath: path.join(directory, `executions-${connection.agent_id}.jsonl`), gatewayToken }));
  }
  // Automatically clear stale sandbox OUTSIDE_ROOT boundary memories when full_access is active.
  try {
    const currentPolicy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    if (currentPolicy?.full_access === true) {
      const healClient = new AnyLinkClient({ baseUrl: connection.server, token: connection.token, timeoutMs: 15000 });
      void healStaleBoundaries(healClient, currentPolicy).then(res => {
        if (res.healed > 0 || res.recorded) process.stdout.write(JSON.stringify({ event: 'mac_full_access_boundaries_healed', ...res }) + '\n');
      }).catch(() => {});
    }
  } catch {}

  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try { await Promise.all(workers.map(w => loop(w, abort, 2).finally(() => w.close()))); }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
