#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
revision=44f96edf7f49dc6ea501727bd8ae07531641e0d2
output="${1:?Usage: build-shared-skills-baseline.sh /absolute/output}"
case "$output" in /*) ;; *) echo 'Output must be an absolute path.' >&2; exit 2 ;; esac
if ! git cat-file -e "$revision^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$revision"
fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git -C "$root" archive "$revision" | tar -x -C "$scratch"
mkdir -p "$(dirname "$output")"
cd "$scratch"
bun install --frozen-lockfile --ignore-scripts
bun build --compile --no-compile-autoload-bunfig --outfile "$output" src/cli.ts
printf 'Built shared-skills compatibility baseline from %s\n' "$revision"
