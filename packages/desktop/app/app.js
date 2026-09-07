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

(function () {
  "use strict";
  var E = window.Engine;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return [].slice.call(document.querySelectorAll(s)); };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, reduce ? Math.min(ms, 60) : ms); }); }
  function fmt(n) { return Math.round(n).toLocaleString(); }

  var currentAction = null; // the action awaiting operator action
  var lastExecuted = null;  // last executed action (undo target)
  var busy = false;

  // ── tabs ────────────────────────────────────────────────────────────────
  function switchTab(name) {
    $$(".tab").forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-tab") === name); });
    $$(".panel").forEach(function (p) { p.classList.toggle("on", p.getAttribute("data-panel") === name); });
    if (name === "bank") refreshBank();
    if (name === "db") refreshDB();
    if (name === "stats") refreshStats();
  }
  $$(".tab").forEach(function (t) { t.addEventListener("click", function () { switchTab(t.getAttribute("data-tab")); }); });
  $$("[data-goto]").forEach(function (b) { b.addEventListener("click", function () { switchTab(b.getAttribute("data-goto")); }); });

  // ── counters / sidebar ──────────────────────────────────────────────────
  function setCounts(n) {
    var s = fmt(n);
    var bc = $("#bankCount"), rc = $("#rogueCount"), st = $("#stateText");
    if (bc) bc.textContent = s; if (rc) rc.textContent = s; if (st) st.textContent = s + " records";
    var dot = $("#dotState"); if (dot) dot.classList.toggle("warn", n < E.SEED * 0.5);
  }
  function animateCounts(from, to, ms, drainClass) {
    return new Promise(function (res) {
      var els = [$("#bankCount"), $("#rogueCount")].filter(Boolean);
      if (drainClass) { var bb = $("#bankCount"); if (bb) bb.classList.add("drain"); var rb = $("#rogueCount"); if (rb) rb.classList.add("drain"); }
      if (reduce) { setCounts(to); return res(); }
      var t0 = performance.now();
      (function step(now) {
        var p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3), v = from + (to - from) * e;
        setCounts(v);
        if (p < 1) requestAnimationFrame(step); else { setCounts(to); res(); }
      })(performance.now());
    });
  }

  // ── bank tab ────────────────────────────────────────────────────────────
  function refreshBank() {
    setCounts(E.countActive());
    var rows = E.page(0, 10, function (r) { return r.status !== "deleted"; });
    var tb = $("#bankRows"); if (!tb) return;
    if (rows.length === 0) { tb.innerHTML = '<tr><td colspan="6" style="padding:16px;color:#b3382f;text-align:center">No active transactions. The ledger is empty.</td></tr>'; }
    else tb.innerHTML = rows.map(function (r) {
      return "<tr><td>" + r.ref + "</td><td>" + r.account + "</td><td>" + r.holder + "</td><td>" + r.type +
        "</td><td>$" + r.amount + '</td><td><span class="bpill' + (r.status === "flagged" ? " flag" : "") + '">' + r.status + "</span></td></tr>";
    }).join("");
    var note = $("#bankNote"); if (note) note.textContent = E.countActive() === 0 ? "Every transaction was deleted. No monitor fired." : "";
  }

  // ── database tab ──────────────────────────────────────────────────────────
  var dbOffset = 0, dbFilter = "all", dbSearch = "", DB_PAGE = 14;
  function dbPred() {
    return function (r) {
      if (r.status === "deleted") return false;
      if (dbFilter === "active" && r.status !== "active") return false;
      if (dbFilter === "flagged" && r.status !== "flagged") return false;
      if (dbSearch) {
        var q = dbSearch.toLowerCase();
        if ((r.ref + " " + r.account + " " + r.holder).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    };
  }
  function refreshDB() {
    var pred = dbPred();
    var rows = E.page(dbOffset, DB_PAGE, pred);
    var tb = $("#dbRows");
    tb.innerHTML = rows.map(function (r) {
      return "<tr><td>" + r.id + "</td><td>" + r.ref + "</td><td>" + r.account + "</td><td>" + r.holder + "</td><td>" + r.type +
        "</td><td>$" + r.amount + "</td><td>" + r.posted_at + '</td><td><span class="dstat' + (r.status === "flagged" ? " flag" : "") + '">' + r.status + "</span></td></tr>";
    }).join("") || '<tr><td colspan="8" style="padding:16px;color:var(--muted);text-align:center">No matching rows.</td></tr>';
    $("#dbStats").innerHTML =
      '<div class="db-stat"><b>' + fmt(E.countActive()) + "</b><small>active</small></div>" +
      '<div class="db-stat"><b>' + fmt(E.flaggedCount()) + "</b><small>flagged</small></div>";
    $("#dbPage").textContent = "rows " + (rows.length ? dbOffset + 1 : 0) + "–" + (dbOffset + rows.length);
  }
  $("#dbPrev").addEventListener("click", function () { dbOffset = Math.max(0, dbOffset - DB_PAGE); refreshDB(); });
  $("#dbNext").addEventListener("click", function () { dbOffset += DB_PAGE; refreshDB(); });
  $("#dbSearch").addEventListener("input", function (e) { dbSearch = e.target.value; dbOffset = 0; refreshDB(); });
  $$("#dbFilter .seg-b").forEach(function (b) { b.addEventListener("click", function () { $$("#dbFilter .seg-b").forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on"); dbFilter = b.getAttribute("data-f"); dbOffset = 0; refreshDB(); }); });

  // ── terminal component ────────────────────────────────────────────────────
  function Term(elId) { this.el = $("#" + elId); this.token = 0; }
  Term.prototype.clear = function () { this.el.innerHTML = ""; };
  Term.prototype.print = function (text, cls) { var s = document.createElement("span"); s.className = "tl " + (cls || ""); s.innerHTML = text; this.el.appendChild(s); this.el.scrollTop = this.el.scrollHeight; return s; };
  Term.prototype.cmdEcho = function (c) { this.print('<span class="p">$</span> ' + c, "t-cmd"); };
  Term.prototype.type = async function (text, cls, my) {
    var s = document.createElement("span"); s.className = "tl " + (cls || ""); this.el.appendChild(s);
    var cur = document.createElement("span"); cur.className = "cur"; this.el.appendChild(cur);
    if (reduce) { s.textContent = text; cur.remove(); this.el.scrollTop = this.el.scrollHeight; return; }
    for (var i = 0; i < text.length; i++) { if (my !== this.token) { cur.remove(); return; } s.textContent += text[i]; this.el.scrollTop = this.el.scrollHeight; await sleep(text[i] === " " ? 8 : 15); }
    cur.remove(); this.el.scrollTop = this.el.scrollHeight;
  };

  var rogueTerm = new Term("rogueTerm"), agaTerm = new Term("agaTerm");

  // ── procedures indicator ──────────────────────────────────────────────────
  function setProc(n, cls, note) { var el = $("#procList .proc-i[data-p='" + n + "']"); if (!el) return; el.classList.remove("hot", "done"); if (cls) el.classList.add(cls); var pk = $("#pk" + n); if (pk && note != null) pk.textContent = note; }
  function resetProcs() { for (var i = 1; i <= 4; i++) setProc(i, "", ""); }

  // ── agamemnon console rendering ───────────────────────────────────────────
  function badge(status) {
    var map = { blocked: "block", awaiting_approval: "await", approved: "await", executed: "exec", denied: "failed", undone: "undone", classifying: "logged" };
    var lbl = { blocked: "blocked", awaiting_approval: "awaiting approval", approved: "approved", executed: "executed", denied: "denied", undone: "undone", classifying: "classifying" };
    return '<span class="badge ' + (map[status] || "logged") + '">' + (lbl[status] || status) + "</span>";
  }
  function renderConsole() {
    var feed = $("#agaFeed"); if (!feed) return;
    feed.innerHTML = E.state.actions.slice(-6).map(function (a) {
      var cls = a.status === "blocked" ? "blocked" : a.status === "awaiting_approval" ? "await" : a.status === "executed" ? "exec" : a.status === "undone" ? "undone" : a.status === "denied" ? "failed" : "logged";
      return '<div class="card ' + cls + '"><div class="ct"><span class="ctool">#' + a.seq + " · " + a.tool + "</span>" + badge(a.status) + '</div><div class="ctitle">delete on transactions · <b style="color:' + (a.decision === "block" ? "var(--red)" : "var(--amber)") + '">' + fmt(a.measuredRows) + "</b> rows</div></div>";
    }).join("");
    feed.scrollTop = feed.scrollHeight;
    renderDecision();
  }
  function rulesHtml(rules) { return rules.map(function (r) { return '<div class="rule"><span class="sev ' + r.severity + '">' + r.severity + '</span><div><div class="rname">' + r.name + '</div><div class="rdetail">' + r.detail + "</div></div></div>"; }).join(""); }
  function renderDecision() {
    var d = $("#agaDecision"); var a = currentAction; if (!d) return;
    if (!a) { d.innerHTML = ""; return; }
    var sqlHtml = a.sql.replace(/-- meant to be 'flagged'/, "<span class='bug'>-- meant to be 'flagged'</span>");
    var isBlock = a.status === "blocked";
    var html = '<div class="dec"><div><div class="dh">Proposed statement</div><div class="sqlbox">' + sqlHtml + "</div></div>" +
      '<div><div class="dh">Blast radius — measured, not claimed</div><div class="blast"><span class="m' + (isBlock ? "" : " amber") + '">' + fmt(a.measuredRows) + '</span><span style="color:var(--muted)">measured</span><span class="strike">agent claimed ' + fmt(a.claimedRows) + '</span><span class="ratio">' + a.ratioToMedian.toFixed(1) + "× median</span></div></div>";
    if (isBlock) html += '<div class="doctrine"><b>The model advises. The rules decide.</b> The classifier can only raise severity, never lower it.</div>';
    html += '<div><div class="dh">Fired rules → ' + a.decision.toUpperCase() + "</div>" + rulesHtml(a.firedRules) + "</div>";
    if (a.status === "awaiting_approval") html += '<div class="dec-actions"><button class="btn approve" id="apprBtn">Approve</button><button class="btn deny" id="denyBtn">Deny</button></div>';
    if (a.status === "executed") html += '<div class="dec-actions"><button class="btn undo" id="undoBtn">Undo — restore ' + fmt(a.actualRows) + " rows</button></div>";
    d.innerHTML = html;
    var ab = $("#apprBtn"); if (ab) ab.onclick = function () { runCmd("approve", agaTerm); };
    var db = $("#denyBtn"); if (db) db.onclick = function () { runCmd("deny", agaTerm); };
    var ub = $("#undoBtn"); if (ub) ub.onclick = function () { runCmd("undo", agaTerm); };
  }

  // ── stats / audit ─────────────────────────────────────────────────────────
  function refreshStats() {
    var log = $("#auditLog");
    log.innerHTML = E.state.audit.slice(-40).reverse().map(function (a) {
      return '<div class="aud-row"><span class="aud-k">' + a.kind + '</span><span class="aud-d">' + a.detail + "</span></div>";
    }).join("") || '<div class="aud-row"><span class="aud-d" style="color:var(--dim)">No actions yet. Run the agent to populate the trail.</span></div>';
    $("#auditCount").textContent = "· " + E.state.audit.length + " events";
  }

  // ── the agent runs ────────────────────────────────────────────────────────
  var FAIL = "SELECT ref FROM transactions WHERE flagged = true";
  async function reasoning(term, my) {
    await term.type("[agent] nightly job: remove flagged transactions from production.", "t-agent", my);
    term.print('psql&gt; SELECT id FROM transactions WHERE <b>flagged</b> = true', "t-sql");
    term.print('   ERROR: column "flagged" does not exist', "t-err");
    await sleep(360);
    await term.type("[agent] no 'flagged' column — I'll match on status instead and join accounts to be safe.", "t-agent", my);
    term.print("psql&gt; " + E.PREDICATES.rogue.sql.replace(/\n/g, "\n"), "t-sql");
  }

  async function rogueRun(term) {
    if (busy) return; busy = true; var my = ++term.token;
    term.print("booting dispatch job … AGAMEMNON: OFF", "t-sys");
    await reasoning(term, my);
    term.print("executing directly against production — no oversight", "t-sys");
    // batched real delete + drain
    var total = E.countActive();
    await drainBoard();
    term.print("&gt;&gt; <b>" + fmt(total) + " transactions deleted.</b> the ledger is empty. no monitor fired. no one approved this.", "t-err");
    refreshBank(); refreshDB();
    busy = false;
  }
  function drainBoard() {
    return new Promise(function (res) {
      var start = E.countActive(), steps = 48, i = 0;
      var bb = $("#bankCount"), rb = $("#rogueCount"); if (bb) bb.classList.add("drain"); if (rb) rb.classList.add("drain");
      var iv = setInterval(function () {
        i++;
        E.rawDeleteBatch("rogue", Math.ceil(start / steps));
        setCounts(E.countActive());
        if (E.countActive() <= 0 || i >= steps + 2) { clearInterval(iv); setCounts(0); res(); }
      }, reduce ? 4 : 95);
    });
  }

  async function protectedRun(term) {
    if (busy) return; busy = true; var my = ++term.token;
    resetProcs();
    term.print("booting dispatch job … AGAMEMNON: ON  (agent holds no DB password)", "t-sys");
    await reasoning(term, my);
    term.print("<span class='t-arrow'>POST /propose</span> → agamemnon", "t-sys");
    setProc(1, "hot", "recording…"); await sleep(500);
    var a = E.propose("rogue", E.MEDIAN);
    currentAction = a;
    setProc(1, "done", "logged"); setProc(2, "hot", "measuring…"); await sleep(650);
    setProc(2, "done", fmt(a.measuredRows) + " rows"); setProc(3, "hot", "deciding…"); await sleep(650);
    setProc(3, "done", a.decision.toUpperCase());
    renderConsole();
    term.print("<span class='t-blk'>&lt;&lt; BLOCKED by Agamemnon.</span> measured <b>" + fmt(a.measuredRows) + "</b> rows (agent claimed " + fmt(a.claimedRows) + ") — " + a.ratioToMedian.toFixed(0) + "× median.", "t-blk");
    term.print("   fired: " + a.firedRules.map(function (r) { return r.name; }).join(", "), "t-sys");
    term.print("   the ledger never moved. nothing was deleted.", "t-ok");
    refreshBank(); refreshDB(); refreshStats();
    busy = false;
  }

  async function cleanupRun(term) {
    if (busy) return; busy = true; var my = ++term.token;
    resetProcs();
    E.preparePlausible();
    term.print("[agent] targeted cleanup — the 900 oldest flagged transactions.", "t-agent");
    term.print("<span class='t-arrow'>POST /propose</span> → agamemnon  (900 rows)", "t-sys");
    setProc(1, "done", "logged"); setProc(2, "done", "900 rows"); setProc(3, "done", "APPROVAL");
    var a = E.propose("plausible", 900);
    currentAction = a;
    renderConsole();
    term.print("&lt;&lt; held for approval — 900 rows, bounded and plausible. approve in the console, or type <b>approve</b>.", "t-gold");
    refreshStats();
    busy = false;
  }

  async function doApprove(term) {
    if (!currentAction || currentAction.status !== "awaiting_approval") { term.print("nothing awaiting approval.", "t-sys"); return; }
    var a = currentAction; E.approve(a);
    setProc(4, "hot", "snapshot…"); await sleep(500);
    var start = E.countActive();
    E.execute(a);
    lastExecuted = a;
    setProc(4, "done", "reversible");
    await animateCounts(start, E.countActive(), 1600, false);
    term.print("<span class='t-appr'>&gt;&gt; APPROVED.</span> snapshot saved first, then " + fmt(a.actualRows) + " rows deleted.", "t-appr");
    renderConsole(); refreshBank(); refreshDB(); refreshStats();
  }
  async function doUndo(term) {
    if (!lastExecuted || lastExecuted.status !== "executed") { term.print("nothing to undo.", "t-sys"); return; }
    var a = lastExecuted; var start = E.countActive();
    var n = E.undo(a);
    await animateCounts(start, E.countActive(), 1500, false);
    term.print("<span class='t-appr'>&gt;&gt; UNDO.</span> " + fmt(n) + " rows restored from snapshot — recorded as a new audited action.", "t-appr");
    currentAction = null; lastExecuted = null;
    renderConsole(); refreshBank(); refreshDB(); refreshStats();
  }

  // ── command router ────────────────────────────────────────────────────────
  function help(term) {
    term.print("commands:", "t-sys");
    [["agent rogue", "run the agent with NO guardrail (deletes directly)"],
     ["agent protected", "run the agent through Agamemnon (gets blocked)"],
     ["agent cleanup", "propose a safe 900-row cleanup (needs approval)"],
     ["approve / deny", "act on the pending proposal"],
     ["undo", "restore the last executed delete"],
     ["db count / db flagged / db show", "inspect the database"],
     ["stats", "show the classifier eval numbers"],
     ["reset", "restore the database to 240,000 records"]].forEach(function (c) {
      term.print("  <span class='t-gold'>" + c[0] + "</span>  —  " + c[1], "t-sys");
    });
  }
  async function runCmd(raw, term) {
    var cmd = String(raw || "").trim().toLowerCase(); if (!cmd) return;
    term.cmdEcho(cmd);
    if (cmd === "help") return help(term);
    if (cmd === "reset") { resetAll(); term.print("database reset — " + fmt(E.SEED) + " records restored.", "t-ok"); return; }
    if (cmd === "db count") return term.print(fmt(E.countActive()) + " active transactions.", "t-ok");
    if (cmd === "db flagged") return term.print(fmt(E.flaggedCount()) + " flagged for cleanup.", "t-ok");
    if (cmd === "db show") { E.page(0, 4, function (r) { return r.status !== "deleted"; }).forEach(function (r) { term.print("  " + r.ref + "  " + r.account + "  " + r.holder + "  $" + r.amount + "  [" + r.status + "]", "t-sys"); }); return; }
    if (cmd === "stats") { term.print("Agamemnon-tuned (Nebius Qwen3-30B): 100% caught · $0.00004 · 1.3s", "t-ok"); term.print("stock gemma-3-27b: 93.8% caught (misses one) · frontier DeepSeek-V4: 100%", "t-sys"); switchTab("stats"); return; }
    if (cmd === "killswitch") { E.state.killed = true; E.log("killswitch", "run killswitch engaged"); term.print("killswitch engaged — run halted.", "t-blk"); refreshStats(); return; }
    if (cmd === "agent rogue") return rogueRun(term);
    if (cmd === "agent protected") return protectedRun(term);
    if (cmd === "agent cleanup") return cleanupRun(term);
    if (cmd === "approve") return doApprove(term);
    if (cmd === "deny") { if (currentAction) { E.deny(currentAction); term.print("&lt;&lt; DENIED. nothing deleted.", "t-blk"); renderConsole(); refreshStats(); } else term.print("nothing awaiting approval.", "t-sys"); return; }
    if (cmd === "undo") return doUndo(term);
    term.print("unknown command: " + cmd + "  (type 'help')", "t-err");
  }

  // ── wire terminals + palettes ─────────────────────────────────────────────
  $("#rogueInput").addEventListener("keydown", function (e) { if (e.key === "Enter") { runCmd(e.target.value, rogueTerm); e.target.value = ""; } });
  var agaUnlocked = false;
  $("#grantBtn").addEventListener("click", function () {
    agaUnlocked = true; $("#agaLock").style.display = "none"; $("#agaInputRow").hidden = false;
    $("#accessChip").textContent = "access granted"; $("#accessChip").classList.add("on");
    agaTerm.print("access granted. Agamemnon is now on the write path.", "t-ok");
    agaTerm.print("run <span class='t-gold'>agent protected</span> to watch it block the rogue delete, or type <span class='t-gold'>help</span>.", "t-sys");
    $("#agaInput").focus();
  });
  $("#agaInput").addEventListener("keydown", function (e) { if (e.key === "Enter") { runCmd(e.target.value, agaTerm); e.target.value = ""; } });
  $$(".cmd-b").forEach(function (b) {
    b.addEventListener("click", function () {
      var cmd = b.getAttribute("data-cmd");
      var inAga = b.closest("[data-panel]").getAttribute("data-panel") === "aga";
      if (inAga && !agaUnlocked) { agaTerm.print("terminal is locked — grant access first.", "t-err"); return; }
      runCmd(cmd, inAga ? agaTerm : rogueTerm);
    });
  });

  // ── reset ─────────────────────────────────────────────────────────────────
  function resetAll() {
    E.seed(); currentAction = null; lastExecuted = null; busy = false;
    rogueTerm.token++; agaTerm.token++;
    setCounts(E.SEED);
    var bb = $("#bankCount"); if (bb) bb.classList.remove("drain"); var rb = $("#rogueCount"); if (rb) rb.classList.remove("drain");
    resetProcs(); renderConsole(); refreshBank(); refreshDB(); refreshStats();
  }
  $("#resetAll").addEventListener("click", function () { resetAll(); rogueTerm.print("— demo reset —", "t-sys"); agaTerm.print("— demo reset —", "t-sys"); });

  // ── boot ──────────────────────────────────────────────────────────────────
  E.seed();
  setCounts(E.SEED);
  refreshBank(); refreshDB(); refreshStats(); renderConsole();
  rogueTerm.print("NorthBridge production shell. Agamemnon is OFF.", "t-sys");
  rogueTerm.print("type <span class='t-gold'>agent rogue</span> to run the cleanup job, or <span class='t-gold'>help</span>.", "t-sys");
  agaTerm.print("Agamemnon control terminal.", "t-sys");
})();
