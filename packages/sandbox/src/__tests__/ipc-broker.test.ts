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
import { httpGet, MAX_FETCH_BYTES, MalformedSyscall, parseSyscall } from "../ipc-broker.ts";
import { fakeFetch } from "./fakes.ts";

describe("parseSyscall — the enclave's request is hostile until parsed", () => {
  it("accepts every well-formed op the prelude sends", () => {
    expect(parseSyscall({ op: "db.select", table: "orders", where: { id: 1, note: null } })).toEqual({ op: "db.select", table: "orders", where: { id: 1, note: null } });
    expect(parseSyscall({ op: "db.mutate", mutation: { table: "orders", operation: "delete", where: { id: 1 } } })).toEqual({
      op: "db.mutate",
      mutation: { table: "orders", operation: "delete", data: {}, where: { id: 1 } },
    });
    expect(parseSyscall({ op: "http.fetch", url: "https://a.test/" })).toEqual({ op: "http.fetch", url: "https://a.test/" });
    expect(parseSyscall({ op: "ipc.send", to: "sb-2", message: { hi: 1 } })).toEqual({ op: "ipc.send", to: "sb-2", message: { hi: 1 } });
    expect(parseSyscall({ op: "ipc.recv" })).toEqual({ op: "ipc.recv" });
  });

  it.each([
    ["not an object", "db.select"],
    ["an array", [{ op: "ipc.recv" }]],
    ["an unknown op", { op: "fs.write", path: "/etc/passwd" }],
    ["a non-string table", { op: "db.select", table: 42 }],
    ["an empty table", { op: "db.select", table: "" }],
    ["an over-long table", { op: "db.select", table: "t".repeat(64) }],
    ["a where with an object value", { op: "db.select", table: "t", where: { id: { $gt: 0 } } }],
    ["a where with a non-finite number", { op: "db.select", table: "t", where: { id: Infinity } }],
    ["a where that is an array", { op: "db.select", table: "t", where: [1] }],
    ["a missing mutation", { op: "db.mutate" }],
    ["an unknown mutation operation", { op: "db.mutate", mutation: { table: "t", operation: "truncate", data: {} } }],
    ["array data", { op: "db.mutate", mutation: { table: "t", operation: "insert", data: [1, 2] } }],
    ["a non-string url", { op: "http.fetch", url: { href: "https://a.test" } }],
    ["a missing recipient", { op: "ipc.send", message: "hi" }],
  ])("rejects %s", (_why, raw) => {
    expect(() => parseSyscall(raw)).toThrow(MalformedSyscall);
  });
});

describe("httpGet — the only network path out", () => {
  it("does a GET and returns status, type and body", async () => {
    const f = fakeFetch(() => ({ body: "hello", headers: { "content-type": "text/plain" } }));
    expect(await httpGet(f.impl, "https://api.allowed.test/v1")).toEqual({ status: 200, contentType: "text/plain", body: "hello", truncated: false });
    expect(f.calls).toEqual(["https://api.allowed.test/v1"]);
  });

  it.each([["http://api.allowed.test/"], ["ftp://api.allowed.test/"], ["https://user:pw@api.allowed.test/"], ["not a url"]])("refuses %s without making a request", async (url) => {
    const f = fakeFetch(() => ({ body: "x" }));
    await expect(httpGet(f.impl, url)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it("does not follow redirects — they could leave the allowlist", async () => {
    const f = fakeFetch(() => ({ status: 302, headers: { location: "https://evil.test/" } }));
    await expect(httpGet(f.impl, "https://api.allowed.test/")).rejects.toThrow(/redirect/);
    expect(f.calls).toEqual(["https://api.allowed.test/"]);
  });

  it("caps the response size", async () => {
    const f = fakeFetch(() => ({ body: "x".repeat(MAX_FETCH_BYTES * 2) }));
    const r = await httpGet(f.impl, "https://api.allowed.test/");
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBeLessThanOrEqual(MAX_FETCH_BYTES);
  });
});
