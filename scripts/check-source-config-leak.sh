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
#
# This grep is a tripwire, not the contract. The behavioral contract is
# test/source-config-secret-surfaces.test.ts (plus the backup and admin API
# assertions named below): each surface is fed a stored webhook_secret and
# must never print it.
#
# Secret-bearing keys (SECRET_KEYS in src/core/source-config-redact.ts):
# webhook_secret only. Every other key the codebase reads is a pointer, not a
# credential: gh_token_env / g_token_env name an env var, gh_app_pem_path
# names a key file, g_token_command names a mint command, g_account is an
# account pointer (tokens live in the credential vault), and remote_url is
# rejected at registration when it embeds credentials (parseRemoteUrl).
#
# Audited surfaces (source-config security audit):
#   LEAKED, fixed with redactSourceConfig():
#     - sources_add op result, printed by `gbrain call sources_add` when a
#       path is attached to an existing path-less source (src/core/ops/sources.ts)
#     - managed `gbrain sources add` receipt, its replay, and the retained
#       persistence_topology_changes outcome (src/core/persistence/source-lifecycle.ts)
#   Clean (explicit field projections; covered by behavioral tests):
#     - sources list / list --json / status / status --json / webhook show /
#       current --json / archived / archived --json / remove --dry-run
#     - parse warnings for re-wrapped configs (src/core/sources-load.ts)
#     - remote MCP sources_list, sources_status, get_status_snapshot, run_doctor
#     - local doctor --json
#     - admin API GET /admin/api/sources (test/e2e/serve-http-oauth.test.ts)
#     - backup metadata, restore reconnect lines and restore-receipt.json
#       (test/agent-install-backup.serial.test.ts)
#     - audit JSONL / log files under GBRAIN_HOME (none carry source config)
#   Intentional one-time reveals, each printing the new secret exactly once:
#     - `sources webhook set` and `sources webhook rotate` (src/commands/sources.ts)
#   Documented sensitive state (kept): the full-database backup archive
#     (classification 'sensitive-full-database-state') and the private 0600
#     restore inventory .gbrain/restore-detached.json, which retains detached
#     source configs so the operator can reconnect them.
#   Internal readers that never serialize config (predicates only): sync,
#     autopilot, source resolver, destructive guard, webhook HMAC check,
#     connectors, minion authority (hashed into a digest), company brain.

set -euo pipefail

cd "$(dirname "$0")/.."
# Self-test seam: GBRAIN_GUARD_ROOT points at a fixture tree with its own src/.
# The scan covers all of src/, including refactor wave 1's module dirs
# (src/commands/serve-http-*.ts, src/core/engine-sql/, src/commands/sync/,
# src/commands/doctor/checks/); each has a known-bad fixture.
if [ -n "${GBRAIN_GUARD_ROOT:-}" ]; then cd "$GBRAIN_GUARD_ROOT"; fi

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
    SITE_LINE=$(echo "$LINE" | cut -d: -f2)
    # Look in surrounding 20 lines
    START=$((SITE_LINE - 10))
    [ "$START" -lt 1 ] && START=1
    END=$((SITE_LINE + 5))
    CONTEXT=$(sed -n "${START},${END}p" "$FILE" 2>/dev/null || true)
    if ! grep -q 'redactSourceConfig' <<< "$CONTEXT"; then
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
