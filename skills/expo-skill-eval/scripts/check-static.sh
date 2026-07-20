#!/usr/bin/env bash
# Static gate for a generated Expo app: typecheck, lint, bundle.
#
# Usage: check-static.sh <project-path> [platforms-csv]
#   platforms-csv  Platforms to bundle-check with `expo export`,
#                  e.g. "ios,android" (default) or "ios,android,web".
#
# Prints [PASS]/[FAIL] per gate and exits non-zero if any gate fails.
# A passing export catches most import/syntax/missing-module errors
# without needing a device.
set -uo pipefail

PROJECT_PATH="${1:?usage: check-static.sh <project-path> [platforms-csv]}"
PLATFORMS="${2:-ios,android}"

cd "$PROJECT_PATH"
FAILED=0
LOG_DIR=".eval-static"
mkdir -p "$LOG_DIR"

run_gate() {
  local name="$1"
  shift
  if "$@" >"$LOG_DIR/$name.log" 2>&1; then
    echo "[PASS] $name"
  else
    echo "[FAIL] $name (log: $PROJECT_PATH/$LOG_DIR/$name.log)"
    tail -20 "$LOG_DIR/$name.log" | sed 's/^/        /'
    FAILED=1
  fi
}

run_gate tsc bunx tsc --noEmit

# Lint only files changed since the fixture commit - the pristine template has
# pre-existing lint errors that aren't the executor's fault. Falls back to a
# full `expo lint` when the project isn't a git repo.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CHANGED_FILES=()
  while IFS= read -r f; do
    [[ -f "$f" ]] && CHANGED_FILES+=("$f")
  done < <(
    {
      git diff --name-only HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx'
      git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.js' '*.jsx'
    } | sort -u
  )
  if ((${#CHANGED_FILES[@]})); then
    run_gate lint env CI=1 bunx eslint "${CHANGED_FILES[@]}"
  else
    echo "[SKIP] lint (no changed JS/TS files)"
  fi
else
  run_gate lint env CI=1 bunx expo lint
fi

EXPORT_ARGS=(export --output-dir "$LOG_DIR/export")
IFS=',' read -ra PLATFORM_LIST <<<"$PLATFORMS"
for p in "${PLATFORM_LIST[@]}"; do
  EXPORT_ARGS+=(--platform "$p")
done
run_gate export env CI=1 bunx expo "${EXPORT_ARGS[@]}"

exit "$FAILED"
