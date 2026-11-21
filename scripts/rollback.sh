#!/usr/bin/env bash
set -euo pipefail
host=${1:-ywc}
ssh -o BatchMode=yes "$host" 'set -eu; target=$(readlink -f /opt/anylink-agent/previous); test -n "$target"; bash "$target/remote-up.sh" "$target"'
