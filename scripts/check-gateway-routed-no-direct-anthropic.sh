#!/usr/bin/env bash
# CI guard: fail if gateway-routed source files reintroduce direct Anthropic
# SDK instantiation (`new Anthropic()` / `import Anthropic from '@anthropic-ai/sdk'`
# as a runtime constructor, NOT a type-only import).
#
# Why this exists: v0.35.5.0 migrated src/core/think/index.ts from `new Anthropic()`
# to a gateway.chat() adapter (closed #952). v0.41+ wave did the same for
# src/core/cycle/synthesize.ts (T5 in the community PR wave). Both files
# now route through src/core/ai/gateway.ts so any provider with a registered
# recipe (Anthropic, DeepSeek, OpenRouter, Voyage, Ollama, llama-server, ...)
# is reachable via `models.dream.synthesize_verdict` / chat model config.
#
# Without this guard, a future contributor adding `import Anthropic from
# '@anthropic-ai/sdk'` and `new Anthropic()` to either file silently re-opens
# the same provider-lock-in bug class. The symptom is "my DeepSeek config
# isn't being used by dream synthesize" — invisible until first user report.
#
# Mirrors the pattern of scripts/check-jsonb-pattern.sh.
#
# Usage: scripts/check-gateway-routed-no-direct-anthropic.sh
# Exit:  0 when clean, 1 when a guarded file imports the SDK as a runtime value.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Files whose contract is "ALL chat calls route through gateway.chat()".
# Extend this list when migrating another file off direct SDK construction.
GUARDED_FILES=(
  "src/core/cycle/synthesize.ts"
  "src/core/think/index.ts"
)

FAILED=0

for f in "${GUARDED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    # File was renamed or removed. Don't fail loud — flag and continue.
    echo "WARN: guarded file missing: $f (rename/remove? update GUARDED_FILES in $(basename "$0"))"
    continue
  fi

  # Match `new Anthropic(...)` — the runtime constructor call. Both `new Anthropic()`
  # and `new Anthropic({apiKey: '...'})` shapes are caught.
  # Exclude single-line `//` and block `*` comment lines so historical references
  # in JSDoc / explanatory comments don't false-fire. Code AND code-in-template
  # literals still hit (those don't start with `//` or ` *`).
  if grep -En 'new\s+Anthropic\s*\(' "$f" 2>/dev/null | grep -vE '^[0-9]+:\s*(//|\*)' | grep .; then
    echo
    echo "ERROR: $f reintroduced direct Anthropic SDK construction (\`new Anthropic()\`)."
    echo "       This file's contract is to route all chat calls through gateway.chat()."
    echo "       Use the adapter pattern from src/core/think/index.ts:tryBuildGatewayClient"
    echo "       or src/core/cycle/synthesize.ts:makeJudgeClient."
    FAILED=1
  fi

  # Match any value-shaped (NOT type-only) import of the SDK. The type-only forms
  # `import type Anthropic from '@anthropic-ai/sdk'` AND
  # `import { type Foo } from '@anthropic-ai/sdk'` (all-type-clauses-only) are allowed
  # for typing the adapter's Anthropic.Message return shape. Covers:
  #   import Anthropic from '@anthropic-ai/sdk'         (default)
  #   import { Anthropic } from '@anthropic-ai/sdk'     (named)
  #   import Anthropic, { Other } from '@anthropic-ai/sdk' (default + named)
  #   import { Anthropic as A } from '@anthropic-ai/sdk' (named-renamed)
  #   import { type Msg, Anthropic } from '@anthropic-ai/sdk' (mixed type + value)
  #   import * as Anthropic from '@anthropic-ai/sdk'    (namespace)
  # Strategy: catch every line ending in `from '@anthropic-ai/sdk'`, strip
  # comment lines, strip top-level `import type ...` (the only allowed shape),
  # then check whether any remaining line contains a value identifier OUTSIDE
  # type-prefixed clauses. We handle the mixed-import case by inspecting the
  # specifier list: if any specifier is not `type Foo`, the import is value-shaped.
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Strip the leading "line-number:" prefix grep adds.
    body="${line#*:}"
    # Top-level `import type ...` is allowed — entire import is type-only.
    if printf '%s' "$body" | grep -qE '^\s*import\s+type\s'; then continue; fi
    # Comment line.
    if printf '%s' "$body" | grep -qE '^\s*(//|\*)'; then continue; fi
    # Extract the specifiers list (between `import` and `from`), if present.
    # If the list contains any specifier NOT prefixed with `type ` (or there's
    # no brace list at all — default/namespace import), it's a value import.
    # POSIX character classes for cross-shell portability (macOS BSD sed
     # doesn't support `\s` even in extended-regex mode).
    specifiers=$(printf '%s' "$body" | sed -nE 's/^[[:space:]]*import[[:space:]]+\{([^}]*)\}[[:space:]]+from.*/\1/p')
    if [ -n "$specifiers" ]; then
      # Brace list present. Allow only if EVERY non-empty specifier is type-prefixed.
      # Use a temp file instead of `while | exit 1` (subshell trap).
      tmpflag=$(mktemp -t gateway-guard-XXXX)
      echo 0 > "$tmpflag"
      printf '%s' "$specifiers" | tr ',' '\n' | while IFS= read -r spec; do
        spec=$(printf '%s' "$spec" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
        [ -z "$spec" ] && continue
        if ! printf '%s' "$spec" | grep -qE '^type\s'; then echo 1 > "$tmpflag"; fi
      done
      has_value=$(cat "$tmpflag")
      rm -f "$tmpflag"
      if [ "$has_value" = "1" ]; then
        echo "$line"
        echo
        echo "ERROR: $f imports @anthropic-ai/sdk with a value-shaped specifier."
        echo "       Use \`import type ...\` for all clauses, or route runtime"
        echo "       chat calls through src/core/ai/gateway.ts."
        FAILED=1
      fi
    else
      # No brace list — default, namespace, or bare import — always value-shaped.
      echo "$line"
      echo
      echo "ERROR: $f imports @anthropic-ai/sdk as a runtime value."
      echo "       Use \`import type Anthropic from '@anthropic-ai/sdk'\` for type-only"
      echo "       references to Anthropic.Message / Anthropic.MessageCreateParamsNonStreaming."
      echo "       Route runtime chat calls through src/core/ai/gateway.ts."
      FAILED=1
    fi
  done < <(grep -En "from\s+['\"]@anthropic-ai/sdk['\"]" "$f" 2>/dev/null)
  # Dynamic import — also a value-shaped reference.
  if grep -En "import\s*\(\s*['\"]@anthropic-ai/sdk['\"]" "$f" 2>/dev/null \
     | grep -vE '^[0-9]+:\s*(//|\*)' | grep .; then
    echo
    echo "ERROR: $f dynamically imports @anthropic-ai/sdk."
    echo "       Route runtime chat calls through src/core/ai/gateway.ts."
    FAILED=1
  fi
done

if [ "$FAILED" -eq 1 ]; then
  exit 1
fi

echo "OK: gateway-routed files have no direct Anthropic SDK construction"
echo "    (guarded: ${GUARDED_FILES[*]})"
