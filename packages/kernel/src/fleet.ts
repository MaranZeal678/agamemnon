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

import type { TrustLabel } from "./effect.ts";

/**
 * Cross-request state: the things a per-statement guard cannot see.
 *
 *  - BUDGETS keyed to the ROOT HUMAN and to the TARGET OBJECT, summed across
 *    every agent and sub-agent — so splitting a blocked job across ten
 *    sub-agents (a decomposition attack) or a runaway loop of small deletes
 *    still trips the breaker. Keying on agent credentials alone would not.
 *  - LEASES + read-version checks — two automations acting on the same
 *    resource are serialised, and a write planned against stale state is
 *    rejected at commit (the AWS Oct-2025 DNS-race class).
 *  - TAINT — once a task has read untrusted input AND private data, any effect
 *    that can move data out needs a human (the "lethal trifecta").
 *  - DENIAL MEMORY — a denied request stays denied for every agent in the same
 *    task lineage. Matched by exact fingerprint only: we do not claim robustness
 *    to rewording, which is an unsolved classification problem.
 *  - PREVIEW FIDELITY — how far each connector's previews drift from reality.
 *
 * All pure: callers pass in the ledger rows they have stored.
 */

// ── Budgets ──────────────────────────────────────────────────────────────────
export interface LedgerEntry {
  at: number;
  rootOwner: string;
  agent: string;
  taskId: string;
  /** "system:resource" — e.g. "postgres:loads". */
  object: string;
  rows: number;
  resources: number;
  amountMinor: number;
}

export interface BudgetLimits {
  windowMs: number;
  /** Per root human, across all of their agents. */
  ownerRows: number;
  ownerResources: number;
  ownerAmountMinor: number;
  /** Per target object, across everyone. */
  objectRows: number;
  /** Effects per minute per root human — runaway-loop breaker. */
  ownerEffectsPerMinute: number;
}

export const DEFAULT_BUDGETS: BudgetLimits = {
  windowMs: 60 * 60 * 1000,
  ownerRows: 20000,
  ownerResources: 25,
  ownerAmountMinor: 500_00,
  objectRows: 50000,
  ownerEffectsPerMinute: 60,
};

export interface BudgetFinding {
  rule: string;
  detail: string;
}

/** Would adding `next` breach a rolling budget? Returns every breached budget. */
export function checkBudgets(
  ledger: LedgerEntry[],
  next: Omit<LedgerEntry, "at">,
  now: number,
  limits: BudgetLimits = DEFAULT_BUDGETS,
): BudgetFinding[] {
  const recent = ledger.filter((e) => now - e.at < limits.windowMs);
  const mine = recent.filter((e) => e.rootOwner === next.rootOwner);
  const sum = (xs: LedgerEntry[], k: "rows" | "resources" | "amountMinor") => xs.reduce((a, e) => a + e[k], 0);
  const out: BudgetFinding[] = [];
  const agents = new Set(mine.map((e) => e.agent).concat(next.agent));

  const rows = sum(mine, "rows") + next.rows;
  if (rows > limits.ownerRows) {
    out.push({
      rule: "owner-row-budget",
      detail: `${rows.toLocaleString()} rows changed in the last ${Math.round(limits.windowMs / 60000)} min on behalf of ${next.rootOwner} across ${agents.size} agent(s) (limit ${limits.ownerRows.toLocaleString()})`,
    });
  }
  const res = sum(mine, "resources") + next.resources;
  if (res > limits.ownerResources) {
    out.push({ rule: "owner-resource-budget", detail: `${res} resources changed for ${next.rootOwner} (limit ${limits.ownerResources})` });
  }
  const amt = sum(mine, "amountMinor") + next.amountMinor;
  if (next.amountMinor > 0 && amt > limits.ownerAmountMinor) {
    out.push({ rule: "owner-money-budget", detail: `${(amt / 100).toFixed(2)} moved for ${next.rootOwner} (limit ${(limits.ownerAmountMinor / 100).toFixed(2)})` });
  }
  const objRows = sum(recent.filter((e) => e.object === next.object), "rows") + next.rows;
  if (objRows > limits.objectRows) {
    out.push({ rule: "object-row-budget", detail: `${objRows.toLocaleString()} rows changed on ${next.object} by everyone (limit ${limits.objectRows.toLocaleString()})` });
  }
  const lastMinute = mine.filter((e) => now - e.at < 60000).length + 1;
  if (lastMinute > limits.ownerEffectsPerMinute) {
    out.push({ rule: "runaway-loop", detail: `${lastMinute} effects in the last minute for ${next.rootOwner} (limit ${limits.ownerEffectsPerMinute}/min)` });
  }
  return out;
}

// ── Leases + write skew ──────────────────────────────────────────────────────
export interface Lease {
  key: string; // resource key, hierarchical with ":" — "postgres:loads", "github:org/repo:main"
  taskId: string;
  expiresAt: number;
}

const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);

export type LeaseResult = { ok: true; lease: Lease } | { ok: false; heldBy: Lease };

/** Acquire a lease on `key` for `taskId`, unless another live task holds an overlapping one. */
export function acquireLease(leases: Lease[], key: string, taskId: string, now: number, ttlMs = 5 * 60 * 1000): LeaseResult {
  const conflict = leases.find((l) => l.expiresAt > now && l.taskId !== taskId && overlaps(l.key, key));
  if (conflict) return { ok: false, heldBy: conflict };
  return { ok: true, lease: { key, taskId, expiresAt: now + ttlMs } };
}

/** Optimistic concurrency: the version read at planning time must still be current at commit. */
export function checkReadVersion(readVersion: string | undefined, currentVersion: string | undefined): { ok: boolean; detail: string } {
  if (!readVersion || !currentVersion) return { ok: true, detail: "no version tracked" };
  return readVersion === currentVersion
    ? { ok: true, detail: "state unchanged since planning" }
    : { ok: false, detail: `planned against version ${readVersion.slice(0, 12)}, but the target is now ${currentVersion.slice(0, 12)} — another actor changed it` };
}

// ── Taint (lethal trifecta) ──────────────────────────────────────────────────
export interface TaskTaint {
  readUntrusted: boolean;
  readPrivate: boolean;
  untrustedSources: string[];
}

export const CLEAN_TAINT: TaskTaint = { readUntrusted: false, readPrivate: false, untrustedSources: [] };

export function absorbTaint(t: TaskTaint, read: { labels?: TrustLabel[]; private?: boolean; source?: string }): TaskTaint {
  const untrusted = (read.labels ?? []).includes("untrusted");
  return {
    readUntrusted: t.readUntrusted || untrusted,
    readPrivate: t.readPrivate || !!read.private,
    untrustedSources: untrusted && read.source ? [...new Set([...t.untrustedSources, read.source])] : t.untrustedSources,
  };
}

/** Private data + untrusted instructions + a way out = needs a human. */
export function lethalTrifecta(t: TaskTaint, egress: boolean): { fires: boolean; detail: string } {
  const fires = egress && t.readUntrusted && t.readPrivate;
  return {
    fires,
    detail: fires
      ? `this task read untrusted input (${t.untrustedSources.join(", ") || "unlabelled source"}) and private data, and this effect can send data out`
      : "",
  };
}

// ── Denial memory ────────────────────────────────────────────────────────────
export interface DenialRecord {
  fingerprint: string;
  taskId: string;
  rootOwner: string;
  at: number;
  reason: string;
}

/** A request denied anywhere in the same task — or for the same root owner recently — stays denied. */
export function priorDenial(
  denials: DenialRecord[],
  fingerprint: string,
  taskId: string,
  rootOwner: string,
  now: number,
  ownerWindowMs = 24 * 3600 * 1000,
): DenialRecord | undefined {
  return denials.find(
    (d) => d.fingerprint === fingerprint && (d.taskId === taskId || (d.rootOwner === rootOwner && now - d.at < ownerWindowMs)),
  );
}

// ── Preview fidelity ─────────────────────────────────────────────────────────
/** 1.0 = the preview matched reality exactly. Compares the shared numeric counts. */
export function fidelityScore(predicted: Record<string, number>, observed: Record<string, number>): number {
  const keys = Object.keys(predicted).filter((k) => k in observed);
  if (keys.length === 0) return 1;
  const errs = keys.map((k) => {
    const p = predicted[k];
    const o = observed[k];
    if (p === o) return 0;
    return Math.min(1, Math.abs(p - o) / Math.max(1, Math.abs(p), Math.abs(o)));
  });
  return 1 - errs.reduce((a, b) => a + b, 0) / errs.length;
}

/** Rolling mean fidelity for a connector; below the floor its previews are treated as estimates. */
export function connectorFidelity(scores: number[], floor = 0.98): { mean: number; trusted: boolean; samples: number } {
  if (scores.length === 0) return { mean: 1, trusted: true, samples: 0 };
  const recent = scores.slice(-100);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  return { mean, trusted: mean >= floor, samples: recent.length };
}
