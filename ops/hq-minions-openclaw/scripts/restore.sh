#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/restore.sh backups/gbrain-YYYYMMDDTHHMMSSZ.dump [--db <database>] [--user <user>] [--service <compose-service>]

Flags:
  --db <database>         Restore into this database instead of the default/.env database.
  --user <user>           Restore using this Postgres user instead of the default/.env user.
  --service <service>     docker compose service name to exec into (default: postgres).
USAGE
}

dump=""
target_db=""
target_user=""
compose_service="postgres"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      [[ $# -ge 2 ]] || { echo "Missing value for --db" >&2; usage; exit 2; }
      target_db="$2"
      shift 2
      ;;
    --user)
      [[ $# -ge 2 ]] || { echo "Missing value for --user" >&2; usage; exit 2; }
      target_user="$2"
      shift 2
      ;;
    --service)
      [[ $# -ge 2 ]] || { echo "Missing value for --service" >&2; usage; exit 2; }
      compose_service="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -n "$dump" ]]; then
        echo "Unexpected extra argument: $1" >&2
        usage
        exit 2
      fi
      dump="$1"
      shift
      ;;
  esac
done

if [[ -z "$dump" ]]; then
  usage
  exit 2
fi

if [[ ! -f "$dump" ]]; then
  echo "Dump not found: $dump" >&2
  exit 2
fi

existing_postgres_db="${POSTGRES_DB-}"
existing_postgres_user="${POSTGRES_USER-}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -n "$existing_postgres_db" ]]; then
  POSTGRES_DB="$existing_postgres_db"
fi
if [[ -n "$existing_postgres_user" ]]; then
  POSTGRES_USER="$existing_postgres_user"
fi
if [[ -n "$target_db" ]]; then
  POSTGRES_DB="$target_db"
fi
if [[ -n "$target_user" ]]; then
  POSTGRES_USER="$target_user"
fi

docker compose exec -T "$compose_service" pg_restore \
  -U "${POSTGRES_USER:-gbrain}" \
  -d "${POSTGRES_DB:-gbrain}" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges < "$dump"

echo "Restore complete to database ${POSTGRES_DB:-gbrain} via service ${compose_service}."
