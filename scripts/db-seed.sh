#!/usr/bin/env bash
# Build the demo world from a clean slate: schema → seed → agent history →
# the breaking migration. Then grant Agamemnon's service role access to the
# freshly created tables. Fast: 412k rows via generate_series.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
DB_DIR="$ROOT_DIR/packages/meridian/db"

echo "Seeding Meridian (schema, 412k loads, agent history, migration)…"
psql_app -q -f "$DB_DIR/schema.sql"
psql_app -q -f "$DB_DIR/seed.sql"
psql_app -q -f "$DB_DIR/agent_runs.sql"
psql_app -q -f "$DB_DIR/migration.sql"

# agamemnon_svc must be able to snapshot (SELECT) and execute (DELETE/INSERT)
# on tables that meridian_app just created.
psql_admin -d "$MERIDIAN_DB" -v au="$AGAMEMNON_DB_USER" <<'SQL'
GRANT ALL ON ALL TABLES    IN SCHEMA public TO :"au";
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO :"au";
SQL

active=$(psql_app -tAc "SELECT count(*) FROM loads WHERE status='active'")
orphans=$(psql_app -tAc "SELECT count(*) FROM loads l LEFT JOIN bookings b ON b.load_ref=l.ref WHERE b.id IS NULL")
echo "Seed complete: ${active} active loads, ${orphans} genuine orphans."
