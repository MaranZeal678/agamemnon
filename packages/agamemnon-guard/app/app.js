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
  var API = "http://127.0.0.1:7420";
  var $ = function (s) { return document.querySelector(s); };
  var openIds = {};       // expanded cards
  var sigPending = "", sigFeed = "", sigAudit = "", sigTiles = "";

  function api(path, body) {
    var opt = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
    return fetch(API + path, opt).then(function (r) { return r.json(); });
  }
  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  function badge(status, decision) {
    var map = { blocked: ["block", "blocked"], awaiting_approval: ["await", "awaiting approval"], approved: ["exec", "approved"], executed: ["exec", "executed"], denied: ["denied", "denied"], undone: ["undone", "undone"] };
    var m = map[status] || ["allow", decision || status];
    return '<span class="badge ' + m[0] + '">' + m[1] + "</span>";
  }
  function rulesHtml(rules) {
    return (rules || []).map(function (r) {
      return '<div class="rule"><span class="sev ' + r.severity + '">' + r.severity + '</span><div><div class="rname">' + esc(r.name) + '</div><div class="rdetail">' + esc(r.detail) + "</div></div></div>";
    }).join("");
  }
  function detailHtml(a) {
    var v = a.classifier || {};
    var isBlock = a.decision === "block";
    var h = '<div><div class="dh">Proposed statement</div><div class="sqlbox">' + esc(a.sql) + "</div></div>";
    h += '<div><div class="dh">Blast radius — measured by Agamemnon</div><div class="blast"><b style="font-family:var(--mono);font-size:16px;color:' + (isBlock ? "var(--red)" : "var(--text)") + '">' + fmt(a.measuredRows) + '</b> records · <span class="pct">' + ((v.blast_radius || 0) * 100).toFixed(1) + "%</span> of the table · classifier: " + esc(v.class) + "</div></div>";
    if (isBlock) h += '<div class="doctrine"><b>The model advises. The rules decide.</b> The classifier can only raise severity, never lower it.</div>';
    h += '<div><div class="dh">Fired rules → ' + esc(String(a.decision).toUpperCase()) + "</div>" + rulesHtml(a.firedRules) + "</div>";
    if (a.status === "awaiting_approval")
      h += '<div class="actions"><input class="note-in" placeholder="note (optional)" id="note_' + a.id + '"/><button class="btn approve" data-approve="' + a.id + '">Approve</button><button class="btn deny" data-deny="' + a.id + '">Deny</button></div>';
    if (a.status === "executed")
      h += '<div class="actions"><button class="btn undo" data-undo="' + a.id + '">Undo — restore ' + fmt(a.actualRows) + " records</button></div>";
    return h;
  }
  function cardHtml(a, forcePending) {
    var cls = a.status === "blocked" ? "blocked" : a.status === "awaiting_approval" ? "await" : a.status === "executed" ? "exec" : "";
    var open = forcePending || openIds[a.id] ? " open" : "";
    return '<div class="card ' + cls + open + '" data-id="' + a.id + '">' +
      '<div class="card-h" data-toggle="' + a.id + '"><div><div class="card-actor">' + esc(a.actor) + " · #" + a.seq + '</div><div class="card-desc">' + esc(a.description) + '</div></div>' +
      '<div class="card-rows"><div class="n">' + fmt(a.measuredRows) + '</div><div class="u">records</div></div>' + badge(a.status, a.decision) + "</div>" +
      '<div class="card-body">' + detailHtml(a) + "</div></div>";
  }

  function wireCards(root) {
    root.querySelectorAll("[data-toggle]").forEach(function (el) {
      el.onclick = function () { var id = el.getAttribute("data-toggle"); openIds[id] = !openIds[id]; el.parentElement.classList.toggle("open"); };
    });
    root.querySelectorAll("[data-approve]").forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); var id = b.getAttribute("data-approve"); var n = document.getElementById("note_" + id); b.disabled = true; api("/approve", { actionId: id, note: n ? n.value : "" }).then(poll); }; });
    root.querySelectorAll("[data-deny]").forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); var id = b.getAttribute("data-deny"); var n = document.getElementById("note_" + id); b.disabled = true; api("/deny", { actionId: id, note: n ? n.value : "" }).then(poll); }; });
    root.querySelectorAll("[data-undo]").forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); b.disabled = true; api("/undo", { actionId: b.getAttribute("data-undo") }).then(poll); }; });
  }

  function renderPending(list) {
    var sig = list.map(function (a) { return a.id; }).join(",");
    if (sig === sigPending) return; sigPending = sig;
    var el = $("#pending");
    el.innerHTML = list.map(function (a) { return cardHtml(a, true); }).join("");
    wireCards(el);
  }
  function renderFeed(list) {
    var pendingIds = {};
    var sig = list.map(function (a) { return a.id + a.status; }).join(",");
    if (sig === sigFeed) return; sigFeed = sig;
    var el = $("#feed");
    el.innerHTML = list.filter(function (a) { return a.status !== "awaiting_approval"; }).map(function (a) { return cardHtml(a, false); }).join("");
    wireCards(el);
    $("#feedEmpty").style.display = list.length ? "none" : "block";
  }
  function renderAudit(list) {
    var sig = list.length + ":" + (list[0] ? list[0].at : 0);
    if (sig === sigAudit) return; sigAudit = sig;
    $("#audit").innerHTML = list.map(function (a) {
      return '<div class="aud"><span class="k ' + esc(a.kind) + '">' + esc(a.kind) + '</span><span class="d">' + esc(a.detail) + "</span></div>";
    }).join("");
    $("#auditCount").textContent = list.length ? list.length + " recent events" : "";
  }
  function renderTiles(s) {
    var sig = [s.protected, s.blocked, s.held, s.executed].join(",");
    if (sig === sigTiles) return; sigTiles = sig;
    $("#tProtected").textContent = fmt(s.protected);
    $("#tBlocked").textContent = fmt(s.blocked);
    $("#tHeld").textContent = fmt(s.held);
    $("#tExecuted").textContent = fmt(s.executed);
  }

  function setGuard(ok, text, enforcement) {
    var pill = $("#guardPill");
    pill.className = "guard-pill " + (ok ? (enforcement ? "ok" : "off") : "off");
    $("#guardText").textContent = text;
    $("#enfToggle").checked = !!enforcement;
  }

  var failCount = 0;
  function poll() {
    return Promise.all([api("/stats"), api("/feed?limit=14"), api("/pending"), api("/audit?limit=70")])
      .then(function (r) {
        failCount = 0;
        var stats = r[0], feed = r[1].feed || [], pending = r[2].pending || [], audit = r[3].audit || [];
        setGuard(true, "guard active · :7420 · " + fmt(stats.protected) + " records", stats.enforcement);
        renderTiles(stats); renderPending(pending); renderFeed(feed); renderAudit(audit);
      })
      .catch(function () { failCount++; if (failCount > 1) setGuard(false, "guard server unreachable", false); });
  }

  $("#enfToggle").addEventListener("change", function (e) { api("/enforcement", { on: e.target.checked }).then(poll); });
  $("#resetBtn").addEventListener("click", function () { api("/reset", {}).then(function () { sigFeed = sigPending = sigAudit = sigTiles = ""; poll(); }); });

  poll();
  setInterval(poll, 900);
})();
