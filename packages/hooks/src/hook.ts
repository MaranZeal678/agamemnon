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

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { analyseShell, classifyOversight, type ShellVerdict } from "@agamemnon/kernel";

/**
 * Agamemnon pre-tool hook for coding agents.
 *
 *   node hook.ts --agent claude|cursor|codex|gemini|windsurf
 *
 * Reads the agent's hook payload on stdin, records INTENT (the command, the
 * file change, the scripts it would run), analyses it locally, asks the broker,
 * and answers in the agent's own format (deny / ask / allow).
 *
 * A hook is advisory, not the boundary: it cannot see what a child process or
 * generated code does at runtime. The boundary is the broker — real
 * credentials only exist there, so a bypassed hook still meets a placeholder.
 * What the hook adds is early, explained refusal ("route this through
 * agm_propose") and intent capture for the audit trail.
 *
 * Failure policy: if the broker is unreachable, risky actions (any local
 * finding) are DENIED; clean actions proceed so the agent can still work.
 */

type Agent = "claude" | "cursor" | "codex" | "gemini" | "windsurf";

interface Intent {
  tool: string;
  command?: string;
  path?: string;
  operation?: string;
  before?: string;
  after?: string;
  diff?: string;
  cwd: string;
}

function readStdin(): Promise<string> {
  return new Promise((r) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => r(s));
    if (process.stdin.isTTY) r("");
  });
}

/** Normalise the different agents' payloads into one intent. */
export function toIntent(agent: Agent, payload: any): Intent {
  const cwd = String(payload.cwd ?? payload.workspace_roots?.[0] ?? process.cwd());
  if (agent === "cursor") {
    if (payload.command) return { tool: "shell", command: String(payload.command), cwd };
    if (payload.file_path) return { tool: "edit", path: String(payload.file_path), cwd, after: payload.content ?? undefined };
    return { tool: String(payload.hook_event_name ?? "unknown"), cwd };
  }
  if (agent === "windsurf") {
    const ti = payload.tool_info ?? {};
    if (ti.command_line) return { tool: "shell", command: String(ti.command_line), cwd: String(ti.cwd ?? cwd) };
    if (ti.file_path) return { tool: "edit", path: String(ti.file_path), cwd, diff: (ti.edits ?? []).map((e: any) => `-${e.old_string ?? ""}\n+${e.new_string ?? ""}`).join("\n") };
    return { tool: "unknown", cwd };
  }
  // Claude Code / Codex / Gemini share the {tool_name, tool_input} shape.
  const name = String(payload.tool_name ?? payload.toolName ?? "");
  const input = payload.tool_input ?? payload.toolInput ?? payload.input ?? {};
  if (/^(bash|shell|run_shell_command|exec_command|local_shell)$/i.test(name) || input.command) {
    return { tool: name || "shell", command: String(input.command ?? input.cmd ?? (Array.isArray(input.argv) ? input.argv.join(" ") : "")), cwd };
  }
  const path = input.file_path ?? input.path ?? input.filePath;
  if (path) {
    const abs = resolve(cwd, String(path));
    const before = existsSync(abs) ? safeRead(abs) : undefined;
    let after: string | undefined;
    if (typeof input.content === "string") after = input.content;
    else if (typeof input.new_string === "string" && before !== undefined) after = before.replace(String(input.old_string ?? ""), input.new_string);
    else if (Array.isArray(input.edits) && before !== undefined) after = input.edits.reduce((acc: string, e: any) => acc.replace(String(e.old_string ?? ""), String(e.new_string ?? "")), before);
    const op = /delete|remove/i.test(name) ? "delete" : "write";
    return { tool: name || "edit", path: String(path), operation: op, before, after, cwd };
  }
  return { tool: name || "unknown", cwd };
}

function safeRead(p: string): string | undefined {
  try {
    const s = readFileSync(p, "utf8");
    return s.length > 1_000_000 ? undefined : s;
  } catch {
    return undefined;
  }
}

/** Bodies of scripts a command would run (package.json scripts, Makefile targets, script files). */
export function expandScripts(command: string, cwd: string, refs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ref of refs) {
    if (ref.startsWith("package.json#")) {
      const pkg = safeRead(join(cwd, "package.json"));
      const script = pkg ? (JSON.parse(pkg).scripts ?? {})[ref.slice(13)] : undefined;
      if (script) out[ref] = String(script);
    } else if (ref.startsWith("Makefile#")) {
      const mk = safeRead(join(cwd, "Makefile"));
      if (mk) {
        const target = ref.slice(9);
        const m = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:[^\\n]*\\n((?:\\t[^\\n]*\\n?)*)`, "m").exec(mk);
        if (m) out[ref] = m[1];
      }
    } else {
      const body = safeRead(resolve(cwd, ref));
      if (body) out[ref] = body.slice(0, 200_000);
    }
  }
  return out;
}

export interface HookDecision {
  verdict: ShellVerdict;
  reasons: string[];
  reroute?: string;
  source: "broker" | "local";
}

const RANK: Record<ShellVerdict, number> = { allow: 0, ask: 1, deny: 2 };

export async function decide(intent: Intent, opts: { broker?: string; token?: string } = {}): Promise<HookDecision> {
  const local: Array<{ rule: string; verdict: ShellVerdict; detail: string; reroute?: string }> = [];
  let expansions: Record<string, string> = {};
  if (intent.command) {
    const first = analyseShell(intent.command);
    expansions = expandScripts(intent.command, intent.cwd, first.invokes);
    local.push(...analyseShell(intent.command, expansions).findings);
  }
  if (intent.path) {
    for (const f of classifyOversight({ system: "fs", operation: intent.operation ?? "write", resource: intent.path.replace(/^\.\//, ""), before: intent.before, after: intent.after, diff: intent.diff })) {
      local.push({ rule: `oversight:${f.rule}`, verdict: "ask", detail: f.detail, reroute: "this change reduces oversight — propose it with agm_propose (fs.write / fs.delete) so two humans review it" });
    }
  }
  const localVerdict = local.reduce<ShellVerdict>((a, f) => (RANK[f.verdict] > RANK[a] ? f.verdict : a), "allow");
  const broker = opts.broker ?? process.env.AGAMEMNON_BROKER_URL ?? "http://127.0.0.1:7700";
  const token = opts.token ?? process.env.AGAMEMNON_AGENT_TOKEN;
  if (token) {
    try {
      const res = await fetch(`${broker}/v1/hooks/intent`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...intent, expansions }),
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const r = await res.json();
        const verdict: ShellVerdict = RANK[r.verdict as ShellVerdict] >= RANK[localVerdict] ? r.verdict : localVerdict;
        const findings = [...(r.findings ?? []), ...local];
        return { verdict, reasons: [...new Set(findings.map((f: any) => `${f.rule}: ${f.detail}`))], reroute: findings.find((f: any) => f.reroute)?.reroute, source: "broker" };
      }
    } catch {
      /* fall through to the local, fail-closed decision */
    }
  }
  const failClosed = local.length > 0 ? "deny" : "allow";
  return {
    verdict: token ? (failClosed as ShellVerdict) : localVerdict,
    reasons: local.map((f) => `${f.rule}: ${f.detail}`).concat(token && local.length ? ["Agamemnon broker unreachable — risky actions are refused until it is back"] : []),
    reroute: local.find((f) => f.reroute)?.reroute,
    source: "local",
  };
}

/** Render the decision in the calling agent's protocol. Returns the process exit code. */
export function respond(agent: Agent, d: HookDecision, write: (s: string) => void, writeErr: (s: string) => void): number {
  const reason = [`Agamemnon: ${d.verdict.toUpperCase()}`, ...d.reasons.map((r) => `- ${r}`), d.reroute ? `Instead: ${d.reroute}` : ""].filter(Boolean).join("\n");
  if (agent === "claude") {
    write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.verdict, permissionDecisionReason: d.verdict === "allow" ? "Agamemnon: no risk found" : reason } }));
    return 0;
  }
  if (agent === "cursor") {
    write(JSON.stringify({ permission: d.verdict, userMessage: d.verdict === "allow" ? undefined : reason, agentMessage: d.verdict === "allow" ? undefined : reason }));
    return 0;
  }
  // Codex / Gemini / Windsurf: exit code 2 blocks, stderr is shown to the model.
  if (d.verdict === "allow") return 0;
  writeErr(reason);
  return 2;
}

export async function main(argv = process.argv.slice(2)) {
  const agent = (argv[argv.indexOf("--agent") + 1] ?? "claude") as Agent;
  const raw = await readStdin();
  let payload: any = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const d = await decide(toIntent(agent, payload));
  const code = respond(agent, d, (s) => process.stdout.write(s), (s) => process.stderr.write(s));
  process.exitCode = code;
}

if ((import.meta as any).main) await main();
