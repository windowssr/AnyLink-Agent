import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createAgentAskHandler} from './agent-ask.mjs';
import {TaskDeclined, TaskFailure} from '../../sdk/src/worker.mjs';

const client = {directory: async () => ({items: [{device: {id: 'dev-mac', name: 'Mac 主机', platform: 'macos'}, agents: [{id: 'ag-openclaw', name: 'Mac 大肥鱼'}]}, {device: {id: 'dev-phone', name: '我的手机', platform: 'android'}, agents: []}]})};
const task = {id: 'task-1', source_device_id: 'dev-phone', source_agent_id: 'ag-phone', capability: 'agent.ask', input: {}};

async function gateway(t, handler) {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
const isTaskFailure = (code) => (e) => e instanceof TaskFailure && (!code || e.code === code);

test('agent.ask posts the remote agent request with resolved names and session key', async t => {
  let seen;
  const url = await gateway(t, (req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      seen = {url: req.url, auth: req.headers.authorization, session: req.headers['x-openclaw-session-key'], agent: req.headers['x-openclaw-agent-id'], body: JSON.parse(body)};
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({choices: [{message: {content: '已把报告整理到下载目录'}}]}));
    });
  });
  const ask = createAgentAskHandler({client, gatewayToken: 'gw-secret', gatewayUrl: url});
  const result = await ask.execute({instruction: '把桌面的报告整理一下', context: '尽量简单'}, {task, signal: new AbortController().signal});
  assert.equal(seen.url, '/v1/chat/completions'); assert.equal(seen.auth, 'Bearer gw-secret');
  assert.equal(seen.session, 'agent:remote:anylink-task-task-1'); assert.equal(seen.agent, 'remote');
  assert.equal(seen.body.model, 'openclaw/remote'); assert.equal(seen.body.stream, false);
  const content = seen.body.messages[0].content;
  assert.ok(content.includes('【跨设备任务 task-1】来自 我的手机（未知 Agent）'));
  assert.ok(content.includes('把桌面的报告整理一下') && content.includes('补充信息'));
  assert.equal(result.reply, '已把报告整理到下载目录'); assert.equal(result.truncated, false); assert.equal(result.session_key, 'agent:remote:anylink-task-task-1');
});

test('agent.ask rejects bad input and gateway 4xx as definite failures', async t => {
  const url = await gateway(t, (req, res) => { res.statusCode = 401; res.end('{"error":"bad token"}'); });
  const ask = createAgentAskHandler({client, gatewayToken: 'gw-secret', gatewayUrl: url});
  const signal = new AbortController().signal;
  await assert.rejects(ask.execute({}, {task, signal}), isTaskFailure('BAD_INPUT'));
  await assert.rejects(ask.execute({instruction: 'x'.repeat(4001)}, {task, signal}), isTaskFailure('BAD_INPUT'));
  await assert.rejects(ask.execute({instruction: 'ok', extra: 1}, {task, signal}), isTaskFailure('BAD_INPUT'));
  await assert.rejects(ask.execute({instruction: '整理文件'}, {task, signal}), isTaskFailure('MAC_AGENT_REJECTED'));
});

test('agent.ask treats 5xx and refused connections distinctly', async t => {
  const url = await gateway(t, (req, res) => { res.statusCode = 503; res.end('down'); });
  const ask = createAgentAskHandler({client, gatewayToken: 'gw-secret', gatewayUrl: url});
  const signal = new AbortController().signal;
  await assert.rejects(ask.execute({instruction: '整理文件'}, {task, signal}), (e) => !(e instanceof TaskFailure), '5xx stays unknown');
  const dead = createAgentAskHandler({client, gatewayToken: 'x', gatewayUrl: 'http://127.0.0.1:59999'});
  await assert.rejects(dead.execute({instruction: '整理文件'}, {task, signal}), isTaskFailure('MAC_AGENT_UNAVAILABLE'));
});

test('agent.ask truncates long replies', async t => {
  const url = await gateway(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({choices: [{message: {content: '长'.repeat(50000)}}]}));
  });
  const ask = createAgentAskHandler({client, gatewayToken: 'gw-secret', gatewayUrl: url});
  const result = await ask.execute({instruction: '写一篇长文'}, {task, signal: new AbortController().signal});
  assert.equal(result.reply.length, 48000); assert.equal(result.truncated, true);
});

test('agent.ask converts [ANYLINK_DECLINED] into TaskDeclined and supports v3 task.instruction + progress', async t => {
  const url = await gateway(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({choices: [{message: {content: '[ANYLINK_DECLINED: NO_WECHAT] Mac 未开放微信发消息权限'}}]}));
  });
  const progresses = [];
  const ask = createAgentAskHandler({client, gatewayToken: 'gw-secret', gatewayUrl: url});
  const v3Task = {...task, capability: 'agent.invoke', instruction: '帮我发微信给张三'};
  await assert.rejects(
    ask.execute({}, {task: v3Task, signal: new AbortController().signal, reportProgress: async p => progresses.push(p)}),
    e => e instanceof TaskDeclined && e.code === 'NO_WECHAT' && e.message.includes('微信'),
  );
  assert.equal(progresses.length, 1);
  assert.equal(progresses[0].percent, 25);
});
