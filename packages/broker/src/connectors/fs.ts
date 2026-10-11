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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { classifyOversight, sha256Hex, planRevert, type EffectRequest, type WriteRecord } from "@agamemnon/kernel";
import { ConnectorError, type Compensated, type Connector, type ConnectorContext, type Executed, type Prepared } from "./types.ts";
import type { EffectRow } from "../store.ts";

/**
 * Workspace file effects for coding agents. Every overwrite or delete keeps
 * the previous bytes, so deletes go to a trash (not oblivion) and a whole task
 * can be reverted without touching files a human edited afterwards. Paths are
 * confined to the registered workspace root. The oversight catalogue judges
 * every change (test deletion, skip markers, CI masking, agent config edits).
 */

export interface FsWorkspaceConfig {
  root: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const hashFile = (p: string) => (existsSync(p) ? sha256Hex(new Uint8Array(readFileSync(p))) : null);

export class FsConnector implements Connector {
  readonly system = "fs";
  readonly operations = ["fs.write", "fs.delete"];

  private workspace(req: EffectRequest, ctx: ConnectorContext) {
    const name = String(req.params.workspace ?? "default");
    const t = ctx.store.target("fs", `workspace:${name}`);
    if (!t?.config?.root) throw new ConnectorError("target-unregistered", `workspace "${name}" is not registered`);
    return { name, root: resolve(t.config.root as string), env: t.env };
  }

  private resolvePath(root: string, p: string): { abs: string; rel: string } {
    const abs = resolve(root, p);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || rel.split(sep).includes("..") || resolve(abs) === resolve(root)) {
      throw new ConnectorError("path-outside-workspace", `${p} is outside the workspace`);
    }
    return { abs, rel: rel.split(sep).join("/") };
  }

  async prepare(req: EffectRequest, ctx: ConnectorContext): Promise<Prepared> {
    const { name, root, env } = this.workspace(req, ctx);
    const { abs, rel } = this.resolvePath(root, String(req.params.path ?? ""));
    const exists = existsSync(abs);
    if (exists && statSync(abs).size > MAX_BYTES) throw new ConnectorError("too-large", `${rel} is larger than 5 MB`);
    const before = exists ? readFileSync(abs, "utf8") : undefined;
    const op = req.operation === "fs.delete" ? "delete" : "write";
    if (op === "delete" && !exists) throw new ConnectorError("not-found", `${rel} does not exist`);
    const after = op === "write" ? String(req.params.content ?? "") : undefined;
    const oversight = classifyOversight({ system: "fs", operation: op, resource: rel, before, after });
    const beforeLines = before?.split("\n") ?? [];
    const afterSet = new Set(after?.split("\n") ?? []);
    const beforeSet = new Set(beforeLines);
    const added = (after?.split("\n") ?? []).filter((l) => !beforeSet.has(l)).length;
    const removed = op === "delete" ? beforeLines.length : beforeLines.filter((l) => !afterSet.has(l)).length;
    const key = `fs:${name}:${rel}`;
    return {
      effect: {
        request: { ...req, target: { system: "fs", resource: `${name}/${rel}`, env: env ?? undefined } },
        reversibility: "undo",
        preview: {
          summary: op === "delete" ? `delete ${rel} (${beforeLines.length} lines → trash)` : `${exists ? "edit" : "create"} ${rel} (+${added} / −${removed} lines)`,
          counts: { files: 1, linesAdded: added, linesRemoved: removed },
          fidelity: "exact",
        },
        precondition: hashFile(abs) ?? "absent",
        oversight,
        creates: [],
        egress: false,
        reads: [key],
        writes: [key],
      },
      internal: { workspace: name, rel, op },
    };
  }

  async execute(req: EffectRequest, prepared: Prepared, ctx: ConnectorContext): Promise<Executed> {
    const i = prepared.internal as { workspace: string; rel: string; op: "write" | "delete" };
    const { root } = this.workspace(req, ctx);
    const { abs } = this.resolvePath(root, i.rel);
    const current = hashFile(abs) ?? "absent";
    if (current !== prepared.effect.precondition) throw new ConnectorError("precondition-drift", `${i.rel} changed since it was approved — nothing written`);
    const beforeBytes = existsSync(abs) ? readFileSync(abs) : null;
    if (i.op === "delete") rmSync(abs);
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(req.params.content ?? ""));
    }
    return {
      outcome: "executed",
      observedCounts: { files: 1, linesAdded: prepared.effect.preview.counts.linesAdded ?? 0, linesRemoved: prepared.effect.preview.counts.linesRemoved ?? 0 },
      writes: [{ key: `fs:${i.workspace}:${i.rel}`, target: `${i.workspace}/${i.rel}`, before: beforeBytes ? { b64: beforeBytes.toString("base64") } : null, afterHash: hashFile(abs) }],
      detail: `${i.op === "delete" ? "deleted (kept in trash)" : "wrote"} ${i.rel}`,
    };
  }

  async compensate(row: EffectRow, ctx: ConnectorContext): Promise<Compensated> {
    const writes = ctx.store.writes([row.taskId]).filter((w) => w.effectId === row.id);
    return this.revertWrites(writes.map((w) => ({ ...w, taskId: "__effect__" })), ["__effect__"], ctx);
  }

  async revertWrites(writes: Array<WriteRecord & { target: string }>, taskIds: string[], ctx: ConnectorContext): Promise<Compensated> {
    let restored = 0;
    const skipped: Array<{ key: string; reason: string }> = [];
    const pathOf = (key: string) => {
      const [, ws, ...rest] = key.split(":");
      const t = ctx.store.target("fs", `workspace:${ws}`);
      return join(resolve(t?.config?.root ?? "."), rest.join(":"));
    };
    for (const tid of taskIds) {
      const plan = planRevert(writes, tid, (k) => hashFile(pathOf(k)));
      skipped.push(...plan.skip);
      for (const r of plan.restore) {
        const p = pathOf(r.key);
        if (r.action === "delete") rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, Buffer.from(String((r.before as any).b64), "base64"));
        }
        restored++;
      }
    }
    return { detail: `restored ${restored} file(s); ${skipped.length} skipped (edited since)`, restored, skipped };
  }
}
