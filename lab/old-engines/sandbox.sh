#!/bin/sh
# Runs in-container.sh in an image unpacked by fetch-image.mjs, for a machine without Docker: an unprivileged user
# namespace mapped to root, with its own mount, PID, network, IPC and UTS namespaces, chrooted into the image. As in the
# Docker run, the image is read-only, /tmp is a fresh tmpfs, the four files are mounted read-only where docker run mounts
# them, and the network namespace has nothing but loopback. Not reproduced: the CPU, memory and process limits, which
# need cgroups this user cannot write to, and the image's own user: the page runs as root of the namespace, which is the
# unprivileged runner user outside it. in-container.sh and its Chrome flags are the same in both runs.
# Usage: sandbox.sh <image dir> <busybox> <page.html> <bundle> <in-container.sh>
set -eu
if [ "${1:-}" != --inside ]; then
  # PID 1 in the new namespace is the shell of in-container.sh: when it exits, every process left behind goes with it
  exec unshare --user --map-root-user --mount --pid --fork --net --ipc --uts sh "$0" --inside "$@"
fi
shift
IMAGE=$1 BUSYBOX=$2 PAGE=$3 BUNDLE=$4 SCRIPT=$5
R=$IMAGE/rootfs
mount --make-rprivate / 2>/dev/null || true
# mount points, made while the image can still be written
mkdir -p "$R/proc" "$R/dev" "$R/sys" "$R/tmp" "$R/tools" "$R/srv"
for file in tools/busybox srv/page.html srv/visito.min.js in-container.sh; do
  [ -e "$R/$file" ] || : > "$R/$file"
done
mount --bind "$R" "$R"
mount -o remount,bind,ro "$R"
mount -t proc -o nosuid,nodev,noexec proc "$R/proc"
mount --rbind /dev "$R/dev"
# a /dev/shm of its own, the size docker run gives it
mount -t tmpfs -o nosuid,nodev,size=512m shm "$R/dev/shm"
mount --rbind /sys "$R/sys"
mount -o remount,bind,ro "$R/sys" 2>/dev/null || true
mount -t tmpfs -o nosuid,nodev,exec,size=512m tmp "$R/tmp"
bind_ro() {
  mount --bind "$1" "$R/$2"
  mount -o remount,bind,ro "$R/$2"
}
bind_ro "$BUSYBOX" tools/busybox
bind_ro "$PAGE" srv/page.html
bind_ro "$BUNDLE" srv/visito.min.js
bind_ro "$SCRIPT" in-container.sh
"$BUSYBOX" hostname old-engine
# docker run --network none brings up loopback and nothing else
"$BUSYBOX" ip link set lo up
# the image's own environment, as docker run passes it, and HOME=/tmp as the Docker run sets it
set --
while IFS= read -r pair; do
  [ -n "$pair" ] && set -- "$@" "$pair"
done < "$IMAGE/env"
exec chroot "$R" /usr/bin/env -i "$@" HOME=/tmp /bin/bash /in-container.sh
