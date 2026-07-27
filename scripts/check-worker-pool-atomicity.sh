#!/usr/bin/env bash
# CI guard: protect the worker-pool atomicity invariant (v0.41.15.0, D5).
#
# `src/core/worker-pool.ts:runSlidingPool` rests on `const idx = nextIdx++`
# being atomic across N concurrent workers. Two failure modes silently
# break the invariant; this guard rejects both.
#
# FAILURE MODE 1: `worker_threads` import in any file that imports
# `runSlidingPool` or `runWithLimit`. Pool work crossing kernel threads
# loses the JS event-loop guarantee. Two workers could claim the same
# idx; silent duplicate work, duplicate DB writes. Same failure shape as
# the per-page lock in extract-conversation-facts exists to defend
# against, but the lock is defense-in-depth — atomicity is the primary
# correctness story.
#
# FAILURE MODE 2: An `await` between the read and write of `nextIdx` in
# `worker-pool.ts` itself. Pattern like `const idx = await getNextIdx()`
# introduces a yield window between read and write; another worker can
# run during the yield and claim the same idx.
#
# Usage: scripts/check-worker-pool-atomicity.sh
# Exit:  0 when invariants hold, 1 when a violation is found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

POOL_FILE="src/core/worker-pool.ts"

if [ ! -f "$POOL_FILE" ]; then
  echo "OK: $POOL_FILE not present yet — guard is no-op"
  exit 0
fi

# -----------------------------------------------------------------------
# FAILURE MODE 1: worker_threads alongside the helper.
# Find every src/ file that imports from the helper, then check whether
# any of them ALSO imports node:worker_threads / worker_threads.
# -----------------------------------------------------------------------

IMPORT_PATTERN="from ['\"][^'\"]*worker-pool[^'\"]*['\"]"
HELPER_CALLERS=$(grep -rlE "$IMPORT_PATTERN" src/ 2>/dev/null || true)

if [ -n "$HELPER_CALLERS" ]; then
  WORKER_THREADS_VIOLATIONS=""
  for caller in $HELPER_CALLERS; do
    if grep -E "from ['\"](node:)?worker_threads['\"]" "$caller" >/dev/null 2>&1; then
      WORKER_THREADS_VIOLATIONS="$WORKER_THREADS_VIOLATIONS$caller\n"
    fi
  done
  if [ -n "$WORKER_THREADS_VIOLATIONS" ]; then
    echo "ERROR: worker_threads imported in file(s) that also use runSlidingPool / runWithLimit:"
    # shellcheck disable=SC2059
    printf "$WORKER_THREADS_VIOLATIONS"
    echo
    echo "       The sliding pool's atomicity invariant relies on the single"
    echo "       JS event loop. worker_threads crosses kernel threads; two"
    echo "       workers can claim the same idx; duplicate work + DB writes."
    echo "       See src/core/worker-pool.ts header for the full invariant."
    exit 1
  fi
fi

# -----------------------------------------------------------------------
# FAILURE MODE 2: await between nextIdx read and write inside the helper.
# The legal forms are:
#     let nextIdx = 0;
#     const idx = nextIdx++;
# Anything matching `await.*nextIdx` or `nextIdx.*await` in the helper
# body indicates a yield window between read and write.
# -----------------------------------------------------------------------

# Strip multi-line comments + single-line comments before checking, so
# `await` mentions in documentation don't false-fire. The pool file's
# header explicitly mentions `await getNextIdx()` as the BAD pattern;
# without comment-stripping, this guard would always fail.
STRIPPED=$(sed -E '
  # Drop /** ... */ block comments (greedy single-line form only).
  /^\s*\/\*/,/\*\//d
  # Drop // line comments.
  s|//.*$||
' "$POOL_FILE")

if echo "$STRIPPED" | grep -E '(await\s+[a-zA-Z_$]*[Nn]ext[Ii]dx|nextIdx[^+]*await)' >/dev/null 2>&1; then
  echo "ERROR: found await near nextIdx in $POOL_FILE"
  echo "       The claim `const idx = nextIdx++` must remain a single"
  echo "       synchronous statement. Inserting an await between the read"
  echo "       and write breaks atomicity: another worker can run during"
  echo "       the yield window and claim the same idx."
  echo "       See src/core/worker-pool.ts header for the full invariant."
  exit 1
fi

echo "OK: worker-pool atomicity invariant intact"
