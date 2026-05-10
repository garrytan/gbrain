#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo/root." >&2
  exit 2
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required for the host-native worker service. Install Bun on the host before running scripts/install-systemd.sh." >&2
  exit 2
fi

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and set the runtime values before installing the systemd unit." >&2
  exit 2
fi

install_dir="$(pwd)"
user_name="${SUDO_USER:-$(logname 2>/dev/null || echo "$USER")}"

mkdir -p /etc/hq-minions-openclaw
cp .env /etc/hq-minions-openclaw/env
chmod 0600 /etc/hq-minions-openclaw/env

sed "s#__DIR__#${install_dir}#g; s#__USER__#${user_name}#g" \
  systemd/hq-minions-openclaw-worker.service \
  > /etc/systemd/system/hq-minions-openclaw-worker.service

systemctl daemon-reload

echo "Installed hq-minions-openclaw-worker.service"
echo "Enable with:"
echo "  sudo systemctl enable --now hq-minions-openclaw-worker.service"
