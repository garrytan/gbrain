---
name: cold-start
version: 1.0.0
description: |
  Day-one data bootstrapping for a new brain. Sequences the highest-leverage
  data sources to go from empty brain to useful brain in one session. The
  agent never holds raw OAuth tokens or API keys: Google data comes through
  gbrain's own connector, an offline export, or a host's credential gateway.
  Covers Gmail import, calendar sync, contacts seeding, X/Twitter archive,
  conversation imports, and file archives.
  Use when a user has just finished gbrain setup and asks "now what?"
triggers:
  - "cold start"
  - "fill my brain"
  - "bootstrap brain"
  - "bootstrap my data"
  - "import my data"
  - "day one"
  - "get started"
  - "what should I import first"
  - "populate brain"
  - "now what?"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - sync_brain
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - meetings/
  - daily/
  - media/
  - conversations/
  - sources/
---

# Cold Start — Day-One Brain Bootstrapping

You have a working brain. Search works. Now what?

An empty brain is a static database. A brain with your email history, calendar,
contacts, conversations, and social media is a **live context membrane** that makes
every future interaction smarter. This skill sequences the highest-leverage data
sources to get you from zero to useful in one session.

## Contract

- Every import phase is gated on user consent (ask-user pattern) before proceeding.
- **The agent never holds raw OAuth tokens or API keys.** This is a safety
  requirement, not a preference. Three paths satisfy it for Google data:
  the native connector (`gbrain google setup` — tokens live in gbrain's
  credential vault, mode 0600, never in the agent's context; see
  `docs/guides/google-connect.md` and `skills/google-loops/SKILL.md`),
  a credential gateway the host already integrates, such as ClawVisor (it
  vaults credentials, scopes each task, logs every API call, and asks a
  human before destructive operations), or offline file exports (Google Takeout, Twitter archive
  download).
- Each phase is independently valuable — the user can stop after any phase and still
  have a useful brain.
- Progress is tracked in `cold-start-state.json` in the brain's config directory so interrupted sessions
  can resume.
- Entity detection and cross-linking run on every import, not as a separate pass.

## Prerequisites

- GBrain installed and initialized (`gbrain doctor --json` all green)
- Brain repo cloned and synced
- Agent has terminal access and can run `gbrain` CLI commands

## The Priority Stack

Data sources ranked by **information density × ease of import**:

| Priority | Source | Why | Time | Pages Created |
|----------|--------|-----|------|---------------|
| 1 | Existing markdown/Obsidian | Highest density — it's already structured | 5 min | 100s-1000s |
| 2 | Google Contacts | Seeds the people/ directory — names, emails, companies | 10 min | 50-500 |
| 3 | Google Calendar (90 days) | Meeting history with attendee context | 15 min | 30-90 |
| 4 | Gmail (recent threads) | Relationship context, active threads, org chart signals | 20 min | 50-200 |
| 5 | Conversations (ChatGPT/Claude exports; coding sessions on this machine come from setup's `setup_history` decision) | Your thinking, questions, mental models | 15 min | 10-100 |
| 6 | X/Twitter archive | Your public positions, takes, engagement patterns | 20 min | 30-365 |
| 7 | File archives (Dropbox/Drive/local) | Historical documents, old writing, photos | 30+ min | varies |
| 8 | Meeting transcripts (Circleback/etc.) | Deep relationship context from recorded calls | 20 min | 10-50 |

## Phase 0: Choose how Google data comes in

Ask the user which path to use for Contacts, Calendar and Gmail (phases 2-4).
None of them puts a Google token in the agent's hands:

1. **gbrain's Google connector (default).** `gbrain google setup` connects the
   user's own Google OAuth client for live sync of mail threads, calendar
   events and contacts. Setup imports right away and keeps syncing, so before
   running it ask which account and which services (`--services`) to connect,
   and say that it starts syncing at once. In the same breath, say that synced
   mail and calendar text is sent to the configured model provider for
   open-loop and atom extraction (both on by default), and how to turn that off:
   `gbrain config set loops.extraction_enabled false` and
   `gbrain config set cycle.extract_atoms.connector_pages false`. Tokens live in gbrain's local credential vault (a 0600
   file, redacted in listings); the agent only runs CLI commands. See
   `docs/guides/google-connect.md` and `skills/google-loops/SKILL.md`.
2. **Google Takeout (offline).** A [Google Takeout](https://takeout.google.com)
   export covers all three as a point-in-time snapshot (contacts CSV, calendar
   ICS, Gmail mbox). Phases 2-4 below document this path first.
3. **A credential gateway the host already has.** Some agent hosts integrate
   a gateway such as [ClawVisor](https://clawvisor.com) that holds the
   credentials, scopes each task and logs every call. gbrain has no gateway
   settings of its own, and Codex and Claude Code have no such integration,
   so offer this only on a host that has one. Ask for the narrowest read-only
   scope that does the job and state it plainly: what the agent reads, from
   which accounts, and why. When the gateway blocks a request the user
   needs, tell them what was blocked and widen the task only with their
   agreement.

Whichever path the user picks, never ask them to paste a token into the chat
and never hold OAuth tokens in the agent's own context or files. Secrets
travel by file or environment intake, never on the command line or in chat.

## Phase 1: Existing Markdown / Obsidian Import

For an existing company Git repository, use the migrate (host-side) company
workflow instead of the generic import below. On the trusted brain host, start with
`gbrain sources inspect <path> --profile company-brain`; confirm an initialized
company brain and a new source, show the connect destination/access preview, and
obtain approval before `--yes`. Do not flatten its vocabulary by activating or
normalizing an unrelated personal schema. The offline `gbrain sources demo
company-brain` needs no keys or private data. Details:
`docs/guides/company-brain-ingestion.md`.
For this company path, stop after reporting the durable receipt; skip the generic
import and post-bootstrap checklist below. Later enrichment or scheduling needs
separate consent and must respect the source's immutable keyless sync policy.

**The highest-leverage first import.** If the user already has a notes system, this
is hundreds or thousands of structured pages ready to go.

### Discovery

```bash
echo "=== Markdown Repository Discovery ==="
for dir in ~/git/* ~/Documents/* ~/notes/* ~/obsidian/*; do
  if [ -d "$dir" ]; then
    md_count=$(find "$dir" -name "*.md" -not -path "*/node_modules/*" \
      -not -path "*/.git/*" -not -path "*/.obsidian/*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$md_count" -gt 5 ]; then
      total_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      echo "  $dir ($total_size, $md_count .md files)"
    fi
  fi
done
```

### Import

```bash
# Obsidian vaults are markdown directories — import directly, then wire wikilinks
# (full flow: migrate (host-side))
gbrain import /path/to/vault --no-embed --workers 4
gbrain extract links --source db      # parses [[wikilinks]] natively

# For plain markdown directories
gbrain import /path/to/dir --no-embed --workers 4

# Verify
gbrain stats
gbrain search "<topic from the imported data>"
```

### Post-import

- Run link extraction: `gbrain extract links --source db`
- Run timeline extraction: `gbrain extract timeline --source db`
- Embeddings: with a paid embedding provider this costs money. Tell the user
  how many pages need embedding and ask before running `gbrain embed --stale`.

**Track progress:** after each phase, merge it into the state file the
Resume Protocol reads (set `PHASE` to the phase just finished and `NEXT`
to the next one; add `SKIPPED=1` for a phase the user skipped):
```bash
PHASE=1 NEXT=2 python3 - <<'PY'
import datetime, json, os, pathlib
p = pathlib.Path(os.environ.get('GBRAIN_HOME') or pathlib.Path.home()) / '.gbrain' / 'cold-start-state.json'
s = json.loads(p.read_text()) if p.exists() else {
    'started': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')}
key = 'phases_skipped' if os.environ.get('SKIPPED') == '1' else 'phases_completed'
s[key] = sorted(set(s.get(key, [])) | {int(os.environ['PHASE'])})
s['next_phase'] = int(os.environ['NEXT'])
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(s, indent=2) + '\n')
PY
```

## Phase 2: Google Contacts → People Pages

**Seeds the people/ directory.** Every person in your contacts becomes a brain page
with name, email, phone, company, and notes. This is the foundation that all other
imports build on — when Gmail references "bob@example.com", the brain already knows
who Bob is.

### Via Google Takeout (offline)

1. Export contacts from [takeout.google.com](https://takeout.google.com)
   (select Contacts, CSV format), or directly from
   [contacts.google.com](https://contacts.google.com) via Export → Google CSV.
2. Parse the CSV: each row carries name, email(s), phone(s), organization,
   and notes.
3. Run each row through the processing rules below to create people/ pages.

### Via a host credential gateway (pseudo-code)

```javascript
// Fetch all contacts
const contacts = await clawvisor('google.contacts', 'list_contacts', {
  limit: 1000,
  fields: 'names,emailAddresses,phoneNumbers,organizations,biographies'
});
```

### Processing rules

For each contact:
1. **Filter out noise** — skip contacts with no name, no email, or that are clearly
   automated (noreply@, no-reply@, support@, notifications@)
2. **Check brain first** — `gbrain search "name"` to avoid duplicates
3. **Create people/ page** with:
   - Name, email(s), phone(s), company, title
   - Source attribution: `[Source: Google Contacts, YYYY-MM-DD]`
   - Any notes from the contact as initial context
4. **Link to company** — if the contact has an organization, create/update the
   company page and link the person to it

### Quality gate

After importing 5 contacts, pause and show the user a sample page. Ask:
> "Here's what a contact page looks like. Want me to continue with the rest, or
> adjust the format first?"

## Phase 3: Google Calendar (Last 90 Days)

**Meeting history with attendee context.** Calendar events reveal who the user meets
with, how often, and in what context. Combined with contacts, this builds a rich
relationship map.

### Fetch events

**Via Google Takeout (offline):** export
Calendar from [takeout.google.com](https://takeout.google.com) (ICS format,
one file per calendar). Parse each event (title, start/end, attendees), keep
the last 90 days, and file them into the brain structure below.

**Via a host credential gateway (pseudo-code):**

```javascript
// Query ALL calendar accounts the user named
const accounts = ['alice@example.com', 'alice@work.example.com'];
for (const account of accounts) {
  const events = await clawvisor(`google.calendar:${account}`, 'list_events', {
    timeMin: new Date(Date.now() - 90 * 86400000).toISOString(),
    timeMax: new Date().toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });
}
```

### Brain structure

Follow the three-tier calendar architecture:
```
brain/daily/calendar/
├── calendar-log.md              ← compiled truth (patterns, key people)
├── YYYY/
│   ├── YYYY-MM.md               ← monthly summary
│   └── YYYY-MM-DD.md            ← daily event log
```

### Entity enrichment

For each event with attendees:
1. Look up each attendee in the brain (they should exist from Phase 2), by
   exact match only (`gbrain whois <email or name> --json`)
   ([identity rule](../conventions/brain-first.md#identity-exact-match))
2. Add a timeline entry to their page: met at [event title] on [date]
3. If an attendee has no brain page and appears in 3+ events, create one
4. Link attendees who appear in the same meeting

## Phase 4: Gmail (Recent Threads)

**Relationship context and active threads.** Email reveals organizational
relationships, ongoing conversations, and communication patterns.

Offline, the source is the Gmail mbox file from a
[Google Takeout](https://takeout.google.com) export. The sampling
and filtering rules below apply the same way.

### Strategy: Smart sampling, not bulk import

Don't import every email. Import the **signal**:

1. **Sent mail (last 30 days)** — who the user actively communicates with
2. **Starred/important emails** — user-curated signal
3. **Threads with 3+ replies** — active conversations worth tracking
4. **Emails from people already in the brain** — enrichment, not cold import

### Processing

For each email thread:
1. **Entity detection** — extract people, companies mentioned
2. **Update people pages** — add communication context to timeline
3. **Create meeting pages** — if the email is a meeting summary or follow-up
4. **Skip noise** — newsletters, automated notifications, marketing

### Filtering rules

**Auto-skip (never import):**
- noreply@, no-reply@, notifications@, support@, mailer-daemon@
- Unsubscribe-heavy senders (marketing)
- GitHub/Jira/Linear notification emails
- Calendar invites (already captured in Phase 3)

**Always import:**
- Direct emails from people in the brain
- Starred/flagged emails
- Emails the user sent (their words are highest-value signal)

## Phase 5: Conversation Exports (ChatGPT / Claude / Perplexity)

**Your thinking, captured.** AI conversation exports reveal what the user
was researching, building, and thinking about. This is original thinking
preserved in dialog form.

### Supported formats

- **ChatGPT:** Settings → Data Controls → Export → `conversations.json`
- **Claude:** Download from claude.ai conversation history
- **Perplexity:** Export from settings

### Processing

For each conversation:
1. **Assess significance** (1-5 scale):
   - 1 = Pure utility (how-tos, quick lookups) → skip or minimal page
   - 2 = Minor context → 1-paragraph note
   - 3 = Notable (reveals interests, building something) → full page
   - 4 = Important (deep personal processing, strategic thinking) → rich page
   - 5 = Defining (identity work, breakthrough insights) → full treatment
2. **Extract entities** — people, companies, concepts discussed
3. **Capture original thinking** — the user's exact phrasing is the signal.
   Never paraphrase.
4. **File by primary subject** — not in a "conversations/" dump. A conversation
   about a person goes to people/, about a concept goes to concepts/, etc.

### Quality rule

Only import conversations rated 3+. The brain is for signal, not noise.

## Phase 6: X/Twitter Archive

**Your public positions and engagement patterns.** Twitter reveals what the user
thinks, who they engage with, and what ideas they're developing publicly.

### Data sources

1. **Twitter data export** (Settings → Your Account → Download Archive)
   - Contains all tweets, likes, DMs, bookmarks
2. **Live API** (if available) — recent tweets and engagement
3. **Bookmarks** — curated signal, high value

### Brain structure

```
brain/media/x/{handle}/
├── x-log.md                     ← compiled truth (themes, voice, key threads)
├── daily/YYYY-MM-DD.md          ← daily tweet log
├── monthly/YYYY-MM.md           ← monthly rollup
└── bookmarks/                   ← saved/bookmarked content
```

### Processing

- **Original tweets** → capture with full context, extract entities
- **Quote tweets** → capture the user's commentary + the source tweet
- **Threads** → reconstruct as a single narrative
- **Bookmarks** → high-signal curation, import with tags
- **Likes** — low signal, skip unless the user wants them

## Phase 7: File Archives

**Historical documents, old writing, photos with metadata.** This is the long tail —
less structured but potentially very high value (old journals, letters, early writing).

Delegate to the `archive-crawler` skill. It handles:
- Crawling directory structures
- Filtering for high-value content (user's own writing, not installers)
- Text extraction from PDFs, images (OCR), documents
- Entity extraction and brain page creation

> **Safety gate:** Archive crawling can be slow and create many pages.
> archive-crawler is a skill, not a CLI command — it refuses to run without an
> explicit `archive-crawler.scan_paths:` allow-list in `gbrain.yml`. Add the
> archive path to the allow-list, run the skill's scan pass first, and show the
> user the manifest before proceeding with full ingestion.

**Supported sources:**
- Local directories (Dropbox sync folder, Google Drive, old hard drives)
- Cloud storage (Backblaze B2, S3) via mounted paths
- Email archives (PST, mbox, EML, Google Takeout)
- Data exports (LinkedIn, Facebook, etc.)

## Phase 8: Meeting Transcripts

**Deep relationship context from recorded calls.** If the user has a meeting
recording service (Circleback, Otter, Fireflies, Read.ai), import recent
transcripts.

Delegate to `meeting-ingestion` skill. Key rules:
- Always pull the **complete transcript**, not just the AI summary
- Entity propagation is MANDATORY — every attendee gets a timeline update
- A meeting is NOT fully ingested until all entity pages are updated

## Post-Bootstrap Checklist

After completing available phases:

1. **Verify brain health:**
   ```bash
   gbrain doctor --json
   gbrain stats
   ```

2. **Test retrieval:**
   ```bash
   gbrain query "who do I meet with most often?"
   gbrain query "what am I working on?"
   gbrain search "<person from contacts>"
   ```

3. **Offer live sync** (if not already set up) as its own yes/no. For each
   source, say how often it runs and what each run can spend (embedding and
   model extraction), and schedule only the ones the user agrees to:
   - Calendar: daily
   - Email: periodic sweep (4-8 hours)
   - X: daily ingest
   - Brain repo: `gbrain sync --repo <path>` every 5-30 minutes. A managed brain
     (`gbrain sources writer status --json` shows `"mode": "managed"`) refuses
     that line: use the managed recipe in `skills/cron-scheduler/SKILL.md`
     ("Managed brain") with `--source <id>`, e.g.
     `gbrain sources refresh <id>; gbrain sync --source <id> --no-pull --hard-deadline 13m`
     every 15 minutes on the owner host.

4. **Check the state file** (`cold-start-state.json` in the brain's config
   directory, written by the snippet in Phase 1); it should look like:
   ```json
   {
     "started": "2026-01-15T10:00:00+00:00",
     "phases_completed": [1, 2, 3, 4],
     "phases_skipped": [6, 7],
     "next_phase": 5
   }
   ```

5. **Tell the user what to do next:**
   > "Your brain has N pages across people, calendar, email, and conversations.
   > Live sync runs for [the sources you agreed to]. From here:
   > - The **signal-detector** captures entities from every conversation
   > - The **briefing** skill can compile daily context
   > - The **daily-task-prep** skill handles day planning
   > - Say 'enrich [person]' to deep-dive any contact"

## When it fails

Follow the [agent operator protocol](../conventions/agent-operator-protocol.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- Every import phase is a user choice: when a command exits 3 (`confirmation_required`) or prints an `[AGENT]` ask, relay the `[SHOW USER]` block and wait; do not chain phases with `--yes`.
- `gbrain google setup` prints `[SHOW USER]` steps: relay them verbatim and wait for the user to finish the consent click. Credential errors carry their own `fix`; follow it.
- The first `gbrain query` after an import is empty with a degraded notice: embeddings are off or still backfilling, so the import may have worked. Check `gbrain doctor --json` before telling the user the import failed.

## Anti-Patterns

- **Giving the agent raw OAuth tokens.** This is the #1 anti-pattern. An agent with
  raw Gmail/Calendar tokens is an uncontrolled attack surface — one prompt injection
  and your entire Google account is exposed. Use one of the Phase 0 paths:
  gbrain's Google connector, an offline export, or the host's credential
  gateway. Never ask the user to paste a token.
- **Bulk importing everything without filtering.** The brain is for signal, not noise.
  Filter out automated senders, marketing emails, utility conversations.
- **Importing without entity cross-linking.** Every import should detect entities and
  update existing brain pages. Isolated imports don't compound.
- **Not gating on user consent.** Every phase should be presented as a choice. The user
  may not want their DMs or therapy conversations imported.
- **Importing everything at significance 1.** Not every conversation is worth a brain
  page. Use the significance scale and skip utility content.
- **Creating people pages for automated senders.** Sentry, GitHub notifications,
  newsletter platforms are not people. Filter by the rules in Phase 4.

## Resume Protocol

If the session is interrupted:

1. Read `cold-start-state.json` in the brain's config directory (`$GBRAIN_HOME/.gbrain/`, or `~/.gbrain/` when `GBRAIN_HOME` is unset)
2. Skip completed phases
3. Resume from `next_phase`
4. The user doesn't have to repeat credential setup or re-import completed sources

## Output Format

After each phase:

```
PHASE N COMPLETE: [source name]
================================

Pages created: N
Pages updated: N
Entities linked: N
Time elapsed: N min

Sample pages:
- people/jane-smith.md (created — 3 emails, 5 meetings)
- companies/acme-corp.md (updated — 2 new employees linked)

Next: Phase N+1 — [description]. Ready to proceed?
```

## Tools Used

- `search` — check for existing pages before creating
- `query` — hybrid search for entity deduplication
- `get_page` — read existing pages for merge decisions
- `put_page` — create and update brain pages
- `add_link` — cross-reference entities
- `add_timeline_entry` — record events on entity timelines
- `sync_brain` — sync changes to the index after each phase
