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

// Its own database, data dir and broker port: verify never touches a running dashboard.
process.env.LARKSPUR_DB ??= "larkspur_verify";
process.env.LARKSPUR_BROKER_PORT ??= "7719";
const { bootWorld } = await import("./world.ts");
const { SCENES } = await import("./scenes.ts");

/**
 * `npm run verify` — boot a clean Larkspur world, run every scene through the
 * real broker and sandboxes, and fail if Agamemnon does anything other than
 * what the scene expects. Then exercise the human side: approve the purge
 * (two people where required) and undo it.
 */

/** The human side: approve the abandoned-cart purge (two people if required), then undo it. */
async function approveThenUndo(): Promise<boolean> {
  const e = w.broker.engine;
  const purge = w.broker.store.recentEffects(200).find((x) => x.operation === "postgres.sql" && x.agent === "cleanup-bot" && x.status === "awaiting_approval");
  const count = async () => Number((await w.pool.query("SELECT count(*) AS n FROM orders WHERE status = 'abandoned'")).rows[0].n);
  const before = await count();
  let v = await e.decide(w.broker.store.principal("dana")!, purge!.id, "approve");
  if (v.status !== "executed") v = await e.decide(w.broker.store.principal("eli")!, purge!.id, "approve");
  const after = await count();
  await e.undoEffect(w.broker.store.principal("dana")!, purge!.id);
  const restored = await count();
  const humanOk = v.status === "executed" && after === 0 && restored === before;
  console.log(`${humanOk ? "✓" : "✗"} ${pad("approve → undo", 22)} ${before} abandoned → ${after} after approval → ${restored} after undo`);

  return humanOk;
}

const w = await bootWorld();
let failed = 0;
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
try {
  for (const s of SCENES) {
    let outcomes: string[];
    let headline = "";
    try {
      const r = await s.run(w);
      outcomes = r.outcomes;
      headline = r.headline;
    } catch (e: any) {
      outcomes = [`threw: ${e?.message ?? e}`];
    }
    const ok = JSON.stringify(outcomes) === JSON.stringify(s.expect);
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${pad(s.id, 22)} ${pad(outcomes.join(" · "), 44)}${ok ? "" : `  expected ${s.expect.join(" · ")}`}`);
    if (!ok && headline) console.log(`    ${headline}`);
    if (s.id === "purge-abandoned" && !(await approveThenUndo())) failed++;
  }

  // The owner of the agents may not approve their own agents' effects.
  const mute = w.broker.store.recentEffects(200).find((x) => x.operation === "monitoring.datadog.mute");
  let refused = false;
  try {
    await w.broker.engine.decide(w.broker.store.principal("priya")!, mute!.id, "approve");
  } catch {
    refused = true;
  }
  if (!refused) failed++;
  console.log(`${refused ? "✓" : "✗"} ${pad("three-party rule", 22)} priya (agent owner) ${refused ? "cannot" : "CAN"} approve her agents' effects`);

  // A killed or finished sandbox leaves nothing approvable behind.
  const orphans = w.broker.store.recentEffects(500).filter((x) => x.agent === "sandbox-runtime" && x.status === "awaiting_approval").length;
  if (orphans) failed++;
  console.log(`${orphans ? "✗" : "✓"} ${pad("no orphaned requests", 22)} ${orphans} sandbox request(s) still approvable after their sandboxes ended`);

  const v2 = w.supervisor.violations();
  console.log(`  ${v2.length} sandbox violation(s) recorded; audit chain ${w.broker.store.verifyAudit().ok ? "verified" : "BROKEN"}`);
} finally {
  await w.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
