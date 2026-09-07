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
  var API = "http://127.0.0.1:7420"; // Agamemnon guard — the bank holds no data itself
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return [].slice.call(document.querySelectorAll(s)); };
  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var state = { view: "records", status: "all", region: "all", q: "", offset: 0, limit: 25, selected: {}, total: 0, online: false };

  function api(path, body) {
    var opt = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
    return fetch(API + path, opt).then(function (r) { if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || r.status); }); return r.json(); });
  }

  // ── views ────────────────────────────────────────────────────────────────
  function show(view) {
    state.view = view;
    $$(".nav-i").forEach(function (n) { n.classList.toggle("on", n.getAttribute("data-view") === view); });
    $$(".view").forEach(function (v) { v.classList.toggle("on", v.getAttribute("data-view") === view); });
    $("#crumb").textContent = { dashboard: "Dashboard", records: "Account Records", audit: "Activity Log", protection: "Data Protection" }[view];
    if (view === "dashboard") loadCounts();
    if (view === "records") loadRecords();
    if (view === "audit") loadAudit();
    if (view === "protection") loadProtection();
  }
  $$("[data-view]").forEach(function (el) { el.addEventListener("click", function () { show(el.getAttribute("data-view")); }); });

  // ── protection / health ────────────────────────────────────────────────────
  function pollHealth() {
    api("/health").then(function (h) {
      state.online = true;
      var b = $("#protBadge"); b.className = "prot ok"; $("#protText").textContent = "Protected by Agamemnon";
      if (state.view === "records" && !$("#rows").children.length) loadRecords();
    }).catch(function () {
      state.online = false;
      var b = $("#protBadge"); b.className = "prot off"; $("#protText").textContent = "Agamemnon offline";
      $("#delSelected").disabled = true; $("#purgeBtn").disabled = true;
      if (state.view === "records") $("#rows").innerHTML = '<tr><td colspan="9" class="offline-cell" style="padding:34px;text-align:center;color:var(--red)">Records unavailable — the data-protection layer (Agamemnon) is offline.<br><span style="color:var(--muted);font-size:12.5px">This app holds no records of its own. Start the <b>Agamemnon</b> app to continue.</span></td></tr>';
      var pc = $("#pcStatus"); if (pc) { pc.className = "pc-status off"; pc.textContent = "● Agamemnon is OFFLINE — records cannot be read or changed."; }
    });
  }

  // ── records ────────────────────────────────────────────────────────────────
  function selector() {
    return { filter: { status: state.status, region: state.region } };
  }
  function loadRecords() {
    if (!state.online) return;
    var qs = "?status=" + state.status + "&region=" + encodeURIComponent(state.region) + "&q=" + encodeURIComponent(state.q) + "&limit=" + state.limit + "&offset=" + state.offset;
    api("/records" + qs).then(function (d) {
      state.total = d.total;
      var tb = $("#rows");
      if (!d.rows.length) { tb.innerHTML = '<tr><td colspan="9" style="padding:28px;text-align:center;color:var(--muted)">No records match this filter.</td></tr>'; }
      else tb.innerHTML = d.rows.map(function (r) {
        var chk = state.selected[r.id] ? " checked" : "";
        return '<tr class="' + (state.selected[r.id] ? "sel" : "") + '" data-id="' + r.id + '">' +
          '<td class="chk"><input type="checkbox" data-row="' + r.id + '"' + chk + '/></td>' +
          '<td class="ref">' + esc(r.ref) + '</td><td>' + esc(r.holder) + '</td><td class="acct">' + esc(r.account_no) + '</td>' +
          '<td>' + esc(r.type) + '</td><td>' + esc(r.region) + '</td><td>' + esc(r.branch) + '</td>' +
          '<td class="num">$' + esc(r.balance) + '</td><td><span class="pill ' + r.status + '">' + r.status + "</span></td></tr>";
      }).join("");
      $$("#rows [data-row]").forEach(function (c) { c.addEventListener("change", function () { toggleRow(Number(c.getAttribute("data-row")), c.checked); }); });
      var from = d.total ? state.offset + 1 : 0, to = Math.min(state.offset + state.limit, d.total);
      $("#pageInfo").textContent = "Showing " + fmt(from) + "–" + fmt(to) + " of " + fmt(d.total) + " records";
      $("#prevPage").disabled = state.offset === 0; $("#nextPage").disabled = to >= d.total;
      $("#checkAll").checked = false;
      updateSel();
      if (d.counts) paintCounts(d.counts);
    }).catch(function (e) { /* offline handled by health */ });
  }
  function toggleRow(id, on) { if (on) state.selected[id] = true; else delete state.selected[id]; var tr = $('#rows tr[data-id="' + id + '"]'); if (tr) tr.classList.toggle("sel", on); updateSel(); }
  function updateSel() { var n = Object.keys(state.selected).length; $("#selCount").textContent = n; $("#delSelected").disabled = n === 0 || !state.online; }

  $("#checkAll").addEventListener("change", function (e) {
    $$("#rows [data-row]").forEach(function (c) { c.checked = e.target.checked; toggleRow(Number(c.getAttribute("data-row")), e.target.checked); });
  });
  $("#search").addEventListener("input", function (e) { state.q = e.target.value; state.offset = 0; loadRecords(); });
  $("#regionSel").addEventListener("change", function (e) { state.region = e.target.value; state.offset = 0; loadRecords(); });
  $$("#statusSeg .sg").forEach(function (b) { b.addEventListener("click", function () { $$("#statusSeg .sg").forEach(function (x) { x.classList.remove("on"); }); b.classList.add("on"); state.status = b.getAttribute("data-f"); state.offset = 0; loadRecords(); }); });
  $("#prevPage").addEventListener("click", function () { state.offset = Math.max(0, state.offset - state.limit); loadRecords(); });
  $("#nextPage").addEventListener("click", function () { state.offset += state.limit; loadRecords(); });

  // ── deletes → the guard ────────────────────────────────────────────────────
  $("#delSelected").addEventListener("click", function () {
    var ids = Object.keys(state.selected).map(Number);
    if (!ids.length) return;
    propose({ ids: ids }, "delete " + ids.length + " selected record(s)");
  });
  $("#purgeBtn").addEventListener("click", function () {
    var label = "purge all records where status = " + state.status + (state.region !== "all" ? " and region = " + state.region : "");
    confirmModal("Purge records?", "You're about to submit a bulk deletion of <b>every record matching the current filter</b> (status: " + esc(state.status) + ", region: " + esc(state.region) + "). Agamemnon will check it before anything is removed.", function () {
      propose(selector(), label);
    });
  });

  function propose(sel, label) {
    if (!state.online) return;
    api("/guard/propose", { selector: sel, actor: "Jordan Tan (Records Intern)" }).then(function (a) {
      if (a.status === "executed") {
        toast("ok", fmt(a.actualRows) + " record(s) deleted", "Approved by policy and removed. This is reversible from the Agamemnon console.");
        state.selected = {}; loadRecords();
      } else if (a.status === "awaiting_approval") {
        toast("warn", "Held for approval", fmt(a.measuredRows) + " records — over the auto-approve threshold. A supervisor must approve this in the Agamemnon app. Nothing was deleted.");
      } else if (a.status === "blocked") {
        blockedModal(a);
      }
    }).catch(function (e) { toast("err", "Request failed", String(e.message || e)); });
  }

  // ── counts / dashboard ─────────────────────────────────────────────────────
  function paintCounts(c) {
    if ($("#kTotal")) { $("#kTotal").textContent = fmt(c.total); $("#kActive").textContent = fmt(c.active); $("#kFlagged").textContent = fmt(c.flagged); $("#kDormant").textContent = fmt(c.dormant + c.closed); }
  }
  function loadCounts() {
    api("/counts").then(function (c) {
      paintCounts(c);
      var max = c.total || 1;
      var rows = [["Active", c.active, "var(--green)"], ["Flagged", c.flagged, "var(--amber)"], ["Dormant", c.dormant, "var(--dim)"], ["Closed", c.closed, "var(--red)"]];
      $("#statusBars").innerHTML = rows.map(function (r) {
        return '<div class="bar-row"><div class="bl">' + r[0] + '</div><div class="bar-track"><div class="bar-fill" style="width:' + (r[1] / max * 100).toFixed(1) + "%;background:" + r[2] + '"></div></div><div class="bn">' + fmt(r[1]) + "</div></div>";
      }).join("");
    }).catch(function () {});
  }
  function loadAudit() {
    api("/audit?limit=80").then(function (d) {
      $("#auditLog").innerHTML = (d.audit || []).map(function (a) {
        return '<div class="log-row"><span class="log-k ' + esc(a.kind) + '">' + esc(a.kind) + '</span><span class="log-d">' + esc(a.detail) + "</span></div>";
      }).join("") || '<div class="log-row"><span class="log-d" style="color:var(--muted)">No activity yet.</span></div>';
    }).catch(function () {});
  }
  function loadProtection() {
    var pc = $("#pcStatus");
    if (state.online) { pc.className = "pc-status ok"; pc.textContent = "● Protected — Agamemnon is online and enforcing policy on every deletion."; }
    else { pc.className = "pc-status off"; pc.textContent = "● Agamemnon is OFFLINE — records cannot be read or changed."; }
  }

  // ── toast + modal ──────────────────────────────────────────────────────────
  function toast(kind, title, detail) {
    var el = document.createElement("div"); el.className = "toast " + kind;
    el.innerHTML = '<div class="tt">' + esc(title) + '</div><div class="td">' + detail + "</div>";
    $("#toasts").appendChild(el);
    setTimeout(function () { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(function () { el.remove(); }, 300); }, 5200);
  }
  function closeModal() { $("#modal").hidden = true; $("#modalCard").innerHTML = ""; }
  function confirmModal(title, body, onYes) {
    $("#modalCard").innerHTML =
      '<div class="m-h"><div class="m-ico warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg></div><div><div class="m-title">' + esc(title) + '</div><div class="m-sub">This is submitted to Agamemnon for a policy check.</div></div></div>' +
      '<div class="m-b">' + body + '</div>' +
      '<div class="m-f"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn danger" id="mYes">Submit deletion</button></div>';
    $("#modal").hidden = false;
    $("#mCancel").onclick = closeModal; $("#mYes").onclick = function () { closeModal(); onYes(); };
  }
  function blockedModal(a) {
    var v = a.classifier || {};
    var rules = (a.firedRules || []).filter(function (r) { return r.severity === "block"; });
    $("#modalCard").innerHTML =
      '<div class="m-h"><div class="m-ico block"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg></div><div><div class="m-title">Deletion blocked by Agamemnon</div><div class="m-sub">The write-path guardrail stopped this action.</div></div></div>' +
      '<div class="m-b">This deletion was <b>refused before anything was removed</b> because its blast radius is too large.' +
      '<div class="m-stat"><div class="ms"><div class="msv red">' + fmt(a.measuredRows) + '</div><div class="msl">records it would delete</div></div><div class="ms"><div class="msv">' + ((v.blast_radius || 0) * 100).toFixed(1) + '%</div><div class="msl">of the whole table</div></div><div class="ms"><div class="msv">' + (a.ratioToMedian || 0).toFixed(0) + '×</div><div class="msl">the normal amount</div></div></div>' +
      '<div class="m-rules">' + rules.map(function (r) { return '<div class="m-rule"><span class="rn">' + esc(r.name) + '</span><span class="rd">' + esc(r.detail) + "</span></div>"; }).join("") + "</div></div>" +
      '<div class="m-f"><button class="btn primary" id="mOk">Understood</button></div>';
    $("#modal").hidden = false;
    $("#mOk").onclick = closeModal;
  }
  $("#modal").addEventListener("click", function (e) { if (e.target === $("#modal")) closeModal(); });

  // ── boot ───────────────────────────────────────────────────────────────────
  pollHealth();
  setInterval(pollHealth, 2500);
  setInterval(function () { if (state.view === "audit") loadAudit(); if (state.view === "records") loadRecords(); }, 2500);
  show("records");
})();
