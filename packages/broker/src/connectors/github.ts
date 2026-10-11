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

import { classifyOversight, hashOf, type EffectRequest, type ObservedFacts } from "@agamemnon/kernel";
import { ConnectorError, type Compensated, type Connector, type ConnectorContext, type Executed, type Prepared } from "./types.ts";
import type { EffectRow } from "../store.ts";

/**
 * GitHub connector (REST v3). The agent never holds the GitHub token.
 *
 *   github.contents.write / .delete   preview = diff vs the file at the branch
 *                                     head; precondition = blob SHA; undo =
 *                                     restore the previous content
 *   github.branch.delete              undo = recreate the ref at the saved SHA
 *   github.branch_protection.update / .delete
 *                                     oversight class; compensate = restore the
 *                                     previous protection
 *   github.deploy_key.create / github.webhook.create
 *                                     durable access → artifact revoked at task end
 *   github.pull.create                egress when the repo is public; compensate = close
 *
 * Facts for claim verification: check-run conclusions on commits this task made.
 */

export interface GithubConfig {
  apiBase?: string; // default https://api.github.com
  secret: string; // vault secret holding a token
  repos: string[]; // allowlisted "owner/name"
}

export class GithubConnector implements Connector {
  readonly system = "github";
  readonly operations = [
    "github.contents.write",
    "github.contents.delete",
    "github.branch.delete",
    "github.branch_protection.update",
    "github.branch_protection.delete",
    "github.deploy_key.create",
    "github.webhook.create",
    "github.pull.create",
  ];

  private cfg(req: EffectRequest, ctx: ConnectorContext): { cfg: GithubConfig; env: string | null; repo: string } {
    const account = String(req.params.account ?? "default");
    const t = ctx.store.target("github", `account:${account}`);
    if (!t?.config) throw new ConnectorError("target-unregistered", `GitHub account "${account}" is not registered`);
    const repo = String(req.params.repo ?? "");
    const cfg = t.config as GithubConfig;
    if (!cfg.repos.includes(repo)) throw new ConnectorError("repo-not-allowed", `${repo} is not on the GitHub allowlist`);
    return { cfg, env: t.env, repo };
  }

  private async gh(cfg: GithubConfig, ctx: ConnectorContext, method: string, path: string, body?: unknown): Promise<any> {
    const token = ctx.vault.get(cfg.secret);
    if (!token) throw new ConnectorError("no-credential", `vault has no secret "${cfg.secret}"`);
    const res = await fetch(`${cfg.apiBase ?? "https://api.github.com"}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ConnectorError("github-error", `GitHub ${method} ${path} → ${res.status}: ${json.message ?? text.slice(0, 200)}`);
    return json;
  }

  async prepare(req: EffectRequest, ctx: ConnectorContext): Promise<Prepared> {
    const { cfg, env, repo } = this.cfg(req, ctx);
    const p = req.params as Record<string, any>;
    const target = { system: "github", resource: `${repo}${p.branch ? `@${p.branch}` : ""}`, env: env ?? undefined };
    const base = { request: { ...req, target }, creates: [] as any[], egress: false, reads: [`github:${repo}`], writes: [`github:${repo}`] };
    const op = req.operation;

    if (op === "github.contents.write" || op === "github.contents.delete") {
      const branch = String(p.branch ?? "main");
      const cur = await this.gh(cfg, ctx, "GET", `/repos/${repo}/contents/${encodeURI(String(p.path))}?ref=${encodeURIComponent(branch)}`);
      const before = cur?.content ? Buffer.from(cur.content, "base64").toString("utf8") : undefined;
      if (op === "github.contents.delete" && !cur) throw new ConnectorError("not-found", `${p.path} not found on ${branch}`);
      const after = op === "github.contents.write" ? String(p.content ?? "") : undefined;
      const oversight = classifyOversight({ system: "github", operation: op.endsWith("delete") ? "delete" : "write", resource: String(p.path), before, after });
      const bl = before?.split("\n") ?? [];
      const al = after?.split("\n") ?? [];
      return {
        effect: {
          ...base,
          request: { ...req, target: { ...target, resource: `${repo}@${branch}:${p.path}` } },
          reversibility: "undo",
          preview: { summary: `${op.endsWith("delete") ? "delete" : cur ? "edit" : "create"} ${p.path} on ${repo}@${branch} (+${al.filter((l) => !bl.includes(l)).length} / −${bl.filter((l) => !al.includes(l)).length})`, counts: { files: 1 }, fidelity: "exact" },
          precondition: cur?.sha ?? "absent",
          oversight,
          writes: [`github:${repo}:${branch}:${p.path}`],
        },
        internal: { op, repo, branch, path: p.path, prevSha: cur?.sha ?? null, prevContent: cur?.content ?? null },
      };
    }
    if (op === "github.branch.delete") {
      const ref = await this.gh(cfg, ctx, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(String(p.branch))}`);
      if (!ref) throw new ConnectorError("not-found", `branch ${p.branch} not found`);
      const repoInfo = await this.gh(cfg, ctx, "GET", `/repos/${repo}`);
      const isDefault = repoInfo?.default_branch === p.branch;
      return {
        effect: { ...base, reversibility: "undo", preview: { summary: `delete branch ${p.branch} (head ${String(ref.object.sha).slice(0, 7)})`, counts: { branches: 1 }, fidelity: "exact" }, precondition: ref.object.sha, oversight: isDefault ? [{ rule: "default-branch-deleted", detail: `${p.branch} is the default branch` }] : [] },
        connectorRules: isDefault ? [{ name: "default-branch", severity: "block", detail: "deleting the default branch is refused" }] : [],
        internal: { op, repo, branch: p.branch, sha: ref.object.sha },
      };
    }
    if (op === "github.branch_protection.update" || op === "github.branch_protection.delete") {
      const cur = await this.gh(cfg, ctx, "GET", `/repos/${repo}/branches/${encodeURIComponent(String(p.branch))}/protection`);
      const call = `${op.endsWith("delete") ? "DELETE" : "PUT"} branch_protection ${p.branch}`;
      const oversight = classifyOversight({ system: "github", operation: "api", params: { call, ...(p.protection ?? {}) } });
      if (op.endsWith("update") && cur) {
        const prevChecks = cur.required_status_checks?.contexts ?? [];
        const nextChecks = p.protection?.required_status_checks?.contexts ?? [];
        const dropped = prevChecks.filter((c: string) => !nextChecks.includes(c));
        if (dropped.length) oversight.push({ rule: "required-checks-removed", detail: `required checks removed: ${dropped.join(", ")}` });
      }
      return {
        effect: { ...base, reversibility: "compensate", preview: { summary: `${op.endsWith("delete") ? "remove" : "change"} branch protection on ${repo}@${p.branch}`, counts: { rules: 1 }, fidelity: "exact", details: { before: cur ?? null, after: p.protection ?? null } }, precondition: hashOf(cur ?? null), oversight },
        internal: { op, repo, branch: p.branch, previous: cur ?? null },
      };
    }
    if (op === "github.deploy_key.create" || op === "github.webhook.create") {
      const kind = op === "github.deploy_key.create" ? "deploy_key" : "webhook";
      const detail = kind === "deploy_key" ? `${p.read_only === false ? "read-WRITE" : "read-only"} deploy key "${p.title}"` : `webhook → ${p.config?.url ?? p.url}`;
      return {
        effect: {
          ...base,
          reversibility: "undo",
          preview: { summary: `create ${detail} on ${repo}`, counts: { resources: 1 }, fidelity: "exact" },
          precondition: `create:${hashOf(p)}`,
          oversight: kind === "deploy_key" && p.read_only === false ? [{ rule: "persistent-identity-created", detail: "write-capable deploy key" }] : [],
          creates: [{ kind, id: "(pending)", system: "github", durableAccess: true }],
          egress: kind === "webhook",
        },
        internal: { op, repo },
      };
    }
    if (op === "github.pull.create") {
      const info = await this.gh(cfg, ctx, "GET", `/repos/${repo}`);
      const isPublic = info ? info.private === false : true;
      return {
        effect: { ...base, reversibility: "compensate", preview: { summary: `open PR "${p.title}" ${p.head} → ${p.base} on ${isPublic ? "PUBLIC" : "private"} repo ${repo}`, counts: { pulls: 1 }, fidelity: "exact" }, precondition: `pr:${hashOf({ head: p.head, base: p.base })}`, oversight: [], egress: isPublic, writes: [] },
        internal: { op, repo },
      };
    }
    throw new ConnectorError("unknown-operation", op);
  }

  async execute(req: EffectRequest, prepared: Prepared, ctx: ConnectorContext): Promise<Executed> {
    const { cfg, repo } = this.cfg(req, ctx);
    const i = prepared.internal as any;
    const p = req.params as Record<string, any>;
    switch (i.op) {
      case "github.contents.write":
      case "github.contents.delete": {
        const cur = await this.gh(cfg, ctx, "GET", `/repos/${repo}/contents/${encodeURI(i.path)}?ref=${encodeURIComponent(i.branch)}`);
        if ((cur?.sha ?? "absent") !== prepared.effect.precondition) throw new ConnectorError("precondition-drift", `${i.path} changed on ${i.branch} since approval`);
        const r =
          i.op === "github.contents.write"
            ? await this.gh(cfg, ctx, "PUT", `/repos/${repo}/contents/${encodeURI(i.path)}`, { message: p.message ?? `agent change via Agamemnon`, content: Buffer.from(String(p.content ?? "")).toString("base64"), branch: i.branch, sha: cur?.sha })
            : await this.gh(cfg, ctx, "DELETE", `/repos/${repo}/contents/${encodeURI(i.path)}`, { message: p.message ?? `agent delete via Agamemnon`, branch: i.branch, sha: cur.sha });
        return { outcome: "executed", observedCounts: { files: 1 }, undo: { prevContent: i.prevContent, newSha: r?.content?.sha ?? null, commit: r?.commit?.sha ?? null }, result: { commit: r?.commit?.sha ?? null }, detail: `${i.op.endsWith("delete") ? "deleted" : "committed"} ${i.path} on ${i.branch}` };
      }
      case "github.branch.delete": {
        const ref = await this.gh(cfg, ctx, "GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(i.branch)}`);
        if (ref?.object?.sha !== prepared.effect.precondition) throw new ConnectorError("precondition-drift", `branch ${i.branch} moved since approval`);
        await this.gh(cfg, ctx, "DELETE", `/repos/${repo}/git/refs/heads/${encodeURIComponent(i.branch)}`);
        return { outcome: "executed", observedCounts: { branches: 1 }, undo: { sha: i.sha }, detail: `deleted branch ${i.branch} (restorable at ${String(i.sha).slice(0, 7)})` };
      }
      case "github.branch_protection.update":
      case "github.branch_protection.delete": {
        const cur = await this.gh(cfg, ctx, "GET", `/repos/${repo}/branches/${encodeURIComponent(i.branch)}/protection`);
        if (hashOf(cur ?? null) !== prepared.effect.precondition) throw new ConnectorError("precondition-drift", "branch protection changed since approval");
        if (i.op.endsWith("delete")) await this.gh(cfg, ctx, "DELETE", `/repos/${repo}/branches/${encodeURIComponent(i.branch)}/protection`);
        else await this.gh(cfg, ctx, "PUT", `/repos/${repo}/branches/${encodeURIComponent(i.branch)}/protection`, p.protection);
        return { outcome: "executed", observedCounts: { rules: 1 }, undo: { previous: i.previous }, detail: `branch protection ${i.op.endsWith("delete") ? "removed" : "changed"} on ${i.branch}` };
      }
      case "github.deploy_key.create": {
        const k = await this.gh(cfg, ctx, "POST", `/repos/${repo}/keys`, { title: p.title, key: p.key, read_only: p.read_only !== false });
        return { outcome: "executed", observedCounts: { resources: 1 }, artifacts: [{ kind: "deploy_key", id: `github:${repo}:key:${k.id}`, system: "github", durableAccess: true, revoke: { repo, path: `/repos/${repo}/keys/${k.id}`, account: p.account ?? "default" } }], detail: `deploy key ${k.id} created (expires with the task)` };
      }
      case "github.webhook.create": {
        const h = await this.gh(cfg, ctx, "POST", `/repos/${repo}/hooks`, { name: "web", active: true, events: p.events ?? ["push"], config: p.config ?? { url: p.url, content_type: "json" } });
        return { outcome: "executed", observedCounts: { resources: 1 }, artifacts: [{ kind: "webhook", id: `github:${repo}:hook:${h.id}`, system: "github", durableAccess: true, revoke: { repo, path: `/repos/${repo}/hooks/${h.id}`, account: p.account ?? "default" } }], detail: `webhook ${h.id} created (expires with the task)` };
      }
      case "github.pull.create": {
        const pr = await this.gh(cfg, ctx, "POST", `/repos/${repo}/pulls`, { title: p.title, head: p.head, base: p.base, body: p.body });
        return { outcome: "executed", observedCounts: { pulls: 1 }, undo: { number: pr.number }, result: { number: pr.number, url: pr.html_url }, detail: `PR #${pr.number} opened` };
      }
    }
    throw new ConnectorError("unknown-operation", i.op);
  }

  async compensate(row: EffectRow, ctx: ConnectorContext): Promise<Compensated> {
    const req = row.effect.request as EffectRequest;
    const { cfg, repo } = this.cfg(req, ctx);
    const i = row.effect.internal;
    const u = row.result?.undo ?? {};
    switch (i.op) {
      case "github.contents.write":
      case "github.contents.delete": {
        const cur = await this.gh(cfg, ctx, "GET", `/repos/${repo}/contents/${encodeURI(i.path)}?ref=${encodeURIComponent(i.branch)}`);
        if (i.op === "github.contents.write" && (cur?.sha ?? null) !== (u.newSha ?? null)) return { detail: `${i.path} was edited after the agent's commit — left as is`, restored: 0, skipped: [{ key: i.path, reason: "edited after" }] };
        if (u.prevContent) await this.gh(cfg, ctx, "PUT", `/repos/${repo}/contents/${encodeURI(i.path)}`, { message: `Revert agent change (Agamemnon ${row.id})`, content: u.prevContent.replace(/\n/g, ""), branch: i.branch, sha: cur?.sha });
        else if (cur) await this.gh(cfg, ctx, "DELETE", `/repos/${repo}/contents/${encodeURI(i.path)}`, { message: `Revert agent change (Agamemnon ${row.id})`, branch: i.branch, sha: cur.sha });
        return { detail: `restored ${i.path} on ${i.branch}`, restored: 1 };
      }
      case "github.branch.delete":
        await this.gh(cfg, ctx, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${i.branch}`, sha: u.sha });
        return { detail: `recreated branch ${i.branch} at ${String(u.sha).slice(0, 7)}`, restored: 1 };
      case "github.branch_protection.update":
      case "github.branch_protection.delete":
        if (u.previous) await this.gh(cfg, ctx, "PUT", `/repos/${repo}/branches/${encodeURIComponent(i.branch)}/protection`, protectionPayload(u.previous));
        return { detail: `restored branch protection on ${i.branch}`, restored: 1 };
      case "github.pull.create":
        await this.gh(cfg, ctx, "PATCH", `/repos/${repo}/pulls/${u.number}`, { state: "closed" });
        return { detail: `closed PR #${u.number}`, restored: 1 };
    }
    return { detail: "artifact creations are reversed by revocation", restored: 0 };
  }

  async revokeArtifact(a: { id: string; kind: string; revoke: any }, ctx: ConnectorContext) {
    const t = ctx.store.target("github", `account:${a.revoke?.account ?? "default"}`);
    if (!t?.config) throw new ConnectorError("target-unregistered", "GitHub account missing");
    await this.gh(t.config as GithubConfig, ctx, "DELETE", a.revoke.path);
  }

  async facts(taskId: string, ctx: ConnectorContext): Promise<Partial<ObservedFacts>> {
    const effects = ctx.store.lineage(taskId).flatMap((t) => ctx.store.effectsByTask(t)).filter((e) => e.system === "github" && e.status === "executed" && e.result?.result?.commit);
    if (!effects.length) return {};
    const last = effects[effects.length - 1];
    const req = last.effect.request as EffectRequest;
    const { cfg, repo } = this.cfg(req, ctx);
    const runs = await this.gh(cfg, ctx, "GET", `/repos/${repo}/commits/${last.result.result.commit}/check-runs`);
    const list = runs?.check_runs ?? [];
    if (!list.length) return { tests: { conclusion: "none" } };
    const failed = list.some((r: any) => r.conclusion && !["success", "skipped", "neutral"].includes(r.conclusion));
    return { tests: { conclusion: failed ? "failure" : list.every((r: any) => r.status === "completed") ? "success" : "none" } };
  }
}

/** GitHub returns protection in a different shape than it accepts. */
function protectionPayload(p: any) {
  return {
    required_status_checks: p.required_status_checks ? { strict: !!p.required_status_checks.strict, contexts: p.required_status_checks.contexts ?? [] } : null,
    enforce_admins: !!p.enforce_admins?.enabled,
    required_pull_request_reviews: p.required_pull_request_reviews
      ? { required_approving_review_count: p.required_pull_request_reviews.required_approving_review_count ?? 1, dismiss_stale_reviews: !!p.required_pull_request_reviews.dismiss_stale_reviews }
      : null,
    restrictions: null,
  };
}
