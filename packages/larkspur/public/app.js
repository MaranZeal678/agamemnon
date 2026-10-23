/*
 * Larkspur Operations — dashboard client. Polls /api/state; every action goes
 * to the server, which drives the real Agamemnon broker and sandboxes.
 */

const PAGES = {
  overview: { title: "Overview", sub: "Three merchants build on Larkspur's APIs. Larkspur runs AI agents for support, data hygiene and engineering, and hosts merchant plugins in mini-sandboxes." },
  runbook: { title: "Agent runbook", sub: "What Larkspur's agents and plugins try to do. Each scene goes through the real broker or sandbox supervisor; nothing here decides the outcome." },
  decisions: { title: "Decisions", sub: "Everything Agamemnon measured, held, parked or refused. Approve as Dana or Eli — Priya owns the agents, so she cannot approve their work." },
  sandboxes: { title: "Mini-sandboxes", sub: "New in Gen 2: untrusted code runs in QuickJS-Wasm enclaves with no ambient authority. Its only way out is a syscall the supervisor checks." },
  activity: { title: "Activity", sub: "The broker's hash-chained audit log, and every call that actually reached the outside world." },
  operators: { title: "Operators", sub: "Sign in to the Agamemnon console with one of these tokens. They are generated fresh on every reset." },
};
const GROUPS = {
  commerce: { title: "Commerce operations", sub: "Money, customers and the orders table" },
  platform: { title: "Developer platform", sub: "The storefront-api repo, CI, infrastructure and alerting" },
  sandbox: { title: "Mini-sandboxes", sub: "Plugins, generated code and agent swarms — untrusted by default", badge: "New in Gen 2" },
};

let S = null;
let page = "overview";
const openDetails = new Set();
const running = new Set();

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (cents) => (Number(cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const n = (v) => Number(v ?? 0).toLocaleString("en-US");
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
const label = (s) => ({ awaiting_approval: "awaiting approval", ok: "ran", killed: "killed", error: "stopped" })[s] ?? s;
const pill = (s) => `<span class="pill s-${esc(s)}">${esc(label(s))}</span>`;

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = err ? "on err" : "on";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ""), err ? 6000 : 3000);
}

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error ?? `HTTP ${r.status}`);
    e.rule = j.rule;
    throw e;
  }
  return j;
}

async function refresh() {
  try {
    S = await api("/api/state");
    $("#guard-pill").className = "guard-pill";
    $("#guard-pill").innerHTML = '<span class="dot"></span> Guarded by Agamemnon';
    render();
  } catch {
    $("#guard-pill").className = "guard-pill off";
    $("#guard-pill").innerHTML = '<span class="dot"></span> Dashboard offline';
  }
}

// --- actions -----------------------------------------------------------------------

async function runScene(id) {
  running.add(id);
  render();
  try {
    const r = await api(`/api/scenes/${id}/run`, {});
    if (r.error) toast(r.error, true);
  } catch (e) {
    toast(e.message, true);
  } finally {
    running.delete(id);
    await refresh();
  }
}

async function act(effectId, action, as, force = false) {
  try {
    const r = await api(`/api/effects/${effectId}/${action}`, { as, force });
    toast(action === "approve" && r.approvalState === "pending" ? `Approved by ${as} — one more approver needed` : `${action} → ${r.status ?? "done"}`);
  } catch (e) {
    if (action === "undo" && e.rule === "has-dependents") {
      if (confirm(`${e.message}\n\nUndo anyway?`)) return act(effectId, action, as, true);
    } else toast(e.message, true);
  }
  await refresh();
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-run],[data-act],[data-copy]");
  if (!b) return;
  if (b.dataset.run) runScene(b.dataset.run);
  if (b.dataset.act) act(b.dataset.effect, b.dataset.act, b.dataset.as);
  if (b.dataset.copy) navigator.clipboard.writeText(b.dataset.copy).then(() => toast("Token copied"));
});
document.addEventListener("toggle", (ev) => {
  const d = ev.target;
  if (d.tagName !== "DETAILS" || !d.dataset.key) return;
  if (d.open) openDetails.add(d.dataset.key);
  else openDetails.delete(d.dataset.key);
}, true);
$("#reset").addEventListener("click", async () => {
  if (!confirm("Reset Larkspur? Reseeds the database and starts a fresh broker (new operator tokens).")) return;
  $("#reset").disabled = true;
  try {
    await api("/api/reset", {});
    toast("Fresh world — database reseeded, broker restarted");
  } catch (e) {
    toast(e.message, true);
  }
  $("#reset").disabled = false;
  await refresh();
});
window.addEventListener("hashchange", () => {
  page = (location.hash.replace(/^#\//, "") || "overview").split("?")[0];
  if (!PAGES[page]) page = "overview";
  render();
  scrollTo(0, 0);
});

// --- pieces --------------------------------------------------------------------------

function effectCard(e, opts = {}) {
  const rules = (e.firedRules ?? []).map((r) => `<span class="rule ${esc(r.severity)}" title="${esc(r.detail)}">${esc(r.name)}</span>`).join("");
  const counts = Object.entries(e.counts ?? {}).map(([k, v]) => `${n(v)} ${k}`).join(" · ");
  const approvals = e.approvals ?? [];
  let actions = "";
  if (e.status === "awaiting_approval") {
    const done = approvals.filter((a) => a.decision === "approve").map((a) => a.approver);
    actions = `<div class="actions">
      ${["dana", "eli"].map((p) => (done.includes(p) ? `<span class="muted">✓ ${p}</span>` : `<button class="btn gold small" data-act="approve" data-as="${p}" data-effect="${e.id}">Approve as ${p[0].toUpperCase() + p.slice(1)}</button>`)).join("")}
      <button class="btn danger small" data-act="deny" data-as="dana" data-effect="${e.id}">Deny</button>
      <span class="muted">${e.requiredApprovals > 1 ? `needs ${e.requiredApprovals} different people` : "needs one approver"}</span>
    </div>`;
  } else if (e.status === "held") {
    const left = e.holdUntil ? Math.max(0, Math.round((e.holdUntil - Date.now()) / 1000)) : 0;
    actions = `<div class="actions"><button class="btn dark small" data-act="cancel" data-as="dana" data-effect="${e.id}">Cancel</button><span class="muted">runs in ${left}s unless cancelled</span></div>`;
  } else if (e.status === "executed" && opts.undo !== false && e.reversibility && e.reversibility !== "irreversible" && !String(e.operation).startsWith("postgres.query")) {
    actions = `<div class="actions"><button class="btn dark small" data-act="undo" data-as="dana" data-effect="${e.id}">Undo</button><span class="muted">${esc(e.reversibility)}</span></div>`;
  }
  return `<div class="effect">
    <div class="effect-top">
      <div><div class="op">${esc(e.operation)}</div><div class="meta">${esc(e.agent)}${e.tenant ? ` · tenant ${esc(e.tenant)}` : ""}${e.env ? ` · ${esc(e.env)}` : ""} · ${ago(e.createdAt)}</div></div>
      ${pill(e.status)}
    </div>
    <div class="summary">${esc(e.summary)}</div>
    ${counts || e.reversibility ? `<div class="meta">${counts ? `measured: ${esc(counts)}` : ""}${e.reversibility ? `${counts ? " · " : ""}reversibility: ${esc(e.reversibility)}` : ""}</div>` : ""}
    ${rules ? `<div class="rules">${rules}</div>` : ""}
    ${e.error ? `<div class="meta">${esc(e.error)}</div>` : ""}
    ${actions}
  </div>`;
}

function sandboxBlock(s, key) {
  const r = s.result;
  const status = r.killed ? "killed" : r.success ? "ok" : "error";
  return `<div class="sbx">
    <div class="row">${pill(status)} <span class="mono">${esc(s.label)}</span> <span class="k">${n(r.executionTimeMs)} ms · ${r.proposals.length} proposal(s)${s.tainted ? " · tainted by an untrusted message" : ""}</span></div>
    ${r.killed ? `<div class="kill">${esc(r.killed)}</div>` : ""}
    ${!r.killed && r.error ? `<div class="kill">${esc(r.error)}</div>` : ""}
    ${r.logs.length ? `<div class="log">${r.logs.map(esc).join("\n")}</div>` : ""}
    ${r.success ? `<details data-key="${key}-data"${openDetails.has(`${key}-data`) ? " open" : ""}><summary>Returned value</summary><pre>${esc(JSON.stringify(r.data, null, 2))}</pre></details>` : ""}
  </div>`;
}

function sceneCard(sc) {
  const last = sc.last;
  const isRunning = running.has(sc.id);
  let out = "";
  if (last) {
    const matched = JSON.stringify(last.outcomes) === JSON.stringify(sc.expect);
    out = `<div class="outcome">
      <div class="steps">${last.outcomes.map(pill).join('<span class="k">→</span>')} <span class="expect">${ago(last.at)}</span></div>
      ${last.error ? `<div class="mismatch">${esc(last.error)}</div>` : ""}
      ${!matched && !last.error ? `<div class="mismatch">Expected ${esc(sc.expect.map(label).join(" → "))}</div>` : ""}
      <div class="headline">${esc(last.headline)}</div>
      ${(last.notes ?? []).map((t) => `<div class="note">${esc(t)}</div>`).join("")}
      ${(last.sandbox ?? []).map((s, i) => sandboxBlock(s, `${sc.id}-${i}`)).join("")}
      ${last.effects.length ? `<a href="#/decisions" class="k">${last.effects.length} effect(s) in Decisions →</a>` : ""}
    </div>`;
  }
  return `<div class="card scene">
    <div class="scene-top">
      <div><div class="actor">${esc(sc.actor)}</div><h3>${esc(sc.title)}</h3></div>
      <button class="btn small" data-run="${sc.id}" ${isRunning ? "disabled" : ""}>${isRunning ? "Running…" : last ? "Run again" : "Run"}</button>
    </div>
    <p class="intent">${esc(sc.intent)}</p>
    <p class="risk">${esc(sc.risk)}</p>
    ${sc.code ? `<details data-key="${sc.id}-code"${openDetails.has(`${sc.id}-code`) ? " open" : ""}><summary>Sandbox code</summary><pre>${esc(sc.code)}</pre></details>` : ""}
    ${out}
  </div>`;
}

// --- pages -----------------------------------------------------------------------------

function overview() {
  const a = S.agamemnon;
  const t = a.tally;
  const merchants = S.company
    .map(
      (m) => `<div class="card">
      <div class="merchant-head"><h3>${esc(m.name)}</h3><span class="plan">${esc(m.plan)}</span></div>
      <div class="k mono">${esc(m.id)}</div>
      <div class="kpis">
        <div class="kpi"><div class="v">${n(m.orders)}</div><div class="l">orders</div></div>
        <div class="kpi"><div class="v">${usd(m.revenueCents)}</div><div class="l">paid & shipped</div></div>
        <div class="kpi"><div class="v">${n(m.abandoned)}</div><div class="l">abandoned carts</div></div>
        <div class="kpi"><div class="v">${n(m.refunded)}</div><div class="l">refunded orders</div></div>
        <div class="kpi"><div class="v">${n(m.loyaltyPoints)}</div><div class="l">loyalty points (plugin)</div></div>
        <div class="kpi"><div class="v">${n(m.notes)}</div><div class="l">orders with notes</div></div>
      </div>
    </div>`,
    )
    .join("");
  const p = S.platform;
  return `
    <div class="section-h"><h2>Merchants</h2><p>Live from Larkspur's Postgres</p></div>
    <div class="grid g3">${merchants}</div>
    <div class="section-h"><h2>Platform</h2><p>What the agents could break</p></div>
    <div class="grid g3">
      <div class="card"><h3>storefront-api</h3><div class="k">Test files in the repo</div>
        <ul class="list">${p.tests.map((f) => `<li><span class="mono">tests/${esc(f)}</span><span class="r">present</span></li>`).join("") || '<li class="empty">no tests left</li>'}</ul></div>
      <div class="card"><h3>Money & messages</h3><div class="k">What actually left Larkspur</div>
        <ul class="list">
          <li><span>Stripe refunds issued</span><span class="r">${p.refunds.length ? p.refunds.map((r) => `${esc(r.pi)} ${usd(r.cents)}`).join(", ") : "none"}</span></li>
          <li><span>Emails delivered</span><span class="r">${n(p.emailsSent)}</span></li>
          <li><span>Datadog monitors muted</span><span class="r">${p.mutedMonitors.length ? p.mutedMonitors.map(esc).join(", ") : "none"}</span></li>
        </ul></div>
      <div class="agm"><div class="agm-brand">Agamemnon · this session</div>
        <div class="tally">
          <div class="t"><div class="v">${n(t.executed)}</div><div class="l">executed</div></div>
          <div class="t"><div class="v">${n((t.awaiting_approval ?? 0) + (t.held ?? 0))}</div><div class="l">held or waiting</div></div>
          <div class="t"><div class="v">${n(t.blocked)}</div><div class="l">blocked</div></div>
          <div class="t"><div class="v">${n(a.violations.length)}</div><div class="l">sandbox kills</div></div>
        </div>
        <p class="muted" style="margin:12px 0 0">Audit chain ${a.chain.ok ? `verified (${n(a.chain.checked)} rows)` : "BROKEN"} · mode ${esc(a.mode)}</p>
        <p style="margin:12px 0 0"><a class="btn gold small" href="#/runbook">Open the runbook →</a></p>
      </div>
    </div>`;
}

function runbook() {
  return Object.entries(GROUPS)
    .map(([g, meta]) => {
      const cards = S.scenes.filter((s) => s.group === g).map(sceneCard).join("");
      return `<div class="section-h"><h2>${esc(meta.title)}</h2><p>${esc(meta.sub)}</p>${meta.badge ? `<span class="new" style="margin-left:0">${esc(meta.badge)}</span>` : ""}</div><div class="grid g2">${cards}</div>`;
    })
    .join("");
}

function decisions() {
  const all = S.agamemnon.effects;
  const open = all.filter((e) => e.status === "awaiting_approval" || e.status === "held");
  const blocked = all.filter((e) => e.status === "blocked" || e.status === "denied");
  const done = all.filter((e) => !open.includes(e) && !blocked.includes(e));
  const col = (title, sub, list, empty) => `<div class="agm"><div class="agm-brand">${esc(title)}</div><p class="muted" style="margin:4px 0 12px">${esc(sub)}</p>${list.length ? list.map((e) => effectCard(e)).join("") : `<div class="empty">${esc(empty)}</div>`}</div>`;
  return `<div class="grid" style="gap:16px">
    ${col("Waiting on a human", "Parked for approval, or held in a cancel window", open, "Nothing waiting. Run a scene from the runbook.")}
    <div class="grid g2">
      ${col("Refused", "Blocked by policy, or denied by an operator", blocked, "Nothing refused yet.")}
      ${col("Ran", "Executed, reverted or cancelled — with undo where the effect allows it", done, "Nothing has run yet.")}
    </div>
  </div>`;
}

function sandboxes() {
  const runs = S.scenes.filter((s) => s.last?.sandbox?.length).flatMap((s) => s.last.sandbox.map((x, i) => ({ scene: s, x, i })));
  const v = S.agamemnon.violations;
  return `
    <div class="grid g3">
      <div class="card"><h3>No ambient authority</h3><p class="k">Each enclave is its own Wasm module: no fs, network, timers or host objects. One captured syscall function is the only way out.</p></div>
      <div class="card"><h3>Capabilities, not trust</h3><p class="k">READ_ONLY, MUTATE_STATE, EXTERNAL_HTTP (allowlisted hosts), AGENT_IPC. An ungranted syscall kills the sandbox and is logged.</p></div>
      <div class="card"><h3>Writes are proposals</h3><p class="k">A sandbox write is an ordinary Agamemnon effect on a task scoped to its tenant — measured, gated, receipted, revertible.</p></div>
    </div>
    <div class="section-h"><h2>Policy violations</h2><p>Recorded by the supervisor and written to the broker's audit log</p></div>
    <div class="agm">${
      v.length
        ? `<table><thead><tr><th>When</th><th>Sandbox</th><th>Tenant</th><th>Reason</th><th>Syscall</th></tr></thead><tbody>${v
            .map((x) => `<tr><td>${ago(x.at)}</td><td class="mono">${esc(x.sandboxId)}</td><td class="mono">${esc(x.tenantId)}</td><td>${esc(x.reason)}</td><td class="mono">${esc(JSON.stringify(x.syscall).slice(0, 140))}</td></tr>`)
            .join("")}</tbody></table>`
        : '<div class="empty">No violations yet — run “Review Booster” in the runbook.</div>'
    }</div>
    <div class="section-h"><h2>Recent sandbox runs</h2><p>From the runbook</p></div>
    <div class="grid g2">${runs.length ? runs.map(({ scene, x, i }) => `<div class="card"><div class="actor">${esc(scene.title)}</div>${sandboxBlock(x, `sbx-${scene.id}-${i}`)}</div>`).join("") : '<div class="empty">No sandbox has run yet.</div>'}</div>`;
}

function activity() {
  const a = S.agamemnon;
  const out = S.platform.outside;
  return `<div class="grid g2">
    <div class="agm"><div class="agm-brand">Audit log · ${a.chain.ok ? "chain verified" : "chain BROKEN"}</div>
      <ul class="list audit">${a.audit
        .slice()
        .reverse()
        .map((r) => `<li><span class="muted">${ago(r.at)}</span><span class="who"><span class="kind">${esc(r.kind)}</span> ${esc(r.actor ?? "")}</span><span>${esc(r.detail)}</span></li>`)
        .join("")}</ul></div>
    <div class="card"><h3>The outside world</h3><p class="k">Every request that reached Stripe, GitHub, Datadog or a sandbox's network. Anything Agamemnon refused never appears here.</p>
      <table><thead><tr><th>When</th><th>Service</th><th>Request</th></tr></thead><tbody>${
        out.length ? out.map((c) => `<tr><td>${ago(c.at)}</td><td>${esc(c.service)}</td><td class="mono">${esc(c.method)} ${esc(c.path.slice(0, 80))}</td></tr>`).join("") : '<tr><td colspan="3" class="empty">No outside calls yet.</td></tr>'
      }</tbody></table></div>
  </div>`;
}

function operators() {
  return `<div class="grid g2">
    <div class="agm"><div class="agm-brand">Humans</div>
      <table><thead><tr><th>Who</th><th>Role</th><th>Console token</th></tr></thead><tbody>${S.people
        .map((p) => `<tr><td>${esc(p.title)}</td><td>${esc(p.role)}</td><td><div class="token"><code>${esc(p.token)}</code><button class="btn dark small" data-copy="${esc(p.token)}">Copy</button></div></td></tr>`)
        .join("")}</tbody></table>
      <p class="muted" style="margin:12px 0 0">Three-party rule: Priya launched the agents, so she cannot approve their effects. Oversight-reducing and irreversible effects need two different approvers.</p>
      <p style="margin:12px 0 0"><a class="btn gold small" href="${esc(S.agamemnon.consoleUrl)}" target="_blank" rel="noopener">Open the Agamemnon console ↗</a></p>
    </div>
    <div class="card"><h3>Agents</h3><p class="k">Principals the broker knows. None of them holds a credential.</p>
      <ul class="list">${S.agents.map((a) => `<li><span class="mono">${esc(a.name)}</span><span class="r">${esc(a.title)}</span></li>`).join("")}</ul></div>
  </div>`;
}

function render() {
  const meta = PAGES[page];
  $("#page-title").textContent = meta.title;
  $("#page-sub").textContent = meta.sub;
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.page === page));
  if (!S) return;
  $("#console-link").href = S.agamemnon.consoleUrl;
  const waiting = S.agamemnon.effects.filter((e) => e.status === "awaiting_approval" || e.status === "held").length;
  $("#badge-decisions").textContent = waiting ? String(waiting) : "";
  const html = { overview, runbook, decisions, sandboxes, activity, operators }[page]();
  if (html !== render.last) {
    $("#page").innerHTML = html;
    render.last = html;
  }
}

page = (location.hash.replace(/^#\//, "") || "overview").split("?")[0];
if (!PAGES[page]) page = "overview";
render();
refresh();
setInterval(refresh, 1500);
