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

/**
 * `agamemnon harden-db` — database-native backstops that hold even if the
 * broker is bypassed (someone uses the app's own credential directly):
 *
 *  - a statement-level row cap on DELETE / UPDATE (transition tables count the
 *    rows the statement actually changed; above the cap the statement fails).
 *    Statements from the broker's own session are exempt — the broker already
 *    measured and bound them. A trigger cannot see a statement's WHERE clause,
 *    so this is a row cap, not a "WHERE required" check: it catches the
 *    missing-WHERE mass delete by its size.
 *  - TRUNCATE revoked from the application role (it bypasses row triggers);
 *  - statement / lock / idle-in-transaction timeouts on the application role.
 */

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error(`unsafe identifier "${s}"`);
  return `"${s}"`;
};

export function hardenSql(opts: { tables: string[]; cap: number; appRole?: string; brokerRole: string }): string {
  const lines = [
    "-- Agamemnon harden-db (generated). Review, then apply as the table owner.",
    "BEGIN;",
    "SET LOCAL lock_timeout = '5s';",
    `CREATE OR REPLACE FUNCTION agamemnon_row_cap() RETURNS trigger LANGUAGE plpgsql AS $agm$
DECLARE
  n bigint;
  cap bigint := TG_ARGV[0]::bigint;
BEGIN
  IF session_user = ${`'${opts.brokerRole.replace(/'/g, "''")}'`} THEN
    RETURN NULL; -- the Agamemnon broker measured and bound this statement already
  END IF;
  IF TG_OP = 'DELETE' THEN SELECT count(*) INTO n FROM agm_old; ELSE SELECT count(*) INTO n FROM agm_new; END IF;
  IF n > cap THEN
    RAISE EXCEPTION 'agamemnon: % of % rows in % exceeds the row cap of % — route bulk changes through the Agamemnon broker', TG_OP, n, TG_TABLE_NAME, cap
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END
$agm$;`,
  ];
  for (const t of opts.tables) {
    lines.push(
      `DROP TRIGGER IF EXISTS agamemnon_row_cap_delete ON ${ident(t)};`,
      `CREATE TRIGGER agamemnon_row_cap_delete AFTER DELETE ON ${ident(t)} REFERENCING OLD TABLE AS agm_old FOR EACH STATEMENT EXECUTE FUNCTION agamemnon_row_cap(${Math.trunc(opts.cap)});`,
      `DROP TRIGGER IF EXISTS agamemnon_row_cap_update ON ${ident(t)};`,
      `CREATE TRIGGER agamemnon_row_cap_update AFTER UPDATE ON ${ident(t)} REFERENCING NEW TABLE AS agm_new FOR EACH STATEMENT EXECUTE FUNCTION agamemnon_row_cap(${Math.trunc(opts.cap)});`,
    );
  }
  if (opts.appRole) {
    const r = ident(opts.appRole);
    lines.push(
      `REVOKE TRUNCATE ON ${opts.tables.map(ident).join(", ")} FROM ${r};`,
      `ALTER ROLE ${r} SET statement_timeout = '30s';`,
      `ALTER ROLE ${r} SET lock_timeout = '5s';`,
      `ALTER ROLE ${r} SET idle_in_transaction_session_timeout = '60s';`,
    );
  }
  lines.push("COMMIT;");
  return lines.join("\n");
}
