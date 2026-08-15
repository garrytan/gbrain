#!/usr/bin/env bash
# scripts/check-bootstrap-templates.sh — bootstrap template guard
# [D4, D5, A1 + privacy].
#
# Five independent sections, each SKIP-GRACEFUL (a section whose inputs don't
# exist yet prints SKIP and moves on, so CI stays green while the parallel
# bootstrap tasks land):
#
#   (a) Token↔bank bijection: every {{TOKEN}} across
#       templates/bootstrap/*.template must be a key of
#       templates/bootstrap/questions.json's `questions` object OR one of the
#       DERIVED_TOKENS exported by src/core/bootstrap/assets.ts (render-time
#       values, not interview keys). Unknown token = FAIL. A non-consent bank
#       key used by no template = WARN only (optional keys may render later).
#   (b) Placeholder-only assertion: no banned real-name/fork strings in the
#       template tree. The banned list is derived from scripts/check-privacy.sh
#       (BANNED_NAME + BANNED_PATHS) — check-privacy itself does not scan
#       templates/**, so this section closes that gap for the tree that ships
#       to every downstream install.
#   (c) Generator↔vendored byte-diff, OFFLINE [A1]: if the vendored template
#       repo tree (templates/bootstrap/template-repo/) exists, regenerate via
#       scripts/generate-template-repo.ts into a tmpdir and `diff -r`. The
#       release workflow publishes only what this diff proves the repo
#       reviewed. Skips while the render engine / vendored tree are absent.
#   (d) Phase-list check [D5]: every `Phase: <name>` in BOOTSTRAP_FOR_AGENTS.md
#       must appear in src/core/bootstrap/status.ts (the TS phase list is the
#       single source; the runbook defers to it). Skips while either is absent.
#   (e) Harness-scoping counter-signal pins: the MCP-scope consent is Claude
#       Code only (Codex has no scope flag — `codex mcp add` is user-global).
#       Tripwires against accidental deletion of the load-bearing prose, not
#       proofs of placement: the runbook must carry the Codex bullet's
#       "Do NOT offer an MCP scope choice" and the phase-3 "Claude Code only"
#       scoping; questions.json's MCP_SCOPE.question must START WITH
#       "(Claude Code only". Intentional rewording updates these pins in the
#       same commit. Skips while the runbook/bank are absent.
#
# BSD/GNU grep portable (no \t escapes). Uses `bun` for JSON parsing — the
# check runs via `bun run verify`, so bun is always present.
#
# Env overrides (for this guard's own test):
#   GBRAIN_BOOTSTRAP_GUARD_ROOT   repo root to scan (default: script's ../)
#
# Exit codes:
#   0   clean (or skipped)
#   1   violation
#   2   setup error (bun missing)

set -uo pipefail

ROOT="${GBRAIN_BOOTSTRAP_GUARD_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
TDIR="$ROOT/templates/bootstrap"
fail=0

if [ ! -d "$TDIR" ]; then
  echo "SKIP: templates/bootstrap/ absent — nothing to check yet"
  echo "check-bootstrap-templates: ok (skipped)"
  exit 0
fi

sorted_nonempty() { grep -v '^$' | LC_ALL=C sort -u; }

# ── (a) token ↔ question-bank bijection ─────────────────────────────────────
QUESTIONS="$TDIR/questions.json"
have_templates=0
ls "$TDIR"/*.template >/dev/null 2>&1 && have_templates=1

if [ "$have_templates" -eq 1 ] && [ -f "$QUESTIONS" ]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "ERROR: bun not on PATH — required to parse questions.json" >&2
    exit 2
  fi

  # NOTE: the eval must catch its own parse error and process.exit(3) —
  # an UNCAUGHT throw in `bun -e` does not reliably set a non-zero exit code.
  if ! bank_all=$(GBRAIN_QJSON="$QUESTIONS" bun -e \
    'const fs=require("fs");let b;try{b=JSON.parse(fs.readFileSync(process.env.GBRAIN_QJSON,"utf8"));}catch(e){console.error(String(e));process.exit(3);}console.log(Object.keys(b.questions||{}).join("\n"));' 2>&1); then
    fail=1
    echo "FAIL: could not parse $QUESTIONS as JSON:" >&2
    printf '%s\n' "$bank_all" | sed 's/^/      /' >&2
    bank_all=""
  fi
  consent_keys=$(GBRAIN_QJSON="$QUESTIONS" bun -e \
    'const fs=require("fs");let b;try{b=JSON.parse(fs.readFileSync(process.env.GBRAIN_QJSON,"utf8"));}catch(e){process.exit(3);}console.log((b.consentKeys||[]).join("\n"));' 2>/dev/null || true)

  # Derived (render-time) tokens: parse the DERIVED_TOKENS export from
  # assets.ts; fall back to the two known names if the module is absent.
  # Fallback list pinned to src/core/bootstrap/assets.ts — update BOTH places.
  ASSETS="$ROOT/src/core/bootstrap/assets.ts"
  derived=""
  if [ -f "$ASSETS" ]; then
    derived=$(sed -n '/DERIVED_TOKENS = \[/,/\] as const/p' "$ASSETS" \
      | grep -oE "'[A-Z][A-Z0-9_]*'" | tr -d "'" || true)
  fi
  if [ -z "$derived" ]; then
    derived=$'GITHUB_REPO_URL\nCORPUS_RETENTION_DAYS'
  fi

  tokens=$(grep -ohE '\{\{[A-Z][A-Z0-9_]*\}\}' "$TDIR"/*.template 2>/dev/null \
    | sed -E 's/[{}]//g' | sorted_nonempty || true)
  legal=$(printf '%s\n%s\n' "$bank_all" "$derived" | sorted_nonempty)

  if [ -n "$bank_all" ]; then
    unknown=$(comm -23 <(printf '%s\n' "$tokens" | sorted_nonempty) \
                       <(printf '%s\n' "$legal"))
    if [ -n "$unknown" ]; then
      fail=1
      echo "FAIL: template token(s) with no question-bank or DERIVED_TOKENS entry:" >&2
      printf '%s\n' "$unknown" | sed 's/^/        /' >&2
      echo "      Add the key to templates/bootstrap/questions.json, or to DERIVED_TOKENS" >&2
      echo "      in src/core/bootstrap/assets.ts if it is render-time-derived." >&2
    fi

    nonconsent=$(comm -23 <(printf '%s\n' "$bank_all" | sorted_nonempty) \
                          <(printf '%s\n' "$consent_keys" | sorted_nonempty))
    unused=$(comm -23 <(printf '%s\n' "$nonconsent") \
                      <(printf '%s\n' "$tokens" | sorted_nonempty))
    if [ -n "$unused" ]; then
      echo "WARN: non-consent question-bank key(s) used by no template (warn-only):" >&2
      printf '%s\n' "$unused" | sed 's/^/        /' >&2
    fi
  fi
else
  echo "SKIP: token↔bank bijection (templates: $have_templates, questions.json: $([ -f "$QUESTIONS" ] && echo present || echo absent))"
fi

# ── (b) placeholder-only assertion (privacy) ────────────────────────────────
# Banned terms come from scripts/check-privacy.sh so there is one source of
# truth; the fallback constructs the fork name at runtime because THIS file is
# itself scanned by check-privacy.sh and must not carry the literal.
PRIVACY_SH="$ROOT/scripts/check-privacy.sh"
banned_terms=""
if [ -f "$PRIVACY_SH" ]; then
  name=$(grep -E "^BANNED_NAME=" "$PRIVACY_SH" | head -1 | cut -d"'" -f2 || true)
  paths=$(sed -n '/^BANNED_PATHS=(/,/^)/p' "$PRIVACY_SH" | grep -oE "'[^']+'" | tr -d "'" || true)
  banned_terms=$(printf '%s\n%s\n' "$name" "$paths" | sorted_nonempty)
fi
if [ -z "$banned_terms" ]; then
  banned_terms=$(printf 'winter%s' 'mute')
fi
while IFS= read -r term; do
  [ -n "$term" ] || continue
  hits=$(grep -rilF "$term" "$TDIR" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    fail=1
    echo "FAIL: banned term found in the bootstrap template tree (privacy IRON RULE):" >&2
    printf '%s\n' "$hits" | sed 's/^/        /' >&2
    echo "      Templates ship with every release — rewrite with generic placeholders." >&2
  fi
done <<< "$banned_terms"

# ── (c) generator ↔ vendored tree byte-diff, offline [A1] ──────────────────
VENDORED="$TDIR/template-repo"
RENDER_TS="$ROOT/src/core/bootstrap/render.ts"
GEN="$ROOT/scripts/generate-template-repo.ts"
if [ ! -d "$VENDORED" ]; then
  echo "SKIP: vendored template-repo tree absent ($VENDORED) — byte-diff not applicable yet"
elif [ ! -f "$RENDER_TS" ]; then
  echo "SKIP: render engine absent ($RENDER_TS) — cannot regenerate for byte-diff yet"
elif [ ! -f "$GEN" ]; then
  echo "SKIP: generator script absent ($GEN) — cannot regenerate for byte-diff"
else
  TMP=$(mktemp -d /tmp/gbrain-template-diff-XXXXXX)
  trap 'rm -rf "$TMP"' EXIT
  gen_args=(--out "$TMP/tree")
  if [ -f "$ROOT/VERSION" ]; then
    gen_args+=(--version "$(tr -d '[:space:]' < "$ROOT/VERSION")")
  fi
  if ! bun run "$GEN" "${gen_args[@]}" > "$TMP/gen.log" 2>&1; then
    fail=1
    echo "FAIL: template-repo generator failed:" >&2
    tail -20 "$TMP/gen.log" | sed 's/^/        /' >&2
  elif ! diff -r "$TMP/tree" "$VENDORED" > "$TMP/diff.txt" 2>&1; then
    fail=1
    echo "FAIL: generator output differs from the vendored tree (templates/bootstrap/template-repo/)." >&2
    echo "      The release workflow publishes only what this diff proves the repo reviewed." >&2
    echo "      Regenerate: bun run scripts/generate-template-repo.ts --out templates/bootstrap/template-repo" >&2
    head -20 "$TMP/diff.txt" | sed 's/^/        /' >&2
  fi
fi

# ── (d) runbook phase names ⊆ TS phase list [D5] ───────────────────────────
RUNBOOK="$ROOT/BOOTSTRAP_FOR_AGENTS.md"
STATUS_TS="$ROOT/src/core/bootstrap/status.ts"
if [ -f "$RUNBOOK" ] && [ -f "$STATUS_TS" ]; then
  phases=$(grep -ohE 'Phase: [a-z0-9][a-z0-9_-]*' "$RUNBOOK" | sed 's/^Phase: //' | sorted_nonempty || true)
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if ! grep -qE "['\"]$p['\"]" "$STATUS_TS"; then
      fail=1
      echo "FAIL: runbook phase '$p' not found in src/core/bootstrap/status.ts (PHASES)." >&2
      echo "      The TS phase list is the single source [D5]; the runbook defers to it." >&2
    fi
  done <<< "$phases"
else
  echo "SKIP: phase-list check (runbook or src/core/bootstrap/status.ts absent)"
fi

# ── (e) harness-scoping counter-signal pins (MCP scope is Claude Code only) ─
if [ -f "$RUNBOOK" ]; then
  if ! grep -qF 'Do NOT offer an MCP scope choice' "$RUNBOOK"; then
    fail=1
    echo "FAIL: BOOTSTRAP_FOR_AGENTS.md lost the Codex counter-signal" >&2
    echo "      ('Do NOT offer an MCP scope choice'). Codex has no scope flag —" >&2
    echo "      without this line, Codex-door agents re-ask a dead question." >&2
    echo "      Rewording intentionally? Update this pin in the same commit." >&2
  fi
  if ! grep -qF 'Claude Code only' "$RUNBOOK"; then
    fail=1
    echo "FAIL: BOOTSTRAP_FOR_AGENTS.md lost the 'Claude Code only' scoping on the" >&2
    echo "      MCP-scope consent (phase 3). Without it the consent reads as" >&2
    echo "      harness-blind and Codex-door agents ask it." >&2
    echo "      Rewording intentionally? Update this pin in the same commit." >&2
  fi
else
  echo "SKIP: harness-scoping pins (runbook absent)"
fi
if [ -f "$QUESTIONS" ] && command -v bun >/dev/null 2>&1; then
  if ! GBRAIN_QJSON="$QUESTIONS" bun -e \
    'const fs=require("fs");let b;try{b=JSON.parse(fs.readFileSync(process.env.GBRAIN_QJSON,"utf8"));}catch(e){process.exit(1);}if(!b.questions){process.exit(1);}const e=b.questions.MCP_SCOPE;const q=(e&&e.question)||"";process.exit(q.startsWith("(Claude Code only")&&e.phase==="interview"?0:1);'; then
    fail=1
    echo "FAIL: questions.json MCP_SCOPE.question must start with '(Claude Code only'" >&2
    echo "      AND MCP_SCOPE.phase must be 'interview' (the consent is recorded" >&2
    echo "      pre-confirm during the interview; a 'wire' phase re-creates the" >&2
    echo "      bank-vs-runbook contradiction). Also fails when the questions" >&2
    echo "      object or the MCP_SCOPE entry is missing, or questions.json fails" >&2
    echo "      to parse — a bank without them silently passes section (a) too." >&2
    echo "      Rewording intentionally? Update this pin in the same commit." >&2
  fi
else
  echo "SKIP: MCP_SCOPE bank pin (questions.json or bun absent)"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "check-bootstrap-templates: ok"
