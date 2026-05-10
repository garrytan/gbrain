#!/usr/bin/env bash
# CI grep guard (v0.30.1, finding F3): no source file under src/ may emit
# a postgresql:// URL with userinfo to a logging surface.
#
# Specifically we forbid string literals or template substitutions that
# look like `postgresql://user:pass@host` being passed to:
#   - console.log / .warn / .error
#   - process.stderr.write / process.stdout.write
#   - appendFileSync / writeFileSync (audit JSONL writes)
#   - new logging APIs that may show up later (the regex matches the URL,
#     not the consumer; any leak will trip)
#
# Wired into bun run check:all and bun run verify.
#
# Exit codes: 0 = clean, 1 = found at least one suspect line.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

# False-positive allow-list: lines we know are safe.
#   - The redactor itself: src/core/url-redact.ts
#   - Test fixtures that build redacted strings from full URLs
#   - Documentation comments referring to the pattern
ALLOW_REGEX='url-redact\.ts|test/url-redact\.test\.ts|/\* allow-pg-url-literal \*/'

# The pattern matches an unredacted Postgres URL appearing in a string
# literal, NOT preceded by `redactPgUrl(` or `***@`. We also match any
# URL containing `[^*]@` (i.e. the `***@` redacted form passes).
PATTERN='postgres(ql)?://[^@*"`]+@'

# Search src/ only — tests are excluded since they intentionally construct
# unredacted URLs as input fixtures.
HITS=$(grep -rEn "$PATTERN" "$ROOT/src" 2>/dev/null || true)

if [ -z "$HITS" ]; then
  exit 0
fi

# Filter against the allow-list.
FILTERED=$(echo "$HITS" | grep -vE "$ALLOW_REGEX" || true)

if [ -z "$FILTERED" ]; then
  exit 0
fi

echo "ERROR: unredacted postgres:// URL found in source. Use redactPgUrl() before logging."
echo ""
echo "$FILTERED"
echo ""
echo "Allowed exemption: append \"/* allow-pg-url-literal */\" comment on the line"
echo "(only for fixtures and the redactor itself)."
exit 1
