#!/usr/bin/env bash
# scripts/bench/production-soak/vm-setup.sh — bootstrap one Ubicloud VM (or a
# GitHub Actions Ubicloud runner) for the production-shaped scale soak
# (GBRA-174). Runs as a sudo-capable user inside the synced checkout. Installs
# Docker, bun and frozen dependencies, and pre-pulls the four images the
# topology uses (lib.ts): pgvector, PgBouncer (pinned by digest) and toxiproxy.
#
#   scripts/ubicloud/ubi-runner.sh run --setup scripts/bench/production-soak/vm-setup.sh -- 'bash scripts/bench/production-soak/run.sh ...'
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.4.3}"
t0=$(date +%s)
step() { echo "[soak-setup +$(( $(date +%s) - t0 ))s] $*"; }

echo force-unsafe-io | sudo tee /etc/dpkg/dpkg.cfg.d/99-gbrain-soak >/dev/null
sudo rm -f /var/lib/man-db/auto-update
apt_get() { sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get -qq -o Acquire::Languages=none "$@" >/dev/null; }

if ! command -v docker >/dev/null; then
  step "apt"
  apt_get update
  apt_get install -y --no-install-recommends docker.io git ca-certificates python3 procps postgresql-client jq unzip curl
fi
sudo systemctl start docker 2>/dev/null || true
sudo chmod 666 /var/run/docker.sock

step "images"
for image in pgvector/pgvector:pg16 ghcr.io/shopify/toxiproxy:2.12.0 \
  edoburu/pgbouncer@sha256:9c78945868a6a142c7fc40ccd843bbe5a606df163c7ffce4de70e0d628d696a2; do
  docker pull -q "$image" >/dev/null &
done

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
grep -q '.bun/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"

step "dependencies"
bun scripts/ci-bun-install.ts --frozen-lockfile --ignore-scripts >/dev/null
git config --global user.name "Brain Writer"
git config --global user.email writer@example.invalid
wait
step "done: $(nproc) cores, $(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 )) MB RAM, $(df -h --output=avail / | tail -1) free"
