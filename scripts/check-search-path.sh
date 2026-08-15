#!/usr/bin/env bash
# CI guard (#1647 / #171): every trigger function in the canonical schema base
# files MUST pin `SET search_path`. Without it, an unqualified reference inside
# the function body resolves through the caller's search_path, so a same-named
# object in a user-controlled schema could shadow it. Migration v120 ALTERs
# existing brains; this guard keeps fresh-install function definitions correct
# so a NEW trigger function can't reintroduce the gap. Mirrors the
# check-jsonb-pattern.sh guard philosophy (a written rule caused the disease;
# a guard cures it).
#
# Scope: schema base files only (src/schema.sql, src/core/pglite-schema.ts).
# Historical migration bodies in migrate.ts are append-only and not rescanned;
# the runtime doctor probe (pg_proc.proconfig) covers the live post-migration
# state on real brains.
#
# Usage: scripts/check-search-path.sh
# Exit:  0 when all trigger functions pin search_path, 1 otherwise.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

FILES="src/schema.sql src/core/pglite-schema.ts src/core/schema-embedded.ts"

# A hardened header reads `... RETURNS trigger SET search_path = ... AS $tag$`.
# An UNHARDENED one reads `... RETURNS trigger AS $tag$` — match that form and
# (belt-and-suspenders) drop any line that already mentions search_path.
BAD="$(grep -nEi 'CREATE OR REPLACE FUNCTION [a-z_]+\(\) RETURNS trigger AS ' $FILES 2>/dev/null | grep -vi 'search_path' || true)"

if [ -n "$BAD" ]; then
  echo "ERROR: trigger function(s) missing SET search_path in schema base files:"
  echo "$BAD"
  echo
  echo "Add 'SET search_path = pg_catalog, public' to the function header, e.g.:"
  echo "  CREATE OR REPLACE FUNCTION foo() RETURNS trigger SET search_path = pg_catalog, public AS \$\$"
  echo "See #1647 / #171."
  exit 1
fi

echo "OK: all trigger functions in schema base files pin search_path"
