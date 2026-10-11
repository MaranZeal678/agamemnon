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

// Who asked for an action. Gen-2 treats humans, scripts, agents and MCP
// clients identically: one policy, one audit trail.
const actorType = v.union(v.literal("agent"), v.literal("human"), v.literal("script"), v.literal("mcp"));

export default defineSchema({
  // Registered agents. The agent authenticates with a bearer token whose
  // SHA-256 is stored here; the agent's name comes from THIS row, never from
  // the request body. `owner` is the human who launched / owns the agent —
  // they may not approve its requests (three-party separation).
  agents: defineTable({
    name: v.string(),
    owner: v.string(),
    actorType: actorType,
    tokenHash: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_name", ["name"]),

  // Console operators. Same token scheme; role gates what they may do.
  operators: defineTable({
    name: v.string(),
    role: v.union(v.literal("admin"), v.literal("approver"), v.literal("auditor")),
    tokenHash: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    createdAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_name", ["name"]),

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
      v.literal("shadowed"), // shadow mode: decided and recorded, never executed
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
    // ── Gen-2 hardening ──
    actorType: v.optional(actorType),
    // The predicate with every literal replaced by $n — what the classifier sees.
    predicateShape: v.optional(v.string()),
    // Tables the predicate's subqueries read (granted SELECT to the per-request role).
    referencedTables: v.optional(v.array(v.string())),
    // Distinct human approvals this action needs (1, or 2 above the threshold).
    requiredApprovals: v.optional(v.number()),
    // Shadow mode: the decision Agamemnon WOULD have enforced.
    wouldDecision: v.optional(v.union(v.literal("allow"), v.literal("approval"), v.literal("block"))),
    // The real per-request Postgres role used for execution (created and dropped in one transaction).
    executionRole: v.optional(v.string()),
    // WAL position recorded just before execution, for point-in-time recovery.
    walLsn: v.optional(v.string()),
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
    // The authenticated operator who decided (optional only for pre-Gen-2 rows).
    decidedBy: v.optional(v.string()),
    decidedByRole: v.optional(v.string()),
  }).index("by_action", ["actionId"]),

  // Policy configuration as DATA. Every threshold the engine uses is read from
  // here (the kernel supplies defaults for anything unset).
  policies: defineTable({
    key: v.string(), // "active"
    allowlist: v.array(v.string()),
    perRunDestructiveRowBudget: v.number(),
    updatedAt: v.number(),
    thresholds: v.optional(v.any()), // Partial<Thresholds> from @agamemnon/kernel
    levels: v.optional(v.any()), // per-rule monitor | approve | block
    mode: v.optional(v.union(v.literal("enforce"), v.literal("shadow"))),
    twoPersonRowThreshold: v.optional(v.number()),
    approvalTimeoutMs: v.optional(v.number()),
    classifierDomain: v.optional(v.string()),
  }).index("by_key", ["key"]),

  // Append-only, hash-chained audit trail. Written in the same transaction as
  // the events it records. Never updated, never deleted — not even by the demo
  // reset, which appends a "demo-reset" event instead.
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
      v.literal("shadow"),
      v.literal("auth"),
      v.literal("demo-reset"),
      v.literal("policy-change"),
      v.literal("provision"),
    ),
    runId: v.optional(v.id("runs")),
    actionId: v.optional(v.id("actions")),
    detail: v.string(),
    data: v.optional(v.any()),
    // Who caused this event (agent name, operator name, or "agamemnon").
    actor: v.optional(v.string()),
    // Hash chain (optional only so pre-Gen-2 rows still load; every new row has them).
    seq: v.optional(v.number()),
    prevHash: v.optional(v.string()),
    hash: v.optional(v.string()),
  })
    .index("by_action", ["actionId"])
    .index("by_run", ["runId"])
    .index("by_time", ["at"])
    .index("by_seq", ["seq"]),

  // Per-agent rolling statistics the policy engine reads (the 30-day median).
  agentStats: defineTable({
    agent: v.string(),
    median30d: v.number(),
    updatedAt: v.number(),
    // Real executed row counts (last 30 days, capped). Once there are enough
    // samples the median is recomputed from them instead of the seeded value.
    samples: v.optional(v.array(v.object({ rows: v.number(), at: v.number() }))),
    seededMedian: v.optional(v.number()),
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
