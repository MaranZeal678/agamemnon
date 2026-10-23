// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { decide, toIntent, respond } from "../src/hook.ts";

const run = (agent: string, payload: unknown, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [resolve(import.meta.dirname, "../bin/agamemnon-hook.js"), "--agent", agent], {
    input: JSON.stringify(payload),
    env: { ...process.env, AGAMEMNON_AGENT_TOKEN: "", ...env },
    encoding: "utf8",
  });

describe("coding-agent hook", () => {
  it("denies terraform destroy, prisma reset and rm -rf ~ with a reroute (Claude Code protocol)", () => {
    for (const command of ["terraform destroy -auto-approve", "npx prisma migrate reset --force", "rm -rf ~/"]) {
      const r = run("claude", { tool_name: "Bash", tool_input: { command }, cwd: "/tmp" });
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/Agamemnon: DENY/);
    }
  });

  it("sees through a script the command runs (the hook-bypass via npm run / bash x.sh)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agm-hook-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "db:fresh": "prisma migrate reset --force" } }));
    writeFileSync(join(dir, "nuke.sh"), "#!/bin/sh\nterraform destroy -auto-approve\n");
    expect(JSON.parse(run("claude", { tool_name: "Bash", tool_input: { command: "npm run db:fresh" }, cwd: dir }).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(JSON.parse(run("claude", { tool_name: "Bash", tool_input: { command: "bash nuke.sh" }, cwd: dir }).stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/inside nuke\.sh/);
  });

  it("asks before an edit that skips a test, and before an agent widens its own permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agm-hook-"));
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests/pay.test.ts"), "it('pays', () => {})\n");
    const d1 = await decide(toIntent("claude", { tool_name: "Edit", tool_input: { file_path: "tests/pay.test.ts", old_string: "it('pays'", new_string: "it.skip('pays'" }, cwd: dir }));
    expect(d1.verdict).toBe("ask");
    expect(d1.reasons.join(" ")).toMatch(/test-skipped/);
    const d2 = await decide(toIntent("claude", { tool_name: "Write", tool_input: { file_path: ".claude/settings.json", content: '{"permissions":{"defaultMode":"bypassPermissions"}}' }, cwd: dir }));
    expect(d2.reasons.join(" ")).toMatch(/agent-self-escalation/);
  });

  it("allows ordinary commands and speaks Cursor and exit-code protocols", async () => {
    const ok = await decide(toIntent("cursor", { command: "npm test", cwd: "/tmp" }));
    expect(ok.verdict).toBe("allow");
    const lines: string[] = [];
    const errs: string[] = [];
    expect(respond("cursor", { verdict: "deny", reasons: ["x: y"], source: "local" }, (s) => lines.push(s), (s) => errs.push(s))).toBe(0);
    expect(JSON.parse(lines[0]).permission).toBe("deny");
    expect(respond("gemini", { verdict: "deny", reasons: ["x: y"], source: "local" }, (s) => lines.push(s), (s) => errs.push(s))).toBe(2);
    expect(errs[0]).toMatch(/Agamemnon: DENY/);
  });

  it("fails closed on risky actions when the broker is unreachable", async () => {
    const d = await decide(toIntent("claude", { tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: "/tmp" }), { broker: "http://127.0.0.1:9", token: "agm_agent_x" });
    expect(d.verdict).toBe("deny");
    expect(d.reasons.join(" ")).toMatch(/unreachable/);
    const clean = await decide(toIntent("claude", { tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: "/tmp" }), { broker: "http://127.0.0.1:9", token: "agm_agent_x" });
    expect(clean.verdict).toBe("allow");
  });

  it("flags a real credential in a command as a bypass of the broker", async () => {
    const d = await decide(toIntent("claude", { tool_name: "Bash", tool_input: { command: "psql postgres://admin:hunter2secret@db.prod.internal:5432/app -c 'select 1'" }, cwd: "/tmp" }));
    expect(d.verdict).toBe("deny");
    expect(d.reasons.join(" ")).toMatch(/real-credential-in-command/);
  });
});
