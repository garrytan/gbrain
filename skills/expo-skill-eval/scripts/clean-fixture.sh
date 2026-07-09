#!/usr/bin/env bash
# Reclaim disk after a fixture's screenshots are captured. Essential for
# dev-build runs, where each `expo run:<platform>` leaves multi-GB native build
# output (iOS Pods + DerivedData, Android Gradle build). Removes the heavy,
# regenerable artifacts and keeps the app source + git history, so the grader's
# `git diff` still works.
#
# Usage: clean-fixture.sh <project-path>
#
# Env: EXPO_SKILL_EVAL_KEEP_DERIVEDDATA=1 skips the iOS DerivedData sweep (set it
#   only if you keep a real Xcode project literally named "fixture").
set -uo pipefail

APP="${1:?usage: clean-fixture.sh <project-path>}"

# Safety guard: only ever clean inside an expo-skill-eval workspace.
case "$APP" in
  *expo-skill-eval-*) : ;;
  *) echo "clean-fixture: refusing to clean '$APP' (not an expo-skill-eval fixture)" >&2; exit 1 ;;
esac
[[ -d "$APP" ]] || { echo "clean-fixture: $APP not found, skipping"; exit 0; }

# Stop any Metro / Expo dev server that may still be running for this fixture.
# The snapshot scripts' EXIT trap normally handles this, but cleaning up here
# catches leftover processes from crashes or interrupted runs.
# Ports 8081 (iOS) and 8082 (Android) are the two ports the eval harness
# reserves — freeing them here is safe because clean-fixture.sh only runs after
# all screenshots for this fixture have been captured.
#
# `-sTCP:LISTEN` is REQUIRED, not a refinement: without it, `lsof -ti tcp:8082`
# also matches the *established* connection the adb daemon holds from the
# `adb reverse tcp:8082` tunnel, and SIGKILLing the adb daemon crashes the
# emulator with a gfxstream gRPC SIGABRT (std::bad_function_call). Keep the flag
# so only the Metro listener is killed.
lsof -ti tcp:8081 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti tcp:8082 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true

# Per-fixture heavy dirs — all gitignored / regenerable (node_modules, the
# prebuilt native projects incl. iOS Pods and Android Gradle output, caches).
rm -rf \
  "$APP/node_modules" \
  "$APP/ios" \
  "$APP/android" \
  "$APP/.expo" \
  "$APP/dist" \
  "$APP/web-build" 2>/dev/null || true

# iOS DerivedData for fixture builds. create-expo-app names the project
# "fixture", so its build output lives under DerivedData/fixture-<hash>. This is
# a cache (worst case a rebuild), so it's safe to drop between fixtures.
if [[ "${EXPO_SKILL_EVAL_KEEP_DERIVEDDATA:-0}" != "1" ]]; then
  DD="$HOME/Library/Developer/Xcode/DerivedData"
  [[ -d "$DD" ]] && rm -rf "$DD"/fixture-* 2>/dev/null || true
fi

echo "cleaned fixture: $APP"
