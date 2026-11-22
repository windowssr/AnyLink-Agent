import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {PeerFailure, searchFiles, searchInput} from './search.mjs';
export const prefix = '/anylink-peer/v1';
export const digest = value => createHash('sha256').update(value).digest('hex');
const send = (res, status, value) => { if (res.destroyed) return; res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}); res.end(JSON.stringify(value)); };
const atomic = (file, value) => { const temp = file + '.' + randomUUID() + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value) + '\n', {mode: 0o600, flag: 'wx'}); fs.renameSync(temp, file); };
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new PeerFailure(415, 'JSON_REQUIRED', '搜索请求需要 JSON');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new PeerFailure(413, 'REQUEST_TOO_LARGE', '搜索请求过大'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PeerFailure(400, 'INVALID_JSON', '搜索请求格式不正确'); }
}
export function createPeerHandler({policyFile, receiptDirectory, search = searchFiles}) {
  fs.mkdirSync(receiptDirectory, {recursive: true, mode: 0o700});
  const pending = new Map();
  function authorize(req) {
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.headers.origin || !/^ap_[A-Za-z0-9_-]{40,100}$/.test(token)) throw new PeerFailure(401, 'PEER_AUTH_REQUIRED', '需要已配对的只读搜索凭据');
    const hashed = digest(token), peer = policy.peers?.find(p => p.enabled === true && p.token_hash?.length === hashed.length && timingSafeEqual(Buffer.from(p.token_hash), Buffer.from(hashed)));
    if (!peer || peer.device_id !== req.headers['x-anylink-peer-device'] || policy.device_id !== req.headers['x-anylink-target-device']) throw new PeerFailure(403, 'PEER_NOT_PAIRED', '设备未配对或目标 Mac 不匹配');
    if (!peer.capabilities?.includes('files.search')) throw new PeerFailure(403, 'CAPABILITY_DENIED', '未授予文件搜索能力');
    return {policy, peer};
  }
  return async (req, res) => {
    try {
      const {policy, peer} = authorize(req), route = (req.url ?? '').split('?')[0];
      if (route === prefix + '/capabilities' && req.method === 'GET') { send(res, 200, {device_id: policy.device_id, name: policy.name, capabilities: ['files.search'], read_only: true, scopes: policy.roots.map(r => ({id: r.id, label: r.label}))}); return true; }
      if (route !== prefix + '/files/search' || req.method !== 'POST') throw new PeerFailure(405, 'SEARCH_ONLY', '此配对只支持只读文件名搜索');
      const input = searchInput(await body(req)), key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[\x21-\x7e]{1,160}$/.test(key)) throw new PeerFailure(400, 'REQUEST_ID_REQUIRED', '需要稳定的搜索请求编号');
      const recordKey = digest(peer.device_id + ':' + key), fingerprint = digest(JSON.stringify(input)), file = path.join(receiptDirectory, recordKey + '.json');
      if (fs.existsSync(file)) {
        const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (previous.fingerprint !== fingerprint) throw new PeerFailure(409, 'REQUEST_ID_CONFLICT', '同一请求编号不能更换搜索条件');
        if (previous.state === 'completed') { send(res, 200, {...previous.result, replayed_receipt: true}); return true; }
        if (pending.has(recordKey)) { send(res, 200, {...await pending.get(recordKey), replayed_receipt: true}); return true; }
        throw new PeerFailure(409, 'SEARCH_RESULT_UNKNOWN', '原搜索没有确认完成，请查看原请求后再发起新的搜索');
      }
      if (pending.size >= 1) throw new PeerFailure(429, 'MAC_SEARCH_BUSY', 'Mac 正在处理另一个文件搜索，请稍后再试');
      const controller = new AbortController(), cancel = () => { if (!res.writableEnded) controller.abort(); }; res.on('close', cancel);
      const receipt = {request_id: randomUUID(), origin_device_id: peer.device_id, target_device_id: policy.device_id, capability: 'files.search', fingerprint, state: 'submitted', started_at: new Date().toISOString()};
      atomic(file, receipt);
      const operation = (async () => {
        try {
          const value = await search(input, policy, {signal: controller.signal});
          const result = {...value, request_id: receipt.request_id, origin_device_id: peer.device_id, target_device_id: policy.device_id, target_name: policy.name, executed_by: 'mac_openclaw_plugin', replayed_receipt: false};
          Object.assign(receipt, {state: 'completed', finished_at: new Date().toISOString(), result}); atomic(file, receipt); return result;
        } catch (error) { Object.assign(receipt, {state: controller.signal.aborted ? 'cancelled' : 'interrupted', finished_at: new Date().toISOString()}); atomic(file, receipt); throw error; }
      })();
      pending.set(recordKey, operation);
      try { send(res, 200, await operation); } finally { pending.delete(recordKey); res.off('close', cancel); }
      return true;
    } catch (error) { send(res, error instanceof PeerFailure ? error.status : 503, {error: {code: error instanceof PeerFailure ? error.code : 'MAC_SEARCH_UNAVAILABLE', message: error instanceof PeerFailure ? error.message : 'Mac 搜索暂时不可用，没有自动重跑'}}); return true; }
  };
}
