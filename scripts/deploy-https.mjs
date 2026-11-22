import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {isIP} from 'node:net';
const {values}=parseArgs({options:{host:{type:'string',default:'ywc'},ip:{type:'string'}}});
if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/.test(values.host)||isIP(values.ip??'')!==4)throw new Error('Use --host SSH_ALIAS --ip PUBLIC_IPV4');
const lock=JSON.parse(fs.readFileSync('deploy/https/runtime-lock.json','utf8'));
const archive=path.resolve('data/https',lock.archive);
if(createHash('sha256').update(fs.readFileSync(archive)).digest('hex')!==lock.sha256)throw new Error('Official Caddy archive checksum mismatch');
const prefix='/opt/anylink-agent-https',ssh=['-o','BatchMode=yes','-o','ConnectTimeout=10',values.host];
const run=(cmd,args,options={})=>execFileSync(cmd,args,{...options,stdio:options.input===undefined?'inherit':['pipe','inherit','inherit']});
run('ssh',[...ssh,'python3 -'],{input:`from pathlib import Path
import socket
p=Path('${prefix}')
if p.exists() and not (p/'.anylink-component').exists(): raise SystemExit('Preserving unrelated HTTPS directory')
if not p.exists():
 s=socket.socket(); s.bind(('0.0.0.0',443)); s.close()
 p.mkdir(mode=0o755)
p.chmod(0o755)
(p/'.anylink-component').write_text('AnyLink HTTPS'+chr(10))
(p/'staging').mkdir(mode=0o700,exist_ok=True)
print('AnyLink HTTPS staging ready')
`});
run('scp',[archive,'deploy/https/Caddyfile','deploy/https/anylink-agent-https.service','deploy/https/runtime-lock.json',`${values.host}:${prefix}/staging/`]);
const payload=Buffer.from(JSON.stringify({ip:values.ip,sha256:lock.sha256,archive:lock.archive,prefix,version:lock.version})).toString('base64');
const apply=String.raw`import base64,json,hashlib,tarfile,os,subprocess,time,shutil
from pathlib import Path
cfg=json.loads(base64.b64decode('__PAYLOAD__'))
p=Path(cfg['prefix']); staging=p/'staging'; archive=staging/cfg['archive']
assert (p/'.anylink-component').read_text()=='AnyLink HTTPS'+chr(10)
assert hashlib.sha256(archive.read_bytes()).hexdigest()==cfg['sha256']
unit=Path('/etc/systemd/system/anylink-agent-https.service')
if unit.exists() and 'ExecStart=/opt/anylink-agent-https/caddy run ' not in unit.read_text(): raise SystemExit('Preserving unrelated systemd unit')
backup=p/'backups'/str(int(time.time())); backup.mkdir(parents=True,exist_ok=True)
for file in [p/'Caddyfile',p/'public.env',unit]:
 if file.exists(): shutil.copy2(file,backup/file.name)
with tarfile.open(archive) as tar:
 member=tar.getmember('caddy'); assert member.isfile()
 target=p/'caddy.new'
 with tar.extractfile(member) as source, target.open('wb') as dest: shutil.copyfileobj(source,dest)
 target.chmod(0o755); os.replace(target,p/'caddy')
 for name in ['LICENSE','NOTICE','README.md']:
  try: member=tar.getmember(name)
  except KeyError: continue
  assert member.isfile()
  (p/name).write_bytes(tar.extractfile(member).read())
version=subprocess.check_output([str(p/'caddy'),'version'],text=True).strip()
assert version.startswith('v'+cfg['version']+' '),version
shutil.copyfile(staging/'Caddyfile',p/'Caddyfile'); (p/'Caddyfile').chmod(0o644)
(p/'public.env').write_text('ANYLINK_PUBLIC_IP='+cfg['ip']+'\n'); (p/'public.env').chmod(0o600)
validation=p/'validation-state';validation.mkdir(mode=0o700,exist_ok=True)
env={**os.environ,'ANYLINK_PUBLIC_IP':cfg['ip'],'STATE_DIRECTORY':str(validation),'XDG_DATA_HOME':str(validation/'data'),'XDG_CONFIG_HOME':str(validation/'config')}
subprocess.run([str(p/'caddy'),'validate','--config',str(p/'Caddyfile'),'--adapter','caddyfile'],env=env,check=True)
shutil.copyfile(staging/'anylink-agent-https.service',unit);unit.chmod(0o644)
subprocess.run(['systemd-analyze','verify',str(unit)],check=True)
subprocess.run(['systemctl','daemon-reload'],check=True)
active=subprocess.run(['systemctl','is-active','--quiet','anylink-agent-https.service']).returncode==0
subprocess.run(['systemctl','enable','anylink-agent-https.service'],check=True)
subprocess.run(['systemctl','reload' if active else 'start','anylink-agent-https.service'],check=True)
(p/'installed.json').write_text(json.dumps({'component':'anylink-agent-https','version':cfg['version'],'archive_sha256':cfg['sha256'],'endpoint':'https://'+cfg['ip'],'certificate_profile':'shortlived','nginx_modified':False},indent=2)+'\n')
print(json.dumps({'started':True,'endpoint':'https://'+cfg['ip'],'trusted_certificate_pending_validation':True,'nginx_modified':False}))
`;
run('ssh',[...ssh,'python3 -'],{input:apply.replace('__PAYLOAD__',payload)});
