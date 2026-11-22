import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateConnection} from '../core/protocol.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), secret = path.join(root, 'secrets');
if (!process.argv.includes('--preview')) throw new Error('For the current milestone use --preview. Register a real phone only when it is available.');
const file = path.join(secret, 'android-preview-connection.json'), requestFile = path.join(secret, 'android-preview-pair-request.json');
fs.mkdirSync(secret, {recursive: true, mode: 0o700});
if (fs.existsSync(file)) { validateConnection(JSON.parse(fs.readFileSync(file))); console.log('Android preview binding already exists; no credentials rotated.'); process.exit(0); }
const request = fs.existsSync(requestFile) ? JSON.parse(fs.readFileSync(requestFile)) : {name: 'Android 开发预览（未绑定真机）', key: crypto.randomUUID()};
fs.writeFileSync(requestFile, JSON.stringify(request), {mode: 0o600});
const program = `import json,sys,uuid,urllib.request,http.cookiejar\nfrom pathlib import Path\nv=json.load(sys.stdin)\nop=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))\ndef api(path,body,key=None):\n req=urllib.request.Request('http://127.0.0.1:3180'+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Idempotency-Key':key or str(uuid.uuid4())})\n with op.open(req,timeout=20) as r:return json.load(r)\napi('/v1/auth/login',{'token':Path('/opt/anylink-agent/secrets/owner-token').read_text().strip()})\nd=api('/v1/devices',{'name':v['name'],'platform':'android'},v['key'])\nc=api('/v1/devices/'+d['id']+'/credential',{})\napi('/v1/auth/logout',{})\nprint(json.dumps(c))\n`;
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
let value;
try { value = execFileSync('/usr/bin/ssh', ['-o', 'BatchMode=yes', 'ywc', 'python3 -c ' + quote(program)], {input: JSON.stringify(request), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000}); }
catch { throw new Error('Preview credential issuance was not confirmed. No automatic retry or rotation; inspect the existing device record first.'); }
const bound = JSON.parse(value), connection = validateConnection({server: 'http://127.0.0.1:5180', device_id: bound.device_id, token: bound.token});
fs.writeFileSync(file, JSON.stringify(connection, null, 2) + '\n', {mode: 0o600});
console.log(JSON.stringify({created: true, preview_only: true, device_id: connection.device_id, secret_file: file}));
