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

// ── Decide (called by the workflow after measuring + classifying) ────────────
// Runs the pure policy engine and patches the action with the verdict. The
// classifier's advice is layered on top and may only ESCALATE severity.
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

    // Classifier provenance as its own audit event.
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "classify",
      runId: action.runId,
      actionId: args.actionId,
      detail: `classifier (${args.classifier.source}) → ${args.classifier.class}, blast radius ${args.classifier.blast_radius.toFixed(2)}`,
      data: args.classifier,
    });

    const policy = await getPolicy(ctx);
    const median = await getAgentMedian(ctx, run.agent);
    const pAction: PolicyAction = {
      tool: action.tool,
      target: action.target,
      destructive: action.destructive,
      estimatedRows: args.estimatedRows,
    };
    const pctx: PolicyContext = {
      allowlist: policy.allowlist,
      agentMedian: median,
      perRunDestructiveRowsUsed: run.destructiveRowsUsed,
    };
    const verdict: ClassifierVerdict = args.classifier;
    const result = decide(pAction, pctx, verdict);

    const status =
      result.decision === "block"
        ? "blocked"
        : result.decision === "approval"
          ? "awaiting_approval"
          : "approved";

    await ctx.db.patch(args.actionId, {
      estimatedRows: args.estimatedRows,
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
      runId: action.runId,
      actionId: args.actionId,
      detail: `decision: ${result.decision.toUpperCase()} — measured ${args.estimatedRows.toLocaleString()} rows — fired [${result.firedRules.map((r) => r.name).join(", ") || "none"}]`,
      data: { firedRules: result.firedRules, ratioToMedian: result.ratioToMedian },
    });

    return { decision: result.decision };
  },
});

// ── Human-in-the-loop: approval outcome, approve/deny, killswitch ────────────
// The workflow polls this. Returns "approve" | "deny" | "killed" | null.
export const approvalOutcome = internalQuery({
  args: { actionId: v.id("actions"), runId: v.id("runs") },
  handler: async (ctx, { actionId, runId }) => {
    const run = await ctx.db.get(runId);
    if (run?.killswitch) return "killed" as const;
    const approval = await ctx.db
      .query("approvals")
      .withIndex("by_action", (q) => q.eq("actionId", actionId))
      .order("desc")
      .first();
    if (!approval) return null;
    return approval.decision === "approve" ? ("approve" as const) : ("deny" as const);
  },
});

export const markDenied = internalMutation({
  args: {
    actionId: v.id("actions"),
    killed: v.boolean(),
    timedOut: v.optional(v.boolean()),
  },
  handler: async (ctx, { actionId, killed, timedOut }) => {
    const action = await ctx.db.get(actionId);
    if (!action) return;
    await ctx.db.patch(actionId, { status: "denied", decidedAt: Date.now() });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "denial",
      runId: action.runId,
      actionId,
      detail: killed
        ? "action denied by run killswitch"
        : timedOut
          ? "action denied — approval timed out"
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
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "reconcile",
      runId: action.runId,
      actionId,
      detail: `action failed: ${error}`,
    });
  },
});

// Public: operator approves a parked action (with a note).
export const approve = mutation({
  args: { actionId: v.id("actions"), note: v.string() },
  handler: async (ctx, { actionId, note }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error("unknown action");
    if (action.status !== "awaiting_approval") throw new Error(`action is ${action.status}, not awaiting approval`);
    await ctx.db.insert("approvals", { actionId, decision: "approve", note, decidedAt: Date.now() });
    await ctx.db.patch(actionId, { status: "approved" });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "approval",
      runId: action.runId,
      actionId,
      detail: `operator APPROVED${note ? ` — "${note}"` : ""}`,
    });
    return { ok: true };
  },
});

// Public: operator denies a parked action (with a note).
export const deny = mutation({
  args: { actionId: v.id("actions"), note: v.string() },
  handler: async (ctx, { actionId, note }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error("unknown action");
    if (action.status !== "awaiting_approval") throw new Error(`action is ${action.status}, not awaiting approval`);
    await ctx.db.insert("approvals", { actionId, decision: "deny", note, decidedAt: Date.now() });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "approval",
      runId: action.runId,
      actionId,
      detail: `operator DENIED${note ? ` — "${note}"` : ""}`,
    });
    return { ok: true };
  },
});

// Public: kill an entire run. Any parked action resolves to denied.
export const killRun = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("unknown run");
    await ctx.db.patch(runId, { killswitch: true, status: "killed", finishedAt: Date.now() });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "killswitch",
      runId,
      detail: `run killswitch engaged by operator`,
    });
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

// ── Execution support (Phase 4), called by execute.ts (use node) ─────────────
export const commitUndoPlan = internalMutation({
  args: {
    actionId: v.id("actions"),
    target: v.string(),
    storageId: v.id("_storage"),
    rowCount: v.number(),
  },
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
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "snapshot",
      runId: action.runId,
      actionId: args.actionId,
      detail: `snapshot committed: ${args.rowCount.toLocaleString()} rows serialized to file storage before delete`,
      data: { storageId: args.storageId },
    });
    return { undoPlanId };
  },
});

export const markExecuting = internalMutation({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error("unknown action");
    await ctx.db.patch(actionId, { status: "executing" });
    // Credential mint is an audited event: Agamemnon scopes a per-action grant.
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "credential-mint",
      runId: action.runId,
      actionId,
      detail: `minted per-action Postgres grant for ${action.target} (scope: this action only)`,
    });
  },
});

export const markExecuted = internalMutation({
  args: { actionId: v.id("actions"), actualRows: v.number() },
  handler: async (ctx, { actionId, actualRows }) => {
    const action = await ctx.db.get(actionId);
    if (!action) throw new Error("unknown action");
    const run = await ctx.db.get(action.runId);

    // Reconcile actual against the estimate; the number is recorded either way.
    const est = action.estimatedRows;
    const diverged = est > 0 && Math.abs(actualRows - est) / est > 0.05;

    await ctx.db.patch(actionId, {
      status: "executed",
      actualRows,
      executedAt: Date.now(),
    });
    if (run) {
      await ctx.db.patch(action.runId, { destructiveRowsUsed: run.destructiveRowsUsed + actualRows });
    }
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "execute",
      runId: action.runId,
      actionId,
      detail: `executed: ${actualRows.toLocaleString()} rows deleted from ${action.target}`,
    });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "reconcile",
      runId: action.runId,
      actionId,
      detail: diverged
        ? `RECONCILE WARNING: actual ${actualRows.toLocaleString()} diverged from estimate ${est.toLocaleString()} (>5%)`
        : `reconciled: actual ${actualRows.toLocaleString()} matches estimate ${est.toLocaleString()} within tolerance`,
    });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "credential-revoke",
      runId: action.runId,
      actionId,
      detail: `revoked per-action Postgres grant for ${action.target}`,
    });
    return { diverged };
  },
});

// Undo replays the snapshot as an insert and is recorded as a NEW audited
// action with its own approval record.
export const recordUndoAction = internalMutation({
  args: { originalActionId: v.id("actions"), restoredRows: v.number() },
  handler: async (ctx, { originalActionId, restoredRows }) => {
    const original = await ctx.db.get(originalActionId);
    if (!original) throw new Error("unknown action");
    const seq = (
      await ctx.db.query("actions").withIndex("by_run", (q) => q.eq("runId", original.runId)).collect()
    ).length;

    const undoActionId = await ctx.db.insert("actions", {
      runId: original.runId,
      seq,
      tool: "postgres.undo",
      target: original.target,
      predicateSql: `INSERT INTO ${original.target} (…) OVERRIDING SYSTEM VALUE  -- restore ${restoredRows.toLocaleString()} rows from snapshot`,
      params: { undoOf: original.seq },
      destructive: false,
      note: `undo of action #${original.seq} (${restoredRows.toLocaleString()} rows restored)`,
      agentClaimedRows: restoredRows,
      estimatedRows: restoredRows,
      actualRows: restoredRows,
      status: "executed",
      decision: "allow",
      firedRules: [],
      createdAt: Date.now(),
      executedAt: Date.now(),
    });
    // The undo carries its own approval record (operator-initiated).
    await ctx.db.insert("approvals", {
      actionId: undoActionId,
      decision: "approve",
      note: "undo requested by operator",
      decidedAt: Date.now(),
    });
    await ctx.db.patch(originalActionId, { status: "undone" });

    const plan = await ctx.db
      .query("undoPlans")
      .withIndex("by_action", (q) => q.eq("actionId", originalActionId))
      .first();
    if (plan) await ctx.db.patch(plan._id, { appliedAt: Date.now(), undoActionId });

    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "undo",
      runId: original.runId,
      actionId: undoActionId,
      detail: `undo executed: ${restoredRows.toLocaleString()} rows restored to ${original.target}; action #${original.seq} marked undone`,
    });
    return { undoActionId };
  },
});

// Internal read used by execute.ts to fetch a target/predicate/snapshot plan.
export const actionForExecution = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const a = await ctx.db.get(actionId);
    if (!a) return null;
    return {
      target: a.target,
      predicate: a.predicate ?? a.predicateSql.replace(/^DELETE FROM \S+ WHERE /i, ""),
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
    const plan = await ctx.db
      .query("undoPlans")
      .withIndex("by_action", (q) => q.eq("actionId", actionId))
      .first();
    if (!plan) return null;
    return { target: plan.target, storageId: plan.storageId, rowCount: plan.rowCount, applied: !!plan.appliedAt };
  },
});

// ── Console reactive queries ─────────────────────────────────────────────────
// The live action feed (newest first) with the run's agent name attached.
export const consoleFeed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
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

// One action expanded: the action, its run's last-20 actions, and approvals.
export const actionContext = query({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const action = await ctx.db.get(actionId);
    if (!action) return null;
    const run = await ctx.db.get(action.runId);
    const recent = await ctx.db
      .query("actions")
      .withIndex("by_run", (q) => q.eq("runId", action.runId))
      .order("desc")
      .take(20);
    const approvals = await ctx.db
      .query("approvals")
      .withIndex("by_action", (q) => q.eq("actionId", actionId))
      .collect();
    const median = await getAgentMedian(ctx, run?.agent ?? "");
    return { action, run, recent, approvals, agentMedian: median };
  },
});

export const latestRun = query({
  args: {},
  handler: async (ctx) => {
    const running = await ctx.db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .order("desc")
      .first();
    if (running) return running;
    return await ctx.db.query("runs").order("desc").first();
  },
});

export const auditTail = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db.query("auditLog").withIndex("by_time").order("desc").take(limit ?? 60);
  },
});

export const evalScores = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("classifiers").order("desc").collect();
  },
});

export const policyConfig = query({
  args: {},
  handler: async (ctx) => {
    const p = await getPolicy(ctx);
    return { allowlist: p.allowlist, perRunDestructiveRowBudget: p.perRunDestructiveRowBudget };
  },
});
