(function () {
  "use strict";
  var BASE = "http://127.0.0.1:7420";
  var qp = new URLSearchParams(location.search); if (qp.get("guard")) BASE = "http://127.0.0.1:" + qp.get("guard");
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return [].slice.call(document.querySelectorAll(s)); };
  var fmt = function (n) { return Number(n || 0).toLocaleString(); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  function api(p, body) { var o = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}; return fetch(BASE + p, o).then(function (r) { return r.json(); }); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} }

  // ── views ──────────────────────────────────────────────────────────────
  function show(v) {
    $$(".nav-i").forEach(function (n) { n.classList.toggle("on", n.getAttribute("data-view") === v); });
    $$(".view").forEach(function (s) { s.classList.toggle("on", s.getAttribute("data-view") === v); });
    $("#crumb").textContent = { overview: "Overview", decisions: "Live decisions", database: "Database", terminal: "Terminal", integrations: "Integrations", policy: "Policy", audit: "Audit log", account: "Account" }[v];
    if (v === "database") loadDatabase();
    if (v === "audit") loadAudit();
    if (v === "policy") renderRules();
    if (v === "terminal") $("#termInput").focus();
  }
  $$(".nav-i").forEach(function (n) { n.addEventListener("click", function () { show(n.getAttribute("data-view")); }); });

  // ── decision cards ──────────────────────────────────────────────────────
  var openIds = {};
  function badge(st) { var m = { blocked: ["block", "blocked"], awaiting_approval: ["await", "awaiting approval"], approved: ["exec", "approved"], executed: ["exec", "executed"], denied: ["logged", "denied"], undone: ["logged", "undone"] }[st] || ["logged", st]; return '<span class="badge ' + m[0] + '">' + m[1] + "</span>"; }
  function detail(a) {
    var h = '<div><div class="dh">Proposed statement</div><div class="sqlbox">' + esc(a.sql) + "</div></div>";
    h += '<div><div class="dh">Blast radius (measured)</div><div style="font-size:12.5px;color:var(--muted)"><b style="font-family:var(--mono);color:' + (a.decision === "block" ? "var(--red)" : "var(--text)") + '">' + fmt(a.measuredRows) + "</b> rows · " + (((a.classifier || {}).blast_radius || 0) * 100).toFixed(1) + "% · classifier: " + esc((a.classifier || {}).class) + "</div></div>";
    h += '<div><div class="dh">Fired rules → ' + esc(String(a.decision).toUpperCase()) + "</div>" + (a.firedRules || []).map(function (r) { return '<div class="rule"><span class="sev ' + r.severity + '">' + r.severity + '</span><div><div class="rname">' + esc(r.name) + '</div><div class="rdetail">' + esc(r.detail) + "</div></div></div>"; }).join("") + "</div>";
    if (a.status === "awaiting_approval") h += '<div class="actions"><button class="btn approve" data-ap="' + a.id + '">Approve</button><button class="btn deny" data-dn="' + a.id + '">Deny</button></div>';
    if (a.status === "executed") h += '<div class="actions"><button class="btn undo" data-un="' + a.id + '">Undo — restore ' + fmt(a.actualRows) + " rows</button></div>";
    return h;
  }
  function card(a, o) { var cls = a.status === "blocked" ? "blocked" : a.status === "awaiting_approval" ? "await" : a.status === "executed" ? "exec" : ""; return '<div class="card ' + cls + (o || openIds[a.id] ? " open" : "") + '"><div class="card-h" data-tg="' + a.id + '"><div><div class="card-actor">' + esc(a.actor) + " · #" + a.seq + '</div><div class="card-desc">' + esc(a.description) + '</div></div><div class="card-rows"><div class="n">' + fmt(a.measuredRows) + '</div><div class="u">rows</div></div>' + badge(a.status) + '</div><div class="card-b">' + detail(a) + "</div></div>"; }
  function wire(root) {
    root.querySelectorAll("[data-tg]").forEach(function (e) { e.onclick = function () { var id = e.getAttribute("data-tg"); openIds[id] = !openIds[id]; e.parentElement.classList.toggle("open"); }; });
    root.querySelectorAll("[data-ap]").forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); b.disabled = true; api("/approve", { actionId: b.getAttribute("data-ap"), note: "" }).then(poll); }; });
    root.querySelectorAll("[data-dn]").forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); b.disabled = true; api("/deny", { actionId: b.getAttribute("data-dn"), note: "" }).then(poll); }; });
    root.querySelectorAll("[data-un]").forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); b.disabled = true; api("/undo", { actionId: b.getAttribute("data-un") }).then(poll); }; });
  }

  // ── poll ────────────────────────────────────────────────────────────────
  var sigF = "", sigP = "", sigT = "", sigO = "", fails = 0;
  function poll() {
    Promise.all([api("/stats"), api("/feed?limit=14"), api("/pending")]).then(function (r) {
      fails = 0; var s = r[0], feed = r[1].feed || [], pend = r[2].pending || [];
      $("#guardPill").className = "guardpill ok"; $("#guardText").textContent = "guard active · " + fmt(s.protected) + " rows";
      var ts = [s.protected, s.blocked, s.held, s.executed].join(",");
      if (ts !== sigT) { sigT = ts; $("#oProtected").textContent = fmt(s.protected); $("#oBlocked").textContent = fmt(s.blocked); $("#oHeld").textContent = fmt(s.held); $("#oExecuted").textContent = fmt(s.executed); $("#enfToggle").checked = !!s.enforcement; }
      var ps = pend.map(function (a) { return a.id; }).join(","); if (ps !== sigP) { sigP = ps; $("#pending").innerHTML = pend.map(function (a) { return card(a, true); }).join(""); wire($("#pending")); }
      var fs = feed.map(function (a) { return a.id + a.status; }).join(","); if (fs !== sigF) { sigF = fs; $("#feed").innerHTML = feed.filter(function (a) { return a.status !== "awaiting_approval"; }).map(function (a) { return card(a, false); }).join(""); wire($("#feed")); $("#feedEmpty").style.display = feed.length ? "none" : "block";
        $("#oFeed").innerHTML = feed.slice(0, 5).map(function (a) { return '<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--line)"><span style="font-family:var(--mono);font-size:11px;color:var(--muted)">' + esc(a.actor) + '</span><span style="font-size:12.5px">' + esc(a.description) + "</span>" + badge(a.status) + "</div>"; }).join("") || '<div class="muted">No decisions yet.</div>'; }
    }).catch(function () { fails++; if (fails > 1) { $("#guardPill").className = "guardpill off"; $("#guardText").textContent = "guard unreachable"; } });
  }

  // ── database ────────────────────────────────────────────────────────────
  var COLS = ["ref", "holder", "customer", "account_no", "plan", "type", "region", "branch", "amount", "balance", "status"];
  function loadDatabase() {
    api("/counts").then(function (c) {
      $("#dbStats").innerHTML = Object.keys(c).map(function (k) { return '<div class="db-stat"><b>' + fmt(c[k]) + "</b><small>" + esc(k) + "</small></div>"; }).join("");
    }).catch(function () {});
    api("/records?limit=18").then(function (d) {
      var rows = d.rows || []; if (!rows.length) { $("#dbHead").innerHTML = ""; $("#dbRows").innerHTML = '<tr><td style="padding:20px;color:var(--red)">Table empty.</td></tr>'; return; }
      var cols = COLS.filter(function (k) { return k in rows[0]; });
      $("#dbHead").innerHTML = "<tr>" + cols.map(function (k) { return "<th>" + esc(k) + "</th>"; }).join("") + "</tr>";
      $("#dbRows").innerHTML = rows.map(function (r) { return "<tr>" + cols.map(function (k) { if (k === "status") return '<td><span class="dstat ' + r[k] + '">' + esc(r[k]) + "</span></td>"; if (k === "amount" || k === "balance") return '<td>$' + esc(r[k]) + "</td>"; return "<td>" + esc(r[k]) + "</td>"; }).join("") + "</tr>"; }).join("");
    }).catch(function () {});
  }

  // ── audit + policy ──────────────────────────────────────────────────────
  function loadAudit() { api("/audit?limit=100").then(function (d) { $("#audit").innerHTML = (d.audit || []).map(function (a) { return '<div class="aud"><span class="k ' + esc(a.kind) + '">' + esc(a.kind) + '</span><span class="d">' + esc(a.detail) + "</span></div>"; }).join("") || '<div class="aud"><span class="d muted">No activity yet.</span></div>"'; }).catch(function () {}); }
  var RULES = [
    ["block", "destructive-over-hard-cap", "A destructive change over the hard row cap is refused outright."],
    ["block", "exceeds-20x-median", "Over 20× the agent's normal amount is refused."],
    ["approval", "exceeds-5x-median", "Between 5× and 20× normal needs a human."],
    ["approval", "destructive-over-threshold", "Above the per-action row threshold needs approval."],
    ["approval", "blast-radius-high", "Classifier flags near-whole-table changes for a human."],
    ["block", "destructive-budget-exhausted", "A session can only delete so much before it's cut off."],
  ];
  function renderRules() { $("#rulesList").innerHTML = RULES.map(function (r) { return '<div class="rulerow"><div><div class="rr-name">' + r[1] + '</div><div class="rr-desc">' + r[2] + '</div></div><span class="rr-sev ' + r[0] + '">' + r[0] + "</span></div>"; }).join(""); }
  $("#enfToggle").addEventListener("change", function (e) { api("/enforcement", { on: e.target.checked }).then(poll); });
  $("#resetBtn").addEventListener("click", function () { api("/reset", {}).then(function () { sigF = sigP = sigT = ""; poll(); loadDatabase(); toast("ok", "Data reset", "The protected table was restored."); }); });

  // ── terminal (runs real commands against the guard) ─────────────────────
  function tw(html) { var t = $("#term"); t.insertAdjacentHTML("beforeend", html); t.scrollTop = t.scrollHeight; }
  function tline(s, cls) { tw('<div class="' + (cls || "") + '">' + s + "</div>"); }
  function tjson(o) { tw("<div>" + esc(JSON.stringify(o, null, 2)) + "</div>"); }
  async function runTerm(raw) {
    var cmd = raw.trim(); if (!cmd) return;
    tw('<div class="cmd"><span class="p">$</span> ' + esc(cmd) + "</div>");
    var a = cmd.split(/\s+/);
    try {
      if (a[0] === "help") { ["health — guard status", "stats — decision tallies", "records [status] — list rows", "guard delete all — propose deleting everything (blocked)", "guard delete <status> — e.g. flagged / abandoned", "guard delete ids <a,b,c> — delete specific rows", "approve <id> / deny <id> / undo <id>", "enforcement on|off", "reset — restore data", "clear"].forEach(function (l) { tline("  " + esc(l), "t-sys"); }); return; }
      if (a[0] === "clear") { $("#term").innerHTML = ""; return; }
      if (a[0] === "health") { tjson(await api("/health")); return; }
      if (a[0] === "stats") { tjson(await api("/stats")); return; }
      if (a[0] === "records") { var d = await api("/records?limit=6" + (a[1] ? "&status=" + encodeURIComponent(a[1]) : "")); (d.rows || []).forEach(function (r) { tline("  " + esc((r.ref || r.id) + "  " + (r.holder || r.customer || "") + "  [" + r.status + "]"), "t-sys"); }); tline("  " + fmt(d.total) + " match", "t-sys"); return; }
      if (a[0] === "enforcement") { var on = a[1] !== "off"; await api("/enforcement", { on: on }); tline("enforcement " + (on ? "ON" : "OFF"), "t-ok"); poll(); return; }
      if (a[0] === "reset") { await api("/reset", {}); tline("data reset.", "t-ok"); poll(); loadDatabase(); return; }
      if (a[0] === "approve" || a[0] === "deny") { if (!a[1]) { tline("usage: " + a[0] + " <id>", "t-err"); return; } var rr = await api("/" + a[0], { actionId: a[1], note: "via console" }); tline((a[0] === "approve" ? "approved" : "denied") + " " + a[1] + " → " + rr.status, "t-ok"); poll(); return; }
      if (a[0] === "undo") { if (!a[1]) { tline("usage: undo <id>", "t-err"); return; } var u = await api("/undo", { actionId: a[1] }); tline("restored " + fmt(u.restored) + " rows.", "t-ok"); poll(); loadDatabase(); return; }
      if (a[0] === "guard" && a[1] === "delete") {
        var sel;
        if (a[2] === "all") sel = { all: true };
        else if (a[2] === "ids") sel = { ids: (a[3] || "").split(",").map(Number).filter(Boolean) };
        else if (a[2]) sel = { filter: { status: a[2] } };
        else { tline("usage: guard delete all | <status> | ids <a,b>", "t-err"); return; }
        var res = await api("/guard/propose", { selector: sel, actor: "console" });
        var color = res.decision === "block" ? "t-blk" : res.decision === "approval" ? "t-gold" : "t-ok";
        tline("<< " + res.decision.toUpperCase() + " · measured " + fmt(res.measuredRows) + " rows · " + res.status, color);
        (res.firedRules || []).forEach(function (r) { tline("   [" + r.severity + "] " + esc(r.name) + " — " + esc(r.detail), "t-sys"); });
        if (res.status === "awaiting_approval" || res.status === "executed") tline("   id: " + res.id, "t-sys");
        poll(); loadDatabase(); return;
      }
      tline("unknown command: " + esc(a[0]) + "  (type 'help')", "t-err");
    } catch (e) { tline("error: " + esc(e.message || e), "t-err"); }
  }
  $("#termInput").addEventListener("keydown", function (e) { if (e.key === "Enter") { var v = e.target.value; e.target.value = ""; runTerm(v); } });
  $("#clrTerm").addEventListener("click", function () { $("#term").innerHTML = ""; });
  (function () {
    $("#termMode").textContent = "· running against " + BASE;
    var chips = ["health", "guard delete all", "guard delete flagged", "stats", "reset"];
    $("#termChips").innerHTML = chips.map(function (c) { return '<button class="tchip">' + esc(c) + "</button>"; }).join("");
    $$("#termChips .tchip").forEach(function (b) { b.onclick = function () { $("#termInput").value = b.textContent; runTerm(b.textContent); $("#termInput").value = ""; }; });
    tline("Agamemnon console. Commands run against the guard at " + esc(BASE) + ". Type 'help'.", "t-sys");
  })();

  // ── GitHub integration (real) ───────────────────────────────────────────
  function ghHeaders(t) { return { Authorization: "Bearer " + t, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }; }
  function setGh(profile) {
    if (profile) {
      $("#ghChipInner").innerHTML = '<img src="' + esc(profile.avatar_url) + '"/> ' + esc(profile.login);
      $("#ghAction").innerHTML = '<span style="color:var(--green);font-size:12.5px;font-weight:600">Connected</span>';
      $("#ghConnected").hidden = false;
      $("#ghAvatar").src = profile.avatar_url; $("#ghLogin").textContent = profile.name || profile.login;
      $("#ghMeta").textContent = "@" + profile.login + " · " + fmt(profile.public_repos) + " public repos";
      $("#ghDesc").textContent = "Connected as @" + profile.login + ".";
      $("#accountBody").innerHTML = '<div class="acct-row"><img src="' + esc(profile.avatar_url) + '"/><div><div class="acct-name">' + esc(profile.name || profile.login) + '</div><div class="acct-sub">@' + esc(profile.login) + " · signed in with GitHub</div></div></div>";
      loadRepos();
    } else {
      $("#ghChipInner").textContent = "Connect GitHub";
      $("#ghAction").innerHTML = '<button class="btn primary" id="ghConnect">Connect</button>'; $("#ghConnect").onclick = openGh;
      $("#ghConnected").hidden = true;
      $("#ghDesc").textContent = "Link a repository so Agamemnon can guard its write path.";
      $("#accountBody").innerHTML = '<div class="muted">Connect GitHub in Integrations to sign in with your GitHub identity.</div>';
    }
  }
  function loadRepos() {
    var t = ls("gh_token"); if (!t) return;
    fetch("https://api.github.com/user/repos?per_page=8&sort=updated&affiliation=owner", { headers: ghHeaders(t) }).then(function (r) { return r.json(); }).then(function (repos) {
      if (!Array.isArray(repos)) return;
      $("#ghRepoCount").textContent = "· newest " + repos.length;
      var guarded = JSON.parse(ls("gh_guarded") || "{}");
      $("#ghRepos").innerHTML = repos.map(function (r) {
        var on = guarded[r.full_name];
        return '<div class="repo"><div><div class="repo-name">' + esc(r.full_name.split("/")[0]) + "/<b>" + esc(r.name) + "</b>" + (r.private ? " · private" : "") + '</div><div class="repo-desc">' + esc(r.description || "no description") + '</div></div><div class="repo-right"><span class="repo-lang">' + esc(r.language || "") + '</span><button class="guard-toggle' + (on ? " on" : "") + '" data-repo="' + esc(r.full_name) + '">' + (on ? "● guarded" : "guard writes") + "</button></div></div>";
      }).join("");
      $$("#ghRepos .guard-toggle").forEach(function (b) { b.onclick = function () { var g = JSON.parse(ls("gh_guarded") || "{}"); var k = b.getAttribute("data-repo"); if (g[k]) delete g[k]; else g[k] = true; ls("gh_guarded", JSON.stringify(g)); loadRepos(); toast("ok", g[k] ? "Guarding " + k : "Unguarded " + k, g[k] ? "Agamemnon now reviews writes to this repo." : "Removed from the write-path guard."); }; });
    }).catch(function () {});
  }
  function openGh() { $("#ghErr").hidden = true; $("#ghToken").value = ""; $("#ghModal").hidden = false; setTimeout(function () { $("#ghToken").focus(); }, 50); }
  function closeGh() { $("#ghModal").hidden = true; }
  $("#ghChip").addEventListener("click", function () { if (ls("gh_token")) show("integrations"); else openGh(); });
  $("#ghCancel").addEventListener("click", closeGh);
  $("#ghModal").addEventListener("click", function (e) { if (e.target === $("#ghModal")) closeGh(); });
  $("#ghSubmit").addEventListener("click", function () {
    var t = $("#ghToken").value.trim(); if (!t) return;
    $("#ghSubmit").disabled = true; $("#ghErr").hidden = true;
    fetch("https://api.github.com/user", { headers: ghHeaders(t) }).then(function (r) { if (!r.ok) throw new Error(r.status === 401 ? "Invalid token." : "GitHub error " + r.status); return r.json(); })
      .then(function (p) { ls("gh_token", t); ls("gh_profile", JSON.stringify({ login: p.login, name: p.name, avatar_url: p.avatar_url, public_repos: p.public_repos })); $("#ghSubmit").disabled = false; closeGh(); setGh(JSON.parse(ls("gh_profile"))); toast("ok", "GitHub connected", "Signed in as @" + p.login + "."); })
      .catch(function (e) { $("#ghSubmit").disabled = false; $("#ghErr").hidden = false; $("#ghErr").textContent = e.message || String(e); });
  });
  document.addEventListener("click", function (e) { if (e.target && e.target.id === "ghConnect") openGh(); if (e.target && e.target.id === "ghDisconnect") { ls("gh_token", null); ls("gh_profile", null); setGh(null); toast("ok", "Disconnected", "GitHub was unlinked from this console."); } });

  function toast(kind, title, detail) { var e = document.createElement("div"); e.className = "toast " + kind; e.innerHTML = '<div class="tt">' + esc(title) + '</div><div class="td">' + esc(detail) + "</div>"; $("#toasts").appendChild(e); setTimeout(function () { e.style.opacity = "0"; e.style.transition = "opacity .3s"; setTimeout(function () { e.remove(); }, 300); }, 5000); }

  // ── boot ─────────────────────────────────────────────────────────────────
  var savedGh = ls("gh_profile"); setGh(savedGh ? JSON.parse(savedGh) : null);
  poll(); setInterval(poll, 1200);
})();
