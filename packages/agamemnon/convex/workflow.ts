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

import { WorkflowManager } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * The durable proposal workflow: classify → decide → (park) → snapshot →
 * execute. Durable means it survives restarts and keeps its place. Crucially,
 * one action parking for human approval does NOT halt the run — unrelated
 * branches (the agent's harmless side tasks) keep flowing through their own
 * workflows concurrently.
 *
 * The human wait is a deliberately unclever sleep-and-recheck loop.
 */
export const workflow = new WorkflowManager(components.workflow);

const POLL_MS = 1500;
const MAX_POLLS = 800; // ~20 minutes ceiling

export const proposalWorkflow = workflow.define({
  args: {
    actionId: v.id("actions"),
    runId: v.id("runs"),
    agent: v.string(),
    target: v.string(),
    predicate: v.string(),
  },
  handler: async (step, args): Promise<void> => {
    // 1. Measure the TRUE blast radius with Agamemnon's own credential.
    let measured: { matchingRows: number; totalRows: number };
    try {
      measured = await step.runAction(internal.execute.countMatching, {
        target: args.target,
        predicate: args.predicate,
      });
    } catch (e: any) {
      await step.runMutation(internal.core.markFailed, {
        actionId: args.actionId,
        error: `measurement failed: ${e?.message ?? e}`,
      });
      return;
    }

    // 2. Classify (heuristic fallback inside; never throws, never stalls).
    const agentMedian = await step.runQuery(internal.core.agentMedianQuery, { agent: args.agent });
    const classifier = await step.runAction(internal.classifier.classify, {
      target: args.target,
      predicateSql: `DELETE FROM ${args.target} WHERE ${args.predicate}`,
      matchingRows: measured.matchingRows,
      totalRows: measured.totalRows,
      destructive: true,
      agentMedian,
    });

    // 3. Decide. Pure policy engine; the classifier may only escalate.
    const decided = await step.runMutation(internal.core.applyDecision, {
      actionId: args.actionId,
      estimatedRows: measured.matchingRows,
      classifier,
    });

    if (decided.decision === "block") return; // terminal: blocked
    if (decided.decision === "allow") {
      await step.runAction(internal.execute.snapshotAndDelete, { actionId: args.actionId });
      return;
    }

    // 4. Approval needed — park. Sleep-and-recheck for a human decision or the
    //    run killswitch. Other actions in this run keep executing meanwhile.
    for (let i = 0; i < MAX_POLLS; i++) {
      const outcome = await step.runQuery(internal.core.approvalOutcome, {
        actionId: args.actionId,
        runId: args.runId,
      });
      if (outcome === "approve") {
        await step.runAction(internal.execute.snapshotAndDelete, { actionId: args.actionId });
        return;
      }
      if (outcome === "deny") {
        await step.runMutation(internal.core.markDenied, { actionId: args.actionId, killed: false });
        return;
      }
      if (outcome === "killed") {
        await step.runMutation(internal.core.markDenied, { actionId: args.actionId, killed: true });
        return;
      }
      await step.sleep(POLL_MS);
    }
    await step.runMutation(internal.core.markDenied, { actionId: args.actionId, killed: false, timedOut: true });
  },
});

/**
 * Ingest a proposal: write the action row and its audit row in ONE mutation,
 * then start the durable workflow. The atomicity guarantee (no action without
 * an audit entry) holds here.
 */
export const kickoff = internalMutation({
  args: {
    runId: v.id("runs"),
    agent: v.string(),
    tool: v.string(),
    target: v.string(),
    predicate: v.string(),
    params: v.any(),
    destructive: v.boolean(),
    agentClaimedRows: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("unknown run");
    if (run.killswitch) throw new Error("run has been killed");

    const seq = (
      await ctx.db.query("actions").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect()
    ).length;
    const predicateSql = `DELETE FROM ${args.target} WHERE ${args.predicate}`;

    // ATOMIC: action row + first audit row in the same transaction.
    const actionId = await ctx.db.insert("actions", {
      runId: args.runId,
      seq,
      tool: args.tool,
      target: args.target,
      predicateSql,
      predicate: args.predicate,
      params: args.params,
      destructive: args.destructive,
      agentClaimedRows: args.agentClaimedRows,
      estimatedRows: 0, // measured by the workflow, patched by applyDecision
      status: "classifying",
      firedRules: [],
      createdAt: Date.now(),
    });
    await ctx.db.insert("auditLog", {
      at: Date.now(),
      kind: "propose",
      runId: args.runId,
      actionId,
      detail: `proposed ${args.tool} on ${args.target} (agent claimed ${args.agentClaimedRows.toLocaleString()} rows)`,
      data: { predicateSql },
    });

    const workflowId = await workflow.start(ctx, internal.workflow.proposalWorkflow, {
      actionId,
      runId: args.runId,
      agent: args.agent,
      target: args.target,
      predicate: args.predicate,
    });
    await ctx.db.patch(actionId, { workflowId });

    return { actionId, status: "classifying" as const };
  },
});
