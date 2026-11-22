export const MODEL = 'deepseek-flash';
export class AgentFailure extends Error {
  constructor(code, message, uncertain = false) {
    super(message); this.name = 'AgentFailure'; this.code = code; this.uncertain = uncertain;
  }
}
function endpoint(value) {
  const server = String(value ?? '').replace(/\/$/, '');
  const match = /^(https?):\/\/(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(server);
  const local = match && ['127.0.0.1', 'localhost', '[::1]', '10.0.2.2'].includes(match[2]);
  if (!match || (match[1] === 'http' && !local) || (match[3] && (+match[3] < 1 || +match[3] > 65535))) {
    throw new AgentFailure('BAD_ENDPOINT', '服务器需使用 HTTPS；USB 调试仅允许本机回环 HTTP 地址');
  }
  return server;
}
export function validateConnection(input) {
  if (!input || typeof input !== 'object') throw new AgentFailure('BAD_BINDING', '请导入设备连接信息');
  const server = endpoint(input.server);
  if (!/^ak_[A-Za-z0-9_-]{32,100}$/.test(input.token ?? '') || !/^[0-9a-f-]{36}$/i.test(input.device_id ?? '')) {
    throw new AgentFailure('BAD_BINDING', '设备连接信息不完整');
  }
  let mac_peer;
  if (input.mac_peer) {
    const peer = input.mac_peer;
    if (!/^ap_[A-Za-z0-9_-]{40,100}$/.test(peer.token ?? '') || !/^[0-9a-f-]{36}$/i.test(peer.device_id ?? '') || peer.device_id === input.device_id) throw new AgentFailure('BAD_PEER_BINDING', 'Mac 只读搜索配对信息不完整');
    mac_peer = {server: endpoint(peer.server), device_id: peer.device_id, name: String(peer.name ?? '我的 Mac').slice(0, 80), token: peer.token};
  }
  return {server, device_id: input.device_id, token: input.token, ...(mac_peer ? {mac_peer} : {})};
}
export const textOf = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
export function wireMessages(context) {
  const output = [];
  for (const message of context.messages) {
    if (message.role === 'system') output.push({role: 'system', content: textOf(message) + Object.values(message.sections ?? {}).filter(Boolean).join('\n')});
    else if (message.role === 'user') output.push({role: 'user', content: textOf(message)});
    else if (message.role === 'toolResult') output.push({role: 'tool', tool_call_id: message.toolCallId, content: textOf(message)});
    else if (message.role === 'assistant' && !['error', 'aborted'].includes(message.stopReason)) {
      const calls = message.content.filter(p => p.type === 'toolCall');
      output.push({role: 'assistant', content: textOf(message) || null, ...(calls.length ? {tool_calls: calls.map(c => ({id: c.id, type: 'function', function: {name: c.name, arguments: JSON.stringify(c.arguments)}}))} : {})});
    }
  }
  return output;
}
// Parses complete SSE events, including CRLF, comments and multiline data. The
// transport owns UTF-8 decoding; this parser never assumes a chunk is an event.
export class SSEParser {
  constructor(onData) { this.buffer = ''; this.onData = onData; }
  feed(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 1048576) throw new AgentFailure('EVENT_TOO_LARGE', '模型数据超过本机限制', true);
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const event = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) this.onData(data);
    }
  }
}
export function memoryIntent(text) {
  if (/(?:不要|不用|别|无需|不必|不准|不(?=保存|记录|记住|更新|更正|遗忘|忘掉|删除)).{0,6}(?:记住|记录|保存|更新|更正|遗忘|忘掉|删除)/u.test(text)) return false;
  return /(?:记住|记一下|记下来|保存.{0,8}(?:记忆|偏好)|更新.{0,8}记忆|更正.{0,8}记忆|忘掉|遗忘|删除.{0,8}记忆)/u.test(text);
}
export function publicFailure(error) {
  return error instanceof AgentFailure ? error.message : '本轮未确认完成，请查看执行记录；没有自动重试。';
}
