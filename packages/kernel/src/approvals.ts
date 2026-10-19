// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * Approval integrity — who may approve what, and when an approval counts.
 *
 * Three-party separation: the REQUESTER (the agent or script that proposed
 * the effect), the LAUNCHER (the human who started / owns that agent), and the
 * APPROVER must all be different principals. Segregation of duties already
 * separates requester from approver (Teleport, GitHub required reviewers);
 * agents add the launcher — otherwise the person who told the agent to do the
 * thing can rubber-stamp it. Approvals from agents count as none.
 */

export type PrincipalKind = "human" | "agent" | "script" | "mcp";

export interface Principal {
  kind: PrincipalKind;
  id: string;
}

export interface ApprovalRecord {
  approver: Principal;
  decision: "approve" | "deny";
  at: number;
  /** Set when this was a reviewer canary rather than a real request. */
  canary?: boolean;
}

export interface ApprovalSubject {
  requester: Principal;
  /** The human who launched / owns the requesting agent, if known. */
  launcher?: string;
  /** How many distinct human approvals this effect needs (1 or 2+). */
  required: number;
}

export interface ApproverCheck {
  ok: boolean;
  reason?: string;
}

/** Can this principal approve this subject at all? */
export function checkApprover(approver: Principal, subject: ApprovalSubject): ApproverCheck {
  if (approver.kind !== "human") {
    return { ok: false, reason: `approvals from a ${approver.kind} count as none — a human must decide` };
  }
  if (approver.id === subject.requester.id) {
    return { ok: false, reason: "the requester cannot approve its own request" };
  }
  if (subject.launcher && approver.id === subject.launcher) {
    return { ok: false, reason: "the human who launched this agent cannot approve its requests" };
  }
  return { ok: true };
}

export type ApprovalState =
  | { state: "pending"; approvals: number; required: number }
  | { state: "approved"; approvers: string[] }
  | { state: "denied"; by: string };

/** Resolve the current state from the approval records (deny wins immediately). */
export function approvalState(subject: ApprovalSubject, records: ApprovalRecord[]): ApprovalState {
  const valid = records.filter((r) => !r.canary && checkApprover(r.approver, subject).ok);
  const denial = valid.find((r) => r.decision === "deny");
  if (denial) return { state: "denied", by: denial.approver.id };
  const approvers = [...new Set(valid.filter((r) => r.decision === "approve").map((r) => r.approver.id))];
  if (approvers.length >= subject.required) return { state: "approved", approvers };
  return { state: "pending", approvals: approvers.length, required: subject.required };
}

export interface RequiredApprovalInput {
  rows?: number;
  reversibility?: "undo" | "compensate" | "hold" | "irreversible";
  oversightReducing?: boolean;
  twoPersonRowThreshold?: number;
}

/** How many distinct human approvers an effect needs. */
export function requiredApprovals(input: RequiredApprovalInput): number {
  if (input.oversightReducing) return 2;
  if (input.reversibility === "irreversible") return 2;
  const threshold = input.twoPersonRowThreshold ?? 2000;
  if ((input.rows ?? 0) > threshold) return 2;
  return 1;
}

export interface ReviewerStats {
  approver: string;
  decisions: number;
  approvalRate: number;
  medianSecondsToDecide: number;
  fastApprovals: number; // approvals in under 3 seconds
  canariesSeen: number;
  canariesCaught: number;
}

/**
 * Rubber-stamp telemetry. A reviewer who approves everything in under three
 * seconds — or waves through a canary — is decoration, not oversight.
 */
export function reviewerStats(
  rows: Array<{ approver: string; decision: "approve" | "deny"; secondsToDecide: number; canary?: boolean }>,
): ReviewerStats[] {
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.approver, [...(by.get(r.approver) ?? []), r]);
  return [...by.entries()].map(([approver, rs]) => {
    const real = rs.filter((r) => !r.canary);
    const canaries = rs.filter((r) => r.canary);
    const secs = real.map((r) => r.secondsToDecide).sort((a, b) => a - b);
    return {
      approver,
      decisions: real.length,
      approvalRate: real.length ? real.filter((r) => r.decision === "approve").length / real.length : 0,
      medianSecondsToDecide: secs.length ? secs[secs.length >> 1] : 0,
      fastApprovals: real.filter((r) => r.decision === "approve" && r.secondsToDecide < 3).length,
      canariesSeen: canaries.length,
      canariesCaught: canaries.filter((r) => r.decision === "deny").length,
    };
  });
}
