// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { describe, it, expect, beforeAll } from "vitest";
import { BrokerProposalBridge, mutationToSql, quoteIdent, quoteLiteral, selectToSql } from "../agamemnon-bridge.ts";
import { makeBroker, pgAvailable, q, resetTestDb } from "../../../broker/tests/helpers.ts";

describe("quoteIdent — reject, don't escape", () => {
  it("double-quotes a plain identifier", () => {
    expect(quoteIdent("orders")).toBe('"orders"');
    expect(quoteIdent("_tmp_2")).toBe('"_tmp_2"');
    expect(quoteIdent("t".repeat(63))).toBe(`"${"t".repeat(63)}"`);
  });

  it.each([[""], ["1orders"], ["order items"], ['or"ders'], ["orders; DROP TABLE x"], ["public.orders"], ["t".repeat(64)], ["ordérs"]])("refuses %j", (name) => {
    expect(() => quoteIdent(name)).toThrow();
  });
});

describe("quoteLiteral", () => {
  it.each([
    [null, "NULL"],
    [true, "TRUE"],
    [false, "FALSE"],
    [42, "42"],
    [-1.5, "-1.5"],
    ["open", "'open'"],
    ["O'Brien", "'O''Brien'"],
    ["'; DROP TABLE orders; --", "'''; DROP TABLE orders; --'"],
    ["back\\slash", "'back\\slash'"],
    [{ tags: ["a"] }, `'{"tags":["a"]}'`],
    [["x", "y'z"], `'["x","y''z"]'`],
  ])("%j → %s", (value, sql) => {
    expect(quoteLiteral(value)).toBe(sql);
  });

  it.each([[NaN], [Infinity], [-Infinity], [undefined], ["nul\u0000byte"], [() => 1]])("refuses %j", (value) => {
    expect(() => quoteLiteral(value)).toThrow();
  });
});

describe("mutationToSql / selectToSql", () => {
  it("compiles inserts", () => {
    expect(mutationToSql({ table: "orders", operation: "insert", data: { customer_id: 7, status: "open", amount: 5 } })).toBe(
      `INSERT INTO "orders" ("customer_id", "status", "amount") VALUES (7, 'open', 5)`,
    );
  });

  it("compiles updates with an equality WHERE", () => {
    expect(mutationToSql({ table: "orders", operation: "update", data: { status: "void", note: null }, where: { id: 3 } })).toBe(`UPDATE "orders" SET "status" = 'void', "note" = NULL WHERE "id" = 3`);
  });

  it("compiles deletes; null compiles to IS NULL; no where means the whole table", () => {
    expect(mutationToSql({ table: "orders", operation: "delete", data: {}, where: { status: "stale", note: null } })).toBe(`DELETE FROM "orders" WHERE "status" = 'stale' AND "note" IS NULL`);
    expect(mutationToSql({ table: "orders", operation: "delete", data: {} })).toBe(`DELETE FROM "orders"`);
    expect(mutationToSql({ table: "orders", operation: "delete", data: {}, where: {} })).toBe(`DELETE FROM "orders"`);
  });

  it("compiles selects", () => {
    expect(selectToSql({ table: "orders", where: { customer_id: 7 } })).toBe(`SELECT * FROM "orders" WHERE "customer_id" = 7`);
    expect(selectToSql({ table: "orders" })).toBe(`SELECT * FROM "orders"`);
  });

  it("refuses empty inserts and updates, unknown operations, and hostile names anywhere", () => {
    expect(() => mutationToSql({ table: "orders", operation: "insert", data: {} })).toThrow();
    expect(() => mutationToSql({ table: "orders", operation: "update", data: {}, where: { id: 1 } })).toThrow();
    expect(() => mutationToSql({ table: "orders", operation: "truncate" as any, data: {} })).toThrow();
    expect(() => mutationToSql({ table: 'orders"; DROP TABLE x; --', operation: "delete", data: {} })).toThrow();
    expect(() => mutationToSql({ table: "orders", operation: "insert", data: { 'a") VALUES (1); --': 1 } })).toThrow();
    expect(() => selectToSql({ table: "orders", where: { "1=1 OR id": 1 } })).toThrow();
  });
});

// --- through the real broker ------------------------------------------------------

const PG = await pgAvailable();

describe.skipIf(!PG)("BrokerProposalBridge — against the real broker and Postgres", () => {
  beforeAll(resetTestDb);

  async function attached(tenant: string) {
    const b = makeBroker();
    const bridge = new BrokerProposalBridge(b, { agent: "cleanup-bot", connection: "test" });
    await bridge.attach("sb-1", tenant);
    return { b, bridge };
  }

  it("a sandbox insert for its own tenant executes and the row exists", async () => {
    const { bridge } = await attached("7");
    const o = await bridge.handleSandboxWriteProposal("sb-1", { table: "orders", operation: "insert", data: { customer_id: 7, status: "open", amount: 11, note: "from sandbox" } });
    expect(o.status).toBe("executed");
    expect(o.approved).toBe(true);
    expect(await q(`SELECT amount FROM orders WHERE note = 'from sandbox'`)).toEqual([{ amount: 11 }]);
  });

  it("a mass delete touching other tenants' rows is blocked by the broker's tenant guard", async () => {
    const { bridge } = await attached("7");
    const o = await bridge.handleSandboxWriteProposal("sb-1", { table: "orders", operation: "delete", data: {}, where: { status: "stale" } });
    expect(o.approved).toBe(false);
    expect(o.status).toBe("blocked");
    expect(o.firedRules.map((r) => r.name)).toContain("cross-tenant");
    expect(o.counts.rows).toBeGreaterThan(1);
  });

  it("an attacker-controlled value stays a value", async () => {
    const { bridge } = await attached("7");
    const o = await bridge.handleSandboxWriteProposal("sb-1", { table: "orders", operation: "update", data: { note: "x'; DELETE FROM orders; --" }, where: { customer_id: 7, note: "from sandbox" } });
    expect(o.status).toBe("executed");
    expect(Number((await q(`SELECT count(*) AS n FROM orders`))[0].n)).toBeGreaterThan(4000);
    expect(await q(`SELECT note FROM orders WHERE customer_id = 7 AND note LIKE 'x''%'`)).toEqual([{ note: "x'; DELETE FROM orders; --" }]);
  });

  it("reads return the tenant's rows through the broker", async () => {
    const { bridge } = await attached("7");
    const r = await bridge.handleSandboxRead("sb-1", { table: "orders", where: { customer_id: 7 } });
    expect(r.outcome.status).toBe("executed");
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((row: any) => String(row.customer_id) === "7")).toBe(true);
  });

  it("detach ends the task; violations land in the broker's audit log", async () => {
    const { b, bridge } = await attached("7");
    const taskId = bridge.taskOf("sb-1")!;
    await bridge.recordViolation({ sandboxId: "sb-1", tenantId: "7", at: Date.now(), syscall: { op: "http.fetch", url: "https://evil.test" }, reason: "EXTERNAL_HTTP not granted" });
    expect(b.store.auditTail(5).some((a) => a.kind === "sandbox-violation" && a.taskId === taskId)).toBe(true);
    await bridge.detach("sb-1");
    expect(b.store.task(taskId)?.status).not.toBe("open");
    await expect(bridge.handleSandboxWriteProposal("sb-1", { table: "orders", operation: "delete", data: {} })).rejects.toThrow(/not attached/);
  });
});
