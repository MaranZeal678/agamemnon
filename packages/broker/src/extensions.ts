// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import type http from "node:http";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Engine } from "./engine.ts";
import type { PrincipalRow } from "./store.ts";

/**
 * Broker extensions — how add-ons (for example the Agamemnon Enterprise operator
 * console) plug into the open broker without forking it.
 *
 * The interface only lets an extension ADD: core routes are matched first and
 * cannot be overridden, extension routes are reachable by signed-in operators
 * only, /v1/admin/ stays core-only, and no hook here touches admission, binding
 * or verification.
 *
 * Extensions are TRUSTED code, not a sandbox: they run in the broker's process
 * and routes receive the engine itself. Load only extensions you would trust as
 * a dependency of the broker.
 *
 * Load extensions with `openBroker({ extensions })`, or at startup with
 * AGAMEMNON_EXTENSIONS=<module>[,<module>…] (package names or paths; each module
 * default-exports a BrokerExtension, or exports one named `extension`).
 */

export interface PageContext {
  publicUrl?: string;
}

export interface RouteContext {
  req: http.IncomingMessage;
  method: string;
  path: string;
  url: URL;
  body: any;
  /** The signed-in operator. Extension routes never see agents or anonymous callers. */
  me: PrincipalRow;
  isAdmin: boolean;
  engine: Engine;
  send: (code: number, body: unknown, type?: string) => void;
}

export interface BrokerExtension {
  name: string;
  /**
   * Unauthenticated HTML pages at exact paths. Only "/" and "/console" are
   * honoured; every other path belongs to the core broker.
   */
  pages?: Partial<Record<"/" | "/console", (ctx: PageContext) => string>>;
  /**
   * Operator routes, tried after every core operator route. Paths under
   * /v1/admin/ are reserved for the core broker and never reach extensions.
   * Return true when the request was handled.
   */
  routes?: (ctx: RouteContext) => boolean | Promise<boolean>;
  /** Extra annotations attached to each line of the evidence pack (GET /v1/evidence). */
  evidenceControls?: (receipt: any) => Record<string, string>;
}

const PAGE_PATHS = new Set(["/", "/console"]);

export function validateExtension(ext: unknown, source = "extension"): BrokerExtension {
  const e = ext as BrokerExtension;
  if (!e || typeof e !== "object" || typeof e.name !== "string" || !e.name) throw new Error(`${source}: an extension must be an object with a name`);
  for (const p of Object.keys(e.pages ?? {})) if (!PAGE_PATHS.has(p)) throw new Error(`${source}: extensions may only provide the "/" and "/console" pages, not "${p}"`);
  if (e.routes !== undefined && typeof e.routes !== "function") throw new Error(`${source}: routes must be a function`);
  if (e.evidenceControls !== undefined && typeof e.evidenceControls !== "function") throw new Error(`${source}: evidenceControls must be a function`);
  return e;
}

/** Import the modules named in a comma-separated list (AGAMEMNON_EXTENSIONS). */
export async function loadExtensions(spec: string | undefined, cwd = process.cwd()): Promise<BrokerExtension[]> {
  const out: BrokerExtension[] = [];
  for (const raw of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const target = raw.startsWith(".") || isAbsolute(raw) ? pathToFileURL(resolve(cwd, raw)).href : raw;
    const mod = await import(target);
    out.push(validateExtension(mod.default ?? mod.extension, raw));
  }
  return out;
}
