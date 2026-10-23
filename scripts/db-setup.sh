#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Elamaran Elangovan
# Create the meridian database and the two application roles on the local
# Homebrew Postgres. Idempotent. Requires that the current OS user is a
# Postgres superuser (verified: maran is). Never prints passwords.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

: "${MERIDIAN_DB:?}" "${MERIDIAN_DB_USER:?}" "${MERIDIAN_DB_PASSWORD:?}"
: "${AGAMEMNON_DB_USER:?}" "${AGAMEMNON_DB_PASSWORD:?}"

echo "Creating database '$MERIDIAN_DB' and roles (idempotent)…"

# Database (createdb is not transactional; guard with a catalog check).
if ! psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname='$MERIDIAN_DB'" | grep -q 1; then
  psql_admin -c "CREATE DATABASE $MERIDIAN_DB"
fi

# Roles. The SQL (with the password inlined) is fed on stdin, never as a
# process argument, so the secret is not visible in `ps`. Passwords are hex
# from `openssl rand -hex`, so inlining inside single quotes needs no escaping.
upsert_role() {  # $1 = role name, $2 = password
  local user="$1" pw="$2" verb exists
  exists=$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname='$user'")
  [[ "$exists" == "1" ]] && verb="ALTER" || verb="CREATE"
  printf "%s ROLE %s LOGIN PASSWORD '%s';\n" "$verb" "$user" "$pw" | psql_admin -q -f -
}
upsert_role "$MERIDIAN_DB_USER"  "$MERIDIAN_DB_PASSWORD"
upsert_role "$AGAMEMNON_DB_USER" "$AGAMEMNON_DB_PASSWORD"

# Grants. meridian_app is the application's own credential (and the
# UNPROTECTED agent's in Act 1). agamemnon_svc is the one only Agamemnon holds,
# and it is deliberately narrow: schema USAGE only, no default privileges, and
# CREATEROLE so it can mint a per-request role for each execution. Its table
# privileges are granted explicitly — allowlisted tables only — in db-seed.sh.
psql_admin -d "$MERIDIAN_DB" \
  -v mu="$MERIDIAN_DB_USER" -v au="$AGAMEMNON_DB_USER" <<'SQL'
GRANT ALL ON SCHEMA public TO :"mu";
REVOKE ALL ON SCHEMA public FROM :"au";
GRANT USAGE ON SCHEMA public TO :"au";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO :"mu";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO :"mu";
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM :"au";
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM :"au";
ALTER ROLE :"au" CREATEROLE NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS;
SQL

echo "Database and roles ready."
