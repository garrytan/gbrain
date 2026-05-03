#!/bin/bash
# CI guard against silent singleton reuse in connected-gbrains code paths.
#
# Codex finding #7 (plan review 2026-04-22): the module singleton in
# src/core/db.ts is shared across the process. With multi-brain routing,
# any `db.getConnection()` call in an op-dispatch code path means that op
# silently targets whichever brain connected to the singleton first,
# regardless of ctx.brainId / ctx.engine. This is exactly the bug Codex
# #1 flagged in postgres-engine.ts internals.
#
# This script fails the build when NEW `db.getConnection()` calls appear
# in src/core/operations.ts (the per-op handler surface) or in any new
# `src/commands/*.ts` file. Existing legitimate callers are grandfathered
# via an explicit allowlist — cleanups land in PR 1.
#
# When you hit this guard: instead of `db.getConnection()` or `db.connect(...)`,
# use `ctx.engine` from the passed-in OperationContext. See
# src/core/brain-registry.ts for how ctx.engine gets populated per-call.
#
# Run manually:  bash scripts/check-no-legacy-getconnection.sh
# Wired into CI: `bun test` (via package.json scripts.test)

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT"

# Files that are allowed to touch the singleton today. Every other file
# under src/core or src/commands is forbidden. This list shrinks in PR 1.
ALLOWED=(
  "src/core/db.ts"                      # the singleton's definition
  "src/core/postgres-engine.ts"         # calls db.connect + fallback in sql getter — PR 1 removes the fallback
  "src/commands/init.ts"                # first-time setup path, no engine yet
  "src/commands/doctor.ts"              # PR 1 refactors to accept engine
  "src/commands/files.ts"               # PR 1 refactors to accept engine
  "src/commands/repair-jsonb.ts"        # PR 1 refactors
  "src/commands/serve-http.ts"          # PR 1 threads engine through the OAuth dispatch path
  "src/core/operations.ts"              # 3 localOnly ops (file_list/upload/url) move to ctx.engine in PR 1
  "src/commands/integrity.ts"           # scanIntegrityBatch path; PR 1 refactors to accept engine
)

# Build an argument list for `grep` that excludes allowed files.
EXCLUDE_ARGS=()
for file in "${ALLOWED[@]}"; do
  EXCLUDE_ARGS+=(--exclude="$file")
done

# Search src/core/ and src/commands/ for db.getConnection or db.connect calls.
# We look for the `db.` prefix so references to the symbol elsewhere (e.g.
# the grep guard itself) don't trip the check.
VIOLATIONS=$(
  grep -rn "db\.\(getConnection\|connect\)(" \
    --include="*.ts" \
    "${EXCLUDE_ARGS[@]}" \
    src/core src/commands 2>/dev/null \
    | grep -v -F "src/core/db.ts" \
    | grep -v "^[^:]*:[0-9]*:[[:space:]]*\(//\|\*\)" \
    || true
)

if [ -n "$VIOLATIONS" ]; then
  # Filter out allowed files from the result (the --exclude only matches basename)
  FILTERED=$(printf '%s\n' "$VIOLATIONS" | while IFS= read -r line; do
    path="${line%%:*}"
    allow=0
    for ok in "${ALLOWED[@]}"; do
      if [ "$path" = "$ok" ]; then allow=1; break; fi
    done
    if [ "$allow" -eq 0 ]; then printf '%s\n' "$line"; fi
  done)

  if [ -n "$FILTERED" ]; then
    echo "ERROR: new direct db.getConnection() / db.connect() call found in multi-brain code path:" >&2
    echo "" >&2
    printf '%s\n' "$FILTERED" >&2
    echo "" >&2
    echo "Use ctx.engine from the passed-in OperationContext instead." >&2
    echo "See src/core/brain-registry.ts for the routing model." >&2
    echo "If this call is legitimate, add its path to the ALLOWED list in" >&2
    echo "scripts/check-no-legacy-getconnection.sh with a PR 1 cleanup note." >&2
    exit 1
  fi
fi

echo "check-no-legacy-getconnection: ok (no new singleton callers)"
