import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createApp } from '../server/app.js';
import type { Config } from '../server/config.js';
import { AnyLinkClient } from '../sdk/src/client.mjs';
import { AnyLinkWorker, TaskDeclined } from '../sdk/src/worker.mjs';

const url = process.env.TEST_DATABASE_URL;
const joinKey = 'v3-integration-join-key-0123456789abcdef';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: url!,
    ownerToken: 'test-owner-secret-not-production-v3',
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
    maxAgentConcurrency: 2,
    maxAgentRpm: 60,
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
    wsPingIntervalMs: 25000,
    wsMaxMissedPongs: 2,
    wsMaxBufferedBytes: 1024 * 1024,
    maxQueuedPerAgent: 50,
    maxQueuedGlobal: 500,
    maxCallDepth: 5,
    artifactMaxBytes: 10 * 1024 * 1024,
    artifactQuotaBytes: 200 * 1024 * 1024,
    artifactDefaultTtlSeconds: 3600,
    ...overrides,
  };
}

test('Protocol v3 E2E: Cloud Memory Brain, Multi-Model Gateway, WebSocket Bus, Boundary Learning & Security', { skip: !url }, async t => {
  assert.equal(new URL(url!).pathname, '/anylink_test');
  const setup = new pg.Pool({ connectionString: url });
  await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await setup.end();

  const upstreamRequests: any[] = [];
  let holdResolvers: Array<() => void> = [];
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    upstreamRequests.push(body);
    const sys = String(body.messages?.[0]?.content ?? '');
    const last = String(body.messages?.at(-1)?.content ?? '');

    if (sys.includes('AnyLink Cloud Memory Manager')) {
      const payload = JSON.parse(last);
      const userTurn = payload.messages?.map((m: any) => m.content).join(' ') ?? '';
      const existing = payload.existing_memories ?? [];
      if (userTurn.includes('喜欢白米饭')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                episode_summary: '主人表示最喜欢吃热乎乎的白米饭',
                operations: [{
                  op: 'create',
                  title: '饮食偏好',
                  content: '主人最喜欢吃热乎乎的白米饭',
                  scope: 'global',
                  kind: 'preference',
                  tags: ['食物', '偏好'],
                  importance: 0.9,
                }],
              }),
            },
          }],
        }));
        return;
      }
      if (userTurn.includes('改吃面条') && existing.length > 0) {
        const pref = existing.find((m: any) => m.title === '饮食偏好');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                episode_summary: '主人最近改喜欢吃牛肉面了',
                operations: pref ? [{
                  op: 'update',
                  id: pref.id,
                  title: '饮食偏好',
                  content: '主人现在更喜欢吃牛肉面（之前喜欢白米饭）',
                  scope: 'global',
                  kind: 'preference',
                  tags: ['食物', '面条'],
                  importance: 0.9,
                }] : [],
              }),
            },
          }],
        }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ episode_summary: '跨设备日常记录', operations: [] }) } }],
      }));
      return;
    }

    if (last === 'hold') {
      await new Promise<void>(resolve => holdResolvers.push(resolve));
    }

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"流式回复："}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"白米饭真香"},"finish_reason":"stop"}]}\n\n');
      res.end('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n');
      return;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      model: body.model,
      choices: [{ message: { role: 'assistant', content: `echo(${body.model}): ${last}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 15, completion_tokens: 7 },
    }));
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;

  const config = makeConfig({
    deepseekApiKey: 'test-key-v3-not-real-00000000',
    deepseekBaseUrl: upstreamBase,
    models: [
      { id: 'deepseek-flash', upstreamModel: 'deepseek-flash', baseUrl: upstreamBase, apiKey: 'test-key-v3-not-real-00000000', ownedBy: 'deepseek', inputModalities: ['text', 'image'], aliases: ['default', 'fast'] },
      { id: 'gpt-custom', upstreamModel: 'gpt-custom-v1', baseUrl: upstreamBase, apiKey: 'test-key-v3-not-real-00000000', ownedBy: 'custom', inputModalities: ['text'], aliases: ['smart'] },
    ],
  });

  const instance = await createApp(config, { logger: false });
  await instance.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (instance.app.server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'anylink-v3-'));

  async function join(installId: string, deviceName: string, platform: any, agentKey: string, agentName: string) {
    const res = await AnyLinkClient.connect({
      baseUrl,
      joinKey,
      installId,
      device: { name: deviceName, platform },
      agent: { key: agentKey, name: agentName, summary: `${deviceName} autonomous agent` },
    });
    return { ...res, client: new AnyLinkClient({ baseUrl, token: res.token }) };
  }

  const macMain = await join('mac-v3-0001', 'MacBook', 'macos', 'mac-main', 'Mac 主代理');
  const macRemote = await join('mac-v3-0001', 'MacBook', 'macos', 'mac-remote', 'Mac 后台代理');
  const phone = await join('phone-v3-0001', 'PixelPhone', 'android', 'phone-agent', '手机代理');

  try {
    await t.test('Cloud Memory Brain: LLM consolidation, deduplication, and CJK hybrid assembly across devices', async () => {
      const first = await macMain.client.ingestMemory({
        kind: 'turn',
        messages: [
          { role: 'user', content: '我平时最喜欢白米饭' },
          { role: 'assistant', content: '记下来啦，白米饭最香了' },
        ],
        consolidate_now: true,
      });
      assert.equal(first.status, 'consolidated');
      assert.equal(first.actions?.length, 1);

      // Phone queries with Chinese words that don't literally match the full sentence -> CJK tokenization finds it!
      const phoneView = await phone.client.assembleMemory({ query: '主人爱吃什么米饭' });
      assert.ok(phoneView.memories.some((m: any) => m.title === '饮食偏好' && m.content.includes('白米饭')));
      assert.ok(phoneView.summary_text.includes('白米饭'));
      assert.ok(phoneView.episodes.length >= 1);

      // Consolidating an updated preference updates the existing memory in-place (revision 2) instead of duplicating!
      const second = await phone.client.ingestMemory({
        kind: 'turn',
        messages: [{ role: 'user', content: '我现在改吃面条了' }],
        consolidate_now: true,
      });
      assert.equal(second.status, 'consolidated');
      const prefs = (await macMain.client.searchMemories({ q: '饮食偏好' })).items;
      assert.equal(prefs.length, 1);
      assert.equal(prefs[0].revision, 2);
      assert.ok(prefs[0].content.includes('牛肉面'));
    });

    await t.test('Multi-model gateway: aliases, same-device multi-agent concurrency, and 1A auto-memory mode', async () => {
      const models = await macMain.client.models();
      assert.equal(models.data.length, 2);
      assert.ok(models.data.some((m: any) => m.id === 'gpt-custom'));

      const smartReply = await macMain.client.chatCompletions({ model: 'smart', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(smartReply.choices[0].message.content, 'echo(gpt-custom-v1): hi');

      // Same-device agents (macMain and macRemote) run concurrently without blocking each other!
      const p1 = macMain.client.chatCompletions({ model: 'default', messages: [{ role: 'user', content: 'hold' }] });
      const p2 = macRemote.client.chatCompletions({ model: 'default', messages: [{ role: 'user', content: 'hold' }] });
      for (let i = 0; i < 100 && holdResolvers.length < 2; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(holdResolvers.length, 2, 'Two agents on the same device must run concurrently');
      for (const release of holdResolvers) release();
      holdResolvers = [];
      await Promise.all([p1, p2]);

      // 1A Auto-memory header injects assembled shared memory automatically!
      const beforeCount = upstreamRequests.length;
      const autoReply = await phone.client.chatCompletions(
        { model: 'default', messages: [{ role: 'user', content: '我爱吃什么面条？' }] },
        { autoMemory: true },
      );
      assert.ok(autoReply.choices[0].message.content.includes('echo'));
      const forwarded = upstreamRequests[beforeCount];
      assert.equal(forwarded.messages[0].role, 'system');
      assert.ok(forwarded.messages[0].content.includes('牛肉面'), 'Auto-memory should inject assembled cloud memory');
      await instance.memoryBrain.drain();
    });

    await t.test('WebSocket real-time bus + capability-free invoke + automatic boundary learning on TaskDeclined', async () => {
      const phoneWs = await phone.client.connectWebSocket();
      const worker = new AnyLinkWorker({
        client: macRemote.client,
        journalPath: path.join(folder, 'mac-remote.jsonl'),
        async onInvoke(task, { reportProgress }) {
          if (task.instruction?.includes('发微信')) {
            throw new TaskDeclined('NO_WECHAT', 'Mac 代理未开放微信发消息权限，只支持文件整理');
          }
          await reportProgress({ stage: 'working', message: '正在整理文件', percent: 60 });
          return { reply: `Mac 已处理：${task.instruction}` };
        },
      });
      const ac = new AbortController();
      const workerLoop = worker.run({ signal: ac.signal, useWebSocket: true });
      try {
        // Wait briefly for worker WS handshake
        for (let i = 0; i < 50; i++) {
          const dir = await phone.client.directory();
          const macDev = dir.items.find((d: any) => d.device.id === macMain.device_id);
          if (macDev?.agents.some((a: any) => a.id === macRemote.agent_id && a.ws_online)) break;
          await new Promise(r => setTimeout(r, 30));
        }

        // Verify live WS presence
        const dir = await phone.client.directory();
        const remoteEntry = dir.items.find((d: any) => d.device.id === macMain.device_id)?.agents.find((a: any) => a.id === macRemote.agent_id);
        assert.equal(remoteEntry.ws_online, true);
        assert.equal(remoteEntry.transport, 'ws');

        // 1. Capability-free invocation by agent_key -> live WS progress + instant completion push!
        const progresses: any[] = [];
        const t1 = await phone.client.invoke({ target: { agent_key: 'mac-remote' }, instruction: '把桌面报告移到项目目录' });
        const done1 = await phone.client.waitForTask(t1.id, { socket: phoneWs, timeoutMs: 8000, onProgress: p => progresses.push(p) });
        assert.equal(done1.state, 'succeeded');
        assert.equal(done1.result?.output?.reply, 'Mac 已处理：把桌面报告移到项目目录');
        assert.ok(progresses.some(p => p.percent === 60));

        // 2. Send an unsupported request -> Mac declines -> Cloud Memory Brain AUTOMATICALLY learns the boundary!
        const t2 = await phone.client.invoke({ target: { agent_key: 'mac-remote' }, instruction: '帮我发微信给老板' });
        const done2 = await phone.client.waitForTask(t2.id, { socket: phoneWs, timeoutMs: 8000 });
        assert.equal(done2.state, 'declined');
        assert.equal(done2.result?.error?.code, 'NO_WECHAT');

        await instance.memoryBrain.drain();
        // Next turn, phone assembles memory and naturally sees Mac's capability boundary!
        const nextContext = await phone.client.assembleMemory({ query: '让 Mac 发微信' });
        assert.ok(nextContext.boundaries.some((b: any) => b.content.includes('微信')), 'Cloud Memory Brain must record declined task as a boundary');
        assert.ok(nextContext.summary_text.includes('Learned Device Boundaries'));
      } finally {
        ac.abort();
        await workerLoop;
        worker.close();
        phoneWs.close();
      }
    });

    await t.test('Lease expiry transitions orphaned running tasks to unknown instead of hanging forever', async () => {
      const t1 = await phone.client.invoke({ target: { agent_id: macRemote.agent_id }, instruction: 'Long work', leaseSeconds: 10 });
      const claimed = await macRemote.client.claimTask();
      assert.equal(claimed.task?.id, t1.id);
      const hb = await macRemote.client.heartbeatTask(t1.id, { extendSeconds: 30 });
      assert.equal(hb.cancel_requested, false);

      // Simulate crashed worker whose lease expired
      await instance.db.query("UPDATE link_tasks SET lease_expires_at=now()-interval '2 seconds' WHERE id=$1", [t1.id]);
      const reaped = await instance.linkService.reapExpiredLeases();
      assert.ok(reaped.some(r => r.id === t1.id && r.state === 'unknown'));
      const fetched = await phone.client.task(t1.id);
      assert.equal(fetched.state, 'unknown');
      assert.equal(fetched.result?.error?.code, 'LEASE_EXPIRED');
    });

    await t.test('Security fixes: device-scope write isolation and proxy-aware rate limiting', async () => {
      const macMem = await macMain.client.saveMemory({ title: 'Mac Local Path', content: '/Users/dev/work', scope: 'device' });
      assert.equal(macMem.applicable_device_id, macMain.device_id);
      // Phone cannot modify or delete Mac's device-scoped memory!
      await assert.rejects(phone.client.updateMemory(macMem.id, macMem.revision, { content: 'hijacked' }), (e: any) => e.status === 403 && e.code === 'DEVICE_SCOPE_FORBIDDEN');
      await assert.rejects(phone.client.deleteMemory(macMem.id, macMem.revision), (e: any) => e.status === 403 && e.code === 'DEVICE_SCOPE_FORBIDDEN');
      await assert.rejects(phone.client.saveMemory({ title: 'spoof', content: 'x', scope: 'device', applicable_device_id: macMain.device_id }), (e: any) => e.status === 403 && e.code === 'DEVICE_SCOPE_FORBIDDEN');

      // Behind loopback reverse proxy, distinct X-Forwarded-For IPs are rate-limited independently
      for (let i = 0; i < 5; i++) {
        const r = await instance.app.inject({
          method: 'POST', url: '/edge/v1/connect',
          headers: { authorization: 'Bearer wrong-key', 'x-forwarded-for': '203.0.113.99' },
          payload: { device: { install_id: 'attacker-01', name: 'x', platform: 'other' }, agent: { key: 'a', name: 'a' } },
        });
        assert.equal(r.statusCode, 401);
      }
      const blocked = await instance.app.inject({
        method: 'POST', url: '/edge/v1/connect',
        headers: { authorization: 'Bearer wrong-key', 'x-forwarded-for': '203.0.113.99' },
        payload: { device: { install_id: 'attacker-01', name: 'x', platform: 'other' }, agent: { key: 'a', name: 'a' } },
      });
      assert.equal(blocked.statusCode, 429);
      // Legitimate owner from another IP is NOT locked out!
      const ok = await instance.app.inject({
        method: 'POST', url: '/edge/v1/connect',
        headers: { authorization: `Bearer ${joinKey}`, 'x-forwarded-for': '198.51.100.7' },
        payload: { device: { install_id: 'legit-0001', name: 'Legit', platform: 'linux' }, agent: { key: 'a', name: 'a' } },
      });
      assert.equal(ok.statusCode, 201);
    });

    await t.test('Device unique slug disambiguates duplicate device names & enforces uniqueness', async () => {
      const homeMac = await AnyLinkClient.connect({
        baseUrl, joinKey, installId: 'dup-mac-home-01',
        device: { name: 'My Mac', platform: 'macos', slug: 'home-mac' },
        agent: { key: 'main', name: 'Home Mac' },
      });
      const officeMac = await AnyLinkClient.connect({
        baseUrl, joinKey, installId: 'dup-mac-office-01',
        device: { name: 'My Mac', platform: 'macos', slug: 'office-mac' },
        agent: { key: 'main', name: 'Office Mac' },
      });
      assert.equal(homeMac.device_slug, 'home-mac');
      assert.equal(officeMac.device_slug, 'office-mac');

      // Duplicate explicit slug is rejected with 409 DEVICE_SLUG_TAKEN
      await assert.rejects(
        AnyLinkClient.connect({
          baseUrl, joinKey, installId: 'dup-mac-conflict-01',
          device: { name: 'Third Mac', platform: 'macos', slug: 'home-mac' },
          agent: { key: 'main', name: 'Third Mac' },
        }),
        (e: any) => e.status === 409 && e.code === 'DEVICE_SLUG_TAKEN',
      );

      // Ambiguous device_name returns 409 AMBIGUOUS_TARGET_DEVICE listing slugs
      await assert.rejects(
        phone.client.invoke({ target: { device_name: 'My Mac' }, instruction: 'List files' }),
        (e: any) => e.status === 409 && e.code === 'AMBIGUOUS_TARGET_DEVICE' && e.message.includes('home-mac') && e.message.includes('office-mac'),
      );

      // Targeting by unique device_slug routes unambiguously!
      const routed = await phone.client.invoke({ target: { device_slug: 'office-mac' }, instruction: 'Check office docs' });
      assert.equal(routed.target_device_id, officeMac.device_id);
      const officeClient = new AnyLinkClient({ baseUrl, token: officeMac.token });
      const claimed = await officeClient.claimTask();
      assert.equal(claimed.task?.id, routed.id);
    });

    await t.test('Memory debouncing merges burst turns into 1 LLM call and skips trivial chitchat', async () => {
      const llmBefore = upstreamRequests.filter(r => String(r.messages?.[0]?.content ?? '').includes('AnyLink Cloud Memory Manager')).length;

      // Trivial chitchat is skipped immediately without calling LLM
      const trivial = await phone.client.ingestMemory({
        kind: 'turn',
        session_key: 'debounce-sess',
        messages: [{ role: 'user', content: '好的' }, { role: 'assistant', content: '嗯嗯！' }],
      });
      assert.equal(trivial.status, 'skipped');
      assert.equal(upstreamRequests.filter(r => String(r.messages?.[0]?.content ?? '').includes('AnyLink Cloud Memory Manager')).length, llmBefore);

      // 3 rapid substantive turns in the same session hit batchMax=3 and flush in ONE single LLM call!
      await phone.client.ingestMemory({ kind: 'turn', session_key: 'debounce-sess', messages: [{ role: 'user', content: '我打算下周去上海出差三天' }] });
      await phone.client.ingestMemory({ kind: 'turn', session_key: 'debounce-sess', messages: [{ role: 'user', content: '酒店订在虹桥火车站附近' }] });
      const third = await phone.client.ingestMemory({ kind: 'turn', session_key: 'debounce-sess', messages: [{ role: 'user', content: '记得提醒我带 Type-C 扩展坞' }] });
      assert.equal((third as any).debounced, true);
      await instance.memoryBrain.drain();

      const llmAfter = upstreamRequests.filter(r => String(r.messages?.[0]?.content ?? '').includes('AnyLink Cloud Memory Manager')).length;
      assert.equal(llmAfter - llmBefore, 1, '3 burst turns in one session must coalesce into exactly 1 Cloud Memory LLM call');
    });

    await t.test('Simple loginPassword authenticates both Web Admin login and /edge/v1/connect', async () => {
      const badWeb = await instance.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { password: 'wrong-password' } });
      assert.equal(badWeb.statusCode, 401);
      const okWeb = await instance.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { password: 'test-easy-pass-123' } });
      assert.equal(okWeb.statusCode, 200);
      const statusRes = await instance.app.inject({ method: 'GET', url: '/v1/status', headers: { cookie: String(okWeb.headers['set-cookie']).split(';')[0] } });
      assert.equal(statusRes.statusCode, 200);
      assert.equal(statusRes.json().login_password_enabled, true);

      const quickDevice = await AnyLinkClient.connect({
        baseUrl,
        password: 'test-easy-pass-123',
        installId: 'quick-pass-dev-01',
        device: { name: 'Quick Phone', platform: 'android', slug: 'quick-phone' },
        agent: { key: 'android-dafeiyu', name: 'Quick Agent' },
      });
      assert.ok(quickDevice.token.startsWith('ak_'));
      assert.equal(quickDevice.device_slug, 'quick-phone');
    });
  } finally {
    await instance.app.close();
    await new Promise<void>(r => upstream.close(() => r()));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
