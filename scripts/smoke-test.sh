#!/bin/bash
# smoke-test.sh - Cortex post-deploy smoke tests.
#
# Preferred hosted SaaS usage:
#   CORTEX_PUBLIC_URL=https://<tenant-host> \
#   CORTEX_ADMIN_BOOTSTRAP_TOKEN=<token> \
#   CORTEX_COMPOSIO_WEBHOOK_SECRET=<secret> \
#   CORTEX_BILLING_WEBHOOK_SECRET=<secret> \
#   bash scripts/smoke-test.sh
#
# Direct harness:
#   bun run smoke:saas-live -- --json
#
# Local operator fallback checks the Cortex CLI, database, worker, provider keys,
# and user-defined tests in ~/.cortex/smoke-tests.d/*.sh.

set -a
[ -f /data/.env ] && . /data/.env 2>/dev/null || true
set +a

LOG="${CORTEX_SMOKE_LOG:-/tmp/cortex-smoke-test.log}"
FAILURES=0
FIXES=0
TOTAL=0
SKIPPED=0

timestamp() { date -u '+%Y-%m-%d %H:%M:%S'; }
pass()    { TOTAL=$((TOTAL + 1)); echo "PASS $1"; echo "$(timestamp) PASS: $1" >> "$LOG"; }
fail()    { TOTAL=$((TOTAL + 1)); FAILURES=$((FAILURES + 1)); echo "FAIL $1"; echo "$(timestamp) FAIL: $1" >> "$LOG"; }
fixed()   { FIXES=$((FIXES + 1)); echo "FIXED $1"; echo "$(timestamp) FIXED: $1" >> "$LOG"; }
skip()    { SKIPPED=$((SKIPPED + 1)); echo "SKIP $1"; echo "$(timestamp) SKIP: $1" >> "$LOG"; }

echo "$(timestamp) === Cortex Smoke Tests ===" >> "$LOG"
echo "Running Cortex smoke tests..."
echo ""

# Find bun.
BUN_PATH=""
for bp in \
  "/root/.bun/bin/bun" \
  "/data/.bun/bin/bun" \
  "$HOME/.bun/bin/bun" \
  "$(command -v bun 2>/dev/null)" \
  "$(command -v bun.exe 2>/dev/null)" \
  "/mnt/c/Users/${USER}/.bun/bin/bun.exe" \
  "/mnt/c/Users/itzOn/.bun/bin/bun.exe"; do
  [ -n "$bp" ] && [ -x "$bp" ] && BUN_PATH="$bp" && break
done

if [ -n "$BUN_PATH" ]; then
  export PATH="$(dirname "$BUN_PATH"):$PATH"
  pass "Bun runtime ($BUN_PATH)"
else
  curl -fsSL https://bun.sh/install | bash 2>/dev/null
  if [ -x "/root/.bun/bin/bun" ]; then
    BUN_PATH="/root/.bun/bin/bun"
    export PATH="/root/.bun/bin:$PATH"
    fixed "Bun runtime installed"
    pass "Bun runtime"
  else
    fail "Bun runtime - install failed"
  fi
fi

# Hosted SaaS is the production proof path. Delegate to the full harness when
# a public URL is present and this repo has the TypeScript smoke runner.
if [ -n "${CORTEX_PUBLIC_URL:-}" ] && [ -n "$BUN_PATH" ] && [ -f "$(dirname "$0")/saas-live-smoke.ts" ]; then
  echo ""
  echo "Detected CORTEX_PUBLIC_URL. Running hosted SaaS smoke..."
  "$BUN_PATH" run "$(dirname "$0")/saas-live-smoke.ts" --json
  exit $?
fi

# Resolve local Cortex workspace for operator fallback checks.
CORTEX_DIR=""
for candidate in \
  "${CORTEX_DIR_OVERRIDE:-}" \
  "/data/cortex" \
  "$(dirname "$0")/.." \
  "./node_modules/cortex-brain"; do
  [ -n "$candidate" ] && [ -f "$candidate/src/cli.ts" ] && CORTEX_DIR="$candidate" && break
done

DB_URL="${CORTEX_DATABASE_URL:-${DATABASE_URL:-}}"
[ -z "$DB_URL" ] && DB_URL=$(grep '^CORTEX_DATABASE_URL=' /data/.env 2>/dev/null | head -1 | cut -d= -f2-)
[ -z "$DB_URL" ] && DB_URL=$(grep '^DATABASE_URL=' /data/.env 2>/dev/null | head -1 | cut -d= -f2-)

if [ -n "$CORTEX_DIR" ] && [ -n "$BUN_PATH" ]; then
  if timeout 15 "$BUN_PATH" run "$CORTEX_DIR/src/cli.ts" --help >/dev/null 2>&1; then
    pass "Cortex CLI ($CORTEX_DIR)"
  else
    (cd "$CORTEX_DIR" && "$BUN_PATH" install --frozen-lockfile) >/dev/null 2>&1
    if timeout 15 "$BUN_PATH" run "$CORTEX_DIR/src/cli.ts" --help >/dev/null 2>&1; then
      fixed "Cortex dependencies reinstalled"
      pass "Cortex CLI (after dependency fix)"
    else
      fail "Cortex CLI - will not start"
    fi
  fi
else
  [ -z "$CORTEX_DIR" ] && fail "Cortex CLI - not found"
  [ -z "$BUN_PATH" ] && skip "Cortex CLI - bun not available"
fi

if [ -n "$DB_URL" ] && [ -n "$CORTEX_DIR" ] && [ -n "$BUN_PATH" ]; then
  DOCTOR_OUT=$(DATABASE_URL="$DB_URL" CORTEX_DATABASE_URL="$DB_URL" timeout 20 "$BUN_PATH" run "$CORTEX_DIR/src/cli.ts" doctor 2>&1)
  if echo "$DOCTOR_OUT" | grep -q "Health score\|brain_score\|Health Check"; then
    SCORE=$(echo "$DOCTOR_OUT" | grep -oE 'Health score: [0-9]+' | head -1 | awk '{print $3}')
    [ -z "$SCORE" ] && SCORE="?"
    pass "Cortex database (health score: $SCORE/100)"
  else
    fail "Cortex database - doctor returned no health data"
  fi
else
  [ -z "$DB_URL" ] && fail "Cortex database - no DATABASE_URL or CORTEX_DATABASE_URL"
  [ -z "$CORTEX_DIR" ] && skip "Cortex database - CLI not found"
fi

if [ -n "$CORTEX_DIR" ] && [ -n "$BUN_PATH" ] && [ -n "$DB_URL" ]; then
  if [ -f /tmp/cortex-worker.pid ] && kill -0 "$(cat /tmp/cortex-worker.pid)" 2>/dev/null; then
    pass "Cortex worker (PID: $(cat /tmp/cortex-worker.pid))"
  else
    DATABASE_URL="$DB_URL" CORTEX_DATABASE_URL="$DB_URL" CORTEX_ALLOW_SHELL_JOBS=1 \
      nohup "$BUN_PATH" run "$CORTEX_DIR/src/cli.ts" jobs work --concurrency 2 > /tmp/cortex-worker.log 2>&1 &
    echo $! > /tmp/cortex-worker.pid
    sleep 2
    if kill -0 "$(cat /tmp/cortex-worker.pid)" 2>/dev/null; then
      fixed "Cortex worker started"
      pass "Cortex worker (PID: $(cat /tmp/cortex-worker.pid))"
    else
      fail "Cortex worker - failed to start (check /tmp/cortex-worker.log)"
    fi
  fi
else
  skip "Cortex worker - prerequisites missing"
fi

EMBED_KEY="${ZEROENTROPY_API_KEY:-${OPENAI_API_KEY:-${VOYAGE_API_KEY:-}}}"
if [ -n "$EMBED_KEY" ]; then
  pass "Embedding API key set"
else
  fail "Embedding API key - set ZEROENTROPY_API_KEY, OPENAI_API_KEY, or VOYAGE_API_KEY"
fi

BRAIN_PATH="${CORTEX_BRAIN_PATH:-/data/brain}"
if [ -d "$BRAIN_PATH/.git" ]; then
  PAGE_COUNT=$(find "$BRAIN_PATH" -name "*.md" -not -path "*/.git/*" 2>/dev/null | wc -l)
  pass "Brain repository ($PAGE_COUNT pages at $BRAIN_PATH)"
elif [ -d "$BRAIN_PATH" ]; then
  pass "Brain directory exists ($BRAIN_PATH, not a git repo)"
else
  skip "Brain repository - $BRAIN_PATH not found"
fi

USER_TESTS_DIR="${HOME}/.cortex/smoke-tests.d"
if [ -d "$USER_TESTS_DIR" ]; then
  for test_script in "$USER_TESTS_DIR"/*.sh; do
    [ -f "$test_script" ] || continue
    TEST_NAME=$(basename "$test_script" .sh)
    echo "Running user test: $TEST_NAME"
    if bash "$test_script" 2>/dev/null; then
      pass "User: $TEST_NAME"
    else
      fail "User: $TEST_NAME"
    fi
  done
fi

echo ""
PASSED=$((TOTAL - FAILURES))
echo "Results: $PASSED/$TOTAL passed, $FIXES auto-fixed, $SKIPPED skipped"
if [ $FAILURES -gt 0 ]; then
  echo "$FAILURES failure(s) remain - manual intervention needed"
else
  echo "All smoke tests passed"
fi
echo "$(timestamp) Summary: $PASSED/$TOTAL passed, $FIXES fixed, $FAILURES failed, $SKIPPED skipped" >> "$LOG"

exit $FAILURES
