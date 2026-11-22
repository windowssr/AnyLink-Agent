import {AgentFailure, memoryIntent} from './protocol.mjs';
const str = (maxLength = 4000) => ({type: 'string', minLength: 1, maxLength});
const object = (properties, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const result = value => ({content: [{type: 'text', text: JSON.stringify(value)}], details: value});
const uuid = {...str(36), pattern: '^[0-9a-fA-F-]{36}$'};
const revision = {type: 'integer', minimum: 1};

export function createTools({request, connection, device, journal, run, expression, signal}) {
  const define = (name, label, description, parameters, execute) => ({name, label, description, parameters, executionMode: 'sequential', execute: async (id, params, toolSignal) => {
    if (toolSignal?.aborted || signal?.aborted) throw new AgentFailure('CANCELLED', '本轮已停止');
    if (run.uncertain) throw new AgentFailure('TOOL_RESULT_UNKNOWN', '原操作结果未确认，已停止后续执行', true);
    try { return await journal.tool(run, id, name, params, async key => result(await execute(params, {'Idempotency-Key': key}, toolSignal))); }
    catch (error) { if (error.uncertain) { run.uncertain = true; journal.save(); } throw error; }
  }});
  const writeAllowed = () => { if (!memoryIntent(run.text)) throw new AgentFailure('MEMORY_NOT_REQUESTED', '主人本轮没有要求记住、更正或遗忘，未修改记忆'); };
  return [
    ...(connection.mac_peer ? [define('anylink_mac_search_files', '在 Mac 上搜索文件', '把只读搜索交给已配对的 Mac 本地 OpenClaw 执行，返回真实文件名、路径和请求回执。query 使用文件名关键词，不传路径或通配符；scope 可为 all、desktop、documents、downloads、projects、workspace。只搜索 Mac 开放的范围，不读内容。partial=true 时说明搜索范围或数量限制，不声称全盘不存在。', object({query: str(120), scope: {type: 'string', enum: ['all', 'desktop', 'documents', 'downloads', 'projects', 'workspace']}, limit: {type: 'integer', minimum: 1, maximum: 50}}, ['query']), async (p, headers, s) => {
      const value = await request('/anylink-peer/v1/files/search', {method: 'POST', body: p, headers, signal: s});
      if (!value || value.target_device_id !== connection.mac_peer.device_id || value.origin_device_id !== connection.device_id || value.read_only !== true || value.name_only !== true || !Array.isArray(value.matches)) throw new AgentFailure('MAC_RESULT_UNVERIFIED', 'Mac 搜索回执不匹配，未采信结果', true);
      return value;
    })] : []),
    define('anylink_memory_search', '查询共同记忆', '查询云端当前有效记忆。默认只查全局和当前手机；可指定其他设备 ID 查询该设备事实。', object({q: {type: 'string', maxLength: 200}, device_id: uuid}), async (p, _h, s) => {
      if (p.device_id) return request('/edge/v1/memories/search', {method: 'POST', body: p, signal: s});
      const c = await request('/edge/v1/context', {signal: s}), q = (p.q ?? '').toLowerCase();
      return {items: [...c.global, ...c.device].filter(m => (m.title + ' ' + m.content).toLowerCase().includes(q))};
    }),
    define('anylink_memory_save', '记住你说的话', '仅当主人本轮明确要求记住时保存事实。global 跨设备共享；device 仅当前手机适用。', object({title: str(120), content: str(), scope: {type: 'string', enum: ['global', 'device']}}, ['title', 'content', 'scope']), (p, headers, s) => {
      writeAllowed(); return request('/edge/v1/memories', {method: 'POST', body: {...p, applicable_device_id: p.scope === 'device' ? connection.device_id : null}, headers, signal: s});
    }),
    define('anylink_memory_update', '更正共同记忆', '主人明确更正记忆后使用。先查 ID 和当前 revision，冲突时重新查询，不猜版本。', object({id: uuid, content: str(), expected_revision: revision}, ['id', 'content', 'expected_revision']), (p, headers, s) => {
      writeAllowed(); const {id, ...body} = p; return request('/edge/v1/memories/' + id, {method: 'PATCH', body, headers, signal: s});
    }),
    define('anylink_memory_delete', '遗忘一条记忆', '只在主人明确要求遗忘时使用，先查 ID 和 revision。', object({id: uuid, expected_revision: revision}, ['id', 'expected_revision']), (p, headers, s) => {
      writeAllowed(); return request('/edge/v1/memories/' + p.id, {method: 'DELETE', headers: {...headers, 'If-Match': String(p.expected_revision)}, signal: s});
    }),
    define('anylink_device_status', '查看手机状态', '读取当前设备和网络、电量状态；浏览器预览明确返回 preview，不冒充真机。', object({}), () => device.status()),
    define('anylink_note_save', '写入手机便笺', '在当前手机 AnyLink 私有便笺中保存文字，不写入云端长期记忆或其他应用。', object({title: str(100), content: str(8000)}, ['title', 'content']), p => device.saveNote(p)),
    define('anylink_note_list', '查看手机便笺', '读取当前手机 AnyLink 私有便笺。', object({}), () => device.listNotes()),
    define('anylink_companion_expression', '大肥鱼做出回应', '请求形象表达开心、安慰或好奇，人物和聊天属于同一个大肥鱼。requested 表示已提交表现请求，不是渲染完成证明。', object({emotion: {type: 'string', enum: ['neutral', 'happy', 'excited', 'comfort', 'curious', 'apologetic']}, gesture: {type: 'string', enum: ['none', 'wave', 'point', 'nod']}}, ['emotion', 'gesture']), p => { const status = expression(p); return {requested: true, ...(status ?? {}), ...p}; }),
  ];
}
