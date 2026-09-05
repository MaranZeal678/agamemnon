import { describe, it, expect } from "vitest";
import {
  decide,
  evaluateRules,
  applyClassifier,
  moreSevere,
  POLICY,
  type PolicyAction,
  type PolicyContext,
  type ClassifierVerdict,
} from "../convex/policy";

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  allowlist: ["loads", "bookings"],
  agentMedian: 1210,
  perRunDestructiveRowsUsed: 0,
  ...over,
});

const del = (rows: number, over: Partial<PolicyAction> = {}): PolicyAction => ({
  tool: "postgres.delete",
  target: "loads",
  destructive: true,
  estimatedRows: rows,
  ...over,
});

describe("severity ordering", () => {
  it("orders allow < approval < block", () => {
    expect(moreSevere("allow", "approval")).toBe("approval");
    expect(moreSevere("approval", "block")).toBe("block");
    expect(moreSevere("block", "allow")).toBe("block");
  });
});

describe("rule 1 — allowlist", () => {
  it("blocks a target that is not on the allowlist", () => {
    const r = evaluateRules(del(10, { target: "customers" }), ctx());
    expect(r.decision).toBe("block");
    expect(r.firedRules.map((f) => f.name)).toContain("target-not-allowlisted");
  });
});

describe("rule 2 — destructive hard cap", () => {
  it("blocks a destructive delete over 5000 rows", () => {
    const r = evaluateRules(del(5001), ctx({ agentMedian: 100000 }));
    expect(r.decision).toBe("block");
    expect(r.firedRules.map((f) => f.name)).toContain("destructive-over-hard-cap");
  });
});

describe("rule 3 — median multipliers", () => {
  it("blocks over 20x the agent median", () => {
    // 412,000 vs median 1210 → ~340x
    const r = evaluateRules(del(412000), ctx());
    expect(r.decision).toBe("block");
    const names = r.firedRules.map((f) => f.name);
    expect(names).toContain("exceeds-20x-median");
    expect(r.ratioToMedian).toBeGreaterThan(20);
  });

  it("requires approval between 5x and 20x median", () => {
    // median 100 → 5x=500, 20x=2000. 800 rows is in-between; keep <=hard cap.
    const r = evaluateRules(del(800), ctx({ agentMedian: 100 }));
    expect(r.decision).toBe("approval");
    const names = r.firedRules.map((f) => f.name);
    expect(names).toContain("exceeds-5x-median");
    expect(names).not.toContain("exceeds-20x-median");
  });
});

describe("rule 5 — per-run destructive budget", () => {
  it("blocks when the run's destructive budget would be exceeded", () => {
    const r = evaluateRules(
      del(200),
      ctx({ agentMedian: 100000, perRunDestructiveRowsUsed: POLICY.PER_RUN_DESTRUCTIVE_ROW_BUDGET }),
    );
    expect(r.decision).toBe("block");
    expect(r.firedRules.map((f) => f.name)).toContain("destructive-budget-exhausted");
  });
});

describe("rule 6 — destructive over 100", () => {
  it("requires approval for a plausible 900-row delete (the Act 3 case)", () => {
    const r = evaluateRules(del(900), ctx());
    expect(r.decision).toBe("approval");
    const names = r.firedRules.map((f) => f.name);
    expect(names).toContain("destructive-over-100");
    expect(names).not.toContain("destructive-over-hard-cap");
    expect(names).not.toContain("exceeds-20x-median");
  });

  it("allows a tiny destructive delete under 100 rows", () => {
    const r = evaluateRules(del(50), ctx());
    expect(r.decision).toBe("allow");
    expect(r.firedRules).toHaveLength(0);
  });
});

describe("classifier — escalate only, never reduce", () => {
  const benign: ClassifierVerdict = {
    class: "benign",
    blast_radius: 0.01,
    rationale: "bounded",
    source: "model",
  };
  const catastrophic: ClassifierVerdict = {
    class: "catastrophic",
    blast_radius: 0.99,
    rationale: "matches whole table",
    source: "model",
  };

  it("cannot talk a block down to approval", () => {
    const base = evaluateRules(del(412000), ctx()); // block
    const r = applyClassifier(base, benign);
    expect(r.decision).toBe("block");
    expect(r.classifierEscalated).toBe(false);
  });

  it("can escalate an allow up to approval via blast radius", () => {
    const base = evaluateRules(del(50), ctx()); // allow
    const r = applyClassifier(base, { ...catastrophic, class: "benign" }); // only blast radius high
    expect(r.decision).toBe("approval");
    expect(r.firedRules.map((f) => f.name)).toContain("blast-radius-high");
    expect(r.classifierEscalated).toBe(true);
  });

  it("can escalate an approval up to block via catastrophic class", () => {
    const base = evaluateRules(del(900), ctx()); // approval
    const r = applyClassifier(base, catastrophic);
    expect(r.decision).toBe("block");
    expect(r.classifierEscalated).toBe(true);
  });

  it("write path survives with no verdict at all", () => {
    const r = decide(del(412000), ctx(), null);
    expect(r.decision).toBe("block");
    expect(r.classifierEscalated).toBe(false);
  });
});

describe("end-to-end demo cases", () => {
  it("Act 2 — 412k delete is blocked with multiple red rules", () => {
    const r = decide(del(412000), ctx());
    expect(r.decision).toBe("block");
    expect(r.firedRules.length).toBeGreaterThanOrEqual(3);
  });

  it("Act 3 — 900-row delete needs approval, not a block", () => {
    const r = decide(del(900), ctx());
    expect(r.decision).toBe("approval");
  });
});
