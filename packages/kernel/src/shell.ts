// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * Shell-command analysis for coding-agent hooks (Claude Code, Cursor, Codex,
 * Gemini, Windsurf). Shared by the hook (offline, fail-closed) and the broker.
 *
 * A hook sees the command string, not what a script or Makefile target does —
 * so callers pass the BODIES of any scripts the command runs (`bash x.sh`,
 * `npm run reset`, `make clean`) in `expansions`, and those are analysed too.
 * A hook is still advisory: the enforcement point is the broker, because the
 * real credentials only exist there (the agent sees placeholders).
 *
 * Patterns come from real incidents: `terraform destroy` on stale state
 * (DataTalks.Club 2026), `prisma migrate reset` against prod (2026), `rm -rf ~/`
 * (Claude Code / Gemini CLI 2025), platform volume deletes with a stray token
 * (PocketOS 2026), force-pushes and hard resets.
 */

export type ShellVerdict = "allow" | "ask" | "deny";

export interface ShellFinding {
  rule: string;
  verdict: ShellVerdict;
  detail: string;
  /** What to do instead — surfaced to the agent so it reroutes, not retries. */
  reroute?: string;
}

interface Pattern {
  rule: string;
  re: RegExp;
  verdict: ShellVerdict;
  detail: string;
  reroute?: string;
}

const PATTERNS: Pattern[] = [
  { rule: "terraform-destroy", re: /\bterraform\s+(-chdir=\S+\s+)?(destroy|apply\b[^|;&]*-destroy)\b/, verdict: "deny", detail: "terraform destroy tears down real infrastructure (and often its backups)", reroute: "propose it through Agamemnon: agm_propose with operation terraform.apply and the saved plan" },
  { rule: "terraform-auto-approve", re: /\bterraform\s+(-chdir=\S+\s+)?apply\b[^|;&]*-auto-approve\b/, verdict: "deny", detail: "terraform apply -auto-approve skips the plan review", reroute: "run `terraform plan -out=plan.tfplan` and propose the plan through Agamemnon" },
  { rule: "prisma-reset", re: /\bprisma\s+(migrate\s+reset|db\s+push\b[^|;&]*(--force-reset|--accept-data-loss)|migrate\s+diff\b[^|;&]*--shadow-database-url)/, verdict: "deny", detail: "this Prisma command can drop every table in the target database", reroute: "use a disposable branch database (agamemnon init gives you one) and propose schema changes through Agamemnon" },
  { rule: "db-drop", re: /\b(dropdb|DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+)/i, verdict: "deny", detail: "destructive SQL outside the broker cannot be previewed or undone", reroute: "send the statement with agm_propose (postgres.sql)" },
  { rule: "db-cli-direct", re: /\b(psql|pg_dump|pg_restore|mysql|mongosh?|redis-cli)\b[^|;&]*(postgres(ql)?:\/\/|mysql:\/\/|mongodb(\+srv)?:\/\/|redis:\/\/|-h\s+\S+)/, verdict: "ask", detail: "direct database client connection outside the broker", reroute: "use agm_query / agm_propose so the effect is measured and reversible" },
  { rule: "rm-rf-dangerous", re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|--force\s+--recursive)[a-zA-Z]*\s+(\/|~|\$HOME|\.\.|\*|\.\s|\.$|\/Users|\/home|--no-preserve-root)/, verdict: "deny", detail: "recursive force-delete of a home, root, parent or wildcard path", reroute: "delete specific files inside the workspace (they go to Agamemnon's trash and can be restored)" },
  { rule: "git-force-push", re: /\bgit\s+push\b[^|;&]*(\s-f\b|--force(?!-with-lease)|\s\+\S+:)/, verdict: "ask", detail: "force-push rewrites shared history", reroute: "use --force-with-lease on your own branch, or open a PR" },
  { rule: "git-hard-reset", re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f[a-zA-Z]*d|checkout\s+--\s+\.|restore\s+--staged\s+--worktree\s+\.)/, verdict: "ask", detail: "discards uncommitted work irreversibly" },
  { rule: "git-hooks-bypass", re: /\bgit\s+(commit|push)\b[^|;&]*--no-verify\b/, verdict: "ask", detail: "skips the repository's own checks" },
  { rule: "cloud-delete", re: /\baws\s+\S+\s+(delete-\S+|terminate-instances|remove-\S+|deregister-\S+|rb\b|rm\b[^|;&]*--recursive)|\bgcloud\s+[^|;&]*\bdelete\b|\baz\s+[^|;&]*\bdelete\b/, verdict: "deny", detail: "cloud control-plane delete outside the broker", reroute: "propose it through Agamemnon so it is previewed, bound and held" },
  { rule: "cloud-oversight", re: /\baws\s+(cloudtrail\s+(stop-logging|delete-trail)|guardduty\s+delete-detector|config\s+stop-configuration-recorder|logs\s+delete-log-group)/, verdict: "deny", detail: "switches off cloud audit / detection" },
  { rule: "k8s-delete", re: /\bkubectl\s+[^|;&]*\b(delete|drain|cordon|scale\b[^|;&]*--replicas[= ]0)\b/, verdict: "ask", detail: "Kubernetes destructive operation" },
  { rule: "platform-delete", re: /\b(railway\s+(down|delete|volume\s+delete)|vercel\s+(remove|rm|projects?\s+rm)|supabase\s+(projects\s+delete|db\s+reset)|fly\s+(destroy|apps\s+destroy|volumes\s+destroy)|heroku\s+(apps:destroy|pg:reset)|neonctl\s+(projects|branches)\s+delete|netlify\s+sites:delete)\b/, verdict: "deny", detail: "hosting-platform delete — platforms often keep backups on the same volume", reroute: "propose it through Agamemnon (it becomes a held, cancellable delete)" },
  { rule: "platform-api-delete", re: /\bcurl\b[^|;&]*(-X\s*DELETE|--request\s+DELETE|volumeDelete|projectDelete|serviceDelete|environmentDelete)/i, verdict: "deny", detail: "raw API delete call — exactly the PocketOS path (one GraphQL volumeDelete)", reroute: "use the Agamemnon connector for this platform" },
  { rule: "secrets-exfil", re: /\b(cat|less|head|tail|base64|xxd)\b[^|;&]*(\.env\b|\.aws\/credentials|\.ssh\/id_|\.npmrc|\.pgpass|\.netrc|\.docker\/config\.json)|\b(env|printenv)\b\s*(\||>)/, verdict: "ask", detail: "reads credential files" },
  { rule: "pipe-to-shell", re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, verdict: "ask", detail: "pipes a remote script into a shell" },
  { rule: "agent-permission-bypass", re: /--dangerously-skip-permissions|--yolo\b|--trust-all-tools|bypassPermissions/, verdict: "deny", detail: "launches an AI CLI with its safety prompts disabled (the Nx s1ngularity technique)" },
  { rule: "disk-wipe", re: /\b(mkfs(\.\w+)?|dd\s+[^|;&]*of=\/dev\/|shred\s+-|diskutil\s+(erase|zero))/, verdict: "deny", detail: "disk-level destruction" },
  { rule: "chmod-world", re: /\bchmod\s+(-R\s+)?(0?777|a\+rwx)\s+(\/|~)/, verdict: "ask", detail: "makes a system or home path world-writable" },
];

/** Strings that look like real credentials (not Agamemnon placeholders). */
const CREDENTIAL = /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s:@\/]+:(?!agm_ph_)[^\s@\/]{6,}@|\b(AKIA|ASIA)[0-9A-Z]{16}\b|\bsk_live_[0-9a-zA-Z]{16,}|\bghp_[0-9A-Za-z]{30,}|\bxox[bpas]-[0-9A-Za-z-]{20,}|\bglpat-[0-9A-Za-z_-]{20}/;

export interface ShellAnalysis {
  verdict: ShellVerdict;
  findings: ShellFinding[];
  /** A real (non-placeholder) credential appears in the command: the broker is being bypassed. */
  bypassCredential: boolean;
  /** Scripts the command runs that the caller should expand and re-submit. */
  invokes: string[];
}

/** Which script files / targets does this command execute? (for expansion by the hook) */
export function invokedScripts(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/\b(?:bash|sh|zsh|source|\.)\s+([./\w-]+\.(?:sh|bash|zsh))\b/g)) out.push(m[1]);
  for (const m of command.matchAll(/(?:^|[\s;&|])(\.\/[\w./-]+)/g)) out.push(m[1]);
  for (const m of command.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g)) if (!["install", "i", "ci", "add", "test", "--version"].includes(m[1])) out.push(`package.json#${m[1]}`);
  for (const m of command.matchAll(/\bmake\s+([\w.-]+)/g)) out.push(`Makefile#${m[1]}`);
  for (const m of command.matchAll(/\b(?:node|tsx|ts-node|python3?|ruby|deno\s+run)\s+([./\w-]+\.(?:m?js|ts|py|rb))\b/g)) out.push(m[1]);
  return [...new Set(out)];
}

const RANK: Record<ShellVerdict, number> = { allow: 0, ask: 1, deny: 2 };

export function analyseShell(command: string, expansions: Record<string, string> = {}): ShellAnalysis {
  const findings: ShellFinding[] = [];
  const scan = (text: string, via?: string) => {
    for (const p of PATTERNS) {
      if (p.re.test(text)) {
        findings.push({ rule: p.rule, verdict: p.verdict, detail: via ? `${p.detail} (inside ${via})` : p.detail, reroute: p.reroute });
      }
    }
  };
  scan(command);
  for (const [name, body] of Object.entries(expansions)) scan(body, name);
  const bypassCredential = CREDENTIAL.test(command) || Object.values(expansions).some((b) => CREDENTIAL.test(b));
  if (bypassCredential) {
    findings.push({ rule: "real-credential-in-command", verdict: "deny", detail: "a real database/cloud credential appears in the command — it should only exist inside the Agamemnon broker", reroute: "run `agamemnon sweep` and move the credential into the vault" });
  }
  const verdict = findings.reduce<ShellVerdict>((acc, f) => (RANK[f.verdict] > RANK[acc] ? f.verdict : acc), "allow");
  return { verdict, findings, bypassCredential, invokes: invokedScripts(command) };
}

/** Does a credential-looking value in some text NOT belong to the vault? */
export function containsRealCredential(text: string): boolean {
  return CREDENTIAL.test(text);
}
