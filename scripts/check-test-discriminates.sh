#!/usr/bin/env bash
# scripts/check-test-discriminates.sh — does this test actually pin the fix? (#3665)
#
# A fix's test is only worth anything if it FAILS without the fix. This helper
# makes that a one-command local check so the PR template's required
# "Discrimination test" field is trivial to fill honestly:
#
#   bash scripts/check-test-discriminates.sh <test-file> <source-file> [<source-file>...]
#
# What it does:
#   1. Saves the named source files aside (plain file copies — no git stash, so
#      concurrent worktree users are never disturbed).
#   2. Reverts each source file to its pre-fix state:
#        - dirty file (uncommitted fix)  → content from HEAD
#        - clean file (committed fix)    → content from $DISCRIMINATE_BASE
#          (default: merge-base with origin/master, falling back to HEAD~1)
#      A file that does not exist in the base ref is removed (its pre-fix
#      state is nonexistence).
#   3. Runs `bun test <test-file>` and parses the pass/fail counts.
#   4. Restores the source files (also on ^C / error — trap'd).
#
# Exit codes:
#   0  DISCRIMINATES — the test fails against the pre-fix source (>=1 test ran
#      and failed).
#   1  DOES NOT DISCRIMINATE — the test passes with the fix reverted. The test
#      is green both ways and pins nothing (the #3665 class).
#   3  VACUOUS FAILURE — non-zero exit but zero executed-test failures (import
#      crash, missing file, bash 127). A missing binary also exits non-zero;
#      that is not discrimination (the #3573 class).
#   2  usage / setup error.
#
# NOT wired into CI: the script cannot know which hunk is "the fix" on an
# arbitrary diff. It exists so the author can, in two minutes, produce the
# reviewable claim the PR template asks for.

set -uo pipefail

usage() {
  echo "usage: bash scripts/check-test-discriminates.sh <test-file> <source-file> [<source-file>...]" >&2
  echo "env:   DISCRIMINATE_BASE=<ref>   pre-fix ref for committed fixes (default: merge-base with origin/master)" >&2
  exit 2
}

[ $# -ge 2 ] || usage
TEST_FILE="$1"; shift
SOURCES=("$@")

cd "$(dirname "$0")/.."

[ -f "$TEST_FILE" ] || { echo "[discriminate] test file not found: $TEST_FILE" >&2; exit 2; }
for f in "${SOURCES[@]}"; do
  [ -f "$f" ] || { echo "[discriminate] source file not found: $f" >&2; exit 2; }
  case "$f" in
    test/*) echo "[discriminate] $f is a test file — pass source files after the test file" >&2; exit 2 ;;
  esac
done

BASE_REF="${DISCRIMINATE_BASE:-}"
if [ -z "$BASE_REF" ]; then
  BASE_REF="$(git merge-base HEAD origin/master 2>/dev/null || true)"
  [ -n "$BASE_REF" ] || BASE_REF="HEAD~1"
fi

SAVE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/discriminate.XXXXXX")"
restore() {
  local i=0
  for f in "${SOURCES[@]}"; do
    if [ -f "$SAVE_DIR/$i" ]; then
      cp "$SAVE_DIR/$i" "$f"
    fi
    i=$((i + 1))
  done
  rm -rf "$SAVE_DIR"
}
trap restore EXIT INT TERM

i=0
for f in "${SOURCES[@]}"; do
  cp "$f" "$SAVE_DIR/$i"
  if git diff --quiet -- "$f" 2>/dev/null; then
    # Clean file: the fix is committed — revert to the pre-fix base ref.
    if git cat-file -e "$BASE_REF:$f" 2>/dev/null; then
      git show "$BASE_REF:$f" > "$f"
      echo "[discriminate] reverted $f to $BASE_REF" >&2
    else
      rm -f "$f"
      echo "[discriminate] $f does not exist at $BASE_REF — removed (pre-fix state is nonexistence)" >&2
    fi
  else
    # Dirty file: the fix is uncommitted — revert to HEAD.
    git show "HEAD:$f" > "$f" 2>/dev/null || { rm -f "$f"; echo "[discriminate] $f is new+uncommitted — removed" >&2; }
    echo "[discriminate] reverted $f to HEAD (uncommitted fix)" >&2
  fi
  i=$((i + 1))
done

OUT="$(mktemp "${TMPDIR:-/tmp}/discriminate-out.XXXXXX")"
bun test --timeout=60000 "$TEST_FILE" > "$OUT" 2>&1
TEST_EXIT=$?
restore
trap - EXIT INT TERM

FAILS="$(grep -Eo '^[[:space:]]*[0-9]+ fail' "$OUT" | grep -Eo '[0-9]+' | tail -1)"
PASSES="$(grep -Eo '^[[:space:]]*[0-9]+ pass' "$OUT" | grep -Eo '[0-9]+' | tail -1)"
FAILS="${FAILS:-0}"
PASSES="${PASSES:-0}"

echo "[discriminate] pre-fix run: exit=$TEST_EXIT pass=$PASSES fail=$FAILS (full output: $OUT)" >&2

if [ "$TEST_EXIT" -eq 0 ]; then
  echo "[discriminate] DOES NOT DISCRIMINATE: $TEST_FILE passes with the fix reverted." >&2
  echo "[discriminate] The test is green both ways and pins nothing — tighten its assertions." >&2
  exit 1
fi
if [ "$FAILS" -eq 0 ]; then
  echo "[discriminate] VACUOUS FAILURE: non-zero exit but no executed test failed (crash/127?)." >&2
  echo "[discriminate] A missing file also exits non-zero — that is not discrimination." >&2
  exit 3
fi

echo "[discriminate] OK: test fails against the pre-fix source ($FAILS failing). Paste into the PR:" >&2
echo "Discrimination test: reverted ${SOURCES[*]} to ${DISCRIMINATE_BASE:-merge-base}, ran $TEST_FILE → $PASSES pass / $FAILS fail. Restored → all pass."
exit 0
