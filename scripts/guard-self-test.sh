#!/usr/bin/env bash
# W0 fix-wave (Tier-1 #11 / D5.14): guard self-test harness.
#
# The audit found scripts/check-no-double-retry.sh had been PERMANENTLY GREEN
# since it shipped: its regex could not match the canonical banned shape, and
# its multi-line fallback was gated on pcregrep, which is installed nowhere.
# A guard that cannot fail is worse than no guard — it reads as coverage.
#
# This harness makes that class structurally impossible for scanner guards:
# every guard marked `selftest yes` in scripts/guards-manifest.tsv is run
# against test/fixtures/guards/<guard>/bad (MUST exit non-zero) and
# .../good (MUST exit 0), via the GBRAIN_GUARD_ROOT override each guard
# honors. Adding a self-test to a `todo` scanner = flip the manifest flag +
# drop two fixture files.
#
# Also prints total harness wall-clock (guard-runtime budget line, D4.5):
# fails if the self-test pass exceeds the budget, so guard sprawl shows up
# here before it shows up as slow `bun run verify`.
#
# Usage: scripts/guard-self-test.sh
# Exit:  0 = every self-tested guard fails on bad + passes on good.

set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

MANIFEST="scripts/guards-manifest.tsv"
FIXTURES="test/fixtures/guards"
BUDGET_SECONDS=30
START=$(date +%s)
failures=0
tested=0

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: $MANIFEST missing — the guard registry is load-bearing."
  exit 1
fi

run_guard() {
  local guard="$1" fixture_root="$2"
  case "$guard" in
    *.mjs) GBRAIN_GUARD_ROOT="$fixture_root" node "scripts/$guard" "$fixture_root" >/dev/null 2>&1 ;;
    *)     GBRAIN_GUARD_ROOT="$fixture_root" bash "scripts/$guard" >/dev/null 2>&1 ;;
  esac
}

while IFS=$'\t' read -r guard klass selftest _notes; do
  case "$guard" in ''|'#'*) continue ;; esac
  [ "$selftest" = "yes" ] || continue
  tested=$((tested + 1))

  bad="$FIXTURES/$guard/bad"
  good="$FIXTURES/$guard/good"
  if [ ! -d "$bad" ] || [ ! -d "$good" ]; then
    echo "FAIL  $guard: manifest says selftest=yes but fixtures missing under $FIXTURES/$guard/{bad,good}"
    failures=$((failures + 1))
    continue
  fi

  if run_guard "$guard" "$bad"; then
    echo "FAIL  $guard: did NOT flag the known-bad fixture — the guard is a no-op (the check-no-double-retry class)"
    failures=$((failures + 1))
  elif ! run_guard "$guard" "$good"; then
    echo "FAIL  $guard: flagged the known-good fixture — false positive"
    failures=$((failures + 1))
  else
    echo "ok    $guard (bad→fail, good→pass)"
  fi
done < "$MANIFEST"

# Manifest completeness: every scripts/check-* guard must have a manifest row
# (new guards can't silently skip classification).
for f in scripts/check-*.sh scripts/check-*.mjs; do
  base="$(basename "$f")"
  # The .ts companion of check-engine-dynamic-import is an implementation file.
  if ! grep -q "^${base}	" "$MANIFEST"; then
    echo "FAIL  $base: no row in $MANIFEST — classify it (scanner|buildfresh|repostate)"
    failures=$((failures + 1))
  fi
done

ELAPSED=$(( $(date +%s) - START ))
echo "guard self-test: $tested guard(s) self-tested, ${ELAPSED}s (budget ${BUDGET_SECONDS}s)"
if [ "$ELAPSED" -gt "$BUDGET_SECONDS" ]; then
  echo "FAIL  guard self-test exceeded the ${BUDGET_SECONDS}s runtime budget — trim fixtures or parallelize before adding more"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  echo "ERROR: $failures guard self-test failure(s)."
  exit 1
fi
echo "OK: all self-tested guards catch their bad fixtures and pass their good ones"
