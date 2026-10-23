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
import { checkSyscall } from "../capabilities.ts";
import type { CapabilityFlag, SandboxCapabilities, Syscall } from "../types.ts";

const caps = (grants: CapabilityFlag[], allowedDomains?: string[]): SandboxCapabilities => ({ grants, allowedDomains, maxMemoryMb: 64, timeoutMs: 1000 });
const ALL: CapabilityFlag[] = ["READ_ONLY", "MUTATE_STATE", "EXTERNAL_HTTP", "AGENT_IPC"];

const CALLS: Array<[Syscall, CapabilityFlag]> = [
  [{ op: "db.select", table: "orders" }, "READ_ONLY"],
  [{ op: "db.mutate", mutation: { table: "orders", operation: "delete", data: {} } }, "MUTATE_STATE"],
  [{ op: "ipc.send", to: "sb-2", message: "hi" }, "AGENT_IPC"],
  [{ op: "ipc.recv" }, "AGENT_IPC"],
];

describe("checkSyscall — grants", () => {
  it.each(CALLS)("%j needs exactly %s", (call, flag) => {
    expect(checkSyscall(caps([flag]), call)).toEqual({ allowed: true });
    const others = checkSyscall(caps(ALL.filter((f) => f !== flag), ["api.allowed.test"]), call);
    expect(others.allowed).toBe(false);
    if (!others.allowed) expect(others.reason).toContain(flag);
  });

  it("a sandbox with no grants may make no syscall at all", () => {
    for (const [call] of CALLS) expect(checkSyscall(caps([]), call).allowed).toBe(false);
    expect(checkSyscall(caps([], ["api.allowed.test"]), { op: "http.fetch", url: "https://api.allowed.test/" }).allowed).toBe(false);
  });

  it("MUTATE_STATE does not imply READ_ONLY", () => {
    expect(checkSyscall(caps(["MUTATE_STATE"]), { op: "db.select", table: "orders" }).allowed).toBe(false);
  });

  it("refuses an op it does not know", () => {
    expect(checkSyscall(caps(ALL), { op: "fs.write" } as unknown as Syscall).allowed).toBe(false);
  });
});

describe("checkSyscall — EXTERNAL_HTTP and allowedDomains", () => {
  const net = caps(["EXTERNAL_HTTP"], ["api.allowed.test"]);
  const fetchOf = (url: string): Syscall => ({ op: "http.fetch", url });

  it.each([
    ["the plain URL", "https://api.allowed.test/v1?q=1"],
    ["any case", "https://API.Allowed.TEST/v1"],
    ["a trailing dot", "https://api.allowed.test./v1"],
    ["the explicit default port (URL normalises :443 away)", "https://api.allowed.test:443/v1"],
  ])("allows %s", (_why, url) => {
    expect(checkSyscall(net, fetchOf(url))).toEqual({ allowed: true });
  });

  it("normalises the allowlist entries too", () => {
    expect(checkSyscall(caps(["EXTERNAL_HTTP"], ["API.allowed.test."]), fetchOf("https://api.allowed.test/"))).toEqual({ allowed: true });
  });

  it.each([
    ["plain http", "http://api.allowed.test/"],
    ["a non-default port", "https://api.allowed.test:8443/"],
    ["userinfo that hides the real host", "https://api.allowed.test@evil.test/"],
    ["credentials on an allowed host", "https://user:pw@api.allowed.test/"],
    ["a subdomain of an allowed host", "https://x.api.allowed.test/"],
    ["an allowed host as a prefix", "https://api.allowed.test.evil.test/"],
    ["an allowed host as a suffix", "https://evilapi.allowed.test/"],
    ["a homoglyph (Cyrillic а)", "https://аpi.allowed.test/"],
    ["backslash confusion", "https:\\\\evil.test\\@api.allowed.test"],
    ["an IP literal", "https://127.0.0.1/"],
    ["something that is not a URL", "api.allowed.test"],
  ])("refuses %s", (_why, url) => {
    expect(checkSyscall(net, fetchOf(url)).allowed).toBe(false);
  });

  it("says which host was refused", () => {
    const d = checkSyscall(net, fetchOf("https://evil.test/?leak=1"));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/evil\.test.*not in allowedDomains/);
  });

  it("EXTERNAL_HTTP with no allowedDomains reaches nothing; allowedDomains without the grant reaches nothing", () => {
    expect(checkSyscall(caps(["EXTERNAL_HTTP"]), fetchOf("https://api.allowed.test/")).allowed).toBe(false);
    const d = checkSyscall(caps([], ["api.allowed.test"]), fetchOf("https://api.allowed.test/"));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toContain("EXTERNAL_HTTP");
  });
});
