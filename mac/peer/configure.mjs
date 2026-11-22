import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {paths} from '../configure.mjs';
import {digest} from './service.mjs';
import {validateConnection} from '../../android/core/protocol.mjs';
const configFile = path.join(paths.state, 'openclaw.json'), config = JSON.parse(fs.readFileSync(configFile));
if (config.gateway?.port !== 18791 || config.gateway?.bind !== 'loopback') throw new Error('Unexpected local Gateway profile');
const mac = JSON.parse(fs.readFileSync(paths.connection)), clientFile = path.join(paths.root, 'secrets/android-preview-connection.json');
const client = validateConnection(JSON.parse(fs.readFileSync(clientFile)));
if (mac.device_id === client.device_id) throw new Error('A peer must have its own device identity');
const file = path.join(paths.root, 'secrets/mac-peer-policy.json'), existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
if (existing && existing.device_id !== mac.device_id) throw new Error('Peer policy belongs to another Mac');
const token = client.mac_peer?.token ?? 'ap_' + randomBytes(32).toString('base64url');
const roots = existing?.roots ?? [
  {id: 'desktop', label: '桌面', path: path.join(os.homedir(), 'Desktop')},
  {id: 'documents', label: '文稿', path: path.join(os.homedir(), 'Documents')},
  {id: 'downloads', label: '下载', path: path.join(os.homedir(), 'Downloads')},
  {id: 'projects', label: '项目目录', path: path.dirname(paths.root)},
  {id: 'workspace', label: 'AnyLink 工作区', path: paths.workspace},
];
const policy = {...existing, version: 1, device_id: mac.device_id, name: '我的 Mac', roots, peers: existing?.peers ?? []};
const grant = {device_id: client.device_id, token_hash: digest(token), capabilities: ['files.search'], enabled: true};
const previous = policy.peers.findIndex(p => p.device_id === client.device_id);
if (previous < 0) policy.peers.push(grant); else policy.peers[previous] = {...policy.peers[previous], ...grant};
config.plugins.allow = [...new Set([...config.plugins.allow, 'anylink-peer-search'])];
config.plugins.load.paths = [...new Set([...config.plugins.load.paths, path.join(paths.root, 'mac/peer')])];
config.plugins.entries['anylink-peer-search'] = {enabled: true, config: {projectRoot: paths.root}};
const backup = path.join(paths.state, 'openclaw.before-peer-search.json');
if (!fs.existsSync(backup)) fs.writeFileSync(backup, fs.readFileSync(configFile), {mode: 0o600});
const save = (name, value) => { const temp = name + '.peer'; fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600}); fs.renameSync(temp, name); };
save(file, policy); save(configFile, config);
save(clientFile, {...client, mac_peer: {server: client.server, device_id: mac.device_id, name: policy.name, token}});
console.log(JSON.stringify({configured: true, capability: 'files.search', read_only: true, scopes: roots.map(r => ({id: r.id, label: r.label})), gateway_still_loopback: true, independent_peer_credential: true}));
