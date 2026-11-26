import { TaskDeclined, TaskFailure } from '../../sdk/src/worker.mjs';

const GATEWAY = 'http://127.0.0.1:18791';
const ASK_DESCRIPTION = '把一件事交给 Mac 上的大肥鱼：在桌面、文稿、下载、项目目录里读取、写入、整理、移动、删到废纸篓或打开文件；超出本机环境能力会返回 declined 让云端记忆大脑自动学习';
const DECLINE_MARKER = /^\s*\[ANYLINK_DECLINED(?::\s*([A-Z0-9_-]{2,40}))?\]\s*(.*)$/is;

function askInput(input, task) {
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    throw new TaskFailure('BAD_INPUT', '任务输入必须是对象');
  }
  const obj = input ?? {};
  const keys = Object.keys(obj);
  if (keys.some(k => !['instruction', 'context'].includes(k))) throw new TaskFailure('BAD_INPUT', '只接受 instruction 和 context');
  const instruction = typeof obj.instruction === 'string' ? obj.instruction : (typeof task?.instruction === 'string' ? task.instruction : '');
  if (!instruction.trim() || instruction.length > 4000) throw new TaskFailure('BAD_INPUT', 'instruction 需要 1 到 4000 字');
  const context = obj.context;
  if (context !== undefined && (typeof context !== 'string' || context.length > 4000)) throw new TaskFailure('BAD_INPUT', 'context 最多 4000 字');
  return { instruction: instruction.trim(), context: typeof context === 'string' ? context : '' };
}

function nameResolver(client) {
  let cache;
  const load = async () => {
    const { items } = await client.directory();
    const devices = new Map(), agents = new Map();
    for (const item of items ?? []) {
      if (item?.device?.id) devices.set(item.device.id, item.device.slug ? `${item.device.name} (@${item.device.slug})` : item.device.name);
      for (const agent of item?.agents ?? []) if (agent?.id) agents.set(agent.id, agent.name);
    }
    return { devices, agents };
  };
  return async (deviceId, agentId) => {
    if (!cache) cache = await load().catch(() => null);
    let device = cache?.devices.get(deviceId), agent = cache?.agents.get(agentId);
    if ((deviceId && !device) || (agentId && !agent)) {
      cache = await load().catch(() => cache);
      device = device ?? cache?.devices.get(deviceId);
      agent = agent ?? cache?.agents.get(agentId);
    }
    return { device: device || '其他设备', agent: agent || '未知 Agent' };
  };
}

const UNAVAILABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export function createAgentAskHandler({ client, gatewayToken, gatewayUrl = GATEWAY, fetchImpl = fetch }) {
  const names = nameResolver(client);
  return {
    description: ASK_DESCRIPTION,
    async execute(input, { task, signal, reportProgress }) {
      const { instruction, context } = askInput(input, task);
      const { device, agent } = await names(task.source_device_id, task.source_agent_id).catch(() => ({ device: '其他设备', agent: '未知 Agent' }));
      const sessionKey = `agent:remote:anylink-task-${task.id}`;
      const content = `【跨设备任务 ${task.id}】来自 ${device}（${agent}）\n${instruction}` + (context ? `\n\n补充信息：\n${context}` : '');
      await reportProgress?.({ stage: 'running', message: 'Mac 上的大肥鱼正在处理…', percent: 25 });

      const combined = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
      let response;
      try {
        response = await fetchImpl(`${gatewayUrl}/v1/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${gatewayToken}`, 'x-openclaw-agent-id': 'remote', 'x-openclaw-session-key': sessionKey },
          body: JSON.stringify({ model: 'openclaw/remote', stream: false, messages: [{ role: 'user', content }] }),
        });
      } catch (error) {
        let cursor = error, code;
        while (cursor && !code) { code = cursor.code; cursor = cursor.cause; }
        if (UNAVAILABLE.has(code)) throw new TaskFailure('MAC_AGENT_UNAVAILABLE', 'Mac 上的大肥鱼暂时不可用（网关未运行或拒绝连接）');
        throw error;
      }
      if (response.status >= 400 && response.status < 500) throw new TaskFailure('MAC_AGENT_REJECTED', `Mac Agent 网关拒绝了请求（HTTP ${response.status}）`);
      if (!response.ok) throw new Error(`Mac Agent 网关返回 HTTP ${response.status}`);
      let body;
      try { body = await response.json(); } catch { throw new Error('Mac Agent 网关返回了无法解析的响应'); }
      const reply = body?.choices?.[0]?.message?.content;
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('Mac Agent 网关没有返回答复内容');

      // Protocol v3 autonomous decline: when Mac cannot do this in its environment, report `declined`
      // so the Cloud Memory Brain learns this device boundary automatically!
      const declineMatch = reply.trim().match(DECLINE_MARKER);
      if (declineMatch) {
        const code = declineMatch[1] || 'MAC_CAPABILITY_UNSUPPORTED';
        const reason = declineMatch[2]?.trim() || 'Mac 当前环境不支持完成该任务';
        throw new TaskDeclined(code, reason);
      }

      const truncated = reply.length > 48000;
      return { reply: reply.slice(0, 48000), truncated, session_key: sessionKey };
    },
  };
}
