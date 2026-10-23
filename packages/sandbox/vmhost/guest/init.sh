#!/bin/sh
# PID 1 inside an Agamemnon microVM. Read-only root, scratch space in tmpfs,
# no network configured (the VM has no NIC). Run the guest agent once, then
# power off — vmhost tears the VM down either way.
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sys /sys 2>/dev/null
mount -t devtmpfs dev /dev 2>/dev/null
mount -t tmpfs -o size=64m,mode=1777 tmpfs /tmp 2>/dev/null
mount -t tmpfs -o size=8m tmpfs /run 2>/dev/null
export HOME=/tmp PATH=/usr/bin:/bin PYTHONDONTWRITEBYTECODE=1
cd /tmp
/usr/bin/python3 -I -S /agm/agm_guest.py
echo o > /proc/sysrq-trigger
sleep 5
