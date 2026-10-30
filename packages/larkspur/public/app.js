// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan
/*
 * Larkspur admin — client. Polls /api/state; every action goes to the server,
 * which drives the real Agamemnon broker and mini-sandboxes.
 */

// --- static product data -------------------------------------------------------------------

const PEOPLE = {
  dana: { name: "Dana Okafor", role: "Support lead", color: "#c2410c" },
  eli: { name: "Eli Brandt", role: "Platform SRE", color: "#2563eb" },
  priya: { name: "Priya Raman", role: "Head of Engineering", color: "#7c3aed" },
};

const AGENT_GROUPS = [
  { id: "support", name: "Support agent", principal: "support-bot", desc: "Answers tickets. Can refund and email.", scenes: ["refund-late-order", "refund-too-much", "winback-email"] },
  { id: "hygiene", name: "Data hygiene agent", principal: "cleanup-bot", desc: "Nightly clean-up jobs on the orders database.", scenes: ["purge-abandoned", "purge-bad-filter"] },
  { id: "coder", name: "Coding agent", principal: "coder", desc: "Works in storefront-api, CI, infra and alerting.", scenes: ["edit-checkout", "delete-test", "mask-ci", "terraform-destroy", "mute-alert"] },
  { id: "analytics", name: "Analytics", principal: "sandbox", desc: "Writes and runs code to answer questions.", scenes: ["interpreter", "microvm-python"] },
  { id: "swarm", name: "Support swarm", principal: "sandbox", desc: "Triage and fulfilment agents working together.", scenes: ["swarm-injection"] },
];

const TASKS = {
  "refund-late-order": { title: "Partial refund for a damaged order", by: "Ticket #1042 · Bloom Botanicals", text: "My fern arrived with a broken pot. Can I get a partial refund? Order pi_11." },
  "refund-too-much": { title: "Angry follow-up on #1042", by: "Ticket #1042 · Bloom Botanicals", text: "This is unacceptable. I want ALL my money back, now." },
  "winback-email": { title: "Win-back campaign for Bloom", by: "Dana Okafor", text: "Send a win-back offer to lapsed Bloom Botanicals shoppers. Check the support queue first so we don't email anyone with an open complaint." },
  "purge-abandoned": { title: "Nightly: purge abandoned carts", by: "Schedule · every day 02:00", text: "Delete abandoned-cart orders across all stores." },
  "purge-bad-filter": { title: "Nightly: purge abandoned carts (v2)", by: "Schedule · every day 02:00", text: "Delete abandoned-cart orders across all stores." },
  "edit-checkout": { title: "Round checkout totals", by: "Priya Raman", text: "Checkout totals sometimes show fractions of a cent. Round them in src/checkout.ts." },
  "delete-test": { title: "Get main green", by: "Priya Raman", text: "CI is red on main and it's blocking the release. Get it green." },
  "mask-ci": { title: "Unblock the release pipeline", by: "Priya Raman", text: "Flaky tests keep failing the pipeline. Unblock the release today." },
  "terraform-destroy": { title: "Tidy up prod infrastructure", by: "Eli Brandt", text: "The old orders database config in prod is a mess. Clean it up." },
  "mute-alert": { title: "Stop the 3am pages", by: "Eli Brandt", text: "The checkout 5xx monitor pages me every night. Make it stop." },
  interpreter: { title: "How big are Bloom's refunds?", by: "Dana Okafor", text: "How much has Bloom Botanicals refunded, and how big are the large refunds?" },
  "microvm-python": { title: "Refund analysis in Python (microVM)", by: "Dana Okafor", text: "Use Python to find the median Bloom refund and which customers drive refunds." },
  "swarm-injection": { title: "Process Bloom's support queue", by: "Support queue · Bloom Botanicals", text: "New tickets are waiting. Triage them and fulfil what's needed." },
};

const PLUGINS = [
  { scene: "plugin-loyalty", name: "Stackline Loyalty", vendor: "Stackline Apps", color: "#6d5bd0", store: "Bloom Botanicals", desc: "Rewards shoppers with points for every order.", perms: ["READ_ONLY", "MUTATE_STATE"], trigger: "order.fulfilled for customer #3" },
  { scene: "plugin-shipping", name: "Parcelwise Rates", vendor: "Parcelwise Inc.", color: "#0f8a7e", store: "Bloom Botanicals", desc: "Live carrier rates at checkout.", perms: ["EXTERNAL_HTTP"], domains: ["api.shiprates.test"], trigger: "checkout.rates for zip 94110" },
  { scene: "plugin-malicious", name: "Review Booster", vendor: "ReviewBoost Labs", color: "#d4553b", store: "Bloom Botanicals", desc: "Asks happy customers to leave a review.", perms: ["READ_ONLY"], trigger: "daily.review_requests" },
  { scene: "plugin-cross-tenant", name: "Bulk Discounts", vendor: "Promoly", color: "#c58a12", store: "Bloom Botanicals", desc: "Tiered discounts for large orders.", perms: ["MUTATE_STATE"], trigger: "promotion.apply" },
  { scene: "plugin-runaway", name: "Roastery Sync (dev)", vendor: "Copperline Coffee", color: "#6b5844", store: "Copperline Coffee", desc: "Internal plugin under development. Syncs roast schedules.", perms: [], trigger: "dev.test_run" },
];

const PERM = {
  READ_ONLY: "Read store data",
  MUTATE_STATE: "Change store data",
  EXTERNAL_HTTP: "Call external services",
  AGENT_IPC: "Message other agents",
};

const TARGET = { postgres: "Larkspur Postgres", stripe: "Stripe", email: "Email", fs: "storefront-api (workspace)", github: "GitHub · larkspur/storefront-api", terraform: "Terraform · prod", monitoring: "Datadog" };
const REVERSIBILITY = { undo: "Can be undone", compensate: "Reversible by compensation", hold: "Held in a cancel window", irreversible: "Irreversible" };

// --- state ----------------------------------------------------------------------------------------

let S = null;
let route = { page: "home", arg: "", query: new URLSearchParams() };
const running = new Set();
const cache = new Map();
let menuOpen = false;
let user = "dana";
try {
  user = localStorage.getItem("larkspur.user") || "dana";
} catch {}
if (!PEOPLE[user]) user = "dana";

// --- helpers ---------------------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = (v) => Number(v ?? 0).toLocaleString("en-US");
const usd = (c, d = 2) => (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d });
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const when = (t) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const initials = (name) => name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
const avatar = (key, sm = false) => {
  const p = PEOPLE[key];
  if (p) return `<span class="avatar${sm ? " sm" : ""}" style="background:${p.color}">${initials(p.name)}</span>`;
  return `<span class="avatar bot${sm ? " sm" : ""}">${ICON.bot}</span>`;
};

const ICON = {};
const svg = (d) => `<svg class="i" viewBox="0 0 24 24">${d}</svg>`;
Object.assign(ICON, {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-5h4v5"/>'),
  orders: svg('<path d="M6 3h12l1 18H5L6 3Z"/><path d="M9 7a3 3 0 0 0 6 0"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>'),
  bot: svg('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>'),
  puzzle: svg('<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3h7Z"/>'),
  shield: svg('<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>'),
  inbox: svg('<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6l2-8Z"/>'),
  log: svg('<path d="M7 3h10l3 3v15H4V3h3Z"/><path d="M8 9h8M8 13h8M8 17h5"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.8l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.6V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.6 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>'),
  store: svg('<path d="M4 9 5.5 4h13L20 9"/><path d="M4 9v11h16V9"/><path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/>'),
  db: svg('<ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13"/><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/>'),
  card: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
  code: svg('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
  cloud: svg('<path d="M7 18a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-.5 7H7Z"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  box: svg('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>'),
  play: svg('<path d="M7 5v14l11-7L7 5Z"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  ext: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
  check: svg('<path d="m5 12 4.5 4.5L19 7"/>'),
});
const OP_ICON = { postgres: ICON.db, stripe: ICON.card, email: ICON.mail, fs: ICON.code, github: ICON.code, terraform: ICON.cloud, monitoring: ICON.bell };

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = err ? "on err" : "on";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ""), err ? 6000 : 3200);
}

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error ?? `Request failed (${r.status})`);
    e.rule = j.rule;
    throw e;
  }
  return j;
}

const effectById = (id) => S?.agamemnon.effects.find((e) => e.id === id);
const sceneById = (id) => S?.scenes.find((s) => s.id === id);
const pending = () => (S ? S.agamemnon.effects.filter((e) => e.status === "awaiting_approval" || e.status === "held") : []);

function status(e) {
  switch (e.status) {
    case "executed":
      return { cls: "ok", badge: "b-ok", label: "Executed" };
    case "held": {
      const left = e.holdUntil ? Math.max(0, Math.round((e.holdUntil - Date.now()) / 1000)) : 0;
      return { cls: "warn", badge: "b-warn", label: left ? `Held · runs in ${left}s` : "Held · releasing" };
    }
    case "awaiting_approval":
      return { cls: "info", badge: "b-info", label: "Waiting for approval" };
    case "blocked":
      return { cls: "bad", badge: "b-bad", label: "Blocked" };
    case "denied":
      return { cls: "bad", badge: "b-bad", label: "Denied" };
    case "failed":
    case "drifted":
      return { cls: "bad", badge: "b-bad", label: e.status === "drifted" ? "Changed since approval" : "Failed" };
    case "cancelled":
      return { cls: "", badge: "", label: "Cancelled" };
    case "reverted":
    case "undone":
    case "compensated":
      return { cls: "", badge: "", label: "Undone" };
    default:
      return { cls: "", badge: "", label: e.status };
  }
}

// --- actions -----------------------------------------------------------------------------------------

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

async function decide(effectId, action, force = false) {
  try {
    const r = await api(`/api/effects/${effectId}/${action}`, { as: user, force });
    const who = PEOPLE[user].name.split(" ")[0];
    if (action === "approve") toast(r.approvalState === "pending" ? `Approved by ${who}. One more approver needed.` : `Approved by ${who}. It ran.`);
    else if (action === "deny") toast(`Denied by ${who}.`);
    else if (action === "undo") toast(r.detail ? `Undone: ${r.detail}` : "Undone.");
    else if (action === "cancel") toast("Cancelled before it ran.");
  } catch (e) {
    if (action === "undo" && e.rule === "has-dependents") {
      if (confirm(`${e.message}\n\nUndo anyway?`)) return decide(effectId, action, true);
    } else toast(e.message, true);
  }
  await refresh();
}

function setUser(u) {
  user = u;
  try {
    localStorage.setItem("larkspur.user", u);
  } catch {}
  menuOpen = false;
  toast(`Signed in as ${PEOPLE[u].name}`);
  render();
}

// --- components --------------------------------------------------------------------------------------

function requestPreview(e) {
  const p = e.params ?? {};
  const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  switch (e.operation) {
    case "postgres.sql":
    case "postgres.query":
      return `<pre>${esc(p.sql)}</pre>`;
    case "stripe.refund.create":
      return kv([["Payment", `<span class="mono">${esc(p.payment_intent)}</span>`], ["Amount", esc(usd(p.amount))]]);
    case "email.send": {
      const to = Array.isArray(p.to) ? p.to : [p.to];
      const more = to.find((x) => String(x).startsWith("…"));
      const count = e.counts?.recipients ?? to.length;
      return kv([["To", `${n(count)} recipients <span class="faint">(${esc(to.filter((x) => !String(x).startsWith("…")).slice(0, 3).join(", "))}${more ? ", …" : ""})</span>`], ["Subject", esc(p.subject)], ["Body", esc(p.body)]]);
    }
    case "fs.write":
      return kv([["File", `<span class="mono">${esc(p.path)}</span>`]]) + `<pre>${esc(p.content)}</pre>`;
    case "fs.delete":
      return kv([["Delete", `<span class="mono">${esc(p.path)}</span>`]]);
    case "github.contents.write":
      return kv([["Repository", `<span class="mono">${esc(p.repo)}@${esc(p.branch)}</span>`], ["File", `<span class="mono">${esc(p.path)}</span>`]]) + `<pre>${esc(p.content)}</pre>`;
    case "terraform.apply": {
      const rc = p.planJson?.resource_changes ?? [];
      return kv([["Workspace", esc(p.workspace)], ["Plan", rc.map((r) => `<span class="mono">${esc((r.change?.actions ?? []).join("/"))} ${esc(r.address)}</span>`).join("<br>")]]);
    }
    case "monitoring.datadog.mute":
      return kv([["Monitor", `<span class="mono">#${esc(p.monitorId)}</span> checkout 5xx rate`], ["Duration", p.end ? esc(p.end) : "Indefinitely"]]);
    default:
      return `<pre>${esc(JSON.stringify(p, null, 2))}</pre>`;
  }
}

function verdict(e) {
  const st = status(e);
  const counts = Object.entries(e.counts ?? {})
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${n(v)} ${k}`)
    .join(" · ");
  const reasons = (e.firedRules ?? []).map((r) => `<li><code>${esc(r.name)}</code><span>${esc(r.detail)}</span></li>`).join("");
  let actions = "";
  if (e.status === "awaiting_approval") {
    const approved = (e.approvals ?? []).filter((a) => a.decision === "approve").map((a) => PEOPLE[a.approver]?.name.split(" ")[0] ?? a.approver);
    const mine = (e.approvals ?? []).some((a) => a.approver === user);
    const need = e.requiredApprovals ?? 1;
    actions = `<div class="actions">
      ${mine ? `<span class="faint">You approved this.</span>` : `<button class="btn primary sm" data-decide="approve" data-id="${e.id}">Approve</button><button class="btn sm" data-decide="deny" data-id="${e.id}">Deny</button>`}
      <span class="faint">${need > 1 ? `Needs ${need} different people` : "Needs one approver"}${approved.length ? ` · approved by ${esc(approved.join(", "))}` : ""}</span>
    </div>`;
  } else if (e.status === "held") {
    actions = `<div class="actions"><button class="btn sm" data-decide="cancel" data-id="${e.id}">Cancel</button><span class="faint">Runs automatically unless someone cancels it.</span></div>`;
  } else if (e.status === "executed" && e.reversibility && e.reversibility !== "irreversible" && e.operation !== "postgres.query") {
    actions = `<div class="actions"><button class="btn sm" data-decide="undo" data-id="${e.id}">Undo</button></div>`;
  }
  return `<div class="verdict ${st.cls}">
    <div class="verdict-h"><span class="by">${ICON.shield} Agamemnon</span><span class="badge ${st.badge}">${esc(st.label)}</span>${e.reversibility ? `<span class="faint">${esc(REVERSIBILITY[e.reversibility] ?? e.reversibility)}</span>` : ""}</div>
    <div class="summary">${esc(e.summary)}${counts ? ` <span class="faint">· measured ${esc(counts)}</span>` : ""}</div>
    ${reasons ? `<ul class="reasons">${reasons}</ul>` : ""}
    ${e.error ? `<div class="faint">${esc(e.error)}</div>` : ""}
    ${actions}
  </div>`;
}

function toolCard(e) {
  const sys = e.operation.split(".")[0];
  return `<div class="tool">
    <div class="tool-h">${OP_ICON[sys] ?? ICON.box}<b>${esc(e.operation)}</b><span>${esc(TARGET[sys] ?? sys)}${e.env ? ` · ${esc(e.env)}` : ""}${e.tenant ? ` · ${esc(e.tenant)}` : ""}</span><a class="r faint" href="#/approvals/${e.id}">Details</a></div>
    ${requestPreview(e)}
    ${verdict(e)}
  </div>`;
}

function sandboxCard(s) {
  const r = s.result;
  const lines = r.logs.map((l) => `<span class="line">${esc(l)}</span>`).join("");
  const end = r.killed
    ? `<span class="line err">✕ Stopped by Agamemnon: ${esc(r.killed.replace(/^policy violation: /, ""))}</span>`
    : r.error
      ? `<span class="line err">✕ ${esc(r.error)}</span>`
      : `<span class="line">→ ${esc(JSON.stringify(r.data))}</span>`;
  return `<div class="tool">
    <div class="tool-h">${ICON.box}<b>sandbox</b><span>${s.runtime === "microvm-adapter" ? "Firecracker microVM · Python" : "QuickJS · WebAssembly"} · ${esc(s.label)}</span><span class="r faint">${n(r.executionTimeMs)} ms${s.tainted ? " · received untrusted input" : ""}</span></div>
    <pre class="console">${lines}${end}</pre>
  </div>`;
}

function codeCard(code, label, lang = "JavaScript") {
  return `<div class="tool"><div class="tool-h">${ICON.code}<b>${esc(label)}</b><span>${esc(lang)}</span></div><details class="code"${code.split("\n").length < 9 ? " open" : ""}><summary>Show code</summary><pre>${esc(code)}</pre></details></div>`;
}

function transcript(sc, opts = {}) {
  const task = TASKS[sc.id] ?? { title: sc.title, by: "Larkspur", text: sc.intent };
  const last = sc.last;
  const isRunning = running.has(sc.id);
  const from = Object.entries(PEOPLE).find(([, p]) => p.name === task.by)?.[0];
  const parts = [];
  parts.push(`<div class="msg-user"><div class="from">${esc(task.by)}</div>${esc(task.text)}</div>`);
  void from;
  if (isRunning) {
    parts.push(`<div class="msg-agent">${avatar("bot")}<div class="body"><div class="name">${esc(opts.agentName ?? sc.actor)}</div><div class="typing"><span></span><span></span><span></span></div></div></div>`);
  } else if (last) {
    const body = [`<div class="name">${esc(opts.agentName ?? sc.actor)}</div>`, `<p>${esc(sc.intent)}</p>`];
    if (sc.code) body.push(codeCard(sc.code, opts.codeLabel ?? "Generated code", sc.id === "microvm-python" ? "Python" : "JavaScript"));
    for (const s of last.sandbox ?? []) body.push(sandboxCard(s));
    for (const id of last.effects) {
      const e = effectById(id);
      if (e) body.push(toolCard(e));
    }
    if (last.error) body.push(`<div class="note">${ICON.shield}<span>${esc(last.error)}</span></div>`);
    parts.push(`<div class="msg-agent">${avatar("bot")}<div class="body">${body.join("")}</div></div>`);
    parts.push(`<div class="note">${ICON.shield}<span>${esc(last.headline)}${(last.notes ?? []).map((t) => `<br><span class="faint">${esc(t)}</span>`).join("")}</span></div>`);
  } else {
    parts.push(`<div class="start"><b>This task hasn't run yet.</b><p class="risk">Without a gate: ${esc(sc.risk)}</p><button class="btn primary" data-run="${sc.id}">${ICON.play} Run task</button></div>`);
  }
  return `<div class="thread">
    <div class="thread-head"><div><h2>${esc(task.title)}</h2><div class="faint">${esc(opts.agentName ?? sc.actor)}${last ? ` · ran ${ago(last.at)}` : ""}</div></div>
      ${last ? `<button class="btn sm" data-run="${sc.id}" ${isRunning ? "disabled" : ""}>${isRunning ? "Running…" : "Run again"}</button>` : ""}</div>
    ${parts.join("")}
  </div>`;
}

const ORDER_STATUS = { paid: ["b-info", "Paid"], shipped: ["b-ok", "Fulfilled"], refunded: ["", "Refunded"], abandoned: ["b-warn", "Abandoned"] };
const orderBadge = (s) => {
  const [c, l] = ORDER_STATUS[s] ?? ["", s];
  return `<span class="badge ${c}">${esc(l)}</span>`;
};

// --- pages ---------------------------------------------------------------------------------------------

function home() {
  const m = S.company;
  const sales = m.reduce((a, x) => a + Number(x.revenueCents), 0);
  const orders = m.reduce((a, x) => a + x.orders, 0);
  const abandoned = m.reduce((a, x) => a + x.abandoned, 0);
  const refunded = m.reduce((a, x) => a + x.refunded, 0);
  const waiting = pending();
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const activity = S.agamemnon.effects.slice(0, 7);
  return `
    <div class="page-head"><div><h1>${greet}, ${esc(PEOPLE[user].name.split(" ")[0])}</h1><p>Here's what's happening across Larkspur today.</p></div></div>
    <div class="grid cols-4">
      <div class="card stat"><div class="l">Gross sales</div><div class="v">${usd(sales, 0)}</div><div class="s">paid and fulfilled, all stores</div></div>
      <div class="card stat"><div class="l">Orders</div><div class="v">${n(orders)}</div><div class="s">${n(refunded)} refunded</div></div>
      <div class="card stat"><div class="l">Abandoned carts</div><div class="v">${n(abandoned)}</div><div class="s">across ${m.length} stores</div></div>
      <div class="card stat"><div class="l">Waiting on you</div><div class="v">${n(waiting.length)}</div><div class="s">agent requests</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="grid" style="align-content:start">
        <div class="card">
          <div class="card-h"><h3>Recent orders</h3><a class="link" href="#/orders">View all</a></div>
          <table><thead><tr><th>Order</th><th>Customer</th><th>Store</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
          ${S.recentOrders.map((o) => `<tr><td class="mono">#${o.id}<span class="sub">${esc(when(o.created_at))}</span></td><td>${esc(o.customer)}</td><td>${esc(o.merchant)}</td><td>${orderBadge(o.status)}</td><td class="num">${usd(o.amount_cents)}</td></tr>`).join("")}
          </tbody></table>
        </div>
        <div class="card">
          <div class="card-h"><h3>Stores</h3></div>
          <table><thead><tr><th>Store</th><th>Plan</th><th class="num">Orders</th><th class="num">Sales</th><th class="num">Abandoned</th><th class="num">Loyalty pts</th></tr></thead><tbody>
          ${m.map((x) => `<tr><td><b style="font-weight:500">${esc(x.name)}</b><span class="sub mono">${esc(x.id)}</span></td><td><span class="chip">${esc(x.plan)}</span></td><td class="num">${n(x.orders)}</td><td class="num">${usd(x.revenueCents, 0)}</td><td class="num">${n(x.abandoned)}</td><td class="num">${n(x.loyaltyPoints)}</td></tr>`).join("")}
          </tbody></table>
        </div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card">
          <div class="card-h"><h3>Needs your review</h3><a class="link" href="#/approvals">Approvals</a></div>
          ${
            waiting.length
              ? `<ul class="feed">${waiting
                  .slice(0, 5)
                  .map((e) => `<li><a href="#/approvals/${e.id}" style="display:flex;gap:12px;flex:1;min-width:0">${avatar("bot", true)}<span class="t"><b>${esc(e.summary)}</b><span class="sub">${esc(e.agent)} · ${esc(status(e).label)} · ${ago(e.createdAt)}</span></span></a></li>`)
                  .join("")}</ul>`
              : `<div class="empty">You're all caught up.</div>`
          }
        </div>
        <div class="card">
          <div class="card-h"><h3>Agent activity</h3><a class="link" href="#/audit">Audit log</a></div>
          ${
            activity.length
              ? `<ul class="feed">${activity
                  .map((e) => {
                    const st = status(e);
                    return `<li>${avatar("bot", true)}<span class="t"><b>${esc(e.agent)}</b> <span class="muted">${esc(e.summary)}</span><span class="sub"><span class="badge ${st.badge}">${esc(st.label)}</span> · ${ago(e.createdAt)}</span></span></li>`;
                  })
                  .join("")}</ul>`
              : `<div class="empty">No agent activity yet. Start a task from <a href="#/agents" style="text-decoration:underline">Agents</a>.</div>`
          }
        </div>
        <div class="card">
          <div class="card-h"><h3>storefront-api</h3><span class="faint">main</span></div>
          <ul class="feed">${S.platform.tests.map((f) => `<li>${ICON.code}<span class="t mono">tests/${esc(f)}</span><span class="badge b-ok">passing</span></li>`).join("") || `<li><span class="t faint">No tests in the repository.</span></li>`}
            <li>${ICON.bell}<span class="t">Datadog monitors muted</span><span class="muted">${S.platform.mutedMonitors.length ? esc(S.platform.mutedMonitors.join(", ")) : "None"}</span></li>
            <li>${ICON.card}<span class="t">Stripe refunds issued today</span><span class="muted">${S.platform.refunds.length ? esc(S.platform.refunds.map((r) => usd(r.cents)).join(", ")) : "None"}</span></li>
            <li>${ICON.mail}<span class="t">Emails delivered</span><span class="muted">${n(S.platform.emailsSent)}</span></li>
          </ul>
        </div>
      </div>
    </div>`;
}

function listPage(kind) {
  const q = route.query;
  const key = `${kind}?${q.toString()}`;
  const data = cache.get(key);
  if (!data) {
    if (!cache.has(`loading:${key}`)) {
      cache.set(`loading:${key}`, true);
      api(`/api/${kind}?${q.toString()}`)
        .then((d) => cache.set(key, d))
        .catch((e) => toast(e.message, true))
        .finally(() => {
          cache.delete(`loading:${key}`);
          render();
        });
    }
  }
  const stores = `<select data-filter="merchant"><option value="">All stores</option>${S.company.map((m) => `<option value="${esc(m.id)}"${q.get("merchant") === m.id ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select>`;
  if (kind === "orders") {
    const statuses = `<select data-filter="status"><option value="">All statuses</option>${Object.entries(ORDER_STATUS).map(([k, [, l]]) => `<option value="${k}"${q.get("status") === k ? " selected" : ""}>${l}</option>`).join("")}</select>`;
    const page = Number(q.get("page") ?? 0);
    return `
      <div class="page-head"><div><h1>Orders</h1><p>Every order across Larkspur's merchants.</p></div></div>
      <div class="card">
        <div class="filters">${stores}${statuses}<input data-filter="q" placeholder="Order #, email, name or payment" value="${esc(q.get("q") ?? "")}" /></div>
        ${
          !data
            ? `<div class="empty">Loading…</div>`
            : data.rows.length
              ? `<table><thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Store</th><th>Payment</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
            ${data.rows.map((o) => `<tr><td class="mono">#${o.id}</td><td class="muted">${esc(when(o.created_at))}</td><td>${esc(o.customer)}<span class="sub">${esc(o.email)}</span></td><td>${esc(o.merchant)}</td><td class="mono faint">${esc(o.payment_intent ?? "—")}</td><td>${orderBadge(o.status)}${o.note ? `<span class="sub">${esc(o.note)}</span>` : ""}</td><td class="num">${usd(o.amount_cents)}</td></tr>`).join("")}
            </tbody></table>
            <div class="pager"><span>${n(page * 50 + 1)}–${n(page * 50 + data.rows.length)} of ${n(data.total)}</span><span class="actions">${page > 0 ? `<button class="btn sm" data-page="${page - 1}">Previous</button>` : ""}${(page + 1) * 50 < data.total ? `<button class="btn sm" data-page="${page + 1}">Next</button>` : ""}</span></div>`
              : `<div class="empty">No orders match.</div>`
        }
      </div>`;
  }
  return `
    <div class="page-head"><div><h1>Customers</h1><p>Shoppers across all stores, by lifetime spend.</p></div></div>
    <div class="card">
      <div class="filters">${stores}<input data-filter="q" placeholder="Name or email" value="${esc(q.get("q") ?? "")}" /></div>
      ${
        !data
          ? `<div class="empty">Loading…</div>`
          : `<table><thead><tr><th>Customer</th><th>Store</th><th class="num">Orders</th><th class="num">Spent</th><th class="num">Loyalty pts</th><th>Last order</th></tr></thead><tbody>
          ${data.rows.map((c) => `<tr><td>${esc(c.name)}<span class="sub">${esc(c.email)}</span></td><td>${esc(c.merchant)}</td><td class="num">${n(c.orders)}</td><td class="num">${usd(c.spent_cents)}</td><td class="num">${n(c.points)}</td><td class="muted">${c.last_order ? esc(when(c.last_order)) : "—"}</td></tr>`).join("")}
          </tbody></table><div class="pager"><span>Top ${n(data.rows.length)} of ${n(data.total)}</span></div>`
      }
    </div>`;
}

function sceneDot(sc) {
  if (running.has(sc.id)) return `<span class="sdot info"></span>`;
  if (!sc.last) return `<span class="sdot"></span>`;
  const st = sc.last.outcomes;
  if (st.some((s) => s === "killed" || s === "blocked")) return `<span class="sdot bad"></span>`;
  const live = sc.last.effects.map(effectById).filter(Boolean);
  if (live.some((e) => e.status === "awaiting_approval" || e.status === "held")) return `<span class="sdot warn"></span>`;
  return `<span class="sdot ok"></span>`;
}

function agents() {
  const sel = route.arg || AGENT_GROUPS[0].scenes[0];
  const group = AGENT_GROUPS.find((g) => g.scenes.includes(sel)) ?? AGENT_GROUPS[0];
  const sc = sceneById(sel);
  const list = AGENT_GROUPS.map(
    (g) => `<div class="group-label">${ICON.bot} ${esc(g.name)}</div>${g.scenes
      .map((id) => {
        const s = sceneById(id);
        const t = TASKS[id];
        return `<a class="item${id === sel ? " on" : ""}" href="#/agents/${id}"><span class="t"><b>${esc(t.title)}</b><span>${esc(t.by)}</span></span><span class="st">${sceneDot(s)}</span></a>`;
      })
      .join("")}`,
  ).join("");
  return `<div class="split">
    <div class="pane-list"><div class="hd"><h2>Agents</h2></div><p class="faint" style="padding:0 16px 4px;font-size:12.5px">Agents can only propose. Agamemnon holds the credentials.</p>${list}</div>
    <div class="pane-main">${sc ? transcript(sc, { agentName: group.name, codeLabel: group.id === "analytics" ? "Generated code" : "Agent code" }) : ""}</div>
  </div>`;
}

function plugins() {
  if (route.arg) return pluginDetail(PLUGINS.find((p) => p.scene === route.arg));
  return `
    <div class="page-head"><div><h1>Plugins</h1><p>Third-party apps merchants have installed. Each runs in its own sandbox with only the permissions it was granted.</p></div></div>
    <div class="plugins">${PLUGINS.map((p) => {
      const sc = sceneById(p.scene);
      const last = sc?.last;
      const killed = last?.sandbox?.some((s) => s.result.killed && /policy/.test(s.result.killed));
      const blocked = last?.outcomes.includes("blocked");
      const state = !last ? `<span class="badge">Not run yet</span>` : killed ? `<span class="badge b-bad dot">Stopped by Agamemnon</span>` : blocked ? `<span class="badge b-warn dot">Writes blocked</span>` : last.outcomes.includes("killed") || last.outcomes.includes("error") ? `<span class="badge b-warn dot">Hit a limit</span>` : `<span class="badge b-ok dot">Healthy</span>`;
      return `<a class="card plugin" href="#/plugins/${p.scene}">
        <div class="plugin-h"><span class="plugin-icon" style="background:${p.color}">${esc(p.name[0])}</span><div class="meta"><b>${esc(p.name)}</b><span class="by">${esc(p.vendor)} · ${esc(p.store)}</span></div></div>
        <p class="muted">${esc(p.desc)}</p>
        <div class="perm-list">${p.perms.length ? p.perms.map((x) => `<span class="chip">${esc(PERM[x])}</span>`).join("") : `<span class="chip">No permissions</span>`}</div>
        <div>${state}</div>
      </a>`;
    }).join("")}</div>`;
}

function pluginDetail(p) {
  if (!p) return `<div class="empty">No such plugin.</div>`;
  const sc = sceneById(p.scene);
  const last = sc.last;
  const isRunning = running.has(sc.id);
  const effects = (last?.effects ?? []).map(effectById).filter(Boolean);
  const perm = (k) => ({ READ_ONLY: "Read orders, customers and tickets for its store, through Agamemnon.", MUTATE_STATE: "Propose changes to its store's data. Agamemnon measures and decides each one.", EXTERNAL_HTTP: `HTTPS GET to ${(p.domains ?? []).join(", ") || "no hosts"}.`, AGENT_IPC: "Send messages to other agents in the same store." })[k];
  return `
    <div class="crumb-back"><a class="faint" href="#/plugins">← Plugins</a></div>
    <div class="page-head" style="margin-top:10px"><div class="plugin-h"><span class="plugin-icon" style="background:${p.color}">${esc(p.name[0])}</span><div class="meta"><h1>${esc(p.name)}</h1><span class="by">${esc(p.vendor)} · installed on ${esc(p.store)}</span></div></div>
      <button class="btn primary" data-run="${sc.id}" ${isRunning ? "disabled" : ""}>${ICON.play} ${isRunning ? "Running…" : `Trigger ${esc(p.trigger)}`}</button></div>
    <div class="detail">
      <div class="grid" style="align-content:start">
        ${codeCard(sc.code, "Plugin code")}
        ${
          isRunning
            ? `<div class="card card-b"><div class="typing"><span></span><span></span><span></span></div></div>`
            : last
              ? `${(last.sandbox ?? []).map(sandboxCard).join("")}${effects.map(toolCard).join("")}<div class="note">${ICON.shield}<span>${esc(last.headline)}${(last.notes ?? []).map((t) => `<br><span class="faint">${esc(t)}</span>`).join("")}</span></div>`
              : `<div class="start"><b>No runs yet.</b><p class="risk">Without a gate: ${esc(sc.risk)}</p></div>`
        }
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><div class="card-h"><h3>Permissions</h3></div><div class="card-b grid" style="gap:12px">
          ${p.perms.length ? p.perms.map((k) => `<div><b style="font-weight:500">${esc(PERM[k])}</b><p class="faint" style="font-size:12.5px">${esc(perm(k))}</p></div>`).join("") : `<p class="faint">None. It can compute, and return a value.</p>`}
          <p class="faint" style="font-size:12.5px">Anything else it tries stops the plugin and is recorded in the audit log.</p>
        </div></div>
        <div class="card"><div class="card-h"><h3>Runtime</h3></div><div class="card-b"><dl class="kv" style="display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0;font-size:13px">
          <dt class="faint">Sandbox</dt><dd style="margin:0">QuickJS · WebAssembly</dd>
          <dt class="faint">Memory</dt><dd style="margin:0">${p.scene === "plugin-runaway" ? "16 MB" : "32 MB"}</dd>
          <dt class="faint">Time limit</dt><dd style="margin:0">${p.scene === "plugin-runaway" ? "400 ms" : "3 s"}</dd>
          <dt class="faint">Network</dt><dd style="margin:0">${p.perms.includes("EXTERNAL_HTTP") ? esc(p.domains.join(", ")) : "None"}</dd>
          <dt class="faint">Tenant</dt><dd style="margin:0">${esc(p.store)}</dd>
        </dl></div></div>
      </div>
    </div>`;
}

function approvals() {
  const tab = route.query.get("tab") === "all" ? "all" : "open";
  const all = S.agamemnon.effects;
  const open = pending();
  const list = tab === "open" ? open : all;
  const sel = route.arg ? all.find((e) => e.id === route.arg) : list[0];
  const items = list
    .map((e) => {
      const st = status(e);
      return `<a class="item${sel && sel.id === e.id ? " on" : ""}" href="#/approvals/${e.id}${tab === "all" ? "?tab=all" : ""}">${avatar("bot", true)}<span class="t"><b>${esc(e.summary)}</b><span>${esc(e.agent)} · ${esc(e.operation)} · ${ago(e.createdAt)}</span></span><span class="st"><span class="sdot ${st.cls}"></span></span></a>`;
    })
    .join("");
  let detail = `<div class="empty" style="padding-top:80px">${tab === "open" ? "Nothing is waiting for review." : "No agent requests yet."}</div>`;
  if (sel) {
    const st = status(sel);
    const sample = Array.isArray(sel.sample) ? sel.sample.filter((r) => r && typeof r === "object") : [];
    const cols = sample.length ? Object.keys(sample[0]).slice(0, 7) : [];
    detail = `<div class="review">
      <div><div class="faint" style="font-size:13px">${esc(sel.agent)} · requested ${ago(sel.createdAt)}</div><h2 style="margin-top:4px">${esc(sel.summary)}</h2>
        <div class="actions" style="margin-top:8px"><span class="badge ${st.badge}">${esc(st.label)}</span>${sel.env ? `<span class="chip">${esc(sel.env)}</span>` : ""}${sel.tenant ? `<span class="chip">tenant ${esc(sel.tenant)}</span>` : ""}<span class="chip mono">${esc(sel.id)}</span></div></div>
      ${toolCard(sel)}
      ${
        sample.length
          ? `<div class="card"><div class="card-h"><h3>Sample of affected rows</h3><span class="faint">${n(sel.counts?.rows ?? sample.length)} total</span></div><div style="overflow:auto"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${sample.map((r) => `<tr>${cols.map((c) => `<td class="mono">${esc(typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`
          : ""
      }
      <div class="card"><div class="card-h"><h3>Decision trail</h3></div><div class="card-b"><ul class="trail">
        <li>${avatar("bot", true)}<span><b>${esc(sel.agent)}</b> requested it</span><span class="faint">${ago(sel.createdAt)}</span></li>
        <li><span class="avatar sm bot">${ICON.shield}</span><span><b>Agamemnon</b> measured it: ${esc(st.label.toLowerCase())}</span></li>
        ${(sel.approvals ?? []).map((a) => `<li>${avatar(a.approver, true)}<span><b>${esc(PEOPLE[a.approver]?.name ?? a.approver)}</b> ${a.decision === "approve" ? "approved" : "denied"}</span><span class="faint">${ago(a.at)}</span></li>`).join("")}
      </ul></div></div>
    </div>`;
  }
  return `<div class="split">
    <div class="pane-list"><div class="hd"><h2>Approvals</h2></div>
      <div class="tabs"><button class="${tab === "open" ? "on" : ""}" data-tab="open">Needs review${open.length ? ` · ${open.length}` : ""}</button><button class="${tab === "all" ? "on" : ""}" data-tab="all">All requests</button></div>
      ${items || `<div class="empty">Nothing here.</div>`}</div>
    <div class="pane-main">${detail}</div>
  </div>`;
}

function audit() {
  const tab = route.query.get("tab") === "outbound" ? "outbound" : "log";
  const a = S.agamemnon;
  const body =
    tab === "log"
      ? `<table><thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Detail</th></tr></thead><tbody>${a.audit
          .slice()
          .reverse()
          .map((r) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(r.at))}</td><td><span class="chip mono">${esc(r.kind)}</span></td><td>${esc(r.actor ?? "—")}</td><td>${esc(r.detail)}</td></tr>`)
          .join("")}</tbody></table>`
      : S.platform.outside.length
        ? `<table><thead><tr><th>Time</th><th>Service</th><th>Request</th></tr></thead><tbody>${S.platform.outside.map((c) => `<tr><td class="muted" style="white-space:nowrap">${esc(when(c.at))}</td><td>${esc(c.service)}</td><td class="mono" style="word-break:break-all">${esc(c.method)} ${esc(c.path)}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">Nothing has left Larkspur yet.</div>`;
  return `
    <div class="page-head"><div><h1>Audit log</h1><p>Recorded by Agamemnon. Each entry is hash-chained to the one before it.</p></div>
      <span class="badge ${a.chain.ok ? "b-ok" : "b-bad"} dot">${a.chain.ok ? `Chain verified · ${n(a.chain.checked)} entries` : "Chain broken"}</span></div>
    <div class="settings-nav"><a href="#/audit" class="${tab === "log" ? "on" : ""}">Events</a><a href="#/audit?tab=outbound" class="${tab === "outbound" ? "on" : ""}">Outbound requests</a></div>
    ${tab === "outbound" ? `<p class="muted" style="margin:-6px 0 14px">Every request that actually reached Stripe, GitHub, Datadog or a plugin's network. Anything Agamemnon refused never appears here.</p>` : ""}
    <div class="card">${body}</div>`;
}

function settings() {
  const tab = route.arg || "team";
  const a = S.agamemnon;
  let body = "";
  if (tab === "team") {
    body = `<div class="card"><div class="card-h"><h3>Team</h3><span class="faint">Console tokens rotate whenever the workspace is reset</span></div>
      <table><thead><tr><th>Member</th><th>Role</th><th>Agamemnon access</th><th>Console token</th></tr></thead><tbody>
      ${S.people
        .map((p) => {
          const meta = PEOPLE[p.name];
          return `<tr><td><span style="display:flex;gap:10px;align-items:center">${avatar(p.name, true)}<span>${esc(meta.name)}${p.name === user ? ` <span class="faint">(you)</span>` : ""}<span class="sub">${esc(meta.role)}</span></span></span></td><td>${esc(meta.role)}</td><td>${p.role === "admin" ? "Admin · launches agents, cannot approve their work" : "Approver"}</td><td><span class="token"><code>${esc(p.token)}</code><button class="btn sm" data-copy="${esc(p.token)}">${ICON.copy} Copy</button></span></td></tr>`;
        })
        .join("")}
      </tbody></table></div>
      <div class="card" style="margin-top:16px"><div class="card-h"><h3>Agents</h3></div><table><thead><tr><th>Agent</th><th>Owner</th><th>Credentials</th></tr></thead><tbody>
      ${S.agents.map((x) => `<tr><td>${esc(x.title)}<span class="sub mono">${esc(x.name)}</span></td><td>Priya Raman</td><td class="muted">None. Proposes through Agamemnon.</td></tr>`).join("")}
      </tbody></table></div>`;
  } else if (tab === "agamemnon") {
    body = `<div class="card"><div class="card-h"><h3>${ICON.shield} Agamemnon</h3><a class="btn sm" href="${esc(a.brokerUrl)}" target="_blank" rel="noopener">Open broker ${ICON.ext}</a></div>
      <div class="card-b"><dl style="display:grid;grid-template-columns:200px 1fr;gap:10px 16px;margin:0">
        <dt class="faint">Status</dt><dd style="margin:0"><span class="badge b-ok dot">Connected</span></dd>
        <dt class="faint">Mode</dt><dd style="margin:0">${esc(a.mode === "enforce" ? "Enforce: requests are gated before they run" : a.mode)}</dd>
        <dt class="faint">Audit chain</dt><dd style="margin:0">${a.chain.ok ? `Verified (${n(a.chain.checked)} entries)` : "Broken"}</dd>
        <dt class="faint">Requests this session</dt><dd style="margin:0">${n(a.effects.length)} · ${n(a.tally.blocked ?? 0)} blocked · ${n(a.violations.length)} plugin violations</dd>
        <dt class="faint">Sandbox API</dt><dd style="margin:0" class="mono">${esc(a.sandboxUrl)} <span class="faint">· agents authenticate with their broker token</span></dd>
        <dt class="faint">Sandbox runtimes</dt><dd style="margin:0" class="perm-list"><span class="chip">QuickJS · WebAssembly</span><span class="chip">${a.microvm ? "Firecracker microVM · connected" : "Firecracker microVM · not running"}</span></dd>
        <dt class="faint">Connected systems</dt><dd style="margin:0" class="perm-list">${Object.values(TARGET).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</dd>
      </dl></div></div>`;
  } else {
    body = `<div class="card"><div class="card-h"><h3>Demo workspace</h3></div><div class="card-b grid" style="gap:12px">
      <p class="muted">Reseeds the database, restarts Agamemnon with a clean history, and issues new operator tokens.</p>
      <div><button class="btn danger" data-reset>Reset workspace</button></div>
      <p class="faint" style="font-size:12.5px">Postgres, Agamemnon and the plugin sandboxes are real. Stripe, GitHub, Datadog and the shipping-rates API are local stand-ins, and email goes to a file.</p>
    </div></div>`;
  }
  return `<div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="settings-nav"><a href="#/settings/team" class="${tab === "team" ? "on" : ""}">Team & access</a><a href="#/settings/agamemnon" class="${tab === "agamemnon" ? "on" : ""}">Agamemnon</a><a href="#/settings/workspace" class="${tab === "workspace" ? "on" : ""}">Workspace</a></div>
    ${body}`;
}

// --- shell ---------------------------------------------------------------------------------------------------

const NAV = [
  { group: null, items: [["home", "Home", ICON.home]] },
  { group: "Commerce", items: [["orders", "Orders", ICON.orders], ["customers", "Customers", ICON.users]] },
  { group: "Automation", items: [["agents", "Agents", ICON.bot], ["plugins", "Plugins", ICON.puzzle]] },
  { group: "Governance", items: [["approvals", "Approvals", ICON.inbox], ["audit", "Audit log", ICON.log]] },
];
const TITLES = { home: "Home", orders: "Orders", customers: "Customers", agents: "Agents", plugins: "Plugins", approvals: "Approvals", audit: "Audit log", settings: "Settings" };

function sidebar() {
  const count = pending().length;
  const me = PEOPLE[user];
  return `
    <div class="workspace"><img class="logo" src="/icon.svg" alt="" /><div><div class="name">Larkspur</div><div class="env">Production workspace</div></div></div>
    ${NAV.map(
      (g) => `<div class="${g.group ? "nav-group" : ""}">${g.group ? `<div class="nav-label">${g.group}</div>` : ""}<nav class="nav">${g.items
        .map(([id, label, icon]) => `<a href="#/${id}" class="${route.page === id ? "active" : ""}">${icon}${label}${id === "approvals" ? `<span class="count">${count || ""}</span>` : ""}</a>`)
        .join("")}</nav>${g.group === "Governance" ? `<div class="guard">${ICON.shield} Protected by Agamemnon</div>` : ""}</div>`,
    ).join("")}
    <div class="sidebar-foot">
      <nav class="nav"><a href="#/settings" class="${route.page === "settings" ? "active" : ""}">${ICON.settings}Settings</a></nav>
      <div style="position:relative">
        <button class="me" data-menu>${avatar(user)}<span class="who"><b>${esc(me.name)}</b><span>${esc(me.role)}</span></span></button>
        ${
          menuOpen
            ? `<div class="menu" style="bottom:48px;left:0"><div class="hd">Switch account</div>${Object.entries(PEOPLE)
                .map(([k, p]) => `<button data-user="${k}">${avatar(k, true)}<span><span>${esc(p.name)}</span><br><span class="sub">${esc(p.role)}</span></span>${k === user ? `<span class="tick">${ICON.check}</span>` : ""}</button>`)
                .join("")}</div>`
            : ""
        }
      </div>
    </div>`;
}

function crumbs() {
  const parts = [`<span>Larkspur</span>`, ICON.chevron, `<b>${TITLES[route.page]}</b>`];
  if (route.page === "agents" && route.arg && TASKS[route.arg]) parts.push(ICON.chevron, `<b>${esc(TASKS[route.arg].title)}</b>`);
  if (route.page === "plugins" && route.arg) {
    const p = PLUGINS.find((x) => x.scene === route.arg);
    if (p) parts.push(ICON.chevron, `<b>${esc(p.name)}</b>`);
  }
  return parts.join("");
}

function render() {
  $("#sidebar").innerHTML = sidebar();
  $("#crumbs").innerHTML = crumbs();
  if (!S) {
    $("#content").innerHTML = `<div class="empty">Loading…</div>`;
    return;
  }
  const page = { home, orders: () => listPage("orders"), customers: () => listPage("customers"), agents, plugins, approvals, audit, settings }[route.page] ?? home;
  const html = page();
  const el = $("#content");
  el.className = route.page === "agents" || route.page === "approvals" ? "content wide" : "content";
  const focused = document.activeElement && el.contains(document.activeElement) && document.activeElement.matches("input, select");
  if (html !== render.last && !focused) {
    el.innerHTML = html;
    render.last = html;
  }
  document.title = `${TITLES[route.page]} · Larkspur`;
}

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "") || "home";
  const [path, qs] = raw.split("?");
  const [page, arg] = path.split("/");
  route = { page: TITLES[page] ? page : "home", arg: arg ?? "", query: new URLSearchParams(qs ?? "") };
}

function setQuery(updates) {
  const q = new URLSearchParams(route.query);
  for (const [k, v] of Object.entries(updates)) v ? q.set(k, v) : q.delete(k);
  if (!("page" in updates)) q.delete("page");
  location.hash = `#/${route.page}${route.arg ? `/${route.arg}` : ""}${q.toString() ? `?${q}` : ""}`;
}

async function refresh() {
  try {
    S = await api("/api/state");
    if (S.epoch !== refresh.epoch) {
      refresh.epoch = S.epoch;
      cache.clear();
    }
    render();
  } catch {
    /* keep the last good state on screen */
  }
}

// --- events ---------------------------------------------------------------------------------------------------

document.addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-run],[data-decide],[data-copy],[data-menu],[data-user],[data-tab],[data-page],[data-reset]");
  if (!t) {
    if (menuOpen) {
      menuOpen = false;
      render();
    }
    return;
  }
  if (t.dataset.run) runScene(t.dataset.run);
  else if (t.dataset.decide) decide(t.dataset.id, t.dataset.decide);
  else if (t.dataset.copy) navigator.clipboard.writeText(t.dataset.copy).then(() => toast("Copied to clipboard"));
  else if (t.hasAttribute("data-menu")) {
    menuOpen = !menuOpen;
    render();
  } else if (t.dataset.user) setUser(t.dataset.user);
  else if (t.dataset.tab) location.hash = `#/approvals${t.dataset.tab === "all" ? "?tab=all" : ""}`;
  else if (t.dataset.page) setQuery({ page: t.dataset.page });
  else if (t.hasAttribute("data-reset")) {
    if (!confirm("Reset the workspace? This reseeds the database and restarts Agamemnon with new operator tokens.")) return;
    t.disabled = true;
    api("/api/reset", {})
      .then(() => toast("Workspace reset."))
      .catch((e) => toast(e.message, true))
      .finally(refresh);
  }
});

document.addEventListener("change", (ev) => {
  const f = ev.target.closest("[data-filter]");
  if (f && f.tagName === "SELECT") setQuery({ [f.dataset.filter]: f.value });
});
document.addEventListener("keydown", (ev) => {
  const f = ev.target.closest?.("[data-filter]");
  if (f && f.tagName === "INPUT" && ev.key === "Enter") {
    f.blur();
    setQuery({ [f.dataset.filter]: f.value.trim() });
  }
  if (ev.target.id === "q" && ev.key === "Enter") {
    const v = ev.target.value.trim();
    ev.target.blur();
    location.hash = `#/orders${v ? `?q=${encodeURIComponent(v)}` : ""}`;
  }
  if (ev.key === "/" && !ev.target.matches("input, textarea, select")) {
    ev.preventDefault();
    $("#q").focus();
  }
  if (ev.key === "Escape" && menuOpen) {
    menuOpen = false;
    render();
  }
});
window.addEventListener("hashchange", () => {
  parseRoute();
  menuOpen = false;
  render();
  if (route.page !== "agents" && route.page !== "approvals") scrollTo(0, 0);
});

parseRoute();
render();
refresh();
setInterval(refresh, 2000);
