// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { moreSevere, leveled, type Decision, type FiredRule, type RuleLevels } from "./policy.ts";
import { requiredApprovals } from "./approvals.ts";
import type { Effect, Reversibility } from "./effect.ts";
import {
  acquireLease,
  checkBudgets,
  lethalTrifecta,
  priorDenial,
  DEFAULT_BUDGETS,
  type BudgetLimits,
  type DenialRecord,
  type Lease,
  type LedgerEntry,
  type TaskTaint,
} from "./fleet.ts";

/**
 * Admission — the single decision for one measured effect.
 *
 * Deterministic and ordered from cheapest to costliest. The LLM opinion, when
 * used, is passed in as connector rules and can only add severity. The output
 * says not just allow / approval / block, but HOW MANY independent humans must
 * approve, whether an irreversible effect is converted into a cancellable hold,
 * and which tier decided (T1 = deterministic, T3 = human).
 */

export interface AdmissionContext {
  now: number;
  mode?: "enforce" | "shadow";
  levels?: RuleLevels;
  /** Rules the connector already evaluated (row policy, classifier escalation …). */
  connectorRules?: FiredRule[];
  ledger?: LedgerEntry[];
  budgets?: BudgetLimits;
  leases?: Lease[];
  taint?: TaskTaint;
  denials?: DenialRecord[];
  fingerprint?: string;
  trust?: "normal" | "supervised" | "suspended";
  /** Rolling preview fidelity of this connector. */
  connectorFidelityTrusted?: boolean;
  /** The connector can turn this effect into a cancellable hold (outbox, auth-capture, tombstone). */
  canDefer?: boolean;
  /** Result of the optimistic-concurrency check, if the connector tracks versions. */
  readVersion?: { ok: boolean; detail: string };
  twoPersonRowThreshold?: number;
  /** An operator-accepted allow rule matched this fingerprint (never for oversight / irreversible). */
  learnedAllow?: boolean;
}

export interface AdmissionResult {
  decision: Decision;
  /** In shadow mode the enforced decision is "allow"; this is what WOULD have happened. */
  wouldDecision: Decision;
  firedRules: FiredRule[];
  requiredApprovals: number;
  /** Final reversibility after any hold conversion. */
  reversibility: Reversibility;
  convertToHold: boolean;
  tier: "T1" | "T3";
  leases: Lease[];
  ledgerEntry: Omit<LedgerEntry, "at">;
}

/** The single number that best describes an effect's size, per connector convention. */
export function primaryCount(e: Effect): number {
  const c = e.preview.counts;
  if (typeof c.rows === "number") return c.rows;
  if (typeof c.records === "number") return c.records;
  if (typeof c.recipients === "number") return c.recipients;
  if (typeof c.resources === "number") return c.resources;
  const plan = (c.destroy ?? 0) + (c.replace ?? 0) + (c.update ?? 0) + (c.create ?? 0);
  if (plan > 0) return plan;
  if (typeof c.files === "number") return c.files;
  return 0;
}

const isWrite = (e: Effect) => e.writes.length > 0 || e.egress || e.creates.length > 0;

export function admit(effect: Effect, ctx: AdmissionContext): AdmissionResult {
  const levels = ctx.levels ?? {};
  const fired: FiredRule[] = [];
  const fire = (name: string, natural: Decision, detail: string) => {
    const { severity, level } = leveled(name, natural, levels);
    fired.push(level ? { name, severity, detail, level } : { name, severity, detail });
  };
  // Connector-evaluated rules honour the same per-rule levels as kernel rules.
  for (const r of ctx.connectorRules ?? []) {
    const { severity, level } = r.level ? { severity: r.severity, level: r.level } : leveled(r.name, r.severity, levels);
    fired.push(level ? { ...r, severity, level } : r);
  }

  const req = effect.request;
  const count = primaryCount(effect);
  let reversibility: Reversibility = effect.reversibility;
  let convertToHold = false;
  let needsTwo = false;

  // Trust: contradiction history tightens what the agent may do.
  if (ctx.trust === "suspended") fire("agent-suspended", "block", `${req.requester.id} is suspended after repeated claim contradictions; its owner must reinstate it`);
  else if (ctx.trust === "supervised" && isWrite(effect)) fire("agent-supervised", "approval", `${req.requester.id} recently made a claim the systems of record contradicted — every write now needs a human`);

  // Denial memory (exact fingerprint only).
  if (ctx.fingerprint && ctx.denials?.length) {
    const d = priorDenial(ctx.denials, ctx.fingerprint, req.taskId, req.delegation.rootOwner, ctx.now);
    if (d) fire("previously-denied", "block", `an identical request was denied ${d.taskId === req.taskId ? "earlier in this task" : `for ${d.rootOwner} recently`}: ${d.reason}`);
  }

  // Declared intent vs measured effect.
  const expected = req.declared?.expectedCount;
  if (typeof expected === "number" && expected >= 0 && count > Math.max(expected * 3, expected + 50)) {
    fire("intent-mismatch", "block", `the agent expected ~${expected.toLocaleString()} but the measured effect is ${count.toLocaleString()} (${expected > 0 ? (count / expected).toFixed(1) + "×" : "unbounded"})`);
  }
  if (req.declared?.env && req.target.env && req.declared.env.toLowerCase() !== req.target.env.toLowerCase()) {
    fire("environment-mismatch", "block", `the agent declared "${req.declared.env}" but the target is registered as "${req.target.env}"`);
  }

  // Isolation: leases on everything written, and the read-version check.
  const leases: Lease[] = [];
  for (const key of effect.writes) {
    const r = acquireLease(ctx.leases ?? [], key, req.taskId, ctx.now);
    if (r.ok) leases.push(r.lease);
    else fire("resource-leased", "block", `${key} is leased by task ${r.heldBy.taskId} until ${new Date(r.heldBy.expiresAt).toISOString()} — concurrent writers are serialised`);
  }
  if (ctx.readVersion && !ctx.readVersion.ok) fire("stale-read", "block", ctx.readVersion.detail);

  // Fleet budgets keyed to the root human and the target object.
  const ledgerEntry: Omit<LedgerEntry, "at"> = {
    rootOwner: req.delegation.rootOwner,
    agent: req.requester.id,
    taskId: req.taskId,
    object: `${req.target.system}:${req.target.resource}`,
    rows: effect.writes.length ? (effect.preview.counts.rows ?? effect.preview.counts.records ?? 0) : 0,
    resources: (effect.preview.counts.destroy ?? 0) + (effect.preview.counts.replace ?? 0) + (effect.preview.counts.resources ?? 0),
    amountMinor: effect.preview.amountMinor ?? 0,
  };
  if (isWrite(effect)) {
    for (const b of checkBudgets(ctx.ledger ?? [], ledgerEntry, ctx.now, ctx.budgets ?? DEFAULT_BUDGETS)) fire(b.rule, "block", b.detail);
  }

  // Backups in the same blast radius as the data.
  if (effect.destroysBackups) fire("destroys-data-and-backups", "block", "this effect would destroy the data AND its last restorable copy — refused regardless of approval");

  // Oversight-integrity class: two humans, never automatic.
  for (const o of effect.oversight) {
    fire(`oversight:${o.rule}`, "approval", o.detail);
    needsTwo = true;
  }

  // Reversibility admission.
  if (reversibility === "irreversible") {
    if (ctx.canDefer) {
      convertToHold = true;
      reversibility = "hold";
      fired.push({ name: "irreversible-converted-to-hold", severity: "allow", detail: "converted to a held action with a cancel window" });
    } else {
      fire("irreversible-effect", "approval", "nothing can reverse this effect once it runs");
      needsTwo = true;
    }
  }

  // Durable access that would outlive the task.
  const durable = effect.creates.filter((a) => a.durableAccess);
  if (durable.length) {
    fire("creates-durable-access", "approval", `creates ${durable.map((a) => `${a.kind} ${a.id}`).join(", ")} — revoked automatically when the task ends unless promoted`);
  }

  // Taint: private data + untrusted input + egress.
  if (ctx.taint) {
    const t = lethalTrifecta(ctx.taint, effect.egress);
    if (t.fires) fire("lethal-trifecta", "approval", t.detail);
  }

  // Preview fidelity: estimates on non-undoable writes need a human.
  const lowFidelity = effect.preview.fidelity !== "exact" || ctx.connectorFidelityTrusted === false;
  if (lowFidelity && isWrite(effect) && reversibility !== "undo" && reversibility !== "hold") {
    fire("estimated-preview", "approval", `preview fidelity is ${ctx.connectorFidelityTrusted === false ? "below the connector's floor" : effect.preview.fidelity} for a write that cannot be undone`);
  }

  let decision = fired.reduce<Decision>((acc, r) => moreSevere(acc, r.severity), "allow");

  // A learned allow rule can only relax an "approval" that came from row-count
  // policy — never oversight, irreversibility, taint, intent or a block.
  if (ctx.learnedAllow && decision === "approval") {
    const relaxable = fired.filter((r) => r.severity === "approval").every((r) => /^(destructive-over-100|exceeds-5x-median)$/.test(r.name));
    if (relaxable) {
      decision = "allow";
      fired.push({ name: "learned-allow", severity: "allow", detail: "matched an operator-accepted allow rule for this request shape" });
    }
  }

  const required = requiredApprovals({
    rows: count,
    reversibility,
    oversightReducing: needsTwo && effect.oversight.length > 0,
    twoPersonRowThreshold: ctx.twoPersonRowThreshold,
  });
  const enforce = ctx.mode !== "shadow";
  return {
    decision: enforce ? decision : "allow",
    wouldDecision: decision,
    firedRules: fired,
    requiredApprovals: needsTwo ? Math.max(2, required) : required,
    reversibility,
    convertToHold,
    tier: decision === "approval" ? "T3" : "T1",
    leases: decision === "block" ? [] : leases,
    ledgerEntry,
  };
}
