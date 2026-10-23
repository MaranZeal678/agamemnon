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

import { describe, it, expect, beforeAll } from "vitest";
import { SandboxSupervisor } from "../supervisor.ts";
import { BrokerProposalBridge } from "../agamemnon-bridge.ts";
import { FakeBridge, sandbox } from "./fakes.ts";
import { makeBroker, pgAvailable, resetTestDb } from "../../../broker/tests/helpers.ts";

/**
 * Use case 2 — many tenants' agents on shared infrastructure. Each gets its
 * own enclave (its own Wasm memory), its own limits, no network by default,
 * and a broker task scoped to its tenant.
 */
describe("use case: multi-tenant isolation", () => {
  it("tenants run concurrently without seeing each other's state", async () => {
    const sup = new SandboxSupervisor({ bridge: new FakeBridge() });
    const a = await sup.spawnSandbox(sandbox([], { tenantId: "acme" }));
    const b = await sup.spawnSandbox(sandbox([], { tenantId: "globex" }));
    const [ra, rb] = await Promise.all([
      sup.executeInSandbox(a, `globalThis.secret = context.secret; await null; return typeof secret;`, { secret: "acme-key" }),
      sup.executeInSandbox(b, `await null; return { secret: typeof secret, ctx: context };`, { note: "globex" }),
    ]);
    expect(ra.data).toBe("string");
    expect(rb.data).toEqual({ secret: "undefined", ctx: { note: "globex" } });
  });

  it("limits are per sandbox: one tenant's runaway does not kill another's run", async () => {
    const sup = new SandboxSupervisor({ bridge: new FakeBridge() });
    const hog = await sup.spawnSandbox(sandbox([], { tenantId: "acme", timeoutMs: 200 }));
    const calm = await sup.spawnSandbox(sandbox([], { tenantId: "globex" }));
    const [h, c] = await Promise.all([sup.executeInSandbox(hog, `for (;;) await null;`, {}), sup.executeInSandbox(calm, `let s = 0; for (let i = 0; i < 1e5; i++) s += i; return s;`, {})]);
    expect(h.killed).toMatch(/timeout/);
    expect(c).toMatchObject({ success: true, data: 4999950000 });
  });

  it("no network egress by default", async () => {
    const sup = new SandboxSupervisor({ bridge: new FakeBridge(), fetch: (async () => new Response("leaked")) as typeof fetch });
    const id = await sup.spawnSandbox(sandbox(["READ_ONLY", "MUTATE_STATE"], { tenantId: "acme" }));
    const r = await sup.executeInSandbox(id, `await api.fetch("https://example.com/");`, {});
    expect(r.killed).toMatch(/EXTERNAL_HTTP not granted/);
  });

  it("every sandbox is attached to its own tenant", async () => {
    const bridge = new FakeBridge();
    const sup = new SandboxSupervisor({ bridge });
    await sup.spawnSandbox(sandbox([], { id: "t-a", tenantId: "acme" }));
    await sup.spawnSandbox(sandbox([], { id: "t-b", tenantId: "globex" }));
    expect([...bridge.attached]).toEqual([
      ["t-a", "acme"],
      ["t-b", "globex"],
    ]);
  });
});

const PG = await pgAvailable();

describe.skipIf(!PG)("use case: multi-tenant isolation — at the proposal level, through the real broker", () => {
  beforeAll(resetTestDb);

  it("a sandbox cannot propose writes outside its tenant — not by WHERE, not by VALUES", async () => {
    const b = makeBroker();
    const bridge = new BrokerProposalBridge(b, { agent: "cleanup-bot", connection: "test" });
    const sup = new SandboxSupervisor({ bridge });
    const id = await sup.spawnSandbox(sandbox(["MUTATE_STATE"], { tenantId: "7" }));
    const r = await sup.executeInSandbox(
      id,
      `const own = await db.insert("orders", { customer_id: 7, status: "open", amount: 3 });
       const foreignRows = await db.update("orders", { note: "x" }, { customer_id: 8 });
       const foreignValue = await db.insert("orders", { customer_id: 8, status: "open", amount: 3 });
       const rehome = await db.update("orders", { customer_id: 8 }, { customer_id: 7, status: "open" });
       return [own.status, foreignRows.status, foreignValue.status, rehome.status];`,
      {},
    );
    expect(r.data).toEqual(["executed", "blocked", "blocked", "blocked"]);
    for (const p of r.proposals.slice(1)) expect(p.firedRules.map((f) => f.name)).toContain("cross-tenant");
  });
});
