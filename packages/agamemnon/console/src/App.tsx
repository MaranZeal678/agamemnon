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

import { createContext, useContext, useState } from "react";
import { useQuery, useMutation, useAction, useConvex } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Tab = "live" | "audit" | "eval";

// ── Operator session ────────────────────────────────────────────────────────
// Every console query and mutation is authenticated with the operator's token.
// The token is kept in this browser only (localStorage) — a convenience, not
// the security boundary; Convex re-checks it on every call.
const TOKEN_KEY = "agm.operatorToken";
const TokenCtx = createContext<string>("");
const useToken = () => useContext(TokenCtx);

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function App() {
  const [token, setToken] = useState<string>(readToken);
  const me = useQuery(api.core.whoami, token ? { operatorToken: token } : "skip");
  const signOut = () => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
    setToken("");
  };
  if (!token || me === null) {
    return <SignIn invalid={!!token && me === null} onToken={(t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ } setToken(t); }} />;
  }
  if (me === undefined) return <div className="app"><div className="empty-hint" style={{ padding: 40 }}>connecting to Agamemnon…</div></div>;
  return (
    <TokenCtx.Provider value={token}>
      <Shell me={me} signOut={signOut} />
    </TokenCtx.Provider>
  );
}

function SignIn({ onToken, invalid }: { onToken: (t: string) => void; invalid: boolean }) {
  const [value, setValue] = useState("");
  return (
    <div className="app">
      <div className="signin">
        <div className="ag-word" style={{ fontSize: 28 }}>AGA<b>MEMNON</b></div>
        <div className="ag-tag" style={{ marginBottom: 22 }}>operator sign-in</div>
        <p style={{ color: "var(--muted)", fontSize: 13, maxWidth: 420 }}>
          Paste your operator token (for the local demo: <code>AGAMEMNON_OPERATOR_ALICE_TOKEN</code> from <code>.env</code>).
          Approvals are attributed to the operator who signs in, and the human who launched an agent can never approve its requests.
        </p>
        <input
          className="note-input"
          type="password"
          autoFocus
          placeholder="agm_op_…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onToken(value.trim()); }}
          style={{ width: 420, marginTop: 10 }}
        />
        {invalid && <div style={{ color: "var(--red)", fontSize: 13, marginTop: 8 }}>That token is unknown or revoked.</div>}
        <div style={{ marginTop: 12 }}>
          <button className="btn gold" disabled={!value.trim()} onClick={() => onToken(value.trim())}>Sign in</button>
        </div>
      </div>
    </div>
  );
}

function Shell({ me, signOut }: { me: { name: string; role: string }; signOut: () => void }) {
  const operatorToken = useToken();
  const [tab, setTab] = useState<Tab>("live");
  const [selected, setSelected] = useState<Id<"actions"> | null>(null);
  const latestRun = useQuery(api.core.latestRun, { operatorToken });
  const killRun = useMutation(api.core.killRun);

  return (
    <div className="app">
      <header className="ag-header">
        <div className="ag-brand">
          <div className="ag-sigil">
            <svg viewBox="0 0 40 40" fill="none">
              {/* a stylized gate / watchtower sigil */}
              <path d="M20 3 L34 11 L34 30 L20 37 L6 30 L6 11 Z" stroke="#e8b93e" strokeWidth="1.6" />
              <path d="M20 3 L20 37 M6 11 L34 11 M6 30 L34 30" stroke="#6b5a26" strokeWidth="1" />
              <circle cx="20" cy="20.5" r="4.2" fill="#e8b93e" />
            </svg>
          </div>
          <div>
            <div className="ag-word">
              AGA<b>MEMNON</b>
            </div>
            <div className="ag-tag">the watcher at the gate</div>
          </div>
        </div>
        <div className="ag-right">
          <div className="ag-conn">
            <span className={latestRun === undefined ? "dot off" : "dot"} />
            {latestRun === undefined ? "connecting…" : "live · reactive"}
          </div>
          <div className="ag-conn" title="signed-in operator">
            {me.name} · {me.role}
            <button className="btn" style={{ marginLeft: 8, padding: "2px 8px" }} onClick={signOut}>sign out</button>
          </div>
          <button
            className="btn kill"
            disabled={!latestRun || latestRun.status !== "running" || me.role === "auditor"}
            onClick={() => latestRun && killRun({ runId: latestRun._id, operatorToken })}
          >
            Kill Run
          </button>
        </div>
      </header>

      <div className="ag-tabs">
        <div className={"ag-tab" + (tab === "live" ? " active" : "")} onClick={() => setTab("live")}>
          Live
        </div>
        <div className={"ag-tab" + (tab === "audit" ? " active" : "")} onClick={() => setTab("audit")}>
          Audit
        </div>
        <div className={"ag-tab" + (tab === "eval" ? " active" : "")} onClick={() => setTab("eval")}>
          Eval
        </div>
      </div>

      {tab === "live" && <LiveView selected={selected} setSelected={setSelected} />}
      {tab === "audit" && <AuditView />}
      {tab === "eval" && <EvalView />}
    </div>
  );
}

// ── Live view: feed + detail ────────────────────────────────────────────────
function LiveView({
  selected,
  setSelected,
}: {
  selected: Id<"actions"> | null;
  setSelected: (id: Id<"actions">) => void;
}) {
  const operatorToken = useToken();
  const feed = useQuery(api.core.consoleFeed, { operatorToken, limit: 40 });

  return (
    <div className="ag-body">
      <div className="ag-feed">
        <div className="section-label">Action feed · newest first</div>
        {feed === undefined && <div className="empty-hint">connecting to Agamemnon…</div>}
        {feed && feed.length === 0 && (
          <div className="empty-hint">No actions yet. Run the agent to see proposals arrive here.</div>
        )}
        {feed?.map((a) => (
          <ActionCard key={a._id} a={a} selected={selected === a._id} onClick={() => setSelected(a._id)} />
        ))}
      </div>
      <div className="ag-detail">
        {selected ? <DetailPanel actionId={selected} /> : <div className="detail-empty">Select an action to inspect the decision.</div>}
      </div>
    </div>
  );
}

function StatusBadge({ status, decision }: { status: string; decision?: string | null }) {
  const label = status === "awaiting_approval" ? "awaiting approval" : status;
  const cls =
    status === "blocked" ? "block" :
    status === "awaiting_approval" ? "approval" :
    status === "executed" || status === "approved" ? "executed" :
    status === "classifying" ? "classifying" :
    status === "failed" ? "failed" :
    status === "shadowed" ? "approval" :
    status === "denied" || status === "undone" || status === "logged" ? "denied" : "";
  return <span className={"badge " + cls}>{label}</span>;
}

function ActionCard({ a, selected, onClick }: { a: any; selected: boolean; onClick: () => void }) {
  const isDelete = a.tool === "postgres.delete";
  return (
    <div className={`action ${a.status}${selected ? " sel" : ""}`} onClick={onClick}>
      <div className="action-top">
        <span className="action-tool">
          #{a.seq} · {a.tool}
        </span>
        <StatusBadge status={a.status} decision={a.decision} />
      </div>
      <div className="action-title">
        {isDelete ? (
          <>
            delete on <span style={{ fontFamily: "var(--mono)" }}>{a.target}</span>
            {a.estimatedRows > 0 && (
              <> · <b style={{ color: a.decision === "block" ? "var(--red)" : "var(--amber)" }}>{a.estimatedRows.toLocaleString()}</b> rows</>
            )}
          </>
        ) : a.tool === "reason" ? (
          <span style={{ color: "var(--muted)", fontWeight: 400 }}>{a.note}</span>
        ) : a.tool === "postgres.undo" ? (
          <span style={{ color: "var(--gold-2)" }}>{a.note}</span>
        ) : (
          <span style={{ color: a.status === "failed" ? "var(--red)" : "var(--muted)", fontWeight: 400 }}>
            {a.note || a.predicateSql}
          </span>
        )}
      </div>
      <div className="action-sub">{a.agent}</div>
    </div>
  );
}

function highlightSql(sql: string) {
  // Highlight the subtle bug (l.id::text — should be l.ref) in red.
  const bug = "l.id::text";
  const idx = sql.indexOf(bug);
  const kw = (s: string) =>
    s.replace(/\b(DELETE|FROM|WHERE|SELECT|LEFT JOIN|JOIN|IS NULL|AND|OR|IN|NOT|EXISTS|ORDER BY|LIMIT|INSERT INTO|VALUES|OVERRIDING SYSTEM VALUE)\b/g, "$1");
  const render = (s: string, key: number) =>
    kw(s)
      .split(/|/)
      .map((seg, i) =>
        i % 2 === 1 ? <span className="kw" key={`${key}-${i}`}>{seg}</span> : <span key={`${key}-${i}`}>{seg}</span>,
      );
  if (idx === -1) return <>{sql}</>;
  return (
    <>
      {sql.slice(0, idx)}
      <span className="bug">{bug}</span>
      {sql.slice(idx + bug.length)}
    </>
  );
}

function DetailPanel({ actionId }: { actionId: Id<"actions"> }) {
  const operatorToken = useToken();
  const ctx = useQuery(api.core.actionContext, { operatorToken, actionId });
  const approve = useMutation(api.core.approve);
  const deny = useMutation(api.core.deny);
  const undo = useAction(api.execute.undo);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(String(e?.data ?? e?.message ?? e).replace(/^.*Uncaught Error: /s, "").split("\n")[0]);
    } finally {
      setBusy(false);
    }
  };

  if (ctx === undefined) return <div className="detail-empty">loading…</div>;
  if (ctx === null || !ctx.action) return <div className="detail-empty">action not found</div>;
  const a = ctx.action;
  const median = ctx.agentMedian || 1;
  const isDelete = a.tool === "postgres.delete";
  const decisionColor =
    a.decision === "block" ? "red" : a.decision === "approval" ? "warn" : "safe";

  return (
    <div>
      <div className="section-label">Action #{a.seq} · {a.tool}</div>

      {isDelete && (
        <>
          <div className="card">
            <h3>Proposed statement</h3>
            <div className="sql">{highlightSql(a.predicateSql)}</div>
          </div>

          <div className="card">
            <h3>Blast radius — measured by Agamemnon, not claimed by the agent</h3>
            <div className="blast">
              <span className={`measured ${decisionColor}`}>{a.estimatedRows.toLocaleString()}</span>
              <span className="vs">rows measured</span>
              <span className="claimed-strike">agent claimed {a.agentClaimedRows.toLocaleString()}</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--muted)" }}>
              agent 30-day median <b style={{ color: "var(--text)" }}>{median.toLocaleString()}</b> ·{" "}
              this is <span className="ratio">{a.ratioToMedian ? a.ratioToMedian.toFixed(1) : "—"}×</span> the median
            </div>
          </div>

          {a.classifier && (
            <div className="card">
              <h3>Classifier verdict ({a.classifier.source})</h3>
              <div className="kv">
                <div className="k">class</div>
                <div className="v" style={{ color: a.classifier.class === "catastrophic" ? "var(--red)" : a.classifier.class === "elevated" ? "var(--amber)" : "var(--green)" }}>
                  {a.classifier.class}
                </div>
                <div className="k">blast radius</div>
                <div className="v">{a.classifier.blast_radius.toFixed(2)}</div>
                <div className="k">rationale</div>
                <div className="v" style={{ color: "var(--muted)" }}>{a.classifier.rationale}</div>
              </div>
            </div>
          )}

          <div className="doctrine">
            <b>The model advises, the rules decide.</b> The classifier may only escalate severity,
            never reduce it. The decision below is the deterministic policy engine's.
          </div>

          {a.status === "shadowed" && (
            <div className="doctrine">
              <b>Shadow mode.</b> Nothing was executed. Agamemnon recorded what it would have done:{" "}
              <b>{String(a.wouldDecision ?? "allow").toUpperCase()}</b>.
            </div>
          )}

          <div className="card">
            <h3>Fired policy rules → {(a.status === "shadowed" ? a.wouldDecision : a.decision)?.toUpperCase() ?? "—"}</h3>
            {a.firedRules.length === 0 && <div style={{ color: "var(--dim)", fontSize: 13 }}>no rules fired — allowed</div>}
            {a.firedRules.map((r: any, i: number) => (
              <div className="rule" key={i}>
                <span className={"sev " + r.severity}>{r.severity}</span>
                <div>
                  <div className="rname">{r.name}</div>
                  <div className="rdetail">{r.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Approve / Deny */}
      {a.status === "awaiting_approval" && (
        <div className="card">
          <h3>
            Operator decision · needs {a.requiredApprovals ?? 1} independent approver{(a.requiredApprovals ?? 1) > 1 ? "s" : ""}
          </h3>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 8 }}>
            Requested by <b>{ctx.run?.agent}</b>
            {ctx.agentOwner ? <> · launched by <b>{ctx.agentOwner}</b> (cannot approve)</> : null}
            {ctx.approvals.length > 0 && (
              <> · so far: {ctx.approvals.map((ap: any) => `${ap.decidedBy ?? "?"} ${ap.decision}d`).join(", ")}</>
            )}
          </div>
          <div className="decide">
            <textarea
              className="note-input"
              rows={2}
              placeholder="add a note (recorded in the audit log)…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="decide-row">
              <button
                className="btn gold"
                disabled={busy}
                onClick={() => run(() => approve({ actionId, note, operatorToken }))}
              >
                Approve
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => run(() => deny({ actionId, note, operatorToken }))}
              >
                Deny
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Undo */}
      {a.status === "executed" && isDelete && (
        <div className="card">
          <h3>Reversibility</h3>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10 }}>
            {a.actualRows?.toLocaleString()} rows deleted · snapshot stored before deletion.
          </div>
          <button
            className="btn"
            disabled={busy}
            onClick={() => run(() => undo({ actionId, operatorToken }))}
          >
            Undo — restore {a.actualRows?.toLocaleString()} rows
          </button>
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: "var(--red)" }}>
          <h3 style={{ color: "var(--red)" }}>Refused</h3>
          <div style={{ fontSize: 13 }}>{error}</div>
        </div>
      )}

      {/* Run timeline — last 20 actions, so the failed status_code query is visible */}
      <div className="card">
        <h3>This run — last {ctx.recent.length} actions</h3>
        {ctx.recent.map((m: any) => (
          <div className={`mini${m._id === a._id ? " thisone" : ""}${m.status === "failed" ? " fail" : ""}`} key={m._id}>
            <span className="seq">#{m.seq}</span>
            <span className="mtool">{m.tool}</span>
            <span className="mnote">{m.status === "failed" ? (m.error ?? m.note) : m.note || m.predicateSql}</span>
            <StatusBadge status={m.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Audit view ──────────────────────────────────────────────────────────────
function AuditView() {
  const operatorToken = useToken();
  const convex = useConvex();
  const audit = useQuery(api.core.auditTail, { operatorToken, limit: 80 });
  const chain = useQuery(api.core.auditVerify, { operatorToken });
  const [exporting, setExporting] = useState(false);
  const exportChain = async () => {
    setExporting(true);
    try {
      const lines: string[] = [];
      let after: number | undefined = undefined;
      for (;;) {
        const page: any = await convex.query(api.core.auditExport, { operatorToken, afterSeq: after, limit: 1000 });
        for (const r of page.rows) lines.push(JSON.stringify(r));
        if (page.nextAfterSeq === null) break;
        after = page.nextAfterSeq;
      }
      const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `agamemnon-audit-${new Date().toISOString().slice(0, 19)}.jsonl`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="ag-full">
      <div className="section-label" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span>Audit log · append-only · hash-chained · newest first</span>
        {chain && (
          <span className={"badge " + (chain.ok ? "executed" : "block")} title={chain.ok ? `head ${chain.headHash.slice(0, 16)}…` : chain.brokenAt?.reason}>
            {chain.ok ? `chain verified · ${chain.checked} rows` : `CHAIN BROKEN at #${chain.brokenAt?.seq}`}
          </span>
        )}
        <button className="btn" disabled={exporting} onClick={exportChain}>{exporting ? "exporting…" : "Export JSONL"}</button>
      </div>
      {audit === undefined && <div className="empty-hint">loading…</div>}
      {audit && audit.length === 0 && <div className="empty-hint">No audit entries yet.</div>}
      {audit?.map((e: any) => (
        <div className="audit-line" key={e._id}>
          <span className="at">{new Date(e.at).toLocaleTimeString()}</span>
          {typeof e.seq === "number" && <span className="at" title={e.hash}>#{e.seq}</span>}
          <span className={"audit-kind " + e.kind}>{e.kind}</span>
          <span className="audit-detail">{e.detail}</span>
        </div>
      ))}
    </div>
  );
}

// ── Eval view ───────────────────────────────────────────────────────────────
function EvalView() {
  const operatorToken = useToken();
  const scores = useQuery(api.core.evalScores, { operatorToken });
  return (
    <div className="ag-full">
      <div className="section-label">Blast-radius classifier · held-out evaluation</div>
      {scores === undefined && <div className="empty-hint">loading…</div>}
      {scores && scores.length === 0 && (
        <div className="empty-hint">
          No eval results yet. Run <code style={{ fontFamily: "var(--mono)" }}>make eval</code> to score the
          classifier against the held-out set.
        </div>
      )}
      {scores && scores.length > 0 && (
        <div className="scrolltable">
          <table className="eval">
            <thead>
              <tr>
                <th>Model</th>
                <th>Precision</th>
                <th>Recall</th>
                <th>F1</th>
                <th>Cost / call</th>
                <th>p50 latency</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s: any) => (
                <tr key={s._id} className={s.label.toLowerCase().includes("tuned") || s.label.toLowerCase().includes("agamemnon") ? "tuned" : ""}>
                  <td className="label">
                    {s.label}
                    <div className="pill-model">{s.model}</div>
                  </td>
                  <td>{(s.precision * 100).toFixed(1)}%</td>
                  <td>{(s.recall * 100).toFixed(1)}%</td>
                  <td>{(s.f1 * 100).toFixed(1)}%</td>
                  <td>${s.costPerCallUsd.toFixed(5)}</td>
                  <td>{s.p50LatencyMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 16, fontSize: 12.5, color: "var(--muted)" }}>
        Scored on a held-out set of labelled destructive/benign actions, including hand-written
        adversarial cases (deletes disguised as updates, bounded predicates that are secretly
        unbounded, cascading foreign keys).
      </div>
    </div>
  );
}
