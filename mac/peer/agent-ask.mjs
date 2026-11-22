import {TaskFailure} from '../../sdk/src/worker.mjs';

const GATEWAY = 'http://127.0.0.1:18791';
const ASK_DESCRIPTION = '把一件事交给 Mac 上的大肥鱼：在桌面、文稿、下载、项目目录里读取、写入、整理、移动、删到废纸篓或打开文件；input {instruction, context?}，返回她做完后的答复';

function askInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TaskFailure('BAD_INPUT', '任务输入必须是对象');
  const keys = Object.keys(input);
  if (keys.some(k => !['instruction', 'context'].includes(k))) throw new TaskFailure('BAD_INPUT', '只接受 instruction 和 context');
  const instruction = input.instruction;
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000) throw new TaskFailure('BAD_INPUT', 'instruction 需要 1 到 4000 字');
  const context = input.context;
  if (context !== undefined && (typeof context !== 'string' || context.length > 4000)) throw new TaskFailure('BAD_INPUT', 'context 最多 4000 字');
  return {instruction: instruction.trim(), context: typeof context === 'string' ? context : ''};
}

// Resolve source device/agent display names through the link directory; cache per
// worker, refresh once on a miss, fall back to a generic label.
function nameResolver(client) {
  let cache;
  const load = async () => {
    const {items} = await client.directory();
    const devices = new Map(), agents = new Map();
    for (const item of items ?? []) {
      if (item?.device?.id) devices.set(item.device.id, item.device.name);
      for (const agent of item?.agents ?? []) if (agent?.id) agents.set(agent.id, agent.name);
    }
    return {devices, agents};
  };
  return async (deviceId, agentId) => {
    if (!cache) cache = await load().catch(() => null);
    let device = cache?.devices.get(deviceId), agent = cache?.agents.get(agentId);
    if ((deviceId && !device) || (agentId && !agent)) {
      cache = await load().catch(() => cache);
      device = device ?? cache?.devices.get(deviceId); agent = agent ?? cache?.agents.get(agentId);
    }
    return {device: device || '其他设备', agent: agent || '未知 Agent'};
  };
}

const UNAVAILABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export function createAgentAskHandler({client, gatewayToken, gatewayUrl = GATEWAY, fetchImpl = fetch}) {
  const names = nameResolver(client);
  return {
    description: ASK_DESCRIPTION,
    async execute(input, {task, signal}) {
      const {instruction, context} = askInput(input);
      const {device, agent} = await names(task.source_device_id, task.source_agent_id).catch(() => ({device: '其他设备', agent: '未知 Agent'}));
      const sessionKey = `anylink-task-${task.id}`;
      const content = `【跨设备任务 ${task.id}】来自 ${device}（${agent}）\n${instruction}` + (context ? `\n\n补充信息：\n${context}` : '');
      const combined = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
      let response;
      try {
        response = await fetchImpl(`${gatewayUrl}/v1/chat/completions`, {
          method: 'POST', redirect: 'error', signal: combined,
          headers: {'content-type': 'application/json', authorization: `Bearer ${gatewayToken}`, 'x-openclaw-session-key': sessionKey},
          body: JSON.stringify({model: 'openclaw/remote', stream: false, messages: [{role: 'user', content}]}),
        });
      } catch (error) {
        let cursor = error, code;
        while (cursor && !code) { code = cursor.code; cursor = cursor.cause; }
        if (UNAVAILABLE.has(code)) throw new TaskFailure('MAC_AGENT_UNAVAILABLE', 'Mac 上的大肥鱼暂时不可用（网关未运行或拒绝连接）');
        throw error; // abort/timeout/network ambiguity after possible send: outcome unknown
      }
      if (response.status >= 400 && response.status < 500) throw new TaskFailure('MAC_AGENT_REJECTED', `Mac Agent 网关拒绝了请求（HTTP ${response.status}）`);
      if (!response.ok) throw new Error(`Mac Agent 网关返回 HTTP ${response.status}`);
      let body;
      try { body = await response.json(); } catch { throw new Error('Mac Agent 网关返回了无法解析的响应'); }
      const reply = body?.choices?.[0]?.message?.content;
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('Mac Agent 网关没有返回答复内容');
      const truncated = reply.length > 48000;
      return {reply: reply.slice(0, 48000), truncated, session_key: sessionKey};
    },
  };
}
