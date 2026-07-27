---
name: cold-start
version: 1.0.0
description: |
  Day-one data bootstrapping for a new brain. Sequences the highest-leverage
  data sources to go from empty brain to useful brain in one session. Uses
  ClawVisor for safe credential handling — the agent never holds raw API keys.
  Covers Gmail import, calendar sync, contacts seeding, X/Twitter archive,
  conversation imports, and file archives.
  Use when a user has just finished gbrain setup and asks "now what?"
triggers:
  - "cold start"
  - "fill my brain"
  - "bootstrap brain"
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
- **Google/social API access goes through ClawVisor.** The agent never holds raw OAuth
  tokens or API keys. This is a safety requirement, not a preference. ClawVisor vaults
  credentials, enforces task-scoped authorization, logs every API call, and requires
  human approval for destructive operations. If the user doesn't want ClawVisor, the
  only safe alternative is offline file exports (Google Takeout, Twitter archive download).
- Each phase is independently valuable — the user can stop after any phase and still
  have a useful brain.
- Progress is tracked in `~/.gbrain/cold-start-state.json` so interrupted sessions
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
| 5 | Conversations (ChatGPT/Claude exports) | Your thinking, questions, mental models | 15 min | 10-100 |
| 6 | X/Twitter archive | Your public positions, takes, engagement patterns | 20 min | 30-365 |
| 7 | File archives (Dropbox/Drive/local) | Historical documents, old writing, photos | 30+ min | varies |
| 8 | Meeting transcripts (Circleback/etc.) | Deep relationship context from recorded calls | 20 min | 10-50 |

## Phase 0: ClawVisor Setup (Required for API Access)

> **Safety boundary:** An AI agent with raw OAuth tokens to your Gmail, Calendar,
> and Contacts is an uncontrolled attack surface. One prompt injection, one
> malicious tool call, and your entire Google account is exposed. ClawVisor
> eliminates this risk class entirely.

[ClawVisor](https://clawvisor.com) is a credential gateway that sits between the
agent and your APIs. The agent never sees your credentials — ClawVisor injects
them at request time, enforces policies, and logs everything.

**What ClawVisor gives you:**
- **Credential vaulting** — agent sees shadow tokens, never real secrets
- **Task-scoped authorization** — each workflow declares exactly what it needs
- **Audit trail** — every API call logged with metadata (who, what, when)
- **Human approval gates** — destructive operations (send email, modify calendar)
  require your explicit approval
- **Multi-service** — Gmail, Calendar, Contacts, Drive, GitHub, iMessage from one gateway
- **Revocation** — disable the agent's access in one click, no token rotation needed

**Setup (15 min):**
1. Sign up at [app.clawvisor.com](https://app.clawvisor.com)
2. Create an agent in the dashboard, copy the agent token
3. Set environment variables:
   ```bash
   gbrain config set clawvisor_url "https://app.clawvisor.com"
   gbrain config set clawvisor_agent_token "<token>"
   ```
4. Activate Google services (Gmail, Calendar, Contacts) in the dashboard
5. Create a standing task with expansive scope:
   > "Full brain bootstrapping: read emails, calendar events, and contacts to
   > populate knowledge base. List, read, and search across all connected accounts."
6. Save the standing task ID:
   ```bash
   gbrain config set clawvisor_task_id "<task_id>"
   ```

**Critical scoping rule:** Be expansive in task purposes. "Email triage" gets
rejected by intent verification. "Full executive assistant email management
including inbox triage, searching by any criteria, reading emails, tracking
threads" works. The intent model uses the purpose to judge each request.

### If the user declines ClawVisor

Do NOT fall back to direct OAuth. Instead, skip Phases 2-4 (Contacts, Calendar,
Gmail) and proceed with offline-only imports:

- **Phase 1** (markdown/Obsidian) — works without any API access
- **Phase 5** (conversation exports) — works from downloaded JSON files
- **Phase 6** (X/Twitter) — works from downloaded archive
- **Phase 7** (file archives) — works from local files
- **Phase 8** (meeting transcripts) — works from exported transcripts

Tell the user:
> "No problem. We'll skip the Google imports for now and work with file-based
> sources. You can set up ClawVisor anytime to unlock Contacts, Calendar, and
> Gmail imports safely."

**Do NOT offer direct OAuth as an alternative.** An agent holding raw Google
tokens is a security liability. The skill should not teach agents to store
credentials they shouldn't have.

## Phase 1: Existing Markdown / Obsidian Import

**The highest-leverage first import.** If the user already has a notes system, this
is hundreds or thousands of structured pages ready to go.

### Discovery

```bash
echo "=== Markdown Repository Discovery ==="
for dir in /data/* ~/git/* ~/Documents/* ~/notes/* ~/obsidian/* 2>/dev/null; do
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
# For Obsidian vaults, use the migrate skill for proper wikilink handling
gbrain migrate --from obsidian --path /path/to/vault

# For plain markdown directories
gbrain import /path/to/dir --no-embed --workers 4

# Verify
gbrain stats
gbrain search "<topic from the imported data>"
```

### Post-import

- Run link extraction: `gbrain extract links --source db`
- Run timeline extraction: `gbrain extract timeline --source db`
- Start embeddings: `gbrain embed --stale` (runs in background)

> **Track progress:**
> ```bash
> echo '{"phase_1_complete": true, "pages_imported": N}' > ~/.gbrain/cold-start-state.json
> ```

## Phase 2: Google Contacts → People Pages

**Seeds the people/ directory.** Every person in your contacts becomes a brain page
with name, email, phone, company, and notes. This is the foundation that all other
imports build on — when Gmail references "john@acme.com", the brain already knows
who John is.

### Via ClawVisor

```javascript
// Fetch all contacts
const contacts = await clawvisor('google.contacts', 'list_contacts', {
  limit: 1000,
  fields: 'names,emailAddresses,phoneNumbers,organizations,biographies'
});
```

### Via direct Google People API

```bash
curl -s -H "Authorization: Bearer $GOOGLE_TOKEN" \
  "https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations,biographies&pageSize=1000"
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

```javascript
// Via ClawVisor — query ALL calendar accounts
const accounts = ['primary@gmail.com', 'work@company.com'];
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
1. Look up each attendee in the brain (they should exist from Phase 2)
2. Add a timeline entry to their page: met at [event title] on [date]
3. If an attendee has no brain page and appears in 3+ events, create one
4. Link attendees who appear in the same meeting

## Phase 4: Gmail (Recent Threads)

**Relationship context and active threads.** Email reveals organizational
relationships, ongoing conversations, and communication patterns.

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

> **Safety gate:** Archive crawling can be slow and create many pages. Always start
> with a scan-only pass:
> ```bash
> gbrain archive-crawler --scan-only --path /path/to/archive
> ```
> Show the user the manifest before proceeding with full ingestion.

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

3. **Set up live sync** (if not already):
   - Calendar: daily cron
   - Email: periodic sweep (4-8 hours)
   - X: daily ingest
   - Brain repo: `gbrain sync --repo <path>` every 5-30 minutes

4. **Track state:**
   ```json
   // ~/.gbrain/cold-start-state.json
   {
     "started": "2026-01-15T10:00:00Z",
     "credential_gateway": "clawvisor",
     "phases_completed": [1, 2, 3, 4],
     "phases_skipped": [6, 7],
     "total_pages_created": 847,
     "total_entities_linked": 1203,
     "next_phase": 5
   }
   ```

5. **Tell the user what to do next:**
   > "Your brain has N pages across people, calendar, email, and conversations.
   > Live sync is configured for [sources]. From here:
   > - The **signal-detector** captures entities from every conversation
   > - The **briefing** skill can compile daily context
   > - The **executive-assistant** pattern handles email triage
   > - Say 'enrich [person]' to deep-dive any contact"

## Anti-Patterns

- **Giving the agent raw OAuth tokens.** This is the #1 anti-pattern. An agent with
  raw Gmail/Calendar tokens is an uncontrolled attack surface — one prompt injection
  and your entire Google account is exposed. Use ClawVisor. If the user declines
  ClawVisor, skip to offline imports. Never offer direct OAuth as a fallback.
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

1. Read `~/.gbrain/cold-start-state.json`
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
