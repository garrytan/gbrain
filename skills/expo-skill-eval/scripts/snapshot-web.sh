#!/usr/bin/env bash
# Run an Expo app's web target and capture a browser screenshot. (Phase 4 -
# only for eval cases whose runtime.platforms includes "web".)
#
# Usage: snapshot-web.sh <project-path> <output-png> [port] [settle-seconds]
#
# Starts Metro with `expo start --web`, waits for the dev server to respond,
# then screenshots with Playwright's CLI at an iPhone-ish viewport. The first
# run downloads Chromium via `bunx playwright install chromium`.
set -uo pipefail

PROJECT_PATH="${1:?usage: snapshot-web.sh <project-path> <output-png> [port] [settle-seconds]}"
OUT="${2:?usage: snapshot-web.sh <project-path> <output-png> [port] [settle-seconds]}"
PORT="${3:-8081}"
SETTLE="${4:-8}"
SERVER_TIMEOUT="${EXPO_SKILL_EVAL_BUNDLE_TIMEOUT:-240}"
LOG="${OUT%.png}.metro.log"

mkdir -p "$(dirname "$OUT")"

# Free the port up front in case a previous run (or a crash) left Metro on it,
# so `expo start` binds the port we expect instead of silently incrementing.
# Runs inside this script, so the eval harness never needs ad-hoc lsof/kill.
lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true

bunx playwright install chromium >/dev/null 2>&1 || true

(cd "$PROJECT_PATH" && exec env -u CI bunx expo start --port "$PORT" --web) </dev/null >"$LOG" 2>&1 &
METRO_PID=$!
cleanup() {
  kill "$METRO_PID" 2>/dev/null
  pkill -f "expo start --port $PORT" 2>/dev/null
  wait "$METRO_PID" 2>/dev/null
}
trap cleanup EXIT

DEADLINE=$((SECONDS + SERVER_TIMEOUT))
until curl -sf "http://localhost:$PORT" >/dev/null; do
  if ! kill -0 "$METRO_PID" 2>/dev/null || ((SECONDS > DEADLINE)); then
    echo "error: web dev server did not come up. Log tail:" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  sleep 2
done

STATUS=0
bunx playwright screenshot \
  --browser chromium \
  --viewport-size "390,844" \
  --wait-for-timeout "$((SETTLE * 1000))" \
  "http://localhost:$PORT" "$OUT" || STATUS=1

# Keep parity with the device snapshot scripts: cap the largest dimension so
# screenshots fit the eval viewer's window.
if [[ -f "$OUT" ]]; then
  sips -Z "${EXPO_SKILL_EVAL_MAX_DIM:-600}" "$OUT" >/dev/null 2>&1 || true
fi
echo "screenshot: $OUT"
echo "metro log: $LOG"
exit "$STATUS"
