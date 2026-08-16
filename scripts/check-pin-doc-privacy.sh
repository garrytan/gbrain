#!/usr/bin/env bash
# scripts/check-pin-doc-privacy.sh — PIN-doc privacy guard.
#
# The docs/mcp/*-CLI-PIN.md files carry VERBATIM observation transcripts from
# real installs (help output, saved configs, error copy). That verbatim
# discipline is the point — but it is also exactly how an operator path
# (/Users/<name>/…), a key fragment, or an account id ends up committed and
# shipped with every release. This guard asserts the placeholder discipline:
#
#   1. No operator home paths: /Users/<name>/ or /home/<name>/ must appear as
#      placeholders (<tmp>, $HOME, ~/) — never as a real username path.
#      Bare `~/.grok`-style spellings are fine (that IS the placeholder).
#   2. No key material: long high-entropy tokens with known prefixes
#      (sk-…, xai-…, gbrain_<64+hex-ish>, ANTHROPIC/OPENAI/XAI key shapes).
#      npm `sha512-…` integrity pins are EXPECTED content — excluded.
#   3. No obvious account ids: emails outside example.com/invalid domains.
#
# SKIP-GRACEFUL: no pin docs yet → SKIP (exit 0). Test override:
# GBRAIN_PIN_PRIVACY_GUARD_ROOT points file resolution at a fixture tree.
# BSD/GNU portable.

set -uo pipefail

ROOT="${GBRAIN_PIN_PRIVACY_GUARD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
shopt -s nullglob
PIN_DOCS=("$ROOT"/docs/mcp/*-CLI-PIN.md)
shopt -u nullglob

if [ "${#PIN_DOCS[@]}" -eq 0 ]; then
  echo "check-pin-doc-privacy: SKIP (no docs/mcp/*-CLI-PIN.md yet)"
  exit 0
fi

fail=0

for doc in "${PIN_DOCS[@]}"; do
  rel="${doc#"$ROOT"/}"

  # 1. Operator home paths (a real username after /Users/ or /home/).
  hits=$(grep -nE '(/Users|/home)/[A-Za-z][A-Za-z0-9._-]+/' "$doc" || true)
  if [ -n "$hits" ]; then
    fail=1
    echo "FAIL: $rel carries operator home path(s) — replace with <tmp>/\$HOME/~ placeholders:" >&2
    printf '%s\n' "$hits" | sed 's/^/        /' >&2
  fi

  # 2. Key material. sha512- npm integrity pins are expected; exclude lines
  #    carrying them before scanning for long secret-shaped runs.
  hits=$(grep -v 'sha512-' "$doc" | grep -nE '(sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|gbrain_[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16})' || true)
  if [ -n "$hits" ]; then
    fail=1
    echo "FAIL: $rel carries key-shaped material — redact before committing:" >&2
    printf '%s\n' "$hits" | sed 's/^/        /' >&2
  fi

  # 3. Emails outside the documentation-safe domains.
  hits=$(grep -nE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$doc" \
    | grep -vE '@(example\.(com|org|net)|[A-Za-z0-9.-]*invalid)' || true)
  if [ -n "$hits" ]; then
    fail=1
    echo "FAIL: $rel carries a non-placeholder email address:" >&2
    printf '%s\n' "$hits" | sed 's/^/        /' >&2
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "check-pin-doc-privacy: FAIL (pin docs ship with every release — placeholder discipline is the privacy IRON RULE)" >&2
  exit 1
fi
echo "check-pin-doc-privacy: ok (${#PIN_DOCS[@]} pin doc(s))"
