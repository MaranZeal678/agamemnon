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

import { canonicalJson, sha256Hex } from "./hash.ts";

/**
 * Tamper-evident audit chain.
 *
 * Every audit row carries `seq`, `prevHash` and `hash`, where
 *   hash = SHA-256(prevHash || canonicalJson(event-without-hash-fields)).
 * Editing, deleting or reordering any row breaks every hash after it, and
 * `verifyChain` names the first broken link. This makes the log
 * tamper-EVIDENT, not tamper-proof: anchor the head hash somewhere the guard
 * cannot write (a WORM bucket, a transparency log) for the latter.
 */

export const GENESIS_HASH = "0".repeat(64);

export interface ChainFields {
  seq: number;
  prevHash: string;
  hash: string;
}

/** The hashed body: everything except the chain fields themselves. */
export function auditBody<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const { seq: _s, prevHash: _p, hash: _h, _id: _i, _creationTime: _c, ...body } = row as Record<string, unknown>;
  return body;
}

export function computeAuditHash(prevHash: string, seq: number, body: Record<string, unknown>): string {
  return sha256Hex(`${prevHash}\n${seq}\n${canonicalJson(body)}`);
}

/** Build the chain fields for the next row given the current head. */
export function nextLink(
  head: { seq: number; hash: string } | null,
  body: Record<string, unknown>,
): ChainFields {
  const seq = head ? head.seq + 1 : 0;
  const prevHash = head ? head.hash : GENESIS_HASH;
  return { seq, prevHash, hash: computeAuditHash(prevHash, seq, body) };
}

export interface ChainVerdict {
  ok: boolean;
  checked: number;
  headHash: string;
  /** First broken row, if any. */
  brokenAt?: { seq: number; reason: string };
}

/** Verify rows in ascending `seq` order. */
export function verifyChain(rows: Array<Record<string, unknown> & ChainFields>): ChainVerdict {
  let prev = GENESIS_HASH;
  let expectedSeq = rows.length ? rows[0].seq : 0;
  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return { ok: false, checked: row.seq, headHash: prev, brokenAt: { seq: row.seq, reason: `gap: expected seq ${expectedSeq}` } };
    }
    if (row.prevHash !== prev && !(row.seq === rows[0].seq && rows[0].seq > 0)) {
      return { ok: false, checked: row.seq, headHash: prev, brokenAt: { seq: row.seq, reason: "prevHash does not match previous row" } };
    }
    const recomputed = computeAuditHash(row.prevHash, row.seq, auditBody(row));
    if (recomputed !== row.hash) {
      return { ok: false, checked: row.seq, headHash: prev, brokenAt: { seq: row.seq, reason: "row contents do not match its hash (edited)" } };
    }
    prev = row.hash;
    expectedSeq++;
  }
  return { ok: true, checked: rows.length, headHash: prev };
}
