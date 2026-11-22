import path from 'node:path';
import fs from 'node:fs';
import {createPeerHandler, prefix} from './service.mjs';
import {searchFiles} from './search.mjs';
const parameters = {type: 'object', properties: {query: {type: 'string', minLength: 1, maxLength: 120}, scope: {type: 'string', enum: ['all', 'desktop', 'documents', 'downloads', 'projects', 'workspace']}, limit: {type: 'integer', minimum: 1, maximum: 50}}, required: ['query'], additionalProperties: false};
export default {
  id: 'anylink-peer-search', name: 'AnyLink Read-only Peer Search',
  register(api) {
    const root = api.pluginConfig?.projectRoot;
    if (!path.isAbsolute(root ?? '')) throw new Error('Absolute projectRoot required');
    const policyFile = path.join(root, 'secrets/mac-peer-policy.json');
    const handler = createPeerHandler({policyFile, receiptDirectory: path.join(root, 'data/mac/peer/receipts')});
    for (const route of ['/files/search', '/capabilities']) api.registerHttpRoute({path: prefix + route, auth: 'plugin', match: 'exact', handler});
    api.registerTool(() => ({name: 'anylink_mac_search_files', label: '只读搜索 Mac 文件', description: '在本机已开放目录里按文件名关键词搜索，只返回文件名、路径和元数据，不读取内容。partial=true 时不能声称已搜遍电脑。', parameters, async execute(_id, input, signal) {
      const result = await searchFiles(input, JSON.parse(fs.readFileSync(policyFile, 'utf8')), {signal});
      return {content: [{type: 'text', text: JSON.stringify(result)}], details: result};
    }}), {names: ['anylink_mac_search_files'], workspaceAccess: false});
  },
};
