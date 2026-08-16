#!/usr/bin/env bash
# v0.41.18.0 — CI guard against double-retry hazard.
#
# Engine batch methods (addLinksBatch / addTimelineEntriesBatch /
# upsertChunks) self-retry via withRetry(BULK_RETRY_OPTS) inside the engine
# implementation. Wrapping them ALSO at the call site produces 3×3=9 retry
# attempts under failure, amplifying load on a recovering circuit breaker
# and worsening the very incident the wave was designed to fix.
#
# This script greps src/ for the pattern and fails the build if found.
# Catches the migration-ordering hazard from the v0.41.18.0 eng review (D6)
# AND prevents future refactors from re-introducing the bug class.
#
# Usage: scripts/check-no-double-retry.sh
# Exit:  0 when no matches, 1 when matches found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# W0 fix-wave (Tier-1 #11): self-test seam. The guard harness points this at
# a known-bad fixture tree and asserts exit 1 — the guard can no longer rot
# into a permanently-green no-op unnoticed.
SCAN_ROOT="${GBRAIN_GUARD_ROOT:-src/}"

# Match: withRetry(...) wrapping any of the 3 engine batch methods.
#
# W0 fix-wave (Tier-1 #11): the previous pattern used `[^)]*` between
# `withRetry(` and `engine.`, which can never cross the `)` in `() =>` — so
# the CANONICAL banned shape (an arrow function wrapping the engine batch
# call) was invisible and the guard had been permanently green since it
# shipped. `.*` (line-bounded by grep) covers the arrow form, async arrows,
# and any argument shape. (Spelled without the literal call token here —
# check-system-of-record scans scripts/ comments too: the prose-bleed class.)
PATTERN='withRetry\(.*engine\.(addLinksBatch|addTimelineEntriesBatch|upsertChunks)'

# Single-line scan (covers ~95% of real cases).
if grep -rEn "$PATTERN" "$SCAN_ROOT" --include='*.ts' 2>/dev/null; then
  echo
  echo "ERROR: Found withRetry(...engine.{addLinksBatch|addTimelineEntriesBatch|upsertChunks})"
  echo "       pattern in src/."
  echo
  echo "       Engine batch methods self-retry via withRetry(BULK_RETRY_OPTS) in"
  echo "       postgres-engine.ts + pglite-engine.ts. Wrapping AGAIN at the call site"
  echo "       produces 3×3=9 retry attempts under failure, amplifying load on a"
  echo "       recovering circuit breaker."
  echo
  echo "       Fix: delete the outer withRetry wrap. Pass auditSite as a kwarg:"
  echo "         await engine.addLinks(batch, { auditSite: 'extract.links_inc' }); // example"
  echo
  echo "       Audit JSONL records the retries silently at "
  echo "       ~/.gbrain/audit/batch-retry-YYYY-Www.jsonl; check"
  echo "       \`gbrain doctor\` for the batch_retry_health surface."
  exit 1
fi

# Multi-line scan: a withRetry( on one line and the engine call within the
# next 3 lines. W0 fix-wave (Tier-1 #11): the previous pass was gated on
# pcregrep, which is not installed on dev machines OR CI — it never ran.
# perl is always available; same 3-line window, always on.
#
# Ship-review catch: perl must ALWAYS exit 0 and let OUTPUT PRESENCE decide.
# An exit-1-from-clean-batches design breaks under `set -o pipefail` the
# moment src/ outgrows one xargs batch (xargs exits 123, overriding grep's
# verdict) — a silently missed violation, the same permanently-green class
# this guard was just cured of.
MULTILINE_MATCHES=$(find "$SCAN_ROOT" -name '*.ts' -type f -print0 2>/dev/null | xargs -0 perl -0777 -ne '
  if (/withRetry\([^\n]*\n(?:[^\n]*\n){0,2}?[^\n]*engine\.(?:addLinksBatch|addTimelineEntriesBatch|upsertChunks)/) {
    print "$ARGV: multi-line withRetry wrap around an engine batch call\n";
  }
' 2>/dev/null || true)
if [ -n "$MULTILINE_MATCHES" ]; then
  echo "$MULTILINE_MATCHES"
  echo
  echo "ERROR: Multi-line withRetry(...engine.batch...) wrap found in $SCAN_ROOT. See above."
  exit 1
fi

echo "OK: no withRetry(...engine.batch...) double-retry patterns in $SCAN_ROOT"
