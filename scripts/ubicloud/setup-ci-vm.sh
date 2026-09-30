#!/usr/bin/env bash
# scripts/ubicloud/setup-ci-vm.sh — bootstrap one Ubicloud VM for
# scripts/ci-ubicloud.ts. Runs as user `ubi` (passwordless sudo) inside the
# synced checkout on a stock Ubuntu 24.04 image.
#
# Provides what the ci:local runner container provides, per VM:
#   - bun (pinned; BUN_VERSION, matching docker-compose.ci.yml's runner tag)
#   - git, python3, procps, psql, jq, node, timeout (test prerequisites)
#   - SLOTS isolated pgvector/pgvector:pg16 servers, each fronted by a
#     transaction-mode PgBouncer, so every E2E slot owns its whole server just
#     as each ci:local shard owns postgres-N (slot i: postgres on
#     127.0.0.1:$((15432+i)), pgbouncer on 127.0.0.1:$((16432+i))), each
#     schema bootstrapped the way e2e.yml's full-corpus workers do it
#   - frozen dependencies and both PGLite snapshot fixtures, built once
#   - gitleaks (GITLEAKS=1; pinned + checksum-verified like test.yml)
#
# Knobs: SLOTS (default nproc), BUN_VERSION (default 1.3.13), GITLEAKS=0|1.
set -euo pipefail

SLOTS="${SLOTS:-$(nproc)}"
BUN_VERSION="${BUN_VERSION:-1.3.13}"
GITLEAKS="${GITLEAKS:-0}"
GITLEAKS_VERSION=8.30.1
PG_IMAGE=pgvector/pgvector:pg16
PGBOUNCER_IMAGE=edoburu/pgbouncer:latest
# Throwaway password of the loopback-only test servers (docker-compose.ci.yml uses the same).
PG_PASSWORD=postgres

t0=$(date +%s)
step() { echo "[setup-ci-vm +$(( $(date +%s) - t0 ))s] $*"; }

# scripts/ci-ubicloud.ts multiplexes every slot's commands over one SSH
# connection; sshd's default MaxSessions (10) would refuse slots 11+.
echo "MaxSessions 256" | sudo tee /etc/ssh/sshd_config.d/99-gbrain-ci.conf >/dev/null
sudo systemctl reload ssh

export DEBIAN_FRONTEND=noninteractive
(
  sudo apt-get update -qq >/dev/null
  sudo apt-get install -y -qq --no-install-recommends \
    docker.io git ca-certificates python3 procps postgresql-client jq nodejs build-essential >/dev/null
) &
apt_pid=$!

# bun ships as a zip; python3's zipfile avoids waiting on apt for unzip.
(
  arch=x64
  [ "$(uname -m)" = aarch64 ] && arch=aarch64
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${arch}.zip"
  python3 -m zipfile -e "$tmp/bun.zip" "$tmp"
  mkdir -p "$HOME/.bun/bin"
  install -m 755 "$tmp/bun-linux-${arch}/bun" "$HOME/.bun/bin/bun"
  ln -sf bun "$HOME/.bun/bin/bunx"
  rm -rf "$tmp"
) &
bun_pid=$!

if [ "$GITLEAKS" = "1" ]; then
  (
    base="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    url="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/$base" "$url/$base"
    curl -fsSL -o "$tmp/checksums.txt" "$url/gitleaks_${GITLEAKS_VERSION}_checksums.txt"
    ( cd "$tmp" && grep " ${base}\$" checksums.txt | sha256sum -c - >/dev/null )
    tar -xzf "$tmp/$base" -C "$tmp" gitleaks
    sudo install "$tmp/gitleaks" /usr/local/bin/gitleaks
    rm -rf "$tmp"
  ) &
  gitleaks_pid=$!
fi

wait "$bun_pid"
export PATH="$HOME/.bun/bin:$PATH"
step "bun $(bun --version)"
bun install --frozen-lockfile >/tmp/gbrain-bun-install.log 2>&1 || { tail -40 /tmp/gbrain-bun-install.log; exit 1; }
step "dependencies installed"

wait "$apt_pid"
step "apt packages installed"
git config --global --add safe.directory '*'

sudo docker pull -q "$PG_IMAGE" >/dev/null &
pg_pull=$!
sudo docker pull -q "$PGBOUNCER_IMAGE" >/dev/null &
pgb_pull=$!

# Snapshot builds overlap the image pulls. Both are idempotent and hash-keyed.
bun run build:pglite-snapshot >/tmp/gbrain-snapshot.log 2>&1 || { tail -40 /tmp/gbrain-snapshot.log; exit 1; }
bun run build:pglite-snapshot --profile default >>/tmp/gbrain-snapshot.log 2>&1 || { tail -40 /tmp/gbrain-snapshot.log; exit 1; }
step "PGLite snapshots built"

wait "$pg_pull" "$pgb_pull"
sudo docker network create gbrain-ci >/dev/null 2>&1 || true
for i in $(seq 1 "$SLOTS"); do
  sudo docker run -d --name "pg-$i" --network gbrain-ci \
    -p "127.0.0.1:$((15432 + i)):5432" \
    -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=gbrain_test \
    "$PG_IMAGE" -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
done
for i in $(seq 1 "$SLOTS"); do
  # Same pooler settings as docker-compose.ci.yml's pgbouncer service.
  sudo docker run -d --name "pgb-$i" --network gbrain-ci \
    -p "127.0.0.1:$((16432 + i)):5432" \
    -e DB_HOST="pg-$i" -e DB_PORT=5432 -e DB_USER=postgres -e DB_PASSWORD="$PG_PASSWORD" \
    -e POOL_MODE=transaction -e AUTH_TYPE=plain -e MAX_CLIENT_CONN=200 -e DEFAULT_POOL_SIZE=10 \
    -e IGNORE_STARTUP_PARAMETERS=extra_float_digits,statement_timeout,idle_in_transaction_session_timeout,search_path \
    "$PGBOUNCER_IMAGE" >/dev/null
done
for i in $(seq 1 "$SLOTS"); do
  for _ in $(seq 1 120); do
    PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$((15432 + i))" -U postgres -d gbrain_test -Atc 'select 1' >/dev/null 2>&1 && break
    sleep 0.5
  done
  PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$((15432 + i))" -U postgres -d gbrain_test -Atc 'select 1' >/dev/null \
    || { echo "[setup-ci-vm] postgres slot $i never became ready" >&2; sudo docker logs "pg-$i" | tail -20 >&2; exit 1; }
done
step "$SLOTS postgres + pgbouncer slots ready"

# Initialize every slot's schema up front, exactly like e2e.yml's "Bootstrap
# isolated E2E schema" step, so no file depends on whichever file happens to
# reach a fresh database first.
bootstrap_pids=()
for i in $(seq 1 "$SLOTS"); do
  (
    bootstrap_home=$(mktemp -d "${TMPDIR:-/tmp}/e2e-bootstrap.XXXXXX")
    trap 'rm -rf "$bootstrap_home"' EXIT
    unset GBRAIN_DATABASE_URL GBRAIN_E2E_ALLOW_DB
    DATABASE_URL="postgresql://postgres:${PG_PASSWORD}@127.0.0.1:$((15432 + i))/gbrain_test" \
    HOME="$bootstrap_home" GBRAIN_HOME="$bootstrap_home" \
    GBRAIN_CI_DISABLE_TEST_ENV_FILE=1 GBRAIN_MODEL_DISCOVERY=off \
    GBRAIN_TEST_KEEP_AMBIENT_ENV=0 GBRAIN_TEST_KEEP_PROVIDER_KEYS=0 \
      bun --no-env-file \
        --preload ./test/helpers/operator-env-preload.ts \
        --preload ./test/helpers/provider-keys-preload.ts \
        -e 'import { setupLegacyEmbeddingDB, teardownDB } from "./test/e2e/helpers.ts"; try { await setupLegacyEmbeddingDB(); } finally { await teardownDB(); }' \
      >"/tmp/gbrain-bootstrap-$i.log" 2>&1
  ) &
  bootstrap_pids+=("$!")
done
for i in $(seq 1 "$SLOTS"); do
  wait "${bootstrap_pids[$((i - 1))]}" || { echo "[setup-ci-vm] schema bootstrap failed for slot $i" >&2; tail -30 "/tmp/gbrain-bootstrap-$i.log" >&2; exit 1; }
done
step "E2E schemas bootstrapped"

if [ "$GITLEAKS" = "1" ]; then
  wait "$gitleaks_pid"
  step "gitleaks $(gitleaks version)"
fi
step "ready"
