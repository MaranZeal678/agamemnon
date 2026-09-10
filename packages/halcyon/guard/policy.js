/*
 * Agamemnon policy engine — PURE, DETERMINISTIC, NO MODEL CALLS.
 * The model advises; the rules decide. The classifier may only ESCALATE.
 * Constants tuned for Halcyon's billing scale (normal nightly cleanup ~11k rows).
 */
"use strict";

const POLICY = {
  DESTRUCTIVE_ROW_HARD_CAP: 50000, // destructive + > this  → block
  MEDIAN_BLOCK_MULTIPLIER: 20, //     > this × median      → block
  MEDIAN_APPROVAL_MULTIPLIER: 5, //   > this × median      → approval
  BLAST_RADIUS_APPROVAL_THRESHOLD: 0.9,
  DESTRUCTIVE_APPROVAL_ROW_THRESHOLD: 25000, // over this needs a human
  PER_RUN_DESTRUCTIVE_ROW_BUDGET: 50000,
};

const SEV = { allow: 0, approval: 1, block: 2 };
const moreSevere = (a, b) => (SEV[a] >= SEV[b] ? a : b);

function evaluateRules(action, ctx) {
  const fired = [];
  const rows = action.estimatedRows;
  const median = ctx.agentMedian > 0 ? ctx.agentMedian : 1;
  const ratio = rows / median;
  const fire = (name, severity, detail) => fired.push({ name, severity, detail });

  if (action.destructive) {
    if (rows > POLICY.DESTRUCTIVE_ROW_HARD_CAP)
      fire("destructive-over-hard-cap", "block",
        `${rows.toLocaleString()} rows exceeds the ${POLICY.DESTRUCTIVE_ROW_HARD_CAP.toLocaleString()}-row destructive hard cap`);
    if (rows > POLICY.MEDIAN_BLOCK_MULTIPLIER * median)
      fire("exceeds-20x-median", "block",
        `${rows.toLocaleString()} is ${ratio.toFixed(1)}× the agent's median of ${median.toLocaleString()} (limit 20×)`);
    else if (rows > POLICY.MEDIAN_APPROVAL_MULTIPLIER * median)
      fire("exceeds-5x-median", "approval",
        `${rows.toLocaleString()} is ${ratio.toFixed(1)}× the agent's median (>5× needs approval)`);
    if (ctx.perRunDestructiveRowsUsed + rows > POLICY.PER_RUN_DESTRUCTIVE_ROW_BUDGET)
      fire("destructive-budget-exhausted", "block",
        `+${rows.toLocaleString()} would exceed the ${POLICY.PER_RUN_DESTRUCTIVE_ROW_BUDGET.toLocaleString()}-row per-run budget`);
    if (rows > POLICY.DESTRUCTIVE_APPROVAL_ROW_THRESHOLD)
      fire("destructive-over-threshold", "approval",
        `${rows.toLocaleString()} destructive rows (>${POLICY.DESTRUCTIVE_APPROVAL_ROW_THRESHOLD.toLocaleString()}) requires approval`);
  }
  const decision = fired.reduce((acc, r) => moreSevere(acc, r.severity), "allow");
  return { decision, firedRules: fired, ratioToMedian: ratio };
}

function applyClassifier(base, verdict) {
  if (!verdict) return { ...base, classifierEscalated: false };
  const fired = [...base.firedRules];
  let decision = base.decision;
  const before = decision;
  if (verdict.blast_radius >= POLICY.BLAST_RADIUS_APPROVAL_THRESHOLD) {
    fired.push({ name: "blast-radius-high", severity: "approval",
      detail: `classifier blast radius ${verdict.blast_radius.toFixed(2)} ≥ ${POLICY.BLAST_RADIUS_APPROVAL_THRESHOLD} (${verdict.source})` });
    decision = moreSevere(decision, "approval");
  }
  const cs = verdict.class === "catastrophic" ? "block" : verdict.class === "elevated" ? "approval" : "allow";
  if (SEV[cs] > SEV[decision]) {
    fired.push({ name: `classifier-${verdict.class}`, severity: cs, detail: `classifier rated "${verdict.class}" (${verdict.source}): ${verdict.rationale}` });
    decision = cs;
  }
  return { decision, firedRules: fired, ratioToMedian: base.ratioToMedian, classifierEscalated: SEV[decision] > SEV[before] };
}

function decide(action, ctx, verdict = null) { return applyClassifier(evaluateRules(action, ctx), verdict); }

function classify(matching, total, destructive, target) {
  const frac = total > 0 ? matching / total : matching > 0 ? 1 : 0;
  const blast = Math.max(0, Math.min(1, frac));
  let cls = !destructive ? "benign" : blast >= 0.9 ? "catastrophic" : blast >= 0.2 || matching > 5000 ? "elevated" : "benign";
  return { class: cls, blast_radius: blast, source: "heuristic",
    rationale: `matches ${matching.toLocaleString()} of ${total.toLocaleString()} rows (${(blast * 100).toFixed(1)}% of ${target})` };
}

module.exports = { POLICY, decide, classify };
