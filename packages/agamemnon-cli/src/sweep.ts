// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Credential sweep — finds the keys an agent could pick up and use to go
 * AROUND the broker. PocketOS (2026): a coding agent found a Railway token in
 * an unrelated file and deleted production with one API call. Every hit here
 * is a bypass route until the credential lives only in the Agamemnon vault.
 */

export interface SweepHit {
  file: string;
  line: number;
  kind: string;
  preview: string; // masked
  variable?: string;
}

const PATTERNS: Array<[string, RegExp]> = [
  ["postgres-url", /\b(postgres(?:ql)?):\/\/[^\s:@/'"]+:(?!agm_ph_)[^\s@/'"]{3,}@[^\s'"]+/],
  ["mysql-url", /\bmysql:\/\/[^\s:@/'"]+:[^\s@/'"]{3,}@[^\s'"]+/],
  ["mongodb-url", /\bmongodb(?:\+srv)?:\/\/[^\s:@/'"]+:[^\s@/'"]{3,}@[^\s'"]+/],
  ["redis-url", /\brediss?:\/\/[^\s'"]*:[^\s@/'"]{3,}@[^\s'"]+/],
  ["aws-access-key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["aws-secret", /\baws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}/i],
  ["stripe-live-key", /\b(sk|rk)_live_[0-9a-zA-Z]{20,}/],
  ["github-token", /\b(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}|\bgithub_pat_[0-9A-Za-z_]{40,}/],
  ["slack-token", /\bxox[abprs]-[0-9A-Za-z-]{20,}/],
  ["gitlab-token", /\bglpat-[0-9A-Za-z_-]{20}/],
  ["openai-key", /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{32,}/],
  ["private-key", /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["railway-token", /\bRAILWAY_(API_)?TOKEN\s*=\s*['"]?[0-9a-f-]{20,}/i],
  ["vercel-token", /\bVERCEL_TOKEN\s*=\s*['"]?[A-Za-z0-9]{20,}/],
  ["supabase-service-role", /\bSUPABASE_SERVICE_ROLE(_KEY)?\s*=\s*['"]?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./],
  ["neon-api-key", /\bNEON_API_KEY\s*=\s*['"]?[A-Za-z0-9_-]{20,}/],
  ["generic-secret-var", /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*['"]?(?!agm_ph_|\$\{|changeme|example|xxx|your-|<)[^\s'"#]{12,}/],
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", ".venv", "venv", "__pycache__", ".agamemnon", "target"]);
const INTERESTING = /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.pgpass|\.netrc|\.mcp\.json|mcp\.json|docker-compose[\w.-]*\.ya?ml|[\w.-]+\.(ya?ml|json|toml|ini|cfg|conf|sh|ts|js|py|tf|tfvars|properties))$/;

function mask(s: string): string {
  return s.replace(/(:\/\/[^:@\s]+:)([^@\s]{2})[^@\s]*(@)/, "$1$2••••$3").replace(/([A-Za-z0-9_-]{4})[A-Za-z0-9_\-/+=]{8,}/g, "$1••••");
}

export function sweep(root: string, opts: { maxFiles?: number } = {}): SweepHit[] {
  const hits: SweepHit[] = [];
  let files = 0;
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(root, p);
      if (!INTERESTING.test(rel) || st.size > 1_000_000) continue;
      if (++files > (opts.maxFiles ?? 20000)) return;
      let text = "";
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      text.split("\n").forEach((line, i) => {
        for (const [kind, re] of PATTERNS) {
          const m = re.exec(line);
          if (!m) continue;
          if (kind === "generic-secret-var" && hits.some((h) => h.file === rel && h.line === i + 1)) continue;
          const variable = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*[=:]/.exec(line)?.[1];
          hits.push({ file: rel, line: i + 1, kind, preview: mask(line.trim()).slice(0, 120), variable });
          break;
        }
      });
    }
  };
  walk(root);
  return hits;
}
