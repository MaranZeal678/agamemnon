#!/usr/bin/env bash
# Fill any EMPTY password/URL fields in .env with machine-generated values.
# Idempotent: never overwrites a value that is already set. Never prints secrets.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV="$ROOT_DIR/.env"

[[ -f "$ENV" ]] || { echo "ERROR: .env not found. Run: cp .env.example .env" >&2; exit 1; }

set -a; source "$ENV"; set +a

changed=0
ensure_pw() {   # $1 = var name
  local name="$1" val="${!1:-}"
  if [[ -z "$val" ]]; then
    local pw; pw="$(openssl rand -hex 20)"
    perl -pi -e "s|^${name}=\$|${name}=${pw}|" "$ENV"
    changed=1
    export "$name"="$pw"
  fi
}
ensure_url() {  # $1 = url var, $2 = user var, $3 = pw var
  local name="$1" val="${!1:-}"
  if [[ -z "$val" ]]; then
    local user="${!2}" pw="${!3}"
    local url="postgres://${user}:${pw}@${PGHOST:-127.0.0.1}:${PGPORT:-5432}/${MERIDIAN_DB:-meridian}"
    perl -pi -e "s|^${name}=\$|${name}=${url}|" "$ENV"
    changed=1
  fi
}

ensure_pw MERIDIAN_DB_PASSWORD
ensure_pw AGAMEMNON_DB_PASSWORD
ensure_url MERIDIAN_DATABASE_URL  MERIDIAN_DB_USER  MERIDIAN_DB_PASSWORD
ensure_url AGAMEMNON_DATABASE_URL AGAMEMNON_DB_USER AGAMEMNON_DB_PASSWORD

if [[ "$changed" -eq 1 ]]; then
  echo "Generated missing credentials into .env (values not shown)."
else
  echo "All credentials already present in .env (nothing changed)."
fi
