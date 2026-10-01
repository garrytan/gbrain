#!/usr/bin/env bash
# Bootstrap a fresh Ubicloud Ubuntu VM for the System One eval arms
# (scripts/ubicloud/ubi-runner.sh run --setup <this file>). Installs Bun and
# the checkout's dependencies and creates an empty keyless PGLite brain.
set -euo pipefail
BUN_VERSION="${BUN_VERSION:-1.3.13}"
sudo apt-get update -qq && sudo apt-get install -y -qq unzip python3 > /dev/null
arch=x64
[ "$(uname -m)" = aarch64 ] && arch=aarch64
tmp=$(mktemp -d)
base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
curl -fsSL -o "$tmp/bun-linux-${arch}.zip" "$base/bun-linux-${arch}.zip"
curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
( cd "$tmp" && grep " bun-linux-${arch}.zip\$" SHASUMS256.txt | sha256sum -c - > /dev/null )
python3 -m zipfile -e "$tmp/bun-linux-${arch}.zip" "$tmp"
mkdir -p "$HOME/.bun/bin"
install -m 755 "$tmp/bun-linux-${arch}/bun" "$HOME/.bun/bin/bun"
rm -rf "$tmp"
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$HOME/.profile"
export PATH="$HOME/.bun/bin:$PATH"
bun install > /dev/null
GBRAIN_HOME="$HOME/gbhome" bun src/cli.ts init --pglite --no-embedding > /dev/null
echo "setup ok: bun $(bun --version), $(nproc) vCPU"
