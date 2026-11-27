#!/usr/bin/env bash
# The served Rust parity set gate (multi-user lane L3): runs exactly the `served` rows of
# test/engine-parity/rust-served-set.tsv on the Rust arm as a served client of a brain server (GBRAIN_TEST_RUST_SERVED=1,
# multi_writer on), with multi-user mode on through one route, one Bun process per file. Every file runs, whatever an
# earlier file did. The run is red when any file fails, when a file's output does not show the arm ran in that route
# (the `[rust-mu-<route> arm]` line: the mode was on and asserted), when a listed file does not exist, or when no file ran.
#
# Usage: scripts/run-rust-served-set.sh <env|config>
#        scripts/run-rust-served-set.sh --list          print the set, one file per line, and exit
#   RUST_SERVED_SET_MANIFEST  the manifest (default: test/engine-parity/rust-served-set.tsv)
#   RUST_SERVED_SET_RUNNER    the command each file is passed to (default: bun test --timeout=120000)
#   RUST_SERVED_SET_JOBS      files run at once (default: 4)
#   RUST_SERVED_SET_LOG_DIR   per-file logs and summary.tsv (default: a new directory under ${TMPDIR:-/tmp})
set -uo pipefail
MANIFEST="${RUST_SERVED_SET_MANIFEST:-test/engine-parity/rust-served-set.tsv}"
set_files() { awk -F'\t' '!/^#/ && $1 != "file" && $2 == "served" { print $1 }' "$MANIFEST"; }
if [ "${1:-}" = "--list" ]; then set_files; exit 0; fi
ROUTE="${1:?usage: run-rust-served-set.sh <env|config> | --list}"
case "$ROUTE" in env|config) ;; *) echo "::error::route must be env or config, not $ROUTE"; exit 2 ;; esac
RUNNER="${RUST_SERVED_SET_RUNNER:-bun test --timeout=120000}"
JOBS="${RUST_SERVED_SET_JOBS:-4}"
LOG_DIR="${RUST_SERVED_SET_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/gbrain-served-set.XXXXXX")}"
mkdir -p "$LOG_DIR"
: > "$LOG_DIR/summary.tsv"
export GBRAIN_TEST_RUST_ARM=1 GBRAIN_TEST_RUST_SERVED=1 GBRAIN_TEST_RUST_MU_ARM="$ROUTE" RUNNER ROUTE LOG_DIR
run_one() {
  local f="$1" name rc mode=yes
  name=$(printf '%s' "$f" | tr '/' '_')
  if [ ! -f "$f" ]; then printf '%s\tmissing\t-\n' "$f" >> "$LOG_DIR/summary.tsv"; return; fi
  # shellcheck disable=SC2086
  env -u DATABASE_URL $RUNNER "$f" > "$LOG_DIR/$name.log" 2>&1; rc=$?
  grep -q "^\[rust-mu-$ROUTE arm\]" "$LOG_DIR/$name.log" || mode=no
  printf '%s\t%s\t%s\n' "$f" "$rc" "$mode" >> "$LOG_DIR/summary.tsv"
}
export -f run_one
set_files | xargs -P "$JOBS" -I{} bash -c 'run_one "$@"' _ {}
total=$(set_files | wc -l | tr -d ' ')
ran=$(awk -F'\t' '$2 != "missing"' "$LOG_DIR/summary.tsv" | wc -l | tr -d ' ')
red=0
if [ "$ran" -eq 0 ]; then echo "::error::the served set ran no file"; red=1; fi
while IFS=$'\t' read -r f rc mode; do
  if [ "$rc" = "missing" ]; then echo "::error file=$f::served-set file $f does not exist"; red=1
  elif [ "$rc" != "0" ]; then echo "::error file=$f::served-set file failed on the $ROUTE route: $f (exit $rc)"; red=1
  elif [ "$mode" != "yes" ]; then echo "::error file=$f::served-set file $f did not run in the rust-mu-$ROUTE arm"; red=1
  fi
done < <(LC_ALL=C sort "$LOG_DIR/summary.tsv")
failed=$(awk -F'\t' '$2 != "0" || $3 != "yes"' "$LOG_DIR/summary.tsv" | wc -l | tr -d ' ')
echo "served set, $ROUTE route: ran $ran of $total files, $failed red (logs: $LOG_DIR)"
exit "$red"
