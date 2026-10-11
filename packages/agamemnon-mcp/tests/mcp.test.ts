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

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openBroker } from "../../broker/src/index.ts";
import { createServer, hashToken } from "../../broker/src/server.ts";

describe("MCP server → broker (stdio, end to end)", () => {
  it("exposes only broker-mediated tools; destructive changes park with an approval link", async () => {
    process.env.AGAMEMNON_MASTER_KEY = randomBytes(32).toString("hex");
    const dir = mkdtempSync(join(tmpdir(), "agm-mcp-"));
    const b = openBroker({ dataDir: dir, useKeychain: false });
    const ws = join(dir, "ws");
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "tests/billing.test.ts"), "it('bills', () => {})\n");
    b.store.upsertTarget({ system: "fs", resource: "workspace:default", env: "dev", config: { root: ws } });
    b.store.upsertPrincipal({ name: "claude-code", kind: "agent", owner: "maran", tokenHash: hashToken("tok-agent") });
    const http = createServer(b.engine, {});
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(http.address() as any).port}`;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dirname, "../bin/agamemnon-mcp.js")],
      env: { ...process.env, AGAMEMNON_BROKER_URL: url, AGAMEMNON_AGENT_TOKEN: "tok-agent" } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["agm_cancel", "agm_claim", "agm_end_task", "agm_propose", "agm_query", "agm_start_task", "agm_status"]);
      expect(tools).not.toContain("execute_sql");

      const start: any = await client.callTool({ name: "agm_start_task", arguments: { goal: "fix the flaky billing test" } });
      expect(start.content[0].text).toMatch(/^task task_/);

      const ok: any = await client.callTool({ name: "agm_propose", arguments: { operation: "fs.write", params: { path: "src/fix.ts", content: "export const x = 1;\n" }, expectedCount: 1, waitSeconds: 1 } });
      expect(ok.content[0].text).toMatch(/^EXECUTED/);
      expect(existsSync(join(ws, "src/fix.ts"))).toBe(true);

      const del: any = await client.callTool({ name: "agm_propose", arguments: { operation: "fs.delete", params: { path: "tests/billing.test.ts" }, waitSeconds: 1 } });
      const t = del.content[0].text as string;
      expect(t).toMatch(/^AWAITING_APPROVAL/);
      expect(t).toMatch(/oversight:test-deleted/);
      expect(t).toMatch(/Needs 2 human approval/);
      expect(existsSync(join(ws, "tests/billing.test.ts"))).toBe(true);

      const claim: any = await client.callTool({ name: "agm_claim", arguments: { claims: [{ type: "env", value: "dev" }], summary: "All tests pass now." } });
      expect(claim.content[0].text).toMatch(/VERIFIED: env/);
      expect(claim.content[0].text).toMatch(/tests/);
    } finally {
      await client.close();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});
