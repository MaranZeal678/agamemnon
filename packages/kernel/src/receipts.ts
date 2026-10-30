// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { canonicalJson, sha256Hex } from "./hash.ts";
import { OVERSIGHT_CATALOG_VERSION } from "./oversight.ts";
import type { Delegation, TargetRef } from "./effect.ts";

/**
 * Signed effect receipts — approved effect vs observed effect, per action.
 *
 * Logs say what happened. A receipt pairs what a human APPROVED (the bound
 * effect hash) with what Agamemnon then OBSERVED in the system of record, plus
 * who approved, on whose behalf, and whether the agent's claims held up —
 * signed (ed25519, by the broker) and hash-chained to the previous receipt.
 * Evidence an auditor or insurer can verify without trusting the guard's UI.
 * (Signing itself lives in the broker; the kernel defines the payload.)
 */

export interface Receipt {
  version: 1;
  receiptId: string;
  effectId: string;
  taskId: string;
  operation: string;
  target: TargetRef;
  delegation: Delegation;
  decision: "allow" | "approval" | "block";
  firedRules: string[];
  approvedEffectHash: string | null;
  bindingHash: string | null;
  approvers: Array<{ id: string; at: number }>;
  reversibility: string;
  observed: { counts: Record<string, number>; outcome: "executed" | "blocked" | "denied" | "failed" | "held" | "cancelled" | "reverted" };
  verification: { fidelity: number | null; claims: Array<{ type: string; status: string }> };
  oversightCatalog: string;
  prevReceiptHash: string;
  issuedAt: number;
}

export type ReceiptInput = Omit<Receipt, "version" | "oversightCatalog" | "prevReceiptHash">;

export const GENESIS_RECEIPT = "0".repeat(64);

export function buildReceipt(input: ReceiptInput, prevReceiptHash: string = GENESIS_RECEIPT): Receipt {
  return { version: 1, oversightCatalog: OVERSIGHT_CATALOG_VERSION, prevReceiptHash, ...input };
}

export function receiptPayload(r: Receipt): string {
  return canonicalJson(r);
}

export function receiptHash(r: Receipt): string {
  return sha256Hex(receiptPayload(r));
}

export interface SignedReceipt {
  receipt: Receipt;
  hash: string;
  signature: string; // base64
  publicKey: string; // base64 SPKI / raw, as produced by the signer
  alg: "ed25519";
}

export interface ReceiptSigner {
  alg: "ed25519";
  publicKey: string;
  sign(payload: string): string;
}

export function signReceipt(r: Receipt, signer: ReceiptSigner): SignedReceipt {
  return { receipt: r, hash: receiptHash(r), signature: signer.sign(receiptPayload(r)), publicKey: signer.publicKey, alg: signer.alg };
}

/** Verify signatures and the hash chain. `verify` checks one signature (injected: node:crypto, WebCrypto…). */
export function verifyReceipts(
  list: SignedReceipt[],
  verify: (payload: string, signature: string, publicKey: string) => boolean,
): { ok: boolean; checked: number; brokenAt?: { index: number; reason: string } } {
  let prev = GENESIS_RECEIPT;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.receipt.prevReceiptHash !== prev) return { ok: false, checked: i, brokenAt: { index: i, reason: "chain broken (prevReceiptHash mismatch)" } };
    if (receiptHash(s.receipt) !== s.hash) return { ok: false, checked: i, brokenAt: { index: i, reason: "receipt contents changed after signing" } };
    if (!verify(receiptPayload(s.receipt), s.signature, s.publicKey)) return { ok: false, checked: i, brokenAt: { index: i, reason: "bad signature" } };
    prev = s.hash;
  }
  return { ok: true, checked: list.length };
}
