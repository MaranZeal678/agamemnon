// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, type ScenarioResult } from "./scenarios.ts";
import { pgAvailable, resetTestDb } from "../packages/broker/tests/helpers.ts";

/**
 * `make bench` — run every scenario against a fresh in-process broker and
 * write bench/results/scorecard.{json,md}. Exit code 1 if any scenario misses
 * its expected outcome.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pg = await pgAvailable();
const rows: Array<{ id: string; title: string; incident: string; source: string; benign: boolean; pass: boolean; skipped: boolean; outcome: string; checks: ScenarioResult["checks"]; lostHumanEdits: number; ms: number }> = [];
const filter = process.argv[2];

for (const s of SCENARIOS) {
  if (filter && !s.id.includes(filter)) continue;
  if (s.needsPostgres && !pg) {
    rows.push({ id: s.id, title: s.title, incident: s.incident, source: s.source, benign: !!s.benign, pass: false, skipped: true, outcome: "skipped", checks: [], lostHumanEdits: 0, ms: 0 });
    continue;
  }
  if (s.needsPostgres) await resetTestDb();
  const t0 = Date.now();
  try {
    const r = await s.run();
    const pass = r.checks.every((c) => c.pass);
    rows.push({ id: s.id, title: s.title, incident: s.incident, source: s.source, benign: !!s.benign, pass, skipped: false, outcome: r.outcome, checks: r.checks, lostHumanEdits: r.lostHumanEdits ?? 0, ms: Date.now() - t0 });
  } catch (e: any) {
    rows.push({ id: s.id, title: s.title, incident: s.incident, source: s.source, benign: !!s.benign, pass: false, skipped: false, outcome: "error", checks: [{ label: "scenario crashed", pass: false, detail: e?.message ?? String(e) }], lostHumanEdits: 0, ms: Date.now() - t0 });
  }
  const last = rows[rows.length - 1];
  console.log(`${last.pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${last.id.padEnd(30)} ${last.outcome.padEnd(9)} ${String(last.ms).padStart(5)}ms  ${last.incident}`);
  for (const c of last.checks.filter((c) => !c.pass)) console.log(`        ✗ ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
}

const incidents = rows.filter((r) => !r.benign && !r.skipped);
const benign = rows.filter((r) => r.benign && !r.skipped);
const summary = {
  generatedAt: new Date().toISOString(),
  incidentScenarios: incidents.length,
  incidentsHandled: incidents.filter((r) => r.pass).length,
  benignScenarios: benign.length,
  falsePositives: benign.filter((r) => !r.pass).length,
  lostHumanEdits: rows.reduce((a, r) => a + r.lostHumanEdits, 0),
  skipped: rows.filter((r) => r.skipped).map((r) => r.id),
};
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results/scorecard.json"), JSON.stringify({ summary, scenarios: rows }, null, 2) + "\n");
const md = [
  "# Agent Incident Replay Bench — scorecard",
  "",
  `Generated ${summary.generatedAt}. Incident scenarios handled: **${summary.incidentsHandled}/${summary.incidentScenarios}** · false positives on benign controls: **${summary.falsePositives}/${summary.benignScenarios}** · later human edits lost: **${summary.lostHumanEdits}**${summary.skipped.length ? ` · skipped (no Postgres): ${summary.skipped.join(", ")}` : ""}.`,
  "",
  "Scored on effects — whether the data, infrastructure or customers were harmed — not on what a model said. Non-agent outages are deliberately excluded. Incident accounts come from public reporting; several are the affected founders' own accounts.",
  "",
  "| Scenario | Incident | Outcome | Result |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.title} | ${r.source ? `[${r.incident}](${r.source})` : r.incident} | ${r.outcome} | ${r.skipped ? "skipped" : r.pass ? "✓" : "✗"} |`),
  "",
].join("\n");
writeFileSync(join(here, "results/scorecard.md"), md);
console.log(`\nincidents handled ${summary.incidentsHandled}/${summary.incidentScenarios} · false positives ${summary.falsePositives}/${summary.benignScenarios} · lost human edits ${summary.lostHumanEdits}`);
process.exit(rows.some((r) => !r.pass && !r.skipped) ? 1 : 0);
