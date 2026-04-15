#!/bin/bash
set -euo pipefail

REPO_DIR="${GBRAIN_REPO_DIR:-$HOME/Projects/gbrain}"
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
RUNTIME_DIR="$BUN_INSTALL/install/global/node_modules/gbrain"
BIN_LINK="$BUN_INSTALL/bin/gbrain"
BACKUP_ROOT="${GBRAIN_BACKUP_ROOT:-$HOME/.gbrain/runtime-backups}"
TEST_CMD=(bun test test/extract.test.ts test/utils.test.ts test/search.test.ts test/e2e/search-quality.test.ts)

export BUN_INSTALL
export PATH="$BUN_INSTALL/bin:$HOME/.nvm/versions/node/v24.4.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd git
need_cmd python3
need_cmd bun

[ -d "$REPO_DIR/.git" ] || {
  echo "Repo not found: $REPO_DIR" >&2
  exit 1
}

cd "$REPO_DIR"

if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to update with a dirty repo: $REPO_DIR" >&2
  git status --short >&2 || true
  exit 1
fi

BRANCH="$(git branch --show-current)"
PREV_REV="$(git rev-parse HEAD)"
mkdir -p "$(dirname "$RUNTIME_DIR")" "$(dirname "$BIN_LINK")" "$BACKUP_ROOT"

echo "Repo: $REPO_DIR"
echo "Branch: $BRANCH"
echo "Starting rev: $PREV_REV"

git fetch --all --prune
git pull --ff-only
bun install --frozen-lockfile
chmod +x src/cli.ts

if [ -e "$RUNTIME_DIR" ] && [ ! -L "$RUNTIME_DIR" ]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$BACKUP_ROOT/gbrain-global-pre-relink-$TS"
  mv "$RUNTIME_DIR" "$BACKUP_DIR"
  echo "Backed up existing runtime dir to: $BACKUP_DIR"
fi

if [ -L "$RUNTIME_DIR" ]; then
  CURRENT_TARGET="$(python3 - <<'PY'
import os
p = os.path.join(os.environ['BUN_INSTALL'], 'install/global/node_modules/gbrain')
print(os.path.realpath(os.path.expanduser(p)))
PY
)"
  if [ "$CURRENT_TARGET" != "$REPO_DIR" ]; then
    rm "$RUNTIME_DIR"
    ln -s "$REPO_DIR" "$RUNTIME_DIR"
  fi
else
  ln -s "$REPO_DIR" "$RUNTIME_DIR"
fi

ln -sf "$RUNTIME_DIR/src/cli.ts" "$BIN_LINK"

rollback() {
  echo "Verification failed. Rolling back to $PREV_REV" >&2
  git reset --hard "$PREV_REV" >&2
  bun install --frozen-lockfile >&2
  chmod +x src/cli.ts >&2 || true
}

if ! "${TEST_CMD[@]}"; then
  rollback
  exit 1
fi

if ! "$BIN_LINK" --help >/dev/null; then
  rollback
  exit 1
fi

if ! "$BIN_LINK" stats >/dev/null; then
  rollback
  exit 1
fi

FINAL_REV="$(git rev-parse HEAD)"
REALPATH_NOW="$(python3 - <<'PY'
import os
p = os.path.join(os.environ['BUN_INSTALL'], 'bin/gbrain')
print(os.path.realpath(os.path.expanduser(p)))
PY
)"

echo "Updated rev: $FINAL_REV"
echo "Active runtime: $REALPATH_NOW"
echo "Verification: OK"
