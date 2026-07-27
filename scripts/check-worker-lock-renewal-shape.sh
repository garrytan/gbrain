#!/usr/bin/env bash
# v0.41.22.2 — CI guard against the v0.41.22.1 lock-renewal crash class.
#
# The bug pattern: `setInterval(async () => { await something() })` lets
# any throw inside the async callback propagate to Node's process-level
# `unhandledRejection` handler, which kills the worker with exit 1.
# Production lost ~39 worker processes/day to this exact shape when
# PgBouncer rotated connections during a renewLock call.
#
# This guard enforces two invariants on `src/core/minions/worker.ts`:
#
#   1. The BUG pattern is absent: no `setInterval(async ...)` literal.
#      A future refactor that inlines `setInterval(async () => { await
#      renewLock(...) })` again would re-introduce the v0.41.22.1
#      crash class via the exact original surface.
#
#   2. The GOOD pattern is present: launchJob calls `runLockRenewalTick`.
#      Without this call-site, the timer logic could be re-inlined via
#      a different shape AND bypass the first invariant. The
#      `runLockRenewalTick` extraction is also the only test seam that
#      gives the state machine behavioral coverage.
#
# Intentionally bug-pattern-specific, not implementation-specific: a
# future refactor to `setTimeout`-recursion or `AbortController`-based
# scheduling passes as long as the bug pattern stays absent (codex C12
# from the v0.41.22.2 outside-voice review).
#
# Usage: scripts/check-worker-lock-renewal-shape.sh
# Exit:  0 when shape is good, 1 when violations found.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Allow tests to override the target file for fixture-based meta-tests.
TARGET="${GBRAIN_LOCK_RENEWAL_SHAPE_TARGET:-src/core/minions/worker.ts}"

if [ ! -f "$TARGET" ]; then
  echo "ERROR: shape guard target file not found: $TARGET"
  exit 1
fi

# Invariant 1: the LOCK-RENEWAL site must not use the bug shape.
#
# The bug-class regex is `setInterval(...async...)`, but it appears
# legitimately elsewhere in worker.ts (the stall-detector loop at
# line ~269 uses it with try/catch — codex C13 covers re-entrancy
# guard for that path separately). To keep this guard from fighting
# unrelated decisions, we narrow scope to the renewal timer
# specifically by requiring the assignment shape `lockTimer = setInterval(`.
#
# A future refactor that renames `lockTimer` would slip past this
# guard; that's an accepted tradeoff (the variable name has been
# stable since v0.10 and is the load-bearing test seam for
# `launchJob`'s `inFlight` accounting).
#
# Uses POSIX ERE + [[:space:]] for BSD-grep portability (macOS shipping
# grep doesn't support -P / \s).
if grep -Eq 'lockTimer[[:space:]]*=[[:space:]]*setInterval\([[:space:]]*async' "$TARGET"; then
  echo "ERROR: $TARGET contains the v0.41.22.1 bug pattern (\`setInterval(async ...)\`)."
  echo
  echo "       Async timer callbacks let unhandledRejection escape to the"
  echo "       process-level handler and crash the worker daemon."
  echo
  echo "       Fix: wrap the timer callback synchronously around an IIFE that"
  echo "       routes through src/core/minions/lock-renewal-tick.ts:"
  echo
  echo "         setInterval(() => {"
  echo "           if (tickInFlight) return;"
  echo "           tickInFlight = true;"
  echo "           void runLockRenewalTick(deps, state)"
  echo "             .then(handleResult)"
  echo "             .catch(handlePostError)"
  echo "             .finally(() => { tickInFlight = false; });"
  echo "         }, lockDurationMs / 2);"
  exit 1
fi

# Invariant 2: good pattern present. launchJob must call
# `runLockRenewalTick` or the test seam is gone.
if ! grep -q 'runLockRenewalTick' "$TARGET"; then
  echo "ERROR: $TARGET does not call \`runLockRenewalTick\`."
  echo
  echo "       Lock-renewal logic must route through"
  echo "       src/core/minions/lock-renewal-tick.ts so the state-machine"
  echo "       behavior stays unit-testable (no PGLite needed, no"
  echo "       setInterval / process plumbing in tests). Re-introduce the"
  echo "       call site at launchJob's renewal timer."
  exit 1
fi

echo "lock-renewal shape OK ($TARGET)"
