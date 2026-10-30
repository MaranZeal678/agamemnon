# microVM sandboxes (Firecracker on KVM)

The heavy tier of Agamemnon's mini-sandboxes: each run is a fresh Firecracker
microVM with hardware isolation, running Python. It follows the shape of
[Arrakis](https://github.com/abshkbh/arrakis) — clients talk REST to one
server, which owns the microVMs on a KVM host — with the openings Arrakis
leaves for convenience closed.

```
 Mac                                         Lima VM "agm-kvm" (Ubuntu, /dev/kvm via nested virt)
 ┌───────────────────────────────┐           ┌─────────────────────────────────────────────────┐
 │ agents / SDK ──REST + token──▶│           │                                                 │
 │   sandbox REST server         │  TCP      │  vmhost.py ──spawns──▶ firecracker ──KVM──┐     │
 │   supervisor (capabilities)   │──token──▶ │     ▲   (no API socket, seccomp, 1 vCPU)  │     │
 │   MicroVmRuntime              │ 127.0.0.1 │     │                                     ▼     │
 │   bridge → Agamemnon broker   │   :7801   │     └──── vsock (UDS) ◀── guest agent (Python)  │
 └───────────────────────────────┘           │            read-only rootfs · no NIC · tmpfs    │
                                             └─────────────────────────────────────────────────┘
```

| Arrakis | Here | Why it differs |
|---|---|---|
| py-sdk / client → REST | `SandboxClient` → `/v1/sandboxes` (src/server.ts) | Every call carries a broker principal's token; sandboxes act as the agent that created them, on a tenant-scoped broker task; only that agent runs code; operators inspect and stop but never run code |
| Restserver | Sandbox REST server + supervisor | All policy lives here: syscall parsing, capabilities, kill-on-violation, proposals |
| MicroVM (cloud-hypervisor) on /dev/kvm | Firecracker microVM on /dev/kvm | Smaller device model, default seccomp, published aarch64 guest images |
| Code server in the VM | Guest agent (`guest/agm_guest.py`) | Talks only vsock to vmhost; untrusted — the host parses every frame |
| VM networking + auto port forwarding | **None** | No network device in the VM; Lima forwards only vmhost's port, only to the Mac's loopback |
| VNC server | **None** | Headless only |

## Run it

```bash
make vm-up       # create/boot the Lima VM (first time: downloads Ubuntu 24.04 arm64)
make vm-setup    # inside it: Firecracker + its CI guest kernel and Ubuntu rootfs → read-only rootfs.ext4
make vmhost      # run vmhost (keep it running)
make vm-check    # boot real microVMs and check every isolation property
make larkspur    # the demo picks up the microVM host automatically
```

Needs Apple M3 or later on macOS 15+ (nested virtualization), or any Linux host
with `/dev/kvm` (run `vmhost.py` there directly and point `AGAMEMNON_VMHOST` at it).

## What `make vm-check` proves (on a real VM)

| Property | How it is checked |
|---|---|
| Boots a real microVM | kernel, vCPU and memory read from inside the guest |
| No network device | `/proc/net/dev` lists only `lo` |
| No route out | `connect(1.1.1.1:80)` → network unreachable |
| Read-only root | writing `/etc/…` fails |
| vsock reaches only vmhost's port | host port 22 refused; another VM's CID unreachable |
| Hard deadline | `while True: pass` is destroyed at its deadline (the VMM process is killed) |
| Memory is capped | allocating past the VM's memory kills the guest, not the host |
| Policy still applies | granted syscalls reach the broker; an ungranted one kills and terminates the sandbox |

## Honest limits

- **No jailer yet.** Firecracker runs as the unprivileged VM user with its
  default seccomp filters, but not under `jailer` (chroot, cgroups, separate
  uid per VM). That is the next hardening step.
- **Boot time.** Under nested virtualization a VM takes about 4 s to boot; one
  VM per run. Snapshots/restore would cut this to tens of milliseconds.
- **vmhost's link is a shared token over loopback TCP**, forwarded by Lima.
  Anyone on the Mac who can read the token can start VMs (not touch data —
  syscalls still go through the supervisor). Use a Unix socket or mTLS for a
  multi-user host.
- **Guest images are Firecracker's CI kernel and Ubuntu rootfs**, pinned by
  `setup-guest.sh` to the newest published CI version; build your own for
  production.
- **Memory** is the VM's size (sandbox limit + 96 MB for kernel and Python),
  not a per-process cap inside the guest.
- `--driver local-insecure` runs the guest agent with **no isolation**; it exists
  for tests on machines without KVM, and the runtime refuses it unless a test
  opts in.
