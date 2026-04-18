#!/usr/bin/env bash
# fix-v0.11.0.sh — stopgap for broken v0.11.0 installs where the Minions
# migration never fired on upgrade.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/garrytan/gbrain/v0.11.1/scripts/fix-v0.11.0.sh | bash
#
# What it does:
#   1. gbrain init --migrate-only — applies schema v7 without touching config.
#   2. gbrain jobs smoke — fails loudly if Minions isn't healthy.
#   3. Prompts for minion_mode (or defaults to pain_triggered on non-TTY).
#   4. Atomically writes ~/.gbrain/preferences.json (0o600).
#   5. Appends ~/.gbrain/migrations/completed.jsonl with status:"partial" and
#      apply_migrations_pending: true — the v0.11.1 `apply-migrations` runner
#      will pick up where we left off (host rewrites, autopilot install).
#   6. Detects host AGENTS.md / cron/jobs.json and PRINTS the rewrite guidance
#      as text. Never auto-edits host files from a curl-piped script — too
#      high blast-radius (user trust model is "I pasted this").
#   7. Final line: tells the user to run `gbrain autopilot --install` as the
#      one-stop finisher (autopilot forks the Minions worker as a child).
#
# Retires when v0.11.1 is out: the canonical fix becomes
#   gbrain upgrade && gbrain apply-migrations

set -euo pipefail

RED=$'\033[1;31m'
GREEN=$'\033[1;32m'
YELLOW=$'\033[1;33m'
NC=$'\033[0m'

say()  { printf "%s%s%s\n" "$1" "$2" "$NC"; }
info() { say "" "$1"; }
ok()   { say "$GREEN" "$1"; }
warn() { say "$YELLOW" "$1"; }
die()  { say "$RED" "$1"; exit 1; }

command -v gbrain >/dev/null 2>&1 || die "gbrain not found on \$PATH. Install it first (\`bun add -g gbrain\` or download a binary)."

GBRAIN_DIR="${HOME}/.gbrain"
PREFS_PATH="${GBRAIN_DIR}/preferences.json"
COMPLETED_PATH="${GBRAIN_DIR}/migrations/completed.jsonl"

mkdir -p "${GBRAIN_DIR}/migrations"

# ------------------------------------------------------------
# Step 1: schema
# ------------------------------------------------------------
info "[1/8] Applying schema (gbrain init --migrate-only)..."
if ! gbrain init --migrate-only; then
  die "Schema migration failed. Check ~/.gbrain/config.json has a valid database_url (or database_path for PGLite), then re-run."
fi
ok "      schema ok"

# ------------------------------------------------------------
# Step 2: smoke
# ------------------------------------------------------------
info "[2/8] Running Minions smoke test (gbrain jobs smoke)..."
if ! gbrain jobs smoke; then
  die "Smoke test failed. See the error above. Fix before continuing."
fi
ok "      smoke ok"

# ------------------------------------------------------------
# Step 3: mode prompt
# ------------------------------------------------------------
info "[3/8] Choose minion_mode..."
MODE="pain_triggered"
if [ -t 0 ] && [ -t 1 ]; then
  echo ""
  echo "  [1] always          — route every background task through Minions (most durable)"
  echo "  [2] pain_triggered  — default to native subagents, switch to Minions on pain signals (recommended)"
  echo "  [3] off             — disable Minions; keep native subagents"
  echo ""
  read -r -p "  Choice [2]: " CHOICE
  case "${CHOICE:-2}" in
    1) MODE="always" ;;
    3) MODE="off" ;;
    *) MODE="pain_triggered" ;;
  esac
else
  warn "      non-interactive shell → defaulting to pain_triggered (change later: \`gbrain config set minion_mode <mode>\`)"
fi
ok "      mode=${MODE}"

# ------------------------------------------------------------
# Step 4: atomic write preferences.json (0o600)
# ------------------------------------------------------------
info "[4/8] Writing ~/.gbrain/preferences.json..."
NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TMP_PREFS=$(mktemp)
cat > "${TMP_PREFS}" <<EOF
{
  "minion_mode": "${MODE}",
  "set_at": "${NOW_ISO}",
  "set_in_version": "0.11.0"
}
EOF
chmod 600 "${TMP_PREFS}"
mv "${TMP_PREFS}" "${PREFS_PATH}"
chmod 600 "${PREFS_PATH}"
ok "      wrote ${PREFS_PATH}"

# ------------------------------------------------------------
# Step 5: append completed.jsonl as status:"partial"
# ------------------------------------------------------------
info "[5/8] Recording migration as partial..."
# We write "partial" + apply_migrations_pending:true. v0.11.1 apply-migrations
# detects this and resumes the remaining phases (host rewrites + autopilot
# install). If we wrote "complete" here, apply-migrations would SKIP the
# remaining phases and the broken install would stay broken (Codex H2).
echo "{\"version\":\"0.11.0\",\"status\":\"partial\",\"apply_migrations_pending\":true,\"mode\":\"${MODE}\",\"ts\":\"${NOW_ISO}\",\"source\":\"fix-v0.11.0.sh\"}" >> "${COMPLETED_PATH}"
ok "      appended ${COMPLETED_PATH}"

# ------------------------------------------------------------
# Step 6: detect AGENTS.md — PRINT guidance, do not auto-edit
# ------------------------------------------------------------
info "[6/8] Scanning for AGENTS.md..."
AGENTS_FOUND=()
for CANDIDATE in "${HOME}/.claude/AGENTS.md" "${HOME}/.openclaw/AGENTS.md" "${PWD}/AGENTS.md"; do
  [ -f "${CANDIDATE}" ] && AGENTS_FOUND+=("${CANDIDATE}")
done
if [ ${#AGENTS_FOUND[@]} -eq 0 ]; then
  ok "      no AGENTS.md found — nothing to suggest"
else
  for F in "${AGENTS_FOUND[@]}"; do
    warn "      AGENTS.md detected: ${F}"
    echo "        - Next steps (this script does NOT auto-edit):"
    echo "            1. Add a pointer to skills/conventions/subagent-routing.md"
    echo "            2. The v0.11.1 binary's \`gbrain apply-migrations --yes\` will inject"
    echo "               this automatically once v0.11.1 is installed."
  done
fi

# ------------------------------------------------------------
# Step 7: detect cron/jobs.json and scan for agentTurn
# ------------------------------------------------------------
info "[7/8] Scanning for cron manifests..."
CRON_FOUND=()
for CANDIDATE in "${HOME}/.claude/cron/jobs.json" "${HOME}/.openclaw/cron/jobs.json" "${PWD}/cron/jobs.json"; do
  [ -f "${CANDIDATE}" ] && CRON_FOUND+=("${CANDIDATE}")
done
if [ ${#CRON_FOUND[@]} -eq 0 ]; then
  ok "      no cron/jobs.json found — nothing to suggest"
else
  for F in "${CRON_FOUND[@]}"; do
    warn "      cron manifest detected: ${F}"
    COUNT=$(grep -c 'agentTurn' "${F}" 2>/dev/null || echo 0)
    echo "        - ${COUNT} agentTurn entries"
    echo "        - v0.11.1 apply-migrations will:"
    echo "            * auto-rewrite builtin handlers (sync/embed/lint/import/"
    echo "              extract/backlinks/autopilot-cycle) to gbrain jobs submit"
    echo "            * emit a pending-host-work.jsonl TODO for every non-builtin"
    echo "              handler; host agent walks those per skills/migrations/v0.11.0.md"
  done
fi

# ------------------------------------------------------------
# Step 8: final line
# ------------------------------------------------------------
info "[8/8] Done. Next step:"
echo ""
echo "      ${GREEN}gbrain autopilot --install${NC}"
echo ""
echo "      That ONE command does the rest: supervises autopilot, forks the"
echo "      Minions worker, and installs the right entry for your host (launchd"
echo "      on macOS, systemd on Linux, bootstrap hook on ephemeral containers)."
echo ""
echo "      Once v0.11.1 is out:"
echo "        ${GREEN}gbrain upgrade && gbrain apply-migrations${NC}"
echo "      becomes the canonical fix. This script retires then."
