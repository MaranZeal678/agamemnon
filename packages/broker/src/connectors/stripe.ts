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

import { hashOf, type EffectRequest, type ObservedFacts } from "@agamemnon/kernel";
import { ConnectorError, type Compensated, type Connector, type ConnectorContext, type Executed, type Prepared } from "./types.ts";
import type { EffectRow } from "../store.ts";

/**
 * Money moved by support / ops agents (refunds, credits). Purchases are the
 * card networks' and Stripe's own territory; what nobody bounds is an agent
 * ISSUING money back. Here:
 *
 *  - stripe.refund.create  irreversible once issued → the broker holds it for a
 *                          cancel window (or two humans approve); precondition
 *                          = the charge's refunded amount (no double refunds);
 *                          per-owner money budgets apply via the kernel ledger.
 *  - stripe.credit.create  customer-balance credit → compensated by an equal
 *                          debit.
 * Facts: refunds actually created in this task — what "I refunded you $50"
 * claims (and the email outbox's promise extraction) are checked against.
 */

export interface StripeConfig {
  apiBase?: string;
  secret: string;
  /** Largest single refund an agent may request at all, minor units. */
  maxRefundMinor?: number;
}

const form = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

export class StripeConnector implements Connector {
  readonly system = "stripe";
  readonly operations = ["stripe.refund.create", "stripe.credit.create"];

  private cfg(req: EffectRequest, ctx: ConnectorContext) {
    const account = String(req.params.account ?? "default");
    const t = ctx.store.target("stripe", `account:${account}`);
    if (!t?.config) throw new ConnectorError("target-unregistered", `Stripe account "${account}" is not registered`);
    return { cfg: t.config as StripeConfig, env: t.env, account };
  }

  private async api(cfg: StripeConfig, ctx: ConnectorContext, method: string, path: string, body?: Record<string, unknown>, idem?: string): Promise<any> {
    const key = ctx.vault.get(cfg.secret);
    if (!key) throw new ConnectorError("no-credential", `vault has no secret "${cfg.secret}"`);
    const res = await fetch(`${cfg.apiBase ?? "https://api.stripe.com"}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", ...(idem ? { "idempotency-key": idem } : {}) },
      body: body ? form(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ConnectorError("stripe-error", `Stripe ${method} ${path} → ${res.status}: ${json?.error?.message ?? ""}`);
    return json;
  }

  async prepare(req: EffectRequest, ctx: ConnectorContext): Promise<Prepared> {
    const { cfg, env, account } = this.cfg(req, ctx);
    const p = req.params as Record<string, any>;
    if (req.operation === "stripe.refund.create") {
      const pi = await this.api(cfg, ctx, "GET", `/v1/payment_intents/${encodeURIComponent(String(p.payment_intent))}`);
      const received = Number(pi.amount_received ?? pi.amount ?? 0);
      const refunded = Number(pi.amount_refunded ?? (pi.latest_charge?.amount_refunded ?? 0));
      const amount = p.amount !== undefined ? Number(p.amount) : received - refunded;
      const rules: Prepared["connectorRules"] = [];
      if (amount > received - refunded) rules.push({ name: "refund-exceeds-charge", severity: "block", detail: `refund ${amount} exceeds the refundable ${received - refunded}` });
      if (cfg.maxRefundMinor !== undefined && amount > cfg.maxRefundMinor) rules.push({ name: "refund-over-agent-authority", severity: "approval", detail: `refund ${(amount / 100).toFixed(2)} exceeds the agent authority of ${(cfg.maxRefundMinor / 100).toFixed(2)}` });
      return {
        effect: {
          request: { ...req, target: { system: "stripe", resource: `${account}/pi:${p.payment_intent}`, env: env ?? undefined, tenant: pi.customer ?? undefined } },
          reversibility: "irreversible",
          preview: { summary: `refund ${(amount / 100).toFixed(2)} ${String(pi.currency ?? "").toUpperCase()} on ${p.payment_intent}`, counts: { refunds: 1, amountMinor: amount }, fidelity: "exact", amountMinor: amount },
          precondition: hashOf({ pi: pi.id, refunded }),
          oversight: [],
          creates: [],
          egress: false,
          reads: [`stripe:${account}/pi:${p.payment_intent}`],
          writes: [`stripe:${account}/pi:${p.payment_intent}`],
        },
        connectorRules: rules,
        canDefer: true,
        internal: { op: "refund", account, pi: p.payment_intent, amount, reason: p.reason ?? "requested_by_customer" },
      };
    }
    const amount = Number(p.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new ConnectorError("bad-amount", "amount must be a positive integer in minor units");
    const cust = await this.api(cfg, ctx, "GET", `/v1/customers/${encodeURIComponent(String(p.customer))}`);
    return {
      effect: {
        request: { ...req, target: { system: "stripe", resource: `${account}/cus:${p.customer}`, env: env ?? undefined, tenant: String(p.customer) } },
        reversibility: "compensate",
        preview: { summary: `credit ${(amount / 100).toFixed(2)} ${String(p.currency ?? "usd").toUpperCase()} to ${p.customer}`, counts: { credits: 1, amountMinor: amount }, fidelity: "exact", amountMinor: amount },
        precondition: hashOf({ cus: cust.id, balance: cust.balance }),
        oversight: [],
        creates: [],
        egress: false,
        reads: [`stripe:${account}/cus:${p.customer}`],
        writes: [`stripe:${account}/cus:${p.customer}`],
      },
      internal: { op: "credit", account, customer: p.customer, amount, currency: p.currency ?? "usd", description: p.description ?? "goodwill credit (agent)" },
    };
  }

  async execute(req: EffectRequest, prepared: Prepared, ctx: ConnectorContext): Promise<Executed> {
    const { cfg } = this.cfg(req, ctx);
    const i = prepared.internal as any;
    if (i.op === "refund") {
      const pi = await this.api(cfg, ctx, "GET", `/v1/payment_intents/${encodeURIComponent(i.pi)}`);
      const refunded = Number(pi.amount_refunded ?? (pi.latest_charge?.amount_refunded ?? 0));
      if (hashOf({ pi: pi.id, refunded }) !== prepared.effect.precondition) throw new ConnectorError("precondition-drift", "this payment was refunded by someone else since approval");
      const r = await this.api(cfg, ctx, "POST", "/v1/refunds", { payment_intent: i.pi, amount: i.amount, reason: i.reason }, `agm-${req.id}`);
      return { outcome: "executed", observedCounts: { refunds: 1, amountMinor: Number(r.amount) }, facts: { refundsMinor: Number(r.amount) }, result: { refund: r.id }, detail: `refund ${r.id} issued (${(Number(r.amount) / 100).toFixed(2)})` };
    }
    const tx = await this.api(cfg, ctx, "POST", `/v1/customers/${encodeURIComponent(i.customer)}/balance_transactions`, { amount: -i.amount, currency: i.currency, description: i.description }, `agm-${req.id}`);
    return { outcome: "executed", observedCounts: { credits: 1, amountMinor: i.amount }, undo: { tx: tx.id }, result: { balanceTransaction: tx.id }, detail: `credit ${tx.id} applied` };
  }

  async compensate(row: EffectRow, ctx: ConnectorContext): Promise<Compensated> {
    const i = row.effect.internal;
    if (i.op !== "credit") throw new ConnectorError("irreversible", "an issued refund cannot be reversed — that is why refunds are held first");
    const { cfg } = this.cfg(row.effect.request, ctx);
    const tx = await this.api(cfg, ctx, "POST", `/v1/customers/${encodeURIComponent(i.customer)}/balance_transactions`, { amount: i.amount, currency: i.currency, description: `reversal of agent credit (Agamemnon ${row.id})` }, `agm-rev-${row.id}`);
    return { detail: `credit reversed by ${tx.id}`, restored: 1 };
  }

  async facts(taskId: string, ctx: ConnectorContext): Promise<Partial<ObservedFacts>> {
    const effects = ctx.store.lineage(taskId).flatMap((t) => ctx.store.effectsByTask(t)).filter((e) => e.system === "stripe" && e.status === "executed" && e.operation === "stripe.refund.create");
    return effects.length ? { refundsMinor: effects.reduce((a, e) => a + Number(e.result?.observedCounts?.amountMinor ?? 0), 0) } : {};
  }
}
