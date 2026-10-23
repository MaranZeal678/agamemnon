// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * @agamemnon/adapter — the shim an agent imports to route writes through
 * Agamemnon instead of holding a production credential.
 *
 * The agent constructs one Adapter, opens a run, logs its reasoning steps, and
 * calls `propose()` for every write. It NEVER sees a database connection string.
 * It authenticates with its own bearer token (AGAMEMNON_AGENT_TOKEN); the agent
 * name shown in the console comes from that token's registration, not from here.
 * `propose()` returns once the action reaches a terminal decision (blocked /
 * approved+executed / denied), polling /status under the hood.
 */

export type Decision = "allow" | "approval" | "block";
export type ActionStatus =
  | "logged"
  | "proposed"
  | "classifying"
  | "blocked"
  | "awaiting_approval"
  | "approved"
  | "denied"
  | "executing"
  | "executed"
  | "failed"
  | "undone"
  | "shadowed";

export interface FiredRule {
  name: string;
  severity: Decision;
  detail: string;
}

export interface ProposeResult {
  actionId: string;
  status: ActionStatus;
  decision: Decision;
  /** Shadow mode: what Agamemnon would have enforced (nothing executed). */
  wouldDecision?: Decision | null;
  requiredApprovals?: number | null;
  estimatedRows: number;
  agentClaimedRows: number;
  ratioToMedian: number | null;
  firedRules: FiredRule[];
  classifier: { class: string; blast_radius: number; rationale: string; source: string } | null;
  actualRows?: number | null;
  error?: string | null;
}

export interface ProposeInput {
  target: string;
  predicate: string; // the WHERE clause; Agamemnon builds count/snapshot/delete
  params?: Record<string, unknown>;
  agentClaimedRows: number; // what the agent THINKS it will affect
}

const TERMINAL: ActionStatus[] = ["blocked", "denied", "executed", "failed", "undone", "shadowed"];

export class Adapter {
  private readonly token: string;

  constructor(
    private readonly baseUrl: string,
    private readonly agent: string,
    token?: string,
  ) {
    if (!baseUrl) throw new Error("Agamemnon base URL is required (AGAMEMNON_PROPOSE_URL)");
    this.token = token ?? process.env.AGAMEMNON_AGENT_TOKEN ?? "";
    if (!this.token) throw new Error("Agamemnon agent token is required (AGAMEMNON_AGENT_TOKEN)");
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.token}` };
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private runId: string | null = null;

  async startRun(): Promise<string> {
    const { runId } = await this.post("/run/start", {});
    this.runId = runId;
    return runId;
  }

  /** Log a reasoning step, a failed read, or a harmless side task — display-only. */
  async step(input: {
    tool: "reason" | "postgres.query" | "task";
    target?: string;
    sql?: string;
    note: string;
    failed?: boolean;
    error?: string;
  }): Promise<void> {
    await this.post("/run/step", { runId: this.runId, ...input });
  }

  /** Propose a write. Resolves once the action reaches a terminal decision. */
  async propose(input: ProposeInput): Promise<ProposeResult> {
    const result: ProposeResult = await this.post("/propose", {
      runId: this.runId,
      tool: "postgres.delete",
      target: input.target,
      predicate: input.predicate,
      params: input.params ?? {},
      agentClaimedRows: input.agentClaimedRows,
    });
    // Always resolve the full status (a pre-measurement block returns early).
    return this.awaitDecision(result.actionId, result);
  }

  async awaitDecision(actionId: string, seed?: ProposeResult): Promise<ProposeResult> {
    // Slightly longer than the server's default approval timeout (20 min), so
    // the server — which always resolves a timeout to DENY — answers first.
    const deadlineMs = 21 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      const res = await fetch(new URL(`/status/${actionId}`, this.baseUrl), { headers: this.headers() });
      const s = await res.json();
      if (TERMINAL.includes(s.status)) {
        return { ...(seed as ProposeResult), ...s, actionId };
      }
      await new Promise((r) => setTimeout(r, 1000)); // sleep-and-recheck
    }
    throw new Error("timed out waiting for a decision");
  }

  async finishRun(status: "completed" | "killed" = "completed"): Promise<void> {
    await this.post("/run/finish", { runId: this.runId, status });
  }
}
