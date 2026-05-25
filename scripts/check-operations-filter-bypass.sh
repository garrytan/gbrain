#!/usr/bin/env bash
# v0.39 — CI guard against bypassing the localOnly filter on the HTTP MCP
# surface. Lives alongside check-jsonb-pattern.sh / check-progress-to-stdout.sh
# in the bun run verify chain.
#
# Background: serve-http.ts builds the HTTP MCP tools/list response from
# `operations.filter(op => !op.localOnly)`. That filter is the only thing
# keeping localOnly ops (sync_brain, file_upload, file_list, file_url —
# any admin op the user EXPLICITLY marked as CLI-only) off the wire.
#
# If a future HTTP-exposing module imports `operations` from
# core/operations.ts WITHOUT applying the filter, the localOnly contract
# silently breaks: a write-scoped OAuth client could submit `sync_brain`
# or `file_upload` over HTTP. Codex outside-voice review of the e2e-test-
# wave (CMT-3) flagged this exact bypass class.
#
# The guard works by:
#   1. Listing every file that imports `operations` from core/operations.ts.
#   2. Comparing against an explicit ALLOWLIST of known-safe importers
#      (each with a rationale below).
#   3. Failing if a new file is missing from the allowlist — forces the
#      author to either (a) join the allowlist with an explicit rationale,
#      or (b) apply the canonical filter at import.
#
# This is a structural defense. The runtime defense lives in
# test/operations-trust-boundary.test.ts (the canonical filter contract +
# handler-invocation cases for the historically-broken classes).
#
# To allow a new importer: add the relative path to ALLOWED below with a
# one-line comment explaining why localOnly isn't a concern there.
#
# Exit: 0 when no unknown importers, 1 when at least one is missing from
# the allowlist.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Files allowed to import `operations` directly. Each entry must be
# accompanied by a one-line rationale (the comment on the same line).
ALLOWED=(
  "src/cli.ts"                                  # local CLI; user owns the machine, no trust boundary
  "src/mcp/dispatch.ts"                         # shared dispatch; sets ctx.remote from caller, handlers self-gate
  "src/mcp/server.ts"                           # stdio MCP; local-trusted (binary on user's box)
  "src/mcp/http-transport.ts"                   # superseded by serve-http.ts; kept for back-compat tests
  "src/mcp/tool-defs.ts"                        # pure helper; takes ops as parameter, never exposes them
  "src/core/minions/tools/brain-allowlist.ts"   # subagent registry; has its own opt-in allowlist (separate from localOnly)
  "src/commands/capture.ts"                     # local CLI tool; not network-exposed
  "src/commands/book-mirror.ts"                 # local CLI tool; not network-exposed
  "src/commands/tools-json.ts"                  # gbrain --tools-json introspection; full op list IS the purpose
  "src/commands/serve-http.ts"                  # MUST APPLY .filter(op => !op.localOnly) — verified by grep below
)

# Pattern: any import that brings the `operations` VALUE in from core/operations.ts.
# Three shapes the value can enter through; each must be caught:
#   - destructured:    import { operations } from '...core/operations.ts'
#   - aliased:         import { operations as ops } from '...core/operations.ts'
#   - namespace:       import * as opsModule from '...core/operations.ts'
# The original narrow regex only matched the destructured form — codex caught
# the bypass class during /ship adversarial review (aliased + namespace forms
# slipped through). The broadened regex below specifically requires `operations`
# inside the destructured clause OR a namespace import (`* as X`); type-only
# imports of sibling exports like `sourceScopeOpts` / `OperationContext` are
# left alone (those don't expose the op list to a transport surface).
PATTERN='import[[:space:]]+(\*[[:space:]]+as[[:space:]]+[a-zA-Z_$][a-zA-Z0-9_$]*|\{[^}]*\boperations\b[^}]*\})[[:space:]]+from[[:space:]]*['\''"][^'\''"]*core/operations\.ts['\''"]'

# Collect files that import `operations`. Use a while-loop over grep output
# instead of `mapfile` to stay compatible with macOS's default bash 3.2.
FOUND_FILES=""
while IFS= read -r f; do
  [ -n "$f" ] && FOUND_FILES="$FOUND_FILES$f"$'\n'
done < <(grep -rlE --include='*.ts' "$PATTERN" src/ 2>/dev/null | sort -u || true)

FAIL=0

# Check 1: every found file is in ALLOWED.
while IFS= read -r file; do
  [ -z "$file" ] && continue
  rel="${file#"$ROOT/"}"
  ok=0
  for allowed in "${ALLOWED[@]}"; do
    if [ "$rel" = "$allowed" ]; then
      ok=1
      break
    fi
  done
  if [ "$ok" -eq 0 ]; then
    echo "FAIL: $rel imports operations but is not in scripts/check-operations-filter-bypass.sh ALLOWED list."
    echo "      Either apply .filter(op => !op.localOnly) at the import boundary,"
    echo "      or add this file to ALLOWED with a one-line rationale."
    FAIL=1
  fi
done <<< "$FOUND_FILES"

# Check 2: serve-http.ts MUST contain the canonical filter expression near
# its operations import. Without the filter, the entire HTTP MCP surface
# leaks localOnly ops.
SERVE_HTTP="src/commands/serve-http.ts"
if [ -f "$SERVE_HTTP" ]; then
  if ! grep -qE 'operations\.filter\(\s*op\s*=>\s*!op\.localOnly\s*\)' "$SERVE_HTTP"; then
    echo "FAIL: $SERVE_HTTP no longer contains the canonical"
    echo "      operations.filter(op => !op.localOnly) expression. The HTTP MCP"
    echo "      surface depends on this filter to enforce localOnly. Restore"
    echo "      the filter or refactor the trust boundary explicitly."
    FAIL=1
  fi
fi

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "Hint: see test/operations-trust-boundary.test.ts for the runtime contract."
  exit 1
fi

exit 0
