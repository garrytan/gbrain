#!/usr/bin/env bash
# scripts/bench/stall-repro-vm-setup.sh — bootstrap one Ubicloud VM for
# scripts/bench/managed-sync-stall-repro.ts (#6278 Phase 0). Runs as user
# `ubi` (passwordless sudo) on a stock Ubuntu 24.04 image, inside the synced
# checkout (~/work/gbrain). Installs Docker, git, bun, pulls the harness images,
# installs frozen dependencies, and when RELEASE_COMMIT is set adds a worktree
# of that commit beside the checkout (../gbrain-release) with its own
# dependencies, so the same fixture runs on a release and on this branch.
#
#   scripts/ubicloud/ubi-runner.sh run --setup scripts/bench/stall-repro-vm-setup.sh \
#     --env RELEASE_COMMIT=8e11aa1f -- 'bun scripts/bench/managed-sync-stall-repro.ts --cli-repo ../gbrain-release ...'
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.4.2}"
RELEASE_COMMIT="${RELEASE_COMMIT:-}"
t0=$(date +%s)
step() { echo "[stall-repro-setup +$(( $(date +%s) - t0 ))s] $*"; }

echo force-unsafe-io | sudo tee /etc/dpkg/dpkg.cfg.d/99-gbrain-bench >/dev/null
sudo rm -f /var/lib/man-db/auto-update
apt_get() { sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get -qq -o Acquire::Languages=none "$@" >/dev/null; }

step "apt"
apt_get update
apt_get install -y --no-install-recommends docker.io git ca-certificates python3 procps postgresql-client jq unzip curl
sudo usermod -aG docker "$USER" || true
sudo systemctl start docker

step "bun ${BUN_VERSION}"
if ! command -v bun >/dev/null || [ "$(bun --version)" != "$BUN_VERSION" ]; then
  # The pinned release zip, as scripts/ubicloud/setup-ci-vm.sh installs it: no script piped into a shell.
  arch=x64
  [ "$(uname -m)" = aarch64 ] && arch=aarch64
  tmp=$(mktemp -d)
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 1 -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${arch}.zip"
  python3 -m zipfile -e "$tmp/bun.zip" "$tmp"
  mkdir -p "$HOME/.bun/bin"
  install -m 755 "$tmp/bun-linux-${arch}/bun" "$HOME/.bun/bin/bun"
  ln -sf bun "$HOME/.bun/bin/bunx"
  rm -rf "$tmp"
fi
export PATH="$HOME/.bun/bin:$PATH"
grep -q '.bun/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.bashrc"
grep -q '.bun/bin' "$HOME/.profile" || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
bun --version

step "docker images"
sudo docker pull -q pgvector/pgvector:pg16 >/dev/null &
sudo docker pull -q ghcr.io/shopify/toxiproxy:2.12.0 >/dev/null &
sudo docker pull -q edoburu/pgbouncer@sha256:9c78945868a6a142c7fc40ccd843bbe5a606df163c7ffce4de70e0d628d696a2 >/dev/null &

step "dependencies"
bun install --frozen-lockfile >/dev/null

if [ -n "$RELEASE_COMMIT" ]; then
  step "release worktree ${RELEASE_COMMIT}"
  git cat-file -e "${RELEASE_COMMIT}^{commit}" 2>/dev/null || git fetch -q origin "$RELEASE_COMMIT"
  rm -rf ../gbrain-release
  git worktree add -q --detach ../gbrain-release "$RELEASE_COMMIT"
  (cd ../gbrain-release && bun install --frozen-lockfile >/dev/null && echo "release VERSION $(cat VERSION)")
fi
wait
# The docker socket group takes effect on the next login; the bench shells out to `docker` directly, so make the socket world-usable on this throwaway VM.
sudo chmod 666 /var/run/docker.sock
step "ready: $(nproc) vCPU, $(free -g | awk '/Mem:/ {print $2}') GiB"
