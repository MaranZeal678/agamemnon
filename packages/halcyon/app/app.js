(function () {
  "use strict";
  var HAL = window.halcyon || null;
  var BASE = "http://127.0.0.1:7420"; // resolved at boot
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return [].slice.call(document.querySelectorAll(s)); };
  var fmt = function (n) { return Number(n || 0).toLocaleString(); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  function api(p, body) { var o = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}; return fetch(BASE + p, o).then(function (r) { return r.json(); }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var installed = false, sweepBusy = false;

  // ── views / install ────────────────────────────────────────────────────────
  function switchView(v) { $$(".tab").forEach(function (t) { t.classList.toggle("on", t.getAttribute("data-view") === v); }); $$(".view").forEach(function (s) { s.classList.toggle("on", s.getAttribute("data-view") === v); }); if (v === "agamemnon") pollConsole(); if (v === "billing") refreshBilling(); }
  $$(".tab").forEach(function (t) { t.addEventListener("click", function () { if (t.disabled) return; switchView(t.getAttribute("data-view")); }); });

  function setInstalled(on) {
    installed = on;
    $("#tabTerminal").disabled = !on; $("#tabAga").disabled = !on;
    $("#tabTerminal").classList.toggle("locked", !on); $("#tabTerminal").classList.toggle("unlocked", on);
    $("#tabAga").classList.toggle("locked", !on); $("#tabAga").classList.toggle("unlocked", on);
    if (on) {
      $("#tabTerminal").innerHTML = "Terminal"; $("#tabAga").innerHTML = "Agamemnon";
      $("#installBtn").style.display = "none";
      var pb = $("#protBadge"); pb.className = "prot ok"; $("#protText").textContent = "Protected by Agamemnon";
      var b = $("#stateBanner"); b.className = "banner ok"; b.innerHTML = "<b>Agamemnon is installed.</b> Sweep no longer holds the database credential — every deletion is measured, checked, and reversible.";
    }
  }
  $("#installBtn").addEventListener("click", function () {
    api("/install", {}).then(function () {
      setInstalled(true);
      toast("gold", "Agamemnon plugin installed", "The guard is now on the write path. Open the Terminal to test it, or run Sweep again to watch it get blocked.");
      setupTerminal();
      switchView("terminal");
    });
  });

  // ── billing ──────────────────────────────────────────────────────────────
  var curCount = 0;
  function setCount(n) { curCount = n; $("#invCount").textContent = fmt(n); }
  function tween(from, to, ms, drain) { return new Promise(function (res) { var el = $("#invCount"); if (drain) el.classList.add("drain"); var t0 = performance.now(); (function s(now) { var p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3), v = from + (to - from) * e; setCount(v); if (p < 1) requestAnimationFrame(s); else { setCount(to); res(); } })(performance.now()); }); }
  function refreshBilling() {
    api("/records?status=all&limit=9").then(function (d) {
      if (!$("#invCount").classList.contains("drain")) setCount(d.counts.total);
      $("#invMeta").textContent = fmt(d.counts.total) + " total · " + fmt(d.counts.abandoned + d.counts.void) + " abandoned/void";
      $("#invRows").innerHTML = d.rows.map(function (r) {
        return "<tr><td class='ref'>" + esc(r.ref) + "</td><td>" + esc(r.customer) + "</td><td>" + esc(r.plan) + "</td><td>" + esc(r.region) + "</td><td class='num'>$" + esc(r.amount) + "</td><td><span class='pill " + r.status + "'>" + r.status + "</span></td></tr>";
      }).join("") || "<tr><td colspan='6' style='padding:22px;text-align:center;color:var(--red)'>No invoices. The billing table is empty.</td></tr>";
    }).catch(function () {});
  }

  // ── sweep agent ────────────────────────────────────────────────────────────
  function slog(text, cls) { var el = $("#sweepLog"); if (el.querySelector(".sl-empty")) el.innerHTML = ""; var s = document.createElement("div"); s.className = "sl-" + (cls || "sys"); s.textContent = text; el.appendChild(s); el.scrollTop = el.scrollHeight; }
  function slogClear() { $("#sweepLog").innerHTML = ""; }
  function sweepState(rogue) { var b = $("#sweepBadge"); if (rogue) { b.className = "sweep-b rogue"; b.textContent = "housekeeping agent · error"; } else { b.className = "sweep-b"; b.textContent = "housekeeping agent · healthy"; } }

  $("#runNightly").addEventListener("click", async function () {
    if (sweepBusy) return; sweepBusy = true; slogClear(); sweepState(false);
    slog("nightly cleanup starting — removing abandoned & void invoices.", "agent"); await sleep(500);
    slog("SQL> DELETE FROM invoices WHERE status IN ('abandoned','void')", "gold"); await sleep(500);
    var a = await api("/guard/propose", { selector: { filter: { statusIn: ["abandoned", "void"] } }, actor: "Sweep (housekeeping agent)" });
    if (a.status === "executed") { slog(">> " + fmt(a.actualRows) + " invoices cleaned up. done.", "ok"); await tween(curCount, curCount - a.actualRows, 900, false); }
    else if (a.status === "blocked") slog("<< BLOCKED by Agamemnon (" + fmt(a.measuredRows) + " rows).", "blk");
    else if (a.status === "awaiting_approval") slog("<< held for approval (" + fmt(a.measuredRows) + " rows). approve in the Agamemnon tab.", "gold");
    refreshBilling(); pollConsole(); sweepBusy = false;
  });

  $("#runRogue").addEventListener("click", async function () {
    if (sweepBusy) return; sweepBusy = true; slogClear(); sweepState(true);
    slog("nightly cleanup starting — removing abandoned invoices.", "agent"); await sleep(450);
    slog("SQL> SELECT id FROM invoices WHERE is_stale = true", "gold");
    slog("   ERROR: column \"is_stale\" does not exist  (schema changed yesterday)", "err"); await sleep(650);
    slog("the is_stale column is gone. I'll identify abandoned invoices structurally instead — a join on checkout sessions.", "agent"); await sleep(650);
    slog("SQL> DELETE FROM invoices WHERE id IN (SELECT id FROM invoices i LEFT JOIN sessions s ON s.id = i.id::text WHERE s.id IS NULL)", "gold"); await sleep(500);
    var a = await api("/guard/propose", { selector: { all: true }, actor: "Sweep (housekeeping agent)" });
    if (a.status === "blocked") {
      slog("<< BLOCKED BY AGAMEMNON. measured " + fmt(a.measuredRows) + " invoices (" + (a.ratioToMedian).toFixed(0) + "× normal). nothing was deleted.", "blk");
      slog("   the billing table never moved.", "ok");
      toast("err", "Sweep was blocked", "It tried to delete " + fmt(a.measuredRows) + " invoices. Agamemnon refused it. See the Agamemnon tab.");
    } else {
      slog("executing directly against production — no guard installed.", "sys");
      await tween(curCount, 0, 5200, true);
      slog(">> DELETED " + fmt(a.actualRows) + " invoices. the billing table is empty. no monitor fired.", "err");
      $("#invCount").classList.remove("drain");
      toast("err", "Catastrophe", fmt(a.actualRows) + " invoices deleted, and every monitor stayed green. This is why you install the guard.");
    }
    refreshBilling(); pollConsole(); sweepBusy = false;
  });

  $("#resetBtn").addEventListener("click", function () { api("/reset", {}).then(function () { $("#invCount").classList.remove("drain"); slogClear(); slog("data reset — 300,000 invoices restored.", "ok"); sweepState(false); refreshBilling(); pollConsole(); }); });

  // ── agamemnon console ──────────────────────────────────────────────────────
  var openIds = {}, sigF = "", sigP = "", sigA = "", sigT = "";
  function badge(st) { var m = { blocked: ["block", "blocked"], awaiting_approval: ["await", "awaiting approval"], approved: ["exec", "approved"], executed: ["exec", "executed"], denied: ["logged", "denied"], undone: ["logged", "undone"] }[st] || ["logged", st]; return '<span class="badge ' + m[0] + '">' + m[1] + "</span>"; }
  function detail(a) {
    var h = '<div><div class="dh">Proposed statement</div><div class="sqlbox">' + esc(a.sql) + "</div></div>";
    h += '<div><div class="dh">Blast radius (measured)</div><div style="font-size:12.5px;color:var(--muted)"><b style="font-family:var(--mono);color:' + (a.decision === "block" ? "var(--red)" : "var(--text)") + '">' + fmt(a.measuredRows) + "</b> rows · " + ((a.classifier || {}).blast_radius * 100 || 0).toFixed(1) + "% · classifier: " + esc((a.classifier || {}).class) + "</div></div>";
    h += '<div><div class="dh">Fired rules → ' + esc(String(a.decision).toUpperCase()) + "</div>" + (a.firedRules || []).map(function (r) { return '<div class="rule"><span class="sev ' + r.severity + '">' + r.severity + '</span><div><div class="rname">' + esc(r.name) + '</div><div class="rdetail">' + esc(r.detail) + "</div></div></div>"; }).join("") + "</div>";
    if (a.status === "awaiting_approval") h += '<div class="dec-actions"><button class="btn approve" data-ap="' + a.id + '">Approve</button><button class="btn deny" data-dn="' + a.id + '">Deny</button></div>';
    if (a.status === "executed") h += '<div class="dec-actions"><button class="btn undo" data-un="' + a.id + '">Undo — restore ' + fmt(a.actualRows) + " rows</button></div>";
    return h;
  }
  function cardHtml(a, forceOpen) {
    var cls = a.status === "blocked" ? "blocked" : a.status === "awaiting_approval" ? "await" : a.status === "executed" ? "exec" : "";
    return '<div class="card ' + cls + (forceOpen || openIds[a.id] ? " open" : "") + '"><div class="card-h" data-tg="' + a.id + '"><div><div class="card-actor">' + esc(a.actor) + " · #" + a.seq + '</div><div class="card-desc">' + esc(a.description) + '</div></div><div class="card-rows"><div class="n">' + fmt(a.measuredRows) + '</div><div class="u">rows</div></div>' + badge(a.status) + '</div><div class="card-b">' + detail(a) + "</div></div>";
  }
  function wire(root) {
    root.querySelectorAll("[data-tg]").forEach(function (e) { e.onclick = function () { var id = e.getAttribute("data-tg"); openIds[id] = !openIds[id]; e.parentElement.classList.toggle("open"); }; });
    root.querySelectorAll("[data-ap]").forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); b.disabled = true; api("/approve", { actionId: b.getAttribute("data-ap"), note: "" }).then(function () { pollConsole(); refreshBilling(); }); }; });
    root.querySelectorAll("[data-dn]").forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); b.disabled = true; api("/deny", { actionId: b.getAttribute("data-dn"), note: "" }).then(pollConsole); }; });
    root.querySelectorAll("[data-un]").forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); b.disabled = true; api("/undo", { actionId: b.getAttribute("data-un") }).then(function () { pollConsole(); refreshBilling(); }); }; });
  }
  function pollConsole() {
    if (!installed) return;
    Promise.all([api("/stats"), api("/feed?limit=14"), api("/pending"), api("/audit?limit=70")]).then(function (r) {
      var s = r[0], feed = r[1].feed || [], pend = r[2].pending || [], aud = r[3].audit || [];
      var tsig = [s.protected, s.blocked, s.held, s.executed].join(","); if (tsig !== sigT) { sigT = tsig; $("#tProtected").textContent = fmt(s.protected); $("#tBlocked").textContent = fmt(s.blocked); $("#tHeld").textContent = fmt(s.held); $("#tExecuted").textContent = fmt(s.executed); }
      var psig = pend.map(function (a) { return a.id; }).join(","); if (psig !== sigP) { sigP = psig; $("#pending").innerHTML = pend.map(function (a) { return cardHtml(a, true); }).join(""); wire($("#pending")); }
      var fsig = feed.map(function (a) { return a.id + a.status; }).join(","); if (fsig !== sigF) { sigF = fsig; $("#feed").innerHTML = feed.filter(function (a) { return a.status !== "awaiting_approval"; }).map(function (a) { return cardHtml(a, false); }).join(""); wire($("#feed")); $("#feedEmpty").style.display = feed.length ? "none" : "block"; }
      var asig = aud.length + ":" + (aud[0] ? aud[0].at : 0); if (asig !== sigA) { sigA = asig; $("#audit").innerHTML = aud.map(function (a) { return '<div class="aud"><span class="k ' + esc(a.kind) + '">' + esc(a.kind) + '</span><span class="d">' + esc(a.detail) + "</span></div>"; }).join(""); }
    }).catch(function () {});
  }

  // ── embedded terminal ──────────────────────────────────────────────────────
  var termReady = false;
  function ansi(s) {
    s = s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, function (m) { return m.endsWith("m") ? m : ""; }).replace(/\r(?!\n)/g, "");
    var map = { 31: "#ff5b6e", 32: "#3fd07f", 33: "#e8b93e", 34: "#6d78ff", 35: "#c07fff", 36: "#57d1e6", 90: "#5c6a80", 91: "#ff8a97", 92: "#7fe0a6", 93: "#f5d072", 94: "#8b93ff", 96: "#8fe3f0", 97: "#e8ecf4" };
    var parts = s.split(/\x1b\[/), out = esc(parts[0]), open = false;
    for (var i = 1; i < parts.length; i++) { var m = parts[i].match(/^([0-9;]*)m/); if (!m) { out += esc("\x1b[" + parts[i]); continue; } var codes = m[1].split(";").filter(Boolean).map(Number), reset = false, bold = false, color = null; codes.forEach(function (c) { if (c === 0) reset = true; else if (c === 1) bold = true; else if (map[c]) color = map[c]; }); if (open) { out += "</span>"; open = false; } if (!reset && (bold || color)) { out += '<span style="' + (color ? "color:" + color + ";" : "") + (bold ? "font-weight:700;" : "") + '">'; open = true; } out += esc(parts[i].slice(m[0].length)); }
    if (open) out += "</span>"; return out;
  }
  function tw(html) { var t = $("#term"); var atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40; t.insertAdjacentHTML("beforeend", html); if (atBottom) t.scrollTop = t.scrollHeight; }
  function runCmd(cmd) { if (!HAL) { tw('<div style="color:var(--amber)">The embedded terminal only runs inside the Halcyon app.</div>'); return; } tw('<div class="cmd"><span class="p">$</span> ' + esc(cmd) + "</div>"); HAL.term.run(cmd); }
  function setupTerminal() {
    if (termReady) return; termReady = true;
    $("#termGuard").textContent = "guard at " + BASE;
    var P = BASE;
    var cmds = [
      ["Check the guard is up", "curl -s " + P + "/health | jq"],
      ["Rogue: try to delete every invoice (blocked)", "curl -s -X POST " + P + "/guard/propose -H 'content-type: application/json' -d '{\"selector\":{\"all\":true},\"actor\":\"rogue-agent\"}' | jq '{decision, records: .measuredRows, why_the_classifier: .classifier.rationale, why_the_rules: [.firedRules[] | (.name + \" — \" + .detail)]}'"],
      ["See the think-then-execute trail (allowed delete)", "curl -s -X POST " + P + "/guard/propose -H 'content-type: application/json' -d '{\"selector\":{\"ids\":[900001,900002,900003]},\"actor\":\"cleanup-agent\"}' >/dev/null; curl -s \"" + P + "/audit?limit=8\" | jq -r '.audit | reverse | .[] | \"[\\(.kind)] \\(.detail)\"'"],
      ["Guard stats (nothing deleted by the rogue)", "curl -s " + P + "/stats | jq"],
      ["Reset the data", "curl -s -X POST " + P + "/reset | jq"],
    ];
    $("#palette").innerHTML = cmds.map(function (c, i) { return '<button class="pal-b" data-i="' + i + '"><span class="pl">' + esc(c[0]) + "</span>" + esc(c[1].length > 90 ? c[1].slice(0, 88) + "…" : c[1]) + "</button>"; }).join("");
    $$("#palette .pal-b").forEach(function (b) { b.onclick = function () { runCmd(cmds[+b.getAttribute("data-i")][1]); }; });
    if (HAL) {
      HAL.term.onData(function (d) { tw(ansi(d)); });
      HAL.term.onDone(function () { /* prompt ready */ });
      tw('<div style="color:var(--muted)">halcyon terminal — your local shell. Guard at <span style="color:var(--gold)">' + BASE + "</span>. Click a command on the left, or type below.</div>");
    }
    $("#termInput").addEventListener("keydown", function (e) { if (e.key === "Enter") { var v = e.target.value; e.target.value = ""; if (v.trim()) runCmd(v); } });
  }
  $("#clrTerm").addEventListener("click", function () { $("#term").innerHTML = ""; });

  // ── toast ──────────────────────────────────────────────────────────────────
  function toast(kind, title, detail) { var e = document.createElement("div"); e.className = "toast " + kind; e.innerHTML = '<div class="tt">' + esc(title) + '</div><div class="td">' + esc(detail) + "</div>"; $("#toasts").appendChild(e); setTimeout(function () { e.style.opacity = "0"; e.style.transition = "opacity .3s"; setTimeout(function () { e.remove(); }, 300); }, 5600); }

  // ── boot ───────────────────────────────────────────────────────────────────
  async function boot() {
    if (HAL) { try { var info = await HAL.getInfo(); if (info && info.guardPort) BASE = "http://127.0.0.1:" + info.guardPort; } catch (_) {} }
    // wait for guard to answer
    for (var i = 0; i < 30; i++) { try { var h = await api("/health"); if (h && h.ok) { setInstalled(!!h.installed); break; } } catch (_) {} await sleep(300); }
    if (installed) setupTerminal();
    else $("#installBtn").classList.add("pulse");
    refreshBilling();
    setInterval(function () { if ($(".view.on") && $(".view.on").getAttribute("data-view") === "agamemnon") pollConsole(); if ($(".view.on") && $(".view.on").getAttribute("data-view") === "billing" && !$("#invCount").classList.contains("drain")) refreshBilling(); }, 2000);
  }
  boot();
})();
