#!/usr/bin/env bash
# scripts/check-bootstrap-tag.sh — sanctioned-distribution-ref guard [C1 = D6-A].
#
# The agent-bootstrap distribution contract (docs/designs/AGENT_BOOTSTRAP_PLAN.md,
# "Release mechanics") is a SINGLE maintainer-controlled ref: `latest-stable`,
# force-advanced by .github/workflows/release.yml only AFTER a release fully
# publishes (binaries + provenance). Paste blocks copied into the wild never
# rot and never point at an unreviewed branch head. This guard keeps the two
# public entry documents on that contract:
#
#   1. Every raw.githubusercontent.com/garrytan/gbrain/<ref>/<path> reference
#      in README.md and BOOTSTRAP_FOR_AGENTS.md uses <ref> = latest-stable.
#      Carve-out: <path> = INSTALL_FOR_AGENTS.md — that is the pre-bootstrap
#      OpenClaw/Hermes headline install path with its own (master) contract,
#      outside the bootstrap ref rule.
#   2. Every explicit `github:garrytan/gbrain#<ref>` install pin in those
#      files is #latest-stable — no v-prefixed pins, no branch refs
#      (master/main). The historical un-pinned `github:garrytan/gbrain`
#      quick-start form is tolerated (it predates bootstrap and is owned by
#      the README task).
#   3. BOOTSTRAP_FOR_AGENTS.md embeds `<!-- gbrain-runbook-stamp: X.Y.Z.W -->`
#      equal to the VERSION file — `bootstrap status` compares that stamp to
#      the installed binary (supply-chain skew check).
#
# SKIP-GRACEFUL: files that don't exist yet are skipped with a SKIP message
# (exit 0) so CI stays green until the bootstrap doors task lands.
#
# Modeled on scripts/check-key-files-current-state.sh. BSD/GNU grep portable
# (no \t escapes, no GNU-only flags).
#
# Env overrides (for this guard's own test):
#   GBRAIN_BOOTSTRAP_GUARD_ROOT   repo root to scan (default: script's ../)
#
# Exit codes:
#   0   clean (or everything skipped)
#   1   violation

set -uo pipefail

ROOT="${GBRAIN_BOOTSTRAP_GUARD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SANCTIONED='latest-stable'

# URL terminators: whitespace, ), <, >, ", ', backtick. Built by concatenation
# so the single quote and backtick stay literal.
RAW_URL_RE='raw\.githubusercontent\.com/garrytan/gbrain/[^/[:space:]]+/[^[:space:])<>"'\''`]*'
PIN_RE='github:garrytan/gbrain#[0-9A-Za-z._/-]+'

fail=0
checked=0

for rel in README.md BOOTSTRAP_FOR_AGENTS.md; do
  f="$ROOT/$rel"
  if [ ! -f "$f" ]; then
    echo "SKIP: $rel absent — nothing to check yet"
    continue
  fi
  checked=$((checked + 1))

  # ── Rule 1: raw fetch refs must pin the sanctioned ref ────────────────────
  raw_refs=$(grep -oE "$RAW_URL_RE" "$f" | LC_ALL=C sort -u || true)
  while IFS= read -r u; do
    [ -n "$u" ] || continue
    rest="${u#raw.githubusercontent.com/garrytan/gbrain/}"
    ref="${rest%%/*}"
    path="${rest#*/}"
    [ "$ref" = "$SANCTIONED" ] && continue
    [ "$path" = "INSTALL_FOR_AGENTS.md" ] && continue
    fail=1
    echo "FAIL: $rel references unsanctioned ref '$ref': $u" >&2
    echo "      Bootstrap fetch URLs must use the maintainer-controlled '$SANCTIONED' ref" >&2
    echo "      (no v-prefixed pins, no branch refs). See .github/workflows/release.yml." >&2
  done <<< "$raw_refs"

  # ── Rule 2: explicit install pins must be #latest-stable ─────────────────
  pins=$(grep -oE "$PIN_RE" "$f" | LC_ALL=C sort -u || true)
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    ref="${p#github:garrytan/gbrain#}"
    if [ "$ref" != "$SANCTIONED" ]; then
      fail=1
      echo "FAIL: $rel pins the install to '#$ref' ($p)." >&2
      echo "      The only sanctioned install pin is github:garrytan/gbrain#$SANCTIONED." >&2
    fi
  done <<< "$pins"
done

# ── Rule 3: runbook stamp equals VERSION ────────────────────────────────────
runbook="$ROOT/BOOTSTRAP_FOR_AGENTS.md"
if [ -f "$runbook" ]; then
  version_file="$ROOT/VERSION"
  if [ ! -f "$version_file" ]; then
    echo "SKIP: VERSION file absent — cannot check the runbook stamp"
  else
    version="$(tr -d '[:space:]' < "$version_file")"
    stamp="$(grep -oE '<!-- gbrain-runbook-stamp: [0-9A-Za-z.-]+ -->' "$runbook" \
      | head -1 \
      | sed -E 's/<!-- gbrain-runbook-stamp: (.+) -->/\1/')"
    if [ -z "$stamp" ]; then
      fail=1
      echo "FAIL: BOOTSTRAP_FOR_AGENTS.md is missing its '<!-- gbrain-runbook-stamp: X.Y.Z.W -->' line." >&2
      echo "      bootstrap status compares this stamp to the installed binary (skew check)." >&2
    elif [ "$stamp" != "$version" ]; then
      fail=1
      echo "FAIL: BOOTSTRAP_FOR_AGENTS.md stamp '$stamp' != VERSION '$version'." >&2
      echo "      Refresh the runbook stamp in the same commit as the VERSION bump." >&2
    fi
  fi
fi

# ── Rule 4: plugin marketplace refs pin a sanctioned ref ─────────────────────
# `codex plugin marketplace add garrytan/gbrain@<ref>` in docs must use the
# release channel (@latest-stable) or the slim dist branch (@codex-plugin).
# The @-less form (`plugin marketplace add garrytan/gbrain`) is deliberately
# OUT of scope: Claude Code marketplace adds have no ref pin syntax, so the
# Claude lane documents the bare form and installs the repo default branch —
# a recorded decision, not a gate hole. Codex docs headline the pinned form.
while IFS=: read -r file line match; do
  ref="${match##*@}"
  case "$ref" in
    latest-stable|codex-plugin) ;;
    *)
      fail=1
      echo "FAIL: $file:$line pins 'marketplace add garrytan/gbrain@$ref' — use @latest-stable or @codex-plugin." >&2
      ;;
  esac
done < <(grep -RInE 'plugin marketplace add garrytan/gbrain@[A-Za-z0-9._-]+' \
  "$ROOT/README.md" "$ROOT/BOOTSTRAP_FOR_AGENTS.md" "$ROOT/INSTALL_FOR_AGENTS.md" "$ROOT/docs" 2>/dev/null \
  | sed -E 's/^([^:]+):([0-9]+):.*(plugin marketplace add garrytan\/gbrain@[A-Za-z0-9._-]+).*/\1:\2:\3/' || true)

if [ "$fail" -ne 0 ]; then
  exit 1
fi
if [ "$checked" -eq 0 ]; then
  echo "check-bootstrap-tag: ok (no bootstrap entry docs present yet — all checks skipped)"
else
  echo "check-bootstrap-tag: ok ($checked doc(s) on the '$SANCTIONED' distribution ref)"
fi
