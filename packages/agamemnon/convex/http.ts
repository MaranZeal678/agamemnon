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

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Agamemnon ingress. The adapter (and thus the agent) only ever talks to these
 * endpoints — it never holds a database credential.
 *
 *   POST /run/start    { agent }                       → { runId }
 *   POST /propose      { runId, agent, tool, target,   → decision result
 *                        predicate, params,
 *                        agentClaimedRows, destructive }
 *   GET  /status/:id                                    → action status
 *   POST /run/finish   { runId, status }                → { ok }
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const runStart = httpAction(async (ctx, request) => {
  const { agent } = await request.json();
  if (typeof agent !== "string") return json({ error: "agent is required" }, 400);
  const runId = await ctx.runMutation(internal.core.startRun, { agent });
  return json({ runId });
});

const propose = httpAction(async (ctx, request) => {
  const body = await request.json();
  const { runId, agent, tool, target, predicate, params, agentClaimedRows, destructive } = body;
  if (!runId || !agent || !tool || !target || !predicate) {
    return json({ error: "runId, agent, tool, target, predicate are required" }, 400);
  }
  // Start the durable workflow; the agent polls /status until a terminal decision.
  const result = await ctx.runMutation(internal.workflow.kickoff, {
    runId: runId as Id<"runs">,
    agent,
    tool,
    target,
    predicate,
    params: params ?? {},
    agentClaimedRows: Number(agentClaimedRows ?? 0),
    destructive: destructive !== false, // postgres.delete is destructive by default
  });
  return json(result);
});

const runStep = httpAction(async (ctx, request) => {
  const { runId, tool, target, sql, note, failed, error } = await request.json();
  if (!runId || !tool) return json({ error: "runId and tool are required" }, 400);
  const result = await ctx.runMutation(internal.core.recordStep, {
    runId: runId as Id<"runs">,
    tool,
    target: target ?? "loads",
    sql: sql ?? "",
    note: note ?? "",
    failed: failed === true,
    error: error ?? undefined,
  });
  return json(result);
});

const status = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const id = url.pathname.replace(/^\/status\//, "");
  if (!id) return json({ error: "action id required" }, 400);
  const result = await ctx.runQuery(internal.core.getActionStatus, { actionId: id as Id<"actions"> });
  if (!result) return json({ error: "not found" }, 404);
  return json(result);
});

const runFinish = httpAction(async (ctx, request) => {
  const { runId, status } = await request.json();
  await ctx.runMutation(internal.core.finishRun, {
    runId: runId as Id<"runs">,
    status: status === "killed" ? "killed" : "completed",
  });
  return json({ ok: true });
});

const http = httpRouter();
http.route({ path: "/run/start", method: "POST", handler: runStart });
http.route({ path: "/run/step", method: "POST", handler: runStep });
http.route({ path: "/propose", method: "POST", handler: propose });
http.route({ pathPrefix: "/status/", method: "GET", handler: status });
http.route({ path: "/run/finish", method: "POST", handler: runFinish });

export default http;
