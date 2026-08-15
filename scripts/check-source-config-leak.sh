#!/usr/bin/env bash
# v0.40 D15.4 CI guard — prevent webhook_secret leak through sources.config
# serialization paths.
#
# After v0.40, sources.config can contain secrets (webhook_secret). Any code
# path that returns the raw config object via JSON.stringify / serializer
# without first running it through redactSourceConfig() will leak the secret.
#
# This script greps for risky patterns:
#   1. JSON.stringify on a `config` field where the source is a row from `sources`
#   2. New endpoints / ops that return raw `config` without `redactSourceConfig`
#
# Failure mode is loose-positive on purpose — false positives cost one
# 30-second comment-or-fix; false negatives leak production secrets.

set -euo pipefail

cd "$(dirname "$0")/.."

FOUND=0

# Pattern A: sources.config field referenced in a JSON serializer call site
# without redactSourceConfig nearby. Covers MCP op handlers, admin API
# routes, sources.ts subcommands that print --json output.
#
# Whitelist:
#   - src/core/source-config-redact.ts itself (defines the redactor)
#   - src/core/sources-load.ts (returns raw rows; callers redact)
#   - src/commands/sources.ts runFederate/runWebhook* (mutators write raw)
#   - src/core/migrate.ts (DDL data references not serialization)
#   - src/core/sources-ops.ts (CLI feedback prints structured fields, not raw config)
#   - test/ (tests are allowed to introspect raw config)

# Grep for `r.config\|src.config\|source.config` near JSON.stringify/console.log/res.json
# where redactSourceConfig is NOT used in the same hunk.
RAW_PATTERN='\b(\.config\b|config:[[:space:]]*src\.config)\b'

# Tightened patterns: match serializers that pass a source-row's .config
# field (source.config, src.config, row.config, s.config, or a property
# access like `.config` on an object likely sourced from a `sources` row),
# NOT every variable named "config" (which would catch global gbrain config).
#
# The risk pattern is `JSON.stringify(<srcVar>.config)` where srcVar holds
# a row from the sources table. Variables that hold the GLOBAL gbrain
# config.json are also commonly named `config` — that's a different shape
# and a different threat model (already protected at the file-mode 0o600
# write site in src/core/config.ts).
#
# rg uses `-g` for globs; grep -rE uses `--include`. Branch accordingly so
# CI runners without rg still match cleanly.
if command -v rg >/dev/null 2>&1; then
  CANDIDATES=$(rg -n \
    -e 'JSON\.stringify\((source|src|row|s)\.config' \
    -e 'res\.json\((source|src|row|s)\.config' \
    -e 'res\.json\(\{[^}]*\.config[^.]' \
    -e 'console\.log\(JSON\.stringify\((source|src|row|s)\.config' \
    -g '*.ts' \
    src/ 2>/dev/null || true)
else
  CANDIDATES=$(grep -rEn \
    -e 'JSON\.stringify\((source|src|row|s)\.config' \
    -e 'res\.json\((source|src|row|s)\.config' \
    -e 'res\.json\(\{[^}]*\.config[^.]' \
    -e 'console\.log\(JSON\.stringify\((source|src|row|s)\.config' \
    --include='*.ts' \
    src/ 2>/dev/null || true)
fi

# Filter out files we trust (handle sources.config redaction themselves OR
# handle the gbrain global config, which is a different object).
FILTERED=$(echo "$CANDIDATES" | \
  grep -v 'src/core/source-config-redact.ts' | \
  grep -v 'src/core/sources-load.ts' | \
  grep -v 'src/commands/sources.ts' | \
  grep -v 'src/core/migrate.ts' | \
  grep -v 'src/core/sources-ops.ts' | \
  grep -v 'src/commands/init.ts' | \
  grep -v 'src/core/config.ts' || true)

if [ -n "$FILTERED" ]; then
  # For each candidate, check if redactSourceConfig appears within 10 lines above.
  while IFS= read -r LINE; do
    [ -z "$LINE" ] && continue
    FILE=$(echo "$LINE" | cut -d: -f1)
    LINENO=$(echo "$LINE" | cut -d: -f2)
    # Look in surrounding 20 lines
    START=$((LINENO - 10))
    [ "$START" -lt 1 ] && START=1
    END=$((LINENO + 5))
    CONTEXT=$(sed -n "${START},${END}p" "$FILE" 2>/dev/null || true)
    if ! echo "$CONTEXT" | grep -q 'redactSourceConfig'; then
      echo "POTENTIAL_LEAK: $LINE"
      echo "  Context lacks redactSourceConfig — verify webhook_secret cannot be serialized."
      FOUND=1
    fi
  done <<< "$FILTERED"
fi

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo "v0.40 D15.4 guard: every sources.config serializer MUST go through"
  echo "redactSourceConfig() from src/core/source-config-redact.ts."
  echo ""
  echo "If a flagged site is a known false positive (e.g. CLI command that"
  echo "only prints metadata, not the raw object), update the whitelist in"
  echo "scripts/check-source-config-leak.sh."
  exit 1
fi

exit 0
