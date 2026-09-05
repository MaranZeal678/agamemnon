#!/usr/bin/env bash
# Shared helpers. Loads .env WITHOUT printing any value.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

load_env() {
  if [[ ! -f "$ROOT_DIR/.env" ]]; then
    echo "ERROR: .env not found. Run: cp .env.example .env  (then add your Nebius key)" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
}

# Admin psql: connects as the current OS superuser to the default 'postgres' db.
psql_admin() {
  psql -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -d postgres -v ON_ERROR_STOP=1 "$@"
}

# App psql: connects to the meridian db as the meridian_app role.
psql_app() {
  PGPASSWORD="$MERIDIAN_DB_PASSWORD" psql \
    -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" \
    -U "$MERIDIAN_DB_USER" -d "$MERIDIAN_DB" -v ON_ERROR_STOP=1 "$@"
}
