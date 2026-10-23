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

import { describe, it, expect } from "vitest";
import { SandboxSupervisor } from "../supervisor.ts";
import { FakeBridge, sandbox } from "./fakes.ts";

/**
 * Use case 1 — an AI agent generates code and runs it. The code computes
 * freely, but every side effect leaves as a syscall and every write becomes a
 * proposal the broker decides on.
 */
describe("use case: code interpreter enclave", () => {
  it("generated code computes over broker-read data and returns a value", async () => {
    const bridge = new FakeBridge();
    bridge.rows = [{ amount_cents: 1200 }, { amount_cents: 5400 }, { amount_cents: 300 }];
    const sup = new SandboxSupervisor({ bridge });
    const id = await sup.spawnSandbox(sandbox(["READ_ONLY"]));
    const r = await sup.executeInSandbox(
      id,
      `const rows = await db.select("orders", { status: "refunded" });
       const total = rows.reduce((s, r) => s + r.amount_cents, 0);
       console.log("rows", rows.length);
       return { total, max: Math.max(...rows.map((r) => r.amount_cents)) };`,
      {},
    );
    expect(r).toMatchObject({ success: true, data: { total: 6900, max: 5400 }, logs: ["rows 3"], proposals: [] });
    expect(bridge.reads).toEqual([{ sandboxId: id, table: "orders", where: { status: "refunded" } }]);
  });

  it("db.insert / db.update / db.delete are intercepted and become proposals — never direct writes", async () => {
    const bridge = new FakeBridge();
    bridge.decide = (m) => (m.operation === "delete" && !m.where ? { status: "blocked", firedRules: [] } : { status: "executed", firedRules: [] });
    const sup = new SandboxSupervisor({ bridge });
    const id = await sup.spawnSandbox(sandbox(["MUTATE_STATE"]));
    const r = await sup.executeInSandbox(
      id,
      `const out = [];
       out.push((await db.insert("notes", { body: "hi" })).status);
       out.push((await db.update("notes", { body: "bye" }, { id: 1 })).status);
       out.push((await db.delete("notes")).status);
       return out;`,
      {},
    );
    expect(r.data).toEqual(["executed", "executed", "blocked"]);
    expect(r.proposals.map((p) => [p.summary, p.status])).toEqual([
      ["insert notes", "executed"],
      ["update notes", "executed"],
      ["delete notes", "blocked"],
    ]);
  });

  it("generated code that reaches for the host gets nothing", async () => {
    const sup = new SandboxSupervisor({ bridge: new FakeBridge() });
    const id = await sup.spawnSandbox(sandbox());
    const r = await sup.executeInSandbox(
      id,
      `const probes = {};
       for (const name of ["require", "process", "fetch", "XMLHttpRequest", "WebSocket", "Deno", "Bun", "setTimeout", "WebAssembly"]) probes[name] = typeof globalThis[name];
       let imported = "no"; try { await import("child_process"); imported = "yes"; } catch {}
       return { probes, imported };`,
      {},
    );
    expect(Object.values((r.data as any).probes).every((t) => t === "undefined")).toBe(true);
    expect((r.data as any).imported).toBe("no");
  });
});
