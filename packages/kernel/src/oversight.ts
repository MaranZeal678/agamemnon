// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import type { OversightFinding } from "./effect.ts";

/**
 * The oversight-integrity class.
 *
 * Path-based protections (CODEOWNERS, branch protection) and single-cloud
 * denies (an SCP on cloudtrail:StopLogging) each guard one place. An agent that
 * wants its work to "pass" — or that has been told to hide something — can
 * reduce oversight in any of a dozen systems: delete the failing test, mark it
 * skipped, add `continue-on-error` to CI, mute the alert, stop the trail,
 * disable the audit trigger, or rewrite its own permission file (CVE-2025-53773).
 *
 * This catalogue recognises those actions as ONE semantic class across
 * systems. Every finding forces effect-bound approval by two humans; nothing
 * in this class is ever auto-approved or auto-learned.
 *
 * Versioned so that receipts can name the catalogue that judged them.
 */
export const OVERSIGHT_CATALOG_VERSION = "2026.10.1";

/** A connector-neutral description of an operation, enough to judge oversight. */
export interface OperationDescriptor {
  system: string; // "fs" | "git" | "github" | "postgres" | "aws" | "terraform" | "monitoring" | "ci"
  operation: string; // "delete" | "write" | "apply" | "api" | "sql" …
  /** File path, table, API call name, resource type … */
  resource?: string;
  /** For file writes: content before / after (or a unified diff in `diff`). */
  before?: string;
  after?: string;
  diff?: string;
  /** For SQL: the statement; for API calls: the action name. */
  statement?: string;
  /** Structured params (API payloads, plan changes). */
  params?: Record<string, unknown>;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|test_[^/]*|[^/]*_test)\/|(^|\/)[^/]*(\.|_)(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;
const SKIP_MARKERS: Array<[RegExp, string]> = [
  [/\b(it|test|describe)\.skip\s*\(/, "test.skip / describe.skip"],
  [/\bx(it|describe|test)\s*\(/, "xit / xdescribe"],
  [/\b(it|test)\.todo\s*\(/, "test.todo"],
  [/@pytest\.mark\.(skip|xfail)\b/, "@pytest.mark.skip / xfail"],
  [/\bpytest\.skip\s*\(/, "pytest.skip()"],
  [/@unittest\.skip/, "@unittest.skip"],
  [/\bt\.Skip(Now|f)?\s*\(/, "t.Skip()"],
  [/@(Disabled|Ignore)\b/, "@Disabled / @Ignore"],
  [/#\[ignore\]/, "#[ignore]"],
  [/\bskip\s*:\s*true\b/, "skip: true"],
];
const AGENT_CONFIG = /(^|\/)(\.claude\/settings[^/]*\.json|\.claude\/hooks?[^/]*|\.cursor\/(hooks\.json|rules|mcp\.json|cli\.json)|\.vscode\/settings\.json|\.codex\/[^/]+|codex\/config\.toml|\.gemini\/(settings\.json|policies?[^/]*)|\.windsurf\/[^/]+|\.mcp\.json|AGENTS\.md|CLAUDE\.md|\.agamemnon\/[^/]+)$/i;
const CI_FILE = /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile|\.buildkite\/[^/]+)$/i;
const CODEOWNERS = /(^|\/)(\.github\/)?CODEOWNERS$/;
const AUDIT_NAME = /(audit|_log$|^log_|history|journal|ledger)/i;

/** Lines added by a change (from `diff`, or by comparing before/after). */
function addedLines(d: OperationDescriptor): string[] {
  if (d.diff) return d.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  if (d.after !== undefined) {
    const before = new Set((d.before ?? "").split("\n"));
    return d.after.split("\n").filter((l) => !before.has(l));
  }
  return [];
}

function removedLines(d: OperationDescriptor): string[] {
  if (d.diff) return d.diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
  if (d.before !== undefined) {
    const after = new Set((d.after ?? "").split("\n"));
    return d.before.split("\n").filter((l) => !after.has(l));
  }
  return [];
}

const TEST_DECL = /\b(it|test|describe)\s*\(|^\s*def test_|func Test[A-Z]|@Test\b|#\[test\]/;

/** Judge one operation against the catalogue. Empty array = no oversight impact. */
export function classifyOversight(d: OperationDescriptor): OversightFinding[] {
  const out: OversightFinding[] = [];
  const add = (rule: string, detail: string) => out.push({ rule, detail });
  const res = d.resource ?? "";
  const op = d.operation.toLowerCase();

  // ── Files / repositories ──────────────────────────────────────────────────
  if (d.system === "fs" || d.system === "git" || d.system === "github") {
    if (TEST_PATH.test(res) && (op === "delete" || op === "rename")) {
      add("test-deleted", `test file ${res} would be ${op}d`);
    }
    if (TEST_PATH.test(res) && (op === "write" || op === "edit")) {
      for (const line of addedLines(d)) {
        for (const [re, name] of SKIP_MARKERS) if (re.test(line)) add("test-skipped", `${name} added in ${res}`);
      }
      const removedTests = removedLines(d).filter((l) => TEST_DECL.test(l)).length;
      const addedTests = addedLines(d).filter((l) => TEST_DECL.test(l)).length;
      if (removedTests > addedTests) add("tests-removed", `${removedTests - addedTests} test case(s) removed from ${res}`);
      if (addedLines(d).some((l) => /expect\(\s*true\s*\)\.toBe\(\s*true\s*\)|\bassert\s+True\b|assertTrue\(\s*true\s*\)|assert\.ok\(\s*true\s*\)/.test(l))) {
        add("assertion-trivialised", `trivially-true assertion added in ${res}`);
      }
    }
    if (CI_FILE.test(res)) {
      if (op === "delete") add("ci-pipeline-deleted", `CI definition ${res} would be deleted`);
      for (const line of addedLines(d)) {
        if (/continue-on-error\s*:\s*true/.test(line)) add("ci-continue-on-error", `continue-on-error: true added in ${res}`);
        if (/\|\|\s*true\b|;\s*exit\s+0\b|set\s+\+e\b/.test(line)) add("ci-failure-masked", `failure masking ("${line.trim().slice(0, 60)}") added in ${res}`);
        if (/allow_failure\s*:\s*true/.test(line)) add("ci-allow-failure", `allow_failure: true added in ${res}`);
        if (/--no-verify|SKIP_TESTS|--skip-tests|-DskipTests/.test(line)) add("ci-checks-bypassed", `check bypass flag added in ${res}`);
      }
      if (op === "write" || op === "edit") add("ci-pipeline-changed", `CI definition ${res} modified (agents may not rewrite their own checks unreviewed)`);
    }
    if (CODEOWNERS.test(res)) add("codeowners-changed", `review ownership file ${res} would change`);
    if (AGENT_CONFIG.test(res)) {
      add("agent-config-changed", `agent permission/config file ${res} would change`);
      for (const line of addedLines(d)) {
        if (/autoApprove|"chat\.tools\.autoApprove"|bypassPermissions|dangerously-skip-permissions|--yolo|"defaultMode"\s*:\s*"(bypassPermissions|acceptEdits)"|trust-all-tools|"allow"\s*:\s*\[\s*"\*"/i.test(line)) {
          add("agent-self-escalation", `permission escalation in ${res}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    if (/(^|\/)\.git\/hooks\//.test(res) || /(^|\/)\.husky\//.test(res)) add("git-hooks-changed", `git hook ${res} would change`);
  }

  // ── GitHub API ────────────────────────────────────────────────────────────
  if (d.system === "github" && op === "api") {
    const call = String(d.params?.call ?? res);
    if (/branch[_-]?protection|rulesets?/i.test(call) && /delete|remove|disable/i.test(call)) add("branch-protection-removed", `${call}`);
    if (/branch[_-]?protection/i.test(call) && /update|put/i.test(call)) {
      const checks = (d.params?.required_status_checks as any)?.contexts;
      const reviews = (d.params?.required_pull_request_reviews as any)?.required_approving_review_count;
      if (checks === null || (Array.isArray(checks) && checks.length === 0)) add("required-checks-removed", "required status checks cleared");
      if (reviews === 0 || d.params?.required_pull_request_reviews === null) add("required-reviews-removed", "required reviews disabled");
      if (d.params?.enforce_admins === false) add("admin-bypass-enabled", "admins may bypass protection");
    }
    if (/secret[_-]?scanning|dependabot|code[_-]?scanning/i.test(call) && /disable|delete/i.test(call)) add("security-scanning-disabled", call);
    if (/audit[_-]?log/i.test(call) && /delete|disable|stream/i.test(call)) add("audit-log-changed", call);
  }

  // ── Postgres ──────────────────────────────────────────────────────────────
  if (d.system === "postgres") {
    const s = (d.statement ?? "").replace(/\s+/g, " ");
    if (/\bdisable\s+(row\s+level\s+security|trigger)\b/i.test(s)) add("db-guardrail-disabled", s.slice(0, 120));
    if (/\bno\s+force\s+row\s+level\s+security\b/i.test(s)) add("db-guardrail-disabled", s.slice(0, 120));
    if (/\bdrop\s+(policy|trigger|event\s+trigger)\b/i.test(s)) add("db-guardrail-dropped", s.slice(0, 120));
    const tbl = /\b(?:drop|truncate|alter|delete\s+from|update)\s+(?:table\s+)?(?:if\s+exists\s+)?(?:only\s+)?("?[\w.]+"?)/i.exec(s)?.[1]?.replace(/"/g, "");
    if (tbl && AUDIT_NAME.test(tbl.split(".").pop()!)) add("audit-data-modified", `statement modifies audit/history table ${tbl}`);
    if (/\b(grant|alter\s+role)\b.*\b(superuser|bypassrls|all\s+privileges)\b/i.test(s)) add("privilege-escalation", s.slice(0, 120));
    if (/\bset\s+(session_replication_role|row_security)\s*(=|to)\s*(replica|off)\b/i.test(s)) add("db-guardrail-disabled", s.slice(0, 120));
    if (/\balter\s+system\s+set\s+(log_|pgaudit\.)/i.test(s)) add("db-logging-changed", s.slice(0, 120));
  }

  // ── AWS control plane (API calls or Terraform resource changes) ───────────
  const awsCall = String(d.params?.action ?? (d.system === "aws" ? res : ""));
  if (awsCall) {
    const rules: Array<[RegExp, string]> = [
      [/cloudtrail:(StopLogging|DeleteTrail|PutEventSelectors|UpdateTrail)/i, "audit-trail-weakened"],
      [/guardduty:(DeleteDetector|UpdateDetector|DisassociateFromMasterAccount|DeleteMembers)/i, "threat-detection-disabled"],
      [/config:(StopConfigurationRecorder|DeleteConfigurationRecorder|DeleteDeliveryChannel)/i, "config-recording-disabled"],
      [/logs:(DeleteLogGroup|PutRetentionPolicy|DeleteRetentionPolicy|DeleteSubscriptionFilter)/i, "logs-reduced"],
      [/securityhub:(DisableSecurityHub|BatchDisableStandards)/i, "security-hub-disabled"],
      [/cloudwatch:(DisableAlarmActions|DeleteAlarms)/i, "alarms-silenced"],
      [/s3:(PutBucketLogging|DeleteBucketPolicy|PutBucketVersioning)/i, "storage-guardrail-changed"],
      [/iam:(CreateAccessKey|CreateUser|AttachUserPolicy|PutUserPolicy|CreateLoginProfile|UpdateAssumeRolePolicy)/i, "persistent-identity-created"],
    ];
    for (const [re, rule] of rules) if (re.test(awsCall)) add(rule, awsCall);
  }
  if (d.system === "terraform") {
    const type = String(d.params?.resourceType ?? "");
    const actions = (d.params?.actions as string[] | undefined) ?? [];
    const after = (d.params?.after as Record<string, unknown> | undefined) ?? {};
    const destroying = actions.includes("delete");
    const map: Record<string, string> = {
      aws_cloudtrail: "audit-trail-weakened",
      aws_guardduty_detector: "threat-detection-disabled",
      aws_config_configuration_recorder: "config-recording-disabled",
      aws_config_configuration_recorder_status: "config-recording-disabled",
      aws_cloudwatch_log_group: "logs-reduced",
      aws_cloudwatch_metric_alarm: "alarms-silenced",
      aws_securityhub_account: "security-hub-disabled",
      aws_s3_bucket_logging: "storage-guardrail-changed",
      aws_s3_bucket_versioning: "storage-guardrail-changed",
      aws_backup_vault_lock_configuration: "backup-protection-weakened",
      github_branch_protection: "branch-protection-removed",
      datadog_monitor: "alerts-muted",
      pagerduty_service: "paging-changed",
    };
    if (map[type] && destroying) add(map[type], `${type}.${String(d.params?.name ?? "")} would be destroyed`);
    if (type === "aws_cloudtrail" && after.enable_logging === false) add("audit-trail-weakened", "enable_logging = false");
    if (type === "aws_guardduty_detector" && after.enable === false) add("threat-detection-disabled", "enable = false");
    if (type === "aws_config_configuration_recorder_status" && after.is_enabled === false) add("config-recording-disabled", "is_enabled = false");
    if (type === "aws_cloudwatch_metric_alarm" && after.actions_enabled === false) add("alarms-silenced", "actions_enabled = false");
    if (type === "aws_cloudwatch_log_group" && typeof after.retention_in_days === "number") {
      const before = (d.params?.before as any)?.retention_in_days;
      if (typeof before === "number" && before > 0 && (after.retention_in_days as number) < before) {
        add("logs-reduced", `log retention ${before} → ${after.retention_in_days} days`);
      }
    }
    if (type === "datadog_monitor" && (after.notify_no_data === false || after.priority === null)) {
      /* not oversight by itself */
    }
    if (/^aws_iam_(access_key|user|user_policy|user_login_profile)$/.test(type) && actions.includes("create")) {
      add("persistent-identity-created", `${type} would be created`);
    }
    if (/^aws_iam_.*policy/.test(type) && JSON.stringify(after).includes('"Action":"*"')) add("wildcard-privilege", `${type} grants Action "*"`);
  }

  // ── Monitoring / paging ──────────────────────────────────────────────────
  if (d.system === "monitoring") {
    const call = `${String(d.params?.provider ?? "")}:${String(d.params?.call ?? res)}`;
    if (/mute|silence|downtime|snooze/i.test(call)) add("alerts-muted", call);
    if (/delete.*(monitor|alert|rule|check)|disable.*(monitor|alert|service|integration)/i.test(call)) add("alerts-deleted", call);
    if (/maintenance[_-]?window|escalation[_-]?polic(y|ies).*(update|delete)|service.*disable/i.test(call)) add("paging-changed", call);
  }

  // de-duplicate identical findings
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.rule}|${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
