#!/usr/bin/env bash
# CI guard: retired contributor-workflow phrases stay out of the docs agents follow.
#
# Refactor wave 1 moved the code several always-loaded instructions pointed at:
# migrations are one file each under src/core/schema-migrations/, migrated
# storage domains keep their SQL once in src/core/engine-sql/, CLI-only
# commands are records in src/cli/command-table.ts, the PGLite schema template
# is generated, and the migrate.ts region policy is gone. Agents follow
# CLAUDE.md, AGENTS.md, CONTRIBUTING.md, docs/ and skills/ literally, so one
# stale sentence sends them to edit the wrong file. This guard fails when a
# retired phrase reappears there.
#
# Historical records are exempt: docs/designs/, docs/test-audit/,
# docs/incidents/, docs/plans/, docs/proposals/, docs/research/, docs/issues/,
# docs/superpowers/, docs/migrations/ and skills/migrations/ (release
# migration notes), and the wave 1 porting kit (docs/architecture/wave-1-*).
# CHANGELOG.md is outside the scanned set.
#
# Each failure prints FAIL / Why / Fix / See. To retire another phrase, add a
# row to RETIRED below (ERE pattern, TAB, the current instruction).
#
# Run: bash scripts/check-retired-phrases.sh
# Wired into `bun run verify` via package.json `check:retired-phrases`.
# Self-test seam: GBRAIN_GUARD_ROOT points at a fixture tree.

set -uo pipefail

ROOT="${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 2

SCAN=()
for p in CLAUDE.md AGENTS.md CONTRIBUTING.md docs skills; do
  [ -e "$p" ] && SCAN+=("$p")
done
if [ "${#SCAN[@]}" -eq 0 ]; then
  echo "✓ retired phrases: nothing to scan under $ROOT"
  exit 0
fi

EXEMPT='^(docs/(designs|test-audit|incidents|plans|proposals|research|issues|superpowers|migrations)/|skills/migrations/|docs/architecture/wave-1-)'

# pattern<TAB>current instruction
# Read with `read -d ''`, never a `cat` heredoc inside a command substitution:
# macOS /bin/bash 3.2 quote-scans that heredoc and dies on the apostrophe and
# the odd backticks in these rows, so the guard could not even parse there.
IFS= read -r -d '' RETIRED <<'EOF' || true
MIGRATIONS`? array	Migrations are one file each: `bun run new:migration <snake_name>` scaffolds src/core/schema-migrations/v<NNN>-<name>.ts and regenerates registry.generated.ts; migrate.ts is only the runner.
append(s|ing)? (an entry |a migration |it )?to (the )?`?MIGRATIONS	Migrations are one file each: `bun run new:migration <snake_name>` (src/core/schema-migrations/), never an array append.
lands in BOTH	A migrated storage domain's SQL lives once in src/core/engine-sql/<domain>.ts and both engines delegate to it; only unmigrated or dialect-specific methods are written per engine (scripts/engine-sql-baseline.tsv).
Add the case to	A CLI-only command is a record in src/cli/command-table.ts plus its dispatch module src/cli/commands/<name>.ts, then `bun run build:flag-registry`.
region-exempt	The module-size ratchet has one policy (`ratchet`); migrate.ts is runner-only and ratcheted like every other file.
schema\.sql \+ pglite-schema\.ts|pglite-schema\.ts \+ schema\.sql	Schema DDL has one hand-edited copy: edit src/schema.sql (or the TS fragment its region banner names), then `bun run build:schema` regenerates schema-embedded.generated.ts and pglite-schema.generated.ts.
EOF

fail=0
hits=0
while IFS=$'\t' read -r pattern fix; do
  [ -n "$pattern" ] || continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    file="${hit%%:*}"
    if printf '%s\n' "$file" | grep -qE "$EXEMPT"; then continue; fi
    rest="${hit#*:}"
    line="${rest%%:*}"
    text="${rest#*:}"
    match=$(printf '%s\n' "$text" | grep -oE "$pattern" | head -1)
    hits=$((hits + 1))
    fail=1
    echo "FAIL: $file:$line retired phrase \"$match\"" >&2
    echo "Why:  refactor wave 1 retired this workflow; agents follow these docs literally and would edit the wrong file." >&2
    echo "Fix:  rewrite the sentence to the current instruction: $fix" >&2
    echo "See:  docs/TESTING.md#retired-phrase-guard" >&2
  done < <(grep -rnIE "$pattern" "${SCAN[@]}" 2>/dev/null || true)
done <<< "$RETIRED"

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "✗ retired phrases: $hits hit(s) in CLAUDE.md / AGENTS.md / CONTRIBUTING.md / docs / skills" >&2
  exit 1
fi
echo "✓ retired phrases: none in CLAUDE.md, AGENTS.md, CONTRIBUTING.md, docs/ or skills/ (historical records exempt)"
