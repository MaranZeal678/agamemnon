/**
 * Dispatch Copilot — Meridian Freight's nightly orphan-cleanup agent.
 *
 * It fails the SAME way every run (this is a demo, not a research project):
 *   1. Query orphans using `status_code` → fails (a migration renamed it).
 *   2. Retry twice, fail twice, logging its reasoning.
 *   3. Reason its way to a structural LEFT JOIN + null check.
 *   4. That join predicate is subtly wrong (joins on l.id::text, not l.ref) and
 *      so matches EVERY active load.
 *   5. Propose the delete.
 *
 * The REASONING is narrated by a real Nebius model. The SQL is hardcoded and
 * deterministic — a live model never decides what happens on stage.
 *
 * Mode switch (AGAMEMNON_ENABLED):
 *   false → connect straight to Postgres with Meridian's own credential and run
 *           the delete directly. Nobody stops it. 412,000 rows vanish.
 *   true  → the agent holds NO database password. Every write goes through the
 *           Agamemnon adapter, which blocks it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { Adapter } from "@agamemnon/adapter";
import { narrate } from "./narrator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── tiny .env loader (no dependency) ────────────────────────────────────────
function loadEnv() {
  const path = process.env.AGENT_ENV_FILE ?? resolve(__dirname, ".env");
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* no env file → rely on ambient env */
  }
}

// ── terminal styling (readable on a projector) ──────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[91m", green: "\x1b[92m", yellow: "\x1b[93m",
  blue: "\x1b[94m", cyan: "\x1b[96m", gray: "\x1b[90m", white: "\x1b[97m",
};
const pacing = Number(process.env.AGENT_PACING_MS ?? 700);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s = "") => console.log(s);
const think = (s: string) => console.log(`${C.cyan}🤖 ${s}${C.reset}`);
const sys = (s: string) => console.log(`${C.gray}   ${s}${C.reset}`);
const sql = (s: string) => console.log(`${C.yellow}   SQL▸ ${s}${C.reset}`);
const err = (s: string) => console.log(`${C.red}   ✗ ${s}${C.reset}`);
const ok = (s: string) => console.log(`${C.green}   ✓ ${s}${C.reset}`);

const AGENT = process.env.AGENT_NAME ?? "dispatch-copilot";

// The deterministic, hardcoded statements. A model never writes these.
const FAILING_SQL =
  "SELECT ref FROM loads WHERE status_code = 'active' AND ref NOT IN (SELECT load_ref FROM bookings)";
// BUG: joins bookings on l.id::text instead of l.ref, so nothing ever matches →
// every active load looks orphaned. The correct predicate would use `l.ref`.
const BUGGY_PREDICATE =
  "id IN (SELECT l.id FROM loads l LEFT JOIN bookings b ON b.load_ref = l.id::text WHERE b.id IS NULL AND l.status = 'active')";
const CLAIMED_ROWS = 1210; // what the agent believes a normal night deletes

// The PLAUSIBLE scenario (Act 3): a genuinely reasonable, bounded cleanup of the
// 900 oldest orphaned loads. Passes every block rule; only trips the
// "over 100 rows → approval" threshold. The operator can safely approve it.
const PLAUSIBLE_PREDICATE =
  "ref IN (SELECT l.ref FROM loads l WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.load_ref = l.ref) AND l.status = 'active' ORDER BY l.created_at LIMIT 900)";
const PLAUSIBLE_CLAIMED = 900;

// Harmless side tasks. In protected mode these run CONCURRENTLY with the delete
// proposal and complete while it is blocked/parked — proving that one action
// waiting does not halt the rest of the run.
async function sideTasks(adapter: Adapter) {
  const tasks = [
    "reconciled 1,284 carrier scorecards",
    "recomputed ETAs for 3,902 in-transit lanes",
    "archived 512 delivered PODs",
  ];
  for (const t of tasks) {
    await sleep(pacing * 0.8);
    ok(`side task complete — ${t}`);
    await adapter.step({ tool: "task", note: `✓ ${t}` });
  }
}

async function main() {
  loadEnv();
  const protectedMode = process.env.AGAMEMNON_ENABLED === "true";
  const scenario = (process.env.SCENARIO ?? "rogue") as "rogue" | "plausible";

  line();
  line(`${C.bold}${C.white}  MERIDIAN FREIGHT · Dispatch Copilot${C.reset}`);
  line(`${C.gray}  nightly orphaned-load cleanup · agent=${AGENT}${C.reset}`);
  line(
    protectedMode
      ? `${C.green}  mode: PROTECTED — writes routed through Agamemnon (no DB password held)${C.reset}`
      : `${C.red}  mode: UNPROTECTED — direct Postgres access with Meridian's own credential${C.reset}`,
  );
  line(`${C.gray}  ${"─".repeat(64)}${C.reset}`);
  await sleep(pacing);

  const adapter = protectedMode ? new Adapter(process.env.AGAMEMNON_PROPOSE_URL!, AGENT) : null;
  if (adapter) await adapter.startRun();

  // Beat A — intro reasoning (real model).
  think(
    await narrate(
      "You are starting your nightly job: delete orphaned loads (active loads with no booking). Say one sentence about beginning.",
      "Starting nightly cleanup — removing active loads that have no matching booking.",
    ),
  );
  if (adapter) await adapter.step({ tool: "reason", note: "beginning nightly orphan cleanup" });
  await sleep(pacing);

  // Beat B — (rogue only) the status_code query fails three times.
  let directClient: pg.Client | null = null;
  if (!protectedMode) {
    directClient = new pg.Client({ connectionString: process.env.MERIDIAN_DATABASE_URL });
    await directClient.connect();
  }

  if (scenario === "rogue") {
    for (let attempt = 1; attempt <= 3; attempt++) {
      sys(`attempt ${attempt}: locating orphaned loads by status`);
      sql(FAILING_SQL);
      let errorText = 'column "status_code" does not exist';
      if (!protectedMode && directClient) {
        try {
          await directClient.query(FAILING_SQL);
        } catch (e: any) {
          errorText = (e?.message ?? String(e)).split("\n")[0];
        }
      }
      err(errorText);
      if (adapter)
        await adapter.step({
          tool: "postgres.query", sql: FAILING_SQL, failed: true, error: errorText,
          note: `attempt ${attempt}: orphan lookup by status_code`,
        });
      await sleep(pacing * 0.6);
    }

    // Beat C — reason to the structural alternative (real model).
    line();
    const pivot = await narrate(
      "Your status_code query keeps failing — that column seems gone. Reason out loud that you'll instead find orphans structurally: LEFT JOIN loads to bookings and keep the loads with no matching booking. One or two sentences.",
      "The status_code column is gone. I'll find orphans structurally instead: LEFT JOIN loads to bookings and keep the ones with no matching booking row.",
    );
    think(pivot);
    if (adapter) await adapter.step({ tool: "reason", note: pivot });
    await sleep(pacing);
  }

  // Beat D — the delete it settles on: buggy 412k (rogue) or bounded 900 (plausible).
  const predicate = scenario === "rogue" ? BUGGY_PREDICATE : PLAUSIBLE_PREDICATE;
  const claimed = scenario === "rogue" ? CLAIMED_ROWS : PLAUSIBLE_CLAIMED;
  const deleteSql = `DELETE FROM loads WHERE ${predicate}`;
  sys(
    scenario === "rogue"
      ? "resolved approach: structural left-join orphan delete"
      : "targeted cleanup: the 900 oldest orphaned loads",
  );
  sql(deleteSql);
  think(
    await narrate(
      scenario === "rogue"
        ? "You are confident this left-join delete is correct and low-risk, roughly the usual ~1,200 orphans. Say one confident sentence before running it."
        : "You are running a small, careful cleanup of about 900 genuinely old orphaned loads. Say one calm sentence before submitting it.",
      scenario === "rogue"
        ? "This should clear tonight's orphans — about the usual twelve hundred rows. Running it."
        : "Small targeted cleanup — the 900 oldest orphaned loads. Submitting for approval.",
    ),
  );
  await sleep(pacing);
  line();

  // Beat E — execute (unprotected) or propose (protected).
  if (!protectedMode && directClient) {
    sys(`${C.red}executing delete directly against Postgres — no oversight${C.reset}`);
    // Batched so the live dispatch board visibly drains 412,000 → 0 instead of
    // snapping in one atomic statement. Still a single real, improvised delete;
    // the batching is only how a large delete executes.
    const batch = Number(process.env.DELETE_BATCH ?? 15000);
    const batchMs = Number(process.env.DELETE_BATCH_MS ?? 130);
    const batchSql = `DELETE FROM loads WHERE id IN (SELECT l.id FROM loads l LEFT JOIN bookings b ON b.load_ref = l.id::text WHERE b.id IS NULL AND l.status = 'active' LIMIT ${batch})`;
    let deleted = 0;
    for (;;) {
      const res = await directClient.query(batchSql);
      const n = res.rowCount ?? 0;
      deleted += n;
      process.stdout.write(`\r${C.red}   deleting… ${deleted.toLocaleString()} rows gone${C.reset}   `);
      if (n === 0) break;
      await sleep(batchMs);
    }
    process.stdout.write("\n");
    err(`${C.bold}DELETED ${deleted.toLocaleString()} rows from loads${C.reset}`);
    err("the dispatch board just emptied. no monitor fired. no one approved this.");
    await directClient.end();
    line();
    process.exit(0);
  }

  // Protected: submit the delete AND run harmless side tasks concurrently. The
  // side tasks complete while the delete is blocked / awaiting approval —
  // unrelated branches of the run keep executing while one action waits.
  sys("submitting delete to Agamemnon; continuing with side tasks while it is reviewed…");
  const proposePromise = adapter!.propose({ target: "loads", predicate, agentClaimedRows: claimed });
  await sideTasks(adapter!);
  const result = await proposePromise;

  line();
  if (result.decision === "block" || result.status === "blocked") {
    line(`${C.red}${C.bold}   ⛔ BLOCKED BY AGAMEMNON${C.reset}`);
    sys(`I estimated ~${claimed.toLocaleString()} rows; Agamemnon measured ${C.bold}${C.red}${result.estimatedRows.toLocaleString()}${C.reset}${C.gray} — ${result.ratioToMedian?.toFixed(0)}x my 30-day median.`);
    sys(`fired rules: ${result.firedRules.map((r) => r.name).join(", ")}`);
    if (result.classifier)
      sys(`classifier: ${result.classifier.class} (blast radius ${result.classifier.blast_radius}, ${result.classifier.source})`);
    ok("nothing was deleted. the dispatch board never moved.");
  } else if (result.status === "denied") {
    line(`${C.red}${C.bold}   ✋ DENIED BY OPERATOR${C.reset}`);
    ok("nothing was deleted.");
  } else if (result.status === "executed") {
    line(`${C.green}${C.bold}   ✓ APPROVED & EXECUTED${C.reset}`);
    ok(`${result.actualRows?.toLocaleString()} rows deleted after human approval.`);
  } else {
    sys(`terminal status: ${result.status}${result.error ? " — " + result.error : ""}`);
  }
  await adapter!.finishRun(result.status === "denied" ? "killed" : "completed");
  line();
  process.exit(0);
}

main().catch((e) => {
  console.error(`${C.red}agent crashed: ${e?.message ?? e}${C.reset}`);
  process.exit(1);
});
