#!/usr/bin/env bash
# Morning report — runs at 08:00 Hermosillo via cron.
# Reads last night's journal and sends Telegram silent push with summary.

set -uo pipefail

COMPOUND_DIR="$HOME/.openclaw/skills/gbrain/compound"
JOURNAL_DIR="$COMPOUND_DIR/journal"
DATE_TODAY=$(date -u +%Y-%m-%d)
JOURNAL="$JOURNAL_DIR/compound-$DATE_TODAY.md"

# Telegram setup
BOT_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.openclaw/openclaw.json'))['channels']['telegram']['botToken'])" 2>/dev/null)
CHAT_ID="1439730479"

if [ ! -f "$JOURNAL" ]; then
  echo "No journal for today ($JOURNAL not found). Skipping morning report."
  exit 0
fi

# Build summary
SUMMARY=$(python3 <<EOF
import re
content = open("$JOURNAL").read()
applied = len(re.findall(r'→ ✓ applied', content))
errors = len(re.findall(r'→ ❌', content))
skipped = len(re.findall(r'skip-low-confidence', content))
mode = re.search(r'\*\*Mode:\*\* (\S+)', content)
mode = mode.group(1) if mode else 'unknown'

# Extract category breakdown
cats = {}
for m in re.finditer(r'### \S+: (\S+) \(', content):
    cat = m.group(1)
    cats[cat] = cats.get(cat, 0) + 1

cat_str = ", ".join(f"{c}={n}" for c,n in sorted(cats.items(), key=lambda x: -x[1])[:3])

print(f"🌙 *Compound cycle ($mode)*\n")
print(f"✓ Applied: {applied}")
print(f"⏭ Skipped: {skipped}")
if errors > 0:
    print(f"❌ Errors: {errors}")
print(f"\nTop categories: {cat_str if cat_str else '(none)'}")
print(f"\nFull journal: \`$JOURNAL\`")
print(f"Status: \`/gbrain compound status\`")
print(f"Revert one: \`/gbrain compound revert <id>\`")
EOF
)

if [ -z "$BOT_TOKEN" ]; then
  echo "No Telegram token configured. Skipping push."
  exit 0
fi

curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=$CHAT_ID" \
  --data-urlencode "text=$SUMMARY" \
  --data-urlencode "parse_mode=Markdown" \
  --data-urlencode "disable_notification=true" \
  >/dev/null 2>&1 && echo "✓ morning report sent" || echo "⚠ telegram delivery failed"
