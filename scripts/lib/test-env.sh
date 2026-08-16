# scripts/lib/test-env.sh — shared helpers for the test-runner family
# (test-shard.sh, run-serial-tests.sh, run-slow-tests.sh, run-unit-parallel.sh,
# run-verify-parallel.sh). Source AFTER cd'ing to the repo root:
#
#   . scripts/lib/test-env.sh
#
# bash 3.2 compatible (macOS system bash): no mapfile, no wait -n, no ${var^^}.
# Every helper degrades gracefully inside the script-sandbox tests
# (test/scripts/run-unit-parallel.test.ts symlinks a minimal PATH with no
# sysctl/nproc/vm_stat/timeout and no package.json).

# ──────────────────────────────────────────────────────────────────────────
# CPU detection: Apple Silicon perf cores → Mac total physical → nproc → 4.
# Returns a single positive integer.
# ──────────────────────────────────────────────────────────────────────────
detect_cpus() {
  local n=""
  n=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null) && [ -n "$n" ] && [ "$n" -gt 0 ] && echo "$n" && return
  n=$(sysctl -n hw.physicalcpu 2>/dev/null) && [ -n "$n" ] && [ "$n" -gt 0 ] && echo "$n" && return
  n=$(nproc 2>/dev/null) && [ -n "$n" ] && [ "$n" -gt 0 ] && echo "$n" && return
  echo 4
}

# ──────────────────────────────────────────────────────────────────────────
# Available-memory detection (MB). macOS: vm_stat free + inactive +
# speculative + purgeable pages (inactive/purgeable are reclaimable on
# pressure, which is exactly the scenario we size for). Linux: MemAvailable.
# Unknown platform → 0, and the caller skips adaptation entirely.
# ──────────────────────────────────────────────────────────────────────────
detect_available_mem_mb() {
  if command -v vm_stat >/dev/null 2>&1; then
    vm_stat 2>/dev/null | awk '
      /page size of/ { psize = $8 }
      /Pages free/        { free = $NF }
      /Pages inactive/    { inactive = $NF }
      /Pages speculative/ { spec = $NF }
      /Pages purgeable/   { purge = $NF }
      END {
        gsub(/\./, "", free); gsub(/\./, "", inactive)
        gsub(/\./, "", spec); gsub(/\./, "", purge)
        if (psize == 0) psize = 16384
        printf "%d\n", (free + inactive + spec + purge) * psize / 1048576
      }'
    return
  fi
  if [ -r /proc/meminfo ]; then
    awk '/MemAvailable/ { printf "%d\n", $2 / 1024; found = 1 } END { if (!found) print 0 }' /proc/meminfo
    return
  fi
  echo 0
}

# ──────────────────────────────────────────────────────────────────────────
# PGLite schema snapshot: build (idempotent, ~40ms when fresh; mkdir-lock
# concurrency-safe; hash folds handler-migration source) and export
# GBRAIN_PGLITE_SNAPSHOT for child bun processes. 500+ test files each
# cold-boot PGLite + replay every migration without it (~3.5x per booting
# file — see docs/TESTING.md).
#
# No-op when GBRAIN_NO_SNAPSHOT=1 or when a parent runner already exported
# the path (double-building is harmless but noisy). Non-fatal on build
# failure — tests fall back to cold init. The one-line "active" echo makes
# a silent fall-back-to-cold-init regression visible in CI logs.
#   $1: label for log lines (defaults to test-env).
# ──────────────────────────────────────────────────────────────────────────
ensure_pglite_snapshot() {
  local label="${1:-test-env}"
  [ "${GBRAIN_NO_SNAPSHOT:-0}" = "1" ] && return 0
  if [ -n "${GBRAIN_PGLITE_SNAPSHOT:-}" ]; then
    echo "[$label] PGLite snapshot active (inherited): $GBRAIN_PGLITE_SNAPSHOT" >&2
    return 0
  fi
  if bun run build:pglite-snapshot >/dev/null 2>&1; then
    export GBRAIN_PGLITE_SNAPSHOT=test/fixtures/pglite-snapshot.tar
    echo "[$label] PGLite snapshot active: $GBRAIN_PGLITE_SNAPSHOT" >&2
  else
    echo "[$label] snapshot build failed (non-fatal) — tests run with cold init" >&2
  fi
}
