#!/usr/bin/env bash
# Runs one command in the browser container: non-root, read-only source, capped CPU, memory and processes, and no network
# unless LAB_NETWORK=bridge is set (only record-fixture.mjs needs it). BUNDLE and FIXTURE_* are passed through.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/lab/report/raw" "$ROOT/private/fixture"
# root hands the two output directories to an unprivileged user; anyone else runs the container as themselves
if [ "$(id -u)" = 0 ]; then
  RUN_AS=1001:1001
  chown "$RUN_AS" "$ROOT/lab/report/raw" "$ROOT/private/fixture"
else
  RUN_AS="$(id -u):$(id -g)"
fi
exec nice -n 19 docker run --rm --network "${LAB_NETWORK:-none}" --user "$RUN_AS" \
  --cpus "${LAB_CPUS:-4}" --memory 4g --pids-limit 1024 --shm-size 1g --read-only --tmpfs /tmp:exec,size=1g \
  -e HOME=/tmp -e BUNDLE -e FIXTURE_URL -e FIXTURE_USER -e FIXTURE_PASS -e FIXTURE_BLOCK \
  -v "$ROOT":/work:ro -v "$ROOT/lab/report/raw":/work/lab/report/raw -v "$ROOT/private/fixture":/work/private/fixture \
  -w /work visitojs-browsers "$@"
