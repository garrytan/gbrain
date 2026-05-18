#!/usr/bin/env bash
# Reference installer for the claude-code-capture recipe.
# Idempotent. Documented in ../claude-code-capture.md.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/garrytan/gbrain/master/recipes/claude-code-capture/install.sh)

set -euo pipefail

C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_RESET=$'\033[0m'
ok()   { echo "${C_OK}✓${C_RESET} $*"; }
warn() { echo "${C_WARN}⚠${C_RESET} $*"; }
err()  { echo "${C_ERR}✗${C_RESET} $*" >&2; }

HOOKS_DIR="$HOME/.gbrain/hooks"
SCRIPT_DST="$HOOKS_DIR/signal-detector.py"
SETTINGS="$HOME/.claude/settings.json"

mkdir -p "$HOOKS_DIR"

echo "→ Downloading signal-detector.py from upstream..."
RAW_URL="https://raw.githubusercontent.com/garrytan/gbrain/master/recipes/claude-code-capture/signal-detector.py"
curl -fsSL "$RAW_URL" -o "$SCRIPT_DST"
chmod 700 "$SCRIPT_DST"
ok "Installed $SCRIPT_DST"

echo "→ Checking auth mode..."
if command -v claude >/dev/null 2>&1; then
  ok "claude CLI found ($(command -v claude)) — capture will use your Pro/Max subscription (no extra cost)"
else
  ENV_FILE="${GBRAIN_ENV_FILE:-$HOME/gbrain/.env}"
  if [ -f "$ENV_FILE" ] && grep -q "^ANTHROPIC_API_KEY=" "$ENV_FILE"; then
    ok "ANTHROPIC_API_KEY found in $ENV_FILE — capture will use direct API (~1-3¢/session)"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    ok "ANTHROPIC_API_KEY found in shell env — capture will use direct API (~1-3¢/session)"
  else
    warn "Neither claude CLI nor ANTHROPIC_API_KEY found"
    warn "Capture will skip until one is available. Either:"
    warn "  - Install Claude Code:  npm i -g @anthropic-ai/claude-code"
    warn "  - Or add to $ENV_FILE:  ANTHROPIC_API_KEY=sk-ant-..."
  fi
fi

echo "→ Wiring Stop hook into $SETTINGS..."
if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi
cp "$SETTINGS" "$SETTINGS.bak-pre-capture-$(date +%s)"

python3 - <<PY
import json, os, tempfile
p = "$SETTINGS"
with open(p) as f: d = json.load(f)
d.setdefault("hooks", {}).setdefault("Stop", [])

new_cmd = "python3 $SCRIPT_DST"
existing = []
for entry in d["hooks"]["Stop"]:
    for h in entry.get("hooks", []):
        if h.get("type") == "command":
            existing.append(h.get("command",""))

if new_cmd in existing:
    print("Already wired — skipping merge.")
else:
    d["hooks"]["Stop"].append({
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": new_cmd,
            "timeout": 120,
            "async": True
        }]
    })

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p))
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
os.chmod(tmp, 0o600)
os.replace(tmp, p)
print("Settings written.")
PY

ok "Stop hook wired"

if command -v jq >/dev/null 2>&1; then
  if jq -e '.hooks.Stop[].hooks[] | select(.command | contains("signal-detector"))' "$SETTINGS" >/dev/null 2>&1; then
    ok "jq validation passed"
  else
    err "jq validation FAILED — settings.json may be malformed"
    exit 1
  fi
fi

echo "→ Smoke testing script..."
echo '{}' | python3 "$SCRIPT_DST" || true
LAST_LOG=$(tail -1 "$HOOKS_DIR/signal-detector.log" 2>/dev/null || echo "")
[ -n "$LAST_LOG" ] && ok "Script ran. Last log: $LAST_LOG"

echo ""
echo "════════════════════════════════════════════"
echo "  ✅ claude-code-capture installed"
echo "════════════════════════════════════════════"
echo ""
echo "  Open /hooks in Claude Code (or restart) to load the new hook."
echo "  See recipes/claude-code-capture.md for full details."
echo ""
