// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { nextLink, sha256Hex, DEFAULT_THRESHOLDS, type Thresholds, type RuleLevels } from "../../kernel/src/index.ts";

/**
 * Shared helpers for every Convex function: principal authentication, the
 * hash-chained audit append, and policy-as-data. Plain functions, not Convex
 * endpoints — nothing here is callable from outside.
 */

/** Tokens are high-entropy random strings, so a single SHA-256 is sufficient. */
export function hashToken(token: string): string {
  return sha256Hex(`agamemnon-token:${token}`);
}

export class AuthError extends Error {}

export async function agentByToken(ctx: QueryCtx, token: string | undefined | null): Promise<Doc<"agents">> {
  if (!token) throw new AuthError("missing agent token (Authorization: Bearer agm_…)");
  const row = await ctx.db
    .query("agents")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", hashToken(token)))
    .unique();
  if (!row || row.status !== "active") throw new AuthError("unknown or revoked agent token");
  return row;
}

export type OperatorRole = Doc<"operators">["role"];

export async function requireOperator(
  ctx: QueryCtx,
  token: string | undefined | null,
  roles: OperatorRole[] = ["admin", "approver", "auditor"],
): Promise<Doc<"operators">> {
  if (!token) throw new AuthError("operator sign-in required");
  const row = await ctx.db
    .query("operators")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", hashToken(token)))
    .unique();
  if (!row || row.status !== "active") throw new AuthError("unknown or revoked operator token");
  if (!roles.includes(row.role)) throw new AuthError(`operator "${row.name}" (${row.role}) may not do this`);
  return row;
}

export type AuditBody = {
  at?: number;
  kind: Doc<"auditLog">["kind"];
  runId?: Id<"runs">;
  actionId?: Id<"actions">;
  detail: string;
  data?: unknown;
  actor?: string;
};

/**
 * Append one hash-chained audit row. Convex mutations are serializable, so two
 * concurrent appends that read the same head conflict and one retries — the
 * chain cannot fork.
 */
export async function appendAudit(ctx: MutationCtx, input: AuditBody): Promise<Id<"auditLog">> {
  const head = await ctx.db.query("auditLog").withIndex("by_seq").order("desc").first();
  const body: Record<string, unknown> = {
    at: input.at ?? Date.now(),
    kind: input.kind,
    detail: input.detail,
  };
  if (input.runId) body.runId = input.runId;
  if (input.actionId) body.actionId = input.actionId;
  if (input.data !== undefined) body.data = input.data;
  if (input.actor) body.actor = input.actor;
  const link = nextLink(
    head && typeof head.seq === "number" && head.hash ? { seq: head.seq, hash: head.hash } : null,
    body,
  );
  return await ctx.db.insert("auditLog", { ...(body as any), ...link });
}

export interface ActivePolicy {
  allowlist: string[];
  perRunDestructiveRowBudget: number;
  thresholds: Thresholds;
  levels: RuleLevels;
  mode: "enforce" | "shadow";
  twoPersonRowThreshold: number;
  approvalTimeoutMs: number;
  classifierDomain: string;
}

export const DEFAULT_ALLOWLIST: string[] = [];
export const DEFAULT_APPROVAL_TIMEOUT_MS = 20 * 60 * 1000;

export async function getPolicy(ctx: QueryCtx): Promise<ActivePolicy> {
  const row = await ctx.db
    .query("policies")
    .withIndex("by_key", (q) => q.eq("key", "active"))
    .unique();
  const budget = row?.perRunDestructiveRowBudget ?? DEFAULT_THRESHOLDS.PER_RUN_DESTRUCTIVE_ROW_BUDGET;
  return {
    allowlist: row?.allowlist ?? DEFAULT_ALLOWLIST,
    perRunDestructiveRowBudget: budget,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(row?.thresholds ?? {}), PER_RUN_DESTRUCTIVE_ROW_BUDGET: budget },
    levels: (row?.levels ?? {}) as RuleLevels,
    mode: row?.mode ?? "enforce",
    twoPersonRowThreshold: row?.twoPersonRowThreshold ?? 2000,
    approvalTimeoutMs: row?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    classifierDomain: row?.classifierDomain ?? "a production database",
  };
}
