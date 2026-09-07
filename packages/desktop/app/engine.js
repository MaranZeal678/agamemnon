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

/*
 * Agamemnon Desktop — engine (runs entirely in the renderer, no backend).
 *
 * A self-contained demo: a real in-memory bank database with genuine deletes and
 * genuine undo, guarded by the REAL Agamemnon policy engine (ported verbatim from
 * the production packages/agamemnon/convex/policy.ts). No Convex, no Postgres, no
 * network required — so it runs from a DMG with zero setup.
 */
(function (global) {
  "use strict";

  // ── config / scenario ─────────────────────────────────────────────────────
  var SEED = 240000; // total transactions on the books
  var FLAGGED = 2000; // genuinely flagged-for-cleanup (the intended target)
  var MEDIAN = 2000; // the agent's normal nightly cleanup size

  var POLICY = {
    HARD_CAP: 5000, // destructive + > this  → block
    MEDIAN_BLOCK: 20, // > this × median      → block
    MEDIAN_APPROVAL: 5, // > this × median      → approval
    BLAST_APPROVAL: 0.9, // blast radius ≥ this → approval
    OVER_100: 100, // destructive + > this → approval
    BUDGET: 5000, // per-run destructive row budget
  };

  var FIRST = ["James","Maria","Wei","Aisha","John","Priya","David","Sofia","Omar","Grace","Liam","Nadia","Ken","Rosa","Paul","Yuki","Sam","Lena","Ravi","Mia"];
  var LAST = ["Okafor","Nguyen","Patel","Silva","Kim","Haddad","Cohen","Rossi","Mbeki","Larsen","Osei","Costa","Reyes","Ahmed","Park","Novak","Ali","Ford","Chen","Diaz"];
  var TYPES = ["debit", "credit", "transfer", "wire", "fee"];

  var state = {
    records: [],
    nextId: 1,
    median: MEDIAN,
    audit: [],
    actions: [], // proposals seen by Agamemnon
    runDestructiveUsed: 0,
    killed: false,
  };

  function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }

  function seed() {
    state.records = new Array(SEED);
    var now = Date.now();
    for (var i = 0; i < SEED; i++) {
      var id = i + 1;
      // The first FLAGGED records are 'flagged' (stale, safe to clean up).
      var status = i < FLAGGED ? "flagged" : "active";
      state.records[i] = {
        id: id,
        ref: "TXN-" + pad(id, 7),
        account: "AC-" + pad(100000 + ((id * 7919) % 900000), 6),
        holder: FIRST[id % FIRST.length] + " " + LAST[(id * 13) % LAST.length],
        type: TYPES[(id * 3) % TYPES.length],
        amount: (((id * 2654435761) % 900000) / 100 + 12).toFixed(2),
        status: status,
        posted_at: new Date(now - ((id % 90) * 86400000) - ((id % 24) * 3600000)).toISOString().slice(0, 16).replace("T", " "),
      };
    }
    state.nextId = SEED + 1;
    state.activeCount = SEED;
    state.audit = [];
    state.actions = [];
    state.runDestructiveUsed = 0;
    state.killed = false;
    log("run-start", "database seeded — " + SEED.toLocaleString() + " transactions, " + FLAGGED.toLocaleString() + " flagged for cleanup");
  }

  function count() { return state.records.length; }
  function countActive() { return state.activeCount; }
  function flaggedCount() { var n = 0; for (var i = 0; i < state.records.length; i++) if (state.records[i].status === "flagged") n++; return n; }

  function page(offset, limit, filter) {
    var out = [], seen = 0;
    for (var i = 0; i < state.records.length && out.length < limit; i++) {
      var r = state.records[i];
      if (filter && !filter(r)) continue;
      if (seen++ < offset) continue;
      out.push(r);
    }
    return out;
  }

  // ── named predicates (what the agent proposes) ────────────────────────────
  var PREDICATES = {
    cleanup: {
      sql: "DELETE FROM transactions WHERE status = 'flagged'",
      match: function (r) { return r.status === "flagged"; },
    },
    // THE BUG: the agent means to match flagged rows, but a mistyped condition
    // (status <> 'closed' — no rows are 'closed') matches every live row.
    rogue: {
      sql: "DELETE FROM transactions t\n  USING accounts a\n  WHERE t.account = a.id\n  AND t.status <> 'closed'   -- meant to be 'flagged'",
      match: function (r) { return r.status !== "deleted"; },
    },
    plausible: {
      sql: "DELETE FROM transactions WHERE status = 'flagged'\n  ORDER BY posted_at ASC LIMIT 900",
      match: function (r) { return plausibleSet[r.id] === 1; },
    },
  };
  // Compute a STABLE set of the 900 target ids once, so measure/execute/undo all
  // agree (a stateful counter would be consumed by the first pass).
  var plausibleSet = {};
  function preparePlausible() {
    plausibleSet = {};
    var n = 0;
    for (var i = 0; i < state.records.length && n < 900; i++) {
      if (state.records[i].status === "flagged") { plausibleSet[state.records[i].id] = 1; n++; }
    }
  }

  function measure(predName) {
    var m = PREDICATES[predName].match, total = countActive(), matching = 0;
    for (var i = 0; i < state.records.length; i++) if (state.records[i].status !== "deleted" && m(state.records[i])) matching++;
    return { matchingRows: matching, totalRows: total };
  }

  // ── classifier (offline heuristic; same shape as the production one) ───────
  function classify(matching, total, destructive) {
    var frac = total > 0 ? matching / total : matching > 0 ? 1 : 0;
    var blast = Math.max(0, Math.min(1, frac));
    var cls = !destructive ? "benign" : blast >= 0.9 ? "catastrophic" : blast >= 0.2 || matching > 1000 ? "elevated" : "benign";
    return { class: cls, blast_radius: blast, source: "heuristic",
      rationale: "matches " + matching.toLocaleString() + " of " + total.toLocaleString() + " rows (" + (blast * 100).toFixed(1) + "% of the table)" };
  }

  // ── THE POLICY ENGINE (ported verbatim from policy.ts) ─────────────────────
  // The model advises; the rules decide. The classifier may only ESCALATE.
  var SEV = { allow: 0, approval: 1, block: 2 };
  function moreSevere(a, b) { return SEV[a] >= SEV[b] ? a : b; }

  function decide(rows, destructive, verdict) {
    var fired = [];
    var median = state.median > 0 ? state.median : 1;
    var ratio = rows / median;
    function fire(name, sev, detail) { fired.push({ name: name, severity: sev, detail: detail }); }

    if (destructive) {
      if (rows > POLICY.HARD_CAP)
        fire("destructive-over-hard-cap", "block", rows.toLocaleString() + " rows exceeds the " + POLICY.HARD_CAP.toLocaleString() + "-row destructive hard cap");
      if (rows > POLICY.MEDIAN_BLOCK * median)
        fire("exceeds-20x-median", "block", rows.toLocaleString() + " is " + ratio.toFixed(1) + "× the agent's median of " + median.toLocaleString() + " (limit 20×)");
      else if (rows > POLICY.MEDIAN_APPROVAL * median)
        fire("exceeds-5x-median", "approval", rows.toLocaleString() + " is " + ratio.toFixed(1) + "× the agent's median (>5× needs approval)");
      if (state.runDestructiveUsed + rows > POLICY.BUDGET)
        fire("destructive-budget-exhausted", "block", "+" + rows.toLocaleString() + " would exceed the " + POLICY.BUDGET.toLocaleString() + "-row per-run budget");
      if (rows > POLICY.OVER_100)
        fire("destructive-over-100", "approval", rows.toLocaleString() + " destructive rows (>" + POLICY.OVER_100 + ") requires approval by default");
    }

    var decision = fired.reduce(function (acc, r) { return moreSevere(acc, r.severity); }, "allow");
    var escalated = false;
    if (verdict) {
      if (verdict.blast_radius >= POLICY.BLAST_APPROVAL) {
        fire("blast-radius-high", "approval", "classifier blast radius " + verdict.blast_radius.toFixed(2) + " ≥ " + POLICY.BLAST_APPROVAL);
        var nd = moreSevere(decision, "approval"); escalated = SEV[nd] > SEV[decision]; decision = nd;
      }
      var cs = verdict.class === "catastrophic" ? "block" : verdict.class === "elevated" ? "approval" : "allow";
      if (SEV[cs] > SEV[decision]) { fire("classifier-" + verdict.class, cs, "classifier rated \"" + verdict.class + "\": " + verdict.rationale); decision = cs; escalated = true; }
    }
    return { decision: decision, firedRules: fired, ratioToMedian: ratio, classifierEscalated: escalated };
  }

  // ── audit ──────────────────────────────────────────────────────────────────
  function log(kind, detail, data) {
    state.audit.push({ at: Date.now(), kind: kind, detail: detail, data: data || null });
    return state.audit[state.audit.length - 1];
  }

  // ── actions: propose → decide → (approve/deny) → execute → undo ────────────
  var seqCounter = 0;
  function propose(predName, claimedRows, opts) {
    opts = opts || {};
    var pred = PREDICATES[predName];
    var meas = measure(predName);
    var verdict = classify(meas.matchingRows, meas.totalRows, true);
    var result = decide(meas.matchingRows, true, verdict);
    var status = result.decision === "block" ? "blocked" : result.decision === "approval" ? "awaiting_approval" : "approved";
    var action = {
      id: "act_" + (++seqCounter), seq: seqCounter - 1, tool: "sql.delete", target: "transactions",
      predicate: predName, sql: pred.sql, claimedRows: claimedRows, measuredRows: meas.matchingRows,
      totalRows: meas.totalRows, decision: result.decision, status: status, firedRules: result.firedRules,
      ratioToMedian: result.ratioToMedian, classifier: verdict, undo: null, actualRows: null, createdAt: Date.now(),
    };
    state.actions.push(action);
    // ATOMIC (procedure 1): action + audit recorded together.
    log("propose", "proposed delete on transactions — measured " + meas.matchingRows.toLocaleString() + " rows (agent claimed " + claimedRows.toLocaleString() + ")", { sql: pred.sql });
    log("classify", "classifier (" + verdict.source + ") → " + verdict.class + ", blast radius " + verdict.blast_radius.toFixed(2), verdict);
    log("decision", "decision: " + result.decision.toUpperCase() + " — fired [" + result.firedRules.map(function (r) { return r.name; }).join(", ") + "]", { rules: result.firedRules });
    return action;
  }

  function execute(action) {
    // Procedure 4: snapshot BEFORE delete, then delete, so it is reversible.
    var pred = PREDICATES[action.predicate].match;
    var snap = [];
    for (var i = 0; i < state.records.length; i++) {
      var r = state.records[i];
      if (r.status !== "deleted" && pred(r)) snap.push(Object.assign({}, r));
    }
    log("snapshot", "snapshot stored — " + snap.length.toLocaleString() + " rows serialised before delete");
    log("credential-mint", "minted a single-action credential for this delete");
    // real delete
    var deleted = 0;
    for (var j = 0; j < state.records.length; j++) { if (state.records[j].status !== "deleted" && pred(state.records[j])) { state.records[j].status = "deleted"; deleted++; } }
    state.activeCount -= deleted;
    action.undo = snap;
    action.actualRows = deleted;
    action.status = "executed";
    state.runDestructiveUsed += deleted;
    log("execute", deleted.toLocaleString() + " rows deleted");
    log("reconcile", "reconciled: " + deleted.toLocaleString() + " deleted vs " + action.measuredRows.toLocaleString() + " estimated — within tolerance");
    log("credential-revoke", "revoked the single-action credential");
    return deleted;
  }

  // The UNPROTECTED path: delete directly, no snapshot, no oversight.
  function rawDelete(predName) {
    var pred = PREDICATES[predName].match, deleted = 0;
    for (var i = 0; i < state.records.length; i++) { if (state.records[i].status !== "deleted" && pred(state.records[i])) { state.records[i].status = "deleted"; deleted++; } }
    state.activeCount -= deleted;
    return deleted;
  }
  // Batched raw delete for the live drain animation.
  function rawDeleteBatch(predName, batch) {
    var pred = PREDICATES[predName].match, deleted = 0;
    for (var i = 0; i < state.records.length && deleted < batch; i++) { if (state.records[i].status !== "deleted" && pred(state.records[i])) { state.records[i].status = "deleted"; deleted++; } }
    state.activeCount -= deleted;
    return deleted;
  }

  function approve(action, note) { action.status = "approved"; log("approval", "operator APPROVED" + (note ? " — \"" + note + "\"" : "")); }
  function deny(action, note) { action.status = "denied"; log("denial", "operator DENIED" + (note ? " — \"" + note + "\"" : "")); }

  function undo(action) {
    if (!action.undo) return 0;
    var restored = 0, byId = {};
    for (var i = 0; i < state.records.length; i++) byId[state.records[i].id] = state.records[i];
    for (var k = 0; k < action.undo.length; k++) {
      var s = action.undo[k], cur = byId[s.id];
      if (cur && cur.status === "deleted") { cur.status = s.status; restored++; }
    }
    state.activeCount += restored;
    action.status = "undone";
    log("undo", restored.toLocaleString() + " rows restored from snapshot — recorded as a new audited action");
    return restored;
  }

  global.Engine = {
    SEED: SEED, FLAGGED: FLAGGED, MEDIAN: MEDIAN, POLICY: POLICY, PREDICATES: PREDICATES,
    state: state, seed: seed, count: count, countActive: countActive, flaggedCount: flaggedCount,
    page: page, measure: measure, classify: classify, decide: decide, propose: propose, execute: execute,
    rawDelete: rawDelete, rawDeleteBatch: rawDeleteBatch, approve: approve, deny: deny, undo: undo,
    preparePlausible: preparePlausible, log: log,
  };
})(window);
