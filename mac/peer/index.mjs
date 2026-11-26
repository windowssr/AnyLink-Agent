import path from 'node:path';
import fs from 'node:fs';
import {searchFiles} from './search.mjs';
import {fileOps} from './files.mjs';
const parameters = {type: 'object', properties: {query: {type: 'string', minLength: 1, maxLength: 120}, scope: {type: 'string', enum: ['all', 'desktop', 'documents', 'downloads', 'projects', 'workspace']}, limit: {type: 'integer', minimum: 1, maximum: 50}}, required: ['query'], additionalProperties: false};
const pathParam = {type: 'string', minLength: 1, maxLength: 4096, description: '绝对路径或 <范围ID>:<相对路径>'};
const fileTools = [
  ['anylink_files_list', '列出 Mac 开放目录里的文件和子目录', {type: 'object', properties: {path: pathParam, limit: {type: 'integer', minimum: 1, maximum: 200}}, required: ['path'], additionalProperties: false}, 'list'],
  ['anylink_files_read', '读取 Mac 开放目录里的文本文件内容（自动跳过二进制）', {type: 'object', properties: {path: pathParam, offset: {type: 'integer', minimum: 0}, max_bytes: {type: 'integer', minimum: 1, maximum: 200000}}, required: ['path'], additionalProperties: false}, 'read'],
  ['anylink_files_write', '在 Mac 开放目录里新建、覆盖或追加文本文件；删除请用 anylink_files_trash 移到废纸篓', {type: 'object', properties: {path: pathParam, content: {type: 'string', maxLength: 1048576}, mode: {type: 'string', enum: ['create', 'overwrite', 'append']}, create_parents: {type: 'boolean'}}, required: ['path', 'content'], additionalProperties: false}, 'write'],
  ['anylink_files_mkdir', '在 Mac 开放目录里递归创建文件夹', {type: 'object', properties: {path: pathParam}, required: ['path'], additionalProperties: false}, 'mkdir'],
  ['anylink_files_move', '在 Mac 开放目录内移动或重命名文件；to 是已存在目录时移入其中', {type: 'object', properties: {from: pathParam, to: pathParam, overwrite: {type: 'boolean'}}, required: ['from', 'to'], additionalProperties: false}, 'move'],
  ['anylink_files_trash', '把 Mac 开放目录里的文件或文件夹移到废纸篓（永不直接删除，可恢复）', {type: 'object', properties: {path: pathParam}, required: ['path'], additionalProperties: false}, 'trash'],
  ['anylink_files_open', '用 Mac 默认程序打开开放目录里的文件或文件夹', {type: 'object', properties: {path: pathParam}, required: ['path'], additionalProperties: false}, 'open'],
];
export default {
  id: 'anylink-peer-search', name: 'AnyLink Peer Files',
  register(api) {
    const root = api.pluginConfig?.projectRoot;
    if (!path.isAbsolute(root ?? '')) throw new Error('Absolute projectRoot required');
    const policyFile = path.join(root, 'secrets/mac-peer-policy.json');
    const policy = () => JSON.parse(fs.readFileSync(policyFile, 'utf8'));
    api.registerTool(() => ({name: 'anylink_mac_search_files', label: '只读搜索 Mac 文件', description: '在本机已开放目录里按文件名关键词搜索，只返回文件名、路径和元数据，不读取内容。partial=true 时不能声称已搜遍电脑。', parameters, async execute(_id, input, signal) {
      const result = await searchFiles(input, policy(), {signal});
      return {content: [{type: 'text', text: JSON.stringify(result)}], details: result};
    }}), {names: ['anylink_mac_search_files'], workspaceAccess: false});
    for (const [name, description, params, op] of fileTools) {
      api.registerTool(() => ({name, label: description.slice(0, 12), description, parameters: params, async execute(_id, input) {
        try {
          const result = await fileOps[op](input, policy());
          return {content: [{type: 'text', text: JSON.stringify(result)}], details: result};
        } catch (error) {
          const failure = {error: {code: error?.code ?? 'FILE_OP_FAILED', message: String(error?.message ?? error).slice(0, 300)}};
          return {content: [{type: 'text', text: JSON.stringify(failure)}], details: failure, isError: true};
        }
      }}), {names: [name], workspaceAccess: false});
    }
  },
};
