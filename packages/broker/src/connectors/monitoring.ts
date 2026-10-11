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

import { classifyOversight, hashOf, type EffectRequest } from "@agamemnon/kernel";
import { ConnectorError, type Compensated, type Connector, type ConnectorContext, type Executed, type Prepared } from "./types.ts";
import type { EffectRow } from "../store.ts";

/**
 * Thin monitoring connector (Datadog, PagerDuty). Every operation here REDUCES
 * OVERSIGHT — muting a monitor, scheduling downtime, opening a maintenance
 * window — so all of it goes through the oversight class (two humans, never
 * learned) and is compensated by undoing the silence.
 */

export interface MonitoringConfig {
  provider: "datadog" | "pagerduty";
  apiBase?: string;
  secret: string; // Datadog "apiKey:appKey" or PagerDuty token
}

export class MonitoringConnector implements Connector {
  readonly system = "monitoring";
  readonly operations = ["monitoring.datadog.mute", "monitoring.datadog.downtime", "monitoring.pagerduty.maintenance"];

  private cfg(req: EffectRequest, ctx: ConnectorContext) {
    const account = String(req.params.account ?? (req.operation.includes("pagerduty") ? "pagerduty" : "datadog"));
    const t = ctx.store.target("monitoring", `account:${account}`);
    if (!t?.config) throw new ConnectorError("target-unregistered", `monitoring account "${account}" is not registered`);
    return { cfg: t.config as MonitoringConfig, env: t.env, account };
  }

  private async call(cfg: MonitoringConfig, ctx: ConnectorContext, method: string, path: string, body?: unknown) {
    const secret = ctx.vault.get(cfg.secret);
    if (!secret) throw new ConnectorError("no-credential", `vault has no secret "${cfg.secret}"`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.provider === "datadog") {
      const [api, app] = secret.split(":");
      headers["dd-api-key"] = api;
      headers["dd-application-key"] = app ?? "";
    } else headers.authorization = `Token token=${secret}`;
    const base = cfg.apiBase ?? (cfg.provider === "datadog" ? "https://api.datadoghq.com" : "https://api.pagerduty.com");
    const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ConnectorError("monitoring-error", `${cfg.provider} ${method} ${path} → ${res.status}`);
    return json;
  }

  async prepare(req: EffectRequest, ctx: ConnectorContext): Promise<Prepared> {
    const { cfg, env, account } = this.cfg(req, ctx);
    const p = req.params as Record<string, any>;
    const call =
      req.operation === "monitoring.datadog.mute" ? `mute monitor ${p.monitorId}` :
      req.operation === "monitoring.datadog.downtime" ? `create downtime on ${p.scope}` :
      `create maintenance_window for ${(p.serviceIds ?? []).join(",")}`;
    const oversight = classifyOversight({ system: "monitoring", operation: "api", params: { provider: cfg.provider, call } });
    const hours = p.end ? Math.max(0, (Number(p.end) * 1000 - Date.now()) / 3600000) : null;
    return {
      effect: {
        request: { ...req, target: { system: "monitoring", resource: `${account}:${p.monitorId ?? p.scope ?? (p.serviceIds ?? []).join(",")}`, env: env ?? undefined } },
        reversibility: "compensate",
        preview: { summary: `${cfg.provider}: ${call}${hours !== null ? ` for ${hours.toFixed(1)}h` : " indefinitely"}`, counts: { silenced: 1 }, fidelity: "exact" },
        precondition: hashOf({ op: req.operation, p }),
        oversight,
        creates: [],
        egress: false,
        reads: [],
        writes: [`monitoring:${account}`],
      },
      connectorRules: hours === null ? [{ name: "indefinite-silence", severity: "approval", detail: "no end time — the silence would last until someone remembers to lift it" }] : [],
      internal: { op: req.operation },
    };
  }

  async execute(req: EffectRequest, _prepared: Prepared, ctx: ConnectorContext): Promise<Executed> {
    const { cfg } = this.cfg(req, ctx);
    const p = req.params as Record<string, any>;
    if (req.operation === "monitoring.datadog.mute") {
      await this.call(cfg, ctx, "POST", `/api/v1/monitor/${encodeURIComponent(p.monitorId)}/mute`, p.end ? { end: p.end } : {});
      return { outcome: "executed", observedCounts: { silenced: 1 }, undo: { monitorId: p.monitorId }, detail: `monitor ${p.monitorId} muted` };
    }
    if (req.operation === "monitoring.datadog.downtime") {
      const d = await this.call(cfg, ctx, "POST", `/api/v1/downtime`, { scope: p.scope, end: p.end, message: p.message ?? "scheduled via Agamemnon" });
      return { outcome: "executed", observedCounts: { silenced: 1 }, undo: { downtimeId: d.id }, detail: `downtime ${d.id} scheduled` };
    }
    const w = await this.call(cfg, ctx, "POST", `/maintenance_windows`, { maintenance_window: { start_time: p.start, end_time: p.end, services: (p.serviceIds ?? []).map((id: string) => ({ id, type: "service_reference" })) } });
    return { outcome: "executed", observedCounts: { silenced: 1 }, undo: { windowId: w?.maintenance_window?.id }, detail: "maintenance window opened" };
  }

  async compensate(row: EffectRow, ctx: ConnectorContext): Promise<Compensated> {
    const { cfg } = this.cfg(row.effect.request, ctx);
    const u = row.result?.undo ?? {};
    if (u.monitorId) await this.call(cfg, ctx, "POST", `/api/v1/monitor/${encodeURIComponent(u.monitorId)}/unmute`, {});
    if (u.downtimeId) await this.call(cfg, ctx, "DELETE", `/api/v1/downtime/${u.downtimeId}`);
    if (u.windowId) await this.call(cfg, ctx, "DELETE", `/maintenance_windows/${u.windowId}`);
    return { detail: "silence lifted — alerting restored", restored: 1 };
  }
}
