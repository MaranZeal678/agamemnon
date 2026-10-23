// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import net from "node:net";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { extractClaims, hashOf, type EffectRequest, type ObservedFacts } from "@agamemnon/kernel";
import { ConnectorError, type Connector, type ConnectorContext, type Executed, type Prepared } from "./types.ts";
import type { EffectRow } from "../store.ts";

/**
 * Outbound email — irreversible once delivered, so it never leaves at once.
 * The broker holds every message for a cancel window (unsend), and measures
 * its blast radius as recipients × external domains.
 *
 * Promise ledger: commitments the agent makes in the message ("I've refunded
 * you $50", "our policy allows…") are extracted. A promised refund above the
 * agent's authority, or a statement of policy, needs a human (Air Canada was
 * held to its chatbot's invented policy; Cursor's support bot invented one).
 * Promised refunds are then checked against refunds actually issued in the
 * same task — a promise the systems of record contradict is flagged.
 */

export interface EmailConfig {
  from: string;
  /** Domains considered internal (not egress). */
  internalDomains?: string[];
  /** SMTP relay (no TLS — e.g. a local relay or Mailpit). Omit to use the file transport. */
  smtp?: { host: string; port: number };
  /** File transport path (JSON lines) when no SMTP relay is configured. */
  outboxFile?: string;
  holdWindowMs?: number;
  maxPromiseMinor?: number;
  allowPolicyStatements?: boolean;
  maxRecipients?: number;
}

const POLICY_STATEMENT = /\b(our|the) (refund |cancellation |returns? |pricing |usage )?policy (is|allows|states|says|permits|requires)\b|\byou(?:'re| are) entitled to\b|\bwe guarantee\b|\bas per (our|the) (terms|policy)\b|\b(only|limited to) one (device|machine|seat) per\b/i;

async function smtpSend(host: string, port: number, from: string, to: string[], data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const s = net.createConnection({ host, port });
    const steps = [`EHLO agamemnon\r\n`, `MAIL FROM:<${from}>\r\n`, ...to.map((t) => `RCPT TO:<${t}>\r\n`), `DATA\r\n`, `${data.replace(/\r?\n\./g, "\r\n..")}\r\n.\r\n`, `QUIT\r\n`];
    let i = -1;
    let buf = "";
    s.setTimeout(10000, () => { s.destroy(); reject(new Error("SMTP timeout")); });
    s.on("data", (d) => {
      buf += d.toString();
      if (!/\r?\n$/.test(buf)) return;
      const lines = buf.trim().split(/\r?\n/);
      const last = lines[lines.length - 1];
      if (/^\d{3}-/.test(last)) return; // multi-line reply continues
      buf = "";
      const code = Number(last.slice(0, 3));
      if (code >= 400) { s.destroy(); reject(new Error(`SMTP ${last}`)); return; }
      i++;
      if (i < steps.length) s.write(steps[i]);
      else s.end();
    });
    s.on("end", () => resolve());
    s.on("error", reject);
  });
}

export class EmailConnector implements Connector {
  readonly system = "email";
  readonly operations = ["email.send"];

  private cfg(req: EffectRequest, ctx: ConnectorContext) {
    const name = String(req.params.mailbox ?? "default");
    const t = ctx.store.target("email", `mailbox:${name}`);
    if (!t?.config) throw new ConnectorError("target-unregistered", `mailbox "${name}" is not registered`);
    return { name, cfg: t.config as EmailConfig, env: t.env };
  }

  async prepare(req: EffectRequest, ctx: ConnectorContext): Promise<Prepared> {
    const { name, cfg, env } = this.cfg(req, ctx);
    const p = req.params as Record<string, any>;
    const to: string[] = (Array.isArray(p.to) ? p.to : [p.to]).map(String).filter(Boolean);
    if (!to.length) throw new ConnectorError("no-recipients", "params.to is required");
    if (to.some((a) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a))) throw new ConnectorError("bad-recipient", "invalid recipient address");
    const internal = new Set((cfg.internalDomains ?? []).map((d) => d.toLowerCase()));
    const domains = [...new Set(to.map((a) => a.split("@")[1].toLowerCase()))];
    const external = to.filter((a) => !internal.has(a.split("@")[1].toLowerCase()));
    const body = `${p.subject ?? ""}\n${p.body ?? ""}`;
    const promises = extractClaims(body).filter((c) => c.type === "refund");
    const rules: Prepared["connectorRules"] = [];
    for (const pr of promises) {
      const minor = Math.round(Number(pr.value) * 100);
      if (cfg.maxPromiseMinor !== undefined && minor > cfg.maxPromiseMinor) {
        rules.push({ name: "promise-exceeds-authority", severity: "approval", detail: `the message promises a refund of ${Number(pr.value).toFixed(2)}, above the agent's authority of ${(cfg.maxPromiseMinor / 100).toFixed(2)}` });
      }
    }
    if (!cfg.allowPolicyStatements && POLICY_STATEMENT.test(body)) {
      rules.push({ name: "policy-promise", severity: "approval", detail: `the message states company policy ("${POLICY_STATEMENT.exec(body)![0]}") — customers can hold you to it` });
    }
    if (cfg.maxRecipients !== undefined && to.length > cfg.maxRecipients) rules.push({ name: "mass-send", severity: "approval", detail: `${to.length} recipients (> ${cfg.maxRecipients})` });
    return {
      effect: {
        request: { ...req, target: { system: "email", resource: name, env: env ?? undefined }, claims: [...(req.claims ?? []), ...promises.map((pr) => ({ ...pr, source: "extracted" as const }))] },
        reversibility: "irreversible",
        windowMs: cfg.holdWindowMs ?? 10 * 60 * 1000,
        preview: {
          summary: `email "${String(p.subject ?? "").slice(0, 60)}" to ${to.length} recipient(s) across ${domains.length} domain(s)${external.length ? `, ${external.length} external` : ""}${promises.length ? ` — promises a refund of ${promises.map((x) => x.value).join(", ")}` : ""}`,
          counts: { recipients: to.length, external: external.length, domains: domains.length },
          fidelity: "rendered",
          sample: to.slice(0, 5).map((a) => ({ to: a })),
          details: { subject: p.subject ?? "", body: String(p.body ?? "").slice(0, 2000) },
        },
        precondition: hashOf({ to, subject: p.subject, body: p.body }),
        oversight: [],
        creates: [],
        egress: external.length > 0,
        reads: [],
        // Lease / dependency keys per recipient — one pending message must not serialise the whole mailbox.
        writes: to.map((a) => `email:${name}:${a.toLowerCase()}`),
      },
      connectorRules: rules,
      canDefer: true,
      internal: { mailbox: name, to, subject: String(p.subject ?? ""), body: String(p.body ?? "") },
    };
  }

  async execute(req: EffectRequest, prepared: Prepared, ctx: ConnectorContext): Promise<Executed> {
    const { cfg } = this.cfg(req, ctx);
    const i = prepared.internal as { to: string[]; subject: string; body: string };
    const msg = [`From: ${cfg.from}`, `To: ${i.to.join(", ")}`, `Subject: ${i.subject.replace(/[\r\n]/g, " ")}`, `X-Agamemnon-Effect: ${req.id}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", i.body].join("\r\n");
    if (cfg.smtp) await smtpSend(cfg.smtp.host, cfg.smtp.port, cfg.from, i.to, msg);
    else {
      const file = cfg.outboxFile ?? "./.agamemnon/outbox-sent.jsonl";
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), effect: req.id, from: cfg.from, to: i.to, subject: i.subject, body: i.body }) + "\n");
    }
    return { outcome: "executed", observedCounts: { recipients: i.to.length, external: prepared.effect.preview.counts.external ?? 0, domains: prepared.effect.preview.counts.domains ?? 0 }, facts: { sent: i.to.length }, detail: `delivered to ${i.to.length} recipient(s) via ${cfg.smtp ? `SMTP ${cfg.smtp.host}:${cfg.smtp.port}` : "file transport"}` };
  }

  async facts(taskId: string, ctx: ConnectorContext): Promise<Partial<ObservedFacts>> {
    const sent = ctx.store.lineage(taskId).flatMap((t) => ctx.store.effectsByTask(t)).filter((e: EffectRow) => e.system === "email" && e.status === "executed");
    return sent.length ? { sent: sent.reduce((a, e) => a + Number(e.result?.observedCounts?.recipients ?? 0), 0) } : {};
  }
}
