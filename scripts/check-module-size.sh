#!/usr/bin/env bash
# CI guard: module-size ratchet (containment sprint).
#
# The six giant modules (doctor.ts 10k, operations.ts 7.5k, ...) got that way
# one innocent commit at a time. This guard freezes every oversized file at a
# committed ceiling (scripts/module-size-limits.tsv) and caps every UNLISTED
# src file at a hard limit, so the only way to grow a giant is a reviewer-
# visible TSV edit.
#
# TSV columns (tab-separated): path  max_lines  policy  note
#   policy=ratchet        line count (wc -l) must stay <= max_lines
#   policy=region-exempt  lines OUTSIDE the `export const MIGRATIONS = [` ...
#                         `];` region must stay <= max_lines (the append-only
#                         migrations array grows freely; the runner logic
#                         around it must not)
#
# Rules (all violations reported, then one exit):
#   1. measured > max_lines            -> FAIL (growth; raise the ceiling
#                                         consciously via a TSV edit)
#   2. max_lines - measured > SLACK    -> FAIL (stale ceiling after a shrink;
#                                         lower it so the ratchet holds)
#   3. TSV path does not exist         -> FAIL (remove the row)
#   4. unlisted src file > NEWFILE_CAP -> FAIL (split it, or add a TSV row
#                                         consciously)
#
# Self-test seams: GBRAIN_GUARD_ROOT (fixture tree root; TSV read from
# <root>/scripts/module-size-limits.tsv), GBRAIN_MODULE_SIZE_SLACK,
# GBRAIN_MODULE_SIZE_NEWFILE_CAP.

set -uo pipefail

ROOT="${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 1

TSV="scripts/module-size-limits.tsv"
SLACK="${GBRAIN_MODULE_SIZE_SLACK:-50}"
NEWFILE_CAP="${GBRAIN_MODULE_SIZE_NEWFILE_CAP:-1500}"

if [ ! -f "$TSV" ]; then
  echo "FAIL: $TSV not found under $ROOT" >&2
  exit 1
fi

fail=0

measure_region_exempt() {
  # Lines outside the MIGRATIONS array region. The opener must be EXACTLY
  # `export const MIGRATIONS` followed by ':', ' ', or '=' — a bare prefix
  # match would let a spoof-named `export const MIGRATIONS_ANYTHING` open a
  # free-growth region. An unclosed region (EOF while still inside) prints
  # -1 so the caller fails loudly instead of silently exempting the rest of
  # the file.
  awk '
    /^export const MIGRATIONS[:= ]/ { in_region = 1; next }
    in_region && /^\];/             { in_region = 0; next }
    !in_region                      { n++ }
    END                             { print (in_region ? -1 : n + 0) }
  ' "$1"
}

listed_paths=""

while IFS=$'\t' read -r path max policy note; do
  case "$path" in ''|'#'*) continue ;; esac
  listed_paths="$listed_paths $path"

  if [ ! -f "$path" ]; then
    echo "FAIL: $TSV lists $path but the file does not exist — remove the row." >&2
    fail=1
    continue
  fi

  case "$policy" in
    ratchet)
      measured=$(wc -l < "$path" | tr -d ' ')
      label="lines"
      ;;
    region-exempt)
      measured=$(measure_region_exempt "$path")
      if [ "$measured" -eq -1 ]; then
        echo "FAIL: $path — region-exempt file has an unclosed MIGRATIONS region (opened but never closed with '];')." >&2
        echo "      An unclosed region would exempt the rest of the file from the size" >&2
        echo "      ratchet; close the array or fix the file structure." >&2
        fail=1
        continue
      fi
      label="lines outside the MIGRATIONS array"
      ;;
    *)
      echo "FAIL: $TSV row for $path has unknown policy '$policy' (ratchet|region-exempt)." >&2
      fail=1
      continue
      ;;
  esac

  if [ "$measured" -gt "$max" ]; then
    echo "FAIL: $path is $measured $label, over its $max ceiling." >&2
    echo "      Growing a size-ratcheted module is a conscious decision: either move" >&2
    echo "      the new code into a sibling module (preferred), or raise the ceiling" >&2
    echo "      in $TSV in this same commit so the reviewer sees it." >&2
    fail=1
  elif [ $((max - measured)) -gt "$SLACK" ]; then
    echo "FAIL: $path shrank to $measured $label but its ceiling is still $max." >&2
    echo "      Lower the ceiling in $TSV to $measured so the ratchet holds the win." >&2
    fail=1
  fi
done < "$TSV"

# Rule 4: every unlisted src .ts file (non-test, non-generated) obeys the cap.
while IFS= read -r f; do
  case " $listed_paths " in *" $f "*) continue ;; esac
  lines=$(wc -l < "$f" | tr -d ' ')
  if [ "$lines" -gt "$NEWFILE_CAP" ]; then
    echo "FAIL: $f is $lines lines, over the $NEWFILE_CAP cap for files not listed in $TSV." >&2
    echo "      Split it into sibling modules, or add a TSV row consciously." >&2
    fail=1
  fi
done < <(find src -name '*.ts' -not -name '*.generated.ts' -not -name '*.test.ts' 2>/dev/null | sort)

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "OK: module sizes within committed ceilings ($TSV; new-file cap $NEWFILE_CAP)."
