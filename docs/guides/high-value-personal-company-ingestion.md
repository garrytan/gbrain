# High-Value Personal + Company Ingestion Architecture

Status: design plan
Scope: ingest high-signal personal/company sources into GBrain as markdown under `~/gbrain`, then run `gbrain sync`, `gbrain embed --stale`, and extraction/linking passes. No outbound messages or destructive actions without explicit approval.

## 1. Principles and privacy boundaries

1. Local-first staging
   - Every source writes markdown into `~/gbrain/inbox/...` first.
   - Raw exports/transcripts stay local unless explicitly uploaded.
   - GBrain import is append-only or idempotent by source ID.

2. Separate raw, distilled, and entity state
   - Raw/source records: `~/gbrain/inbox/...` or `~/gbrain/sources/...`.
   - Distilled durable notes: `meetings/`, `communications/`, `journal/`, `projects/`.
   - Curated memory/state: `people/`, `companies/`, `deals/`, `projects/`, `concepts/`.

3. Least privilege
   - Read-only by default.
   - Gmail/Calendar use OAuth or app-password read scopes only until user approves write scopes.
   - Beeper MCP is read-only; local DB/bridge reads only.
   - Granola API mode preferred; do not attempt SQLCipher DB extraction unless user supplies/approves key handling.

4. Quiet automation
   - Cron jobs write logs to `~/gbrain/logs/ingest/*.log`.
   - No push notifications except digest pages / explicit review queues.
   - Crons never send messages, RSVP, delete, archive, mark read, label, or mutate remote systems.

5. Safety redaction
   - Drop or hash secrets, auth codes, password reset links, payment card data, OAuth tokens, API keys.
   - For highly sensitive messages, store metadata + summary, not full body, unless source is explicitly whitelisted.
   - Keep denylist rules in `~/gbrain/config/privacy-rules.yml`.

## 2. Priority order: high-value quick wins first

P0 — already/likely available, immediate value
1. Voice notes already landing in `~/gbrain/inbox/voice/`
   - Highest signal: Tim's own thoughts, priorities, ideas, action items.
   - Low auth complexity.
2. Granola meeting notes/transcripts via API
   - Highest company memory value: decisions, commitments, people/company context.
   - Prefer API over local encrypted DB.
3. Google Calendar event metadata
   - Great context for meetings, attendees, follow-ups, and daily briefings.
   - Lower sensitivity than email; easier to summarize safely.

P1 — high value, needs auth/config
4. Gmail / Google Workspace read-only triage
   - Ingest only high-signal human threads first: direct messages, investors, customers, partners, candidates, vendors.
   - Skip newsletters/promotions/receipts by default.
5. Beeper / other messages via MCP or local bridge
   - High signal for social/customer/founder relationships.
   - Use read-only summaries and action extraction; avoid full private conversation dumps unless whitelisted.

P2 — later enrichment/backfill
6. Long-tail message sources: iMessage, Signal, Telegram, LinkedIn, X/Instagram DMs
   - Incremental, privacy-heavy; start with unread/recent/high-signal contacts only.
7. Historical backfills
   - Only after current-day pipeline is stable.
   - Backfill in bounded windows with dry-run summaries.

## 3. File layout under `~/gbrain`

```text
~/gbrain/
  config/
    ingestion-sources.yml              # source enablement, account IDs, high-signal filters
    privacy-rules.yml                  # denylist/allowlist, redaction rules, retention rules
    entity-aliases.yml                 # known people/company aliases for extraction

  inbox/
    voice/                             # existing voice memo markdown inbox
    granola/                           # raw/staged meeting notes from Granola API
    calendar/                          # staged event pages, one per event/day
    email/
      personal/
        high-signal/
        digest/
        raw-redacted/
      work/
        high-signal/
        digest/
        raw-redacted/
    messages/
      beeper/
        high-signal/
        digest/
        raw-redacted/
      imessage/
      signal/
      telegram/
      linkedin/

  sources/
    granola/
      meetings/YYYY/MM/YYYY-MM-DD-<meeting-slug>.md
    calendar/
      YYYY/MM/YYYY-MM-DD.md            # daily schedule + attendee graph
    email/
      threads/YYYY/MM/<account>-<thread-id>.md
    messages/
      threads/YYYY/MM/<platform>-<room-id>-<thread-id>.md

  communications/
    daily/YYYY-MM-DD.md                # consolidated email/message digest + action queue
    threads/<person-or-company>/<thread-slug>.md

  meetings/
    YYYY/MM/YYYY-MM-DD-<meeting-slug>.md
    transcripts/YYYY/MM/YYYY-MM-DD-<meeting-slug>.md

  journal/
    voice/YYYY/MM/YYYY-MM-DD-<slug>.md

  tasks/
    inbox/YYYY-MM-DD.md                # extracted action items requiring review

  logs/
    ingest/
      voice.log
      granola.log
      calendar.log
      gmail.log
      beeper.log
      enrich.log
```

Recommended `gbrain.yml` addition for bulk generated content:

```yaml
storage:
  db_only:
    - inbox/email/
    - inbox/messages/
    - inbox/granola/
    - inbox/calendar/
    - sources/email/
    - sources/messages/
    - sources/granola/
    - sources/calendar/
    - meetings/transcripts/
    - communications/daily/
    - logs/ingest/
```

Keep curated directories (`people/`, `companies/`, `deals/`, `projects/`, `concepts/`) human-reviewable and db-tracked.

## 4. Markdown record schema

Each imported page should use consistent frontmatter:

```yaml
---
type: source_record
source: gmail|calendar|granola|voice|beeper|signal|telegram|linkedin|imessage
source_account: personal|work|unknown
source_id: <stable-provider-id>
thread_id: <stable-thread-id-if-any>
date: YYYY-MM-DDTHH:MM:SSZ
participants:
  - name: Jane Doe
    email: jane@example.com
    role: sender|recipient|attendee|speaker
entities:
  people: []
  companies: []
privacy: public|personal|company-confidential|sensitive
body_policy: full|redacted|summary_only|metadata_only
ingest_status: staged|synced|enriched|needs_review
requires_human_review: false
---
```

Body format:

```md
# <Human title>

## Why this matters
1-3 bullets written by the agent.

## Summary
Concise factual summary.

## Decisions / commitments
- ...

## Action items
- [ ] Owner — action — due/date/source

## Entities to update
- [[people/name]] — specific new fact
- [[companies/company]] — specific new fact

---
## Source excerpt / transcript
Redacted raw text or diarized transcript when allowed.
```

## 5. Source-specific architecture

### A. Voice notes — P0 quick win

Current state: files already exist in `~/gbrain/inbox/voice/`.

Flow:
1. Watch/import voice memo transcripts into `inbox/voice/`.
2. Batch-review 2-3x/day.
3. Convert valuable notes to `journal/voice/YYYY/MM/...` or `projects/<project>/notes/...`.
4. Extract tasks into `tasks/inbox/YYYY-MM-DD.md`.
5. Sync/embed/extract.

Commands:

```bash
cd ~/gbrain
mkdir -p journal/voice/$(date +%Y)/$(date +%m) tasks/inbox logs/ingest

gbrain sync --quiet >> logs/ingest/voice.log 2>&1
gbrain embed --stale --quiet >> logs/ingest/voice.log 2>&1
gbrain extract links --source db --by-mention --quiet >> logs/ingest/voice.log 2>&1
gbrain extract timeline --source db --quiet >> logs/ingest/voice.log 2>&1
```

Cadence:
- Import watcher: every 2 minutes or WatchPaths.
- GBrain sync/embed: every 15 minutes.
- Human/agent review: 10:00, 15:00, 20:30.

Enrichment:
- Classify as idea/task/project/company/contact/personal reflection.
- Pull explicit asks and deadlines.
- Link mentioned people/companies/projects.
- Promote only durable insights into curated pages.

### B. Granola — P0 quick win

Preferred mode: Granola API/export. Avoid direct SQLCipher DB extraction unless user explicitly approves and provides unlock/key process.

Flow:
1. Poll Granola API/export for new completed meetings.
2. Save raw/staged note to `inbox/granola/YYYY-MM-DD-<slug>.md`.
3. Create durable meeting page in `meetings/YYYY/MM/YYYY-MM-DD-<slug>.md`.
4. Store full transcript, if available and allowed, in `meetings/transcripts/YYYY/MM/...`.
5. Update attendee/person/company pages via by-mention links plus timeline extraction.

Import command shape:

```bash
cd ~/gbrain
mkdir -p inbox/granola meetings/$(date +%Y)/$(date +%m) meetings/transcripts/$(date +%Y)/$(date +%m) logs/ingest

# Placeholder command; implement script once API credentials are available.
python3 scripts/ingest/granola_import.py \
  --since-state .state/granola.last \
  --out inbox/granola \
  --meetings-out meetings \
  --transcripts-out meetings/transcripts \
  --redact \
  >> logs/ingest/granola.log 2>&1

gbrain sync --quiet >> logs/ingest/granola.log 2>&1
gbrain embed --stale --quiet >> logs/ingest/granola.log 2>&1
gbrain extract links --source db --by-mention --quiet >> logs/ingest/granola.log 2>&1
gbrain extract timeline --source db --quiet >> logs/ingest/granola.log 2>&1
```

Cadence:
- Poll every 30 minutes during business hours.
- Also run at 18:00 daily for end-of-day catch-up.

Enrichment:
- Prefer complete transcript over AI summary when available.
- Extract decisions, objections, open loops, commitments, owners, due dates.
- For every attendee and mentioned org, add timeline facts.
- Generate follow-up suggestions but do not send them.

### C. Google Calendar — P0/P1

If Google auth is missing, first deliver a setup-only script and skip polling until credentials exist.

Flow:
1. Pull upcoming 14 days and past 7 days of events.
2. Write daily schedule pages to `sources/calendar/YYYY/MM/YYYY-MM-DD.md`.
3. For events with meeting notes/transcripts, link to Granola/meeting pages.
4. Build attendee graph for people/company enrichment.

Commands:

```bash
cd ~/gbrain
mkdir -p sources/calendar/$(date +%Y)/$(date +%m) inbox/calendar logs/ingest

# Requires Google OAuth read-only calendar credentials.
python3 scripts/ingest/google_calendar_import.py \
  --calendar primary \
  --past-days 7 \
  --future-days 14 \
  --out sources/calendar \
  --privacy metadata_summary \
  >> logs/ingest/calendar.log 2>&1

gbrain sync --quiet >> logs/ingest/calendar.log 2>&1
gbrain embed --stale --quiet >> logs/ingest/calendar.log 2>&1
gbrain extract links --source db --by-mention --quiet >> logs/ingest/calendar.log 2>&1
```

Cadence:
- Every 2 hours during business hours.
- Daily brief input at 07:30.
- End-of-day reconciliation at 18:15.

Enrichment:
- Normalize attendees to person/company aliases.
- Flag meetings with no notes/transcript for follow-up review.
- Link recurring meetings to project/deal pages.

### D. Gmail / Google Workspace — P1

Start narrow: read-only, high-signal, recent threads only. Do not mark read, archive, label, draft, reply, or unsubscribe without approval.

Preferred implementation:
- Himalaya CLI if configured, because it is scriptable and works with Gmail/Workspace over IMAP.
- Gmail API later for labels/categories/filter creation if write scopes are approved.

High-signal filters:
- Direct human senders, not no-reply/list/newsletter/receipt.
- Known contacts in `people/`, domains in `companies/`, active deal/project domains.
- Unread, starred, or recent replies to Tim.
- Keywords: contract, intro, investor, customer, demo, urgent, invoice only if business-critical, candidate, partnership, launch, security.

Commands:

```bash
cd ~/gbrain
mkdir -p inbox/email/personal/high-signal inbox/email/work/high-signal communications/daily logs/ingest

# Requires Himalaya installed/configured. Read-only listing/fetching only.
python3 scripts/ingest/gmail_himalaya_import.py \
  --account personal \
  --since 3d \
  --mode high-signal \
  --out inbox/email/personal/high-signal \
  --digest communications/daily/$(date +%F).md \
  --redact \
  >> logs/ingest/gmail.log 2>&1

python3 scripts/ingest/gmail_himalaya_import.py \
  --account work \
  --since 3d \
  --mode high-signal \
  --out inbox/email/work/high-signal \
  --digest communications/daily/$(date +%F).md \
  --redact \
  >> logs/ingest/gmail.log 2>&1

gbrain sync --quiet >> logs/ingest/gmail.log 2>&1
gbrain embed --stale --quiet >> logs/ingest/gmail.log 2>&1
gbrain extract links --source db --by-mention --quiet >> logs/ingest/gmail.log 2>&1
gbrain extract timeline --source db --quiet >> logs/ingest/gmail.log 2>&1
```

Cadence:
- Every 60 minutes during 08:00-18:00.
- Daily digest finalization at 17:45.
- Historical backfill: manual only, 7-day windows, dry-run first.

Enrichment:
- Thread-level summaries, not message spam.
- Extract asks, waiting-on, promised-by-Tim, promised-by-other.
- Update people/company pages only with durable facts.
- Keep sensitive full bodies in `raw-redacted/` or skip entirely based on privacy rules.

### E. Beeper and other messages — P1

Use Beeper MCP for read-only recent/unread discovery. If a local bridge/DB exists, treat it as read-only and do not write/send from it.

Flow:
1. List unread/recent chats by platform.
2. Pull recent messages for high-signal rooms only.
3. Write summaries to `inbox/messages/beeper/high-signal/` and daily digest.
4. Extract tasks and relationship updates.

Commands:

```bash
cd ~/gbrain
mkdir -p inbox/messages/beeper/high-signal communications/daily logs/ingest

# MCP-driven imports need an agent wrapper; local DB mode should be read-only.
python3 scripts/ingest/beeper_import.py \
  --mode mcp-readonly \
  --unread-only \
  --high-signal-only \
  --out inbox/messages/beeper/high-signal \
  --digest communications/daily/$(date +%F).md \
  --redact \
  >> logs/ingest/beeper.log 2>&1

gbrain sync --quiet >> logs/ingest/beeper.log 2>&1
gbrain embed --stale --quiet >> logs/ingest/beeper.log 2>&1
gbrain extract links --source db --by-mention --quiet >> logs/ingest/beeper.log 2>&1
gbrain extract timeline --source db --quiet >> logs/ingest/beeper.log 2>&1
```

Cadence:
- Every 60 minutes for unread/high-signal only.
- Daily digest at 17:45.
- Platform-specific deep backfill only with approval.

Enrichment:
- Classify relationship importance and response urgency.
- Extract commitments and open loops.
- Summarize private chats; avoid full dumps by default.
- Never send, react, mark read, or archive.

## 6. Unified import runner

Create one orchestrator script later:

```bash
cd ~/gbrain
scripts/ingest/run_ingestion.sh voice granola calendar gmail beeper
```

Recommended command body:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$HOME/gbrain"
mkdir -p logs/ingest .state

# Source-specific importers should be idempotent and read-only.
# Run only enabled sources from config/ingestion-sources.yml.

for source in "$@"; do
  case "$source" in
    voice)    scripts/ingest/voice_review_stage.sh ;;
    granola)  python3 scripts/ingest/granola_import.py --config config/ingestion-sources.yml ;;
    calendar) python3 scripts/ingest/google_calendar_import.py --config config/ingestion-sources.yml ;;
    gmail)    python3 scripts/ingest/gmail_himalaya_import.py --config config/ingestion-sources.yml ;;
    beeper)   python3 scripts/ingest/beeper_import.py --config config/ingestion-sources.yml ;;
  esac
 done

gbrain sync --quiet
gbrain embed --stale --quiet
gbrain extract links --source db --by-mention --quiet
gbrain extract timeline --source db --quiet
```

## 7. Cron cadence

Use launchd/cron with quiet logs and flock/lockfiles to prevent overlap.

```cron
# Voice import/sync: frequent, cheap
*/15 * * * * cd ~/gbrain && flock .state/voice.lock scripts/ingest/run_ingestion.sh voice >> logs/ingest/voice.log 2>&1

# Granola: business-hours meeting memory
*/30 8-18 * * 1-5 cd ~/gbrain && flock .state/granola.lock scripts/ingest/run_ingestion.sh granola >> logs/ingest/granola.log 2>&1
0 18 * * 1-5 cd ~/gbrain && flock .state/granola.lock scripts/ingest/run_ingestion.sh granola >> logs/ingest/granola.log 2>&1

# Calendar: daily context and attendee graph
30 7 * * * cd ~/gbrain && flock .state/calendar.lock scripts/ingest/run_ingestion.sh calendar >> logs/ingest/calendar.log 2>&1
0 */2 * * 1-5 cd ~/gbrain && flock .state/calendar.lock scripts/ingest/run_ingestion.sh calendar >> logs/ingest/calendar.log 2>&1
15 18 * * 1-5 cd ~/gbrain && flock .state/calendar.lock scripts/ingest/run_ingestion.sh calendar >> logs/ingest/calendar.log 2>&1

# Gmail: high-signal only
0 8-18 * * 1-5 cd ~/gbrain && flock .state/gmail.lock scripts/ingest/run_ingestion.sh gmail >> logs/ingest/gmail.log 2>&1
45 17 * * 1-5 cd ~/gbrain && flock .state/gmail.lock scripts/ingest/run_ingestion.sh gmail >> logs/ingest/gmail.log 2>&1

# Beeper/messages: high-signal unread only
15 8-18 * * 1-5 cd ~/gbrain && flock .state/beeper.lock scripts/ingest/run_ingestion.sh beeper >> logs/ingest/beeper.log 2>&1
45 17 * * 1-5 cd ~/gbrain && flock .state/beeper.lock scripts/ingest/run_ingestion.sh beeper >> logs/ingest/beeper.log 2>&1

# Daily enrichment/cleanup
30 19 * * * cd ~/gbrain && flock .state/enrich.lock scripts/ingest/run_enrichment.sh >> logs/ingest/enrich.log 2>&1
```

On macOS, prefer launchd for WatchPaths on voice notes; cron is fine for bounded polling jobs.

## 8. Enrichment pipeline

Run after each source import:

```bash
cd ~/gbrain
gbrain sync --quiet
gbrain embed --stale --quiet
gbrain extract links --source db --by-mention --quiet
gbrain extract timeline --source db --quiet
```

Nightly or daily-review enrichment:

1. Entity reconciliation
   - Match aliases/emails/domains to existing `people/` and `companies/` pages.
   - Create candidate entity pages only in `inbox/review/entities/`; do not auto-create curated people/company pages unless approved.

2. Timeline propagation
   - For meetings and high-signal communications, add dated facts to relevant people/company/project pages.
   - Avoid generic entries like "emailed Tim"; only durable facts/commitments.

3. Task extraction
   - Write action items to `tasks/inbox/YYYY-MM-DD.md` with source links.
   - Categories: reply-needed, follow-up, waiting-on, calendar, project, personal.

4. Daily digest
   - Append to `communications/daily/YYYY-MM-DD.md`:
     - top urgent items
     - new decisions
     - people/company changes
     - follow-ups due
     - skipped sensitive items count

5. Privacy audit
   - Scan staged files for secrets/tokens/password reset URLs.
   - Move suspect files to `inbox/review/privacy/` and mark `requires_human_review: true`.

6. Backlink verification
   - Run link extraction dry-run weekly before any aggressive fix.
   - Use explicit links in durable pages for important relationships.

## 9. First implementation sequence

Day 0: prepare layout and config

```bash
cd ~/gbrain
mkdir -p config .state logs/ingest scripts/ingest \
  inbox/{granola,calendar,voice} \
  inbox/email/{personal,work}/{high-signal,digest,raw-redacted} \
  inbox/messages/beeper/{high-signal,digest,raw-redacted} \
  sources/{granola,calendar,email/messages} \
  communications/daily tasks/inbox
```

Day 1 quick wins
1. Stabilize voice-note review/import.
2. Add Granola API importer if credentials/export are available.
3. Add Calendar read-only importer if Google OAuth exists; otherwise write setup instructions and skip polling.

Day 2 high-signal comms
4. Install/configure Himalaya or Gmail read-only API.
5. Import only recent/high-signal email into GBrain.
6. Add Beeper MCP unread/high-signal summaries.

Day 3+ hardening
7. Entity alias config.
8. Privacy audit rules.
9. Nightly digest and task extraction.
10. Manual historical backfill windows.

## 10. Verification checklist

After each importer run:

```bash
cd ~/gbrain
gbrain sync --quiet
gbrain embed --stale --quiet
gbrain extract links --source db --by-mention --dry-run | head -50
gbrain stats
```

Manual checks:
- New source markdown files exist under expected `inbox/` or `sources/` path.
- Files have source IDs and privacy policy frontmatter.
- Daily digest page exists.
- No raw secrets/password reset links/API tokens present.
- Mentioned people/companies are linked or queued for review.
- No outbound or destructive operation occurred.

## 11. Key blockers/assumptions

- Google auth may be missing; Calendar/Gmail importers should no-op with clear log messages until credentials exist.
- Granola DB may be SQLCipher encrypted; API/export is the approved path unless user explicitly approves DB/key handling.
- Beeper MCP is read-only; any local bridge/DB import must remain read-only.
- Import scripts named above are proposed implementation targets and may not exist yet.
