import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Agamemnon data model.
 *
 * The load-bearing invariant lives in core.ts, not here: every `actions` row is
 * written in the SAME mutation as its first `auditLog` row, so an action that
 * exists without an audit trail is structurally impossible. The schema just
 * gives that trail a home.
 */

// A fired policy rule, recorded verbatim so the console can list rules by name.
const firedRule = v.object({
  name: v.string(),
  severity: v.union(v.literal("allow"), v.literal("approval"), v.literal("block")),
  detail: v.string(),
});

// The classifier's advice. Nullable — the write path never depends on it.
const classifierVerdict = v.object({
  class: v.string(),
  blast_radius: v.number(),
  rationale: v.string(),
  source: v.union(v.literal("model"), v.literal("heuristic")),
  latencyMs: v.optional(v.number()),
});

export default defineSchema({
  // One agent invocation. Holds the per-run destructive budget counter and the
  // killswitch. Side tasks and the delete all share a run.
  runs: defineTable({
    agent: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("blocked"),
      v.literal("completed"),
      v.literal("killed"),
    ),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    destructiveRowsUsed: v.number(),
    killswitch: v.boolean(),
    note: v.optional(v.string()),
  }).index("by_status", ["status"]),

  // Every proposed write. `estimatedRows` is Agamemnon's OWN measured count;
  // `agentClaimedRows` is what the agent thought it was doing — the gap is the
  // story. `seq` orders actions within a run for the "last 20 actions" view.
  actions: defineTable({
    runId: v.id("runs"),
    seq: v.number(),
    // "postgres.delete" is the ONLY enforced/executed tool. Non-destructive
    // steps ("postgres.query", "reason") are display-only telemetry so the
    // console can show the agent's failed status_code query and its reasoning
    // in the same feed, two rows above the delete.
    tool: v.string(),
    target: v.string(), // e.g. "loads"
    predicateSql: v.string(), // the full statement, shown on screen
    predicate: v.optional(v.string()), // raw WHERE clause, used for execution
    params: v.any(),
    destructive: v.boolean(),
    note: v.optional(v.string()), // human-readable reasoning / step narration
    agentClaimedRows: v.number(),
    estimatedRows: v.number(), // measured by Agamemnon via its own credential
    actualRows: v.optional(v.number()), // reconciled after execution
    status: v.union(
      v.literal("logged"), // display-only telemetry step (reasoning/observation)
      v.literal("proposed"),
      v.literal("classifying"),
      v.literal("blocked"),
      v.literal("awaiting_approval"),
      v.literal("approved"),
      v.literal("denied"),
      v.literal("executing"),
      v.literal("executed"),
      v.literal("failed"),
      v.literal("undone"),
    ),
    decision: v.optional(
      v.union(v.literal("allow"), v.literal("approval"), v.literal("block")),
    ),
    firedRules: v.array(firedRule),
    ratioToMedian: v.optional(v.number()),
    classifier: v.optional(classifierVerdict),
    workflowId: v.optional(v.string()),
    undoPlanId: v.optional(v.id("undoPlans")),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    executedAt: v.optional(v.number()),
    // A note carried from a reconciliation halt or execution error.
    error: v.optional(v.string()),
  })
    .index("by_run", ["runId", "seq"])
    .index("by_status", ["status"])
    .index("by_created", ["createdAt"]),

  // The reversibility record. The snapshot itself lives in Convex file storage;
  // this row points at it and is committed BEFORE any destructive execution.
  undoPlans: defineTable({
    actionId: v.id("actions"),
    target: v.string(),
    storageId: v.id("_storage"), // JSON snapshot of the exact rows to be deleted
    rowCount: v.number(),
    createdAt: v.number(),
    appliedAt: v.optional(v.number()), // set when undo replays the snapshot
    undoActionId: v.optional(v.id("actions")), // the audited undo action
  }).index("by_action", ["actionId"]),

  // Human decisions on parked actions. Each carries the operator's note.
  approvals: defineTable({
    actionId: v.id("actions"),
    decision: v.union(v.literal("approve"), v.literal("deny")),
    note: v.string(),
    decidedAt: v.number(),
  }).index("by_action", ["actionId"]),

  // Policy configuration as DATA (allowlist + budget). Thresholds themselves are
  // constants in policy.ts; this singleton makes the allowlist visible/seedable.
  policies: defineTable({
    key: v.string(), // "active"
    allowlist: v.array(v.string()),
    perRunDestructiveRowBudget: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Append-only audit trail. Written in the same transaction as the events it
  // records. Never updated, never deleted.
  auditLog: defineTable({
    at: v.number(),
    kind: v.union(
      v.literal("propose"),
      v.literal("classify"),
      v.literal("decision"),
      v.literal("approval"),
      v.literal("denial"),
      v.literal("credential-mint"),
      v.literal("credential-revoke"),
      v.literal("snapshot"),
      v.literal("execute"),
      v.literal("reconcile"),
      v.literal("undo"),
      v.literal("killswitch"),
      v.literal("run-start"),
      v.literal("run-end"),
    ),
    runId: v.optional(v.id("runs")),
    actionId: v.optional(v.id("actions")),
    detail: v.string(),
    data: v.optional(v.any()),
  })
    .index("by_action", ["actionId"])
    .index("by_run", ["runId"])
    .index("by_time", ["at"]),

  // Per-agent rolling statistics the policy engine reads (the 30-day median).
  agentStats: defineTable({
    agent: v.string(),
    median30d: v.number(),
    updatedAt: v.number(),
  }).index("by_agent", ["agent"]),

  // Eval scoreboard: one row per (model, dataset) with the headline metrics the
  // console's eval page renders. Written by the Phase 5 harness.
  classifiers: defineTable({
    label: v.string(), // "Agamemnon-tuned 8B", "stock 8B", "DeepSeek-V3 judge"
    model: v.string(),
    datasetSize: v.number(),
    precision: v.number(),
    recall: v.number(),
    f1: v.number(),
    costPerCallUsd: v.number(),
    p50LatencyMs: v.number(),
    createdAt: v.number(),
  }).index("by_label", ["label"]),
});
