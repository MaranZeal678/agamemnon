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

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createPublicKey, verify as edVerify, randomBytes } from "node:crypto";
import pg from "pg";
import { verifyReceipts } from "@agamemnon/kernel";
import { sweep } from "./sweep.ts";
import { hardenSql } from "./harden.ts";
import { checkMigration } from "./migration.ts";

/**
 *   agamemnon init            hooks + MCP for every coding agent found; deny agents
 *                             read access to secret files; optional vault move
 *   agamemnon sweep [dir]     find credentials an agent could use to bypass the broker
 *   agamemnon coverage        how much destructive intent went through the broker
 *   agamemnon harden-db       database-native row caps + timeouts (prints SQL; --apply)
 *   agamemnon check-migration <file.sql> [--simulate URL]   CI-friendly (exit 1 on errors)
 *   agamemnon receipts verify <file>                         verify signed effect receipts offline
 *   agamemnon pending | approve <id> | deny <id>             decide parked effects from a terminal
 *   agamemnon admin principal|target|secret …                broker administration
 */

const here = dirname(new URL(import.meta.url).pathname);
const REPO_PACKAGES = resolve(here, "../..");
const HOOK_BIN = join(REPO_PACKAGES, "hooks/bin/agamemnon-hook.js");
const MCP_BIN = join(REPO_PACKAGES, "agamemnon-mcp/bin/agamemnon-mcp.js");

type Args = { _: string[]; [k: string]: string | boolean | string[] };
export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const c = { bold: (s: string) => `\x1b[1m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m` };

function readJson(p: string): any {
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error(`${p} is not valid JSON — fix it or move it aside before running init`);
  }
}
function writeJson(p: string, v: unknown, dry: boolean, log: string[]) {
  log.push(`${dry ? "would write" : "wrote"} ${p}`);
  if (dry) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
}
function onPath(bin: string): boolean {
  try {
    execFileSync("/usr/bin/env", ["which", bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function broker(url: string, token: string, path: string, body?: unknown) {
  const res = await fetch(url + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `broker returned ${res.status}`);
  return json;
}

// ── init ─────────────────────────────────────────────────────────────────────
export async function init(args: Args, print = console.log): Promise<string[]> {
  const dir = resolve(String(args.dir ?? process.cwd()));
  const url = String(args.broker ?? process.env.AGAMEMNON_BROKER_URL ?? "http://127.0.0.1:7700");
  const dry = !!args["dry-run"];
  const log: string[] = [];
  const wanted = args.agents ? String(args.agents).split(",") : null;
  const has = (name: string, dot: string, bin: string) => (wanted ? wanted.includes(name) : existsSync(join(dir, dot)) || onPath(bin));

  const agents: string[] = [];
  if (has("claude", ".claude", "claude")) {
    agents.push("claude");
    const p = join(dir, ".claude/settings.json");
    const s = readJson(p);
    s.hooks ??= {};
    s.hooks.PreToolUse ??= [];
    const cmd = `node "${HOOK_BIN}" --agent claude`;
    if (!JSON.stringify(s.hooks.PreToolUse).includes("agamemnon-hook")) {
      s.hooks.PreToolUse.push({ matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: cmd, timeout: 10 }] });
    }
    // Keep secrets out of the agent's reach: the broker holds the real ones.
    s.permissions ??= {};
    s.permissions.deny = [...new Set([...(s.permissions.deny ?? []), "Read(./.env)", "Read(./.env.*)", "Read(~/.aws/**)", "Read(~/.ssh/**)", "Read(~/.pgpass)", "Read(~/.agamemnon/**)", "Bash(cat .env*)", "Bash(printenv:*)"])];
    writeJson(p, s, dry, log);
    if (args.token) writeJson(join(dir, ".claude/settings.local.json"), { ...readJson(join(dir, ".claude/settings.local.json")), env: { AGAMEMNON_BROKER_URL: url, AGAMEMNON_AGENT_TOKEN: String(args.token) } }, dry, log);
  }
  if (has("cursor", ".cursor", "cursor")) {
    agents.push("cursor");
    const p = join(dir, ".cursor/hooks.json");
    const h = readJson(p);
    h.version ??= 1;
    h.hooks ??= {};
    for (const ev of ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile"]) {
      h.hooks[ev] ??= [];
      if (!JSON.stringify(h.hooks[ev]).includes("agamemnon-hook")) h.hooks[ev].push({ command: `node "${HOOK_BIN}" --agent cursor` });
    }
    writeJson(p, h, dry, log);
  }
  // MCP server entry (Claude Code / Cursor read .mcp.json; ${VAR} is expanded by the client).
  const mcpPath = join(dir, ".mcp.json");
  const mcp = readJson(mcpPath);
  mcp.mcpServers ??= {};
  mcp.mcpServers.agamemnon = { command: "node", args: [MCP_BIN], env: { AGAMEMNON_BROKER_URL: url, AGAMEMNON_AGENT_TOKEN: "${AGAMEMNON_AGENT_TOKEN}" } };
  writeJson(mcpPath, mcp, dry, log);

  for (const [name, dot, bin, how] of [
    ["codex", ".codex", "codex", `add a PreToolUse hook running: node "${HOOK_BIN}" --agent codex   (and set allow_managed_hooks_only in requirements.toml for teams)`],
    ["gemini", ".gemini", "gemini", `add a BeforeTool hook running: node "${HOOK_BIN}" --agent gemini`],
    ["windsurf", ".windsurf", "windsurf", `add pre_run_command / pre_write_code hooks running: node "${HOOK_BIN}" --agent windsurf`],
  ] as const) {
    if (has(name, dot, bin)) {
      agents.push(name);
      log.push(`${name}: ${how}`);
    }
  }

  // Credentials an agent could use to bypass the broker.
  const hits = sweep(dir);
  if (hits.length) log.push(`found ${hits.length} credential(s) outside the vault — run \`agamemnon sweep\` for the list`);
  const adminToken = String(args["admin-token"] ?? process.env.AGAMEMNON_ADMIN_TOKEN ?? "");
  if (args.vault && adminToken) {
    for (const envFile of [".env", ".env.local"]) {
      const p = join(dir, envFile);
      if (!existsSync(p)) continue;
      let text = readFileSync(p, "utf8");
      const backup = `${p}.agamemnon.bak`;
      let moved = 0;
      for (const m of text.matchAll(/^([A-Z0-9_]*DATABASE_URL[A-Z0-9_]*)=(postgres(?:ql)?:\/\/[^\s]+)$/gm)) {
        const [line, name, value] = m;
        if (value.includes("agm_ph_")) continue;
        const conn = name.replace(/_?DATABASE_URL_?/, "").toLowerCase() || "default";
        const u = new URL(value);
        if (!dry) {
          const r = await broker(url, adminToken, "/v1/admin/secrets", { name: `postgres/${conn}`, value });
          await broker(url, adminToken, "/v1/admin/targets", { system: "postgres", resource: `connection:${conn}`, env: String(args.env ?? "prod"), fingerprint: `${u.hostname}:${u.port || "5432"}${u.pathname}`, config: { secret: `postgres/${conn}`, allowlist: [], defaultMedian: 1000 } });
          text = text.replace(line, `${name}=${value.replace(/:\/\/([^:@]+):[^@]+@/, `://$1:${r.placeholder}@`)}`);
        }
        moved++;
      }
      if (moved && !dry) {
        copyFileSync(p, backup);
        chmodSync(backup, 0o600);
        writeFileSync(p, text);
        log.push(`moved ${moved} database credential(s) from ${envFile} into the vault (backup: ${envFile}.agamemnon.bak, 0600) — register allowlisted tables with \`agamemnon admin target\``);
      }
    }
  }
  print(c.bold(`Agamemnon init — ${agents.length ? agents.join(", ") : "no coding agents detected"} → ${url}`));
  for (const l of log) print(`  • ${l}`);
  print(c.dim("  Next: export AGAMEMNON_AGENT_TOKEN=<token from `agamemnon admin principal add --kind agent`> and restart your agent."));
  print(c.dim("  Try it: ask the agent to \"delete the stale rows in orders\" — the effect is measured, bound, and parked in the console."));
  return log;
}

// ── sweep ────────────────────────────────────────────────────────────────────
function cmdSweep(args: Args, print = console.log): number {
  const dir = resolve(String(args._[1] ?? process.cwd()));
  const hits = sweep(dir);
  if (args.json) {
    print(JSON.stringify(hits, null, 2));
    return hits.length ? 1 : 0;
  }
  if (!hits.length) {
    print(c.green("✓ no credentials found outside the vault"));
    return 0;
  }
  print(c.bold(c.red(`${hits.length} credential(s) an agent could use to bypass Agamemnon:`)));
  for (const h of hits) print(`  ${c.yellow(h.kind.padEnd(22))} ${h.file}:${h.line}  ${c.dim(h.preview)}`);
  print(c.dim("\nMove database URLs into the vault with `agamemnon init --vault`, rotate the rest, and keep only agm_ph_ placeholders in files."));
  return 1;
}

// ── coverage ─────────────────────────────────────────────────────────────────
async function cmdCoverage(args: Args, print = console.log): Promise<number> {
  const url = String(args.broker ?? process.env.AGAMEMNON_BROKER_URL ?? "http://127.0.0.1:7700");
  const token = String(args.token ?? process.env.AGAMEMNON_OPERATOR_TOKEN ?? "");
  const s = await broker(url, token, "/v1/console/state?limit=500");
  const effects = s.effects as any[];
  const destructive = effects.filter((e) => (e.counts?.rows ?? 0) > 0 || /delete|apply|refund|send|mute|protection/.test(e.operation));
  const through = destructive.length;
  const byKind: Record<string, number> = {};
  for (const ev of s.coverage as any[]) byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1;
  const bypass = (byKind["bypass-credential"] ?? 0) + (byKind["placeholder-used-directly"] ?? 0);
  const hookStops = (byKind["hook-deny"] ?? 0) + (byKind["hook-ask"] ?? 0);
  const total = through + bypass;
  print(c.bold("Agamemnon bypass coverage"));
  print(`  destructive effects mediated by the broker   ${through}`);
  print(`  risky commands stopped at the hook           ${hookStops}`);
  print(`  bypass attempts (real credential / placeholder outside the broker)  ${bypass ? c.red(String(bypass)) : c.green("0")}`);
  print(`  coverage                                     ${total ? ((through / total) * 100).toFixed(1) : "100.0"}%`);
  return bypass ? 1 : 0;
}

// ── harden-db ────────────────────────────────────────────────────────────────
async function cmdHarden(args: Args, print = console.log): Promise<number> {
  const tables = String(args.tables ?? "").split(",").filter(Boolean);
  if (!tables.length) throw new Error("--tables a,b,c is required");
  const sql = hardenSql({ tables, cap: Number(args.cap ?? 5000), appRole: args["app-role"] ? String(args["app-role"]) : undefined, brokerRole: String(args["broker-role"] ?? "agamemnon_svc") });
  if (!args.apply) {
    print(sql);
    return 0;
  }
  const client = new pg.Client({ connectionString: String(args.url ?? process.env.DATABASE_URL) });
  await client.connect();
  try {
    await client.query(sql);
    print(c.green(`✓ row cap ${args.cap ?? 5000} installed on ${tables.join(", ")}`));
  } finally {
    await client.end();
  }
  return 0;
}

// ── check-migration ──────────────────────────────────────────────────────────
async function cmdCheckMigration(args: Args, print = console.log): Promise<number> {
  const file = String(args._[1] ?? "");
  if (!file) throw new Error("usage: agamemnon check-migration <file.sql> [--simulate postgres://…] [--json]");
  const sql = readFileSync(file, "utf8");
  const r = await checkMigration(sql);
  let simulation: Record<string, { before: number; after: number }> | null = null;
  if (args.simulate) simulation = await simulate(String(args.simulate), sql);
  if (args.json) print(JSON.stringify({ ...r, simulation }, null, 2));
  else {
    print(c.bold(`${file}: ${r.statements} statement(s), ${r.findings.length} finding(s)`));
    for (const f of r.findings) print(`  ${f.severity === "error" ? c.red("error  ") : c.yellow("warning")} ${f.id} ${f.statement ? `stmt ${f.statement}: ` : ""}${f.message}${f.fix ? c.dim(` — ${f.fix}`) : ""}`);
    if (simulation) {
      print(c.bold("  simulated on a throwaway copy:"));
      for (const [t, v] of Object.entries(simulation)) print(`    ${t.padEnd(24)} ${v.before.toLocaleString()} → ${v.after.toLocaleString()}${v.after !== v.before ? c.yellow(`  (${v.after - v.before >= 0 ? "+" : ""}${(v.after - v.before).toLocaleString()})`) : ""}`);
    }
  }
  const failOn = args["fail-on"] === "warning" ? ["error", "warning"] : ["error"];
  return r.findings.some((f) => failOn.includes(f.severity)) ? 1 : 0;
}

/** Run the migration on CREATE DATABASE … TEMPLATE copy and report row counts. Dev/staging only. */
async function simulate(url: string, sql: string) {
  const u = new URL(url);
  const source = u.pathname.slice(1);
  const sim = `agm_sim_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString() });
  await admin.connect();
  const counts = async (dbUrl: string) => {
    const cl = new pg.Client({ connectionString: dbUrl });
    await cl.connect();
    try {
      const tables = (await cl.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename as string);
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = Number((await cl.query(`SELECT count(*)::bigint AS n FROM "${t.replace(/"/g, '""')}"`)).rows[0].n);
      return out;
    } finally {
      await cl.end();
    }
  };
  try {
    await admin.query(`CREATE DATABASE "${sim}" TEMPLATE "${source.replace(/"/g, '""')}"`);
    const simUrl = Object.assign(new URL(url), { pathname: `/${sim}` }).toString();
    const before = await counts(simUrl);
    const cl = new pg.Client({ connectionString: simUrl });
    await cl.connect();
    try {
      await cl.query("SET lock_timeout = '5s'");
      await cl.query(sql);
    } finally {
      await cl.end();
    }
    const after = await counts(simUrl);
    const out: Record<string, { before: number; after: number }> = {};
    for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) out[t] = { before: before[t] ?? 0, after: after[t] ?? 0 };
    return out;
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${sim}"`).catch(() => {});
    await admin.end();
  }
}

// ── receipts ─────────────────────────────────────────────────────────────────
function cmdReceipts(args: Args, print = console.log): number {
  const file = String(args._[2] ?? "");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const list = data.receipts ?? data;
  const v = verifyReceipts(list, (payload, sig, pub) => edVerify(null, Buffer.from(payload), createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" }), Buffer.from(sig, "base64")));
  if (data.publicKey && list.some((r: any) => r.publicKey !== data.publicKey)) {
    print(c.red("✗ some receipts were signed by a different key than the broker's published one"));
    return 1;
  }
  print(v.ok ? c.green(`✓ ${v.checked} receipts: signatures valid, chain intact`) : c.red(`✗ broken at receipt ${v.brokenAt!.index}: ${v.brokenAt!.reason}`));
  return v.ok ? 0 : 1;
}

// ── approvals ────────────────────────────────────────────────────────────────
function operator(args: Args) {
  const url = String(args.broker ?? process.env.AGAMEMNON_BROKER_URL ?? "http://127.0.0.1:7700");
  const token = String(args.token ?? process.env.AGAMEMNON_OPERATOR_TOKEN ?? "");
  if (!token) throw new Error("an operator token is required: --token T or AGAMEMNON_OPERATOR_TOKEN");
  return { url, token };
}

async function cmdPending(args: Args, print = console.log): Promise<number> {
  const { url, token } = operator(args);
  const s = await broker(url, token, "/v1/console/state?limit=500");
  const pending = (s.effects as any[]).filter((e) => e.status === "awaiting_approval");
  if (args.json) {
    print(JSON.stringify(pending, null, 2));
    return 0;
  }
  if (!pending.length) {
    print(c.green("No effects are waiting for approval."));
    return 0;
  }
  print(c.bold(`${pending.length} effect${pending.length === 1 ? "" : "s"} waiting for approval`));
  for (const e of pending) {
    const got = (e.approvals ?? []).filter((a: any) => a.decision === "approve").length;
    print("");
    print(`  ${c.bold(e.id)}  ${e.operation} · ${e.resource}${e.env ? ` (${e.env})` : ""}`);
    print(`    ${e.summary}`);
    print(c.dim(`    ${e.reversibility ?? "unknown"} · ${e.fidelity ?? "?"} preview · requested by ${e.agent} · approvals ${got}/${e.requiredApprovals ?? "?"}${e.oversight?.length ? ` · ${c.yellow("reduces oversight")}` : ""}`));
    for (const r of e.firedRules ?? []) print(c.dim(`    - ${r.name}: ${r.detail ?? ""}`));
  }
  print("");
  print(c.dim("  agamemnon approve <id> [--note …]   ·   agamemnon deny <id> [--note …]"));
  return 0;
}

async function cmdDecide(decision: "approve" | "deny", args: Args, print = console.log): Promise<number> {
  const id = String(args._[1] ?? "");
  if (!/^[\w-]+$/.test(id)) throw new Error(`usage: agamemnon ${decision} <effect id> [--note "why"]`);
  const { url, token } = operator(args);
  const r = await broker(url, token, `/v1/effects/${id}/${decision}`, { note: typeof args.note === "string" ? args.note : "" });
  if (args.json) {
    print(JSON.stringify(r, null, 2));
    return 0;
  }
  const state = r.approvalState ?? r.status;
  if (decision === "deny") print(c.red(`✗ ${id} denied`));
  else if (state === "pending") print(c.yellow(`… ${id}: your approval is recorded; it still needs another independent approver`));
  else print(c.green(`✓ ${id} approved → ${r.status}`));
  if (r.error) print(c.red(`  ${r.error}`));
  return 0;
}

// ── admin ────────────────────────────────────────────────────────────────────
async function cmdAdmin(args: Args, print = console.log): Promise<number> {
  const url = String(args.broker ?? process.env.AGAMEMNON_BROKER_URL ?? "http://127.0.0.1:7700");
  const token = String(args.token ?? process.env.AGAMEMNON_ADMIN_TOKEN ?? "");
  const what = args._[1];
  if (what === "principal" && args._[2] === "add") {
    const r = await broker(url, token, "/v1/admin/principals", { name: args.name, kind: args.kind ?? "agent", role: args.role, owner: args.owner });
    print(`${r.name}: ${r.token}`);
    print(c.dim(r.note));
    return 0;
  }
  if (what === "target") {
    await broker(url, token, "/v1/admin/targets", { system: args.system, resource: args.resource, env: args.env, fingerprint: args.fingerprint, config: args.config ? JSON.parse(String(args.config)) : undefined });
    print(c.green(`✓ target ${args.system}:${args.resource} registered (${args.env ?? "no env"})`));
    return 0;
  }
  if (what === "secret") {
    const value = String(args.value ?? process.env.AGAMEMNON_SECRET_VALUE ?? "");
    const r = await broker(url, token, "/v1/admin/secrets", { name: args.name, value });
    print(`placeholder for ${r.name}: ${r.placeholder}`);
    return 0;
  }
  if (what === "mode") {
    const r = await broker(url, token, "/v1/admin/mode", { mode: args._[2] });
    print(`mode: ${r.mode}`);
    return 0;
  }
  throw new Error("usage: agamemnon admin principal add --name N --kind agent|human [--role approver|admin|auditor] [--owner human] | target --system S --resource R --env E [--config JSON] | secret --name N --value V | mode enforce|shadow");
}

export async function run(argv: string[], print = console.log): Promise<number> {
  const args = parseArgs(argv);
  switch (args._[0]) {
    case "init":
      await init(args, print);
      return 0;
    case "sweep":
      return cmdSweep(args, print);
    case "coverage":
      return cmdCoverage(args, print);
    case "harden-db":
      return cmdHarden(args, print);
    case "check-migration":
      return cmdCheckMigration(args, print);
    case "receipts":
      return cmdReceipts(args, print);
    case "pending":
      return cmdPending(args, print);
    case "approve":
    case "deny":
      return cmdDecide(args._[0] as "approve" | "deny", args, print);
    case "admin":
      return cmdAdmin(args, print);
    default:
      print(`agamemnon — the consequence layer for agent actions

  init [--broker URL] [--agents claude,cursor] [--token T] [--vault --admin-token T] [--dry-run]
  sweep [dir] [--json]
  coverage [--broker URL] [--token OPERATOR_TOKEN]
  harden-db --tables a,b [--cap 5000] [--app-role R] [--broker-role agamemnon_svc] [--apply --url URL]
  check-migration <file.sql> [--simulate URL] [--fail-on warning] [--json]
  receipts verify <receipts.json>
  pending [--broker URL] [--token OPERATOR_TOKEN] [--json]
  approve <effect id> [--note "why"] [--json]
  deny <effect id> [--note "why"] [--json]
  admin principal add | target | secret | mode`);
      return args._[0] ? 1 : 0;
  }
}

export async function main() {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (e: any) {
    console.error(c.red(`agamemnon: ${e?.message ?? e}`));
    process.exitCode = 2;
  }
}

if ((import.meta as any).main) await main();
