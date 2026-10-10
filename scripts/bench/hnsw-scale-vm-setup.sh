#!/usr/bin/env bash
# scripts/bench/hnsw-scale-vm-setup.sh — bootstrap one Ubicloud VM for the
# E5.4 HNSW scale bench (scripts/bench/hnsw-iterative-scan.ts --corpus latent).
# Runs as user `ubi` (passwordless sudo) on a stock Ubuntu 24.04 image, inside
# the synced checkout (~/work/gbrain). Installs Docker, bun and frozen
# dependencies, and starts one pgvector/pgvector:pg16 server on
# 127.0.0.1:5434 sized to the VM: shared_buffers 25% and effective_cache_size
# 75% of RAM, SSD planner costs (random_page_cost 1.1, effective_io_concurrency
# 200), a /dev/shm large enough for parallel HNSW builds, and the data
# directory on the VM disk.
#
#   scripts/ubicloud/ubi-runner.sh ssh "$name" 'cd work/gbrain && bash scripts/bench/hnsw-scale-vm-setup.sh'
#   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5434/postgres bun scripts/bench/hnsw-iterative-scan.ts --corpus latent ...
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.4.2}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
t0=$(date +%s)
step() { echo "[hnsw-scale-setup +$(( $(date +%s) - t0 ))s] $*"; }

echo force-unsafe-io | sudo tee /etc/dpkg/dpkg.cfg.d/99-gbrain-bench >/dev/null
sudo rm -f /var/lib/man-db/auto-update
apt_get() { sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get -qq -o Acquire::Languages=none "$@" >/dev/null; }

step "apt"
apt_get update
apt_get install -y --no-install-recommends docker.io git ca-certificates python3 procps postgresql-client jq unzip curl
sudo systemctl start docker

step "postgres image"
sudo docker pull -q "$PG_IMAGE" >/dev/null &
pull=$!

step "bun ${BUN_VERSION}"
if ! command -v bun >/dev/null || [ "$(bun --version)" != "$BUN_VERSION" ]; then
  arch=x64
  [ "$(uname -m)" = aarch64 ] && arch=aarch64
  tmp=$(mktemp -d)
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 1 -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${arch}.zip"
  python3 -m zipfile -e "$tmp/bun.zip" "$tmp"
  mkdir -p "$HOME/.bun/bin"
  install -m 755 "$tmp/bun-linux-${arch}/bun" "$HOME/.bun/bin/bun"
  rm -rf "$tmp"
fi
export PATH="$HOME/.bun/bin:$PATH"
grep -q '.bun/bin' "$HOME/.profile" || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
bun --version

step "dependencies"
bun install --frozen-lockfile >/dev/null
wait "$pull"

mem_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
shared=$(( mem_mb / 4 ))
cache=$(( mem_mb * 3 / 4 ))
shm=$(( mem_mb / 2 ))
step "postgres: ${mem_mb} MB RAM, shared_buffers ${shared}MB, effective_cache_size ${cache}MB, shm ${shm}MB"
sudo mkdir -p /var/lib/hnsw-bench-pg
sudo docker rm -f hnsw-bench-pg >/dev/null 2>&1 || true
sudo docker run -d --name hnsw-bench-pg --shm-size="${shm}m" -p 127.0.0.1:5434:5432 \
  -e POSTGRES_PASSWORD=postgres -v /var/lib/hnsw-bench-pg:/var/lib/postgresql/data "$PG_IMAGE" \
  -c shared_buffers="${shared}MB" -c effective_cache_size="${cache}MB" \
  -c random_page_cost=1.1 -c effective_io_concurrency=200 \
  -c max_worker_processes=32 -c max_parallel_workers=16 -c max_parallel_maintenance_workers=8 \
  -c max_wal_size=32GB -c checkpoint_timeout=30min -c synchronous_commit=off \
  -c max_connections=200 >/dev/null
for _ in $(seq 1 60); do
  PGPASSWORD=postgres psql -h 127.0.0.1 -p 5434 -U postgres -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
PGPASSWORD=postgres psql -h 127.0.0.1 -p 5434 -U postgres -tAc "select version(), (select default_version from pg_available_extensions where name = 'vector')"
step "ready (nproc $(nproc), disk $(df -h /var/lib/hnsw-bench-pg | awk 'NR==2 {print $4}') free)"
