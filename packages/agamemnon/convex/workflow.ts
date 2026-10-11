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
import { guardPredicate, SqlGuardError, isSafeIdentifier } from "../../kernel/src/index.ts";
import { appendAudit, getPolicy } from "./access";

/**
 * The durable proposal workflow: measure → classify → decide → (park) →
 * snapshot → execute. Durable means it survives restarts and keeps its place.
 * One action parking for human approval does NOT halt the run.
 *
 * The human wait is a deliberately unclever sleep-and-recheck loop whose
 * ceiling comes from policy. A timeout always DENIES — it never approves.
 */
export const workflow = new WorkflowManager(components.workflow);

const POLL_MS = 1500;

export const proposalWorkflow = workflow.define({
  args: {
    actionId: v.id("actions"),
    runId: v.id("runs"),
    agent: v.string(),
    target: v.string(),
    predicate: v.string(),
    referencedTables: v.optional(v.array(v.string())),
  },
  handler: async (step, args): Promise<void> => {
    // 1. Measure the TRUE blast radius with Agamemnon's own credential, in a
    //    READ ONLY transaction, as one extended-protocol statement.
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
    //    The classifier sees the predicate's SHAPE only — literals redacted.
    const agentMedian = await step.runQuery(internal.core.agentMedianQuery, { agent: args.agent });
    const classifier = await step.runAction(internal.classifier.classify, {
      actionId: args.actionId,
      target: args.target,
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

    if (decided.shadow) return; // shadow mode: recorded, never executed
    if (decided.decision === "block") return; // terminal: blocked
    if (decided.decision === "allow") {
      await step.runAction(internal.execute.snapshotAndDelete, { actionId: args.actionId });
      return;
    }

    // 4. Approval needed — park until enough distinct humans decide, the run
    //    is killed, or the policy timeout elapses (→ deny).
    const policy = await step.runQuery(internal.core.policyQuery, {});
    const maxPolls = Math.max(1, Math.ceil(policy.approvalTimeoutMs / POLL_MS));
    for (let i = 0; i < maxPolls; i++) {
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

/** Tools this ingress executes. Anything else is refused, not guessed at. */
const SUPPORTED_TOOLS = new Set(["postgres.delete"]);

/**
 * Ingest a proposal: validate, write the action row and its audit row in ONE
 * mutation, then start the durable workflow. Whether an action is destructive
 * is decided HERE from the tool — the agent's own `destructive` flag is ignored.
 */
export const kickoff = internalMutation({
  args: {
    runId: v.id("runs"),
    agent: v.string(),
    tool: v.string(),
    target: v.string(),
    predicate: v.string(),
    params: v.any(),
    agentClaimedRows: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) throw new Error("unknown run");
    if (run.agent !== args.agent) throw new Error("this run belongs to another agent");
    if (run.killswitch) throw new Error("run has been killed");
    if (!SUPPORTED_TOOLS.has(args.tool)) throw new Error(`unsupported tool "${args.tool}"`);

    const policy = await getPolicy(ctx);
    const seq = (await ctx.db.query("actions").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect()).length;
    const destructive = true; // postgres.delete is always destructive — server-derived

    // Validate the target and predicate BEFORE any database access.
    let rejection: { rule: string; detail: string } | null = null;
    let shape: string | undefined;
    let referencedTables: string[] = [];
    if (!isSafeIdentifier(args.target)) {
      rejection = { rule: "target-not-identifier", detail: `"${args.target}" is not a plain table identifier` };
    } else {
      try {
        const analysis = guardPredicate(args.predicate, { allowedTables: [args.target, ...policy.allowlist] });
        shape = analysis.shape;
        referencedTables = analysis.referencedTables.filter((t) => t !== args.target);
      } catch (e) {
        if (e instanceof SqlGuardError) rejection = { rule: `predicate-rejected:${e.code}`, detail: e.message };
        else throw e;
      }
    }

    const predicateSql = `DELETE FROM ${args.target} WHERE ${args.predicate}`;
    const actionId = await ctx.db.insert("actions", {
      runId: args.runId,
      seq,
      tool: args.tool,
      target: args.target,
      predicateSql,
      predicate: args.predicate,
      predicateShape: shape,
      referencedTables,
      params: args.params,
      destructive,
      agentClaimedRows: args.agentClaimedRows,
      estimatedRows: 0,
      status: "classifying",
      firedRules: [],
      createdAt: Date.now(),
      actorType: "agent",
    });
    await appendAudit(ctx, {
      kind: "propose",
      runId: args.runId,
      actionId,
      actor: args.agent,
      detail: `proposed ${args.tool} on ${args.target} (agent claimed ${args.agentClaimedRows.toLocaleString()} rows)`,
      data: { predicateSql },
    });

    if (rejection) {
      await ctx.db.patch(actionId, {
        status: "blocked",
        decision: "block",
        firedRules: [{ name: rejection.rule, severity: "block", detail: rejection.detail }],
        decidedAt: Date.now(),
      });
      await appendAudit(ctx, {
        kind: "decision",
        runId: args.runId,
        actionId,
        actor: "agamemnon",
        detail: `decision: BLOCK before any database access — ${rejection.rule}: ${rejection.detail}`,
      });
      return { actionId, status: "blocked" as const };
    }

    const workflowId = await workflow.start(ctx, internal.workflow.proposalWorkflow, {
      actionId,
      runId: args.runId,
      agent: args.agent,
      target: args.target,
      predicate: args.predicate,
      referencedTables,
    });
    await ctx.db.patch(actionId, { workflowId });
    return { actionId, status: "classifying" as const };
  },
});
