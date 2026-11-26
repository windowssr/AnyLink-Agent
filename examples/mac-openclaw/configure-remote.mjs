import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {paths} from './configure.mjs';
import {composeSoul} from './configure-companion.mjs';

export const REMOTE_TOOLS = ['anylink_mac_search_files', 'anylink_files_list', 'anylink_files_read', 'anylink_files_write', 'anylink_files_mkdir', 'anylink_files_move', 'anylink_files_trash', 'anylink_files_open', 'anylink_memory_search', 'anylink_link_directory', 'anylink_task_status'];

function rewriteLegacyPluginPaths(list, root) {
  const replacements = new Map([
    [path.join(root, 'mac/plugin'), path.join(root, 'examples/mac-openclaw/plugin')],
    [path.join(root, 'mac/control'), path.join(root, 'examples/mac-openclaw/control')],
    [path.join(root, 'mac/companion/plugin'), path.join(root, 'examples/mac-openclaw/companion/plugin')],
    [path.join(root, 'mac/peer'), path.join(root, 'examples/mac-openclaw/peer')],
  ]);
  return [...new Set((list ?? []).map(p => replacements.get(p) ?? p))];
}

// Writes the remote-task agent entry and its persona. By default keeps remote confined to REMOTE_TOOLS;
// pass fullAccess: true (--full-access / ANYLINK_MAC_FULL_ACCESS=1) to explicitly grant full host access.
export function installRemoteAgent({configFile, folder, root, baseFile, appendixFile, fullAccess = false}) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.gateway?.port !== 18791 || config.gateway?.bind !== 'loopback') throw new Error('Unexpected Mac profile');
  const workspace = path.join(folder, 'workspace');
  fs.mkdirSync(workspace, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(workspace, 'SOUL.md'), composeSoul(fs.readFileSync(baseFile, 'utf8'), fs.readFileSync(appendixFile, 'utf8')), {mode: 0o600});
  config.agents.entries ??= {};
  config.agents.ownership = 'explicit';
  if (fullAccess) {
    config.tools = {
      ...(config.tools ?? {}),
      profile: 'full',
      fs: {workspaceOnly: false},
      exec: {security: 'full', ask: 'off'},
    };
    delete config.tools.deny;
    const prevRemote = {...config.agents.entries.remote};
    delete prevRemote.tools;
    config.agents.entries.remote = {...prevRemote, name: '大肥鱼 · 跨设备任务', workspace, tools: {profile: 'full'}};
  } else {
    config.agents.entries.remote = {...config.agents.entries.remote, name: '大肥鱼 · 跨设备任务', workspace, tools: {allow: [...REMOTE_TOOLS]}};
  }
  config.plugins.allow = [...new Set([...(config.plugins?.allow ?? []), 'anylink-peer-search'])];
  config.plugins.load ??= {};
  config.plugins.load.paths = [...new Set([...rewriteLegacyPluginPaths(config.plugins.load.paths, root), path.join(root, 'examples/mac-openclaw/peer')])];
  config.plugins.entries ??= {};
  if (!config.plugins.entries['anylink-peer-search']?.enabled) config.plugins.entries['anylink-peer-search'] = {enabled: true, config: {projectRoot: root}};
  const backup = configFile + '.before-remote-' + new Date().toISOString().replaceAll(/[:.]/g, '-');
  fs.copyFileSync(configFile, backup); fs.chmodSync(backup, 0o600);
  const temp = configFile + '.remote-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'}); fs.renameSync(temp, configFile);
  return {agent: 'remote', fullAccess, tools: fullAccess ? 'full' : REMOTE_TOOLS.length, workspace};
}
function main() {
  const fullAccess = process.argv.includes('--full-access') || process.env.ANYLINK_MAC_FULL_ACCESS === '1';
  const file = path.join(paths.state, 'openclaw.json');
  const folder = path.join(paths.root, 'data/mac/remote');
  const result = installRemoteAgent({
    configFile: file,
    folder,
    root: paths.root,
    baseFile: path.join(paths.root, 'examples/persona/dafeiyu.md'),
    appendixFile: path.join(paths.root, 'examples/mac-openclaw/persona-remote.md'),
    fullAccess,
  });
  console.log(JSON.stringify({configured: true, ...result}));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
