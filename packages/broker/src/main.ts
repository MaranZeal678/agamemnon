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

import { openBroker, bootstrapAdmin, startBroker, loadExtensions } from "./index.ts";

/** `node src/main.ts` — run the broker with configuration from the environment. */
const extensions = await loadExtensions(process.env.AGAMEMNON_EXTENSIONS);
const b = openBroker({ extensions, engine: { publicUrl: process.env.AGAMEMNON_PUBLIC_URL, canaryRate: process.env.AGAMEMNON_CANARY_RATE ? Number(process.env.AGAMEMNON_CANARY_RATE) : undefined } });
const tokenFile = bootstrapAdmin(b);
const { url } = await startBroker(b);
const chain = b.store.verifyAudit();
console.log(`Agamemnon broker listening on ${url}`);
console.log(`  data dir     ${b.dataDir}`);
console.log(`  vault key    ${b.vault.source}${b.vault.source === "file" ? "  (fallback: prefer AGAMEMNON_MASTER_KEY or the macOS Keychain)" : ""}`);
console.log(`  mode         ${b.engine.mode}`);
console.log(`  audit chain  ${chain.ok ? `verified (${chain.checked} rows)` : `BROKEN at #${chain.brokenAt?.seq}`}`);
console.log(`  connectors   ${[...b.engine.connectors.keys()].join(", ")}`);
console.log(`  extensions   ${extensions.length ? extensions.map((x) => x.name).join(", ") : "none"}`);
console.log(`  home         ${url}/   (approvals: ${url}/approve/<effect id> or \`agamemnon pending\`)`);
if (tokenFile) console.log(`  first run: admin token written to ${tokenFile} (0600) — sign in with it, then delete the file`);
const stop = () => process.exit(0);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
