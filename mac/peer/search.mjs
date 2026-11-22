import fs from 'node:fs/promises';
import path from 'node:path';

export class PeerFailure extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, {status, code}); }
}
const scopes = new Set(['all', 'desktop', 'documents', 'downloads', 'projects', 'workspace']);
const excluded = new Set(['node_modules', 'vendor', 'secrets', 'data', 'backups', 'artifacts', 'dist', 'build', 'unpackage', 'Library', 'Applications']);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
export function searchInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['query', 'scope', 'limit'].includes(k))) throw new PeerFailure(400, 'INVALID_SEARCH', '搜索参数不正确');
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query || query.length > 120 || /[\x00-\x1f\/\\]/u.test(query)) throw new PeerFailure(400, 'INVALID_SEARCH', '请提供不含路径的文件名关键词');
  const scope = input.scope ?? 'all', limit = input.limit ?? 20;
  if (!scopes.has(scope) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new PeerFailure(400, 'INVALID_SEARCH', '搜索范围或结果数量不正确');
  return {query, scope, limit};
}

// No shell, file-content API or symlink following. The Mac owns the roots and
// traversal budget; the peer supplies only a literal filename query + scope ID.
export async function searchFiles(input, policy, {signal, maxEntries = 40000, maxMs = 10000} = {}) {
  input = searchInput(input);
  const selected = policy.roots.filter(r => input.scope === 'all' || r.id === input.scope);
  if (!selected.length) throw new PeerFailure(403, 'SEARCH_SCOPE_DENIED', 'Mac 未开放这个搜索范围');
  const terms = input.query.normalize('NFKC').toLowerCase().split(/\s+/u), matches = [], warnings = [], queue = [];
  const started = Date.now(), visited = new Set(); let scanned = 0, partialReason = null;
  const roots = [];
  for (const root of selected) {
    try { const canonical = await fs.realpath(root.path); if (!(await fs.stat(canonical)).isDirectory()) continue; roots.push({id: root.id, label: root.label, path: canonical}); queue.push({root: canonical, folder: canonical, id: root.id, depth: 0}); }
    catch { warnings.push({scope: root.id, reason: 'directory_unavailable'}); }
  }
  while (queue.length) {
    if (signal?.aborted) throw new PeerFailure(409, 'SEARCH_CANCELLED', '搜索已停止');
    if (Date.now() - started >= maxMs || scanned >= maxEntries) { partialReason = scanned >= maxEntries ? 'entry_limit' : 'time_limit'; break; }
    const current = queue.shift(); if (visited.has(current.folder)) continue; visited.add(current.folder);
    let entries;
    try {
      const actual = await fs.realpath(current.folder);
      if (!inside(current.root, actual) || (await fs.lstat(current.folder)).isSymbolicLink()) continue;
      entries = await fs.readdir(current.folder, {withFileTypes: true});
    } catch { warnings.push({scope: current.id, reason: 'directory_unreadable'}); continue; }
    for (const entry of entries) {
      if (signal?.aborted) throw new PeerFailure(409, 'SEARCH_CANCELLED', '搜索已停止');
      if (++scanned > maxEntries || Date.now() - started >= maxMs) { partialReason = scanned > maxEntries ? 'entry_limit' : 'time_limit'; break; }
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || excluded.has(entry.name)) continue;
      const file = path.join(current.folder, entry.name);
      if (entry.isDirectory()) { if (current.depth < 18) queue.push({...current, folder: file, depth: current.depth + 1}); else partialReason ??= 'depth_limit'; continue; }
      if (!entry.isFile() || !terms.every(term => entry.name.normalize('NFKC').toLowerCase().includes(term))) continue;
      try {
        const actual = await fs.realpath(file), stat = await fs.lstat(file);
        if (!inside(current.root, actual) || stat.isSymbolicLink() || !stat.isFile()) continue;
        matches.push({name: entry.name, path: actual, relative_path: path.relative(current.root, actual), scope: current.id, size: stat.size, modified_at: stat.mtime.toISOString()});
        if (matches.length >= input.limit) { partialReason = 'result_limit'; break; }
      } catch { /* A file moved during this read-only search; omit it. */ }
    }
    if (['entry_limit', 'time_limit', 'result_limit'].includes(partialReason)) break;
  }
  return {query: input.query, scope: input.scope, read_only: true, name_only: true, roots, matches, scanned_entries: scanned, coverage: {hidden: false, symlinks: false, excluded_directory_names: [...excluded]}, partial: !!partialReason || warnings.length > 0, partial_reason: partialReason, warnings: warnings.slice(0, 8), duration_ms: Date.now() - started};
}
