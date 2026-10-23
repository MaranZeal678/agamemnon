// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { classifyOversight, hashOf, type EffectRequest, type OversightFinding } from "@agamemnon/kernel";
import { ConnectorError, type Connector, type ConnectorContext, type Executed, type Prepared } from "./types.ts";

/**
 * Terraform connector. The saved plan IS the exact preview — Terraform already
 * refuses to apply a stale saved plan, and we credit that: this connector adds
 * what Terraform does not know:
 *
 *  - environment binding: the workspace's state lineage is registered with an
 *    environment label; a plan made against a different lineage (a stale or
 *    wrong state file — the DataTalks.Club 2026 incident) is refused;
 *  - backup independence: destroying a data store together with its backups /
 *    snapshot protection in one plan is refused outright;
 *  - stateful destroys are typed irreversible (two humans);
 *  - the oversight catalogue runs over every resource change (CloudTrail,
 *    GuardDuty, log retention, alarms, IAM wildcards, branch protection …).
 */

const STATEFUL = /^(aws_db_instance|aws_rds_cluster|aws_dynamodb_table|aws_s3_bucket|aws_ebs_volume|aws_efs_file_system|aws_elasticache_cluster|aws_redshift_cluster|aws_docdb_cluster|aws_neptune_cluster|aws_opensearch_domain|aws_elasticsearch_domain|google_sql_database_instance|google_storage_bucket|google_bigquery_dataset|azurerm_mssql_database|azurerm_storage_account|azurerm_postgresql_flexible_server|railway_volume|supabase_project|neon_project)$/;
const BACKUPS = /^(aws_db_snapshot|aws_db_cluster_snapshot|aws_backup_vault|aws_backup_plan|aws_backup_selection|aws_backup_vault_lock_configuration|aws_s3_bucket_versioning|aws_s3_bucket_object_lock_configuration|aws_ebs_snapshot|google_sql_backup_run)$/;

export interface TerraformWorkspaceConfig {
  workdir?: string;
  /** Registered state lineage — a plan from any other lineage is refused. */
  lineage?: string;
}

interface Change {
  address: string;
  type: string;
  name: string;
  actions: string[];
  before: any;
  after: any;
}

export function summarisePlan(plan: any) {
  const changes: Change[] = (plan?.resource_changes ?? [])
    .filter((rc: any) => rc.mode !== "data")
    .map((rc: any) => ({ address: rc.address, type: rc.type, name: rc.name, actions: rc.change?.actions ?? [], before: rc.change?.before ?? null, after: rc.change?.after ?? null }));
  const counts = { create: 0, update: 0, delete: 0, replace: 0 };
  for (const c of changes) {
    const a = c.actions.join(",");
    if (a === "create") counts.create++;
    else if (a === "update") counts.update++;
    else if (a === "delete") counts.delete++;
    else if (a.includes("delete") && a.includes("create")) counts.replace++;
  }
  return { changes, counts };
}

export class TerraformConnector implements Connector {
  readonly system = "terraform";
  readonly operations = ["terraform.apply"];

  async prepare(req: EffectRequest, ctx: ConnectorContext): Promise<Prepared> {
    const p = req.params as Record<string, any>;
    const workspace = String(p.workspace ?? "default");
    const t = ctx.store.target("terraform", `workspace:${workspace}`);
    if (!t) throw new ConnectorError("target-unregistered", `terraform workspace "${workspace}" is not registered`);
    const cfg = (t.config ?? {}) as TerraformWorkspaceConfig;
    let plan = p.planJson;
    if (!plan && p.planJsonPath) plan = JSON.parse(readFileSync(String(p.planJsonPath), "utf8"));
    if (!plan) throw new ConnectorError("missing-plan", "params.planJson or params.planJsonPath is required (terraform show -json plan.tfplan)");
    const lineage = String(p.stateLineage ?? plan?.prior_state?.lineage ?? "");
    const rules: Prepared["connectorRules"] = [];
    if (cfg.lineage && lineage && lineage !== cfg.lineage) {
      rules.push({ name: "target-fingerprint-mismatch", severity: "block", detail: `plan was made against state lineage ${lineage.slice(0, 8)}…, but workspace "${workspace}" (${t.env ?? "unlabelled"}) is ${cfg.lineage.slice(0, 8)}… — stale or wrong state file` });
    }
    if (cfg.lineage && !lineage) rules.push({ name: "state-lineage-unknown", severity: "approval", detail: "the plan does not say which state it was made against" });

    const { changes, counts } = summarisePlan(plan);
    const oversight: OversightFinding[] = [];
    for (const c of changes) {
      oversight.push(...classifyOversight({ system: "terraform", operation: "apply", params: { resourceType: c.type, name: c.name, actions: c.actions, before: c.before, after: c.after } }));
    }
    const destroyed = changes.filter((c) => c.actions.includes("delete"));
    const statefulDestroyed = destroyed.filter((c) => STATEFUL.test(c.type));
    const backupsDestroyed = destroyed.filter((c) => BACKUPS.test(c.type));
    const unprotected = statefulDestroyed.filter((c) => c.before?.skip_final_snapshot === true || c.before?.delete_automated_backups === true || c.before?.deletion_protection === false);
    const destroysBackups = statefulDestroyed.length > 0 && (backupsDestroyed.length > 0 || unprotected.length > 0);
    const creates = changes
      .filter((c) => c.actions.includes("create") && /^aws_iam_(access_key|user|user_login_profile)$|^github_(repository_deploy_key|repository_webhook)$/.test(c.type))
      .map((c) => ({ kind: c.type, id: c.address, system: "terraform", durableAccess: true }));

    const planHash = p.planPath && existsSync(String(p.planPath)) ? createHash("sha256").update(readFileSync(String(p.planPath))).digest("hex") : hashOf(plan.resource_changes ?? []);
    return {
      effect: {
        request: { ...req, target: { system: "terraform", resource: workspace, env: t.env ?? undefined } },
        reversibility: statefulDestroyed.length ? "irreversible" : "compensate",
        preview: {
          summary: `terraform apply on ${workspace}${t.env ? ` [${t.env}]` : ""}: +${counts.create} ~${counts.update} -${counts.delete} ±${counts.replace}${statefulDestroyed.length ? ` — DESTROYS ${statefulDestroyed.map((c) => c.address).join(", ")}` : ""}`,
          counts: { ...counts, resources: changes.length },
          fidelity: "exact",
          sample: changes.slice(0, 8).map((c) => ({ address: c.address, actions: c.actions.join("/") })),
        },
        precondition: planHash,
        oversight,
        creates,
        egress: false,
        reads: [`terraform:${workspace}`],
        writes: [`terraform:${workspace}`],
        destroysBackups,
      },
      connectorRules: [
        ...rules,
        ...(destroyed.length ? [{ name: "infrastructure-destroy", severity: "approval" as const, detail: `${destroyed.length} resource(s) destroyed: ${destroyed.slice(0, 5).map((c) => c.address).join(", ")}${destroyed.length > 5 ? "…" : ""}` }] : []),
      ],
      internal: { workspace, workdir: cfg.workdir ?? p.workdir ?? null, planPath: p.planPath ?? null, planHash },
    };
  }

  async execute(_req: EffectRequest, prepared: Prepared, _ctx: ConnectorContext): Promise<Executed> {
    const i = prepared.internal as { workdir: string | null; planPath: string | null; planHash: string };
    if (!i.planPath || !i.workdir) throw new ConnectorError("missing-plan", "execution needs params.planPath (saved plan) and a workdir");
    const now = createHash("sha256").update(readFileSync(i.planPath)).digest("hex");
    if (now !== prepared.effect.precondition) throw new ConnectorError("precondition-drift", "the saved plan file changed since approval");
    try {
      execFileSync("terraform", [`-chdir=${i.workdir}`, "apply", "-input=false", "-no-color", i.planPath], { stdio: ["ignore", "pipe", "pipe"], timeout: 30 * 60 * 1000 });
    } catch (e: any) {
      if (e?.code === "ENOENT") throw new ConnectorError("terraform-unavailable", "terraform is not installed on the broker host");
      throw new ConnectorError("apply-failed", String(e?.stderr ?? e?.message ?? e).slice(0, 600));
    }
    const c = prepared.effect.preview.counts;
    return { outcome: "executed", observedCounts: { create: c.create ?? 0, update: c.update ?? 0, delete: c.delete ?? 0, replace: c.replace ?? 0, resources: c.resources ?? 0 }, detail: "saved plan applied (Terraform itself refuses a stale saved plan)" };
  }
}
