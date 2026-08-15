#!/usr/bin/env bash
# #3485 shared shell name floor, mirrored from test/helpers/db-guard.ts.
#
# Heavy-lane scripts run destructive operations (DROP SCHEMA, source-registry
# UPSERTs, initSchema migration replay, parallel syncs) against whatever
# database URL the resolved config names. The bunfig preload guard is
# bun-test-only — shell lanes need their own floor. Source this file AFTER
# confirming DATABASE_URL is set:
#
#   source "$(dirname "$0")/_db_floor.sh"   # exits 2 unless every set db-url
#                                           # var is test-shaped or allowed
#
# BOTH variables are floored: heavy scripts shell out to the real CLI
# (gbrain doctor / gbrain sync), and src/core/config.ts resolves
# GBRAIN_DATABASE_URL ABOVE DATABASE_URL — flooring only one would let the
# other reach a real brain. Query strings are stripped BEFORE the name is
# extracted: `?host=/tmp/test-sockets` must not smuggle a test-shaped segment
# past the floor (the last path segment of the pre-query URL is the db name).
#
# Refuses unless the database name carries "test" as a word segment
# (gbrain_test) or the operator opts the exact name in via GBRAIN_E2E_ALLOW_DB
# (prefer one-shot inline usage — GBRAIN_E2E_ALLOW_DB=name ./script — over a
# shell-profile export, which would permanently disarm the floor).

_db_floor_check() {
  _db_floor_url="$1"
  _db_floor_var="$2"
  [ -z "$_db_floor_url" ] && return 0
  _db_floor_prequery="${_db_floor_url%%\?*}"
  _db_floor_name="${_db_floor_prequery##*/}"
  if [ -z "$_db_floor_name" ]; then
    echo "[db-floor] REFUSING: $_db_floor_var has no database name" >&2
    exit 2
  fi
  if ! printf '%s' "$_db_floor_name" | grep -qiE '(^|[_-])test([_-]|$)'; then
    if [ "${GBRAIN_E2E_ALLOW_DB:-}" != "$_db_floor_name" ]; then
      echo "[db-floor] REFUSING: $_db_floor_var database \"$_db_floor_name\" does not look like a test database" >&2
      echo "  (expected \"test\" as a name segment, e.g. gbrain_test). Heavy-lane scripts run" >&2
      echo "  destructive operations against it. If intentional, opt in one-shot:" >&2
      echo "    GBRAIN_E2E_ALLOW_DB=$_db_floor_name <command>" >&2
      exit 2
    fi
  fi
}

_db_floor_check "${DATABASE_URL:-}" DATABASE_URL
_db_floor_check "${GBRAIN_DATABASE_URL:-}" GBRAIN_DATABASE_URL
unset -f _db_floor_check 2>/dev/null || true
unset _db_floor_url _db_floor_var _db_floor_prequery _db_floor_name 2>/dev/null || true
