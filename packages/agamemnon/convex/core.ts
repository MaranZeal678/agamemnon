import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { decide, type PolicyAction, type PolicyContext, type ClassifierVerdict } from "./policy";

/**
 * Core proposal / decision logic.
 *
 * The atomic invariant lives in `recordProposal`: the `actions` row and its
 * first `auditLog` row are inserted in the SAME mutation (one transaction), so
 * an action that exists without an audit entry is structurally impossible —
 * not merely unlikely. That is the line to point at on stage.
 */

const DEFAULT_ALLOWLIST = ["loads", "bookings"];
const DEFAULT_BUDGET = 5000;
const DEFAULT_MEDIAN = 1210;

async function getPolicy(ctx: any) {
  const row = await ctx.db
    .query("policies")
    .withIndex("by_key", (q: any) => q.eq("key", "active"))
    .unique();
  return {
    allowlist: row?.allowlist ?? DEFAULT_ALLOWLIST,
    perRunDestructiveRowBudget: row?.perRunDestructiveRowBudget ?? DEFAULT_BUDGET,
  };
}

async function getAgentMedian(ctx: any, agent: string): Promise<number> {
  const row = await ctx.db
    .query("agentStats")
    .withIndex("by_agent", (q: any) => q.eq("agent", agent))
    .unique();
  return row?.median30d ?? DEFAULT_MEDIAN;
}

// ── Seed policy + agent stats (idempotent). Called via `convex run`. ─────────
export const seed = internalMutation({
  args: {
    agent: v.string(),
    median30d: v.number(),
    allowlist: v.array(v.string()),
    perRunDestructiveRowBudget: v.number(),
  },
  handler: async (ctx, args) => {
    const existingPolicy = await ctx.db
      .query("policies")
      .withIndex("by_key", (q) => q.eq("key", "active"))
      .unique();
    if (existingPolicy) {
      await ctx.db.patch(existingPolicy._id, {
        allowlist: args.allowlist,
        perRunDestructiveRowBudget: args.perRunDestructiveRowBudget,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("policies", {
        key: "active",
        allowlist: args.allowlist,
        perRunDestructiveRowBudget: args.perRunDestructiveRowBudget,
        updatedAt: Date.now(),
      });
    }

    const existingStats = await ctx.db
      .query("agentStats")
      .withIndex("by_agent", (q) => q.eq("agent", args.agent))
      .unique();
    if (existingStats) {
      await ctx.db.patch(existingStats._id, { median30d: args.median30d, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("agentStats", {
        agent: args.agent,
        median30d: args.median30d,
        updatedAt: Date.now(),
      });
    }
    return { ok: true };
  },
});

// ── Reset operational state (keeps policy/agentStats/classifiers seed). ──────
export const resetDemoState = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const table of ["actions", "auditLog", "runs", "undoPlans", "approvals"] as const) {
      for (const row of await ctx.db.query(table).collect()) {
        await ctx.db.delete(row._id);
      }
    }
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
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "run-start",
      runId,
      detail: `run started for agent "${agent}"`,
    });
    return runId;
  },
});

export const finishRun = internalMutation({
  args: { runId: v.id("runs"), status: v.union(v.literal("completed"), v.literal("killed")) },
  handler: async (ctx, { runId, status }) => {
    await ctx.db.patch(runId, { status, finishedAt: Date.now() });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "run-end",
      runId,
      detail: `run ${status}`,
    });
  },
});

export const agentMedianQuery = internalQuery({
  args: { agent: v.string() },
  handler: async (ctx, { agent }) => getAgentMedian(ctx, agent),
});

// ── Display-only telemetry step (reasoning / failed query). NOT executed. ────
// Recorded so the console can show the agent's failed status_code query and its
// reasoning in the run feed. Still atomic: action row + audit row together.
export const recordStep = internalMutation({
  args: {
    runId: v.id("runs"),
    tool: v.string(), // "reason" | "postgres.query"
    target: v.string(),
    sql: v.string(),
    note: v.string(),
    failed: v.boolean(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("unknown run");
    const seq = (
      await ctx.db.query("actions").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect()
    ).length;

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
    });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "propose",
      runId: args.runId,
      actionId,
      detail: args.failed
        ? `agent step FAILED: ${args.note} (${args.error ?? "error"})`
        : `agent step: ${args.note}`,
      data: { sql: args.sql, tool: args.tool },
    });
    return { actionId, seq };
  },
});

// ── The atomic proposal + decision ──────────────────────────────────────────
export const recordProposal = internalMutation({
  args: {
    runId: v.id("runs"),
    tool: v.string(),
    target: v.string(),
    predicate: v.string(),
    params: v.any(),
    destructive: v.boolean(),
    agentClaimedRows: v.number(),
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
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("unknown run");

    const seq = (await ctx.db.query("actions").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect()).length;
    const predicateSql = `DELETE FROM ${args.target} WHERE ${args.predicate}`;

    // ┌─────────────────────────────────────────────────────────────────────┐
    // │ ATOMIC: the action row and its first audit row are inserted in the   │
    // │ SAME mutation transaction. If this throws, neither exists. An action │
    // │ without an audit entry is therefore structurally impossible.         │
    // └─────────────────────────────────────────────────────────────────────┘
    const actionId = await ctx.db.insert("actions", {
      runId: args.runId,
      seq,
      tool: args.tool,
      target: args.target,
      predicateSql,
      params: args.params,
      destructive: args.destructive,
      agentClaimedRows: args.agentClaimedRows,
      estimatedRows: args.estimatedRows,
      status: "proposed",
      firedRules: [],
      createdAt: Date.now(),
    });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "propose",
      runId: args.runId,
      actionId,
      detail: `proposed ${args.tool} on ${args.target}: ~${args.estimatedRows.toLocaleString()} rows (agent claimed ${args.agentClaimedRows.toLocaleString()})`,
      data: { predicateSql },
    });

    // Record the classifier's advice as its own audit event (provenance visible).
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "classify",
      runId: args.runId,
      actionId,
      detail: `classifier (${args.classifier.source}) → ${args.classifier.class}, blast radius ${args.classifier.blast_radius.toFixed(2)}`,
      data: args.classifier,
    });

    // ── Decide. Pure policy engine; classifier may only escalate. ───────────
    const policy = await getPolicy(ctx);
    const median = await getAgentMedian(ctx, run.agent);
    const action: PolicyAction = {
      tool: args.tool,
      target: args.target,
      destructive: args.destructive,
      estimatedRows: args.estimatedRows,
    };
    const pctx: PolicyContext = {
      allowlist: policy.allowlist,
      agentMedian: median,
      perRunDestructiveRowsUsed: run.destructiveRowsUsed,
    };
    const verdict: ClassifierVerdict = args.classifier;
    const result = decide(action, pctx, verdict);

    const status =
      result.decision === "block"
        ? "blocked"
        : result.decision === "approval"
          ? "awaiting_approval"
          : "approved";

    await ctx.db.patch(actionId, {
      status,
      decision: result.decision,
      firedRules: result.firedRules,
      ratioToMedian: result.ratioToMedian,
      classifier: args.classifier,
      decidedAt: Date.now(),
    });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "decision",
      runId: args.runId,
      actionId,
      detail: `decision: ${result.decision.toUpperCase()} — fired [${result.firedRules.map((r) => r.name).join(", ") || "none"}]`,
      data: { firedRules: result.firedRules, ratioToMedian: result.ratioToMedian },
    });

    return {
      actionId,
      status,
      decision: result.decision,
      estimatedRows: args.estimatedRows,
      agentClaimedRows: args.agentClaimedRows,
      ratioToMedian: result.ratioToMedian,
      firedRules: result.firedRules,
      classifier: args.classifier,
    };
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
      estimatedRows: a.estimatedRows,
      agentClaimedRows: a.agentClaimedRows,
      ratioToMedian: a.ratioToMedian ?? null,
      firedRules: a.firedRules,
      classifier: a.classifier ?? null,
      actualRows: a.actualRows ?? null,
      error: a.error ?? null,
    };
  },
});

// Console feed (Phase 3 uses these reactively; defined now).
export const feed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db.query("actions").withIndex("by_created").order("desc").take(limit ?? 50);
  },
});

export const runActions = query({
  args: { runId: v.id("runs"), limit: v.optional(v.number()) },
  handler: async (ctx, { runId, limit }) => {
    const rows = await ctx.db
      .query("actions")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .order("desc")
      .take(limit ?? 20);
    return rows;
  },
});
