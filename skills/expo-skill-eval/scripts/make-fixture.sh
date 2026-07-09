#!/usr/bin/env bash
# Create an Expo app fixture for an eval run.
#
# Usage: make-fixture.sh <project-path> [sdk-version] [variant]
#   project-path  Where the app should end up (must not exist yet)
#   sdk-version   Expo SDK major version, e.g. "56". Omit for the latest template.
#   variant       "clean" (default) runs the template's reset-project script so
#                 executors start from a blank app instead of the example
#                 screens. "full" keeps the example tabs (Home/Explore) - use
#                 it for evals whose prompt assumes an existing app.
#
# One pristine app is created per SDK version + variant with
# `bunx create-expo-app -t default@sdk-<version>` and cached under
# $EXPO_SKILL_EVAL_CACHE (default ~/.cache/expo-skill-eval/fixtures).
# Each call clones the cache with APFS copy-on-write, so only the first
# call per SDK version pays the install cost.
set -euo pipefail

PROJECT_PATH="${1:?usage: make-fixture.sh <project-path> [sdk-version] [variant]}"
SDK_VERSION="${2:-}"
VARIANT="${3:-clean}"
if [[ "$VARIANT" != "clean" && "$VARIANT" != "full" ]]; then
  echo "error: variant must be 'clean' or 'full', got '$VARIANT'" >&2
  exit 1
fi
CACHE_ROOT="${EXPO_SKILL_EVAL_CACHE:-$HOME/.cache/expo-skill-eval/fixtures}"

if [[ -e "$PROJECT_PATH" ]]; then
  echo "error: $PROJECT_PATH already exists" >&2
  exit 1
fi

TEMPLATE="default"
CACHE_KEY="latest"
if [[ -n "$SDK_VERSION" ]]; then
  TEMPLATE="default@sdk-${SDK_VERSION}"
  CACHE_KEY="sdk-${SDK_VERSION}"
fi
if [[ "$VARIANT" == "clean" ]]; then
  CACHE_KEY="${CACHE_KEY}-clean"
fi
CACHE_DIR="$CACHE_ROOT/$CACHE_KEY"

if [[ ! -d "$CACHE_DIR" ]]; then
  echo "building fixture cache for template '$TEMPLATE'..." >&2
  mkdir -p "$CACHE_ROOT"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  (cd "$TMP_DIR" && bunx create-expo-app --yes --template "$TEMPLATE" fixture) >&2
  if [[ "$VARIANT" == "clean" ]]; then
    # Strip the example screens so executors start from a blank app.
    # Answer "n" to the "move to /example?" prompt - delete them instead.
    (cd "$TMP_DIR/fixture" && echo n | bun run reset-project) >&2
  fi
  # Pin a stable iOS bundle identifier and Android package. The default template
  # leaves both unset, so a dev-build run (`expo run:ios`/`expo run:android`)
  # would prompt for them - which fails in the snapshot scripts' non-interactive
  # mode - and the snapshot scripts need a known id to relaunch the app by.
  (cd "$TMP_DIR/fixture" && bun -e '
    const f = "app.json";
    const j = await Bun.file(f).json();
    j.expo ??= {};
    j.expo.ios ??= {};
    j.expo.android ??= {};
    j.expo.ios.bundleIdentifier ??= "com.exposkilleval.fixture";
    j.expo.android.package ??= "com.exposkilleval.fixture";
    await Bun.write(f, JSON.stringify(j, null, 2) + "\n");
  ') >&2
  # The CLI normally generates expo-env.d.ts on first `expo start`; the static
  # gate runs tsc before any start, so create it up front (it provides the
  # CSS-module and Metro type declarations from expo/types).
  printf '/// <reference types="expo/types" />\n' >"$TMP_DIR/fixture/expo-env.d.ts"
  # expo-dev-client is required for dev-build snapshots: it registers the
  # expo-development-client URL scheme and enables custom Metro port connections
  # (expo run:ios/android --port N opens the app via a deep link that the dev
  # client handles). Without it, a custom port deep link may not open the app.
  (cd "$TMP_DIR/fixture" && bunx expo install expo-dev-client) >&2
  # First `expo lint` self-installs eslint + eslint-config-expo and writes
  # eslint.config.js if missing; it may exit non-zero on that bootstrap run.
  (cd "$TMP_DIR/fixture" && CI=1 bunx expo lint) >&2 || true
  printf '.eval-static/\n' >>"$TMP_DIR/fixture/.gitignore"
  mv "$TMP_DIR/fixture" "$CACHE_DIR"
fi

mkdir -p "$(dirname "$PROJECT_PATH")"
# -c uses APFS clonefile (instant, no extra disk); fall back to a plain copy.
cp -Rc "$CACHE_DIR" "$PROJECT_PATH" 2>/dev/null || cp -R "$CACHE_DIR" "$PROJECT_PATH"

# Fresh git history so `git diff` in the app shows exactly what the executor changed.
rm -rf "$PROJECT_PATH/.git"
git -C "$PROJECT_PATH" init -q
git -C "$PROJECT_PATH" add -A
git -C "$PROJECT_PATH" commit -qm "fixture: pristine $TEMPLATE template" --no-verify

echo "$PROJECT_PATH"
