#!/usr/bin/env bash
# Runs one command in the dev container: no network, non-root, read-only source, capped CPU, memory and processes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build" "$ROOT/dist"
# root hands the two output directories to an unprivileged user; anyone else runs the container as themselves
if [ "$(id -u)" = 0 ]; then
  RUN_AS=1000:1000
  chown "$RUN_AS" "$ROOT/build" "$ROOT/dist"
else
  RUN_AS="$(id -u):$(id -g)"
fi
exec nice -n 19 docker run --rm --network none --user "$RUN_AS" \
  --cpus 2 --memory 2g --pids-limit 256 --read-only --tmpfs /tmp \
  -e HOME=/tmp -e npm_config_cache=/tmp/.npm -e npm_config_update_notifier=false \
  -v "$ROOT":/work:ro -v "$ROOT/build":/work/build -v "$ROOT/dist":/work/dist \
  -w /work visitojs-dev "$@"
