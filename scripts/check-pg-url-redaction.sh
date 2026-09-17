#!/usr/bin/env bash
# CI grep guard (v0.30.1, finding F3; widened to every db_url_credentials
# scheme per TODOS.md): no source file under src/ may emit a credential-
# bearing database URL to a logging surface.
#
# Specifically we forbid string literals or template substitutions that
# look like `postgresql://user:pass@host` (or the mysql/mongodb/redis/
# amqp/mssql equivalents — the same scheme set src/core/secret-scan.ts's
# `db_url_credentials` catch-all covers) being passed to:
#   - console.log / .warn / .error
#   - process.stderr.write / process.stdout.write
#   - appendFileSync / writeFileSync (audit JSONL writes)
#   - new logging APIs that may show up later (the regex matches the URL,
#     not the consumer; any leak will trip)
#
# Wired into bun run verify (single guard registry: scripts/guards-manifest.tsv).
#
# Exit codes: 0 = clean, 1 = found at least one suspect line.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

# False-positive allow-list: lines we know are safe.
#   - The redactor itself: src/core/url-redact.ts
#   - Test fixtures that build redacted strings from full URLs
#   - Documentation comments referring to the pattern
# The marker text is the exemption; its comment wrapper is not load-bearing
# (inside a /** block comment a literal `*/` would terminate the comment, so
# block-comment examples carry the bare marker).
ALLOW_REGEX='url-redact\.ts|test/url-redact\.test\.ts|allow-pg-url-literal'

# The pattern matches an unredacted, credential-bearing database URL
# appearing in a string literal, NOT preceded by `redactPgUrl(`/
# `redactUrlsInText(` or `***@`. We also match any URL containing `[^*]@`
# (i.e. the `***@` redacted form passes). Scheme set mirrors
# db_url_credentials in src/core/secret-scan.ts.
PATTERN='(postgres(ql)?|mysql|mongodb(\+srv)?|redis|rediss|amqp|mssql)://[^@*"`]+@'

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

echo "ERROR: unredacted database URL found in source. Use redactPgUrl() / redactUrlsInText() before logging."
echo ""
echo "$FILTERED"
echo ""
echo "Allowed exemption: append an allow-pg-url-literal comment marker on the line"
echo "(only for fixtures and the redactor itself)."
exit 1
