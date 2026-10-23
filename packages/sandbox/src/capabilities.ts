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

import type { CapabilityFlag, SandboxCapabilities, Syscall } from "./types.ts";

export type CapabilityDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * May this sandbox make this syscall? A refusal KILLS the sandbox and is
 * logged as a policy violation, so this must be exact: no implied grants.
 *
 *   db.select            needs READ_ONLY
 *   db.mutate            needs MUTATE_STATE        (MUTATE_STATE does not imply READ_ONLY)
 *   ipc.send / ipc.recv  need AGENT_IPC
 *   http.fetch           needs EXTERNAL_HTTP AND the URL's host in allowedDomains:
 *                          - parse with `new URL()`; unparseable → refuse
 *                          - protocol must be "https:"
 *                          - no username/password  (https://allowed.test@evil.test/ is evil.test)
 *                          - default port only     (u.port === "")
 *                          - EXACT hostname match, case-insensitive, ignoring one trailing dot
 *                            on either side — no implicit subdomains, no suffix matching
 *                            (evilallowed.test and allowed.test.evil.test must both fail)
 *   anything else        refuse
 *
 * Every refusal's reason should name what was missing (e.g. "MUTATE_STATE not
 * granted", "host evil.test is not in allowedDomains") — operators read these.
 *
 * `call` is already shape-checked by parseSyscall (ipc-broker.ts), so fields
 * have the right types; their VALUES are still attacker-controlled.
 */
export function checkSyscall(caps: SandboxCapabilities, call: Syscall): CapabilityDecision {
  const need = REQUIRES[call.op];
  if (!need) return { allowed: false, reason: `unknown syscall ${JSON.stringify(call.op)}` };
  if (!caps.grants.includes(need)) return { allowed: false, reason: `${need} not granted (${call.op})` };
  return call.op === "http.fetch" ? checkUrl(call.url, caps.allowedDomains ?? []) : { allowed: true };
}

/** Exactly one capability per op — no op is covered by another's grant. */
const REQUIRES: Record<string, CapabilityFlag | undefined> = {
  "db.select": "READ_ONLY",
  "db.mutate": "MUTATE_STATE",
  "http.fetch": "EXTERNAL_HTTP",
  "ipc.send": "AGENT_IPC",
  "ipc.recv": "AGENT_IPC",
};

/** Lower-case and drop one trailing dot, so "API.allowed.test." and "api.allowed.test" compare equal. */
const normHost = (h: string) => h.toLowerCase().replace(/\.$/, "");

/**
 * Decide on the PARSED URL, never the string: the WHATWG parser is what
 * fetch() uses, so the host we check is the host that would be contacted.
 * (userinfo, backslashes, IDN homoglyphs → all resolved by the parser.)
 */
function checkUrl(raw: string, allowedDomains: string[]): CapabilityDecision {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { allowed: false, reason: "http.fetch: not a valid absolute URL" };
  }
  if (u.protocol !== "https:") return { allowed: false, reason: `http.fetch: ${u.protocol} is not allowed, only https:` };
  if (u.username || u.password) return { allowed: false, reason: "http.fetch: URLs with credentials are not allowed" };
  if (u.port !== "") return { allowed: false, reason: `http.fetch: port ${u.port} is not allowed, only the default` };
  const host = normHost(u.hostname);
  if (!allowedDomains.some((d) => normHost(d) === host)) return { allowed: false, reason: `http.fetch: host ${host} is not in allowedDomains` };
  return { allowed: true };
}
