#!/usr/bin/env bash
# scripts/ubicloud/setup-ci-vm.sh — bootstrap one Ubicloud VM for
# scripts/ci-ubicloud.ts. Runs as user `ubi` (passwordless sudo) on a stock
# Ubuntu 24.04 image.
#
# Provides what the ci:local runner container provides, per VM:
#   - bun (pinned; BUN_VERSION, matching docker-compose.ci.yml's runner tag)
#   - git, python3, procps, psql, jq, node, cc, timeout (test prerequisites)
#   - SLOTS isolated pgvector/pgvector:pg16 servers, each fronted by a
#     transaction-mode PgBouncer, so every E2E slot owns its whole server just
#     as each ci:local shard owns postgres-N (slot i: postgres on
#     127.0.0.1:$((15432+i)), pgbouncer on 127.0.0.1:$((16432+i))), each
#     schema bootstrapped the way e2e.yml's full-corpus workers do it
#   - frozen dependencies and both PGLite snapshot fixtures, built once
#   - gitleaks (GITLEAKS=1; pinned + checksum-verified like test.yml)
#
# Every step starts as soon as its inputs exist: apt, the Bun and gitleaks
# downloads and the image pulls need no checkout, so scripts/ci-ubicloud.ts
# streams this script over SSH (`bash -s`) while the checkout is still
# uploading, with CHECKOUT_MARKER naming the file it writes once the checkout
# is unpacked. Run from inside a checkout with no marker, it starts at once.
#
# On a VM booted from the gbrain-ci machine image (scripts/ubicloud/build-ci-image.sh)
# the packages are already installed, so apt is skipped and the image pulls
# only confirm the baked images are current.
#
# Knobs: SLOTS (default nproc), BUN_VERSION (default 1.4.3), GITLEAKS=0|1,
# CHECKOUT (default .), CHECKOUT_MARKER (default: none, checkout present),
# PREPARE_IMAGE=1 (install packages and pull images only, then reset
# cloud-init so the stopped VM can be captured as a machine image).
set -euo pipefail

SLOTS="${SLOTS:-$(nproc)}"
BUN_VERSION="${BUN_VERSION:-1.4.3}"
GITLEAKS="${GITLEAKS:-0}"
CHECKOUT="${CHECKOUT:-.}"
CHECKOUT_MARKER="${CHECKOUT_MARKER:-}"
GITLEAKS_VERSION=8.30.1
APT_PACKAGES=(git ca-certificates python3 procps postgresql-client jq nodejs gcc libc6-dev)
PG_IMAGE=pgvector/pgvector:pg16
PGBOUNCER_IMAGE=edoburu/pgbouncer:latest
# Throwaway password of the loopback-only test servers (docker-compose.ci.yml uses the same).
PG_PASSWORD=postgres

t0=$(date +%s)
step() { echo "[setup-ci-vm +$(( $(date +%s) - t0 ))s] $*"; }
fail() { echo "[setup-ci-vm] $*" >&2; exit 1; }

# scripts/ci-ubicloud.ts multiplexes every slot's commands over one SSH
# connection; sshd's default MaxSessions (10) would refuse slots 11+.
echo "MaxSessions 256" | sudo tee /etc/ssh/sshd_config.d/99-gbrain-ci.conf >/dev/null
sudo systemctl reload ssh

# apt on a throwaway VM: no fsync per package, no man-db rebuild, no
# needrestart scan, and no translation, AppStream or command-not-found indexes.
echo force-unsafe-io | sudo tee /etc/dpkg/dpkg.cfg.d/99-gbrain-ci >/dev/null
sudo rm -f /var/lib/man-db/auto-update
apt_get() {
  sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get -qq \
    -o Acquire::Languages=none -o APT::Update::Post-Invoke-Success= \
    -o Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false \
    -o Acquire::IndexTargets::deb::DEP-11-icons::DefaultEnabled=false \
    -o Acquire::IndexTargets::deb::DEP-11-icons-small::DefaultEnabled=false \
    -o Acquire::IndexTargets::deb::CNF::DefaultEnabled=false "$@" >/dev/null
}

# Docker first so the image pulls overlap the rest of apt. Containers start
# only once apt is done: a package's systemd reload while Docker creates a
# container's scope unit fails the `docker run` ("Message recipient
# disconnected from message bus").
install_system() {
  local pg_pull pgb_pull bin baked=1
  for bin in docker psql node cc jq git; do command -v "$bin" >/dev/null || baked=0; done
  if [ "$baked" = 1 ]; then
    sudo docker pull -q "$PG_IMAGE" >/dev/null
    sudo docker pull -q "$PGBOUNCER_IMAGE" >/dev/null
    return
  fi
  apt_get update
  apt_get install -y --no-install-recommends docker.io
  sudo docker pull -q "$PG_IMAGE" >/dev/null &
  pg_pull=$!
  sudo docker pull -q "$PGBOUNCER_IMAGE" >/dev/null &
  pgb_pull=$!
  apt_get install -y --no-install-recommends "${APT_PACKAGES[@]}"
  wait "$pg_pull"
  wait "$pgb_pull"
}

if [ "${PREPARE_IMAGE:-0}" = "1" ]; then
  install_system
  sudo apt-get clean
  sudo cloud-init clean --logs
  step "image prepared"
  exit 0
fi

(
  install_system
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
) >/tmp/gbrain-system.log 2>&1 &
system_pid=$!

# bun ships as a zip; python3's zipfile avoids waiting on apt for unzip.
(
  arch=x64
  [ "$(uname -m)" = aarch64 ] && arch=aarch64
  tmp=$(mktemp -d)
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 1 -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${arch}.zip"
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
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 1 -o "$tmp/$base" "$url/$base"
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 1 -o "$tmp/checksums.txt" "$url/gitleaks_${GITLEAKS_VERSION}_checksums.txt"
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

if [ -n "$CHECKOUT_MARKER" ]; then
  for _ in $(seq 1 1200); do [ -e "$CHECKOUT_MARKER" ] && break; sleep 0.25; done
  [ -e "$CHECKOUT_MARKER" ] || fail "checkout never arrived ($CHECKOUT_MARKER)"
  step "checkout unpacked"
fi
cd "$CHECKOUT"
bun install --frozen-lockfile >/tmp/gbrain-bun-install.log 2>&1 || { tail -40 /tmp/gbrain-bun-install.log; exit 1; }
step "dependencies installed"

# Snapshot builds overlap the system packages and image pulls. Both are idempotent and hash-keyed.
bun run build:pglite-snapshot >/tmp/gbrain-snapshot.log 2>&1 || { tail -40 /tmp/gbrain-snapshot.log; exit 1; }
bun run build:pglite-snapshot --profile default >>/tmp/gbrain-snapshot.log 2>&1 || { tail -40 /tmp/gbrain-snapshot.log; exit 1; }
step "PGLite snapshots built"

wait "$system_pid" || { tail -40 /tmp/gbrain-system.log >&2; fail "system packages or database containers failed"; }
step "apt packages installed, database containers started"
git config --global --add safe.directory '*'
for i in $(seq 1 "$SLOTS"); do
  for _ in $(seq 1 120); do
    PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$((15432 + i))" -U postgres -d gbrain_test -Atc 'select 1' >/dev/null 2>&1 && break
    sleep 0.5
  done
  PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$((15432 + i))" -U postgres -d gbrain_test -Atc 'select 1' >/dev/null \
    || { echo "[setup-ci-vm] postgres slot $i never became ready" >&2; sudo docker logs "pg-$i" | tail -20 >&2; exit 1; }
done
step "$SLOTS postgres + pgbouncer slots ready"

# The pg-arms lane's database: empty like the unit-postgres-arms job's service
# database, and apart from the E2E schema bootstrapped below.
for i in $(seq 1 "$SLOTS"); do
  PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$((15432 + i))" -U postgres -d gbrain_test -qc 'CREATE DATABASE gbrain_arms_test' \
    || { echo "[setup-ci-vm] could not create gbrain_arms_test on slot $i" >&2; exit 1; }
done

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
