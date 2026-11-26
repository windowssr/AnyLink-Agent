import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {configure,paths} from './configure.mjs';
if(fs.existsSync(paths.connection)&&!process.argv.includes('--rotate')){
  console.log('A local binding already exists. Use --rotate only when replacing its service credential.');process.exit(0);
}
fs.mkdirSync(path.dirname(paths.connection),{recursive:true,mode:0o700});
const requestPath=path.join(path.dirname(paths.connection),'mac-pair-request.json');
const request=fs.existsSync(requestPath)?JSON.parse(fs.readFileSync(requestPath,'utf8')):{name:os.hostname()+' · Mac',key:crypto.randomUUID()};
fs.writeFileSync(requestPath,JSON.stringify(request),{mode:0o600});
const program=`import json,sys,uuid,urllib.request,http.cookiejar\nfrom pathlib import Path\nv=json.load(sys.stdin)\nop=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))\ndef api(path,body,key=None):\n req=urllib.request.Request('http://127.0.0.1:3180'+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Idempotency-Key':key or str(uuid.uuid4())})\n with op.open(req,timeout=15) as r:return json.load(r)\napi('/v1/auth/login',{'token':Path('/opt/anylink-agent/secrets/owner-token').read_text().strip()})\nd=api('/v1/devices',{'name':v['name'],'platform':'macos'},v['key'])\nif v.get('rotate'):api('/v1/devices/'+d['id']+'/revoke',{})\nc=api('/v1/devices/'+d['id']+'/credential',{})\napi('/v1/auth/logout',{})\nprint(json.dumps(c))\n`;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const value=execFileSync('/usr/bin/ssh',['-o','BatchMode=yes','ywc','python3 -c '+quote(program)],{input:JSON.stringify({...request,rotate:process.argv.includes('--rotate')}),encoding:'utf8',maxBuffer:100000});
const bound=JSON.parse(value);
configure({server:'http://127.0.0.1:3181',ssh_host:'ywc',device_id:bound.device_id,credential_id:bound.credential_id,token:bound.token});
