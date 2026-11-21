#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then printf 'Commit source before making a release.\n' >&2; exit 1; fi
revision=$(git rev-parse HEAD)
short=${revision:0:12}
folder="artifacts/$short"
mkdir -p "$folder"
npm ci --no-audit --no-fund
npm run check
npm run build
node scripts/prepare-runtime.mjs
gateway_source=ghcr.io/openclaw/openclaw@sha256:65e229536a2698f0ab211c8a3d1c5c8e2685d19379d153e95f93ff76f22779cf
postgres_source=postgres@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb
docker build --platform linux/amd64 -t "anylink-agent:$short" .
images=("anylink-agent:$short")
gateway_runtime=$gateway_source
postgres_runtime=$postgres_source
if [ "${BUNDLE_UPSTREAM:-0}" = 1 ]; then
  docker pull --platform linux/amd64 "$gateway_source"
  docker pull --platform linux/amd64 "$postgres_source"
  docker tag "$gateway_source" anylink-openclaw:2026.11.6
  docker tag "$postgres_source" anylink-postgres:16
  gateway_runtime=anylink-openclaw:2026.11.6
  postgres_runtime=anylink-postgres:16
  images+=("$gateway_runtime" "$postgres_runtime")
fi
docker save --platform linux/amd64 "${images[@]}" | gzip -1 > "$folder/images.tar.gz"
cp deploy/compose.yaml deploy/openclaw.json scripts/remote-up.sh "$folder/"
printf 'APP_IMAGE=anylink-agent:%s\nOPENCLAW_IMAGE=%s\nPOSTGRES_IMAGE=%s\n' "$short" "$gateway_runtime" "$postgres_runtime" > "$folder/release.env"
node --input-type=module - "$revision" "$folder" <<'JS'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [revision,folder]=process.argv.slice(2);
const imageId=execFileSync('docker',['image','inspect','--format','{{.Id}}',`anylink-agent:${revision.slice(0,12)}`],{encoding:'utf8'}).trim();
fs.writeFileSync(`${folder}/manifest.json`,JSON.stringify({version:'0.1.0',revision,app_image_id:imageId,platform:'linux/amd64',built_at:new Date().toISOString(),gateway:'2026.11.6',gateway_digest:'sha256:65e229536a2698f0ab211c8a3d1c5c8e2685d19379d153e95f93ff76f22779cf',postgres_digest:'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb',model:'deepseek/deepseek-flash'},null,2)+'\n');
JS
(cd "$folder" && shasum -a 256 images.tar.gz compose.yaml openclaw.json release.env remote-up.sh manifest.json > SHA256SUMS)
printf 'Release ready: %s\n' "$folder"
