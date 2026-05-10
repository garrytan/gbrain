#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

mkdir -p backups
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="backups/gbrain-${timestamp}.dump"

docker compose exec -T postgres pg_dump   -U "${POSTGRES_USER:-gbrain}"   -d "${POSTGRES_DB:-gbrain}"   -Fc > "$out"

sha256sum "$out" > "$out.sha256"
echo "Backup written: $out"
