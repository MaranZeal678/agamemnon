/**
 * @agamemnon/adapter — the shim an agent imports to route writes through
 * Agamemnon instead of holding a production credential.
 *
 * The agent constructs one Adapter, opens a run, logs its reasoning steps, and
 * calls `propose()` for every write. It NEVER sees a database connection string.
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
  | "undone";

export interface FiredRule {
  name: string;
  severity: Decision;
  detail: string;
}

export interface ProposeResult {
  actionId: string;
  status: ActionStatus;
  decision: Decision;
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
  destructive?: boolean; // defaults true (postgres.delete)
}

const TERMINAL: ActionStatus[] = ["blocked", "denied", "executed", "failed", "undone"];

export class Adapter {
  constructor(
    private readonly baseUrl: string,
    private readonly agent: string,
  ) {
    if (!baseUrl) throw new Error("Agamemnon base URL is required (AGAMEMNON_PROPOSE_URL)");
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private runId: string | null = null;

  async startRun(): Promise<string> {
    const { runId } = await this.post("/run/start", { agent: this.agent });
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
      agent: this.agent,
      tool: "postgres.delete",
      target: input.target,
      predicate: input.predicate,
      params: input.params ?? {},
      agentClaimedRows: input.agentClaimedRows,
      destructive: input.destructive !== false,
    });
    if (TERMINAL.includes(result.status)) return result;
    // Not terminal yet (awaiting approval) → poll until it is (Phase 3).
    return this.awaitDecision(result.actionId, result);
  }

  async awaitDecision(actionId: string, seed?: ProposeResult): Promise<ProposeResult> {
    const deadlineMs = 15 * 60 * 1000;
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      const res = await fetch(new URL(`/status/${actionId}`, this.baseUrl));
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
