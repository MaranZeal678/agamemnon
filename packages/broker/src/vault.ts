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

import { createCipheriv, createDecipheriv, randomBytes, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ReceiptSigner } from "@agamemnon/kernel";
import type { Store } from "./store.ts";

/**
 * The vault — the reason an agent never holds a real credential.
 *
 * Secrets (database URLs, API tokens) are stored encrypted (AES-256-GCM) in
 * the broker's store. Agents and their tools only ever see a PLACEHOLDER
 * (`agm_ph_…`): a value that is useless anywhere except inside this broker.
 * If a hook is bypassed and generated code reads `.env`, it gets a string that
 * authenticates nowhere.
 *
 * Master key, in order of preference:
 *   1. AGAMEMNON_MASTER_KEY (64 hex chars) — for containers / KMS injection;
 *   2. the macOS Keychain (service "agamemnon-broker");
 *   3. <dataDir>/master.key, mode 0600 — local fallback, flagged in /health.
 */

export type KeySource = "env" | "keychain" | "file";

function keychainGet(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "agamemnon-broker", "-a", "master", "-w"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function keychainSet(hex: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("security", ["add-generic-password", "-s", "agamemnon-broker", "-a", "master", "-w", hex, "-U"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function loadMasterKey(dataDir: string, opts: { useKeychain?: boolean } = {}): { key: Buffer; source: KeySource } {
  const env = process.env.AGAMEMNON_MASTER_KEY;
  if (env && /^[0-9a-f]{64}$/i.test(env)) return { key: Buffer.from(env, "hex"), source: "env" };
  if (opts.useKeychain !== false) {
    const k = keychainGet();
    if (k && /^[0-9a-f]{64}$/i.test(k)) return { key: Buffer.from(k, "hex"), source: "keychain" };
  }
  const file = join(dataDir, "master.key");
  if (existsSync(file)) return { key: Buffer.from(readFileSync(file, "utf8").trim(), "hex"), source: "file" };
  const hex = randomBytes(32).toString("hex");
  if (opts.useKeychain !== false && keychainSet(hex)) return { key: Buffer.from(hex, "hex"), source: "keychain" };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, hex, { mode: 0o600 });
  return { key: Buffer.from(hex, "hex"), source: "file" };
}

export class Vault {
  private readonly store: Store;
  private readonly key: Buffer;
  readonly source: KeySource;

  constructor(store: Store, key: Buffer, source: KeySource) {
    this.store = store;
    this.key = key;
    this.source = source;
    if (key.length !== 32) throw new Error("vault master key must be 32 bytes");
  }

  /** Store (or replace) a secret; returns the placeholder agents may see. */
  put(name: string, value: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(name));
    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
    const existing = this.store.db.prepare("SELECT placeholder FROM secrets WHERE name = ?").get(name) as any;
    const placeholder = existing?.placeholder ?? `agm_ph_${randomBytes(12).toString("hex")}`;
    this.store.db
      .prepare(
        `INSERT INTO secrets(name, iv, tag, data, placeholder, created_at) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data`,
      )
      .run(name, iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64"), placeholder, Date.now());
    return placeholder;
  }

  get(name: string): string | null {
    const r = this.store.db.prepare("SELECT * FROM secrets WHERE name = ?").get(name) as any;
    if (!r) return null;
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(r.iv, "base64"));
    d.setAAD(Buffer.from(name));
    d.setAuthTag(Buffer.from(r.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(r.data, "base64")), d.final()]).toString("utf8");
  }

  has(name: string): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM secrets WHERE name = ?").get(name);
  }

  placeholder(name: string): string | null {
    return ((this.store.db.prepare("SELECT placeholder FROM secrets WHERE name = ?").get(name) as any)?.placeholder as string) ?? null;
  }

  /** Is this string one of our placeholders? (A bypass attempt used one directly.) */
  isPlaceholder(value: string): string | null {
    const r = this.store.db.prepare("SELECT name FROM secrets WHERE placeholder = ?").get(value) as any;
    return r?.name ?? null;
  }

  names(): string[] {
    return (this.store.db.prepare("SELECT name FROM secrets ORDER BY name").all() as any[]).map((r) => r.name);
  }

  /** The broker's ed25519 receipt-signing identity (created once, kept in the vault). */
  signer(): ReceiptSigner & { verify: (payload: string, signature: string, publicKey: string) => boolean } {
    let pem = this.get("broker/receipt-signing-key");
    if (!pem) {
      const { privateKey } = generateKeyPairSync("ed25519");
      pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      this.put("broker/receipt-signing-key", pem);
    }
    const priv = createPrivateKey(pem);
    const publicKey = createPublicKey(priv).export({ format: "der", type: "spki" }).toString("base64");
    return {
      alg: "ed25519",
      publicKey,
      sign: (payload: string) => sign(null, Buffer.from(payload), priv).toString("base64"),
      verify: (payload: string, signature: string, pub: string) =>
        verify(null, Buffer.from(payload), createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64")),
    };
  }
}
