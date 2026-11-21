#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
folder=${1:?Usage: scripts/deploy.sh artifacts/COMMIT [SSH_ALIAS]}
host=${2:-ywc}
short=$(basename "$folder")
[[ "$short" =~ ^[a-f0-9]{12}$ ]] || { printf 'Invalid release ID\n' >&2; exit 1; }
remote="/opt/anylink-agent/releases/$short"
ssh -o BatchMode=yes "$host" "mkdir -p '$remote'"
scp "$folder"/{compose.yaml,release.env,remote-up.sh,image-fingerprint.py,live-smoke.py,manifest.json,SHA256SUMS} "$host:$remote/"
mode=$(ssh -o BatchMode=yes "$host" "python3 - '$remote' '$short'" <<'PY'
import json,subprocess,sys
from pathlib import Path
folder=Path(sys.argv[1]);manifest=json.loads((folder/'manifest.json').read_text())
env=dict(line.split('=',1) for line in (folder/'release.env').read_text().splitlines() if '=' in line)
for key in ['POSTGRES_IMAGE']:
    if subprocess.run(['docker','image','inspect',env[key]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        print('missing');raise SystemExit(0)
tags=subprocess.check_output(['docker','image','ls','--filter','reference=anylink-agent:*','--format','{{.Repository}}:{{.Tag}}'],text=True).splitlines()
for tag in tags:
    result=subprocess.run(['python3',str(folder/'image-fingerprint.py'),tag],capture_output=True,text=True)
    if result.returncode==0 and result.stdout.strip()==manifest['app_image_fingerprint']:
        subprocess.run(['docker','tag',tag,'anylink-agent:'+sys.argv[2]],check=True)
        print('cached');raise SystemExit(0)
print('missing')
PY
)
if [ "$mode" = cached ]; then
  ssh -o BatchMode=yes "$host" "cd '$remote' && sed '/  images.tar.gz$/d' SHA256SUMS | sha256sum -c - && bash remote-up.sh '$remote'"
else
  scp "$folder/images.tar.gz" "$host:$remote/images.tar.gz"
  ssh -o BatchMode=yes "$host" "cd '$remote' && sha256sum -c SHA256SUMS && gzip -dc images.tar.gz | docker load && bash remote-up.sh '$remote'"
fi
