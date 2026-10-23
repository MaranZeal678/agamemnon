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

import { describe, it, expect, beforeEach } from "vitest";
import { makeBroker, pgAvailable, resetTestDb, P, q } from "./helpers.ts";
import { consolePage, approvePage } from "../src/pages.ts";

describe("console pages", () => {
  it("their inline scripts are valid JavaScript", () => {
    for (const html of [consolePage(), approvePage("eff_123")]) {
      const js = /<script>([\s\S]*)<\/script>/.exec(html)![1];
      expect(() => new Function(js)).not.toThrow();
    }
  });
});

const PG = await pgAvailable();
(PG ? describe : describe.skip)("tenancy, dependencies, policy lifecycle, evidence (live Postgres)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  const sql = (s: string) => ({ connection: "test", sql: s });

  it("a tenant-scoped task cannot touch or read another tenant's rows (confused deputy)", async () => {
    const b = makeBroker();
    const bot = P(b, "support-bot");
    const t = b.engine.startTask(bot, { goal: "help customer 7", tenant: "7" });
    const wide = await b.engine.propose(bot, { taskId: t.id, operation: "postgres.sql", params: sql("DELETE FROM orders WHERE status = 'cancelled'") });
    expect(wide.status).toBe("blocked");
    expect(wide.firedRules.find((r) => r.name === "cross-tenant")?.detail).toMatch(/belong to a tenant other than "7"/);
    const own = await b.engine.propose(bot, { taskId: t.id, operation: "postgres.sql", params: sql("DELETE FROM orders WHERE status = 'cancelled' AND customer_id = 7") });
    expect(own.firedRules.map((r) => r.name)).not.toContain("cross-tenant");
    const peek = await b.engine.propose(bot, { taskId: t.id, operation: "postgres.query", params: sql("SELECT id, customer_id FROM orders WHERE customer_id = 8 LIMIT 3") });
    expect(peek.status).toBe("failed");
    expect(peek.error).toMatch(/another tenant — result withheld/);
    const sub = b.engine.startTask(P(b, "helper-1"), { parentTaskId: t.id, tenant: "99" });
    expect(b.store.task(sub.id)!.tenant).toBe("7"); // a sub-agent cannot widen its tenant
  });

  it("a tenant-scoped task cannot write rows into, or re-home rows to, another tenant", async () => {
    const b = makeBroker();
    const bot = P(b, "support-bot");
    const t = b.engine.startTask(bot, { goal: "help customer 7", tenant: "7" });
    const go = (s: string) => b.engine.propose(bot, { taskId: t.id, operation: "postgres.sql", params: sql(s) });
    const crossTenant = (v: Awaited<ReturnType<typeof go>>) => v.firedRules.find((r) => r.name === "cross-tenant")?.detail;

    const own = await go(`INSERT INTO "orders" ("customer_id","status","amount","note") VALUES (7,'open',1,'mine'), ('7','open',2,'mine')`);
    expect(own.status).toBe("executed");
    expect(crossTenant(own)).toBeUndefined();

    const foreign = await go(`INSERT INTO "orders" ("customer_id","status","amount","note") VALUES (8,'open',1,'foreign')`);
    expect(foreign.status).toBe("blocked");
    expect(crossTenant(foreign)).toMatch(/1 inserted row\(s\) set customer_id to a tenant other than "7"/);

    const mixed = await go(`INSERT INTO orders (customer_id, status, amount) VALUES (7, 'open', 1), (8, 'open', 1)`);
    expect(mixed.status).toBe("blocked");

    const omitted = await go(`INSERT INTO orders (status, amount) VALUES ('open', 1)`);
    expect(omitted.status).toBe("blocked");
    expect(crossTenant(omitted)).toMatch(/omits customer_id/);

    const noCols = await go(`INSERT INTO orders OVERRIDING SYSTEM VALUE VALUES (999999, 7, 'open', 1, NULL, now())`);
    expect(noCols.status).toBe("blocked");
    expect(crossTenant(noCols)).toMatch(/without a column list/);

    const computed = await go(`INSERT INTO orders (customer_id, status, amount) VALUES (7 + 1, 'open', 1)`);
    expect(computed.status).toBe("blocked");
    expect(crossTenant(computed)).toMatch(/not a literal/);

    const viaSelect = await go(`INSERT INTO orders (customer_id, status, amount) SELECT customer_id, 'open', 1 FROM orders WHERE customer_id = 8 LIMIT 1`);
    expect(viaSelect.status).toBe("blocked");
    expect(crossTenant(viaSelect)).toMatch(/INSERT … SELECT/);

    const rehome = await go(`UPDATE "orders" SET "customer_id" = 8 WHERE "customer_id" = 7 AND "status" = 'open'`);
    expect(rehome.status).toBe("blocked");
    expect(crossTenant(rehome)).toMatch(/sets customer_id to "8" — the rows would move out of tenant "7"/);

    const rehomeExpr = await go(`UPDATE orders SET customer_id = customer_id + 1 WHERE customer_id = 7 AND status = 'open'`);
    expect(rehomeExpr.status).toBe("blocked");
    expect(crossTenant(rehomeExpr)).toMatch(/non-literal/);

    const upsertRehome = await go(`INSERT INTO orders (id, customer_id, status, amount) OVERRIDING SYSTEM VALUE VALUES (1, 7, 'open', 1) ON CONFLICT (id) DO UPDATE SET customer_id = 8`);
    expect(upsertRehome.status).toBe("blocked");
    expect(crossTenant(upsertRehome)).toMatch(/ON CONFLICT DO UPDATE sets customer_id to "8"/);

    const upsertExcluded = await go(`INSERT INTO orders (id, customer_id, status, amount) OVERRIDING SYSTEM VALUE VALUES (1, 7, 'open', 1) ON CONFLICT (id) DO UPDATE SET customer_id = EXCLUDED.customer_id`);
    expect(upsertExcluded.status).toBe("blocked");
    expect(crossTenant(upsertExcluded)).toMatch(/non-literal/);

    // order 1 belongs to customer 2: a DO UPDATE that leaves customer_id alone still writes a foreign row
    const upsertForeignRow = await go(`INSERT INTO orders (id, customer_id, status, amount) OVERRIDING SYSTEM VALUE VALUES (1, 7, 'open', 1) ON CONFLICT (id) DO UPDATE SET note = 'hijacked'`);
    expect(upsertForeignRow.status).toBe("blocked");
    expect(crossTenant(upsertForeignRow)).toMatch(/whichever existing row conflicts/);

    const ordinary = await go(`UPDATE orders SET note = 'checked' WHERE customer_id = 7 AND status = 'open' AND note IS NULL`);
    expect(ordinary.status).toBe("executed");
    expect(crossTenant(ordinary)).toBeUndefined();

    const n = async (where: string) => Number((await q(`SELECT count(*)::int AS n FROM orders WHERE ${where}`))[0].n);
    expect(await n("note = 'foreign' OR note = 'hijacked'")).toBe(0);
    expect(await n("id = 1 AND customer_id <> 7")).toBe(1);
    expect(await n("note = 'mine' AND customer_id = 7")).toBe(2);
    expect(await n("customer_id = 7 AND status = 'open' AND note = 'checked'")).toBeGreaterThan(0);
  });

  it("reverting a task whose writes another task built on is refused unless forced", async () => {
    const b = makeBroker();
    const a = b.engine.startTask(P(b, "helper-1"), { goal: "tag orders" });
    expect((await b.engine.propose(P(b, "helper-1"), { taskId: a.id, operation: "postgres.sql", params: sql("UPDATE orders SET note = 'reviewed' WHERE id <= 20") })).status).toBe("executed");
    const c = b.engine.startTask(P(b, "helper-2"), { goal: "act on tagged orders" });
    expect((await b.engine.propose(P(b, "helper-2"), { taskId: c.id, operation: "postgres.sql", params: sql("DELETE FROM orders WHERE note = 'reviewed' AND id <= 5") })).status).toBe("executed");
    await expect(b.engine.revertTask(P(b, "alice"), a.id)).rejects.toThrow(/depend on this task's writes/);
    const forced = await b.engine.revertTask(P(b, "alice"), a.id, { force: true });
    expect(forced.summary.length).toBeGreaterThan(0);
  });

  it("replays a draft policy over past decisions and reports what would flip", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), {});
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: sql("DELETE FROM orders WHERE status = 'stale'") });
    expect(v.wouldDecision).toBe("approval");
    const r = b.engine.replayPolicy({ levels: { "destructive-over-100": "monitor" } });
    expect(r.flips).toEqual([expect.objectContaining({ id: v.id, before: "approval", after: "allow" })]);
  });

  it("policy changes need a second operator; the requester cannot approve their own", async () => {
    const b = makeBroker();
    const id = b.engine.requestPolicyChange(P(b, "maran"), { mode: "shadow" });
    expect(b.engine.mode).toBe("enforce");
    expect(() => b.engine.decidePolicyChange(P(b, "maran"), id, true)).toThrow(/cannot approve/);
    expect(b.engine.decidePolicyChange(P(b, "alice"), id, true).status).toBe("applied");
    expect(b.engine.mode).toBe("shadow");
    expect(() => b.engine.requestPolicyChange(P(b, "alice"), { mode: "enforce" })).toThrow(/only admins/);
  });

  it("evidence pack annotates every signed receipt with the controls it supports (informational)", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), {});
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: sql("DELETE FROM orders WHERE status = 'stale'") });
    await b.engine.decide(P(b, "alice"), v.id, "approve");
    const lines = b.engine.evidence().map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    const last = lines[lines.length - 1];
    expect(last.informational).toBe(true);
    expect(last.controls["EU AI Act Art. 14 (human oversight)"]).toMatch(/approved by alice/);
    expect(b.engine.verifyReceipts().ok).toBe(true);
  });

  it("finds every task that read from a source later found to be poisoned", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "support-bot"), {});
    await b.engine.propose(P(b, "support-bot"), { taskId: t.id, operation: "postgres.query", params: sql("SELECT body FROM tickets") });
    await b.engine.propose(P(b, "support-bot"), { taskId: t.id, operation: "postgres.sql", params: sql("UPDATE orders SET note = 'escalated' WHERE id = 1") });
    const hits = b.engine.poisoned("tickets");
    expect(hits.map((h) => h.taskId)).toEqual([t.id]);
    expect(hits[0].effects.some((e) => e.operation === "postgres.sql")).toBe(true);
  });
});

describe("break-glass and metrics", () => {
  it("a declared emergency lets one operator approve alone, never the launcher, always audited", async () => {
    const { makeBroker: mk, P: p } = await import("./helpers.ts");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const b = mk();
    writeFileSync(join(b.dir, "workspace/tests/x.test.ts"), "it('x', () => {})\n");
    const t = b.engine.startTask(p(b, "coder"), {});
    const v = await b.engine.propose(p(b, "coder"), { taskId: t.id, operation: "fs.delete", params: { path: "tests/x.test.ts" } });
    expect(v.requiredApprovals).toBe(2);
    await expect(b.engine.breakGlass(p(b, "alice"), "short", 10)).rejects.toThrow(/real reason/);
    await b.engine.breakGlass(p(b, "alice"), "prod incident #4411 — failing test blocks the hotfix", 10);
    const r = await b.engine.decide(p(b, "alice"), v.id, "approve");
    expect(r.status).toBe("executed");
    expect(b.store.auditTail(20).some((a) => a.kind === "break-glass" && /review required/.test(a.detail))).toBe(true);
    const m = b.engine.metrics();
    expect(m.executed).toBeGreaterThanOrEqual(1);
    expect(m.oversightEffects).toBe(1);
  });
});
