"""Run on ywc only, after stopping AnyLink Gateway. Never recover a running holder."""
import argparse
import json
import re
import subprocess
from pathlib import Path

p=argparse.ArgumentParser()
p.add_argument('--confirm-stopped',action='store_true',required=True)
p.parse_args()
current=subprocess.run(['docker','inspect','--format','{{.State.Running}}','anylink-agent-openclaw-1'],capture_output=True,text=True)
if current.returncode==0 and current.stdout.strip()=='true':raise SystemExit('Stop the AnyLink Gateway container before recovery')
base=Path('/opt/anylink-agent')
image='ghcr.io/openclaw/openclaw@sha256:65e229536a2698f0ab211c8a3d1c5c8e2685d19379d153e95f93ff76f22779cf'
command=['docker','run','--rm','--memory','768m','--entrypoint','node','--env-file',str(base/'secrets/gateway.env'),'-e','OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json','-e','OPENCLAW_NO_RESPAWN=1','-e','NODE_COMPILE_CACHE=/home/node/.openclaw/compile-cache','-e','NODE_OPTIONS=--max-old-space-size=256 --max-semi-space-size=8','-v',str(base/'data/openclaw')+':/home/node/.openclaw',image,'openclaw.mjs','gateway','recover-lock']
def run(extra):
    r=subprocess.run(command+extra,capture_output=True,text=True,timeout=90)
    if r.returncode:raise SystemExit('Upstream lock inspection/recovery failed; inspect service diagnostics')
    return json.loads(r.stdout)
inspection=run(['--json'])
if not inspection.get('present'):
    print(json.dumps({'present':False}));raise SystemExit(0)
holders=inspection.get('holders',[])
if not holders:raise SystemExit('No verifiable stopped container identity found')
for holder in holders:
    found=re.search(r'at ([a-f0-9]{12})/pid-ns',holder)
    if not found:raise SystemExit('Holder identity requires manual inspection')
    old=subprocess.run(['docker','inspect','--format','{{.State.Running}}',found.group(1)],capture_output=True,text=True)
    if old.returncode==0 and old.stdout.strip()=='true':raise SystemExit('A recorded holder is still running; recovery refused')
result=run(['--confirm',inspection['confirmation'],'--json'])
print(json.dumps({'stopped_holders_verified':True,**result}))
