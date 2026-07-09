#!/usr/bin/env bash
# Run an Expo app in Expo Go on an Android emulator and capture a screenshot.
#
# Usage: snapshot-android.sh <project-path> <output-png> [port] [settle-seconds]
#
# Env: EXPO_SKILL_EVAL_RUNNER = expo-go (default) | dev-build — dev-build runs the
#   app via `expo run:android` (native dev-client compile, slow) instead of Expo Go.
#
# If no device is attached, boots the first available AVD and waits for it
# (the slow path - keep one emulator running across an eval session).
# Starts Metro with `expo start --android` (auto-installs Expo Go, sets up
# adb reverse, opens the app), waits for the bundle, settles, screenshots
# via screencap, and tears Metro down. The Metro log is saved next to the
# screenshot as <name>.metro.log. On bundle failure it still captures a
# best-effort screenshot and exits 1.
set -uo pipefail

PROJECT_PATH="${1:?usage: snapshot-android.sh <project-path> <output-png> [port] [settle-seconds]}"
OUT="${2:?usage: snapshot-android.sh <project-path> <output-png> [port] [settle-seconds]}"
PORT="${3:-8082}"
RUNNER="${EXPO_SKILL_EVAL_RUNNER:-expo-go}"   # expo-go | dev-build

# Step-level logging with timestamp. Every major phase emits a marker so a
# crash report can be correlated to "which step was running when it died."
log_step() { echo "[$(date '+%H:%M:%S')] [snapshot-android] STEP: $*" >&2; }

# Track the emulator qemu PID so liveness checks in wait loops can detect a
# mid-flight crash and emit a clear "emulator crashed at step X" message.
EMULATOR_PID=""

emulator_alive() {
  [[ -n "$EMULATOR_PID" ]] && kill -0 "$EMULATOR_PID" 2>/dev/null
}

log_step "start  runner=$RUNNER port=$PORT project=$PROJECT_PATH"

# GPU mode is fixed to host (Metal on Apple Silicon, hardware-accelerated). The
# env-var knob was removed on purpose. If host self-aborts the emulator on a
# given machine (qemu SIGABRT deep in gfxstream/Metal — possible on Apple Silicon
# under load), change this to "guest" and bump SETTLE to ~25 (software rendering
# paints slowly). Avoid swiftshader_indirect — it hangs at boot on arm64.
GPU_MODE="host"
log_step "gpu_mode=$GPU_MODE"

SETTLE="${4:-8}"

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

find_sdk_tool() {
  local tool="$1" subdir="$2"
  if command -v "$tool" >/dev/null; then
    command -v "$tool"
    return
  fi
  local sdk
  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    if [[ -n "$sdk" && -x "$sdk/$subdir/$tool" ]]; then
      echo "$sdk/$subdir/$tool"
      return
    fi
  done
  return 1
}

ADB="$(find_sdk_tool adb platform-tools)" || { echo "error: adb not found (set ANDROID_HOME)" >&2; exit 1; }

# Recycle a wedged emulator before the boot check. An "offline"/unresponsive
# emulator isn't in "device" state, so the check below would otherwise reuse it
# (and hang) or stack a second emulator beside it. Graceful console shutdown
# first; force-kill only the survivors, then reset adb to clear the stale entry —
# so the boot check sees a clean slate and cold-boots a fresh (swiftshader) one.
log_step "checking for wedged/offline emulators"
STALE="$("$ADB" devices | awk 'NR>1 && $1 ~ /^emulator-/ && $2!="device" {print $1}')"
if [[ -n "$STALE" ]]; then
  echo "recycling wedged emulator(s): $STALE" >&2
  for serial in $STALE; do
    "$ADB" -s "$serial" emu kill 2>/dev/null || true   # graceful: ask the console to quit
  done
  sleep 2
  # Still wedged after the graceful attempt? Force-kill the qemu process(es) and
  # reset the adb server to drop the stale "offline" entry. pkill is broad (all
  # qemu emulators), which is fine here: the eval harness runs a single emulator.
  if "$ADB" devices | awk 'NR>1 && $1 ~ /^emulator-/ && $2!="device"' | grep -q .; then
    pkill -9 -f qemu-system-aarch64 2>/dev/null || true
    "$ADB" kill-server 2>/dev/null || true
    "$ADB" start-server 2>/dev/null || true
    sleep 2
  fi
fi

# GPU mismatch: if an emulator is already running with a different GPU mode than
# the one we need, recycle it so the boot path cold-starts with the correct mode.
# gfxstream (host GPU) uses a gRPC channel that can crash on Metro teardown via
# a bad_function_call SIGABRT; guest GPU avoids this by keeping rendering in-guest.
CURRENT_GPU="$(ps aux | grep qemu-system-aarch64 | grep -v grep | grep -o -- '-gpu [a-z_]*' | awk '{print $2}' | head -1)"
log_step "current_gpu=${CURRENT_GPU:-none}  required=$GPU_MODE"
if [[ -n "$CURRENT_GPU" && "$CURRENT_GPU" != "$GPU_MODE" ]]; then
  echo "GPU mismatch: running=$CURRENT_GPU required=$GPU_MODE — recycling emulator" >&2
  "$ADB" emu kill 2>/dev/null || true
  sleep 2
  pkill -9 -f qemu-system-aarch64 2>/dev/null || true
  "$ADB" kill-server 2>/dev/null || true
  "$ADB" start-server 2>/dev/null || true
  sleep 2
fi

log_step "checking device availability"
if ! "$ADB" devices | awk 'NR>1 && $2=="device"' | grep -q .; then
  EMULATOR="$(find_sdk_tool emulator emulator)" || { echo "error: no device attached and emulator binary not found" >&2; exit 1; }
  AVD="$("$EMULATOR" -list-avds | head -1)"
  if [[ -z "$AVD" ]]; then
    echo "error: no AVDs configured" >&2
    exit 1
  fi
  # Reset adb server before cold-booting. A previously crashed emulator leaves
  # the server in a bad state (still trying to reconnect to dead ports 5554/5555),
  # which causes adb wait-for-device to hang indefinitely on the next boot.
  log_step "resetting adb server before cold boot"
  "$ADB" kill-server 2>/dev/null || true
  "$ADB" start-server 2>/dev/null || true
  sleep 1
  log_step "booting emulator avd=$AVD gpu=$GPU_MODE"
  # nohup + disown so the emulator outlives this script and is reused by later
  # eval runs. -no-snapshot forces a clean cold boot (no stale snapshot to replay)
  # and writes no multi-GB snapshot (disk is often tight).
  nohup "$EMULATOR" -avd "$AVD" -no-boot-anim \
    -gpu "$GPU_MODE" -no-snapshot </dev/null >/dev/null 2>&1 &
  disown
  EMULATOR_PID="$(pgrep -f "emulator.*-avd $AVD" | head -1)"
  log_step "emulator booted pid=${EMULATOR_PID:-unknown}"
  "$ADB" wait-for-device
  log_step "adb device appeared — waiting for full boot"
  until [[ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do
    if [[ -n "$EMULATOR_PID" ]] && ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
      echo "error: emulator pid=$EMULATOR_PID crashed during boot (check DiagnosticReports for qemu SIGABRT)" >&2
      exit 1
    fi
    sleep 2
  done
  log_step "emulator fully booted"
else
  EMULATOR_PID="$(pgrep -f qemu-system-aarch64 | head -1)"
  log_step "reusing running emulator pid=${EMULATOR_PID:-unknown}"
fi

# --android makes the CLI install Expo Go on the device when missing. Pin the
# packager hostname to 127.0.0.1 so every exp:// URL goes through the adb
# reverse tunnel - the default LAN-IP URL is often unreachable from the
# emulator (host firewall) and leaves a stuck experience in Expo Go's task
# stack that hijacks later deep links.
# dev-build: expo run:android prebuilds + native-compiles a dev client, installs
# and launches it, and starts Metro — no Expo Go involved.
if [[ "$RUNNER" == "dev-build" ]]; then
  log_step "starting expo run:android port=$PORT"
  # Pass --port so Metro binds to $PORT and the health-check curl matches.
  (cd "$PROJECT_PATH" && exec env -u CI REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 bunx expo run:android --port "$PORT") </dev/null >"$LOG" 2>&1 &
else
  log_step "starting expo start --android port=$PORT"
  (cd "$PROJECT_PATH" && exec env -u CI REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 bunx expo start --port "$PORT" --android) </dev/null >"$LOG" 2>&1 &
fi
METRO_PID=$!
# APP_PKG is set later (dev-build only) but must be in scope for cleanup.
APP_PKG=""
cleanup() {
  kill "$METRO_PID" 2>/dev/null
  lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
  wait "$METRO_PID" 2>/dev/null
}
trap cleanup EXIT
# Resolve the app package name up front so the cleanup trap has it even on
# early exit. app.json is a fixture source file always present before Metro starts.
if [[ "$RUNNER" == "dev-build" ]]; then
  APP_PKG="$(node -e "try{var a=require('$PROJECT_PATH/app.json');console.log((a.expo&&a.expo.android&&a.expo.android.package)||'com.exposkilleval.fixture')}catch(e){console.log('com.exposkilleval.fixture')}" 2>/dev/null || echo 'com.exposkilleval.fixture')"
  log_step "app package=$APP_PKG"
fi

DEADLINE=$((SECONDS + BUNDLE_TIMEOUT))
STATUS=0

log_step "waiting for Metro on port=$PORT"
until curl -sf "http://localhost:$PORT/status" >/dev/null; do
  if ! kill -0 "$METRO_PID" 2>/dev/null; then
    echo "error: Metro (pid=$METRO_PID) exited before coming up. Log tail:" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  if emulator_alive; then : ; elif [[ -n "$EMULATOR_PID" ]]; then
    echo "error: emulator pid=$EMULATOR_PID crashed while waiting for Metro" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  if ((SECONDS > DEADLINE)); then
    echo "error: timed out after ${BUNDLE_TIMEOUT}s waiting for Metro. Log tail:" >&2
    tail -40 "$LOG" >&2
    exit 1
  fi
  sleep 2
done
log_step "Metro is up"
# Expo Go only: wait for it to install (the CLI may still be installing it).
if [[ "$RUNNER" != "dev-build" ]]; then
  log_step "waiting for Expo Go install on device"
  until "$ADB" shell pm list packages 2>/dev/null | grep -q host.exp.exponent; do
    if ((SECONDS > DEADLINE)); then
      echo "error: Expo Go was not installed on the device. Log tail:" >&2
      tail -40 "$LOG" >&2
      exit 1
    fi
    sleep 2
  done
fi
# Both runners: route the bundle over the adb reverse tunnel.
log_step "setting up adb reverse tunnel port=$PORT"
"$ADB" reverse "tcp:$PORT" "tcp:$PORT"
if [[ "$RUNNER" == "dev-build" ]]; then
  # expo run:android launches the dev client BEFORE Metro is ready, so it shows
  # "Cannot connect to Expo CLI". Now that Metro + adb-reverse are both up,
  # force-restart via explicit MainActivity to avoid the "Open in X?" dialog
  # that an implicit VIEW intent triggers. expo run:android --port embeds the
  # Metro URL in the build, so the dev client auto-connects on relaunch.
  if [[ -n "$APP_PKG" ]]; then
    log_step "launching dev-build app pkg=$APP_PKG"
    "$ADB" shell am force-stop "$APP_PKG" 2>/dev/null || true
    sleep 2
    "$ADB" shell am start -W -n "${APP_PKG}/.MainActivity" >/dev/null 2>&1 || true
  fi
else
  log_step "launching Expo Go exp://127.0.0.1:$PORT"
  # Force-stop so a stale experience from a previous run can't be resumed, then
  # give the system a moment to finish task cleanup - launching immediately
  # after force-stop races it and the new activity gets torn down too.
  "$ADB" shell am force-stop host.exp.exponent
  sleep 2
  "$ADB" shell am start -W -a android.intent.action.VIEW -d "exp://127.0.0.1:$PORT" >/dev/null
fi

log_step "waiting for JS bundle"
until grep -q 'Bundled' "$LOG"; do
  if ! kill -0 "$METRO_PID" 2>/dev/null; then
    echo "error: Metro (pid=$METRO_PID) exited before bundling. Log tail:" >&2
    tail -40 "$LOG" >&2
    STATUS=1
    break
  fi
  if emulator_alive; then : ; elif [[ -n "$EMULATOR_PID" ]]; then
    echo "error: emulator pid=$EMULATOR_PID crashed while waiting for JS bundle" >&2
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

log_step "bundle done — settling ${SETTLE}s"
sleep "$SETTLE"
log_step "taking screenshot"
"$ADB" exec-out screencap -p >"$OUT" || STATUS=1
# Raw emulator captures are ~2800px tall and overflow the eval viewer's
# window. Downscale to a review/grading-friendly size.
if [[ -s "$OUT" ]]; then
  sips -Z "${EXPO_SKILL_EVAL_MAX_DIM:-600}" "$OUT" >/dev/null 2>&1 || true
fi
log_step "done  status=$STATUS  screenshot=$OUT"
echo "screenshot: $OUT"
echo "metro log: $LOG"
exit "$STATUS"
