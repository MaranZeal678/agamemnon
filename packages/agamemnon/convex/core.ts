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

import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { decide, median, type PolicyAction, type PolicyContext, type ClassifierVerdict } from "./policy";
import {
  approvalState,
  checkApprover,
  requiredApprovals as requiredApprovalsFor,
  verifyChain,
  type ApprovalRecord,
} from "../../kernel/src/index.ts";
import { appendAudit, getPolicy, requireOperator, agentByToken, hashToken } from "./access";

/**
 * Core proposal / decision logic.
 *
 * The atomic invariant lives in `kickoff` / `recordStep`: the `actions` row and
 * its first audit row are inserted in the SAME mutation (one transaction), so
 * an action that exists without an audit entry is structurally impossible.
 *
 * Gen-2 hardening: every public mutation authenticates a principal; every audit
 * row is hash-chained; approvals enforce requester ≠ approver ≠ launcher.
 */

const DEFAULT_MEDIAN = 1210;
const MEDIAN_MIN_SAMPLES = 5;
const MEDIAN_WINDOW_MS = 30 * 24 * 3600 * 1000;

async function getAgentMedian(ctx: any, agent: string): Promise<number> {
  const row = await ctx.db
    .query("agentStats")
    .withIndex("by_agent", (q: any) => q.eq("agent", agent))
    .unique();
  return row?.median30d ?? DEFAULT_MEDIAN;
}

async function agentOwner(ctx: any, agent: string): Promise<string | undefined> {
  const row = await ctx.db
    .query("agents")
    .withIndex("by_name", (q: any) => q.eq("name", agent))
    .first();
  return row?.owner;
}

// ── Seed policy + agent stats (idempotent). Called via `convex run`. ─────────
export const seed = internalMutation({
  args: {
    agent: v.string(),
    median30d: v.number(),
    allowlist: v.array(v.string()),
    perRunDestructiveRowBudget: v.number(),
    thresholds: v.optional(v.any()),
    levels: v.optional(v.any()),
    mode: v.optional(v.union(v.literal("enforce"), v.literal("shadow"))),
    twoPersonRowThreshold: v.optional(v.number()),
    approvalTimeoutMs: v.optional(v.number()),
    classifierDomain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const fields = {
      allowlist: args.allowlist,
      perRunDestructiveRowBudget: args.perRunDestructiveRowBudget,
      thresholds: args.thresholds,
      levels: args.levels,
      mode: args.mode,
      twoPersonRowThreshold: args.twoPersonRowThreshold,
      approvalTimeoutMs: args.approvalTimeoutMs,
      classifierDomain: args.classifierDomain,
      updatedAt: Date.now(),
    };
    const existingPolicy = await ctx.db
      .query("policies")
      .withIndex("by_key", (q) => q.eq("key", "active"))
      .unique();
    if (existingPolicy) await ctx.db.patch(existingPolicy._id, fields);
    else await ctx.db.insert("policies", { key: "active", ...fields });

    const existingStats = await ctx.db
      .query("agentStats")
      .withIndex("by_agent", (q) => q.eq("agent", args.agent))
      .unique();
    if (existingStats) {
      await ctx.db.patch(existingStats._id, { median30d: args.median30d, seededMedian: args.median30d, samples: [], updatedAt: Date.now() });
    } else {
      await ctx.db.insert("agentStats", {
        agent: args.agent,
        median30d: args.median30d,
        seededMedian: args.median30d,
        samples: [],
        updatedAt: Date.now(),
      });
    }
    await appendAudit(ctx, {
      kind: "policy-change",
      actor: "provision",
      detail: `policy seeded: allowlist [${args.allowlist.join(", ")}], budget ${args.perRunDestructiveRowBudget.toLocaleString()}, mode ${args.mode ?? "enforce"}; ${args.agent} median ${args.median30d.toLocaleString()}`,
      data: { thresholds: args.thresholds ?? null, levels: args.levels ?? null },
    });
    return { ok: true };
  },
});

// ── Provision principals (agents + operators) from token HASHES. ─────────────
// Tokens themselves never reach Convex; scripts/provision-principals.sh hashes
// them locally and passes only the hashes.
export const provisionPrincipals = internalMutation({
  args: {
    agents: v.array(v.object({ name: v.string(), owner: v.string(), tokenHash: v.string() })),
    operators: v.array(
      v.object({
        name: v.string(),
        role: v.union(v.literal("admin"), v.literal("approver"), v.literal("auditor")),
        tokenHash: v.string(),
      }),
    ),
  },
  handler: async (ctx, { agents, operators }) => {
    for (const a of agents) {
      const existing = await ctx.db.query("agents").withIndex("by_name", (q) => q.eq("name", a.name)).first();
      if (existing) await ctx.db.patch(existing._id, { owner: a.owner, tokenHash: a.tokenHash, status: "active" });
      else
        await ctx.db.insert("agents", { ...a, actorType: "agent", status: "active", createdAt: Date.now() });
    }
    for (const o of operators) {
      const existing = await ctx.db.query("operators").withIndex("by_name", (q) => q.eq("name", o.name)).first();
      if (existing) await ctx.db.patch(existing._id, { role: o.role, tokenHash: o.tokenHash, status: "active" });
      else await ctx.db.insert("operators", { ...o, status: "active", createdAt: Date.now() });
    }
    await appendAudit(ctx, {
      kind: "provision",
      actor: "provision",
      detail: `principals provisioned: agents [${agents.map((a) => `${a.name} (owner ${a.owner})`).join(", ")}]; operators [${operators.map((o) => `${o.name}:${o.role}`).join(", ")}]`,
    });
    return { agents: agents.length, operators: operators.length };
  },
});

// ── Reset operational state. The audit log is NEVER deleted. ─────────────────
export const resetDemoState = internalMutation({
  args: {},
  handler: async (ctx) => {
    let cleared = 0;
    for (const table of ["actions", "runs", "undoPlans", "approvals"] as const) {
      for (const row of await ctx.db.query(table).collect()) {
        await ctx.db.delete(row._id);
        cleared++;
      }
    }
    await appendAudit(ctx, {
      kind: "demo-reset",
      actor: "operator-cli",
      detail: `demo reset: ${cleared} operational rows cleared (runs/actions/approvals/undo plans). The audit chain is preserved.`,
    });
    return { ok: true };
  },
});

// ── Runs ────────────────────────────────────────────────────────────────────
export const startRun = internalMutation({
  args: { agent: v.string() },
  handler: async (ctx, { agent }) => {
    const runId = await ctx.db.insert("runs", {
      agent,
      status: "running",
      startedAt: Date.now(),
      destructiveRowsUsed: 0,
      killswitch: false,
    });
    await appendAudit(ctx, { kind: "run-start", runId, actor: agent, detail: `run started for agent "${agent}"` });
    return runId;
  },
});

export const finishRun = internalMutation({
  args: { runId: v.id("runs"), agent: v.string(), status: v.union(v.literal("completed"), v.literal("killed")) },
  handler: async (ctx, { runId, agent, status }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("unknown run");
    if (run.agent !== agent) throw new Error("this run belongs to another agent");
    await ctx.db.patch(runId, { status, finishedAt: Date.now() });
    await appendAudit(ctx, { kind: "run-end", runId, actor: agent, detail: `run ${status}` });
  },
});

export const agentMedianQuery = internalQuery({
  args: { agent: v.string() },
  handler: async (ctx, { agent }) => getAgentMedian(ctx, agent),
});

export const policyQuery = internalQuery({
  args: {},
  handler: async (ctx) => getPolicy(ctx),
});

/** Resolve an agent bearer token to its registered identity (used by HTTP ingress). */
export const agentForToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    try {
      const a = await agentByToken(ctx, token);
      return { name: a.name, owner: a.owner, actorType: a.actorType };
    } catch {
      return null;
    }
  },
});

/** Resolve an operator token (used by actions, which cannot read the DB directly). */
export const operatorForToken = internalQuery({
  args: { token: v.string(), roles: v.array(v.string()) },
  handler: async (ctx, { token, roles }) => {
    try {
      const o = await requireOperator(ctx, token, roles as any);
      return { name: o.name, role: o.role };
    } catch (e: any) {
      return { error: e?.message ?? "unauthorised" };
    }
  },
});

export const runOwner = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => (await ctx.db.get(runId))?.agent ?? null,
});

export const actionOwner = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const a = await ctx.db.get(actionId);
    if (!a) return null;
    return (await ctx.db.get(a.runId))?.agent ?? null;
  },
});

// ── Display-only telemetry step (reasoning / failed query). NOT executed. ────
export const recordStep = internalMutation({
  args: {
    runId: v.id("runs"),
    agent: v.string(),
    tool: v.string(), // "reason" | "postgres.query" | "task"
    target: v.string(),
    sql: v.string(),
    note: v.string(),
    failed: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("unknown run");
    if (run.agent !== args.agent) throw new Error("this run belongs to another agent");
    const seq = (await ctx.db.query("actions").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect()).length;

    const actionId = await ctx.db.insert("actions", {
      runId: args.runId,
      seq,
      tool: args.tool,
      target: args.target,
      predicateSql: args.sql,
      params: {},
      destructive: false,
      note: args.note,
      agentClaimedRows: 0,
      estimatedRows: 0,
      status: args.failed ? "failed" : "logged",
      decision: "allow",
      firedRules: [],
      createdAt: Date.now(),
      error: args.error,
      actorType: "agent",
    });
    await appendAudit(ctx, {
      kind: "propose",
      runId: args.runId,
      actionId,
      actor: args.agent,
      detail: args.failed ? `agent step FAILED: ${args.note} (${args.error ?? "error"})` : `agent step: ${args.note}`,
      data: { sql: args.sql, tool: args.tool },
    });
    return { actionId, seq };
  },
});

// ── Decide (called by the workflow after measuring + classifying) ────────────
export const applyDecision = internalMutation({
  args: {
    actionId: v.id("actions"),
    estimatedRows: v.number(),
    classifier: v.object({
      class: v.string(),
      blast_radius: v.number(),
      rationale: v.string(),
      source: v.union(v.literal("model"), v.literal("heuristic")),
      latencyMs: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) throw new Error("unknown action");
    const run = await ctx.db.get(action.runId);
    if (!run) throw new Error("unknown run");

    await appendAudit(ctx, {
      kind: "classify",
      runId: action.runId,
      actionId: args.actionId,
      actor: "agamemnon",
      detail: `classifier (${args.classifier.source}) → ${args.classifier.class}, blast radius ${args.classifier.blast_radius.toFixed(2)}`,
      data: args.classifier,
    });

    const policy = await getPolicy(ctx);
    const agentMedian = await getAgentMedian(ctx, run.agent);
    const pAction: PolicyAction = {
      tool: action.tool,
      target: action.target,
      destructive: action.destructive, // set by the server from the tool, never by the agent
      estimatedRows: args.estimatedRows,
    };
    const pctx: PolicyContext = {
      allowlist: policy.allowlist,
      agentMedian,
      perRunDestructiveRowsUsed: run.destructiveRowsUsed,
    };
    const verdict: ClassifierVerdict = args.classifier;
    const result = decide(pAction, pctx, verdict, { thresholds: policy.thresholds, levels: policy.levels });
    const required = requiredApprovalsFor({ rows: args.estimatedRows, twoPersonRowThreshold: policy.twoPersonRowThreshold });

    // Shadow mode: decide and record exactly what WOULD happen — never execute.
    if (policy.mode === "shadow") {
      await ctx.db.patch(args.actionId, {
        estimatedRows: args.estimatedRows,
        status: "shadowed",
        decision: "allow",
        wouldDecision: result.decision,
        firedRules: result.firedRules,
        ratioToMedian: result.ratioToMedian,
        classifier: args.classifier,
        requiredApprovals: required,
        decidedAt: Date.now(),
      });
      await appendAudit(ctx, {
        kind: "shadow",
        runId: action.runId,
        actionId: args.actionId,
        actor: "agamemnon",
        detail: `SHADOW: would ${result.decision.toUpperCase()} — measured ${args.estimatedRows.toLocaleString()} rows — nothing executed`,
        data: { firedRules: result.firedRules, ratioToMedian: result.ratioToMedian },
      });
      return { decision: result.decision, shadow: true };
    }

    const status =
      result.decision === "block" ? "blocked" : result.decision === "approval" ? "awaiting_approval" : "approved";
    await ctx.db.patch(args.actionId, {
      estimatedRows: args.estimatedRows,
      status,
      decision: result.decision,
      firedRules: result.firedRules,
      ratioToMedian: result.ratioToMedian,
      classifier: args.classifier,
      requiredApprovals: required,
      decidedAt: Date.now(),
    });
    await appendAudit(ctx, {
      kind: "decision",
      runId: action.runId,
      actionId: args.actionId,
      actor: "agamemnon",
      detail: `decision: ${result.decision.toUpperCase()} — measured ${args.estimatedRows.toLocaleString()} rows — fired [${result.firedRules.map((r) => r.name).join(", ") || "none"}]${result.decision === "approval" ? ` — needs ${required} approver${required > 1 ? "s" : ""}` : ""}`,
      data: { firedRules: result.firedRules, ratioToMedian: result.ratioToMedian, requiredApprovals: required },
    });
    return { decision: result.decision, shadow: false };
  },
});

/** Build the kernel's view of an action's approvals. */
async function approvalSubjectAndRecords(ctx: any, action: Doc<"actions">) {
  const run = await ctx.db.get(action.runId);
  const owner = run ? await agentOwner(ctx, run.agent) : undefined;
  const rows: Doc<"approvals">[] = await ctx.db
    .query("approvals")
    .withIndex("by_action", (q: any) => q.eq("actionId", action._id))
    .collect();
  const records: ApprovalRecord[] = rows
    .filter((r) => r.decidedBy) // pre-Gen-2 anonymous rows never count
    .map((r) => ({ approver: { kind: "human", id: r.decidedBy! }, decision: r.decision, at: r.decidedAt }));
  const subject = {
    requester: { kind: "agent" as const, id: run?.agent ?? "unknown" },
    launcher: owner,
    required: action.requiredApprovals ?? 1,
  };
  return { subject, records };
}

// ── Human-in-the-loop: approval outcome, approve/deny, killswitch ────────────
export const approvalOutcome = internalQuery({
  args: { actionId: v.id("actions"), runId: v.id("runs") },
  handler: async (ctx, { actionId, runId }) => {
    const run = await ctx.db.get(runId);
    if (run?.killswitch) return "killed" as const;
    const action = await ctx.db.get(actionId);
    if (!action) return "deny" as const;
    const { subject, records } = await approvalSubjectAndRecords(ctx, action);
    const st = approvalState(subject, records);
    if (st.state === "approved") return "approve" as const;
    if (st.state === "denied") return "deny" as const;
    return null;
  },
});

export const markDenied = internalMutation({
  args: { actionId: v.id("actions"), killed: v.boolean(), timedOut: v.optional(v.boolean()) },
  handler: async (ctx, { actionId, killed, timedOut }) => {
    const action = await ctx.db.get(actionId);
    if (!action) return;
    await ctx.db.patch(actionId, { status: "denied", decidedAt: Date.now() });
    await appendAudit(ctx, {
      kind: "denial",
      runId: action.runId,
      actionId,
      actor: "agamemnon",
      detail: killed
        ? "action denied by run killswitch"
        : timedOut
          ? "action denied — approval timed out (timeouts always deny, never approve)"
          : "action denied by operator",
    });
  },
});

export const markFailed = internalMutation({
  args: { actionId: v.id("actions"), error: v.string() },
  handler: async (ctx, { actionId, error }) => {
    const action = await ctx.db.get(actionId);
    if (!action) return;
    await ctx.db.patch(actionId, { status: "failed", error, decidedAt: Date.now() });
    // An undo plan committed for a delete that never committed is void.
    const plan = await ctx.db.query("undoPlans").withIndex("by_action", (q) => q.eq("actionId", actionId)).first();
    if (plan && !plan.appliedAt) await ctx.db.delete(plan._id);
    await appendAudit(ctx, { kind: "reconcile", runId: action.runId, actionId, actor: "agamemnon", detail: `action failed: ${error}` });
  },
});

/** Mark an action blocked before measurement (e.g. its predicate was rejected). */
export const markRejected = internalMutation({
  args: { actionId: v.id("actions"), rule: v.string(), detail: v.string() },
  handler: async (ctx, { actionId, rule, detail }) => {
    const action = await ctx.db.get(actionId);
    if (!action) return;
    await ctx.db.patch(actionId, {
      status: "blocked",
      decision: "block",
      firedRules: [{ name: rule, severity: "block", detail }],
      decidedAt: Date.now(),
    });
    await appendAudit(ctx, {
      kind: "decision",
      runId: action.runId,
      actionId,
      actor: "agamemnon",
      detail: `decision: BLOCK before any database access — ${rule}: ${detail}`,
    });
  },
});

async function recordApprovalDecision(
  ctx: any,
  actionId: Id<"actions">,
  operatorToken: string,
  decision: "approve" | "deny",
  note: string,
) {
  const op = await requireOperator(ctx, operatorToken, ["admin", "approver"]);
  const action: Doc<"actions"> | null = await ctx.db.get(actionId);
  if (!action) throw new Error("unknown action");
  if (action.status !== "awaiting_approval") throw new Error(`action is ${action.status}, not awaiting approval`);
  const { subject, records } = await approvalSubjectAndRecords(ctx, action);
  const check = checkApprover({ kind: "human", id: op.name }, subject);
  if (!check.ok) {
    await appendAudit(ctx, {
      kind: "auth",
      runId: action.runId,
      actionId,
      actor: op.name,
      detail: `approval REFUSED for ${op.name}: ${check.reason}`,
    });
    throw new Error(check.reason);
  }
  if (records.some((r) => r.approver.id === op.name)) throw new Error(`${op.name} has already decided on this action`);

  await ctx.db.insert("approvals", {
    actionId,
    decision,
    note,
    decidedAt: Date.now(),
    decidedBy: op.name,
    decidedByRole: op.role,
  });
  const after = approvalState(subject, [...records, { approver: { kind: "human", id: op.name }, decision, at: Date.now() }]);
  if (after.state === "approved") await ctx.db.patch(actionId, { status: "approved" });
  await appendAudit(ctx, {
    kind: "approval",
    runId: action.runId,
    actionId,
    actor: op.name,
    detail:
      decision === "approve"
        ? `${op.name} APPROVED${note ? ` — "${note}"` : ""}${after.state === "pending" ? ` (${after.approvals}/${after.required} approvals)` : ""}`
        : `${op.name} DENIED${note ? ` — "${note}"` : ""}`,
  });
  return { ok: true, state: after.state };
}

export const approve = mutation({
  args: { actionId: v.id("actions"), note: v.string(), operatorToken: v.string() },
  handler: async (ctx, { actionId, note, operatorToken }) =>
    recordApprovalDecision(ctx, actionId, operatorToken, "approve", note),
});

export const deny = mutation({
  args: { actionId: v.id("actions"), note: v.string(), operatorToken: v.string() },
  handler: async (ctx, { actionId, note, operatorToken }) =>
    recordApprovalDecision(ctx, actionId, operatorToken, "deny", note),
});

export const killRun = mutation({
  args: { runId: v.id("runs"), operatorToken: v.string() },
  handler: async (ctx, { runId, operatorToken }) => {
    const op = await requireOperator(ctx, operatorToken, ["admin", "approver"]);
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("unknown run");
    await ctx.db.patch(runId, { killswitch: true, status: "killed", finishedAt: Date.now() });
    await appendAudit(ctx, { kind: "killswitch", runId, actor: op.name, detail: `run killswitch engaged by ${op.name}` });
    return { ok: true };
  },
});

// ── Status + read queries ────────────────────────────────────────────────────
export const getActionStatus = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const a = await ctx.db.get(actionId);
    if (!a) return null;
    return {
      status: a.status,
      decision: a.decision ?? null,
      wouldDecision: a.wouldDecision ?? null,
      estimatedRows: a.estimatedRows,
      agentClaimedRows: a.agentClaimedRows,
      ratioToMedian: a.ratioToMedian ?? null,
      firedRules: a.firedRules,
      classifier: a.classifier ?? null,
      actualRows: a.actualRows ?? null,
      requiredApprovals: a.requiredApprovals ?? null,
      error: a.error ?? null,
    };
  },
});

// ── Execution support, called by execute.ts (use node) ───────────────────────
export const commitUndoPlan = internalMutation({
  args: { actionId: v.id("actions"), target: v.string(), storageId: v.id("_storage"), rowCount: v.number() },
  handler: async (ctx, args) => {
    const action = await ctx.db.get(args.actionId);
    if (!action) throw new Error("unknown action");
    const undoPlanId = await ctx.db.insert("undoPlans", {
      actionId: args.actionId,
      target: args.target,
      storageId: args.storageId,
      rowCount: args.rowCount,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.actionId, { undoPlanId });
    await appendAudit(ctx, {
      kind: "snapshot",
      runId: action.runId,
      actionId: args.actionId,
      actor: "agamemnon",
      detail: `snapshot committed: ${args.rowCount.toLocaleString()} rows captured by DELETE … RETURNING and stored before commit`,
      data: { storageId: args.storageId },
    });
    return { undoPlanId };
  },
});

export const markExecuting = internalMutation({
  args: { actionId: v.id("actions"), role: v.string(), walLsn: v.optional(v.string()), grants: v.array(v.string()) },
  handler: async (ctx, { actionId, role, walLsn, grants }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error("unknown action");
    await ctx.db.patch(actionId, { status: "executing", executionRole: role, walLsn });
    await appendAudit(ctx, {
      kind: "credential-mint",
      runId: action.runId,
      actionId,
      actor: "agamemnon",
      detail: `minted per-request Postgres role ${role}: ${grants.join("; ")} — exists only inside this transaction`,
      data: { role, walLsn: walLsn ?? null, grants },
    });
  },
});

export const markExecuted = internalMutation({
  args: { actionId: v.id("actions"), actualRows: v.number() },
  handler: async (ctx, { actionId, actualRows }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error("unknown action");
    const run = await ctx.db.get(action.runId);

    const est = action.estimatedRows;
    const diverged = est > 0 && Math.abs(actualRows - est) / est > 0.05;
    await ctx.db.patch(actionId, { status: "executed", actualRows, executedAt: Date.now() });
    if (run) {
      await ctx.db.patch(action.runId, { destructiveRowsUsed: run.destructiveRowsUsed + actualRows });
      // Refresh the agent's rolling median from REAL executed history.
      const stats = await ctx.db.query("agentStats").withIndex("by_agent", (q) => q.eq("agent", run.agent)).unique();
      const now = Date.now();
      const samples = [...(stats?.samples ?? []), { rows: actualRows, at: now }]
        .filter((s) => now - s.at < MEDIAN_WINDOW_MS)
        .slice(-200);
      const seeded = stats?.seededMedian ?? stats?.median30d ?? DEFAULT_MEDIAN;
      const med = samples.length >= MEDIAN_MIN_SAMPLES ? median(samples.map((s) => s.rows)) : seeded;
      if (stats) await ctx.db.patch(stats._id, { samples, median30d: med, updatedAt: now });
      else await ctx.db.insert("agentStats", { agent: run.agent, median30d: med, seededMedian: seeded, samples, updatedAt: now });
    }
    await appendAudit(ctx, {
      kind: "execute",
      runId: action.runId,
      actionId,
      actor: "agamemnon",
      detail: `executed: ${actualRows.toLocaleString()} rows deleted from ${action.target}`,
    });
    await appendAudit(ctx, {
      kind: "reconcile",
      runId: action.runId,
      actionId,
      actor: "agamemnon",
      detail: diverged
        ? `RECONCILE WARNING: actual ${actualRows.toLocaleString()} diverged from estimate ${est.toLocaleString()} (>5%)`
        : `reconciled: actual ${actualRows.toLocaleString()} matches the approved estimate ${est.toLocaleString()} within tolerance`,
    });
    await appendAudit(ctx, {
      kind: "credential-revoke",
      runId: action.runId,
      actionId,
      actor: "agamemnon",
      detail: `per-request role ${action.executionRole ?? "(unknown)"} revoked and dropped before commit`,
    });
    return { diverged };
  },
});

export const recordUndoAction = internalMutation({
  args: { originalActionId: v.id("actions"), restoredRows: v.number(), skippedRows: v.number(), operator: v.string() },
  handler: async (ctx, { originalActionId, restoredRows, skippedRows, operator }) => {
    const original = await ctx.db.get(originalActionId);
    if (!original) throw new Error("unknown action");
    const seq = (await ctx.db.query("actions").withIndex("by_run", (q) => q.eq("runId", original.runId)).collect()).length;

    const undoActionId = await ctx.db.insert("actions", {
      runId: original.runId,
      seq,
      tool: "postgres.undo",
      target: original.target,
      predicateSql: `INSERT INTO ${original.target} (…) OVERRIDING SYSTEM VALUE  -- restore ${restoredRows.toLocaleString()} rows from snapshot`,
      params: { undoOf: original.seq },
      destructive: false,
      note: `undo of action #${original.seq} (${restoredRows.toLocaleString()} rows restored${skippedRows ? `, ${skippedRows} skipped on conflict` : ""}) by ${operator}`,
      agentClaimedRows: restoredRows,
      estimatedRows: restoredRows,
      actualRows: restoredRows,
      status: "executed",
      decision: "allow",
      firedRules: [],
      createdAt: Date.now(),
      executedAt: Date.now(),
      actorType: "human",
    });
    await ctx.db.insert("approvals", {
      actionId: undoActionId,
      decision: "approve",
      note: "undo requested by operator",
      decidedAt: Date.now(),
      decidedBy: operator,
    });
    await ctx.db.patch(originalActionId, { status: "undone" });
    const plan = await ctx.db.query("undoPlans").withIndex("by_action", (q) => q.eq("actionId", originalActionId)).first();
    if (plan) await ctx.db.patch(plan._id, { appliedAt: Date.now(), undoActionId });

    await appendAudit(ctx, {
      kind: "undo",
      runId: original.runId,
      actionId: undoActionId,
      actor: operator,
      detail: `undo executed by ${operator}: ${restoredRows.toLocaleString()} rows restored to ${original.target}${skippedRows ? ` (${skippedRows} conflicting rows skipped and reported)` : ""}; action #${original.seq} marked undone`,
    });
    return { undoActionId };
  },
});

export const actionForExecution = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const a = await ctx.db.get(actionId);
    if (!a) return null;
    return {
      target: a.target,
      predicate: a.predicate ?? a.predicateSql.replace(/^DELETE FROM \S+ WHERE /i, ""),
      referencedTables: a.referencedTables ?? [],
      estimatedRows: a.estimatedRows,
      status: a.status,
    };
  },
});

export const undoPlanForAction = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const a = await ctx.db.get(actionId);
    if (!a) return null;
    const plan = await ctx.db.query("undoPlans").withIndex("by_action", (q) => q.eq("actionId", actionId)).first();
    if (!plan) return null;
    return { target: plan.target, storageId: plan.storageId, rowCount: plan.rowCount, applied: !!plan.appliedAt };
  },
});

// ── Console reactive queries (operator sign-in required) ─────────────────────
export const whoami = query({
  args: { operatorToken: v.string() },
  handler: async (ctx, { operatorToken }) => {
    try {
      const o = await requireOperator(ctx, operatorToken);
      return { name: o.name, role: o.role };
    } catch {
      return null;
    }
  },
});

export const consoleFeed = query({
  args: { operatorToken: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { operatorToken, limit }) => {
    await requireOperator(ctx, operatorToken);
    const rows = await ctx.db.query("actions").withIndex("by_created").order("desc").take(limit ?? 40);
    const runIds = [...new Set(rows.map((r) => r.runId))];
    const runs = new Map(
      (await Promise.all(runIds.map((id) => ctx.db.get(id)))).filter(Boolean).map((r) => [r!._id, r!]),
    );
    return rows.map((a) => ({
      ...a,
      agent: runs.get(a.runId)?.agent ?? "unknown",
      runKilled: runs.get(a.runId)?.killswitch ?? false,
    }));
  },
});

export const actionContext = query({
  args: { operatorToken: v.string(), actionId: v.id("actions") },
  handler: async (ctx, { operatorToken, actionId }) => {
    await requireOperator(ctx, operatorToken);
    const action = await ctx.db.get(actionId);
    if (!action) return null;
    const run = await ctx.db.get(action.runId);
    const recent = await ctx.db.query("actions").withIndex("by_run", (q) => q.eq("runId", action.runId)).order("desc").take(20);
    const approvals = await ctx.db.query("approvals").withIndex("by_action", (q) => q.eq("actionId", actionId)).collect();
    const median30 = await getAgentMedian(ctx, run?.agent ?? "");
    const owner = run ? await agentOwner(ctx, run.agent) : undefined;
    return { action, run, recent, approvals, agentMedian: median30, agentOwner: owner ?? null };
  },
});

export const latestRun = query({
  args: { operatorToken: v.string() },
  handler: async (ctx, { operatorToken }) => {
    await requireOperator(ctx, operatorToken);
    const running = await ctx.db.query("runs").withIndex("by_status", (q) => q.eq("status", "running")).order("desc").first();
    if (running) return running;
    return await ctx.db.query("runs").order("desc").first();
  },
});

export const auditTail = query({
  args: { operatorToken: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { operatorToken, limit }) => {
    await requireOperator(ctx, operatorToken);
    return await ctx.db.query("auditLog").withIndex("by_time").order("desc").take(limit ?? 60);
  },
});

/** Page through the audit chain in seq order (for export). */
export const auditExport = query({
  args: { operatorToken: v.string(), afterSeq: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { operatorToken, afterSeq, limit }) => {
    await requireOperator(ctx, operatorToken, ["admin", "auditor"]);
    const n = Math.min(limit ?? 500, 1000);
    const rows = await ctx.db
      .query("auditLog")
      .withIndex("by_seq", (q) => q.gt("seq", afterSeq ?? -1))
      .order("asc")
      .take(n);
    return { rows, nextAfterSeq: rows.length === n ? rows[rows.length - 1].seq : null };
  },
});

/** Verify the most recent window of the chain (full export verification runs client-side). */
export const auditVerify = query({
  args: { operatorToken: v.string(), window: v.optional(v.number()) },
  handler: async (ctx, { operatorToken, window }) => {
    await requireOperator(ctx, operatorToken);
    const n = Math.min(window ?? 2000, 4000);
    const desc = await ctx.db.query("auditLog").withIndex("by_seq", (q) => q.gte("seq", 0)).order("desc").take(n);
    const rows = desc.reverse() as any[];
    const v = verifyChain(rows);
    return { ...v, window: rows.length, firstSeq: rows[0]?.seq ?? null, lastSeq: rows[rows.length - 1]?.seq ?? null };
  },
});

export const evalScores = query({
  args: { operatorToken: v.string() },
  handler: async (ctx, { operatorToken }) => {
    await requireOperator(ctx, operatorToken);
    return await ctx.db.query("classifiers").order("desc").collect();
  },
});

// Replace the eval scoreboard (admin only — previously writable by anyone).
export const saveEvalResults = mutation({
  args: {
    operatorToken: v.string(),
    results: v.array(
      v.object({
        label: v.string(),
        model: v.string(),
        datasetSize: v.number(),
        precision: v.number(),
        recall: v.number(),
        f1: v.number(),
        costPerCallUsd: v.number(),
        p50LatencyMs: v.number(),
      }),
    ),
  },
  handler: async (ctx, { operatorToken, results }) => {
    const op = await requireOperator(ctx, operatorToken, ["admin"]);
    for (const r of await ctx.db.query("classifiers").collect()) await ctx.db.delete(r._id);
    for (const r of results) await ctx.db.insert("classifiers", { ...r, createdAt: Date.now() });
    await appendAudit(ctx, { kind: "policy-change", actor: op.name, detail: `eval scoreboard replaced (${results.length} classifiers)` });
    return { saved: results.length };
  },
});

export const policyConfig = query({
  args: { operatorToken: v.string() },
  handler: async (ctx, { operatorToken }) => {
    await requireOperator(ctx, operatorToken);
    const p = await getPolicy(ctx);
    return {
      allowlist: p.allowlist,
      perRunDestructiveRowBudget: p.perRunDestructiveRowBudget,
      thresholds: p.thresholds,
      levels: p.levels,
      mode: p.mode,
      twoPersonRowThreshold: p.twoPersonRowThreshold,
      approvalTimeoutMs: p.approvalTimeoutMs,
    };
  },
});

// Exposed for tests / scripts that need to confirm a token hash without the token.
export const tokenHashOf = internalQuery({
  args: { token: v.string() },
  handler: async (_ctx, { token }) => hashToken(token),
});

/** The redacted predicate shape for the classifier — never the raw literals. */
export const actionShape = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const a = await ctx.db.get(actionId);
    return a ? { predicateShape: a.predicateShape ?? null } : null;
  },
});
