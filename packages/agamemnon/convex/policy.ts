// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * The policy engine now lives in @agamemnon/kernel — one implementation shared
 * by Convex, the broker and both desktop guards (previously three forks with
 * caps of 5,000 / 2,500 / 50,000). This module re-exports it so existing
 * imports keep working. Still pure: no Convex imports, no I/O, no model calls.
 */
export {
  decide,
  evaluateRules,
  applyClassifier,
  moreSevere,
  classToSeverity,
  heuristicVerdict,
  median,
  POLICY,
  DEFAULT_THRESHOLDS,
  type Decision,
  type Thresholds,
  type RuleLevel,
  type RuleLevels,
  type PolicyAction,
  type PolicyContext,
  type ClassifierVerdict,
  type FiredRule,
  type PolicyResult,
} from "../../kernel/src/policy.ts";
