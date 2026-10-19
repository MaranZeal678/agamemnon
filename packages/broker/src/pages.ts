// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * The broker's home page and approval page — self-contained HTML, no build
 * step, no external assets. Every action calls the authenticated API; the
 * operator token lives in this browser only. A full operator console plugs in
 * as an extension (see extensions.ts) and serves "/" and "/console" instead.
 */

const STYLE = `
:root{--bg:#0b0d12;--panel:#12151d;--panel2:#171b25;--line:#252a36;--text:#e7e3d6;--muted:#9a9583;--dim:#6d6a5e;
--gold:#e8b93e;--gold2:#f3d27a;--red:#ef5b4c;--amber:#f0a43a;--green:#5fc28a;--blue:#6aa6ff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f7f5ef;--panel:#ffffff;--panel2:#f1eee5;--line:#e2ddcf;--text:#1f1d18;--muted:#6b6658;--dim:#8f8a7b;--gold:#a8780f;--gold2:#8a6209}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2;flex-wrap:wrap}
.brand{font-weight:800;letter-spacing:.14em}.brand b{color:var(--gold)}.tag{color:var(--muted);font-size:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.pill.ok{color:var(--green);border-color:color-mix(in srgb,var(--green) 40%,transparent)}.pill.bad{color:var(--red);border-color:color-mix(in srgb,var(--red) 40%,transparent)}
.pill.warn{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 40%,transparent)}.pill.gold{color:var(--gold);border-color:color-mix(in srgb,var(--gold) 40%,transparent)}
nav{display:flex;gap:4px;padding:8px 16px;border-bottom:1px solid var(--line);overflow-x:auto}
nav button{background:none;border:0;color:var(--muted);padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit;white-space:nowrap}
nav button.on{background:var(--panel2);color:var(--text)}
main{padding:16px 20px;max-width:1280px;margin:0 auto}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:16px}@media (max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.card.sel{border-color:var(--gold)}.card h3{margin:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sp{flex:1}
.title{font-weight:600}.sub{color:var(--muted);font-size:12.5px}.mono{font-family:var(--mono);font-size:12.5px}
.rule{display:flex;gap:8px;padding:6px 0;border-top:1px solid var(--line)}.rule:first-child{border-top:0}
.sev{font-size:11px;text-transform:uppercase;font-weight:700;min-width:64px}.sev.block{color:var(--red)}.sev.approval{color:var(--amber)}.sev.allow{color:var(--green)}
button.b{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:7px;padding:6px 12px;cursor:pointer;font:inherit}
button.b:hover{border-color:var(--gold)}button.b.gold{background:var(--gold);color:#16130b;border-color:var(--gold);font-weight:700}
button.b.red{color:var(--red)}button.b:disabled{opacity:.5;cursor:default}
input,textarea{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:7px;padding:7px 9px;font:inherit;width:100%}
table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
.scroll{overflow-x:auto}.empty{color:var(--dim);padding:20px 0}.err{color:var(--red);font-size:13px;margin-top:8px}
.big{font-size:30px;font-weight:800}.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px}.kv div:nth-child(odd){color:var(--muted)}
.signin{max-width:440px;margin:12vh auto;padding:0 16px;text-align:center}
`;

const SHARED_JS = `
const $=(s,r=document)=>r.querySelector(s);const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt=n=>Number(n||0).toLocaleString();const ago=t=>{const s=Math.max(0,(Date.now()-t)/1000);return s<60?Math.round(s)+"s ago":s<3600?Math.round(s/60)+"m ago":new Date(t).toLocaleString()};
let TOKEN="";try{TOKEN=localStorage.getItem("agm.broker.op")||""}catch(e){}
async function api(path,body){const r=await fetch(path,{method:body?"POST":"GET",headers:{"content-type":"application/json",authorization:"Bearer "+TOKEN},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j}
function signin(onok){document.body.innerHTML='<div class="signin"><div class="brand" style="font-size:26px">AGA<b>MEMNON</b></div><div class="tag" style="margin:6px 0 18px">operator sign-in · effect-typed reference monitor</div><input id="tok" type="password" placeholder="agm_op_…" autofocus><div class="err" id="e"></div><p style="margin-top:12px"><button class="b gold" id="go">Sign in</button></p><p class="sub">Approvals are attributed to you. The human who launched an agent can never approve its requests.</p></div>';
const go=async()=>{TOKEN=$("#tok").value.trim();try{const w=await api("/v1/whoami");if(!w.role)throw new Error("that is an agent token, not an operator token");try{localStorage.setItem("agm.broker.op",TOKEN)}catch(e){}onok(w)}catch(e){$("#e").textContent=e.message}};$("#go").onclick=go;$("#tok").onkeydown=e=>{if(e.key==="Enter")go()}}
const REV={undo:["undo","ok"],compensate:["compensate","warn"],hold:["hold · cancellable","gold"],irreversible:["irreversible","bad"]};
const ST={executed:"ok",admitted:"ok",held:"gold",awaiting_approval:"warn",blocked:"bad",denied:"bad",failed:"bad",drifted:"bad",reverted:"",cancelled:"",shadowed:"gold","canary-caught":"ok","canary-missed":"bad"};
function rules(rs){return (rs||[]).map(r=>'<div class="rule"><span class="sev '+esc(r.severity)+'">'+esc(r.level?r.level:r.severity)+'</span><div><div class="mono">'+esc(r.name)+'</div><div class="sub">'+esc(r.detail)+'</div></div></div>').join("")||'<div class="sub">no rules fired</div>'}
function counts(c){return Object.entries(c||{}).map(([k,v])=>'<span class="pill">'+esc(k)+' '+fmt(v)+'</span>').join(" ")}
function sample(s){if(!s||!s.length)return "";const cols=Object.keys(s[0]).slice(0,7);return '<div class="scroll"><table><tr>'+cols.map(c=>'<th>'+esc(c)+'</th>').join("")+'</tr>'+s.map(r=>'<tr>'+cols.map(c=>'<td class="mono">'+esc(typeof r[c]==="object"?JSON.stringify(r[c]):r[c])+'</td>').join("")+'</tr>').join("")+'</table></div>'}
`;

export function homePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agamemnon Broker</title><style>${STYLE}</style></head><body>
<header><div><div class="brand">AGA<b>MEMNON</b></div><div class="tag">preview → bind → admit by reversibility → verify</div></div></header>
<main style="max-width:760px"><div class="card"><div class="title">The broker is running.</div>
<div class="sub" style="margin-top:8px">Approvals are bound to the measured effect. Approval links from agents (MCP) and the webhook open <span class="mono">/approve/&lt;effect id&gt;</span>, where an operator signs in and decides.</div>
<h3 style="margin-top:14px">From a terminal</h3>
<div class="sub mono">export AGAMEMNON_OPERATOR_TOKEN=…<br>agamemnon pending<br>agamemnon approve &lt;effect id&gt; [--note "…"]<br>agamemnon deny &lt;effect id&gt; [--note "…"]</div>
<h3 style="margin-top:14px">API</h3>
<div class="sub mono">GET /health · /v1/* (Authorization: Bearer &lt;token&gt;)</div>
<div class="sub" style="margin-top:14px">A full operator console can be added as a broker extension (AGAMEMNON_EXTENSIONS).</div></div></main>
</body></html>`;
}

export function approvePage(effectId: string): string {
  const safeId = effectId.replace(/[^\w-]/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agamemnon Approval</title><style>${STYLE}</style></head><body>
<script>${SHARED_JS}
const ID=${JSON.stringify(safeId)};
async function show(){const e=await api("/v1/effects/"+ID);const d=e.detail;const rev=REV[e.reversibility]||[e.reversibility,""];
document.body.innerHTML='<header><div><div class="brand">AGA<b>MEMNON</b></div><div class="tag">approve exactly this measured effect</div></div></header><main style="max-width:760px"><div class="card"><div class="row"><span class="pill '+(ST[e.status]||"")+'">'+esc(e.status.replace(/_/g," "))+'</span><span class="pill '+rev[1]+'">'+esc(rev[0])+'</span><span class="pill">'+esc(e.fidelity)+' preview</span></div><div class="big" style="margin-top:8px">'+esc(e.summary)+'</div><div class="sub mono">'+esc(d.operation)+' · '+esc(d.resource)+' · requested by '+esc(d.agent)+' for '+esc(d.effect.request.delegation.rootOwner)+'</div><div style="margin-top:8px">'+counts(e.counts)+'</div><h3 style="margin-top:14px">Why it needs you</h3>'+rules(e.firedRules)+(d.effect.preview.sample?'<h3 style="margin-top:12px">Sample</h3>'+sample(d.effect.preview.sample):'')+'<div class="sub" style="margin-top:12px">Your approval is cryptographically bound to this measurement (binding '+esc((d.binding&&d.binding.bindingHash||"").slice(0,16))+'…). If the target changes before execution, nothing runs.</div>'+(e.status==="awaiting_approval"?'<textarea id="n" rows="2" style="margin-top:12px" placeholder="note"></textarea><div class="row" style="margin-top:8px"><button class="b gold" id="a">Approve</button><button class="b red" id="d">Deny</button></div>':'')+'<div class="err" id="e"></div></div></main>';
const act=async k=>{try{await api("/v1/effects/"+ID+"/"+k,{note:$("#n").value});show()}catch(x){$("#e").textContent=x.message}};if($("#a")){$("#a").onclick=()=>act("approve");$("#d").onclick=()=>act("deny")}}
if(!TOKEN)signin(show);else show().catch(()=>signin(show));
</script></body></html>`;
}
