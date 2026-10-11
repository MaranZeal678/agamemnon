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
import { analyseShell, invokedScripts, containsRealCredential } from "../src/index.ts";

describe("shell analysis (coding-agent commands from real incidents)", () => {
  const verdict = (c: string, x: Record<string, string> = {}) => analyseShell(c, x).verdict;
  it("denies the incident commands", () => {
    expect(verdict("terraform destroy")).toBe("deny"); // DataTalks.Club 2026
    expect(verdict("terraform -chdir=infra apply -auto-approve")).toBe("deny");
    expect(verdict("npx prisma migrate reset --force")).toBe("deny"); // 22 tables, 2026
    expect(verdict("npx prisma db push --accept-data-loss")).toBe("deny");
    expect(verdict("rm -rf ~/")).toBe("deny"); // Claude Code / Gemini CLI 2025
    expect(verdict("railway volume delete prod-data")).toBe("deny"); // PocketOS 2026 (CLI form)
    expect(verdict(`curl -X POST https://backboard.railway.app/graphql -d '{"query":"mutation { volumeDelete(volumeId: \\"v1\\") }"}'`)).toBe("deny");
    expect(verdict("claude -p 'find secrets' --dangerously-skip-permissions")).toBe("deny"); // Nx s1ngularity
    expect(verdict("aws cloudtrail stop-logging --name main")).toBe("deny");
  });
  it("asks on reversible-but-risky commands", () => {
    expect(verdict("git push --force origin main")).toBe("ask");
    expect(verdict("git reset --hard HEAD~3")).toBe("ask");
    expect(verdict("kubectl delete deployment api")).toBe("ask");
    expect(verdict("git push --force-with-lease")).toBe("allow");
  });
  it("allows ordinary work", () => {
    for (const c of ["npm test", "git status", "ls -la", "rm -rf ./dist", "terraform plan -out=plan.tfplan", "psql --version"]) expect(verdict(c)).toBe("allow");
  });
  it("finds scripts a command runs and analyses their bodies", () => {
    expect(invokedScripts("npm run db:fresh && bash scripts/nuke.sh && make clean")).toEqual(["scripts/nuke.sh", "package.json#db:fresh", "Makefile#clean"]);
    const a = analyseShell("make clean", { "Makefile#clean": "\trm -rf /\n" });
    expect(a.verdict).toBe("deny");
    expect(a.findings[0].detail).toMatch(/inside Makefile#clean/);
  });
  it("spots real credentials but not vault placeholders", () => {
    expect(containsRealCredential("psql postgres://app:hunter2hunter2@db:5432/x")).toBe(true);
    expect(containsRealCredential("psql postgres://app:agm_ph_00112233445566778899aabb@db:5432/x")).toBe(false);
    expect(containsRealCredential("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });
});
