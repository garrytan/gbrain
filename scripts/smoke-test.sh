#!/bin/bash
# smoke-test.sh — GBrain post-restart smoke tests + auto-fix
#
# Ships with gbrain. Tests gbrain core services + OpenClaw plugin health.
# Users extend via ~/.gbrain/smoke-tests.d/*.sh (user-defined tests).
#
# Usage:
#   gbrain smoke-test          # run all tests
#   bash scripts/smoke-test.sh # direct invocation
#
# Each test: check → if broken, attempt fix → re-check → report.
# Exit code = number of remaining failures (0 = all pass).

set -a
[ -f /data/.env ] && . /data/.env 2>/dev/null || true
set +a

LOG="${GBRAIN_SMOKE_LOG:-/tmp/gbrain-smoke-test.log}"
FAILURES=0
FIXES=0
TOTAL=0
SKIPPED=0

timestamp() { date -u '+%Y-%m-%d %H:%M:%S'; }
pass()    { TOTAL=$((TOTAL + 1)); echo "✅ $1"; echo "$(timestamp) PASS: $1" >> "$LOG"; }
fail()    { TOTAL=$((TOTAL + 1)); FAILURES=$((FAILURES + 1)); echo "❌ $1"; echo "$(timestamp) FAIL: $1" >> "$LOG"; }
fixed()   { FIXES=$((FIXES + 1)); echo "🔧 Fixed: $1"; echo "$(timestamp) FIXED: $1" >> "$LOG"; }
skip()    { SKIPPED=$((SKIPPED + 1)); echo "⏭️  $1"; echo "$(timestamp) SKIP: $1" >> "$LOG"; }

echo "$(timestamp) === GBrain Smoke Tests ===" >> "$LOG"
echo "🧪 Running gbrain smoke tests..."
echo ""

# ── Resolve paths ───────────────────────────────────────────
# Find gbrain — could be global install, workspace dep, or /data/gbrain
GBRAIN_DIR=""
for candidate in \
  "${GBRAIN_DIR_OVERRIDE:-}" \
  "/data/gbrain" \
  "$(dirname "$0")/.." \
  "${OPENCLAW_WORKSPACE:-/data/.openclaw/workspace}/node_modules/gbrain" \
  "./node_modules/gbrain"; do
  [ -n "$candidate" ] && [ -f "$candidate/src/cli.ts" ] && GBRAIN_DIR="$candidate" && break
done

# Find bun
BUN_PATH=""
for bp in "/root/.bun/bin/bun" "/data/.bun/bin/bun" "$(which bun 2>/dev/null)"; do
  [ -n "$bp" ] && [ -x "$bp" ] && BUN_PATH="$bp" && break
done

# Resolve database URL
DB_URL="${GBRAIN_DATABASE_URL:-${DATABASE_URL:-}}"
# Fallback: grep from .env (handles files with parse-breaking lines)
[ -z "$DB_URL" ] && DB_URL=$(grep '^GBRAIN_DATABASE_URL=' /data/.env 2>/dev/null | head -1 | cut -d= -f2-)
[ -z "$DB_URL" ] && DB_URL=$(grep '^DATABASE_URL=' /data/.env 2>/dev/null | head -1 | cut -d= -f2-)

# ── 1. Bun runtime ─────────────────────────────────────────
if [ -n "$BUN_PATH" ]; then
  export PATH="$(dirname "$BUN_PATH"):$PATH"
  pass "Bun runtime ($BUN_PATH)"
else
  # Auto-fix: install bun
  curl -fsSL https://bun.sh/install | bash 2>/dev/null
  if [ -x "/root/.bun/bin/bun" ]; then
    BUN_PATH="/root/.bun/bin/bun"
    export PATH="/root/.bun/bin:$PATH"
    fixed "Bun runtime installed"
    pass "Bun runtime"
  else
    fail "Bun runtime — install failed"
  fi
fi

# ── 2. GBrain CLI loads ────────────────────────────────────
if [ -n "$GBRAIN_DIR" ] && [ -n "$BUN_PATH" ]; then
  if timeout 15 "$BUN_PATH" run "$GBRAIN_DIR/src/cli.ts" --help >/dev/null 2>&1; then
    pass "GBrain CLI ($GBRAIN_DIR)"
  else
    # Auto-fix: reinstall deps
    cd "$GBRAIN_DIR" && "$BUN_PATH" install --frozen-lockfile 2>/dev/null
    if timeout 15 "$BUN_PATH" run "$GBRAIN_DIR/src/cli.ts" --help >/dev/null 2>&1; then
      fixed "GBrain deps reinstalled"
      pass "GBrain CLI (after dep fix)"
    else
      fail "GBrain CLI — won't start"
    fi
  fi
else
  [ -z "$GBRAIN_DIR" ] && fail "GBrain CLI — not found"
  [ -z "$BUN_PATH" ] && skip "GBrain CLI — bun not available"
fi

# ── 3. GBrain database ────────────────────────────────────
if [ -n "$DB_URL" ] && [ -n "$GBRAIN_DIR" ] && [ -n "$BUN_PATH" ]; then
  DOCTOR_OUT=$(DATABASE_URL="$DB_URL" GBRAIN_DATABASE_URL="$DB_URL" timeout 20 "$BUN_PATH" run "$GBRAIN_DIR/src/cli.ts" doctor 2>&1)
  if echo "$DOCTOR_OUT" | grep -q "Health score\|brain_score\|Health Check"; then
    SCORE=$(echo "$DOCTOR_OUT" | grep -oP 'Health score: \K[0-9]+' || echo '?')
    pass "GBrain database (health score: $SCORE/100)"
  else
    fail "GBrain database — doctor returned no health data"
  fi
else
  [ -z "$DB_URL" ] && fail "GBrain database — no DATABASE_URL or GBRAIN_DATABASE_URL"
  [ -z "$GBRAIN_DIR" ] && skip "GBrain database — gbrain not found"
fi

# ── 4. GBrain worker process ──────────────────────────────
if [ -n "$GBRAIN_DIR" ] && [ -n "$BUN_PATH" ] && [ -n "$DB_URL" ]; then
  if [ -f /tmp/gbrain-worker.pid ] && kill -0 "$(cat /tmp/gbrain-worker.pid)" 2>/dev/null; then
    pass "GBrain worker (PID: $(cat /tmp/gbrain-worker.pid))"
  else
    # Auto-fix: start worker
    DATABASE_URL="$DB_URL" GBRAIN_DATABASE_URL="$DB_URL" GBRAIN_ALLOW_SHELL_JOBS=1 \
      nohup "$BUN_PATH" run "$GBRAIN_DIR/src/cli.ts" jobs work --concurrency 2 > /tmp/gbrain-worker.log 2>&1 &
    echo $! > /tmp/gbrain-worker.pid
    sleep 2
    if kill -0 "$(cat /tmp/gbrain-worker.pid)" 2>/dev/null; then
      fixed "GBrain worker started"
      pass "GBrain worker (PID: $(cat /tmp/gbrain-worker.pid))"
    else
      fail "GBrain worker — failed to start (check /tmp/gbrain-worker.log)"
    fi
  fi
else
  skip "GBrain worker — prerequisites missing"
fi

# ── 5. OpenClaw plugin health (if OpenClaw is installed) ──
OPENCLAW_CODEX_ZOD="/app/node_modules/openclaw/dist/extensions/codex/node_modules/zod"
if [ -d "$OPENCLAW_CODEX_ZOD" ]; then
  CORE_CJS="$OPENCLAW_CODEX_ZOD/v4/core/core.cjs"
  if [ -f "$CORE_CJS" ] && node -e "require('$OPENCLAW_CODEX_ZOD/v4/core/index.cjs')" 2>/dev/null; then
    pass "OpenClaw Codex plugin (Zod CJS)"
  else
    # Auto-fix: reinstall zod
    cd "$OPENCLAW_CODEX_ZOD" && npm install zod@4 --force --silent 2>/dev/null
    if [ -f "$CORE_CJS" ] && node -e "require('$OPENCLAW_CODEX_ZOD/v4/core/index.cjs')" 2>/dev/null; then
      fixed "Codex Zod core.cjs reinstalled"
      pass "OpenClaw Codex plugin (Zod CJS after fix)"
    else
      fail "OpenClaw Codex plugin — Zod fix failed"
    fi
  fi
else
  skip "OpenClaw Codex plugin — not installed"
fi

# ── 6. OpenClaw gateway (if running) ─────────────────────
OPENCLAW_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
if curl -sf "http://127.0.0.1:$OPENCLAW_PORT/" >/dev/null 2>&1; then
  pass "OpenClaw gateway (port $OPENCLAW_PORT)"
else
  skip "OpenClaw gateway — not responding (may not be running yet)"
fi

# ── 7. Embedding API key ─────────────────────────────────
EMBED_KEY="${OPENAI_API_KEY:-${VOYAGE_API_KEY:-}}"
if [ -n "$EMBED_KEY" ]; then
  pass "Embedding API key set"
else
  fail "Embedding API key — neither OPENAI_API_KEY nor VOYAGE_API_KEY is set"
fi

# ── 8. Brain repo (if configured) ────────────────────────
BRAIN_PATH="${GBRAIN_BRAIN_PATH:-/data/brain}"
if [ -d "$BRAIN_PATH/.git" ]; then
  PAGE_COUNT=$(find "$BRAIN_PATH" -name "*.md" -not -path "*/.git/*" 2>/dev/null | wc -l)
  pass "Brain repo ($PAGE_COUNT pages at $BRAIN_PATH)"
elif [ -d "$BRAIN_PATH" ]; then
  pass "Brain directory exists ($BRAIN_PATH, not a git repo)"
else
  skip "Brain repo — $BRAIN_PATH not found"
fi

# ── User-defined tests (~/.gbrain/smoke-tests.d/*.sh) ────
USER_TESTS_DIR="${HOME}/.gbrain/smoke-tests.d"
if [ -d "$USER_TESTS_DIR" ]; then
  for test_script in "$USER_TESTS_DIR"/*.sh; do
    [ -f "$test_script" ] || continue
    TEST_NAME=$(basename "$test_script" .sh)
    echo "  Running user test: $TEST_NAME"
    if bash "$test_script" 2>/dev/null; then
      pass "User: $TEST_NAME"
    else
      fail "User: $TEST_NAME"
    fi
  done
fi

# ── Summary ─────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
PASSED=$((TOTAL - FAILURES))
echo "Results: $PASSED/$TOTAL passed, $FIXES auto-fixed, $SKIPPED skipped"
if [ $FAILURES -gt 0 ]; then
  echo "⚠️  $FAILURES failure(s) remain — manual intervention needed"
else
  echo "✅ All smoke tests passed"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "$(timestamp) Summary: $PASSED/$TOTAL passed, $FIXES fixed, $FAILURES failed, $SKIPPED skipped" >> "$LOG"

exit $FAILURES
