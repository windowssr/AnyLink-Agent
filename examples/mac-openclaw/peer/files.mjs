import fs from 'node:fs/promises';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PeerFailure, excluded} from './search.mjs';

const execFileAsync = promisify(execFile);
const inside = (root, file) => root === path.sep ? file.startsWith(path.sep) : (file === root || file.startsWith(root + path.sep));
const bad = (code, message) => new PeerFailure(400, code, message);

function segments(relative) {
  const parts = String(relative).normalize('NFC').split(/[\\/]+/u).filter(s => s && s !== '.');
  if (parts.includes('..') || parts.some(s => s.startsWith('.') || excluded.has(s)))
    throw bad('PATH_DENIED', '路径包含隐藏、排除目录或越级片段');
  return parts;
}

// Resolve "<rootId>:<relative>" or an absolute path to a verified location inside
// a policy root. Returns {root, abs, segs}; `abs` is root-realpath + validated segs.
export async function resolveInRoots(raw, roots) {
  const text = String(raw ?? '').normalize('NFC').trim();
  if (!text || text.length > 4096) throw bad('INVALID_PATH', '路径不正确');
  let root, rel;
  const prefixed = text.match(/^([A-Za-z0-9_-]+):(.*)$/su);
  if (prefixed && roots.some(r => r.id === prefixed[1])) {
    root = roots.find(r => r.id === prefixed[1]); rel = prefixed[2];
  } else if (path.isAbsolute(text)) {
    const abs = path.resolve(text);
    root = roots.find(r => inside(r.path, abs));
    if (!root) throw new PeerFailure(403, 'OUTSIDE_ROOT', '路径不在 Mac 开放目录内');
    rel = path.relative(root.path, abs);
  } else throw bad('INVALID_PATH', '需要绝对路径或 <范围ID>:<相对路径>');
  const segs = segments(rel);
  const abs = segs.length ? path.join(root.path, ...segs) : root.path;
  return {root, abs, segs};
}

// Verify existing components below the root are not symlinks and that the nearest
// existing ancestor resolves inside the root. Returns the fully resolved path.
async function verify(abs, rootReal, {mustExist = false} = {}) {
  if (!inside(rootReal, abs)) throw new PeerFailure(403, 'OUTSIDE_ROOT', '路径不在 Mac 开放目录内');
  let cursor = abs;
  const tail = [];
  for (;;) {
    try { lstatSync(cursor); break; } catch {
      tail.unshift(path.basename(cursor)); cursor = path.dirname(cursor);
      if (!inside(rootReal, cursor)) throw new PeerFailure(403, 'OUTSIDE_ROOT', '路径不在 Mac 开放目录内');
    }
  }
  // lstat every existing component from the root down to the deepest existing ancestor.
  let current = rootReal;
  for (const seg of path.relative(rootReal, cursor).split(path.sep).filter(Boolean)) {
    current = path.join(current, seg);
    const st = await fs.lstat(current).catch(() => null);
    if (!st) break;
    if (st.isSymbolicLink()) throw new PeerFailure(403, 'SYMLINK_DENIED', '不允许通过符号链接访问');
  }
  const realAncestor = await fs.realpath(cursor);
  if (!inside(rootReal, realAncestor)) throw new PeerFailure(403, 'OUTSIDE_ROOT', '路径解析后越出开放目录');
  const resolved = tail.length ? path.join(realAncestor, ...tail) : realAncestor;
  if (mustExist) {
    const st = await fs.lstat(resolved).catch(() => null);
    if (!st) throw new PeerFailure(404, 'NOT_FOUND', '文件不存在');
    const real = await fs.realpath(resolved);
    if (!inside(rootReal, real)) throw new PeerFailure(403, 'OUTSIDE_ROOT', '路径解析后越出开放目录');
    return {resolved: real, stat: st};
  }
  return {resolved, stat: null};
}

async function resolveOp(raw, policy, opts = {}) {
  if (policy?.full_access === true) {
    const text = String(raw ?? '').normalize('NFC').trim();
    if (!text || text.length > 4096) throw bad('INVALID_PATH', '路径不正确');
    let target = text;
    const prefixed = text.match(/^([A-Za-z0-9_-]+):(.*)$/su);
    if (prefixed && (policy.roots ?? []).some(r => r.id === prefixed[1])) {
      const root = policy.roots.find(r => r.id === prefixed[1]);
      target = path.resolve(root.path, prefixed[2].replace(/^[/\\]+/, ''));
    } else if (text === '~' || text.startsWith('~/')) {
      target = path.join(os.homedir(), text.slice(2));
    } else if (!path.isAbsolute(text)) {
      target = path.resolve(os.homedir(), text);
    }
    const resolved = path.resolve(target);
    let stat = null;
    if (opts.mustExist) {
      stat = await fs.lstat(resolved).catch(() => null);
      if (!stat) throw new PeerFailure(404, 'NOT_FOUND', '文件不存在');
    }
    return {root: {id: 'full', label: '本机全盘', path: path.parse(resolved).root}, resolved, stat};
  }
  const roots = [];
  for (const r of policy.roots ?? []) {
    try { const real = await fs.realpath(r.path); if ((await fs.stat(real)).isDirectory()) roots.push({...r, path: real}); } catch { /* unavailable root */ }
  }
  if (!roots.length) throw new PeerFailure(503, 'ROOTS_UNAVAILABLE', 'Mac 开放目录不可用');
  const {root, abs} = await resolveInRoots(raw, roots);
  const {resolved, stat} = await verify(abs, root.path, opts);
  return {root, resolved, stat};
}

const wrap = async fn => { try { return await fn(); } catch (e) { if (e instanceof PeerFailure) throw e; const code = e?.code ?? ''; const map = {ENOENT: ['NOT_FOUND', '文件不存在'], ENOTDIR: ['NOT_DIRECTORY', '路径不是目录'], EISDIR: ['IS_DIRECTORY', '路径是目录'], EACCES: ['FORBIDDEN', '没有权限'], EPERM: ['FORBIDDEN', '没有权限'], EEXIST: ['FILE_EXISTS', '文件已存在'], ENOSPC: ['NO_SPACE', '磁盘空间不足'], ELOOP: ['SYMLINK_DENIED', '不允许符号链接']}; if (map[code]) throw new PeerFailure(code === 'EEXIST' ? 409 : 400, map[code][0], map[code][1]); throw e; } };

export async function listFiles(input, policy) {
  return wrap(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['path', 'limit'].includes(k))) throw bad('INVALID_INPUT', '参数不正确');
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('INVALID_INPUT', 'limit 需为 1 到 200 的整数');
    const {resolved, stat} = await resolveOp(input.path, policy, {mustExist: true});
    if (!stat.isDirectory()) throw new PeerFailure(400, 'NOT_DIRECTORY', '路径不是目录');
    const names = (await fs.readdir(resolved)).sort((a, b) => a.localeCompare(b, 'zh'));
    const entries = [], skipped = [];
    const unrestricted = policy?.full_access === true;
    for (const name of names) {
      if (!unrestricted && (name.startsWith('.') || excluded.has(name))) continue;
      if (unrestricted && name.startsWith('.')) continue;
      const file = path.join(resolved, name);
      const st = await fs.lstat(file).catch(() => null);
      if (!st || (!unrestricted && st.isSymbolicLink())) { skipped.push(name); continue; }
      entries.push({name, type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file', size: st.isFile() ? st.size : null, modified_at: st.mtime.toISOString()});
      if (entries.length >= limit) break;
    }
    return {path: resolved, entries, truncated: entries.length >= limit || skipped.length > 0, skipped: skipped.slice(0, 20)};
  });
}

export async function readFile(input, policy) {
  return wrap(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['path', 'offset', 'max_bytes'].includes(k))) throw bad('INVALID_INPUT', '参数不正确');
    const offset = input.offset ?? 0, maxBytes = input.max_bytes ?? 60000;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 200000) throw bad('INVALID_INPUT', 'offset 或 max_bytes 不正确');
    const {resolved, stat} = await resolveOp(input.path, policy, {mustExist: true});
    if (!stat.isFile()) throw new PeerFailure(400, 'NOT_FILE', '路径不是普通文件');
    const fh = await fs.open(resolved, 'r');
    try {
      const head = Buffer.alloc(8192);
      const {bytesRead} = await fh.read(head, 0, 8192, 0);
      if (head.subarray(0, bytesRead).includes(0)) throw new PeerFailure(400, 'BINARY_FILE', '这是二进制文件，不能按文本读取');
      const length = Math.min(maxBytes, Math.max(0, stat.size - offset));
      const buf = Buffer.alloc(length);
      if (length) await fh.read(buf, 0, length, offset);
      return {path: resolved, size: stat.size, offset, bytes: length, truncated: offset + length < stat.size, content: buf.toString('utf8')};
    } finally { await fh.close(); }
  });
}

export async function writeFile(input, policy) {
  return wrap(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['path', 'content', 'mode', 'create_parents'].includes(k))) throw bad('INVALID_INPUT', '参数不正确');
    const mode = input.mode ?? 'create', createParents = input.create_parents === true;
    if (!['create', 'overwrite', 'append'].includes(mode)) throw bad('INVALID_INPUT', 'mode 需为 create、overwrite 或 append');
    const content = typeof input.content === 'string' ? input.content : null;
    if (content === null || Buffer.byteLength(content) > 1024 * 1024) throw bad('INVALID_INPUT', 'content 需为不超过 1 MiB 的字符串');
    const {root, resolved} = await resolveOp(input.path, policy);
    if (mode !== 'append') {
      const existing = await fs.lstat(resolved).catch(() => null);
      if (existing?.isDirectory()) throw new PeerFailure(400, 'IS_DIRECTORY', '目标是目录');
      if (mode === 'create' && existing) throw new PeerFailure(409, 'FILE_EXISTS', '文件已存在');
      if (mode === 'overwrite' && existing?.isSymbolicLink()) throw new PeerFailure(403, 'SYMLINK_DENIED', '不允许符号链接');
    }
    const dir = path.dirname(resolved);
    if (createParents) await fs.mkdir(dir, {recursive: true});
    else await fs.mkdir(dir, {recursive: false}).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const realDir = await fs.realpath(dir);
    if (!inside(root.path, realDir)) throw new PeerFailure(403, 'OUTSIDE_ROOT', '父目录解析后越出开放目录');
    if (mode === 'append') { await fs.appendFile(resolved, content); return {path: resolved, bytes: Buffer.byteLength(content), action: 'appended'}; }
    const temp = path.join(dir, `.${path.basename(resolved)}.anylink-${process.pid}-${Date.now()}`);
    await fs.writeFile(temp, content, {mode: 0o600});
    try { await fs.rename(temp, resolved); } catch (e) { await fs.rm(temp, {force: true}).catch(() => {}); throw e; }
    return {path: resolved, bytes: Buffer.byteLength(content), action: mode === 'create' ? 'created' : 'overwritten'};
  });
}

export async function makeDir(input, policy) {
  return wrap(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['path'].includes(k))) throw bad('INVALID_INPUT', '参数不正确');
    const {resolved} = await resolveOp(input.path, policy);
    const existed = await fs.lstat(resolved).then(() => true, () => false);
    if (existed) {
      const st = await fs.lstat(resolved);
      if (!st.isDirectory()) throw new PeerFailure(409, 'FILE_EXISTS', '同名文件已存在');
      return {path: resolved, action: 'exists'};
    }
    await fs.mkdir(resolved, {recursive: true});
    return {path: resolved, action: 'created'};
  });
}

export async function moveFile(input, policy) {
  return wrap(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['from', 'to', 'overwrite'].includes(k))) throw bad('INVALID_INPUT', '参数不正确');
    const overwrite = input.overwrite === true;
    const from = await resolveOp(input.from, policy, {mustExist: true});
    if (from.resolved === from.root.path) throw new PeerFailure(403, 'ROOT_DENIED', '不能移动开放目录本身');
    let to = await resolveOp(input.to, policy);
    let existingTo = await fs.lstat(to.resolved).then(s => s, () => null);
    if (existingTo?.isDirectory()) to = await resolveOp(input.to.replace(/\/+$/, '') + '/' + path.basename(from.resolved), policy);
    if (to.resolved === to.root.path) throw new PeerFailure(403, 'ROOT_DENIED', '不能移动到开放目录本身');
    const targetStat = await fs.lstat(to.resolved).then(s => s, () => null);
    if (targetStat?.isDirectory()) throw new PeerFailure(400, 'IS_DIRECTORY', '目标位置已是目录');
    if (targetStat && !overwrite) throw new PeerFailure(409, 'FILE_EXISTS', '目标已存在');
    try { await fs.rename(from.resolved, to.resolved); }
    catch (e) { if (e.code === 'EXDEV') throw new PeerFailure(409, 'CROSS_DEVICE', '跨设备移动不支持，请改用复制'); throw e; }
    return {from: from.resolved, to: to.resolved, action: 'moved'};
  });
}

export async function trashFile(input, policy, {trashDir = path.join(os.homedir(), '.Trash')} = {}) {
  return wrap(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['path'].includes(k))) throw bad('INVALID_INPUT', '参数不正确');
    const {root, resolved} = await resolveOp(input.path, policy, {mustExist: true});
    if (resolved === root.path) throw new PeerFailure(403, 'ROOT_DENIED', '不能删除开放目录本身');
    await fs.mkdir(trashDir, {recursive: true});
    const base = path.basename(resolved), stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    let dest = path.join(trashDir, base), n = 0;
    while (true) {
      const taken = await fs.lstat(dest).then(() => true, () => false);
      if (!taken) break;
      dest = path.join(trashDir, `${base} ${stamp}${n ? `-${n}` : ''}`); n++;
      if (n > 100) throw new PeerFailure(409, 'TRASH_CONFLICT', '废纸篓命名冲突');
    }
    await fs.rename(resolved, dest);
    return {from: resolved, to: dest, action: 'trashed'};
  });
}

export async function openPath(input, policy, {exec = execFileAsync} = {}) {
  return wrap(async () => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['path'].includes(k))) throw bad('INVALID_INPUT', '参数不正确');
    const {resolved} = await resolveOp(input.path, policy, {mustExist: true});
    await exec('/usr/bin/open', [resolved], {timeout: 10000});
    return {path: resolved, action: 'opened'};
  });
}

export const fileOps = {list: listFiles, read: readFile, write: writeFile, mkdir: makeDir, move: moveFile, trash: trashFile, open: openPath};
export {PeerFailure};
