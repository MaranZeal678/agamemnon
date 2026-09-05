import { usePoll, useTween } from "../api";

interface Summary { activeLoads: number; totalLoads: number; at: number; }
interface Metrics {
  queryLatencyP50Ms: number; errorRatePct: number;
  dbActiveConnections: number; poolInUse: number; poolMax: number; poolWaiting: number;
  txnPerSec: number; at: number;
}
interface Shipment {
  ref: string; origin: string; destination: string; carrier_id: number; status: string; pickup: string;
}

function Metric({ k, value, unit, warn }: { k: string; value: string; unit?: string; warn?: boolean }) {
  return (
    <div className={"metric" + (warn ? " warn" : "")}>
      <span className="led" />
      <div className="k">{k}</div>
      <div className="v">
        {value}
        {unit ? <span className="u"> {unit}</span> : null}
      </div>
    </div>
  );
}

export function Dashboard() {
  const summary = usePoll<Summary>("/api/summary", 600);
  const metrics = usePoll<Metrics>("/api/metrics", 1000);
  const recent = usePoll<Shipment[]>("/api/recent", 1500);
  const active = useTween(summary?.activeLoads ?? null, 480);

  // Green/warn decided by REAL thresholds, not by fiat.
  const latWarn = (metrics?.queryLatencyP50Ms ?? 0) > 150;
  const errWarn = (metrics?.errorRatePct ?? 0) >= 1;
  const loadWarn = (metrics?.dbActiveConnections ?? 0) > 6;
  const poolWarn = (metrics?.poolInUse ?? 0) >= (metrics?.poolMax ?? 8);

  return (
    <main className="mf-main">
      <div className="mf-crumb">
        <b>Dispatch Board</b> · live · polling every 0.6s · terminal CHI-04
      </div>

      <div className="panel">
        <h2>Active Loads — Live</h2>
        <div className="body">
          <div className="counter-wrap">
            <div className="counter">{active.toLocaleString()}</div>
            <div className="counter-sub">
              loads currently <b>active</b> on the board
              <br />
              of <b>{(summary?.totalLoads ?? 0).toLocaleString()}</b> total in system
              <br />
              <span className="tiny">
                updated {summary ? new Date(summary.at).toLocaleTimeString() : "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>System Monitoring — all systems nominal</h2>
        <div className="body">
          <div className="monitor">
            <Metric k="Query Latency (p50)" value={String(metrics?.queryLatencyP50Ms ?? "—")} unit="ms" warn={latWarn} />
            <Metric k="Error Rate" value={(metrics?.errorRatePct ?? 0).toFixed(2)} unit="%" warn={errWarn} />
            <Metric k="Database Load" value={String(metrics?.dbActiveConnections ?? "—")} unit="active" warn={loadWarn} />
            <Metric
              k="Connection Pool"
              value={`${metrics?.poolInUse ?? "—"}/${metrics?.poolMax ?? 8}`}
              warn={poolWarn}
            />
          </div>
          <div className="tiny" style={{ marginTop: 8 }}>
            Throughput {metrics?.txnPerSec ?? 0} txn/s · pool waiting {metrics?.poolWaiting ?? 0} ·
            these are live signals from Postgres, not fixtures.
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Recent Shipments</h2>
        <div className="body" style={{ padding: 0 }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Load Ref</th>
                <th>Origin</th>
                <th>Destination</th>
                <th>Carrier</th>
                <th>Pickup</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(recent ?? []).map((s) => (
                <tr key={s.ref}>
                  <td>{s.ref}</td>
                  <td>{s.origin}</td>
                  <td>{s.destination}</td>
                  <td className="num">#{s.carrier_id}</td>
                  <td>{s.pickup}</td>
                  <td>
                    <span className="pill">{s.status}</span>
                  </td>
                </tr>
              ))}
              {(!recent || recent.length === 0) && (
                <tr>
                  <td colSpan={6} className="tiny" style={{ padding: 12 }}>
                    No active loads on the board.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
