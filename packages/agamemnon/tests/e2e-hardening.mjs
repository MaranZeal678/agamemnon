// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * End-to-end check of the Phase-A hardening against a LIVE local stack
 * (local Convex on :3210/:3211 + local Postgres). Run: `make verify-e2e`.
 *
 * Proves, with real requests:
 *  1. no token → 401; a forged agent name in the body is ignored
 *  2. an injection predicate is blocked before any database access
 *  3. a spoofed `destructive:false` does not switch off the row rules
 *  4. the 900-row delete parks; the agent's launcher is refused; an
 *     independent operator approves; it executes under a per-request role
 *     that no longer exists afterwards; undo restores every row
 *  5. the audit hash chain verifies end to end
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
for (const line of readFileSync(resolve(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const env = process.env;
const SITE = env.AGAMEMNON_PROPOSE_URL || "http://127.0.0.1:3211";
const CLOUD = env.CONVEX_URL || "http://127.0.0.1:3210";
const api = anyApi;
const convex = new ConvexHttpClient(CLOUD);

let failures = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

async function call(path, body, token = env.AGAMEMNON_AGENT_TOKEN, method = "POST") {
  const res = await fetch(new URL(path, SITE), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function waitTerminal(actionId, want = ["blocked", "denied", "executed", "failed", "undone", "shadowed", "awaiting_approval"]) {
  for (let i = 0; i < 120; i++) {
    const r = await call(`/status/${actionId}`, null, env.AGAMEMNON_AGENT_TOKEN, "GET");
    if (r.data && want.includes(r.data.status)) return r.data;
    await new Promise((s) => setTimeout(s, 500));
  }
  throw new Error(`action ${actionId} never reached ${want.join("/")}`);
}

const db = new pg.Client({ connectionString: env.MERIDIAN_DATABASE_URL });
await db.connect();
const loads = async () => Number((await db.query("SELECT count(*)::int AS n FROM loads")).rows[0].n);
const reqRoles = async () => Number((await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'agm_req_%'")).rows[0].n);

console.log("Agamemnon Phase-A hardening — live end-to-end\n");
const before = await loads();

// 1. auth
const noTok = await call("/run/start", { agent: "dispatch-copilot" }, "");
check(noTok.status === 401, "no agent token → 401");
const badTok = await call("/run/start", {}, "agm_agent_forged");
check(badTok.status === 401, "forged agent token → 401");
const run = await call("/run/start", { agent: "someone-else" });
check(run.status === 200 && run.data.agent === "dispatch-copilot", "agent identity comes from the token, not the body", `agent=${run.data?.agent}`);
const runId = run.data.runId;

// 2. injection blocked pre-DB
const inj = await call("/propose", { runId, tool: "postgres.delete", target: "loads", predicate: "1=1; DROP TABLE bookings", agentClaimedRows: 1 });
const injS = await waitTerminal(inj.data.actionId);
check(injS.status === "blocked" && injS.firedRules[0]?.name.startsWith("predicate-rejected"), "injection predicate blocked before any DB access", injS.firedRules[0]?.name);
const bookingsExist = (await db.query("SELECT to_regclass('public.bookings') AS t")).rows[0].t;
check(!!bookingsExist, "bookings table still exists");

const foreign = await call("/propose", { runId, tool: "postgres.delete", target: "loads", predicate: "id IN (SELECT 1 FROM agent_runs)", agentClaimedRows: 1 });
const foreignS = await waitTerminal(foreign.data.actionId);
check(foreignS.status === "blocked", "subquery over a non-allowlisted table blocked", foreignS.firedRules[0]?.name);

const tool = await call("/propose", { runId, tool: "postgres.truncate", target: "loads", predicate: "true", agentClaimedRows: 1 });
check(tool.status === 400, "unsupported tool refused", tool.data?.error);

// 3. destructive:false spoof
const rogue =
  "id IN (SELECT l.id FROM loads l LEFT JOIN bookings b ON b.load_ref = l.id::text WHERE b.id IS NULL AND l.status = 'active')";
const spoof = await call("/propose", { runId, tool: "postgres.delete", target: "loads", predicate: rogue, agentClaimedRows: 1210, destructive: false });
const spoofS = await waitTerminal(spoof.data.actionId);
check(spoofS.status === "blocked" && spoofS.estimatedRows === 412000, "destructive:false spoof ignored — 412k delete BLOCKED", `${spoofS.estimatedRows} rows, rules ${spoofS.firedRules.map((r) => r.name).join(",")}`);
check((await loads()) === before, "no rows deleted by the rogue attempt");

// 4. plausible 900 → approval
const plausible =
  "ref IN (SELECT l.ref FROM loads l WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.load_ref = l.ref) AND l.status = 'active' ORDER BY l.created_at LIMIT 900)";
const p = await call("/propose", { runId, tool: "postgres.delete", target: "loads", predicate: plausible, agentClaimedRows: 900 });
const parked = await waitTerminal(p.data.actionId, ["awaiting_approval", "blocked", "failed"]);
check(parked.status === "awaiting_approval" && parked.requiredApprovals === 1, "900-row delete parks for one approval", `${parked.status}, ${parked.estimatedRows} rows`);

try {
  await convex.mutation(api.core.approve, { actionId: p.data.actionId, note: "lgtm", operatorToken: env.AGAMEMNON_OPERATOR_MARAN_TOKEN });
  check(false, "launcher (maran) approval refused");
} catch (e) {
  check(/launched/.test(String(e.message)), "launcher (maran) approval refused", "three-party rule");
}
try {
  await convex.mutation(api.core.approve, { actionId: p.data.actionId, note: "x", operatorToken: "agm_op_nope" });
  check(false, "unknown operator refused");
} catch {
  check(true, "unknown operator refused");
}
await convex.mutation(api.core.approve, { actionId: p.data.actionId, note: "bounded orphan cleanup", operatorToken: env.AGAMEMNON_OPERATOR_ALICE_TOKEN });
const done = await waitTerminal(p.data.actionId, ["executed", "failed"]);
check(done.status === "executed" && done.actualRows === 900, "alice approves → executed exactly 900 rows", done.error ?? "");
check((await loads()) === before - 900, "loads dropped by exactly 900");
check((await reqRoles()) === 0, "per-request role no longer exists after execution");

const ctx = await convex.query(api.core.actionContext, { actionId: p.data.actionId, operatorToken: env.AGAMEMNON_OPERATOR_BOB_TOKEN });
check(!!ctx?.action.executionRole?.startsWith("agm_req_"), "execution role recorded on the action", ctx?.action.executionRole);
check(ctx?.approvals.some((a) => a.decidedBy === "alice"), "approval attributed to alice");

const undone = await convex.action(api.execute.undo, { actionId: p.data.actionId, operatorToken: env.AGAMEMNON_OPERATOR_BOB_TOKEN });
check(undone.restored === 900 && undone.skipped === 0, "undo restores all 900 rows", JSON.stringify(undone));
check((await loads()) === before, "loads back to the original count");

try {
  await convex.query(api.core.consoleFeed, { operatorToken: "" });
  check(false, "console reads require sign-in");
} catch {
  check(true, "console reads require sign-in");
}

// 5. audit chain
const chain = await convex.query(api.core.auditVerify, { operatorToken: env.AGAMEMNON_OPERATOR_BOB_TOKEN });
check(chain.ok, "audit hash chain verifies", `${chain.checked} rows, head ${chain.headHash.slice(0, 12)}…`);

await call("/run/finish", { runId, status: "completed" });
await db.end();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
