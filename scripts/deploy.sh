#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
folder=${1:?Usage: scripts/deploy.sh artifacts/COMMIT [SSH_ALIAS]}
host=${2:-ywc}
short=$(basename "$folder")
[[ "$short" =~ ^[a-f0-9]{12}$ ]] || { printf 'Invalid release ID\n' >&2; exit 1; }
remote="/opt/anylink-agent/releases/$short"
ssh -o BatchMode=yes "$host" "mkdir -p '$remote'"
scp "$folder"/{images.tar.gz,compose.yaml,openclaw.json,release.env,remote-up.sh,manifest.json,SHA256SUMS} "$host:$remote/"
ssh -o BatchMode=yes "$host" "cd '$remote' && sha256sum -c SHA256SUMS && gzip -dc images.tar.gz | docker load && bash remote-up.sh '$remote'"
