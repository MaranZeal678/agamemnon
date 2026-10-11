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

/**
 * The broker's operator console and approval page — self-contained HTML, no
 * build step, no external assets. Every action calls the authenticated API;
 * the operator token lives in this browser only.
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

export function consolePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agamemnon Broker</title><style>${STYLE}</style></head><body>
<script>${SHARED_JS}
let STATE=null,TAB="queue",SEL=null,ME=null;
const TABS=[["queue","Approvals"],["feed","All effects"],["tasks","Tasks"],["claims","Claims"],["oversight","Oversight"],["holds","Holds"],["artifacts","Artifacts"],["fleet","Fleet"],["rules","Suggestions"],["audit","Audit & receipts"]];
function shell(){document.body.innerHTML='<header><div><div class="brand">AGA<b>MEMNON</b></div><div class="tag">preview → bind → admit by reversibility → verify</div></div><div class="row" id="hdr"></div></header><nav id="nav"></nav><main id="main"></main>';
$("#nav").innerHTML=TABS.map(([k,l])=>'<button data-t="'+k+'">'+l+'</button>').join("");$("#nav").onclick=e=>{const t=e.target.dataset.t;if(t){TAB=t;SEL=null;draw()}}}
function effectCard(e,full){const rev=REV[e.reversibility]||[e.reversibility||"—",""];const sel=SEL===e.id;
let h='<div class="card'+(sel?" sel":"")+'" data-e="'+esc(e.id)+'"><div class="row"><span class="pill '+(ST[e.status]||"")+'">'+esc(e.status.replace(/_/g," "))+'</span><span class="pill '+rev[1]+'">'+esc(rev[0])+'</span>'+(e.fidelity&&e.fidelity!=="exact"?'<span class="pill warn">'+esc(e.fidelity)+' preview</span>':'')+(e.env?'<span class="pill">'+esc(e.env)+'</span>':'')+(e.oversight&&e.oversight.length?'<span class="pill bad">reduces oversight</span>':'')+'<span class="sp"></span><span class="sub">'+ago(e.createdAt)+'</span></div>';
h+='<div class="title" style="margin-top:6px">'+esc(e.summary)+'</div><div class="sub mono">'+esc(e.operation)+' · '+esc(e.resource)+' · '+esc(e.agent)+(e.rootOwner?' for '+esc(e.rootOwner):'')+'</div>';
if(sel||full){h+='<div style="margin-top:8px">'+counts(e.counts)+'</div><h3 style="margin-top:12px">Fired rules → '+esc((e.wouldDecision||e.decision||"").toUpperCase())+'</h3>'+rules(e.firedRules);
if(e.sample&&e.sample.length)h+='<h3 style="margin-top:12px">Sample (measured, PII masked)</h3>'+sample(e.sample);
if(e.approvals&&e.approvals.length)h+='<div class="sub" style="margin-top:8px">decisions: '+e.approvals.map(a=>esc(a.approver)+' '+esc(a.decision)+'d').join(", ")+'</div>';
if(e.status==="awaiting_approval")h+='<h3 style="margin-top:12px">Decide · needs '+esc(e.requiredApprovals)+' independent approver'+(e.requiredApprovals>1?'s':'')+'</h3><textarea rows="2" id="note-'+esc(e.id)+'" placeholder="note (recorded in the audit chain)"></textarea><div class="row" style="margin-top:8px"><button class="b gold" data-act="approve" data-id="'+esc(e.id)+'">Approve this exact effect</button><button class="b red" data-act="deny" data-id="'+esc(e.id)+'">Deny</button></div>';
if(e.status==="executed"&&e.reversibility!=="irreversible")h+='<div class="row" style="margin-top:10px"><button class="b" data-act="undo" data-id="'+esc(e.id)+'">Reverse this effect</button></div>';
if(e.status==="held")h+='<div class="row" style="margin-top:10px"><span class="sub">executes '+(e.holdUntil?ago(e.holdUntil).replace(" ago",""):"")+' unless cancelled</span><button class="b red" data-act="cancel" data-id="'+esc(e.id)+'">Cancel inside the window</button></div>';
if(e.error)h+='<div class="err">'+esc(e.error)+'</div>';h+='<div class="err" id="err-'+esc(e.id)+'"></div>'}
return h+'</div>'}
function draw(){if(!STATE)return;const S=STATE;
$("#hdr").innerHTML='<span class="pill '+(S.mode==="shadow"?"gold":"ok")+'">'+esc(S.mode)+' mode</span><span class="pill '+(S.chain.ok?"ok":"bad")+'">'+(S.chain.ok?"audit chain verified · "+fmt(S.chain.checked):"AUDIT CHAIN BROKEN at #"+esc(S.chain.brokenAt&&S.chain.brokenAt.seq))+'</span><span class="pill">'+esc(S.me.name)+' · '+esc(S.me.role)+'</span><button class="b" id="out">sign out</button>';
$("#out").onclick=()=>{try{localStorage.removeItem("agm.broker.op")}catch(e){}location.reload()};
[...$("#nav").children].forEach(b=>b.classList.toggle("on",b.dataset.t===TAB));const M=$("#main");let h="";
if(TAB==="queue"){const q=S.effects.filter(e=>e.status==="awaiting_approval");h=q.length?q.map(e=>effectCard(e,true)).join(""):'<div class="empty">Nothing is waiting for a human. Effects that need approval appear here with their measured blast radius.</div>'}
if(TAB==="feed")h=S.effects.map(e=>effectCard(e,false)).join("")||'<div class="empty">No effects yet.</div>';
if(TAB==="tasks")h='<div class="card scroll"><table><tr><th>task</th><th>agent</th><th>for</th><th>goal</th><th>taint</th><th>status</th><th></th></tr>'+S.tasks.map(t=>'<tr><td class="mono">'+esc(t.id)+(t.parentId?'<div class="sub">sub-task of '+esc(t.parentId)+'</div>':'')+'</td><td>'+esc(t.agent)+'</td><td>'+esc(t.rootOwner)+'</td><td>'+esc(t.goal||"")+'</td><td>'+(t.taint.readUntrusted?'<span class="pill bad">untrusted</span> '+t.taint.untrustedSources.map(src=>'<button class="b" data-act="poisoned" data-id="'+esc(src)+'" title="find every effect that depended on this source">'+esc(src)+'</button>').join(" ")+' ':'')+(t.taint.readPrivate?'<span class="pill warn">private</span>':'')+'</td><td>'+esc(t.status)+'</td><td><button class="b" data-act="revert" data-id="'+esc(t.id)+'">Revert task</button></td></tr>').join("")+'</table></div><div class="sub">Revert restores only rows still exactly as the task left them — later human edits are skipped and reported (selective repair, after Retro/Warp/Aire).</div>';
if(TAB==="claims")h='<div class="card scroll"><table><tr><th>when</th><th>agent</th><th>claim</th><th>verdict</th><th>evidence (from systems of record)</th></tr>'+S.claims.map(c=>'<tr><td>'+ago(c.at)+'</td><td>'+esc(c.agent)+'</td><td class="mono">'+esc(c.claim&&c.claim.type)+' = '+esc(JSON.stringify(c.claim&&c.claim.value))+(c.claim&&c.claim.source==="extracted"?' <span class="pill">extracted</span>':'')+'</td><td><span class="pill '+(c.status==="verified"?"ok":c.status==="contradicted"?"bad":"")+'">'+esc(c.status)+'</span></td><td class="sub">'+esc(c.evidence)+'</td></tr>').join("")+'</table></div><div class="card"><h3>Agent trust</h3>'+S.principals.filter(p=>p.kind!=="human").map(p=>'<div class="row"><span class="mono">'+esc(p.name)+'</span><span class="sub">owner '+esc(p.owner||"—")+'</span><span class="pill '+(p.status==="suspended"?"bad":p.contradictions?"warn":"ok")+'">'+(p.status==="suspended"?"suspended":p.contradictions?"supervised · "+p.contradictions:"normal")+'</span>'+(p.contradictions?'<button class="b" data-act="reinstate" data-id="'+esc(p.name)+'">Reinstate</button>':'')+'</div>').join("")+'</div>';
if(TAB==="oversight"){const o=S.effects.filter(e=>e.oversight&&e.oversight.length);h='<div class="sub" style="margin-bottom:10px">Actions that reduce oversight — tests deleted or skipped, CI failures masked, alerts muted, audit trails stopped, an agent editing its own permissions. Always two humans, never learned.</div>'+(o.map(e=>effectCard(e,true)).join("")||'<div class="empty">No oversight-reducing actions.</div>')}
if(TAB==="holds"){const o=S.effects.filter(e=>e.status==="held"||e.status==="cancelled");h=o.map(e=>effectCard(e,true)).join("")||'<div class="empty">No held effects. Irreversible effects a connector can defer (email, refunds, platform deletes) wait here for their cancel window.</div>'}
if(TAB==="artifacts")h='<div class="card scroll"><table><tr><th>artifact</th><th>system</th><th>task</th><th>durable access</th><th>state</th><th></th></tr>'+S.artifacts.map(a=>'<tr><td class="mono">'+esc(a.kind)+' '+esc(a.id)+'</td><td>'+esc(a.system)+'</td><td class="mono">'+esc(a.taskId)+'</td><td>'+(a.durableAccess?"yes":"no")+'</td><td>'+(a.revokedAt?'<span class="pill">revoked</span>':a.promotedBy?'<span class="pill gold">kept by '+esc(a.promotedBy)+'</span>':'<span class="pill warn">expires at task end</span>')+'</td><td>'+(!a.revokedAt&&!a.promotedBy&&a.durableAccess?'<button class="b" data-act="promote" data-id="'+esc(a.id)+'">Keep</button>':'')+'</td></tr>').join("")+'</table></div>';
if(TAB==="fleet")h='<div class="grid"><div><div class="card"><h3>Preview fidelity by connector</h3>'+(Object.entries(S.fidelity).map(([k,v])=>'<div class="row"><span class="mono">'+esc(k)+'</span><span class="sp"></span><span class="pill '+(v.mean>=0.98?"ok":"warn")+'">'+(v.mean*100).toFixed(1)+'% · '+v.samples+' samples</span></div>').join("")||'<div class="sub">no executions yet</div>')+'</div><div class="card"><h3>Policy changes (two people)</h3>'+((S.policyChanges||[]).map(p=>'<div class="row"><span class="mono">'+esc(p.id)+'</span><span class="sub">'+esc(p.requested_by)+' · '+esc(JSON.stringify(p.change).slice(0,80))+'</span><span class="sp"></span>'+(p.status==="pending"?'<button class="b gold" data-act="pc-approve" data-id="'+esc(p.id)+'">Approve</button><button class="b red" data-act="pc-reject" data-id="'+esc(p.id)+'">Reject</button>':'<span class="pill">'+esc(p.status)+(p.decided_by?' by '+esc(p.decided_by):'')+'</span>')+'</div>').join("")||'<div class="sub">no policy changes</div>')+'</div><div class="card"><h3>Leases (serialised writers)</h3>'+(S.leases.map(l=>'<div class="mono">'+esc(l.key)+' ← '+esc(l.taskId)+'</div>').join("")||'<div class="sub">none</div>')+'</div></div><div><div class="card"><h3>Reviewers (rubber-stamp telemetry)</h3>'+(S.reviewers.map(r=>'<div class="row"><b>'+esc(r.approver)+'</b><span class="sub">'+r.decisions+' decisions · '+(r.approvalRate*100).toFixed(0)+'% approve · median '+r.medianSecondsToDecide.toFixed(0)+'s · '+r.fastApprovals+' under 3s · canaries '+r.canariesCaught+'/'+r.canariesSeen+' caught</span></div>').join("")||'<div class="sub">no decisions yet</div>')+'<div class="row" style="margin-top:8px"><button class="b" data-act="canary">Plant a reviewer canary</button></div></div><div class="card"><h3>Bypass coverage</h3>'+(S.coverage.map(c=>'<div class="sub"><span class="mono">'+esc(c.kind)+'</span> · '+esc(c.source)+' · '+esc(c.detail)+'</div>').join("")||'<div class="sub">no bypass attempts observed</div>')+'</div></div></div>';
if(TAB==="rules")h='<div class="sub" style="margin-bottom:10px">Request shapes approved 3+ times with zero reversals. Accepting creates an allow rule that expires in 30 days and is revoked automatically on any reversal. Never offered for oversight-reducing or irreversible effects.</div>'+(S.suggestions.map(s=>'<div class="card"><div class="row"><span class="mono">'+esc(s.operation)+'</span><span class="sub">'+s.approvals+' approvals</span><span class="sp"></span>'+(s.accepted?'<span class="pill ok">accepted</span>':'<button class="b" data-act="accept" data-id="'+esc(s.fingerprint)+'">Accept allow rule</button>')+'</div><div class="sub">'+esc(s.example)+'</div></div>').join("")||'<div class="empty">No suggestions yet.</div>');
if(TAB==="audit")h='<div class="row" style="margin-bottom:10px"><button class="b" data-act="export">Export audit chain (JSONL)</button><button class="b" data-act="receipts">Export signed receipts</button><button class="b" data-act="verifyr">Verify receipts</button><span id="vr" class="sub"></span></div><div class="card scroll"><table><tr><th>#</th><th>when</th><th>kind</th><th>actor</th><th>detail</th></tr>'+S.audit.map(a=>'<tr><td class="mono" title="'+esc(a.hash)+'">'+a.seq+'</td><td>'+ago(a.at)+'</td><td><span class="pill">'+esc(a.kind)+'</span></td><td>'+esc(a.actor||"")+'</td><td class="sub">'+esc(a.detail)+'</td></tr>').join("")+'</table></div>';
M.innerHTML=h}
document.addEventListener("click",async e=>{const card=e.target.closest(".card[data-e]");const b=e.target.closest("button[data-act]");
if(b){e.stopPropagation();const id=b.dataset.id,act=b.dataset.act;const errEl=id&&$("#err-"+CSS.escape(id));b.disabled=true;try{
if(act==="approve"||act==="deny")await api("/v1/effects/"+id+"/"+act,{note:($("#note-"+CSS.escape(id))||{}).value||""});
if(act==="undo"){try{await api("/v1/effects/"+id+"/undo",{})}catch(x){if(/force/.test(x.message)&&confirm(x.message+"\\n\\nRevert anyway?"))await api("/v1/effects/"+id+"/undo",{force:true});else throw x}}if(act==="cancel")await api("/v1/effects/"+id+"/cancel",{});
if(act==="revert"){if(!confirm("Revert everything task "+id+" (and its sub-tasks) did? Later human edits are preserved."))return;let r;try{r=await api("/v1/tasks/"+id+"/revert",{})}catch(x){if(/force/.test(x.message)&&confirm(x.message+"\\n\\nRevert anyway?"))r=await api("/v1/tasks/"+id+"/revert",{force:true});else throw x}alert(r.summary.map(s=>s.system+": "+s.detail).join("\\n")||"nothing to revert")}
if(act==="poisoned"){const r=await api("/v1/taint/dependents?source="+encodeURIComponent(id));alert(r.tasks.length?r.tasks.map(t=>t.taskId+" ("+t.agent+" for "+t.rootOwner+"): "+t.effects.length+" effect(s)\\n"+t.effects.map(e=>"  - "+e.operation+": "+e.summary).join("\\n")).join("\\n\\n")+"\\n\\nRevert each task from the Tasks tab.":"no task read from "+id)}
if(act==="pc-approve")await api("/v1/policy-changes/"+id+"/approve",{});if(act==="pc-reject")await api("/v1/policy-changes/"+id+"/reject",{});
if(act==="promote")await api("/v1/artifacts/"+id+"/promote",{});if(act==="accept")await api("/v1/suggestions/"+encodeURIComponent(id)+"/accept",{});
if(act==="reinstate")await api("/v1/principals/"+id+"/reinstate",{});if(act==="canary")await api("/v1/admin/canary",{});
if(act==="export"){let after=-1,lines=[];for(;;){const p=await api("/v1/audit?after="+after+"&limit=5000");p.rows.forEach(r=>lines.push(JSON.stringify(r)));if(p.rows.length<5000)break;after=p.rows[p.rows.length-1].seq}dl("agamemnon-audit.jsonl",lines.join("\\n")+"\\n")}
if(act==="receipts"){const r=await api("/v1/receipts");dl("agamemnon-receipts.json",JSON.stringify(r,null,2))}
if(act==="verifyr"){const v=await api("/v1/receipts/verify");$("#vr").textContent=v.ok?"✓ "+v.checked+" receipts: signatures and chain valid":"✗ broken at "+v.brokenAt.index+": "+v.brokenAt.reason}
await refresh()}catch(x){if(errEl)errEl.textContent=x.message;else alert(x.message)}finally{b.disabled=false}return}
if(card&&!e.target.closest("textarea")){SEL=SEL===card.dataset.e?null:card.dataset.e;draw()}});
function dl(name,text){const u=URL.createObjectURL(new Blob([text]));const a=document.createElement("a");a.href=u;a.download=name;a.click();URL.revokeObjectURL(u)}
async function refresh(){try{STATE=await api("/v1/console/state");const f=document.activeElement;if(f&&f.tagName==="TEXTAREA")return;draw()}catch(e){if(/token/.test(e.message))location.reload()}}
async function start(w){ME=w;shell();await refresh();setInterval(refresh,2000)}
if(!TOKEN)signin(start);else api("/v1/whoami").then(w=>w.role?start(w):signin(start)).catch(()=>signin(start));
</script></body></html>`;
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
