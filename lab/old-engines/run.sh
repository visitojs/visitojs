#!/usr/bin/env bash
# Runs the built file in old Chrome images (Chrome 53, 59, 63, 68, 80), one at a time, with no network inside them.
# Usage: lab/old-engines/run.sh [image tags...]   The images and the web server binary are pulled on first use.
# BUNDLE=dist/visito.lab.min.js runs the lab build instead of the product build, BUNDLE=dist/visito.defer.min.js the deferred build,
# BUNDLE=dist/deep.min.js the deep entry, on its own page (page-deep.html) and with its own checker (check-deep.mjs).
# The images run in Docker when it is available, otherwise in sandbox.sh (user namespaces, no privilege needed), from
# images that fetch-image.mjs pulls by the same digests into OLD_ENGINES_CACHE. OLD_ENGINES_RUNTIME=docker|unshare
# chooses one.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAGS=("$@")
ALL_TAGS=
# pinned by digest: these tags are old enough to be stable, but a digest cannot be re-pointed. check.mjs holds the Chrome
# major each tag must run, and with no tags given it fails unless every one of them ran
[ ${#TAGS[@]} -gt 0 ] || ALL_TAGS=1 TAGS=(
  2.53.0@sha256:205d2031412acc399e705ff38ab716323490cdf89967794630b3c3fd654b02c3
  3.4.0-einsteinium@sha256:09b93dda72f7a78264ba3d5d9aba0eab557836fd7fe4726615ff9db3100a20dc
  3.8.1-erbium@sha256:1106e66d7bd96341ed2637172bf1680adf9330a2ba9a8cdbf576a580e07a8018
  3.14.0-arsenic@sha256:8ea147878016fb200dd07d92d39f11d6522707d630202a1b1c15d748a2bee06f
  3.141.59-zirconium@sha256:ece6017352a6b5c1e8d6b1194b302576bfb3d9fee0912406c3e9f56017d9af17
)
BUSYBOX=busybox:1.36-musl@sha256:3c6ae8008e2c2eedd141725c30b20d9c36b026eb796688f88205845ef17aa213
BUNDLE="${BUNDLE:-$ROOT/dist/visito.min.js}"
# docker needs an absolute path to mount; a relative BUNDLE is read from the current directory
case "$BUNDLE" in /*) ;; *) BUNDLE="$PWD/$BUNDLE" ;; esac
[ -f "$BUNDLE" ] || { echo "no such bundle: $BUNDLE (run npm run build first)" >&2; exit 1; }
# named by the file alone: a checkout path that contains "lab" must not rename the product run
PAGE=page.html CHECK=check.mjs
case "${BUNDLE##*/}" in
  deep*) NAME=old-engines-deep.txt BUILD=deep PAGE=page-deep.html CHECK=check-deep.mjs ;;
  *lab*) NAME=old-engines-lab.txt BUILD=lab ;;
  *defer*) NAME=old-engines-defer.txt BUILD=defer ;;
  *) NAME=old-engines.txt BUILD=product ;;
esac
RUNTIME="${OLD_ENGINES_RUNTIME:-}"
if [ -z "$RUNTIME" ]; then
  if docker info > /dev/null 2>&1; then RUNTIME=docker; else RUNTIME=unshare; fi
fi
case "$RUNTIME" in
  docker | unshare) ;;
  *) echo "OLD_ENGINES_RUNTIME is docker or unshare, not $RUNTIME" >&2; exit 1 ;;
esac
# outside the checkout and keyed by digest, so that a later job on the same machine reuses what an earlier one unpacked
CACHE="${OLD_ENGINES_CACHE:-${RUNNER_TOOL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}}/visito-old-engines}"
# prints the directory of the unpacked image; its progress goes to stderr
fetch() { node "$ROOT/lab/old-engines/fetch-image.mjs" "$CACHE" "$1"; }
TOOLS="$ROOT/lab/report/raw/tools"
if [ ! -x "$TOOLS/busybox" ]; then
  # the old images have no web server: a static busybox serves the page inside them
  mkdir -p "$TOOLS"
  if [ "$RUNTIME" = docker ]; then
    docker run --rm "$BUSYBOX" cat /bin/busybox > "$TOOLS/busybox"
  else
    cp "$(fetch "$BUSYBOX")/rootfs/bin/busybox" "$TOOLS/busybox"
  fi
  chmod +x "$TOOLS/busybox"
fi
OUT="$ROOT/lab/report/raw/$NAME"
: > "$OUT"
for tag in "${TAGS[@]}"; do
  image="selenium/standalone-chrome:$tag"
  echo "IMAGE $image" >> "$OUT"
  if [ "$RUNTIME" = unshare ]; then
    if dir="$(fetch "$image")"; then
      nice -n 19 sh "$ROOT/lab/old-engines/sandbox.sh" "$dir" "$TOOLS/busybox" "$ROOT/lab/old-engines/$PAGE" "$BUNDLE" \
        "$ROOT/lab/old-engines/in-container.sh" >> "$OUT" 2>&1 || echo "RUN_FAILED" >> "$OUT"
    else
      echo "RUN_FAILED" >> "$OUT"
    fi
    continue
  fi
  # pulled here so that its progress stays out of the output; a failed pull makes the run below fail
  docker pull -q "$image" > /dev/null || true
  nice -n 19 docker run --rm --network none --cpus 2 --memory 2g --pids-limit 512 --shm-size 512m \
    --read-only --tmpfs /tmp:exec,size=512m -e HOME=/tmp \
    -v "$TOOLS/busybox":/tools/busybox:ro \
    -v "$ROOT/lab/old-engines/$PAGE":/srv/page.html:ro \
    -v "$BUNDLE":/srv/visito.min.js:ro \
    -v "$ROOT/lab/old-engines/in-container.sh":/in-container.sh:ro \
    --entrypoint bash "$image" /in-container.sh >> "$OUT" 2>&1 || echo "RUN_FAILED" >> "$OUT"
done
# check.mjs needs nothing but Node: in CI it runs on the runner's Node, locally in the dev container like every other script
if [ "${CI:-}" = true ]; then
  node "$ROOT/lab/old-engines/$CHECK" "$OUT" --build "$BUILD" ${ALL_TAGS:+--all-tags}
else
  "$ROOT/lab/run.sh" node "lab/old-engines/$CHECK" "lab/report/raw/$NAME" --build "$BUILD" ${ALL_TAGS:+--all-tags}
fi
