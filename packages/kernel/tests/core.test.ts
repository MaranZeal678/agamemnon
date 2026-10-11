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
import { createHash } from "node:crypto";
import {
  sha256Hex,
  canonicalJson,
  hashOf,
  nextLink,
  verifyChain,
  auditBody,
  GENESIS_HASH,
  checkApprover,
  approvalState,
  requiredApprovals,
  reviewerStats,
  guardPredicate,
  SqlGuardError,
  decide,
  evaluateRules,
  median,
} from "../src/index.ts";

describe("sha256 (pure JS) matches node:crypto", () => {
  const cases = ["", "abc", "a".repeat(1000), "émoji 🚀 unicode", "x".repeat(55), "x".repeat(56), "x".repeat(64)];
  for (const c of cases) {
    it(`hashes ${JSON.stringify(c.slice(0, 12))}… (${c.length} chars)`, () => {
      expect(sha256Hex(c)).toBe(createHash("sha256").update(c, "utf8").digest("hex"));
    });
  }
});

describe("canonical JSON", () => {
  it("is key-order independent and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(canonicalJson({ a: { d: [1, 2] }, b: 1 }));
    expect(hashOf({ x: 1, y: 2 })).toBe(hashOf({ y: 2, x: 1 }));
    expect(hashOf({ x: 1 })).not.toBe(hashOf({ x: 2 }));
  });
});

describe("audit hash chain", () => {
  function build(n: number) {
    const rows: any[] = [];
    let head: { seq: number; hash: string } | null = null;
    for (let i = 0; i < n; i++) {
      const body = { at: 1000 + i, kind: "decision", detail: `event ${i}` };
      const link = nextLink(head, body);
      rows.push({ ...body, ...link });
      head = { seq: link.seq, hash: link.hash };
    }
    return rows;
  }

  it("verifies an intact chain", () => {
    const rows = build(25);
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    const v = verifyChain(rows);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(25);
  });

  it("detects an edited row", () => {
    const rows = build(10);
    rows[4] = { ...rows[4], detail: "nothing to see here" };
    const v = verifyChain(rows);
    expect(v.ok).toBe(false);
    expect(v.brokenAt?.seq).toBe(4);
  });

  it("detects a deleted row", () => {
    const rows = build(10);
    rows.splice(6, 1);
    const v = verifyChain(rows);
    expect(v.ok).toBe(false);
    expect(v.brokenAt?.seq).toBe(7);
  });

  it("ignores Convex system fields when hashing", () => {
    const rows = build(3).map((r, i) => ({ ...r, _id: `id${i}`, _creationTime: 5 }));
    expect(verifyChain(rows).ok).toBe(true);
    expect(auditBody(rows[0])).not.toHaveProperty("_id");
  });
});

describe("approval integrity — requester ≠ approver ≠ launcher", () => {
  const subject = { requester: { kind: "agent" as const, id: "dispatch-copilot" }, launcher: "maran", required: 1 };

  it("refuses agent approvals", () => {
    expect(checkApprover({ kind: "agent", id: "helper-bot" }, subject).ok).toBe(false);
  });
  it("refuses the requester", () => {
    expect(checkApprover({ kind: "human", id: "dispatch-copilot" }, subject).ok).toBe(false);
  });
  it("refuses the launcher", () => {
    const r = checkApprover({ kind: "human", id: "maran" }, subject);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/launched/);
  });
  it("accepts an independent human", () => {
    expect(checkApprover({ kind: "human", id: "alice" }, subject).ok).toBe(true);
  });
  it("needs two distinct approvers when required = 2", () => {
    const s2 = { ...subject, required: 2 };
    const a = { approver: { kind: "human" as const, id: "alice" }, decision: "approve" as const, at: 1 };
    expect(approvalState(s2, [a]).state).toBe("pending");
    expect(approvalState(s2, [a, { ...a, at: 2 }]).state).toBe("pending"); // same person twice
    expect(approvalState(s2, [a, { ...a, approver: { kind: "human", id: "bob" } }]).state).toBe("approved");
  });
  it("ignores invalid approvals and canaries; deny wins", () => {
    const st = approvalState(subject, [
      { approver: { kind: "human", id: "maran" }, decision: "approve", at: 1 },
      { approver: { kind: "agent", id: "x" }, decision: "approve", at: 2 },
      { approver: { kind: "human", id: "alice" }, decision: "approve", at: 3, canary: true },
    ]);
    expect(st.state).toBe("pending");
    const denied = approvalState(subject, [
      { approver: { kind: "human", id: "alice" }, decision: "approve", at: 1 },
      { approver: { kind: "human", id: "bob" }, decision: "deny", at: 2 },
    ]);
    expect(denied.state).toBe("denied");
  });
  it("requires two approvers for irreversible, oversight-reducing or large effects", () => {
    expect(requiredApprovals({ rows: 900 })).toBe(1);
    expect(requiredApprovals({ rows: 2500 })).toBe(2);
    expect(requiredApprovals({ rows: 1, reversibility: "irreversible" })).toBe(2);
    expect(requiredApprovals({ rows: 1, oversightReducing: true })).toBe(2);
  });
  it("flags rubber-stamping", () => {
    const stats = reviewerStats([
      { approver: "alice", decision: "approve", secondsToDecide: 1 },
      { approver: "alice", decision: "approve", secondsToDecide: 2 },
      { approver: "alice", decision: "approve", secondsToDecide: 1, canary: true },
    ]);
    expect(stats[0].fastApprovals).toBe(2);
    expect(stats[0].canariesCaught).toBe(0);
  });
});

describe("predicate guard — injection corpus", () => {
  const allowed = { allowedTables: ["loads", "bookings"] };
  const BAD: Array<[string, string]> = [
    ["1=1; DROP TABLE loads", "multi-statement"],
    ["1=1; COMMIT; DROP SCHEMA public CASCADE", "multi-statement"],
    ["id = 1 -- and status = 'x'", "comment"],
    ["id = 1 /* hidden */", "comment"],
    ["id IN (SELECT id FROM customers)", "table-not-allowed"],
    ["id IN (SELECT id FROM pg_catalog.pg_authid)", "foreign-schema"],
    ["pg_sleep(30) IS NOT NULL", "forbidden-function"],
    ["pg_catalog.pg_sleep(30) IS NOT NULL", "forbidden-function"],
    ["id = nextval('loads_id_seq')", "forbidden-function"],
    ["id IN (SELECT 1) ) OR (1=1", "unbalanced"],
    ["true) OR (1=1", "unbalanced"],
    ["id = $$1$$", "dollar-quote"],
    ["exists (select 1 from loads returning id)", "forbidden-keyword"],
    ["id IN (SELECT id INTO tmp FROM loads)", "forbidden-keyword"],
    ["status = 'active' and 1=(select 1 from dblink('x','y'))", "forbidden-function"],
    ["status = 'unterminated", "unterminated"],
  ];
  for (const [pred, code] of BAD) {
    it(`rejects ${pred}`, () => {
      try {
        guardPredicate(pred, allowed);
        throw new Error("expected rejection");
      } catch (e) {
        expect(e).toBeInstanceOf(SqlGuardError);
        expect((e as SqlGuardError).code).toBe(code);
      }
    });
  }

  it("accepts both demo predicates", () => {
    const rogue =
      "id IN (SELECT l.id FROM loads l LEFT JOIN bookings b ON b.load_ref = l.id::text WHERE b.id IS NULL AND l.status = 'active')";
    const plausible =
      "ref IN (SELECT l.ref FROM loads l WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.load_ref = l.ref) AND l.status = 'active' ORDER BY l.created_at LIMIT 900)";
    expect(guardPredicate(rogue, allowed).referencedTables.sort()).toEqual(["bookings", "loads"]);
    const p = guardPredicate(plausible, allowed);
    expect(p.literals).toEqual(["1", "active", "900"]);
    expect(p.shape).not.toContain("active");
  });

  it("does not trip on ordinary column names", () => {
    expect(() => guardPredicate("owner = 'x' AND start < now() AND load_ref IS NULL", allowed)).not.toThrow();
  });

  it("redacts literal values from the shape (no PII to the model)", () => {
    const a = guardPredicate("email = 'jane@example.com' AND age > 40", allowed);
    expect(a.shape).toBe("email = $1 AND age > $2");
    expect(a.literals).toEqual(["jane@example.com", "40"]);
  });
});

describe("policy — single engine, configurable thresholds", () => {
  const ctx = { allowlist: ["loads"], agentMedian: 1210, perRunDestructiveRowsUsed: 0 };
  const del = (rows: number) => ({ tool: "postgres.delete", target: "loads", destructive: true, estimatedRows: rows });

  it("keeps the Gen-1 demo outcomes", () => {
    expect(decide(del(412000), ctx).decision).toBe("block");
    expect(decide(del(900), ctx).decision).toBe("approval");
    expect(decide(del(50), ctx).decision).toBe("allow");
  });
  it("honours per-deployment thresholds (the forks are gone)", () => {
    const halcyon = { DESTRUCTIVE_ROW_HARD_CAP: 50000, PER_RUN_DESTRUCTIVE_ROW_BUDGET: 50000 };
    const r = decide(del(12000), { agentMedian: 11000, perRunDestructiveRowsUsed: 0 }, null, { thresholds: halcyon });
    expect(r.firedRules.map((f) => f.name)).not.toContain("destructive-over-hard-cap");
  });
  it("reads the per-run budget from configuration, not a constant", () => {
    const r = evaluateRules(del(50), { ...ctx, perRunDestructiveRowsUsed: 990 }, { thresholds: { PER_RUN_DESTRUCTIVE_ROW_BUDGET: 1000 } });
    expect(r.decision).toBe("block");
  });
  it("rule levels: monitor records but does not enforce", () => {
    const r = evaluateRules(del(900), ctx, { levels: { "destructive-over-100": "monitor" } });
    expect(r.decision).toBe("allow");
    expect(r.firedRules[0].level).toBe("monitor");
  });
  it("rule levels: approve caps a block at approval", () => {
    const r = evaluateRules(del(6000), { ...ctx, agentMedian: 100000 }, {
      levels: { "destructive-over-hard-cap": "approve", "destructive-budget-exhausted": "approve" },
    });
    expect(r.decision).toBe("approval");
  });
  it("median helper", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([])).toBe(0);
  });
});
