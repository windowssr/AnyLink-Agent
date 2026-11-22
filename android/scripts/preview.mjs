import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), assets = path.join(root, 'unpackage/dist/build/h5');
const origin = 'http://127.0.0.1:5180', upstream = 'http://127.0.0.1:3181';
if (!fs.existsSync(path.join(assets, 'index.html'))) throw new Error('Run npm run build:preview first.');
const mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm'};
const server = http.createServer(async (req, res) => {
  const error = status => { if (!res.headersSent) res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: {code: 'PREVIEW_REQUEST_REJECTED'}})); };
  try {
    if (req.headers.host !== '127.0.0.1:5180' || (req.headers.origin && req.headers.origin !== origin)) return error(403);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    const url = new URL(req.url, origin);
    if (url.pathname === '/__anylink/preview-binding') {
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-anylink-preview'] !== '1') return error(403);
      const secret = path.join(root, '../secrets/android-preview-connection.json');
      if (!fs.existsSync(secret)) return error(404);
      res.writeHead(200, {'Content-Type': 'application/json'}); res.end(fs.readFileSync(secret)); return;
    }
    if (url.pathname.startsWith('/anylink-peer/')) {
      if (!['/anylink-peer/v1/files/search', '/anylink-peer/v1/capabilities'].includes(url.pathname) || !['GET', 'POST'].includes(req.method)) return error(404);
      if (!/^Bearer ap_[A-Za-z0-9_-]+$/.test(req.headers.authorization ?? '')) return error(401);
      const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const headers = {Authorization: req.headers.authorization};
      for (const name of ['content-type', 'idempotency-key', 'x-anylink-peer-device', 'x-anylink-target-device']) if (req.headers[name]) headers[name] = req.headers[name];
      const response = await fetch('http://127.0.0.1:18791' + url.pathname, {method: req.method, headers, body: req.method === 'GET' ? undefined : req, duplex: 'half', signal: controller.signal, redirect: 'error'});
      res.writeHead(response.status, {'Content-Type': response.headers.get('content-type') ?? 'application/json'});
      if (response.body) await pipeline(response.body, res); else res.end(); return;
    }
    if (/^\/(edge|model)\/v1\/[a-z0-9/_-]+$/i.test(url.pathname)) {
      if (!/^Bearer ak_[A-Za-z0-9_-]+$/.test(req.headers.authorization ?? '')) return error(401);
      const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const headers = {Authorization: req.headers.authorization};
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      for (const name of ['idempotency-key', 'if-match']) if (req.headers[name]) headers[name] = req.headers[name];
      const response = await fetch(upstream + url.pathname, {method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : req, duplex: 'half', signal: controller.signal, redirect: 'error'});
      res.writeHead(response.status, {'Content-Type': response.headers.get('content-type') ?? 'application/json'});
      if (response.body) await pipeline(response.body, res); else res.end(); return;
    }
    if (req.method !== 'GET') return error(405);
    const file = path.resolve(assets, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return error(404);
    res.writeHead(200, {'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream'}); await pipeline(fs.createReadStream(file), res);
  } catch { if (!res.headersSent) error(502); else res.destroy(); }
});
server.listen(5180, '127.0.0.1', () => console.log('Android desktop preview: ' + origin + ' (loopback only; cloud via existing SSH tunnel)'));
