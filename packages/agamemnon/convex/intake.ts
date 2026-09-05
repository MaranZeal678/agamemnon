import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Proposal intake orchestration (V8 action).
 *
 * 1. Measure the TRUE blast radius with Agamemnon's own credential.
 * 2. Consult the classifier (returns the deterministic heuristic when the model
 *    is disabled or unreachable — the write path never stalls on it).
 * 3. Record the proposal + decision atomically.
 *
 * The measured row count — not the agent's claim — is what policy judges.
 */
export const propose = internalAction({
  args: {
    runId: v.id("runs"),
    agent: v.string(),
    tool: v.string(),
    target: v.string(),
    predicate: v.string(),
    params: v.any(),
    agentClaimedRows: v.number(),
    destructive: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { matchingRows, totalRows } = await ctx.runAction(internal.execute.countMatching, {
      target: args.target,
      predicate: args.predicate,
    });

    const agentMedian = await ctx.runQuery(internal.core.agentMedianQuery, { agent: args.agent });

    const classifier = await ctx.runAction(internal.classifier.classify, {
      target: args.target,
      predicateSql: `DELETE FROM ${args.target} WHERE ${args.predicate}`,
      matchingRows,
      totalRows,
      destructive: args.destructive,
      agentMedian,
    });

    return await ctx.runMutation(internal.core.recordProposal, {
      runId: args.runId,
      tool: args.tool,
      target: args.target,
      predicate: args.predicate,
      params: args.params,
      destructive: args.destructive,
      agentClaimedRows: args.agentClaimedRows,
      estimatedRows: matchingRows,
      classifier,
    });
  },
});
