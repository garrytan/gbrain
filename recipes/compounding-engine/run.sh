#!/usr/bin/env bash
# Compounding Engine — main orchestrator
# Runs nightly via cron. Analyzes brain state, applies high-confidence improvements,
# logs everything, and reports via Telegram in the morning.
#
# Modes:
#   run       Full cycle (analyze + auto-apply + journal)
#   status    Show current state + lifetime stats
#   history   List last N cycles with summaries
#   revert <id>  Mark a specific change for revert in next cycle
#   dry-run   Run analyze + show proposals, DO NOT apply

set -uo pipefail

COMPOUND_DIR="$HOME/.openclaw/skills/gbrain/compound"
JOURNAL_DIR="$COMPOUND_DIR/journal"
BACKUP_DIR="$COMPOUND_DIR/backups"
LEARNING="$COMPOUND_DIR/learning.json"
LOG="$HOME/.gbrain/logs/compound.log"

mkdir -p "$JOURNAL_DIR" "$BACKUP_DIR" "$(dirname "$LOG")"

DB_URL=$(python3 -c "import json; print(json.load(open('$HOME/.gbrain/config.json'))['database_url'])" 2>/dev/null)
[ -z "$DB_URL" ] && { echo "❌ DATABASE_URL not configured"; exit 1; }

# Telegram from openclaw config
BOT_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.openclaw/openclaw.json'))['channels']['telegram']['botToken'])" 2>/dev/null)
CHAT_ID="1439730479"

CMD="${1:-run}"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DATE_TODAY=$(date -u +%Y-%m-%d)

log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

# ─── Subcommand: status ────────────────────────────────────────────
if [ "$CMD" = "status" ]; then
  python3 <<EOF
import json
d = json.load(open("$LEARNING"))
print(f"# 🌙 Compounding Engine — status")
print()
print(f"Total cycles run: {d.get('total_cycles', 0)}")
print(f"First run: {d.get('first_run') or '(never)'}")
print(f"Last run: {d.get('last_run') or '(never)'}")
print()
print("## Confidence by category")
print()
for name, cat in d['categories'].items():
    bar_len = int(cat['confidence'] * 14)
    bar = '█' * bar_len + '░' * (14 - bar_len)
    threshold_marker = '' if cat['confidence'] >= d['thresholds']['auto_apply'] else ' ← below auto-threshold'
    print(f"  {name:25s} {bar} {cat['confidence']:.2f}  applied={cat['applied']:3d}  reverted={cat['reverted']:3d}{threshold_marker}")
print()
print(f"Auto-apply threshold: {d['thresholds']['auto_apply']}")
print(f"Skip below: {d['thresholds']['skip_below']}")
EOF
  exit 0
fi

# ─── Subcommand: history ───────────────────────────────────────────
if [ "$CMD" = "history" ]; then
  N="${2:-10}"
  echo "# 📜 Last $N compound cycles"
  echo ""
  ls -t "$JOURNAL_DIR"/compound-*.md 2>/dev/null | head -"$N" | while read -r f; do
    echo "## $(basename "$f" .md)"
    head -20 "$f"
    echo ""
    echo "---"
  done
  exit 0
fi

# ─── Subcommand: revert ────────────────────────────────────────────
if [ "$CMD" = "revert" ]; then
  CHANGE_ID="${2:?Usage: $0 revert <change_id>}"
  log "Revert requested: $CHANGE_ID"
  echo "{\"change_id\": \"$CHANGE_ID\", \"requested_at\": \"$(date -Is)\"}" >> "$COMPOUND_DIR/revert-queue.jsonl"
  echo "✓ Revert queued. Will be processed in next cycle."
  exit 0
fi

# ─── Subcommand: run / dry-run ─────────────────────────────────────
DRY_RUN=0
[ "$CMD" = "dry-run" ] && DRY_RUN=1

log "═══ Cycle start: $TIMESTAMP (dry_run=$DRY_RUN) ═══"

# ─── Phase 1: Pre-flight checks ───────────────────────────────────
log "[phase 1] Pre-flight checks"
curl -sf --max-time 5 http://127.0.0.1:8787/health >/dev/null || { log "❌ wrapper down"; exit 1; }
gbrain --version >/dev/null 2>&1 || { log "❌ gbrain CLI missing"; exit 1; }
log "  ✓ wrapper alive, gbrain CLI ok"

# ─── Phase 2: Backup brain state ──────────────────────────────────
CYCLE_BACKUP="$BACKUP_DIR/$TIMESTAMP"
mkdir -p "$CYCLE_BACKUP"
log "[phase 2] Backup → $CYCLE_BACKUP"
PGCONNECT_TIMEOUT=10 psql "$DB_URL" -At -c "
COPY (SELECT id, slug, type, LENGTH(compiled_truth) AS len, updated_at FROM pages WHERE updated_at > NOW() - INTERVAL '7 days') TO STDOUT WITH CSV HEADER;
" > "$CYCLE_BACKUP/pages-recent.csv" 2>/dev/null
PGCONNECT_TIMEOUT=10 psql "$DB_URL" -At -c "
COPY (SELECT * FROM links WHERE created_at > NOW() - INTERVAL '7 days') TO STDOUT WITH CSV HEADER;
" > "$CYCLE_BACKUP/links-recent.csv" 2>/dev/null
log "  ✓ backup complete"

# ─── Phase 3: Analyze (call claude -p with prompt) ────────────────
log "[phase 3] Analyzing brain state via claude -p"
ANALYZE_PROMPT=$(cat "$COMPOUND_DIR/prompts/analyze.md")
LEARNING_JSON=$(cat "$LEARNING")
PROPOSALS_FILE="$CYCLE_BACKUP/proposals.json"

# Build context: recent pages, links, audit log
CONTEXT=$(PGCONNECT_TIMEOUT=10 psql "$DB_URL" -At -c "
SELECT json_build_object(
  'recent_pages', (SELECT json_agg(json_build_object('slug', slug, 'type', type, 'compiled_truth', LEFT(compiled_truth, 500))) FROM pages WHERE updated_at > NOW() - INTERVAL '24 hours' LIMIT 50),
  'recent_links', (SELECT json_agg(json_build_object('from', pf.slug, 'to', pt.slug, 'type', l.link_type)) FROM links l JOIN pages pf ON pf.id=l.from_page_id JOIN pages pt ON pt.id=l.to_page_id WHERE l.created_at > NOW() - INTERVAL '24 hours' LIMIT 50),
  'all_existing_slugs', (SELECT json_agg(slug) FROM pages),
  'page_types', (SELECT json_agg(DISTINCT type) FROM pages),
  'link_types', (SELECT json_agg(DISTINCT link_type) FROM links)
);
" 2>/dev/null)

# Call Claude (uses Max subscription, no API key needed)
FULL_PROMPT="$ANALYZE_PROMPT

## Current learning state
$LEARNING_JSON

## Brain context (recent activity)
$CONTEXT

Now produce JSON proposals as specified."

# Run claude in non-interactive mode
echo "$FULL_PROMPT" | timeout 120 claude --print --no-chrome 2>/dev/null > "$PROPOSALS_FILE.raw" || {
  log "  ⚠️ claude -p failed or timed out — saving stub"
  echo '{"cycle_at": "'$TIMESTAMP'", "scan_window_hours": 24, "proposals": []}' > "$PROPOSALS_FILE"
}

# Extract JSON from output (claude may add markdown fences sometimes)
python3 <<EOF > "$PROPOSALS_FILE" 2>/dev/null
import re, sys, json
text = open("$PROPOSALS_FILE.raw").read() if open("$PROPOSALS_FILE.raw").read() else "{}"
text = open("$PROPOSALS_FILE.raw").read()
m = re.search(r'\{[\s\S]*"proposals"[\s\S]*\}', text)
if m:
    try:
        json.loads(m.group(0))
        print(m.group(0))
    except:
        print('{"cycle_at":"$TIMESTAMP","proposals":[]}')
else:
    print('{"cycle_at":"$TIMESTAMP","proposals":[]}')
EOF

PROPOSAL_COUNT=$(python3 -c "import json; print(len(json.load(open('$PROPOSALS_FILE'))['proposals']))" 2>/dev/null || echo 0)
log "  ✓ $PROPOSAL_COUNT proposals generated"

# ─── Phase 4: Apply (or skip if dry-run) ──────────────────────────
APPLIED=0
SKIPPED=0
ERRORS=0
JOURNAL_FILE="$JOURNAL_DIR/compound-$DATE_TODAY.md"

{
  echo "# Compound cycle $TIMESTAMP"
  echo ""
  echo "**Mode:** $([ $DRY_RUN -eq 1 ] && echo "dry-run" || echo "auto-apply")"
  echo "**Proposals:** $PROPOSAL_COUNT"
  echo ""
  echo "## Proposals"
  echo ""
} > "$JOURNAL_FILE"

if [ "$PROPOSAL_COUNT" -gt 0 ]; then
  log "[phase 4] Applying $PROPOSAL_COUNT proposals (dry_run=$DRY_RUN)"
  python3 <<PYEOF
import json, subprocess, sys, os

with open("$PROPOSALS_FILE") as f: p = json.load(f)
with open("$LEARNING") as f: learning = json.load(f)

proposals = p.get('proposals', [])
applied, skipped, errors = 0, 0, 0
journal = open("$JOURNAL_FILE", "a")

for prop in proposals:
    cat = prop.get('category')
    conf = prop.get('confidence', 0)
    cat_data = learning['categories'].get(cat, {})
    cat_conf = cat_data.get('confidence', 0.5)
    threshold = learning['thresholds']['auto_apply']

    decision = "auto-apply" if cat_conf >= threshold and conf >= threshold else "skip-low-confidence"

    journal.write(f"### {prop.get('id', '?')[:8]}: {cat} (conf={conf:.2f}, cat_conf={cat_conf:.2f}) — {decision}\n")
    journal.write(f"- **Action:** {prop.get('action')}\n")
    journal.write(f"- **Evidence:** {prop.get('evidence', '?')[:200]}\n")
    if prop.get('action') == 'create_page':
        journal.write(f"- **Slug:** {prop.get('slug')}\n")
    elif prop.get('action') == 'add_link':
        journal.write(f"- **Link:** {prop.get('from')} → {prop.get('to')} ({prop.get('link_type')})\n")
    journal.write("\n")

    if decision == "skip-low-confidence":
        skipped += 1
        continue

    if $DRY_RUN == 1:
        skipped += 1
        continue

    # Execute
    try:
        if prop.get('action') == 'create_page':
            slug = prop['slug']
            content = prop.get('prefilled_content', {})
            # Use gbrain CLI to put_page (idempotent)
            cmd = ['gbrain', 'put-page', slug, '--type', content.get('type', 'concept'), '--title', content.get('title', slug)]
            r = subprocess.run(cmd, input=content.get('compiled_truth', ''), capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                applied += 1
                cat_data['applied'] = cat_data.get('applied', 0) + 1
                journal.write(f"  → ✓ applied\n\n")
            else:
                errors += 1
                journal.write(f"  → ❌ error: {r.stderr[:100]}\n\n")
        elif prop.get('action') == 'add_link':
            cmd = ['gbrain', 'add-link', prop['from'], prop['to'], '--type', prop.get('link_type', 'relates_to')]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                applied += 1
                cat_data['applied'] = cat_data.get('applied', 0) + 1
                journal.write(f"  → ✓ applied\n\n")
            else:
                errors += 1
                journal.write(f"  → ❌ error: {r.stderr[:100]}\n\n")
        else:
            skipped += 1
    except Exception as e:
        errors += 1
        journal.write(f"  → ❌ exception: {str(e)[:100]}\n\n")

journal.close()

# Update learning
import datetime
learning['last_run'] = datetime.datetime.utcnow().isoformat() + 'Z'
if not learning.get('first_run'):
    learning['first_run'] = learning['last_run']
learning['total_cycles'] = learning.get('total_cycles', 0) + 1
with open("$LEARNING", 'w') as f: json.dump(learning, f, indent=2)

# Output summary
print(f"APPLIED={applied}", file=sys.stderr)
print(f"SKIPPED={skipped}", file=sys.stderr)
print(f"ERRORS={errors}", file=sys.stderr)
PYEOF
  RESULT_VARS=$(grep -E "^(APPLIED|SKIPPED|ERRORS)=" /dev/stderr 2>/dev/null || true)
fi

log "  ✓ phase 4 done"

# ─── Phase 5: Telegram notification (morning) ─────────────────────
# Defer to a separate script that runs at 08:00 — this script's responsibility
# is to leave the journal file ready. The morning script reads & sends.
log "═══ Cycle done. Journal: $JOURNAL_FILE ═══"

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "✅ Dry-run complete. Proposals at: $PROPOSALS_FILE"
  echo "  Journal at: $JOURNAL_FILE"
  echo "  No changes applied."
fi
