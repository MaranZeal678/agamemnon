// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Agamemnon ingress. The adapter (and thus the agent) only ever talks to these
 * endpoints — it never holds a database credential. Every endpoint requires
 *   Authorization: Bearer <agent token>
 * and the agent's identity comes from the token's registered record — never
 * from the request body.
 *
 *   POST /run/start    {}                                        → { runId }
 *   POST /run/step     { runId, tool, target?, sql?, note, … }   → { actionId }
 *   POST /propose      { runId, tool, target, predicate,         → { actionId, status }
 *                        params?, agentClaimedRows }
 *   GET  /status/:id                                             → action status
 *   POST /run/finish   { runId, status }                         → { ok }
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** First line of an error, without Convex's "Uncaught Error:" prefix or a stack. */
const clean = (e: any) => String(e?.message ?? e).split("\n")[0].replace(/^Uncaught Error: /, "");

type Agent = { name: string; owner: string; actorType: string };

async function authenticate(ctx: any, request: Request): Promise<Agent | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return json({ error: "missing agent token — send Authorization: Bearer <token>" }, 401);
  const agent = await ctx.runQuery(internal.core.agentForToken, { token });
  if (!agent) return json({ error: "unknown or revoked agent token" }, 401);
  return agent;
}

async function body(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const runStart = httpAction(async (ctx, request) => {
  const agent = await authenticate(ctx, request);
  if (agent instanceof Response) return agent;
  const runId = await ctx.runMutation(internal.core.startRun, { agent: agent.name });
  return json({ runId, agent: agent.name });
});

const propose = httpAction(async (ctx, request) => {
  const agent = await authenticate(ctx, request);
  if (agent instanceof Response) return agent;
  const { runId, tool, target, predicate, params, agentClaimedRows } = await body(request);
  if (!runId || !tool || !target || !predicate) {
    return json({ error: "runId, tool, target, predicate are required" }, 400);
  }
  try {
    // Note: any `destructive` field the agent sends is ignored — the server
    // derives it from the tool. Same for `agent`: identity is the token.
    const result = await ctx.runMutation(internal.workflow.kickoff, {
      runId: runId as Id<"runs">,
      agent: agent.name,
      tool: String(tool),
      target: String(target),
      predicate: String(predicate),
      params: params ?? {},
      agentClaimedRows: Number(agentClaimedRows ?? 0),
    });
    return json(result);
  } catch (e: any) {
    return json({ error: clean(e) }, 400);
  }
});

const runStep = httpAction(async (ctx, request) => {
  const agent = await authenticate(ctx, request);
  if (agent instanceof Response) return agent;
  const { runId, tool, target, sql, note, failed, error } = await body(request);
  if (!runId || !tool) return json({ error: "runId and tool are required" }, 400);
  try {
    const result = await ctx.runMutation(internal.core.recordStep, {
      runId: runId as Id<"runs">,
      agent: agent.name,
      tool: String(tool),
      target: String(target ?? ""),
      sql: String(sql ?? ""),
      note: String(note ?? ""),
      failed: failed === true,
      error: error ?? undefined,
    });
    return json(result);
  } catch (e: any) {
    return json({ error: clean(e) }, 400);
  }
});

const status = httpAction(async (ctx, request) => {
  const agent = await authenticate(ctx, request);
  if (agent instanceof Response) return agent;
  const url = new URL(request.url);
  const id = url.pathname.replace(/^\/status\//, "");
  if (!id) return json({ error: "action id required" }, 400);
  try {
    const owner = await ctx.runQuery(internal.core.actionOwner, { actionId: id as Id<"actions"> });
    if (!owner) return json({ error: "not found" }, 404);
    if (owner !== agent.name) return json({ error: "not found" }, 404); // no cross-agent reads
    const result = await ctx.runQuery(internal.core.getActionStatus, { actionId: id as Id<"actions"> });
    if (!result) return json({ error: "not found" }, 404);
    return json(result);
  } catch {
    return json({ error: "not found" }, 404);
  }
});

const runFinish = httpAction(async (ctx, request) => {
  const agent = await authenticate(ctx, request);
  if (agent instanceof Response) return agent;
  const { runId, status: s } = await body(request);
  try {
    await ctx.runMutation(internal.core.finishRun, {
      runId: runId as Id<"runs">,
      agent: agent.name,
      status: s === "killed" ? "killed" : "completed",
    });
    return json({ ok: true });
  } catch (e: any) {
    return json({ error: clean(e) }, 400);
  }
});

const http = httpRouter();
http.route({ path: "/run/start", method: "POST", handler: runStart });
http.route({ path: "/run/step", method: "POST", handler: runStep });
http.route({ path: "/propose", method: "POST", handler: propose });
http.route({ pathPrefix: "/status/", method: "GET", handler: status });
http.route({ path: "/run/finish", method: "POST", handler: runFinish });

export default http;
