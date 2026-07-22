#!/usr/bin/env bash
# v0.41.18.0 — CI guard against batch-audit-site typo drift (codex H-7).
#
# auditSite labels flow from call sites into the batch-retry audit JSONL
# and from there into `gbrain doctor`'s batch_retry_health check. A typo
# like `'extract.lnks_inc'` doesn't break compilation (TypeScript narrows
# string literals only via the BatchAuditSite type, but external string
# values escape this — e.g. config, environment, dynamic dispatch).
#
# This script extracts every string-literal `auditSite: '...'` value from
# src/ and validates it appears in the BATCH_AUDIT_SITES const list in
# src/core/retry.ts. Fails the build on mismatch.
#
# Usage: scripts/check-batch-audit-site.sh
# Exit:  0 when every literal matches the enum, 1 otherwise.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

RETRY_FILE="src/core/retry.ts"
if [ ! -f "$RETRY_FILE" ]; then
  echo "ERROR: $RETRY_FILE missing — cannot validate audit sites."
  exit 1
fi

# Extract every entry inside BATCH_AUDIT_SITES = [ ... ] as const.
# Strips quotes + trailing commas + whitespace. Strict awk window between
# the array open and closing `] as const`.
KNOWN_SITES=$(awk '
  /BATCH_AUDIT_SITES = \[/ { capture = 1; next }
  capture && /\] as const/ { capture = 0; exit }
  capture {
    # Pull out '\''xyz'\'' or "xyz" string literals on the line.
    while (match($0, /['\''"]([^'\''"]+)['\''"]/)) {
      print substr($0, RSTART + 1, RLENGTH - 2)
      $0 = substr($0, RSTART + RLENGTH)
    }
  }
' "$RETRY_FILE" | sort -u)

if [ -z "$KNOWN_SITES" ]; then
  echo "ERROR: Could not extract BATCH_AUDIT_SITES from $RETRY_FILE."
  exit 1
fi

# Extract every `auditSite: '...'` literal from src/ (excluding retry.ts
# itself which contains the enum definition, and test files which are
# allowed to use synthetic sites for assertion scaffolding).
USED_SITES=$(
  grep -rEh "auditSite:[[:space:]]*['\"][^'\"]+['\"]" src/ \
    --include='*.ts' \
    --exclude-dir=core/audit \
    --exclude='retry.ts' \
    | sed -E "s/.*auditSite:[[:space:]]*['\"]([^'\"]+)['\"].*/\1/" \
    | sort -u
)

if [ -z "$USED_SITES" ]; then
  echo "OK: no auditSite literals found in src/ (engines use defaults)"
  exit 0
fi

UNKNOWN_SITES=$(comm -23 <(echo "$USED_SITES") <(echo "$KNOWN_SITES") || true)

if [ -n "$UNKNOWN_SITES" ]; then
  echo "ERROR: Unknown auditSite literal(s) found in src/:"
  echo "$UNKNOWN_SITES" | sed 's/^/  /'
  echo
  echo "Fix: add the value to BATCH_AUDIT_SITES in src/core/retry.ts."
  echo "     The enum is the closed list of known sites."
  echo
  echo "Known sites:"
  echo "$KNOWN_SITES" | sed 's/^/  /'
  exit 1
fi

echo "OK: all auditSite literals match BATCH_AUDIT_SITES enum"
