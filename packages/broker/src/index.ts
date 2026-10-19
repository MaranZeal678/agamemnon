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

import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { Store } from "./store.ts";
import { Vault, loadMasterKey } from "./vault.ts";
import { Engine, type EngineOptions } from "./engine.ts";
import { createServer, hashToken, newToken } from "./server.ts";
import { PostgresConnector } from "./connectors/postgres.ts";
import { FsConnector } from "./connectors/fs.ts";
import { GithubConnector } from "./connectors/github.ts";
import { TerraformConnector } from "./connectors/terraform.ts";
import { StripeConnector } from "./connectors/stripe.ts";
import { EmailConnector } from "./connectors/email.ts";
import { MonitoringConnector } from "./connectors/monitoring.ts";
import type { Connector } from "./connectors/types.ts";
import type { BrokerExtension } from "./extensions.ts";

export { loadExtensions, type BrokerExtension, type PageContext, type RouteContext } from "./extensions.ts";

export interface Broker {
  store: Store;
  vault: Vault;
  engine: Engine;
  dataDir: string;
}

export function defaultConnectors(): Connector[] {
  return [new PostgresConnector(), new FsConnector(), new GithubConnector(), new TerraformConnector(), new StripeConnector(), new EmailConnector(), new MonitoringConnector()];
}

/** Open (or create) a broker over a data directory. */
export function openBroker(opts: { dataDir?: string; dbPath?: string; useKeychain?: boolean; connectors?: Connector[]; engine?: EngineOptions; extensions?: BrokerExtension[] } = {}): Broker {
  const dataDir = opts.dataDir ?? process.env.AGAMEMNON_DATA_DIR ?? join(homedir(), ".agamemnon");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(opts.dbPath ?? join(dataDir, "broker.db"));
  const { key, source } = loadMasterKey(dataDir, { useKeychain: opts.useKeychain ?? process.env.AGAMEMNON_NO_KEYCHAIN !== "1" });
  const vault = new Vault(store, key, source);
  const engine = new Engine(store, vault, opts.connectors ?? defaultConnectors(), opts.engine);
  for (const ext of opts.extensions ?? []) engine.use(ext);
  return { store, vault, engine, dataDir };
}

/** First run: create an admin operator and write its token to a 0600 file (never logged). */
export function bootstrapAdmin(b: Broker): string | null {
  if (b.store.listPrincipals().some((p) => p.role === "admin")) return null;
  const token = newToken("op");
  b.store.upsertPrincipal({ name: process.env.AGAMEMNON_ADMIN_NAME ?? "admin", kind: "human", role: "admin", tokenHash: hashToken(token) });
  const file = join(b.dataDir, "bootstrap-admin.token");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  b.store.audit({ kind: "provision", actor: "bootstrap", detail: "first admin operator created; token written to bootstrap-admin.token (0600)" });
  return file;
}

export function startBroker(b: Broker, opts: { host?: string; port?: number; publicUrl?: string } = {}) {
  const host = opts.host ?? process.env.AGAMEMNON_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.AGAMEMNON_PORT ?? 7700);
  const publicUrl = opts.publicUrl ?? process.env.AGAMEMNON_PUBLIC_URL ?? `http://${host}:${port}`;
  const server = createServer(b.engine, { host, port, publicUrl });
  const tick = setInterval(() => void b.engine.releaseDueHolds().catch(() => {}), 1000);
  const sweep = setInterval(() => void b.engine.sweepStaleArtifacts().catch(() => {}), 60_000);
  server.on("close", () => {
    clearInterval(tick);
    clearInterval(sweep);
  });
  return new Promise<{ server: typeof server; url: string }>((resolve) => server.listen(port, host, () => resolve({ server, url: publicUrl })));
}
