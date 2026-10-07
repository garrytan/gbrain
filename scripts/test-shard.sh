#!/usr/bin/env bash
# Partition unit test files into N shards and run one shard.
#
# Usage: scripts/test-shard.sh <shard-index> <total-shards>
#   shard-index: 1-based (1..N)
#   total-shards: positive integer
#
# Excluded from sharding:
#   - test/e2e/*           — need DATABASE_URL; run via bun run test:e2e
#   - *.serial.test.ts     — concurrency-unsafe (file-wide mock.module / env
#                            leaks); run via bun run test:serial on its
#                            own runner in CI. Including these here lets
#                            their mock.module() calls leak into the rest
#                            of the shard's bun process and silently break
#                            unrelated tests.
#
# *.slow.test.ts is deliberately INCLUDED here. CI's matrix is the only
# default place these run; the local fast loop (run-unit-shard.sh)
# excludes them. See CLAUDE.md "CI vs local: intentionally divergent file
# sets" for the rationale.
#
# Partition: weight-aware LPT bin-packing via scripts/sharding.ts. Reads
# per-file runtime weights from scripts/test-weights.json (mined from real
# CI logs by scripts/mine-shard-weights.ts). Files absent from the map
# fall back to the corpus median, so adding a new test file works
# immediately without regenerating weights — worst case it lands in the
# wrong shard until next regen, never silently dropped.
#
# Stable partitioning: same `(files, weights, N)` always produces the
# same assignment, so retries are reproducible. Files also run in the
# planned order (see the `./` prefix at the bun invocation below).

set -euo pipefail
unset SHARD # Routing belongs to this wrapper, never to nested test runners.

DRY_RUN_LIST=0
if [ "${1:-}" = "--dry-run-list" ]; then
  DRY_RUN_LIST=1
  shift
fi

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/test-shard.sh [--dry-run-list] <shard-index> <total-shards>" >&2
  exit 1
fi

SHARD_INDEX="$1"
TOTAL_SHARDS="$2"

if ! [[ "$SHARD_INDEX" =~ ^[0-9]+$ ]] || ! [[ "$TOTAL_SHARDS" =~ ^[0-9]+$ ]]; then
  echo "error: shard index and total must be positive integers" >&2
  exit 1
fi
if [ "$SHARD_INDEX" -lt 1 ] || [ "$SHARD_INDEX" -gt "$TOTAL_SHARDS" ]; then
  echo "error: shard index $SHARD_INDEX out of range 1..$TOTAL_SHARDS" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

. scripts/lib/test-env.sh
receipts_init unit

# Collect non-E2E, non-serial unit test files. Slow files INCLUDED — see
# header comment. Local run-unit-shard.sh excludes slow files (different
# policy by design).
#
# Heavy atoms ride dedicated CI jobs (see .github/workflows/test.yml) so no
# single file dominates a shard: entity-resolve-perf.slow.test.ts (~159s,
# non-subdivisible) and entity-card-perf → job slow-entity-resolve-perf;
# eval-brainbench-e2e (98s mined, 10% of the corpus weight) → job
# slow-brainbench-e2e. eval-longmemeval-e2e.slow.test.ts is back in the matrix
# (GBRA-47 E6): engine sharing cut it from ~200s to ~8s, under the ~40s
# keep-in-matrix bar.
# export-scale.slow.test.ts (571s at its 100,001-page master scale) rides the
# slow-entity-resolve-perf job, which sets GBRAIN_TEST_EXPORT_SCALE_PAGES per
# event. reconcile-crash-*.slow.test.ts (244s) is not duplicated here: the
# persistence-validation invariants job already runs it on PGLite for every
# event, before and after activation.
# evals/ is included: its *.test.ts files (eval-harness unit tests) were
# previously collected by NO runner — 45+ real tests never executed anywhere.
# Every collected evals file must be KEYLESS (no API keys, no network) —
# enforced by the allowlist guard in test/scripts/evals-collection.test.ts.
# The local fast loop (run-unit-shard.sh) stays test-only by design (see
# docs/TESTING.md "CI vs local: intentionally divergent file sets").
ALL_FILES=$(find test evals -name '*.test.ts' \
  -not -name '*.serial.test.ts' \
  -not -name 'entity-resolve-perf.slow.test.ts' \
  -not -name 'entity-card-perf.slow.test.ts' \
  -not -name 'eval-brainbench-e2e.slow.test.ts' \
  -not -name 'export-scale.slow.test.ts' \
  -not -name 'reconcile-crash-*.slow.test.ts' \
  -not -path 'test/e2e/*' | sort)

if [ -z "$ALL_FILES" ]; then
  echo "no test files found under test/" >&2
  exit 1
fi

# Delegate the LPT partition to scripts/sharding.ts. Stream the file list
# via stdin to keep argv small (676+ files would overflow argv in some
# shells / OSes).
SHARD_FILES=$(printf '%s\n' "$ALL_FILES" | bun run scripts/sharding.ts "$SHARD_INDEX" "$TOTAL_SHARDS")

if [ "$DRY_RUN_LIST" = "1" ]; then
  printf '%s' "$SHARD_FILES"
  [ -n "$SHARD_FILES" ] && echo ""  # trailing newline if non-empty
  exit 0
fi

# Snapshot fast-path (after the dry-run exit so list-only calls stay
# instant): ~370 PGLite-booting matrix files pay ~3.1s cold init each
# without it. The echo inside makes silent cold-init regressions visible
# in CI logs.
ensure_pglite_snapshot "test-shard"

ALL_COUNT=$(printf '%s\n' "$ALL_FILES" | grep -c '^' || true)
SHARD_COUNT=$(printf '%s\n' "$SHARD_FILES" | grep -c '^' || true)
# grep -c on empty input returns 0 even with trailing newline edge cases
[ -z "$SHARD_FILES" ] && SHARD_COUNT=0

echo "shard $SHARD_INDEX/$TOTAL_SHARDS: ${SHARD_COUNT}/${ALL_COUNT} files (LPT-balanced)"

if [ "$SHARD_COUNT" -eq 0 ]; then
  echo "warning: shard $SHARD_INDEX has no files (total shards may exceed file count)" >&2
  receipt_empty "s${SHARD_INDEX}of${TOTAL_SHARDS}" "$SHARD_INDEX" "$TOTAL_SHARDS"
  exit 0
fi

# Convert newline-separated file list to argv. xargs handles the
# whitespace correctly without word-splitting on spaces in paths.
#
# COVERAGE_DIR (opt-in): when set, run under bun's lcov coverage into
# $COVERAGE_DIR/shard and write a lane manifest on success. xargs -x makes
# an argv overflow FAIL LOUD instead of silently batching into a second bun
# process — a second process reusing the same coverage dir OVERWRITES
# lcov.info, silently losing the first batch's line data. BSD xargs only
# accepts -x together with -n (GNU accepts both spellings), so we pass
# -n 100000: far beyond any real shard's file count, it keeps everything in
# ONE invocation while -x turns "args do not fit" into a hard error.
# merge-lcov.ts's lcovCount!=1 manifest tripwire is the second line of
# defense. When COVERAGE_DIR is empty/unset both arrays stay empty and the
# exec line is byte-identical to the pre-coverage behavior.
COVERAGE_ARGS=()
XARGS_FLAGS=()
if [ -n "${COVERAGE_DIR:-}" ]; then
  COVERAGE_ARGS=(--coverage --coverage-reporter=lcov --coverage-dir="$COVERAGE_DIR/shard")
  XARGS_FLAGS=(-n 100000 -x)
fi
# Receipts (X2): one JUnit report per bun process. A second xargs batch would
# overwrite it the same way it overwrites lcov.info, so receipts also force
# the single-invocation -x tripwire.
shard_file_args=()
while IFS= read -r f; do [ -n "$f" ] && shard_file_args+=("$f"); done <<< "$SHARD_FILES"
receipt_begin primary "s${SHARD_INDEX}of${TOTAL_SHARDS}" "$SHARD_INDEX" "$TOTAL_SHARDS" "" "${shard_file_args[@]}"
[ "${#RECEIPT_ARGS[@]}" -eq 0 ] || XARGS_FLAGS=(-n 100000 -x)
# --max-concurrency mirrors the local runner: unbounded intra-process
# concurrency under parallel PGLite boots produced real shard deaths (the
# 22-minute matrix timeout in test.yml records 13 of them).
#
# The `./` prefix makes each argument a path, not a name filter: Bun runs
# bare `test/x.test.ts` arguments in directory-scan order (filesystem
# dependent, so CI on ext4 and a Mac disagree), and explicit paths in the
# order given. Bun still reports them as `test/x.test.ts`, so the log and
# JUnit parsers see the same names.
rc=0
printf '%s\n' "$SHARD_FILES" | sed 's#^#./#' | xargs ${XARGS_FLAGS[@]+"${XARGS_FLAGS[@]}"} bun test --timeout=60000 --max-concurrency="${GBRAIN_TEST_MAX_CONCURRENCY:-4}" ${COVERAGE_ARGS[@]+"${COVERAGE_ARGS[@]}"} ${RECEIPT_ARGS[@]+"${RECEIPT_ARGS[@]}"} || rc=$?
receipt_end "$rc"

# Lane manifest: written ONLY on a fully green run (complete:true means the
# lcov data represents the whole shard). The real exit code is preserved
# either way. lcovCount != 1 downstream (merge-lcov.ts) means the xargs -x
# tripwire logic above was defeated somehow — merge marks the run degraded.
if [ -n "${COVERAGE_DIR:-}" ] && [ "$rc" -eq 0 ]; then
  LCOV_COUNT=$(find "$COVERAGE_DIR" -name 'lcov.info' 2>/dev/null | grep -c '^' || true)
  printf '{"lane":"shard-%s","sha":"%s","lcovCount":%s,"complete":true}\n' \
    "$SHARD_INDEX" "$(git rev-parse HEAD)" "${LCOV_COUNT:-0}" > "$COVERAGE_DIR/lane-manifest.json"
fi
exit "$rc"
