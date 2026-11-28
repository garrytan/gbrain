#!/usr/bin/env bash
# The served Rust parity set gate (multi-user lane L3): runs exactly the `served` rows of
# test/engine-parity/rust-served-set.tsv on the Rust arm as a served client of a brain server (GBRAIN_TEST_RUST_SERVED=1,
# multi_writer on), with multi-user mode on through one route, one Bun process per file. Every file runs, whatever an
# earlier file did. The run is red when any file fails, when a file's output does not show the arm ran in that route
# (the `[rust-mu-<route> arm]` line: the mode was on and asserted), when a listed file does not exist, or when no file ran.
# It also holds each file that has a row in the Rust tally pins to that row (the L3 brief: a served file has the outcomes
# of the plain Rust arm): red when the file's served tally line is missing, or has fewer equal or more stopped cases than
# the pin, counting the cases the multi-user view holds as known gaps or pinned stops, as the harness does.
#
# Usage: scripts/run-rust-served-set.sh <env|config>
#        scripts/run-rust-served-set.sh --list          print the set, one file per line, and exit
#   RUST_SERVED_SET_MANIFEST  the manifest (default: test/engine-parity/rust-served-set.tsv)
#   RUST_SERVED_SET_RUNNER    the command each file is passed to (default: bun test --timeout=120000)
#   RUST_SERVED_SET_JOBS      files run at once (default: 4)
#   RUST_SERVED_SET_LOG_DIR   per-file logs and summary.tsv (default: a new directory under ${TMPDIR:-/tmp})
#   RUST_SERVED_SET_TALLY     the Rust tally pins (default: test/engine-parity/rust-tally.tsv)
set -uo pipefail
MANIFEST="${RUST_SERVED_SET_MANIFEST:-test/engine-parity/rust-served-set.tsv}"
set_files() { awk -F'\t' '!/^#/ && $1 != "file" && $2 == "served" { print $1 }' "$MANIFEST"; }
if [ "${1:-}" = "--list" ]; then set_files; exit 0; fi
ROUTE="${1:?usage: run-rust-served-set.sh <env|config> | --list}"
case "$ROUTE" in env|config) ;; *) echo "::error::route must be env or config, not $ROUTE"; exit 2 ;; esac
RUNNER="${RUST_SERVED_SET_RUNNER:-bun test --timeout=120000}"
JOBS="${RUST_SERVED_SET_JOBS:-4}"
LOG_DIR="${RUST_SERVED_SET_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/gbrain-served-set.XXXXXX")}"
TALLY="${RUST_SERVED_SET_TALLY:-test/engine-parity/rust-tally.tsv}"
mkdir -p "$LOG_DIR"
: > "$LOG_DIR/summary.tsv"
export GBRAIN_TEST_RUST_ARM=1 GBRAIN_TEST_RUST_SERVED=1 GBRAIN_TEST_RUST_MU_ARM="$ROUTE" RUNNER ROUTE LOG_DIR TALLY
# Prints `<tally> <detail>` for file $1 and its log $2: `none` (no pin row), `missing` (no served tally line), `worse`
# or `ok`. The detail is the served counts and the pin, for the error line.
tally_of() {
  local pin
  pin=$(awk -F'\t' -v f="$1" 'NR > 1 && $1 == f { print $2 " " $3; exit }' "$TALLY")
  if [ -z "$pin" ]; then echo none; return; fi
  awk -v p="[rust-mu-$ROUTE arm] $1: " -v pin="$pin" '
    index($0, p) == 1 {
      rest = substr($0, length(p) + 1); n = split(rest, w, " ")
      if (w[2] == "equal" && w[3] == "to" && w[4] == "PGLite," && w[6] == "stopped") { found = 1; eq = w[1] + 0; st = w[5] + 0 }
      else if (w[2] == "known" || (w[2] == "case(s)" && w[3] == "pinned")) gaps += w[1]
    }
    END {
      split(pin, q, " ")
      if (!found) { print "missing"; exit }
      verdict = (eq + gaps < q[1] + 0 || st > q[2] + 0) ? "worse" : "ok"
      printf "%s %d equal and %d stopped (%d held as known gaps or pinned stops), but the pin is %d equal and %d stopped\n", verdict, eq, st, gaps, q[1], q[2]
    }' "$2"
}
export -f tally_of
run_one() {
  local f="$1" name rc mode=yes
  name=$(printf '%s' "$f" | tr '/' '_')
  if [ ! -f "$f" ]; then printf '%s\tmissing\t-\n' "$f" >> "$LOG_DIR/summary.tsv"; return; fi
  # shellcheck disable=SC2086
  env -u DATABASE_URL $RUNNER "$f" > "$LOG_DIR/$name.log" 2>&1; rc=$?
  grep -q "^\[rust-mu-$ROUTE arm\]" "$LOG_DIR/$name.log" || mode=no
  read -r tally detail < <(tally_of "$f" "$LOG_DIR/$name.log")
  printf '%s\t%s\t%s\t%s\t%s\n' "$f" "$rc" "$mode" "$tally" "$detail" >> "$LOG_DIR/summary.tsv"
}
export -f run_one
set_files | xargs -P "$JOBS" -I{} bash -c 'run_one "$@"' _ {}
total=$(set_files | wc -l | tr -d ' ')
ran=$(awk -F'\t' '$2 != "missing"' "$LOG_DIR/summary.tsv" | wc -l | tr -d ' ')
red=0
if [ "$ran" -eq 0 ]; then echo "::error::the served set ran no file"; red=1; fi
while IFS=$'\t' read -r f rc mode tally detail; do
  if [ "$rc" = "missing" ]; then echo "::error file=$f::served-set file $f does not exist"; red=1
  elif [ "$rc" != "0" ]; then echo "::error file=$f::served-set file failed on the $ROUTE route: $f (exit $rc)"; red=1
  elif [ "$mode" != "yes" ]; then echo "::error file=$f::served-set file $f did not run in the rust-mu-$ROUTE arm"; red=1
  elif [ "$tally" = "missing" ]; then echo "::error file=$f::served-set file $f printed no tally line for the rust-mu-$ROUTE arm, so its pin in $TALLY was not checked"; red=1
  elif [ "$tally" = "worse" ]; then echo "::error file=$f::served-set file $f on the $ROUTE route: ${detail/but the pin is/but $TALLY pins}"; red=1
  fi
done < <(LC_ALL=C sort "$LOG_DIR/summary.tsv")
failed=$(awk -F'\t' '$2 != "0" || $3 != "yes" || $4 == "missing" || $4 == "worse"' "$LOG_DIR/summary.tsv" | wc -l | tr -d ' ')
echo "served set, $ROUTE route: ran $ran of $total files, $failed red (logs: $LOG_DIR)"
exit "$red"
