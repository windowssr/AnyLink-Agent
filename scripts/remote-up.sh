#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/opt/anylink-agent
release=${1:?Usage: remote-up.sh /opt/anylink-agent/releases/COMMIT}
case "$release" in "$base"/releases/*) ;; *) printf 'Invalid release path\n' >&2; exit 1;; esac
test -f "$release/release.env"
test -f "$base/secrets/app.env"
test -f "$base/secrets/model.env"
test -f "$base/secrets/postgres.env"
mkdir -p "$base/data/postgres" "$base/data/artifacts" "$base/backups"
chown 1000:1000 "$base/data/artifacts" 2>/dev/null || chmod 777 "$base/data/artifacts"
compose=(docker compose --project-name anylink-agent --env-file "$release/release.env" -f "$release/compose.yaml")
source "$release/release.env"
python3 - "$release/manifest.json" "$APP_IMAGE" "$release/image-fingerprint.py" <<'PY'
import json,subprocess,sys
manifest=json.load(open(sys.argv[1]))
actual=subprocess.check_output(['python3',sys.argv[3],sys.argv[2]],text=True).strip()
if actual!=manifest['app_image_fingerprint']:raise SystemExit('App content/config fingerprint does not match release manifest')
PY
for image in "$POSTGRES_IMAGE"; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then docker pull --platform linux/amd64 "$image"; fi
done
if [ "$(docker inspect --format '{{.State.Running}}' anylink-agent-postgres-1 2>/dev/null || true)" = true ]; then
  docker exec anylink-agent-postgres-1 pg_dump -U anylink -d anylink -Fc > "$base/backups/before-$(date -u +%Y%m%dT%H%M%SZ).dump"
fi
old=$(readlink -f "$base/current" 2>/dev/null || true)
"${compose[@]}" stop -t 25 app
if ! "${compose[@]}" up -d --wait --wait-timeout 240; then
  if [ -n "$old" ] && [ "$old" != "$release" ]; then
    docker compose --project-name anylink-agent --env-file "$old/release.env" -f "$old/compose.yaml" up -d --wait --wait-timeout 240
    printf 'New release failed; restored %s\n' "$(basename "$old")" >&2
  fi
  exit 1
fi
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:3180/readyz',timeout=10) as r:
    result=json.load(r)
if not result.get('ok'): raise SystemExit('Readiness check failed')
print('AnyLink readiness: OK')
PY
if [ -n "$old" ] && [ "$old" != "$release" ]; then ln -sfn "$old" "$base/previous"; fi
ln -sfn "$release" "$base/current"
printf 'Activated release: %s\n' "$(basename "$release")"
