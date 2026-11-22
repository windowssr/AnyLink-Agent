import {AgentFailure, validateConnection} from '../core/protocol.mjs';

export function createTransport(input) {
  const connection = validateConnection(input);
  return async function request(path, {method = 'GET', body, headers = {}, signal, onText} = {}) {
    if (!/^\/(edge|model)\/v1\/[a-z0-9/_-]+$/i.test(path)) throw new AgentFailure('BAD_ROUTE', '不支持的服务接口');
    if (signal?.aborted) throw new AgentFailure('CANCELLED', '本轮已停止');
    const url = connection.server + path;
    const auth = {Authorization: 'Bearer ' + connection.token, ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers};
    let response;
    try {
      if (typeof plus !== 'undefined' && plus.net) response = await nativeRequest(url, {method, body, headers: auth, signal, onText});
      else response = await browserRequest(url, {method, body, headers: auth, signal, onText});
    } catch (error) {
      if (error instanceof AgentFailure) throw error;
      throw new AgentFailure(signal?.aborted ? 'CANCELLED' : 'TRANSPORT_UNKNOWN', signal?.aborted ? '本轮已停止；已提交请求的结果可能未确认' : '网络请求结果未确认，没有自动重发', method !== 'GET');
    }
    let data; try { data = response.text ? JSON.parse(response.text) : null; } catch { data = null; }
    if (response.status < 200 || response.status >= 300) {
      const code = data?.error?.code ?? 'HTTP_' + response.status;
      const messages = {EDGE_AUTH_REQUIRED: '设备凭据无效或已撤销，请重新连接', MODEL_BUSY: '原模型请求还在处理中，请稍后再试', REVISION_CONFLICT: '记忆已被修改，请重新查询当前版本'};
      throw new AgentFailure(code, messages[code] ?? '服务未确认本次请求（' + response.status + '）', response.status >= 500 && method !== 'GET');
    }
    return onText ? response : data;
  };
}
async function browserRequest(url, {method, body, headers, signal, onText}) {
  const response = await fetch(url, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, credentials: 'omit', redirect: 'error'});
  if (onText && response.ok) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; onText(decoder.decode(chunk.value, {stream: true})); } onText(decoder.decode()); }
    finally { reader.releaseLock(); }
    return {status: response.status, text: ''};
  }
  return {status: response.status, text: await response.text()};
}
function nativeRequest(url, {method, body, headers, signal, onText}) {
  return new Promise((resolve, reject) => {
    const xhr = new plus.net.XMLHttpRequest(); let consumed = 0, settled = false;
    const abort = () => xhr.abort();
    const finish = (error, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const consume = () => {
      if (!onText || xhr.status !== 200 || settled) return;
      try { const text = xhr.responseText ?? ''; if (text.length > consumed) { const delta = text.slice(consumed); consumed = text.length; onText(delta); } }
      catch (error) { finish(error); xhr.abort(); }
    };
    xhr.open(method, url); xhr.timeout = 125000;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.onprogress = consume;
    xhr.onreadystatechange = () => { if (xhr.readyState === 3) consume(); };
    xhr.onload = () => { consume(); finish(null, {status: xhr.status, text: onText && xhr.status === 200 ? '' : xhr.responseText}); };
    xhr.onerror = xhr.ontimeout = () => finish(new AgentFailure('TRANSPORT_UNKNOWN', '网络请求结果未确认，没有自动重发', method !== 'GET'));
    xhr.onabort = () => finish(new AgentFailure('CANCELLED', '本轮已停止；已提交请求的结果可能未确认', method !== 'GET'));
    signal?.addEventListener('abort', abort);
    if (signal?.aborted) { finish(new AgentFailure('CANCELLED', '本轮已停止')); return; }
    xhr.send(body === undefined ? null : JSON.stringify(body));
  });
}
