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
 * The single source of truth for the row-count rules. Convex, the broker and
 * both desktop guards all call this module; they differ only in the
 * thresholds they pass in (a 300k-invoice billing demo and a 412k-load freight
 * demo need different caps, not different code).
 *
 * THE CENTRAL INVARIANT: the model advises, the rules decide. The classifier
 * may only ESCALATE severity, never reduce it — implemented as a max() over the
 * rule-based decision and the classifier's mapped severity. See applyClassifier.
 */

export type Decision = "allow" | "approval" | "block";

const SEVERITY: Record<Decision, number> = { allow: 0, approval: 1, block: 2 };

export function moreSevere(a: Decision, b: Decision): Decision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function severityRank(d: Decision): number {
  return SEVERITY[d];
}

// ── Thresholds (the deterministic knobs; surfaced by name in the console) ────
export interface Thresholds {
  DESTRUCTIVE_ROW_HARD_CAP: number; // destructive + > cap → block
  MEDIAN_BLOCK_MULTIPLIER: number; // > N × median → block
  MEDIAN_APPROVAL_MULTIPLIER: number; // > N × median → approval
  BLAST_RADIUS_APPROVAL_THRESHOLD: number; // classifier blast radius ≥ → approval
  DESTRUCTIVE_APPROVAL_ROW_THRESHOLD: number; // destructive + > N → approval
  PER_RUN_DESTRUCTIVE_ROW_BUDGET: number; // per-run destructive row budget
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  DESTRUCTIVE_ROW_HARD_CAP: 5000,
  MEDIAN_BLOCK_MULTIPLIER: 20,
  MEDIAN_APPROVAL_MULTIPLIER: 5,
  BLAST_RADIUS_APPROVAL_THRESHOLD: 0.9,
  DESTRUCTIVE_APPROVAL_ROW_THRESHOLD: 100,
  PER_RUN_DESTRUCTIVE_ROW_BUDGET: 5000,
};

/** Back-compat alias: the Gen-1 constant name. */
export const POLICY: Thresholds = DEFAULT_THRESHOLDS;

/**
 * Per-rule enforcement level (Sentinel/Kyverno style). A rule set to
 * "monitor" is still recorded when it fires but contributes no severity; one
 * set to "approve" is capped at approval. Unlisted rules enforce as written.
 */
export type RuleLevel = "monitor" | "approve" | "block";
export type RuleLevels = Record<string, RuleLevel>;

export interface PolicyAction {
  tool: string;
  target: string;
  /** Derived by the SERVER from the parsed statement — never taken from the agent. */
  destructive: boolean;
  estimatedRows: number; // Agamemnon's OWN measured count (not the agent's claim)
}

export interface PolicyContext {
  /** Targets Agamemnon may touch. Omit to skip the allowlist rule entirely. */
  allowlist?: string[];
  agentMedian: number; // this agent's rolling median rows per destructive action
  perRunDestructiveRowsUsed: number; // destructive rows already spent this run
}

export interface ClassifierVerdict {
  class: string; // "benign" | "elevated" | "catastrophic"
  blast_radius: number; // 0..1
  rationale: string;
  source: "model" | "heuristic";
}

export interface FiredRule {
  name: string;
  severity: Decision;
  detail: string;
  /** Set when a rule level softened this rule (e.g. "monitor"). */
  level?: RuleLevel;
}

export interface PolicyResult {
  decision: Decision;
  firedRules: FiredRule[];
  ratioToMedian: number;
  classifierEscalated: boolean;
}

export interface EvaluateOptions {
  thresholds?: Partial<Thresholds>;
  levels?: RuleLevels;
}

function resolve(opts?: EvaluateOptions): { t: Thresholds; levels: RuleLevels } {
  return { t: { ...DEFAULT_THRESHOLDS, ...(opts?.thresholds ?? {}) }, levels: opts?.levels ?? {} };
}

/** Apply a rule's configured level to its natural severity. */
export function leveled(name: string, natural: Decision, levels: RuleLevels): { severity: Decision; level?: RuleLevel } {
  const level = levels[name];
  if (!level || level === "block") return { severity: natural };
  if (level === "monitor") return { severity: "allow", level };
  return { severity: natural === "block" ? "approval" : natural, level }; // "approve"
}

/** Evaluate the deterministic rules only. The classifier is layered on by decide(). */
export function evaluateRules(
  action: PolicyAction,
  ctx: PolicyContext,
  opts?: EvaluateOptions,
): { decision: Decision; firedRules: FiredRule[]; ratioToMedian: number } {
  const { t, levels } = resolve(opts);
  const fired: FiredRule[] = [];
  const rows = action.estimatedRows;
  const median = ctx.agentMedian > 0 ? ctx.agentMedian : 1;
  const ratio = rows / median;

  const fire = (name: string, natural: Decision, detail: string) => {
    const { severity, level } = leveled(name, natural, levels);
    fired.push(level ? { name, severity, detail, level } : { name, severity, detail });
  };

  // Rule 1 — allowlist. Off the list is an unconditional block.
  if (ctx.allowlist && !ctx.allowlist.includes(action.target)) {
    fire(
      "target-not-allowlisted",
      "block",
      `target "${action.target}" is not on the allowlist [${ctx.allowlist.join(", ")}]`,
    );
  }

  if (action.destructive) {
    // Rule 2 — absolute destructive ceiling.
    if (rows > t.DESTRUCTIVE_ROW_HARD_CAP) {
      fire(
        "destructive-over-hard-cap",
        "block",
        `${rows.toLocaleString()} rows exceeds the ${t.DESTRUCTIVE_ROW_HARD_CAP.toLocaleString()}-row destructive hard cap`,
      );
    }

    // Rule 3a — >Nx the agent's own median; 3b — >Mx (only when not over N).
    if (rows > t.MEDIAN_BLOCK_MULTIPLIER * median) {
      fire(
        "exceeds-20x-median",
        "block",
        `${rows.toLocaleString()} rows is ${ratio.toFixed(1)}x the agent's 30-day median of ${median.toLocaleString()} (limit ${t.MEDIAN_BLOCK_MULTIPLIER}x)`,
      );
    } else if (rows > t.MEDIAN_APPROVAL_MULTIPLIER * median) {
      fire(
        "exceeds-5x-median",
        "approval",
        `${rows.toLocaleString()} rows is ${ratio.toFixed(1)}x the agent's median of ${median.toLocaleString()} (>${t.MEDIAN_APPROVAL_MULTIPLIER}x needs approval)`,
      );
    }

    // Rule 5 — per-run destructive row budget (now read from configuration).
    if (ctx.perRunDestructiveRowsUsed + rows > t.PER_RUN_DESTRUCTIVE_ROW_BUDGET) {
      fire(
        "destructive-budget-exhausted",
        "block",
        `this run has spent ${ctx.perRunDestructiveRowsUsed.toLocaleString()} destructive rows; +${rows.toLocaleString()} would exceed the ${t.PER_RUN_DESTRUCTIVE_ROW_BUDGET.toLocaleString()}-row budget`,
      );
    }

    // Rule 6 — any destructive action over N rows needs a human.
    if (rows > t.DESTRUCTIVE_APPROVAL_ROW_THRESHOLD) {
      fire(
        "destructive-over-100",
        "approval",
        `${rows.toLocaleString()} destructive rows (>${t.DESTRUCTIVE_APPROVAL_ROW_THRESHOLD}) requires approval by default`,
      );
    }
  }

  const decision = fired.reduce<Decision>((acc, r) => moreSevere(acc, r.severity), "allow");
  return { decision, firedRules: fired, ratioToMedian: ratio };
}

/**
 * Layer the classifier's advice on top of the rules. Both the blast-radius
 * rule and the class mapping can only push the decision UP — max() wins.
 */
export function applyClassifier(
  base: { decision: Decision; firedRules: FiredRule[]; ratioToMedian: number },
  verdict: ClassifierVerdict | null,
  opts?: EvaluateOptions,
): PolicyResult {
  if (!verdict) return { ...base, classifierEscalated: false };
  const { t } = resolve(opts);

  const fired = [...base.firedRules];
  let decision = base.decision;
  const before = decision;

  if (verdict.blast_radius >= t.BLAST_RADIUS_APPROVAL_THRESHOLD) {
    fired.push({
      name: "blast-radius-high",
      severity: "approval",
      detail: `classifier blast radius ${verdict.blast_radius.toFixed(2)} ≥ ${t.BLAST_RADIUS_APPROVAL_THRESHOLD} (${verdict.source})`,
    });
    decision = moreSevere(decision, "approval");
  }

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

export function classToSeverity(cls: string): Decision {
  switch (String(cls).toLowerCase()) {
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
  opts?: EvaluateOptions,
): PolicyResult {
  return applyClassifier(evaluateRules(action, ctx, opts), verdict, opts);
}

/** Deterministic heuristic classifier — same shape as the model's verdict. */
export function heuristicVerdict(input: {
  matchingRows: number;
  totalRows: number;
  destructive: boolean;
  target: string;
}): ClassifierVerdict {
  const { matchingRows, totalRows, destructive, target } = input;
  const fraction = totalRows > 0 ? matchingRows / totalRows : matchingRows > 0 ? 1 : 0;
  const blast_radius = Math.max(0, Math.min(1, fraction));
  let cls: string;
  if (!destructive) cls = "benign";
  else if (blast_radius >= 0.9) cls = "catastrophic";
  else if (blast_radius >= 0.2 || matchingRows > 1000) cls = "elevated";
  else cls = "benign";
  return {
    class: cls,
    blast_radius,
    rationale: `matches ${matchingRows.toLocaleString()} of ${totalRows.toLocaleString()} rows in ${target} (${(blast_radius * 100).toFixed(2)}% of the table)`,
    source: "heuristic",
  };
}

/** Rolling median of recent per-action row counts (used to refresh agent stats). */
export function median(values: number[]): number {
  const xs = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}
