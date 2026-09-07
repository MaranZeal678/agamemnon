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

import { usePoll } from "../api";

interface Run { day: string; time: string; rows_deleted: number; status: string; note: string; }
interface Stats { median: number; min: number; max: number; runs: number; }
interface Payload { runs: Run[]; stats: Stats; }

export function AiOps() {
  const data = usePoll<Payload>("/api/ai-ops/runs", 4000);

  return (
    <main className="mf-main">
      <div className="mf-crumb">
        <b>AI Operations</b> · internal automation
      </div>

      <div className="panel">
        <h2>Dispatch Copilot</h2>
        <div className="body">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20 }}>
            <div style={{ maxWidth: 620 }}>
              <p style={{ margin: "0 0 8px" }}>
                <b>Dispatch Copilot</b> is Meridian's autonomous night-desk agent. It runs a nightly
                cleanup pass that removes orphaned loads — active loads with no matching booking — so
                the board stays accurate for the morning shift. Sanctioned tooling, part of the
                standard operations stack since Q2.
              </p>
              <div className="tiny">
                Owner: Platform Engineering · Schedule: nightly 02:00 CT · Runtime: Node 20 ·
                Credential: <code>meridian_app</code>
              </div>
            </div>
            <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              <span className="pill" style={{ fontSize: 12, padding: "3px 10px" }}>● healthy</span>
              <div className="tiny" style={{ marginTop: 6 }}>
                last run <b>succeeded</b>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Nightly Cleanup — 30-day history</h2>
        <div className="body">
          {data?.stats && (
            <div style={{ display: "flex", gap: 26, marginBottom: 10 }}>
              <div>
                <div className="tiny">30-DAY MEDIAN</div>
                <div style={{ fontSize: 22, fontWeight: "bold", color: "#2c3e50" }}>
                  {data.stats.median.toLocaleString()}<span className="tiny"> rows/night</span>
                </div>
              </div>
              <div>
                <div className="tiny">RANGE</div>
                <div style={{ fontSize: 22, fontWeight: "bold", color: "#2c3e50" }}>
                  {data.stats.min}–{data.stats.max}
                </div>
              </div>
              <div>
                <div className="tiny">RUNS</div>
                <div style={{ fontSize: 22, fontWeight: "bold", color: "#2c3e50" }}>{data.stats.runs}</div>
              </div>
            </div>
          )}
          <table className="grid">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Rows Deleted</th>
                <th>Status</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {(data?.runs ?? []).map((r, i) => (
                <tr key={i}>
                  <td>{r.day}</td>
                  <td>{r.time}</td>
                  <td className="num">{r.rows_deleted.toLocaleString()}</td>
                  <td>
                    <span className="pill">{r.status}</span>
                  </td>
                  <td className="tiny">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
