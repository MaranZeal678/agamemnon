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

/*
 * Agamemnon policy engine for this app — a thin wrapper over the SHARED kernel
 * (packages/kernel, bundled into ./kernel.cjs). Convex, the broker and every
 * desktop guard now run one implementation; only the thresholds differ.
 * Thresholds sized for the Northwind 50,000-record back office.
 * The model advises; the rules decide. The classifier may only ESCALATE.
 */
"use strict";
const kernel = require("./kernel.cjs");

const POLICY = Object.freeze({
  DESTRUCTIVE_ROW_HARD_CAP: 2500, // destructive + > this  → block
  MEDIAN_BLOCK_MULTIPLIER: 20, //     > this × median      → block
  MEDIAN_APPROVAL_MULTIPLIER: 5, //   > this × median      → approval
  BLAST_RADIUS_APPROVAL_THRESHOLD: 0.9,
  DESTRUCTIVE_APPROVAL_ROW_THRESHOLD: 100,
  PER_RUN_DESTRUCTIVE_ROW_BUDGET: 2500,
});

function evaluateRules(action, ctx) {
  return kernel.evaluateRules({ tool: "delete", target: action.target || "records", ...action }, ctx, { thresholds: POLICY });
}
function applyClassifier(base, verdict) {
  return kernel.applyClassifier(base, verdict, { thresholds: POLICY });
}
function decide(action, ctx, verdict = null) {
  return kernel.decide({ tool: "delete", target: action.target || "records", ...action }, ctx, verdict, { thresholds: POLICY });
}
// Deterministic heuristic classifier (offline). Same shape as production.
function classify(matching, total, destructive, target) {
  return kernel.heuristicVerdict({ matchingRows: matching, totalRows: total, destructive, target });
}

module.exports = { POLICY, decide, evaluateRules, applyClassifier, classify };
