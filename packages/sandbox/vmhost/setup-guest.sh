#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Elamaran Elangovan
# Runs INSIDE the Lima VM (limactl shell agm-kvm -- bash .../setup-guest.sh).
# Fetches Firecracker and its official CI guest kernel + Ubuntu rootfs, adds
# the Agamemnon guest agent, and builds a read-only ext4 root filesystem.
#
# Sources (all official Firecracker artefacts):
#   github.com/firecracker-microvm/firecracker/releases      firecracker binary
#   s3.amazonaws.com/spec.ccfc.min/firecracker-ci/...        guest kernel, Ubuntu rootfs
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ARCH="$(uname -m)"
OUT="$HOME/agm-vm"
mkdir -p "$OUT/dl"
cd "$OUT/dl"

[ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "no usable /dev/kvm: nested virtualization off, or log in again for the kvm group"; exit 1; }

release_url="https://github.com/firecracker-microvm/firecracker/releases"
latest="$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$release_url/latest")")"
list() { curl -fsSL "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/$1/$ARCH/$2&list-type=2"; }
# CI guest artefacts lag releases: use the newest minor version that has both a kernel and a rootfs.
major="${latest%%.*}"; minor="$(echo "$latest" | cut -d. -f2)"; ci=""
for m in $(seq "$minor" -1 $((minor > 6 ? minor - 6 : 0))); do
  v="$major.$m"
  if list "$v" vmlinux- | grep -q "<Key>" && list "$v" ubuntu- | grep -q "squashfs</Key>"; then ci="$v"; break; fi
done
[ -n "$ci" ] || { echo "no Firecracker CI guest artefacts found near $latest"; exit 1; }
echo "firecracker $latest ($ARCH), guest kernel/rootfs from CI $ci"

if [ ! -x "$OUT/firecracker" ]; then
  curl -fsSL "$release_url/download/$latest/firecracker-$latest-$ARCH.tgz" -o fc.tgz
  tar -xzf fc.tgz
  install -m 0755 "release-$latest-$ARCH/firecracker-$latest-$ARCH" "$OUT/firecracker"
fi

if [ ! -f "$OUT/vmlinux" ]; then
  key="$(list "$ci" vmlinux- | grep -oP "(?<=<Key>)(firecracker-ci/$ci/$ARCH/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" | sort -V | tail -1)"
  curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min/$key" -o "$OUT/vmlinux"
fi
if [ ! -f ubuntu.squashfs ]; then
  key="$(list "$ci" ubuntu- | grep -oP "(?<=<Key>)(firecracker-ci/$ci/$ARCH/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" | sort -V | tail -1)"
  curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min/$key" -o ubuntu.squashfs
fi

sudo rm -rf rootfs
sudo unsquashfs -q -d rootfs ubuntu.squashfs
if [ ! -x rootfs/usr/bin/python3 ]; then
  echo "rootfs has no python3; installing python3-minimal into it"
  sudo cp /etc/resolv.conf rootfs/etc/resolv.conf
  sudo chroot rootfs /bin/sh -c "apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-minimal && apt-get clean"
fi
sudo mkdir -p rootfs/agm
sudo install -m 0644 "$HERE/guest/agm_guest.py" rootfs/agm/agm_guest.py
sudo install -m 0755 "$HERE/guest/init.sh" rootfs/agm/init.sh
sudo mkfs.ext4 -q -F -d rootfs "$OUT/rootfs.ext4" 1G
sudo chown "$(id -u):$(id -g)" "$OUT/rootfs.ext4"
sudo rm -rf rootfs
echo "ready: $OUT/firecracker, $OUT/vmlinux, $OUT/rootfs.ext4"
