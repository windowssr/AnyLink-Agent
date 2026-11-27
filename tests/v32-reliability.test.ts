import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { AnyLinkClient, AnyLinkError } from '../sdk/src/client.mjs';
import { AnyLinkWorker } from '../sdk/src/worker.mjs';

const url = process.env.TEST_DATABASE_URL;
const joinKey = 'v32-reliability-join-key-0123456789abcdef';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: url!,
    ownerToken: 'test-owner-secret-not-production-v32',
    deepseekApiKey: '',
    deepseekBaseUrl: 'http://127.0.0.1:1/v1',
    defaultModel: 'deepseek-flash',
    memoryModel: 'deepseek-flash',
    embeddingModel: '',
    embeddingBaseUrl: 'http://127.0.0.1:1/v1',
    embeddingApiKey: '',
    models: [],
    allowAnyModel: false,
    gatewayAutoMemoryDefault: false,
    maxGlobalConcurrency: 16,
    maxAgentConcurrency: 4,
    maxAgentRpm: 120,
    trustProxy: 'loopback',
    origin: 'http://127.0.0.1:3180',
    host: '127.0.0.1',
    port: 3180,
    joinKey,
    loginPassword: 'test-easy-pass-123',
    personaFile: 'examples/persona/dafeiyu.md',
    speechPrompt: '',
    ttsVoice: '',
    ttsRate: '',
    ttsPitch: '',
    leaseReaperIntervalMs: 60000,
    memoryDebounceMs: 250,
    memoryBatchMax: 3,
    wsPingIntervalMs: 250,
    wsMaxMissedPongs: 2,
    wsMaxBufferedBytes: 1024 * 1024,
    maxQueuedPerAgent: 3,
    maxQueuedGlobal: 20,
    maxCallDepth: 2,
    artifactMaxBytes: 16 * 1024,
    artifactQuotaBytes: 32 * 1024,
    artifactDefaultTtlSeconds: 3600,
    ...overrides,
  };
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

test('Protocol v3.1 + v3.2 fault-injection: zombie WS, cursor resume, receipt ACK, fencing, retries, queues, suspend/reply, artifacts & SSE resume', { skip: !url }, async t => {
  assert.equal(new URL(url!).pathname, '/anylink_test');
  const setup = new pg.Pool({ connectionString: url });
  await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await setup.end();

  // Mock slow streaming LLM upstream for SSE detach-on-disconnect resume test.
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '第一段' }, finish_reason: null }] })}\n\n`);
      await wait(350);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '，断流后云端继续补全的内容！' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 24 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"episode_summary":"重启后已补整理","operations":[]}' } }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upPort = (upstream.address() as any).port;
  t.after(() => upstream.close());

  const cfg = makeConfig({
    deepseekApiKey: 'test-upstream-key-0123456789abcdef',
    deepseekBaseUrl: `http://127.0.0.1:${upPort}/v1`,
    models: [{
      id: 'deepseek-flash',
      upstreamModel: 'deepseek-flash',
      baseUrl: `http://127.0.0.1:${upPort}/v1`,
      apiKey: 'test-upstream-key-0123456789abcdef',
      ownedBy: 'test',
      inputModalities: ['text'],
      aliases: ['default'],
    }],
  });

  const { app, db, linkService, memoryBrain } = await createApp(cfg, { logger: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => { await app.close(); });

  const phoneCred = await AnyLinkClient.connect({
    baseUrl: address, joinKey, installId: 'v32-phone-001',
    device: { name: 'Phone', platform: 'android', slug: 'my-phone' },
    agent: { key: 'phone', name: 'Phone Agent' },
  });
  const macCred = await AnyLinkClient.connect({
    baseUrl: address, joinKey, installId: 'v32-mac-001',
    device: { name: 'Mac', platform: 'macos', slug: 'home-mac' },
    agent: { key: 'mac', name: 'Mac Agent' },
  });
  const linuxCred = await AnyLinkClient.connect({
    baseUrl: address, joinKey, installId: 'v32-linux-001',
    device: { name: 'Linux', platform: 'linux', slug: 'gpu-box' },
    agent: { key: 'linux', name: 'Linux Agent' },
  });

  const phone = new AnyLinkClient({ baseUrl: address, token: phoneCred.token });
  const mac = new AnyLinkClient({ baseUrl: address, token: macCred.token });
  const linux = new AnyLinkClient({ baseUrl: address, token: linuxCred.token });

  // 1. Half-open zombie WebSocket eviction
  const zombie = new WebSocket(`${address.replace('http', 'ws')}/edge/v1/ws`, {
    headers: { Authorization: `Bearer ${linuxCred.token}` },
    autoPong: false,
  });
  await new Promise<void>((resolve, reject) => {
    zombie.once('message', () => resolve());
    zombie.once('error', reject);
  });
  const dirOnline = await phone.directory();
  const linuxBefore = dirOnline.items.flatMap((i: any) => i.agents).find((a: any) => a.id === linuxCred.agent_id);
  assert.equal(linuxBefore.ws_online, true);
  // Wait for 2 missed ping intervals (250ms * 3 + buffer) -> server terminates zombie!
  await new Promise<void>(resolve => {
    if (zombie.readyState === WebSocket.CLOSED) return resolve();
    zombie.once('close', () => resolve());
  });
  await wait(80);
  const dirAfter = await phone.directory();
  const linuxAfter = dirAfter.items.flatMap((i: any) => i.agents).find((a: any) => a.id === linuxCred.agent_id);
  assert.equal(linuxAfter.ws_online, false);

  // 2. require_online fast-fail when target is offline
  await db.query('UPDATE agents SET last_seen_at=NULL WHERE id=$1', [linuxCred.agent_id]);
  await assert.rejects(
    () => phone.invoke({ target: { device_slug: 'gpu-box' }, instruction: 'check gpu', requireOnline: true }),
    (err: any) => err instanceof AnyLinkError && err.status === 409 && err.code === 'TARGET_OFFLINE',
  );

  // 3. Priority ordering + Concurrency Key + Queue Depth limit (429 QUEUE_FULL)
  const lowTask = await phone.invoke({ target: { agent_id: macCred.agent_id }, instruction: 'low priority', priority: 2, concurrencyKey: 'gui-lock' });
  const highTask = await phone.invoke({ target: { agent_id: macCred.agent_id }, instruction: 'high priority', priority: 9, concurrencyKey: 'gui-lock' });
  const thirdTask = await phone.invoke({ target: { agent_id: macCred.agent_id }, instruction: 'third task', priority: 5 });
  await assert.rejects(
    () => phone.invoke({ target: { agent_id: macCred.agent_id }, instruction: 'fourth overflow' }),
    (err: any) => err instanceof AnyLinkError && err.status === 429 && err.code === 'QUEUE_FULL',
  );

  // Claim #1 must pop highTask (priority 9) first!
  const claim1 = await mac.claimTask();
  assert.equal(claim1.task.id, highTask.id);
  assert.equal(claim1.task.attempt, 1);
  assert.ok(claim1.task.lease_token);

  // Claim #2 must SKIP lowTask (locked by same concurrency_key 'gui-lock') and pop thirdTask!
  const claim2 = await mac.claimTask();
  assert.equal(claim2.task.id, thirdTask.id);

  // Claim #3 returns null while 'gui-lock' is still held by highTask!
  const claim3 = await mac.claimTask();
  assert.equal(claim3.task, null);

  // Finish highTask & thirdTask; now lowTask becomes claimable!
  await mac.completeTask(highTask.id, { state: 'succeeded', output: { reply: 'high done' } }, { leaseToken: claim1.task.lease_token });
  await mac.completeTask(thirdTask.id, { state: 'succeeded', output: { reply: 'third done' } }, { leaseToken: claim2.task.lease_token });
  const claimLow = await mac.claimTask();
  assert.equal(claimLow.task.id, lowTask.id);
  await mac.completeTask(lowTask.id, { state: 'succeeded', output: { reply: 'low done' } }, { leaseToken: claimLow.task.lease_token });

  // 4. Loop detection (A -> B -> A) and maxCallDepth
  const rootTask = await phone.invoke({ target: { agent_id: macCred.agent_id }, instruction: 'step 1' });
  await assert.rejects(
    () => mac.invoke({ target: { agent_id: phoneCred.agent_id }, instruction: 'loop back', parentTaskId: rootTask.id }),
    (err: any) => err.status === 400 && err.code === 'TASK_LOOP_DETECTED',
  );
  const child1 = await mac.invoke({ target: { agent_id: linuxCred.agent_id }, instruction: 'step 2', parentTaskId: rootTask.id });
  assert.equal(child1.trace_id, rootTask.trace_id);
  assert.equal(child1.call_depth, 1);
  const child2 = await linux.invoke({ target: { agent_id: macCred.agent_id }, instruction: 'step 3', parentTaskId: child1.id, allowReentry: true });
  assert.equal(child2.call_depth, 2);
  await assert.rejects(
    () => mac.invoke({ target: { agent_id: linuxCred.agent_id }, instruction: 'too deep', parentTaskId: child2.id, allowReentry: true }),
    (err: any) => err.status === 400 && err.code === 'TASK_MAX_DEPTH_EXCEEDED',
  );
  // Cancel leftover queued test tasks so queue stays clean.
  for (const [c, tid] of [[phone, rootTask.id], [mac, child1.id], [linux, child2.id]] as const) {
    await (c as AnyLinkClient).cancelTask(tid);
  }

  // 5. Idempotent automatic retry + Fencing Token (409 LEASE_FENCED) + Queued TTL expiry active push
  const retryable = await phone.invoke({
    target: { agent_id: macCred.agent_id },
    instruction: 'idempotent fetch',
    idempotent: true,
    maxRetries: 2,
    leaseSeconds: 10,
  });
  const firstClaim = await mac.claimTask({ taskId: retryable.id });
  const staleToken = firstClaim.task.lease_token;
  assert.equal(firstClaim.task.attempt, 1);
  // Expire attempt 1's lease directly in DB and run reaper -> must requeue cleanly!
  await db.query("UPDATE link_tasks SET lease_expires_at=now()-interval '5 seconds' WHERE id=$1", [retryable.id]);
  await linkService.reapExpiredLeases();
  const afterRequeue = await phone.task(retryable.id);
  assert.equal(afterRequeue.state, 'queued');

  const secondClaim = await mac.claimTask({ taskId: retryable.id });
  assert.equal(secondClaim.task.attempt, 2);
  assert.notEqual(secondClaim.task.lease_token, staleToken);
  // Old worker using stale attempt-1 lease_token must be fenced with 409 LEASE_FENCED!
  await assert.rejects(
    () => mac.heartbeatTask(retryable.id, { leaseToken: staleToken }),
    (err: any) => err.status === 409 && err.code === 'LEASE_FENCED',
  );
  await assert.rejects(
    () => mac.completeTask(retryable.id, { state: 'succeeded', output: { reply: 'stale overwrite' } }, { leaseToken: staleToken }),
    (err: any) => err.status === 409 && err.code === 'LEASE_FENCED',
  );
  // Attempt-2 worker succeeds with fresh lease_token!
  await mac.completeTask(retryable.id, { state: 'succeeded', output: { reply: 'attempt 2 ok' } }, { leaseToken: secondClaim.task.lease_token });
  assert.equal((await phone.task(retryable.id)).result.output.reply, 'attempt 2 ok');

  // Queued TTL expiry pushes task.completed(state="expired") over WS!
  const phoneWs = await phone.connectWebSocket({ autoReconnect: true });
  t.after(() => phoneWs.close());
  const expiredPromise = new Promise<any>(resolve => {
    phoneWs.on('task.completed', f => { if (f.task?.state === 'expired') resolve(f.task); });
  });
  const expiringTask = await phone.invoke({ target: { agent_id: linuxCred.agent_id }, instruction: 'will expire', ttlSeconds: 10 });
  await db.query("UPDATE link_tasks SET expires_at=now()-interval '2 seconds' WHERE id=$1", [expiringTask.id]);
  await linkService.reapExpiredLeases();
  const pushedExpired = await expiredPromise;
  assert.equal(pushedExpired.id, expiringTask.id);
  assert.equal(pushedExpired.state, 'expired');
  await phoneWs.ackReceipt(expiringTask.id);

  // 6. Offline unacked receipt replay + task.receipt_ack dedup + waitForTask survives WS drop!
  // First ack all previous completed phone tasks so only the new one is unacked.
  for (const tid of [highTask.id, thirdTask.id, lowTask.id, retryable.id]) {
    await phone.ackReceipt(tid);
  }
  const offlineTask = await phone.invoke({ target: { agent_id: macCred.agent_id }, instruction: 'complete while phone offline' });
  const savedSeq = phoneWs.lastSeq;
  phoneWs.close(); // Phone goes offline!

  const offlineClaim = await mac.claimTask({ taskId: offlineTask.id });
  await mac.completeTask(offlineTask.id, { state: 'succeeded', output: { reply: 'finished while offline' } }, { leaseToken: offlineClaim.task.lease_token });

  // Phone reconnects with resumeAfterSeq -> receives missed task.completed!
  const reconnected1 = await phone.connectWebSocket({ autoReconnect: false, resumeAfterSeq: savedSeq });
  const got1 = await new Promise<any>(resolve => {
    reconnected1.on('task.completed', f => { if (f.task?.id === offlineTask.id) resolve(f); });
  });
  assert.equal(got1.task.result.output.reply, 'finished while offline');
  reconnected1.close(); // Did NOT ack!

  // Reconnect a 2nd time without resumeAfterSeq -> unacked receipt MUST replay again!
  const reconnected2 = await phone.connectWebSocket({ autoReconnect: false });
  const got2 = await new Promise<any>(resolve => {
    reconnected2.on('task.completed', f => { if (f.task?.id === offlineTask.id) resolve(f); });
  });
  assert.equal(got2.replayed_receipt, true);
  await reconnected2.ackReceipt(offlineTask.id);
  reconnected2.close();

  // Reconnect a 3rd time after ACK -> must NOT receive offlineTask again!
  const reconnected3 = await phone.connectWebSocket({ autoReconnect: false });
  let duplicateReceived = false;
  reconnected3.on('task.completed', f => { if (f.task?.id === offlineTask.id) duplicateReceived = true; });
  await wait(250);
  assert.equal(duplicateReceived, false);
  reconnected3.close();

  // 7. Protocol v3.2 Interactive awaiting_input & awaiting_approval (approve + reject)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anylink-v32-worker-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const macWorker = new AnyLinkWorker({
    client: mac,
    journalPath: path.join(tmpDir, 'mac.jsonl'),
    onInvoke: async (task, ctx) => {
      if (task.instruction === 'ask-and-run') {
        const answer = await ctx.askInput('放到哪个文件夹？', { choices: ['桌面', '主目录'], timeoutSeconds: 30 });
        return { reply: `已放到${answer.choice}` };
      }
      if (task.instruction === 'dangerous-delete') {
        const decision = await ctx.requestApproval('确认清理旧安装包？', { riskLevel: 'high', timeoutSeconds: 30 });
        return { reply: decision.approved ? '已批准清理' : '已拒绝' };
      }
      return { reply: 'ok' };
    },
  });
  const workerAbort = new AbortController();
  const workerRun = macWorker.run({ signal: workerAbort.signal, maxConcurrency: 2, pollIntervalMs: 300 });
  t.after(async () => { workerAbort.abort(); await workerRun.catch(() => {}); macWorker.close(); });

  const phoneWs2 = await phone.connectWebSocket({ autoReconnect: true });
  t.after(() => phoneWs2.close());

  const askTask = await phone.invoke({ target: { agent_id: macCred.agent_id }, instruction: 'ask-and-run' });
  const askResult = await phone.waitForTask(askTask.id, {
    socket: phoneWs2,
    timeoutMs: 15000,
    onInteraction: async suspended => {
      assert.equal(suspended.state, 'awaiting_input');
      await phone.replyTask(suspended.id, { choice: '主目录' });
    },
  });
  assert.equal(askResult.state, 'succeeded');
  assert.equal(askResult.result.output.reply, '已放到主目录');

  const approveTask = await phone.invoke({ target: { agent_id: macCred.agent_id }, instruction: 'dangerous-delete' });
  const rejectResult = await phone.waitForTask(approveTask.id, {
    socket: phoneWs2,
    timeoutMs: 15000,
    onInteraction: async suspended => {
      assert.equal(suspended.state, 'awaiting_approval');
      await phone.replyTask(suspended.id, { approved: false, message: '先别删' });
    },
  });
  assert.equal(rejectResult.state, 'declined');
  assert.equal(rejectResult.result.error.code, 'APPROVAL_DENIED');

  // 8. Binary Artifacts (/edge/v1/artifacts)
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
  const uploaded = await phone.uploadArtifact({ data: payload, filename: '截图.png', contentType: 'image/png', taskId: askTask.id, ttlSeconds: 300 });
  assert.equal(uploaded.size_bytes, payload.length);
  assert.equal(uploaded.filename, '截图.png');
  const downloaded = await mac.downloadArtifact(uploaded.id);
  assert.deepEqual(downloaded.data, payload);
  assert.equal(downloaded.sha256, uploaded.sha256);
  // Oversized artifact (> 16 KiB test cap) must be rejected 413
  await assert.rejects(
    () => phone.uploadArtifact({ data: Buffer.alloc(20 * 1024, 1), filename: 'big.bin' }),
    (err: any) => err.status === 413,
  );
  await mac.deleteArtifact(uploaded.id);

  // 9. SSE Detach-on-Disconnect Resume (GET /model/v1/requests/:id)
  let capturedReqId = '';
  const abortMidStream = new AbortController();
  await assert.rejects(async () => {
    for await (const chunk of phone.streamChatCompletions(
      { model: 'deepseek-flash', messages: [{ role: 'user', content: '测试断流续拉' }] },
      { detachOnDisconnect: true, onRequestId: id => { capturedReqId = id; }, signal: abortMidStream.signal },
    )) {
      if (chunk?.choices?.[0]?.delta?.content) abortMidStream.abort();
    }
  });
  assert.ok(capturedReqId, 'must receive X-AnyLink-Request-Id header');
  // Wait for server to finish upstream generation after client TCP dropped!
  await wait(550);
  const recovered = await phone.modelRequest(capturedReqId);
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.result.content, '第一段，断流后云端继续补全的内容！');

  // 10. Cloud Memory Brain startup pending recovery
  const epId = randomUUID();
  await db.query(
    `INSERT INTO memory_episodes(id,owner_id,source_device_id,source_agent_id,kind,messages,metadata,summary,status)
     VALUES($1,'00000000-0000-4000-8000-000000000001',$2,$3,'turn',$4,'{}','pending recovery test','pending')`,
    [epId, phoneCred.device_id, phoneCred.agent_id, JSON.stringify([{ role: 'user', content: '记住我喜欢深海蓝主题' }, { role: 'assistant', content: '好哒主人！' }])],
  );
  const count = await memoryBrain.recoverPending();
  assert.ok(count >= 1);
  await memoryBrain.drain();
  const row = (await db.query('SELECT status,summary FROM memory_episodes WHERE id=$1', [epId])).rows[0];
  assert.equal(row.status, 'consolidated');

  // 11. Protocol v3.2 File Transfer Negotiation (limits in /edge/v1/protocol + per-agent file_policy + server pre-flight)
  const proto = await phone.protocol();
  assert.ok(proto.capabilities.includes('file_policy'));
  assert.equal(proto.limits.artifact_max_bytes, 16 * 1024);
  assert.equal(proto.limits.artifact_quota_bytes, 64 * 1024);

  // Target explicitly disables file receiving -> server rejects file.deliver with 409 TARGET_FILE_RECEIVE_DISABLED
  await mac.updateProfile({ file_policy: { accepts_files: false } });
  const dirDisabled = await phone.directory();
  const macEntryDisabled = dirDisabled.items.flatMap((d: any) => d.agents).find((a: any) => a.id === macCred.agent_id);
  assert.equal(macEntryDisabled?.file_policy?.accepts_files, false);
  const preCheckDisabled = await phone.checkFileTransferTarget({ agent_id: macCred.agent_id }, { sizeBytes: 512 });
  assert.equal(preCheckDisabled.ok, false);
  assert.equal(preCheckDisabled.code, 'TARGET_FILE_RECEIVE_DISABLED');
  await assert.rejects(
    () => phone.createTask({ target: { agent_id: macCred.agent_id }, capability: 'file.deliver', input: { artifact_id: randomUUID(), filename: 'a.txt', size_bytes: 512 } }),
    (err: any) => err.status === 409 && err.code === 'TARGET_FILE_RECEIVE_DISABLED',
  );

  // Target enables files with max_file_bytes=1024, confirm_over_bytes=512, available_bytes=2048
  await mac.registerCapabilities(
    [{ name: 'file.deliver', description: 'Receive files' }],
    { filePolicy: { accepts_files: true, max_file_bytes: 1024, confirm_over_bytes: 512, available_bytes: 2048 } },
  );
  const preCheckTooBig = await phone.checkFileTransferTarget({ agent_id: macCred.agent_id }, { sizeBytes: 1500 });
  assert.equal(preCheckTooBig.ok, false);
  assert.equal(preCheckTooBig.code, 'TARGET_FILE_TOO_LARGE');
  await assert.rejects(
    () => phone.createTask({ target: { agent_id: macCred.agent_id }, capability: 'file.deliver', input: { artifact_id: randomUUID(), filename: 'big.bin', size_bytes: 1500 } }),
    (err: any) => err.status === 413 && err.code === 'TARGET_FILE_TOO_LARGE',
  );

  // Storage check: available_bytes < file size -> 507 TARGET_INSUFFICIENT_STORAGE
  await mac.updateProfile({ file_policy: { accepts_files: true, max_file_bytes: 4096, available_bytes: 256 } });
  await assert.rejects(
    () => phone.createTask({ target: { agent_id: macCred.agent_id }, capability: 'file.deliver', input: { artifact_id: randomUUID(), filename: 'mid.bin', size_bytes: 512 } }),
    (err: any) => err.status === 507 && err.code === 'TARGET_INSUFFICIENT_STORAGE',
  );

  // Valid file within limits passes pre-flight and creates task cleanly
  await mac.updateProfile({ file_policy: { accepts_files: true, max_file_bytes: 4096, confirm_over_bytes: 512, available_bytes: 8192 } });
  const preCheckOk = await phone.checkFileTransferTarget({ agent_id: macCred.agent_id }, { sizeBytes: 768 });
  assert.equal(preCheckOk.ok, true);
  assert.equal(preCheckOk.requiresConfirmation, true);
  assert.equal(preCheckOk.effectiveMaxBytes, 4096);
});
