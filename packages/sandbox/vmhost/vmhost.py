# Agamemnon — AI-agent write-path guardian
# Copyright (c) 2026 Elamaran Elangovan. All rights reserved.
#
# Proprietary and confidential. No licence is granted to use, copy, modify,
# distribute, or run this software beyond local evaluation of this repository
# as published. See LICENSE at the repository root.
#
# ref: AGMN-BOZW-F6BTKX-X3LAO

"""
vmhost — the KVM side of Agamemnon's microVM sandboxes (runs on the Linux host).

    sandbox server (supervisor) ──TCP, token──▶ vmhost ──spawns──▶ firecracker ──KVM──▶ microVM
                                ◀── frames ───        ◀── vsock (UDS) ──────────────── guest agent

One connection = one run = one fresh microVM:
  - read-only root filesystem shared by every VM; scratch space is tmpfs
  - NO network device: the VM's only channel is a vsock stream to this process
  - 1 vCPU, memory sized from the sandbox limit, Firecracker's default seccomp
  - the deadline is enforced by killing the VMM process — hard preemption
  - the VM is destroyed when the run ends, the deadline passes, or the
    supervisor disconnects

vmhost holds no policy and no credentials. It relays the guest's frames to the
supervisor, which parses every syscall as hostile, checks capabilities, and
turns writes into Agamemnon proposals. Frames are size-capped and type-filtered
in both directions.

Usage (inside the Lima VM):
  python3 vmhost.py --listen 127.0.0.1:7801 --token-file ~/.agm-vmhost.token \
      --firecracker ~/agm-vm/firecracker --kernel ~/agm-vm/vmlinux --rootfs ~/agm-vm/rootfs.ext4

`--driver local-insecure` runs the guest agent as a plain local process
instead of a VM. It exists ONLY for tests on machines without KVM, reports
isolated=false, and the TypeScript runtime refuses it unless a test opts in.
"""

import argparse
import asyncio
import hmac
import json
import os
import secrets
import shutil
import signal
import sys
import tempfile
import time

MAX_FRAME = 1 << 20
BOOT_TIMEOUT = 20.0
GUEST_TYPES = {"ready", "sys", "log", "done"}
HOST_TYPES = {"rep", "kill"}
HERE = os.path.dirname(os.path.abspath(__file__))


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


async def send(writer, frame):
    writer.write(json.dumps(frame, separators=(",", ":")).encode() + b"\n")
    await writer.drain()


async def read_frame(reader):
    line = await reader.readline()
    if not line:
        return None
    if len(line) > MAX_FRAME:
        raise ValueError("frame too large")
    f = json.loads(line)
    if not isinstance(f, dict):
        raise ValueError("frame is not an object")
    return f


class Booted:
    def __init__(self, proc, workdir, isolated, boot_ms):
        self.proc, self.workdir, self.isolated, self.boot_ms = proc, workdir, isolated, boot_ms

    async def stop(self):
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.kill()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self.proc.wait(), 5)
            except asyncio.TimeoutError:
                pass
        shutil.rmtree(self.workdir, ignore_errors=True)


class Driver:
    """Boots a sandbox and returns once its guest agent has connected to `vsock_path`."""

    isolated = True

    async def spawn(self, workdir, vsock_uds, mem_mb):
        raise NotImplementedError


class FirecrackerDriver(Driver):
    isolated = True

    def __init__(self, firecracker, kernel, rootfs):
        for p in (firecracker, kernel, rootfs):
            if not os.path.exists(p):
                raise SystemExit(f"vmhost: missing {p}")
        if not os.access("/dev/kvm", os.R_OK | os.W_OK):
            raise SystemExit("vmhost: /dev/kvm is not accessible (is nested virtualization on, and is this user in the kvm group?)")
        self.firecracker, self.kernel, self.rootfs = firecracker, kernel, rootfs

    async def spawn(self, workdir, vsock_uds, mem_mb):
        config = {
            "boot-source": {
                "kernel_image_path": self.kernel,
                "boot_args": "console=ttyS0 reboot=k panic=1 pci=off ro quiet init=/agm/init.sh",
            },
            "drives": [{"drive_id": "rootfs", "path_on_host": self.rootfs, "is_root_device": True, "is_read_only": True}],
            "machine-config": {"vcpu_count": 1, "mem_size_mib": mem_mb, "smt": False},
            # No "network-interfaces": the VM has no NIC at all.
            "vsock": {"guest_cid": 3, "uds_path": vsock_uds},
        }
        cfg = os.path.join(workdir, "vm.json")
        with open(cfg, "w") as f:
            json.dump(config, f)
        console = open(os.path.join(workdir, "console.log"), "wb")
        return await asyncio.create_subprocess_exec(
            self.firecracker, "--no-api", "--config-file", cfg, "--level", "Warning",
            stdin=asyncio.subprocess.DEVNULL, stdout=console, stderr=console, start_new_session=True,
        )


class LocalInsecureDriver(Driver):
    """TEST ONLY: the guest agent as a local process. No isolation whatsoever."""

    isolated = False

    async def spawn(self, workdir, vsock_uds, mem_mb):
        return await asyncio.create_subprocess_exec(
            sys.executable, "-I", os.path.join(HERE, "guest", "agm_guest.py"), "--unix", vsock_uds + "_5000",
            stdin=asyncio.subprocess.DEVNULL, start_new_session=True,
        )


class VmHost:
    def __init__(self, driver, token, runroot):
        self.driver, self.token, self.runroot = driver, token.encode(), runroot
        self.active = 0

    async def handle(self, reader, writer):
        peer = writer.get_extra_info("peername")
        vm = None
        try:
            start = await asyncio.wait_for(read_frame(reader), 10)
            if not start or start.get("t") != "start" or not hmac.compare_digest(str(start.get("token", "")).encode(), self.token):
                await send(writer, {"t": "error", "error": "unauthorised"})
                return
            limits = start.get("limits") or {}
            mem_mb = max(128, min(2048, int(limits.get("memMb", 64)) + 96))
            timeout_s = max(0.05, min(600.0, float(limits.get("timeoutMs", 5000)) / 1000))
            self.active += 1
            vm, guest_r, guest_w, ready = await self.boot(mem_mb)
            await send(writer, {"t": "booted", "isolated": vm.isolated, "bootMs": vm.boot_ms, "memMb": mem_mb, "python": ready.get("python")})
            await send(guest_w, {"t": "run", "code": str(start.get("code", "")), "context": start.get("context") or {}})
            done = await self.relay(reader, writer, guest_r, guest_w, timeout_s)
            await send(writer, done)
        except (asyncio.TimeoutError, ValueError, json.JSONDecodeError, ConnectionError, OSError) as e:
            try:
                await send(writer, {"t": "done", "ok": False, "error": f"vmhost: {type(e).__name__}: {e}"})
            except Exception:  # noqa: BLE001
                pass
        finally:
            if vm:
                await vm.stop()
                self.active -= 1
            writer.close()
            log("run finished", peer)

    async def boot(self, mem_mb):
        workdir = tempfile.mkdtemp(prefix="r-", dir=self.runroot)
        os.chmod(workdir, 0o700)
        vsock_uds = os.path.join(workdir, "v.sock")
        accepted = asyncio.get_running_loop().create_future()

        async def on_guest(r, w):
            if accepted.done():  # one channel per VM; refuse anything else
                w.close()
                return
            accepted.set_result((r, w))

        # Firecracker forwards a guest connect(CID 2, port 5000) to "<uds_path>_5000".
        server = await asyncio.start_unix_server(on_guest, path=vsock_uds + "_5000")
        t0 = time.monotonic()
        proc = await self.driver.spawn(workdir, vsock_uds, mem_mb)
        vm = Booted(proc, workdir, self.driver.isolated, 0)
        try:
            exited = asyncio.ensure_future(proc.wait())
            first = await asyncio.wait({accepted, exited}, timeout=BOOT_TIMEOUT, return_when=asyncio.FIRST_COMPLETED)
            if accepted not in first[0]:
                tail = ""
                try:
                    with open(os.path.join(workdir, "console.log"), "rb") as f:
                        tail = f.read()[-600:].decode(errors="replace")
                except OSError:
                    pass
                raise ConnectionError(f"guest never connected ({'VMM exited' if exited.done() else 'boot timeout'}){': ' + tail if tail else ''}")
            guest_r, guest_w = accepted.result()
            ready = await asyncio.wait_for(read_frame(guest_r), BOOT_TIMEOUT)
            if not ready or ready.get("t") != "ready":
                raise ConnectionError("guest did not say ready")
            vm.boot_ms = round((time.monotonic() - t0) * 1000)
            return vm, guest_r, guest_w, ready
        except BaseException:
            await vm.stop()
            raise
        finally:
            server.close()

    async def relay(self, sup_r, sup_w, guest_r, guest_w, timeout_s):
        """Pump frames both ways until the guest is done, the deadline passes, or someone hangs up."""
        deadline = time.monotonic() + timeout_s

        async def guest_to_sup():
            while True:
                f = await read_frame(guest_r)
                if f is None:
                    return {"t": "done", "ok": False, "error": "the sandbox exited without a result (crashed, or ran out of memory)"}
                if f.get("t") not in GUEST_TYPES:
                    continue
                if f["t"] == "done":
                    return {"t": "done", "ok": bool(f.get("ok")), "value": f.get("value"), "error": f.get("error")}
                await send(sup_w, f)

        async def sup_to_guest():
            while True:
                f = await read_frame(sup_r)
                if f is None or f.get("t") == "kill":
                    return {"t": "done", "ok": False, "killed": f.get("reason", "killed by supervisor") if f else "supervisor disconnected"}
                if f.get("t") in HOST_TYPES:
                    await send(guest_w, f)

        a, b = asyncio.ensure_future(guest_to_sup()), asyncio.ensure_future(sup_to_guest())
        try:
            done, _ = await asyncio.wait({a, b}, timeout=max(0.0, deadline - time.monotonic()), return_when=asyncio.FIRST_COMPLETED)
            if not done:
                return {"t": "done", "ok": False, "killed": f"timeout: exceeded {round(timeout_s * 1000)}ms (VM destroyed)"}
            return next(iter(done)).result()
        finally:
            for t in (a, b):
                t.cancel()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="127.0.0.1:7801")
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--driver", choices=["firecracker", "local-insecure"], default="firecracker")
    ap.add_argument("--firecracker")
    ap.add_argument("--kernel")
    ap.add_argument("--rootfs")
    ap.add_argument("--runroot", default=None)
    a = ap.parse_args()
    for k in ("token_file", "firecracker", "kernel", "rootfs", "runroot"):
        if getattr(a, k):
            setattr(a, k, os.path.expanduser(os.path.expandvars(getattr(a, k))))

    if not os.path.exists(a.token_file):
        with open(a.token_file, "w") as f:
            f.write(secrets.token_hex(24))
        os.chmod(a.token_file, 0o600)
    token = open(a.token_file).read().strip()

    if a.driver == "firecracker":
        driver = FirecrackerDriver(a.firecracker, a.kernel, a.rootfs)
    else:
        log("WARNING: local-insecure driver — guest code runs as a plain local process with NO isolation. Tests only.")
        driver = LocalInsecureDriver()
    # Short paths: a Unix socket path must fit in ~104 bytes.
    runroot = a.runroot or tempfile.mkdtemp(prefix="agmv-", dir="/tmp")
    os.makedirs(runroot, mode=0o700, exist_ok=True)

    host, port = a.listen.rsplit(":", 1)
    vmhost = VmHost(driver, token, runroot)

    async def serve():
        srv = await asyncio.start_server(vmhost.handle, host, int(port))
        log(f"vmhost listening on {a.listen} · driver {a.driver} · isolated={driver.isolated}")
        loop = asyncio.get_running_loop()
        stop = loop.create_future()
        for s in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(s, lambda: stop.done() or stop.set_result(None))
        async with srv:
            await stop
        shutil.rmtree(runroot, ignore_errors=True)

    asyncio.run(serve())


if __name__ == "__main__":
    main()
