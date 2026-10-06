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
# against test/fixtures/guards/<guard>/bad and every bad-<variant> sibling
# (EACH must exit non-zero on its own) and .../good (MUST exit 0), via the
# GBRAIN_GUARD_ROOT override each guard
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
    *.ts)  GBRAIN_GUARD_ROOT="$fixture_root" bun "scripts/$guard" >/dev/null 2>&1 ;;
    *)     GBRAIN_GUARD_ROOT="$fixture_root" bash "scripts/$guard" >/dev/null 2>&1 ;;
  esac
}

# One guard's bad/good cases; prints its result line and exits non-zero per failure.
self_test_guard() {
  local guard="$1" bad good guard_ok=1 variants=0 failed=0 bad_tree
  bad="$FIXTURES/$guard/bad"
  good="$FIXTURES/$guard/good"
  if [ ! -d "$bad" ] || [ ! -d "$good" ]; then
    echo "FAIL  $guard: manifest says selftest=yes but fixtures missing under $FIXTURES/$guard/{bad,good}"
    return 1
  fi

  # bad/ plus any bad-<variant>/ trees (e.g. one per refactor-wave-1 module
  # dir): each must fail ON ITS OWN, proving the guard scans that location.
  for bad_tree in "$bad" "$FIXTURES/$guard"/bad-*; do
    [ -d "$bad_tree" ] || continue
    variants=$((variants + 1))
    if run_guard "$guard" "$bad_tree"; then
      echo "FAIL  $guard: did NOT flag the known-bad fixture $(basename "$bad_tree") — the guard is a no-op there (the check-no-double-retry class)"
      failed=$((failed + 1))
      guard_ok=0
    fi
  done
  if ! run_guard "$guard" "$good"; then
    echo "FAIL  $guard: flagged the known-good fixture — false positive"
    failed=$((failed + 1))
  elif [ "$guard_ok" = "1" ]; then
    echo "ok    $guard (bad→fail x$variants, good→pass)"
  fi
  return "$failed"
}

# Guards are independent (each reads only its own fixture root), so run up to
# GUARD_SELF_TEST_JOBS at once and print results in manifest order.
JOBS="${GUARD_SELF_TEST_JOBS:-4}"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT
guards=()
while IFS=$'\t' read -r guard klass selftest _notes; do
  case "$guard" in ''|'#'*) continue ;; esac
  [ "$selftest" = "yes" ] || continue
  guards+=("$guard")
done < "$MANIFEST"
pids=()
for i in "${!guards[@]}"; do
  if [ "${#pids[@]}" -ge "$JOBS" ]; then
    wait "${pids[0]}"
    pids=("${pids[@]:1}")
  fi
  ( self_test_guard "${guards[$i]}" > "$OUT_DIR/$i.out" 2>&1; echo $? > "$OUT_DIR/$i.rc" ) &
  pids+=("$!")
done
wait
for i in "${!guards[@]}"; do
  tested=$((tested + 1))
  cat "$OUT_DIR/$i.out"
  failures=$((failures + $(cat "$OUT_DIR/$i.rc" 2>/dev/null || echo 1)))
done

# Manifest completeness: every scripts/check-* guard must have a manifest row
# (new guards can't silently skip classification).
for f in scripts/check-*.sh scripts/check-*.mjs scripts/check-*.ts; do
  base="$(basename "$f")"
  # The .ts companion of check-engine-dynamic-import is an implementation file.
  [ "$base" = "check-engine-dynamic-import.ts" ] && continue
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
