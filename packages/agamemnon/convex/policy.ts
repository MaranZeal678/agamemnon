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

/**
 * Agamemnon policy engine — PURE, DETERMINISTIC, NO MODEL CALLS.
 *
 * This module contains zero Convex imports and zero I/O so it can be unit
 * tested directly (see policy.test.ts). core.ts calls `decide()` from inside a
 * mutation; the classifier's advice is passed in, never fetched here.
 *
 * THE CENTRAL INVARIANT: the model advises, the rules decide. The classifier
 * may only ESCALATE severity, never reduce it — implemented as a max() over the
 * rule-based decision and the classifier's mapped severity. See applyClassifier.
 */

// Severity is a total order. The final decision is the most severe fired rule.
export type Decision = "allow" | "approval" | "block";

const SEVERITY: Record<Decision, number> = { allow: 0, approval: 1, block: 2 };

export function moreSevere(a: Decision, b: Decision): Decision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

// ── Thresholds (the deterministic knobs; surfaced by name in the console) ────
export const POLICY = {
  DESTRUCTIVE_ROW_HARD_CAP: 5000, // rule 2: destructive + >5000 rows → block
  MEDIAN_BLOCK_MULTIPLIER: 20, // rule 3a: >20x median → block
  MEDIAN_APPROVAL_MULTIPLIER: 5, // rule 3b: >5x median → approval
  BLAST_RADIUS_APPROVAL_THRESHOLD: 0.9, // rule 4: ≥0.9 → approval
  DESTRUCTIVE_APPROVAL_ROW_THRESHOLD: 100, // rule 6: destructive + >100 → approval
  PER_RUN_DESTRUCTIVE_ROW_BUDGET: 5000, // rule 5: per-run destructive row budget
} as const;

export interface PolicyAction {
  tool: string; // only "postgres.delete" exists in this system
  target: string; // e.g. "loads"
  destructive: boolean;
  estimatedRows: number; // Agamemnon's OWN measured count (not the agent's claim)
}

export interface PolicyContext {
  allowlist: string[]; // targets Agamemnon is permitted to touch
  agentMedian: number; // this agent's 30-day median rows/destructive-action
  perRunDestructiveRowsUsed: number; // destructive rows already spent this run
}

// A classifier verdict. Optional: the write path must survive without it.
export interface ClassifierVerdict {
  class: string; // e.g. "benign" | "elevated" | "catastrophic"
  blast_radius: number; // 0..1
  rationale: string;
  source: "model" | "heuristic"; // provenance, shown in the console
}

export interface FiredRule {
  name: string;
  severity: Decision;
  detail: string;
}

export interface PolicyResult {
  decision: Decision;
  firedRules: FiredRule[];
  ratioToMedian: number; // estimatedRows / agentMedian, for the console
  classifierEscalated: boolean; // did the model push severity UP?
}

/**
 * Evaluate the deterministic rules only. No classifier here — that is layered
 * on afterwards by `decide()` so the "escalate only" guarantee is explicit.
 */
export function evaluateRules(
  action: PolicyAction,
  ctx: PolicyContext,
): { decision: Decision; firedRules: FiredRule[]; ratioToMedian: number } {
  const fired: FiredRule[] = [];
  const rows = action.estimatedRows;
  const median = ctx.agentMedian > 0 ? ctx.agentMedian : 1;
  const ratio = rows / median;

  const fire = (name: string, severity: Decision, detail: string) =>
    fired.push({ name, severity, detail });

  // Rule 1 — allowlist. Off the list is an unconditional block.
  if (!ctx.allowlist.includes(action.target)) {
    fire(
      "target-not-allowlisted",
      "block",
      `target "${action.target}" is not on the allowlist [${ctx.allowlist.join(", ")}]`,
    );
  }

  if (action.destructive) {
    // Rule 2 — absolute destructive ceiling.
    if (rows > POLICY.DESTRUCTIVE_ROW_HARD_CAP) {
      fire(
        "destructive-over-hard-cap",
        "block",
        `${rows.toLocaleString()} rows exceeds the ${POLICY.DESTRUCTIVE_ROW_HARD_CAP.toLocaleString()}-row destructive hard cap`,
      );
    }
  // build-ref AGMN-T7TXXUFTD7FN

    // Rule 3a — >20x the agent's own median.
    if (rows > POLICY.MEDIAN_BLOCK_MULTIPLIER * median) {
      fire(
        "exceeds-20x-median",
        "block",
        `${rows.toLocaleString()} rows is ${ratio.toFixed(1)}x the agent's 30-day median of ${median.toLocaleString()} (limit 20x)`,
      );
    } else if (rows > POLICY.MEDIAN_APPROVAL_MULTIPLIER * median) {
      // Rule 3b — >5x median (only when not already over 20x).
      fire(
        "exceeds-5x-median",
        "approval",
        `${rows.toLocaleString()} rows is ${ratio.toFixed(1)}x the agent's median of ${median.toLocaleString()} (>5x needs approval)`,
      );
    }

    // Rule 5 — per-run destructive row budget.
    if (ctx.perRunDestructiveRowsUsed + rows > POLICY.PER_RUN_DESTRUCTIVE_ROW_BUDGET) {
      fire(
        "destructive-budget-exhausted",
        "block",
        `this run has spent ${ctx.perRunDestructiveRowsUsed.toLocaleString()} destructive rows; +${rows.toLocaleString()} would exceed the ${POLICY.PER_RUN_DESTRUCTIVE_ROW_BUDGET.toLocaleString()}-row budget`,
      );
    }

    // Rule 6 — any destructive action over 100 rows needs a human.
    if (rows > POLICY.DESTRUCTIVE_APPROVAL_ROW_THRESHOLD) {
      fire(
        "destructive-over-100",
        "approval",
        `${rows.toLocaleString()} destructive rows (>${POLICY.DESTRUCTIVE_APPROVAL_ROW_THRESHOLD}) requires approval by default`,
      );
    }
  }

  const decision = fired.reduce<Decision>((acc, r) => moreSevere(acc, r.severity), "allow");
  return { decision, firedRules: fired, ratioToMedian: ratio };
}

/**
 * Layer the classifier's advice on top of the rules. blast_radius ≥ 0.9 is
 * itself a policy rule (rule 4), and the classifier's class maps to a severity
 * — but BOTH can only ever push the decision UP. We take the max; the model can
 * never talk the rules down from block to approval, or from approval to allow.
 */
export function applyClassifier(
  base: { decision: Decision; firedRules: FiredRule[]; ratioToMedian: number },
  verdict: ClassifierVerdict | null,
): PolicyResult {
  if (!verdict) {
    return { ...base, classifierEscalated: false };
  }

  const fired = [...base.firedRules];
  let decision = base.decision;
  const before = decision;

  // Rule 4 — high blast radius requires approval.
  if (verdict.blast_radius >= POLICY.BLAST_RADIUS_APPROVAL_THRESHOLD) {
    fired.push({
      name: "blast-radius-high",
      severity: "approval",
      detail: `classifier blast radius ${verdict.blast_radius.toFixed(2)} ≥ ${POLICY.BLAST_RADIUS_APPROVAL_THRESHOLD} (${verdict.source})`,
    });
    decision = moreSevere(decision, "approval");
  }

  // Class → severity, escalation only.
  const classSeverity = classToSeverity(verdict.class);
  if (SEVERITY[classSeverity] > SEVERITY[decision]) {
    fired.push({
      name: `classifier-${verdict.class}`,
      severity: classSeverity,
      detail: `classifier rated "${verdict.class}" (${verdict.source}): ${verdict.rationale}`,
    });
    decision = classSeverity;
  }

  return {
    decision,
    firedRules: fired,
    ratioToMedian: base.ratioToMedian,
    classifierEscalated: SEVERITY[decision] > SEVERITY[before],
  };
}

function classToSeverity(cls: string): Decision {
  switch (cls.toLowerCase()) {
    case "catastrophic":
      return "block";
    case "elevated":
    case "high":
      return "approval";
    default:
      return "allow"; // "benign" and unknown classes never lower severity (max wins)
  }
}

/** Full evaluation: rules first, classifier layered on top (escalate only). */
export function decide(
  action: PolicyAction,
  ctx: PolicyContext,
  verdict: ClassifierVerdict | null = null,
): PolicyResult {
  return applyClassifier(evaluateRules(action, ctx), verdict);
}
