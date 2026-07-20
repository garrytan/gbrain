#!/usr/bin/env bash
# Run an Expo app in Expo Go on an iOS simulator and capture a screenshot.
#
# Usage: snapshot-ios.sh <project-path> <output-png> [port] [settle-seconds]
#
# Env: EXPO_SKILL_EVAL_RUNNER = expo-go (default) | dev-build — dev-build runs the
#   app via `expo run:ios` (native dev-client compile, slow) instead of Expo Go.
#
# Boots the newest available iPhone simulator if none is booted, starts
# Metro with `expo start --ios` (auto-installs Expo Go on the simulator and
# opens the app), waits for the bundle to load, settles, screenshots, and
# tears Metro down. The Metro log is saved next to the screenshot as
# <name>.metro.log. On bundle failure it still captures a best-effort
# screenshot (the error screen is grading evidence) and exits 1.
set -uo pipefail

PROJECT_PATH="${1:?usage: snapshot-ios.sh <project-path> <output-png> [port] [settle-seconds]}"
OUT="${2:?usage: snapshot-ios.sh <project-path> <output-png> [port] [settle-seconds]}"
PORT="${3:-8081}"
SETTLE="${4:-8}"
RUNNER="${EXPO_SKILL_EVAL_RUNNER:-expo-go}"   # expo-go | dev-build
if [[ "$RUNNER" == "dev-build" ]]; then
  BUNDLE_TIMEOUT="${EXPO_SKILL_EVAL_BUNDLE_TIMEOUT:-900}"   # native compile is slow
else
  BUNDLE_TIMEOUT="${EXPO_SKILL_EVAL_BUNDLE_TIMEOUT:-240}"
fi
LOG="${OUT%.png}.metro.log"

mkdir -p "$(dirname "$OUT")"

# Free the port up front in case a previous run (or a crash) left Metro on it,
# so `expo start` binds the port we expect instead of silently incrementing.
# Runs inside this script, so the eval harness never needs ad-hoc lsof/kill.
lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true

if ! xcrun simctl list devices booted | grep -q '(Booted)'; then
  UDID="$(xcrun simctl list devices available | grep 'iPhone' | tail -1 | grep -oE '[0-9A-F-]{36}')"
  if [[ -z "$UDID" ]]; then
    echo "error: no available iPhone simulator found" >&2
    exit 1
  fi
  echo "booting simulator $UDID..." >&2
  xcrun simctl boot "$UDID"
  open -a Simulator
  xcrun simctl bootstatus "$UDID"
fi

# expo-go: --ios installs Expo Go when missing; its own open is unreliable if a
# previous experience is foregrounded, so we relaunch deterministically below.
# dev-build: expo run:ios prebuilds + native-compiles a dev client, installs and
# launches it on the simulator, and starts Metro — no Expo Go involved.
if [[ "$RUNNER" == "dev-build" ]]; then
  # Pass --port so Metro binds to $PORT and the health-check curl matches.
  (cd "$PROJECT_PATH" && exec env -u CI bunx expo run:ios --port "$PORT") </dev/null >"$LOG" 2>&1 &
else
  (cd "$PROJECT_PATH" && exec env -u CI REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 bunx expo start --port "$PORT" --ios) </dev/null >"$LOG" 2>&1 &
fi
METRO_PID=$!
cleanup() {
  kill "$METRO_PID" 2>/dev/null
  lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  wait "$METRO_PID" 2>/dev/null
}
trap cleanup EXIT

DEADLINE=$((SECONDS + BUNDLE_TIMEOUT))
STATUS=0

until curl -sf "http://localhost:$PORT/status" >/dev/null; do
  if ! kill -0 "$METRO_PID" 2>/dev/null || ((SECONDS > DEADLINE)); then
    echo "error: Metro did not come up. Log tail:" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  sleep 2
done
# Expo Go only: wait for Expo Go to install, then relaunch the experience
# deterministically. dev-build skips this — expo run:ios launches the dev client.
if [[ "$RUNNER" != "dev-build" ]]; then
  until xcrun simctl get_app_container booted host.exp.Exponent >/dev/null 2>&1; do
    if ((SECONDS > DEADLINE)); then
      echo "error: Expo Go was not installed on the simulator. Log tail:" >&2
      tail -40 "$LOG" >&2
      exit 1
    fi
    sleep 2
  done
  # Terminate any running Expo Go so a stale experience can't stay foregrounded,
  # then open the project URL explicitly.
  xcrun simctl terminate booted host.exp.Exponent 2>/dev/null || true
  sleep 2
  xcrun simctl openurl booted "exp://127.0.0.1:$PORT"
fi

until grep -q 'Bundled' "$LOG"; do
  if ! kill -0 "$METRO_PID" 2>/dev/null; then
    echo "error: Metro exited before bundling. Log tail:" >&2
    tail -40 "$LOG" >&2
    STATUS=1
    break
  fi
  if ((SECONDS > DEADLINE)); then
    echo "error: timed out after ${BUNDLE_TIMEOUT}s waiting for bundle. Log tail:" >&2
    tail -40 "$LOG" >&2
    STATUS=1
    break
  fi
  sleep 2
done

# dev-build: after bundling, relaunch the app so it is reliably in the
# foreground. Use xcrun simctl launch (not openurl) to avoid the "Open in X?"
# confirmation dialog that xcrun simctl openurl triggers on the iOS Simulator.
# expo run:ios embeds the Metro URL in the build, so the dev client auto-connects.
if [[ "$RUNNER" == "dev-build" ]]; then
  BUNDLE_ID="$(node -e "try{var a=require('$PROJECT_PATH/app.json');console.log((a.expo&&a.expo.ios&&a.expo.ios.bundleIdentifier)||'com.exposkilleval.fixture')}catch(e){console.log('com.exposkilleval.fixture')}" 2>/dev/null || echo 'com.exposkilleval.fixture')"
  xcrun simctl terminate booted "$BUNDLE_ID" 2>/dev/null || true
  sleep 2
  xcrun simctl launch --terminate-running-process booted "$BUNDLE_ID" >/dev/null 2>&1 || true
  sleep 3
fi

sleep "$SETTLE"
xcrun simctl io booted screenshot "$OUT" || STATUS=1
# Raw simulator captures are 3x retina (~2600px tall) and overflow the eval
# viewer's window. Downscale to a review/grading-friendly size.
if [[ -f "$OUT" ]]; then
  sips -Z "${EXPO_SKILL_EVAL_MAX_DIM:-600}" "$OUT" >/dev/null 2>&1 || true
fi
echo "screenshot: $OUT"
echo "metro log: $LOG"
exit "$STATUS"
