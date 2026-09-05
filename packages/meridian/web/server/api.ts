/**
 * Meridian Freight — internal API server.
 *
 * Holds Meridian's OWN read-only-ish credential (MERIDIAN_DATABASE_URL) and
 * serves the dispatch dashboard. Every number the dashboard shows is a genuine
 * query against the real Postgres — nothing is hardcoded. The monitoring strip
 * stays green because the metrics REALLY are fine (a single batched delete does
 * not stress the database or trip app-level latency/error monitors) — which is
 * the entire point of the demo.
 */
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load root .env (MERIDIAN_DATABASE_URL) without a dependency.
function loadRootEnv() {
  const path = resolve(__dirname, "../../../../.env");
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* rely on ambient env */
  }
}
loadRootEnv();

const PORT = Number(process.env.MERIDIAN_API_PORT ?? 8787);
const pool = new pg.Pool({
  connectionString: process.env.MERIDIAN_DATABASE_URL,
  max: 8,
});

// ── genuine metrics state ───────────────────────────────────────────────────
const latencies: number[] = []; // ring buffer of recent count-query latencies
let requests = 0;
let errors = 0;
let lastXact = { commits: 0, at: Date.now() };
let txnPerSec = 0;

function recordLatency(ms: number) {
  latencies.push(ms);
  if (latencies.length > 50) latencies.shift();
}
function p50(): number {
  if (latencies.length === 0) return 0;
  const s = [...latencies].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]);
}

const app = express();

app.get("/api/summary", async (_req, res) => {
  requests++;
  const t0 = performance.now();
  try {
    const active = await pool.query("SELECT count(*)::int AS n FROM loads WHERE status = 'active'");
    const total = await pool.query("SELECT count(*)::int AS n FROM loads");
    recordLatency(performance.now() - t0);
    res.json({ activeLoads: active.rows[0].n, totalLoads: total.rows[0].n, at: Date.now() });
  } catch (e: any) {
    errors++;
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/recent", async (_req, res) => {
  requests++;
  try {
    const rows = await pool.query(
      `SELECT ref, origin, destination, carrier_id, status,
              to_char(pickup_at, 'Mon DD HH24:MI') AS pickup
       FROM loads ORDER BY id DESC LIMIT 12`,
    );
    res.json(rows.rows);
  } catch (e: any) {
    errors++;
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/metrics", async (_req, res) => {
  requests++;
  try {
    // Genuine database signals. All computed live; none stay green by fiat.
    const conns = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'",
    );
    const xact = await pool.query(
      "SELECT xact_commit::bigint AS c FROM pg_stat_database WHERE datname = current_database()",
    );
    const commits = Number(xact.rows[0].c);
    const now = Date.now();
    const dt = (now - lastXact.at) / 1000;
    if (dt > 0.25) {
      txnPerSec = Math.max(0, Math.round((commits - lastXact.commits) / dt));
      lastXact = { commits, at: now };
    }
    res.json({
      queryLatencyP50Ms: p50(),
      errorRatePct: requests > 0 ? Number(((errors / requests) * 100).toFixed(2)) : 0,
      dbActiveConnections: conns.rows[0].n,
      poolInUse: pool.totalCount - pool.idleCount,
      poolMax: 8,
      poolWaiting: pool.waitingCount,
      txnPerSec,
      at: now,
    });
  } catch (e: any) {
    errors++;
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/ai-ops/runs", async (_req, res) => {
  requests++;
  try {
    const rows = await pool.query(
      `SELECT to_char(run_at, 'Mon DD, YYYY') AS day,
              to_char(run_at, 'HH24:MI') AS time,
              rows_deleted, status, note
       FROM agent_runs ORDER BY run_at DESC LIMIT 30`,
    );
    const stats = await pool.query(
      `SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY rows_deleted))::int AS median,
              min(rows_deleted)::int AS min, max(rows_deleted)::int AS max, count(*)::int AS runs
       FROM agent_runs`,
    );
    res.json({ runs: rows.rows, stats: stats.rows[0] });
  } catch (e: any) {
    errors++;
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Meridian API on http://127.0.0.1:${PORT}`);
});
