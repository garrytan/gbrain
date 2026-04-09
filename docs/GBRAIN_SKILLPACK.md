# GBrain Skillpack: Reference Architecture for AI Agents

## 1. What This Document Is

This is a reference architecture for how a production AI agent uses gbrain as its
knowledge backbone. It is based on patterns from a real deployment with 14,700+ brain
files, 40+ skills, and 20+ cron jobs running continuously.

This is not a tutorial. It is a pattern book. Here's what works, here's why.

**The memex vision, realized.** Vannevar Bush described the memex in "As We May
Think" (1945): a device where an individual stores all their books, records, and
communications, mechanized so it may be consulted with exceeding speed and flexibility.
GBrain is that device. A personal knowledge store with full provenance trails, hybrid
search across everything you've ever read, said, or thought, and an AI agent that
maintains it while you sleep. Bush imagined trails of association linking items together.
GBrain has typed links, backlinks, and graph traversal. Bush imagined a scholar building
a trail through a body of knowledge. GBrain's compiled truth pattern IS that trail,
continuously rewritten as new evidence arrives.

The key difference from Bush's vision: the memex was passive (you had to build the
trails). GBrain is active. The agent detects entities, enriches pages, creates
cross-references, and maintains compiled truth automatically. You don't build the
memex. The memex builds itself.

---

## 2. The Brain-Agent Loop

The core read-write cycle that makes the brain compound over time:

```
Signal arrives (message, meeting, email, tweet, link)
  |
  v
Detect entities (people, companies, concepts, original thinking)
  |
  v
READ: Check brain first (gbrain search, gbrain get)
  |
  v
Respond with context (brain makes every answer better)
  |
  v
WRITE: Update brain pages (new info compiled into existing pages)
  |
  v
Sync: gbrain indexes changes (available for next query)
  |
  v
(next signal arrives — agent is now smarter than last time)
```

Every signal that flows through your agent should touch the brain in both directions.
Read before responding. Write after learning something new. The next time that person,
company, or concept comes up, the agent already has context.

The brain almost always has something. External APIs fill gaps — they don't start
from scratch.

An agent without this loop answers from stale context every time. An agent with it gets
smarter with every conversation, every meeting, every email. Six months in, the
compounding is visible: the agent knows more about your world than you can hold in
working memory, because it never forgets and it never stops indexing.

The loop has two invariants:

1. **Every READ improves the response.** If you answered a question about a person
   without checking their brain page first, you gave a worse answer than you could have.
2. **Every WRITE improves future reads.** If a meeting transcript mentioned new
   information about a company and you didn't update the company page, you created a
   gap that will bite you later.

---

## 3. Entity Detection -- Run It on Every Message

Spawn a lightweight sub-agent on EVERY inbound message. Use a cheap, fast model
(e.g. Claude Sonnet). The sub-agent captures two things with equal priority:

### Original Thinking (PRIMARY)

The user's ideas, observations, theses, frameworks, and philosophical riffs. This is the
highest-value signal in the entire system. Original thinking becomes essays, talks,
leadership philosophy, strategic insight. It compounds.

**Capture the user's EXACT phrasing.** The language IS the insight. "The
ambition-to-lifespan ratio has never been more broken" captures something that
"tension between ambition and mortality" doesn't. Don't clean it up. Don't paraphrase.

Route by authorship:

| Signal | Destination |
|--------|-------------|
| User generated the idea | `brain/originals/{slug}.md` |
| World concept they reference | `brain/concepts/{slug}.md` |
| Product or business idea | `brain/ideas/{slug}.md` |
| Personal reflection or pattern | `brain/personal/reflections/` |

**What counts:** Original observations about how the world works, novel connections
between disparate things, frameworks and mental models, pattern recognition moments,
hot takes with reasoning, metaphors that reveal new angles.

**What doesn't count:** Routine operational messages ("ok", "do it"), pure questions
without embedded observations, echoing back something the agent said.

### Entity Mentions (SECONDARY)

People, companies, media references. For each:

1. Check if brain page exists (`gbrain search "name"`)
2. If no page and entity is notable: create it, enrich it
3. If thin page: spawn background enrichment
4. If rich page: load it silently for context
5. For new facts about existing entities: append to timeline

### Rules

- Fire on EVERY message. No exceptions unless purely operational.
- Don't block the conversation. Spawn and forget.
- User's direct statements are the HIGHEST-authority signal.
- **Iron law: back-link FROM entity pages TO the source that mentions them.** An
  unlinked mention is a broken brain. Format: append to their Timeline or See Also:
  `- **YYYY-MM-DD** | Referenced in [page title](path/to/page.md) -- context`

---

## 3b. The Originals Folder -- Capturing Intellectual Capital

Most knowledge systems capture WHAT YOU FOUND (articles, meetings, people). The
originals folder captures WHAT YOU THINK.

When the user generates an original observation, thesis, framework, or hot take, the
agent captures it verbatim in `brain/originals/`. This is the highest-value content
in the entire brain.

**The authorship test:**

- User generated the idea? -> `originals/{slug}.md`
- User's unique synthesis of someone else's ideas? -> `originals/` (the synthesis is original)
- World concept someone else coined? -> `concepts/{slug}.md`
- Product or business idea? -> `ideas/{slug}.md`

**Naming:** Use the user's own language for the slug. `meatsuit-maintenance-tax` not
`biological-needs-maintenance-overhead`. The vividness IS the concept.

**Cross-link originals to:** people who shaped the thinking, companies where it played
out, meetings where it was discussed, books and media that influenced it, other
originals it connects to (ideas form clusters). An original without cross-links is a
dead original. The connections ARE the intelligence.

Over time, the originals folder becomes a searchable archive of the user's intellectual
output, organized by topic. This is the memex at its most powerful: not just remembering
what you read, but remembering what you THOUGHT about what you read.

---

## 4. The Brain-First Lookup Protocol

Before calling ANY external API to research a person, company, or topic:

```
1. gbrain search "name"     -- keyword match, fast, works day one
2. gbrain query "what do we know about name"  -- hybrid search, needs embeddings
3. gbrain get <slug>         -- direct page read when you know the slug
4. External APIs as FALLBACK only
```

The brain almost always has something. Even a timeline entry from three months ago
is better context than starting from scratch with a web search.

For each entity found: load compiled truth + recent timeline entries before responding.
The compiled truth section gives you the state of play in 30 seconds. The timeline
gives you what changed recently.

**This is mandatory.** An agent that calls Brave Search before checking the brain is
wasting money and giving worse answers. The brain has context that no external API
can provide: relationship history, the user's own assessments, meeting transcripts,
cross-references to other entities.

---

## 5. Enrichment Pipeline -- 7-Step Protocol

When to enrich: entity mentioned in conversation, meeting attendees, email threads,
social interactions, new contacts, whenever the brain page is thin or missing.

### Tier System

Scale API spend to importance. Don't blow 20 API calls on a passing mention.

| Tier | Who | Effort | API Calls |
|------|-----|--------|-----------|
| **Tier 1** | Key people and companies: inner circle, business partners, portfolio companies | Full pipeline, ALL data sources | 10-15 |
| **Tier 2** | Notable: people you interact with occasionally | Web search + social + brain cross-reference | 3-5 |
| **Tier 3** | Minor mentions: everyone else worth tracking | Brain cross-reference + social lookup if handle known | 1-2 |

### The 7 Steps

**Step 1: Identify entities.** From the incoming signal (meeting, email, tweet), extract
people names, company names, and what they're associated with.

**Step 2: Check brain state.** Does a page exist? If yes, read it -- you're on the
UPDATE path. If no, you're on the CREATE path. Check `gbrain search` first.

**Step 3: Extract signal from source.** Don't just pull facts -- pull texture:

- What opinion did they express? -> What They Believe
- What are they building or shipping? -> What They're Building
- Did they express emotion? -> What Makes Them Tick
- Who did they engage with? -> Network / Relationship
- Is this a recurring topic? -> Hobby Horses
- What did they commit to? -> Open Threads
- What was their energy? -> Trajectory

**Step 4: Data source lookups.** For CREATE or thin pages, run structured lookups.
The order matters -- stop when you have enough signal for the entity's tier.

Priority order:

1. **Brain cross-reference** (free, highest-value -- always first): `gbrain search "name"` to find mentions across meetings, other people pages, company pages.
2. **Web search** via [Brave](https://brave.com/search/api/) or [Exa](https://exa.ai): background, press, talks, funding.
3. **X/Twitter deep lookup** (enterprise API or scraping): beliefs, building, hobby horses, network, trajectory.
4. **People enrichment:** [Crustdata](https://crustdata.com) (LinkedIn data), [Happenstance](https://happenstance.com) (web research, career arcs).
5. **Company/funding data:** [Captain](https://captaindata.co) API (Pitchbook-grade funding, valuation, team data).
6. **Meeting history:** [Circleback](https://circleback.ai) (transcript search, attendee lookup).
7. **Contact data** (Google Contacts, CRM sync).

**X/Twitter lookup is underrated.** When you have someone's handle, their tweets are
the single best source for: what they believe (opinions expressed unprompted), what
they're building (shipping announcements), hobby horses (recurring topics), who they
engage with (reply patterns, amplification), and trajectory (posting frequency, tone
shifts). This goes into the brain page's "What They Believe" and "Hobby Horses" sections.

**Step 5: Save raw data.** Every API response gets saved to a `.raw/` sidecar alongside
the brain page. JSON with `sources.{provider}.fetched_at` and `.data`. Overwrite on
re-enrichment, don't append.

**Step 6: Write to brain.** CREATE path: use the page template from your brain's
schema, fill compiled truth from all data gathered, add first timeline entry. UPDATE
path: append timeline, update compiled truth if the new signal materially changes the
picture. Flag contradictions -- don't silently resolve them.

**Step 7: Cross-reference.** After updating a person page: update their company page,
update deal pages, add back-links. After updating a company page: update founder pages,
update deal pages. Every entity page should link to every other entity page that
references it.

### People Pages

A person page isn't a LinkedIn profile. It's a living portrait:

- **Executive Summary** -- How do you know them? Why do they matter?
- **State** -- Role, company, relationship, key context
- **What They Believe** -- Ideology, worldview, first principles
- **What They're Building** -- Current projects, features shipped
- **What Motivates Them** -- Ambition drivers, career arc
- **Assessment** -- Strengths, weaknesses, net read
- **Trajectory** -- Ascending, plateauing, pivoting, declining?
- **Relationship** -- History, temperature, open threads
- **Contact** -- Email, phone, X handle, LinkedIn
- **Timeline** -- Reverse chronological, append-only, never rewritten

Facts are table stakes. Texture is the value.

---

## 6. Compiled Truth + Timeline Pattern

Every brain page has a horizontal rule separating two zones:

**Above the line: Compiled truth.** A synthesis that represents the current state of
play. If you read only the compiled truth section, you know everything you need. This
gets rewritten when new evidence changes the picture.

**Below the line: Timeline.** Append-only log of every signal, in reverse chronological
order. Never rewritten, never deleted. This is the evidence base. Every compiled truth
claim should be traceable to one or more timeline entries.

```markdown
## Executive Summary
One paragraph. How do you know them, why do they matter.

## State
Role, company, key numbers, relationship status.

## What They Believe
Their worldview, first principles, hills they die on.

## What They're Building
Current projects, recent launches, what's next.

## Assessment
Strengths, weaknesses, your net read on this person.

## Trajectory
Where they're headed. Ascending, plateauing, pivoting?

## Relationship
History with you. Last interaction. Open threads.

## Contact
Email, phone, X handle, LinkedIn.

---

## Timeline

- **2026-04-07** | Met at Team Sync. Discussed new product launch. Seemed energized
  about the pivot. [Source: Meeting notes "Team Sync" #12345, 2026-04-07 2:00 PM PT]
- **2026-04-03** | Mentioned in email thread re Q2 planning. Taking lead on ops.
  [Source: email from Sarah Chen re Q2 board deck, 2026-04-03 10:30 AM PT]
- **2026-03-15** | First meeting. Intro from Pedro. Strong technical background.
  [Source: User, direct message, 2026-03-15 3:00 PM PT]
```

The compiled truth pattern works because the agent rewrites the synthesis as new
evidence arrives, but the evidence itself is immutable. Six months of timeline entries
compress into a one-paragraph assessment that's always current.

**GBrain integration:** `gbrain query` weights compiled truth higher than timeline
entries in search results, so the freshest synthesis surfaces first.

---

## 7. Source Attribution -- Every Fact Needs a Citation

This is not a suggestion. It is a hard requirement. Every fact written to a brain page
needs an inline `[Source: ...]` citation with full provenance.

### Format

`[Source: {who}, {channel/context}, {date} {time} {tz}]`

### Examples by Category

**Direct statements:**
`[Source: User, direct message, 2026-04-07 12:33 PM PT]`

**Meetings:**
`[Source: Meeting notes "Team Sync" #12345, 2026-04-03 12:11 PM PT]`

**API enrichment:**
`[Source: Crustdata LinkedIn enrichment, 2026-04-07 12:35 PM PT]`

**Social media (MUST include full URL):**
`[Source: X/@pedroh96 tweet, product launch, 2026-04-07](https://x.com/pedroh96/status/...)`

**Email:**
`[Source: email from Sarah Chen re Q2 board deck, 2026-04-05 2:30 PM PT]`

**Workspace:**
`[Source: Slack #engineering, Keith re deploy schedule, 2026-04-06 11:45 AM PT]`

**Web research:**
`[Source: Happenstance research, 2026-04-07 12:35 PM PT]`

**Published media:**
`[Source: [Wall Street Journal, 2026-04-05](https://wsj.com/...)]`

**Funding data:**
`[Source: Captain API funding data, 2026-04-07 2:00 PM PT]`

### Why This Matters

Six months from now, someone reads a brain page and can trace every single fact back to
where it came from. "User said it" isn't enough. WHERE, ABOUT WHAT, WHEN.

### The Rule Most Agents Miss

Source attribution applies to compiled truth AND timeline. The compiled truth section
(above the line) isn't exempt from citations just because it's a synthesis. Every claim
needs a source. "Pedro co-founded Brex" needs `[Source: ...]` just as much as a
timeline entry does.

### Tweet URLs Are Mandatory

A tweet reference without a URL is a broken citation. Format:
`[Source: X/@handle tweet, topic, date](https://x.com/handle/status/ID)`.
This is a real production problem: hundreds of brain pages end up with broken tweet
citations when the URL is omitted.

### Source Hierarchy for Conflicting Information

1. User's direct statements (highest authority)
2. Primary sources (meetings, emails, direct conversations)
3. Enrichment APIs (Crustdata, Happenstance, Captain)
4. Web search results
5. Social media posts

When sources conflict, note the contradiction in compiled truth with both citations.
Don't silently pick one.

---

## 8. Meeting Ingestion

Meetings are the richest signal source in the entire system. Every meeting produces
entity updates across multiple brain pages.

### Transcript Source

[Circleback](https://circleback.ai) or any meeting recording service with API access.
The key requirement: speaker diarization (who said what) and webhook support.

### Schedule

Run as a cron job. A reasonable cadence: 3x/day (10 AM, 4 PM, 9 PM) to catch new
meetings throughout the day.

### After Every Meeting

**1. Pull the full transcript.** Always pull the complete transcript, not just the AI
summary. AI-generated summaries hallucinate framing -- they editorialize what was "agreed"
or "decided" when no such agreement happened. The transcript is ground truth.

**2. Create the meeting page.** Write to `brain/meetings/YYYY-MM-DD-short-description.md`
with the agent's OWN analysis:

- **Above the bar:** Agent's summary reframed through the user's priorities. What matters
  to YOU, not a generic meeting recap. Flag surprises, contradictions, and implications.
  Name real decisions and commitments (not performative ones). Call out what was left
  unsaid or unresolved.
- **Below the bar:** Full diarized transcript (append-only evidence base). Format:
  `**Speaker** (HH:MM:SS): Words.`

**3. Propagate to entity pages (MANDATORY).** This is the step most agents skip. A
meeting is NOT fully ingested until every entity page has been updated:

- **People pages:** Update State, append Timeline with meeting-specific insights
- **Company pages:** Update State with new metrics, status, decisions, feedback
- **Deal pages:** Update State with new terms, status, deadlines

**4. Extract action items** into your task list.

**5. Commit and sync.** `gbrain sync` so the new pages are immediately searchable.

### Back-Linking

Meeting page links to attendee pages. Attendee pages link back to meeting with context.
The graph is bidirectional. Always.

---

## 9. Reference Cron Schedule

A production agent runs 20+ recurring jobs that interact with the brain. Here is a
generalized reference schedule:

| Frequency | Job | Brain Interaction |
|-----------|-----|-------------------|
| Every 30 min | Email monitoring | `gbrain search` sender, update people pages |
| Every 30 min | Message monitoring | `gbrain search` sender, entity detection |
| Hourly | Social media ingestion | Create/update media pages, entity extraction |
| Hourly | Workspace scanning | Update project pages, flag mentions |
| 3x/day | Meeting processing | Full ingestion pipeline (Section 8) |
| Daily AM | Morning briefing | `gbrain search` for calendar attendees, deal status, active threads |
| Daily AM | Task preparation | Pull today's tasks, cross-reference brain for context |
| Weekly | Brain maintenance | `gbrain doctor`, `gbrain embed --stale`, orphan detection |
| Weekly | Contacts sync | New contacts -> brain pages, enrichment pipeline |

### Quiet Hours Gate

Before sending any notification, check if it's quiet hours (e.g., 11 PM - 8 AM,
configure to your schedule). During quiet hours:

- Hold non-urgent notifications
- Merge held messages into the next morning briefing
- Only break quiet hours for genuinely urgent items (time-sensitive, would cause real
  damage if delayed)

### Travel-Aware Timezone Handling

The agent reads your calendar for flights, hotels, and out-of-office blocks to infer
your current location and timezone. All times shown in YOUR local timezone -- "4:42 AM
HT" in Hawaii, not "14:42 UTC" or "7:42 AM PT".

When you travel, cron jobs that would fire during your home-timezone waking hours but
hit your sleeping hours at the destination get held and folded into the next morning
briefing. No config change needed. The agent figures it out from your calendar.

This means: fly to Tokyo, land, sleep... wake up to a morning briefing that includes
everything your crons would have sent you at 2 PM Pacific (which was 3 AM Tokyo). Zero
missed signals, zero 3 AM pings.

Every cron job includes: quiet hours check, location/timezone awareness, sub-agent
spawning for heavy work.

---

## 10. Content and Media Ingestion

When the user shares a link, article, video, tweet, or document:

1. **Fetch and process** -- transcribe video, OCR PDF, parse article
2. **Save to brain** at `sources/` or `media/`
3. **Cross-reference** with existing brain pages (who's mentioned? what companies? what concepts?)
4. **Surface interesting angles** given the user's interests and worldview
5. **Commit and sync** -- `gbrain sync`

### YouTube Ingestion

YouTube is a first-class workflow, not an afterthought.

- Transcribe with speaker diarization via [Diarize.io](https://diarize.io) -- identifies
  WHO said WHAT, not just a wall of text
- Create brain page at `media/youtube/{slug}.md` with: title, channel, date, link,
  diarized transcript, agent's analysis
- Agent's analysis is the value add: what matters, key quotes attributed to specific
  speakers, connections to existing brain pages, implications
- Cross-reference: every person mentioned gets a back-link from their brain page to
  this video
- Over time, `media/` becomes a searchable archive of every video, podcast, talk, and
  interview the user has consumed, with the agent's commentary layered on top

### Social Media Bundles

Don't just save a tweet. Reconstruct the full context:

- Thread reconstruction (quoted tweets, replies in context)
- Linked articles fetched and summarized
- Engagement data (what resonated, what didn't)
- Entity extraction from the full bundle

### PDFs and Documents

OCR when needed, extract structured data, save to `sources/`. For books and long-form:
chapter summaries, key quotes with page numbers, cross-references to brain pages for
people and concepts mentioned.

---

## 11. Executive Assistant Pattern

The brain transforms basic EA work into contextual EA work. The difference between
"you have a meeting at 3" and "you have a meeting at 3 with Pedro -- last time you
discussed the Series B timeline, he was concerned about burn rate, here's the latest
from his company page."

### Email Triage

Before triaging any email: `gbrain search` for sender context. Load their brain page.
Now you know: who they are, your relationship history, what they care about, and what
open threads exist. The triage is informed, not mechanical.

### Meeting Prep

Before any meeting: `gbrain search` all attendees. Load relationship pages. Surface:
last interaction date, open threads, recent timeline entries, relevant deal status.
The user walks into every meeting already briefed.

### Scheduling

When scheduling: check brain for meeting frequency, last interaction, relationship
temperature. "You haven't met with Diana in 6 weeks and she has an open thread about
the Q3 launch" is a useful scheduling nudge.

### After Clearing Inbox

Update relevant brain pages with new information from email threads. Every email is a
signal. The brain should reflect what was learned.

---

## 12. The Three Search Modes

GBrain provides three distinct search modes. Use the right one for the job.

| Mode | Command | Needs Embeddings | Speed | Best For |
|------|---------|-----------------|-------|----------|
| **Keyword** | `gbrain search "name"` | No | Fastest | Known names, exact matches, day-one queries |
| **Hybrid** | `gbrain query "what do we know"` | Yes | Fast | Semantic questions, fuzzy matching, conceptual search |
| **Direct** | `gbrain get <slug>` | No | Instant | Loading a specific page when you know the slug |

### Progression

- **Day one:** Use keyword search (`gbrain search`). It works without embeddings and
  catches exact name matches.
- **After first embed:** Use hybrid search (`gbrain query`) for semantic questions.
  "Who do I know at fintech companies?" works here.
- **When you know the slug:** Use direct get (`gbrain get pedro-franceschi`). Instant,
  no search overhead.

### Token Budget Awareness

Search returns chunks, not full pages. Read the search excerpts first. Only use
`gbrain get <slug>` for the full page when the chunk confirms relevance.

- "Tell me about Pedro" -> `gbrain get pedro-franceschi` (you want the full page)
- "Did anyone mention the Series A?" -> search results are enough (scan chunks)
- "What's the latest on Brex?" -> search first, then get the company page if needed

### Precedence for Conflicting Information

1. User's direct statements (always wins)
2. Compiled truth sections (synthesized from evidence)
3. Timeline entries (raw signal, reverse chronological)
4. External sources (web search, APIs)

---

## 13. How GBrain Complements Agent Memory

A production agent has three layers of memory. All three should be consulted. They
serve different purposes.

| Layer | What It Stores | Examples | How to Access |
|-------|---------------|----------|---------------|
| **GBrain** | World knowledge -- facts about people, companies, deals, meetings, concepts, ideas | Pedro's company page, meeting transcripts, original theses, deal terms | `gbrain search`, `gbrain query`, `gbrain get` |
| **Agent memory** (`memory_search`) | Operational state -- preferences, architecture decisions, tool config, session continuity | "User prefers concise formatting", "Deploy to staging before prod", "ClawVisor task IDs" | `memory_search`, file reads |
| **Session context** | Current conversation window -- what was just said, what the user just asked | The last 20 messages, current task, immediate context | Already in context |

### When to Use Each

- **"Who is Pedro?"** -> GBrain (world knowledge about a person)
- **"How do I format messages for this user?"** -> Agent memory (operational preference)
- **"What did I just ask you to do?"** -> Session context (immediate)
- **"What happened in Tuesday's meeting?"** -> GBrain (meeting transcript + entity pages)
- **"Which API key goes where?"** -> Agent memory (tool configuration)

GBrain is for facts about the world. Agent memory is for how the agent operates.
Session context is for right now. Don't store operational preferences in GBrain. Don't
store people dossiers in agent memory.

---

## 14. Integration Setup Guides

Three integrations that make the agent real. Without these, the brain is a static
database. With them, it's alive.

### 14a. ClawVisor -- Secure Gateway to Google and iMessage

[ClawVisor](https://clawvisor.com) is a credential vaulting and authorization gateway.
The agent never holds API keys directly. ClawVisor enforces policies, manages
task-scoped authorization, and injects credentials at request time.

**Services:** Gmail (list, read, send, draft), Google Calendar (CRUD), Google Drive
(list, search, read), Google Contacts (list, search), Apple iMessage (list, read,
search, send), GitHub, Slack.

**Task-scoped authorization:** Every request must include a `task_id` from an approved
standing task. Tasks declare: purpose (verbose, 2-3 sentences), authorized actions with
expected use patterns, auto-execute flag, lifetime (standing vs ephemeral).

**Why this matters for GBrain:** The EA workflow needs Gmail (sender lookup before
triage), Calendar (meeting prep, attendee pages), Contacts (enrichment trigger), and
iMessage (direct instructions). ClawVisor gives the agent access without giving it
raw credentials.

**Setup:**

1. Create agent in ClawVisor dashboard, copy agent token
2. Set `CLAWVISOR_URL` and `CLAWVISOR_AGENT_TOKEN` in env
3. Activate services (Google, iMessage, etc.) in the dashboard
4. Create standing tasks with expansive scopes (narrow purposes cause false blocks)
5. Store standing task IDs in agent memory for reuse

**Critical scoping rule:** Be expansive in task purposes. "Full executive assistant
email management including inbox triage, searching by any criteria, reading emails,
tracking threads" works. "Email triage" gets rejected. The intent verification model
uses the purpose to judge whether each request is consistent -- if your purpose is
narrow, legitimate requests fail verification.

### 14b. Circleback -- Meeting Ingestion via Webhooks

[Circleback](https://circleback.ai) records meetings, generates transcripts with
speaker diarization, and fires webhooks on completion.

**Webhook setup:**

1. In Circleback dashboard -> Automations -> add webhook
2. URL: `{your_agent_gateway}/hooks/circleback-meetings`
3. Circleback provides a signing secret for HMAC-SHA256 signature verification
4. Store the signing secret in your webhook transform for verification

**Webhook payload:** Meeting JSON with id, name, attendees, notes, action items, full
transcript, calendar event context.

**Signature verification:** Header `X-Circleback-Signature` contains `sha256=<hex>`.
Verify with `HMAC-SHA256(body, signing_secret)`. Reject unverified webhooks.

**OAuth for API access:** Circleback uses dynamic client registration (OAuth 2.0).
Access tokens expire in ~24h, auto-refresh via refresh token. Store credentials in
agent memory.

**Flow:** Webhook fires -> transform validates signature + normalizes -> agent wakes ->
pulls full transcript via API -> creates brain meeting page -> propagates to entity
pages -> commits to brain repo -> `gbrain sync`.

### 14c. Quo (OpenPhone) -- SMS and Call Integration

[Quo](https://openphone.com) (formerly OpenPhone) provides business phone numbers with
SMS, calls, voicemail, and AI transcripts.

**Webhook setup:**

1. In Quo dashboard -> Integrations -> Webhooks
2. Register webhooks for: `message.received`, `call.completed`, `call.summary.completed`, `call.transcript.completed`
3. Point all to: `{your_agent_gateway}/hooks/quo-events`
4. Store registered webhook IDs in agent memory

**How inbound texts work:**

- Webhook fires with sender phone, message text, conversation context
- Agent looks up sender in brain by phone number
- Surfaces to user's messaging platform with sender identity + brain context
- Drafts reply for approval (never auto-replies without explicit permission)

**How inbound calls work:**

- `call.completed` fires -> if duration > 30s, fetch transcript + AI summary via API
- Ingest to brain (meeting-style page at `meetings/`)
- Update relevant people and company pages

**API auth:** Bare API key in `Authorization` header (no Bearer prefix).

**Key endpoints:** `POST /v1/messages` (send SMS), `GET /v1/messages` (list),
`GET /v1/call-transcripts/{id}`, `GET /v1/conversations`.

---

## 15. Five Operational Disciplines

These are the non-negotiable disciplines that separate a production agent from a demo.

### 1. Signal Detection on Every Message (MANDATORY)

Every inbound message triggers entity detection and original-thinking capture. No
exceptions. If the user thinks out loud and the brain doesn't capture it, the system
is broken. This is the #1 operational discipline.

### 2. Brain-First Lookup Before External APIs (MANDATORY)

`gbrain search` before Brave Search. `gbrain get` before Crustdata. The brain almost
always has something. External APIs fill gaps. An agent that reaches for the web before
checking its own brain is wasting money and giving worse answers.

### 3. Source Attribution on Every Brain Write (MANDATORY)

Every fact written to a brain page gets an inline `[Source: ...]` citation. No
exceptions. Compiled truth isn't exempt because it's a synthesis. Tweet URLs are
mandatory -- a tweet reference without a URL is a broken citation. The goal: six months
from now, every fact traces back to where it came from.

### 4. Iron Law Back-Linking (MANDATORY)

When a person or company with a brain page is mentioned in ANY brain file, that file
MUST be linked FROM the person or company's brain page. This is the connective tissue
of the brain. An unlinked mention is a broken brain. Every skill that writes to the
brain enforces this.

### 5. Durable Skills Over One-Off Work

If you do something twice, make it a skill + cron. The first time is discovery. The
second time is a system failure.

The development cycle:

1. **Concept** a process -- describe what needs to happen
2. **Run it manually for 3-10 items** -- see if the output is good
3. **Revise** -- iterate on quality, fix gaps, adjust the bar
4. **Codify into a skill** -- create a new skill or add to an existing one
5. **Add to cron** -- automate it so it runs without being asked

The skills should collectively cover every type of ingest event without overlap. If two
skills both try to create the same brain page, that's a coverage violation. Each entity
type and signal source should have exactly one owner skill.

---

## Appendix: GBrain CLI Quick Reference

Commands referenced in this document:

| Command | Purpose |
|---------|---------|
| `gbrain search "term"` | Keyword search across all brain pages |
| `gbrain query "question"` | Hybrid search (vector + keyword + RRF) |
| `gbrain get <slug>` | Read a specific brain page by slug |
| `gbrain sync` | Sync local markdown repo to gbrain index |
| `gbrain import <path>` | Import files into the brain |
| `gbrain embed --stale` | Re-embed pages with stale or missing embeddings |
| `gbrain stats` | Show brain statistics (page count, last sync, etc.) |
| `gbrain doctor` | Diagnose brain health issues |
| `gbrain doctor --json` | Machine-readable health check (for cron jobs) |
| `gbrain init` | Initialize a new brain database |

Run `gbrain --help` for the full command reference.

---

## 16. Deterministic Collectors -- Code for Data, LLMs for Judgment

When your agent keeps failing at a mechanical task despite repeated prompt fixes, stop
fighting the LLM. Move the mechanical work to code.

### The Pattern That Broke

We built an email triage system. The agent swept Gmail, classified emails by urgency,
and posted a digest to the user. One rule: every email item must include a clickable
`[Open in Gmail]` link so the user can act on it with one tap.

We put the rule in the skill file. We put it in MEMORY.md. We put it in the cron
prompt. We wrote "NO EXCEPTIONS" in all caps. We wrote "ZERO TOLERANCE" after the
fourth failure. The agent still dropped links -- on carry-forward reminders, on FYI
items, on "still awaiting" sections. The user asked five times. Each time we added
stronger language to the prompt.

The failure mode is probabilistic. The LLM understands the rule. It follows it for the
first 10 items. Then it gets sloppy on item 11, especially on items that are
re-surfaced from state rather than freshly pulled from the API. No amount of prompt
engineering fixes a 90%-reliable formatting task, because 90% reliability over 20 items
per sweep means you fail visibly about twice per day. That's enough to destroy trust.

### The Fix: Separate Deterministic from Analytical

```
┌─────────────────────────────┐     ┌──────────────────────────────┐
│  Deterministic Collector    │────▶│       LLM Agent              │
│  (Node.js / Python script)  │     │                              │
│                             │     │  • Read the pre-formatted    │
│  • Pull data from API       │     │    digest                    │
│  • Store structured JSON    │     │  • Classify items            │
│  • Generate links/URLs      │     │  • Add commentary            │
│  • Detect patterns (regex)  │     │  • Run brain enrichment      │
│  • Track state (seen/new)   │     │  • Draft replies             │
│  • Output markdown digest   │     │  • Surface to user           │
│                             │     │                              │
│  CODE — deterministic,      │     │  AI — judgment, context,     │
│  never forgets              │     │  creativity                  │
└─────────────────────────────┘     └──────────────────────────────┘
```

The collector handles everything mechanical:

- Pulling emails from Gmail (via credential gateway)
- Generating `[Open in Gmail](URL)` from message IDs -- **by code, not by LLM**
- Detecting signature requests (DocuSign/Dropbox Sign regex patterns)
- Tracking which messages are new vs. already seen (state file)
- Storing structured JSON with full metadata
- Generating a pre-formatted markdown digest with every link already embedded

The LLM reads the pre-formatted digest and does what LLMs are good at:

- Classifying urgency (requires understanding relationships, deadlines, context)
- Writing commentary ("this is the $110M acquisition thread, 7 days dropped")
- Running brain enrichment on notable entities (`gbrain search` + page updates)
- Drafting replies
- Deciding what to surface vs. filter

**The links are in the source data. The LLM can't forget them because it doesn't
generate them.**

### Implementation

The email collector follows the same architecture as the X/Twitter collector (a
deterministic data pipeline for social media monitoring):

```
scripts/email-collector/
├── email-collector.mjs     # No LLM calls, no external deps
├── data/
│   ├── state.json          # Last pull timestamp, known IDs, pending signatures
│   ├── messages/           # Structured JSON per day
│   │   └── 2026-04-09.json
│   └── digests/            # Pre-formatted markdown
│       └── 2026-04-09.md
```

Every stored message includes:

```json
{
  "id": "19d74109a811b9e7",
  "account": "work",
  "authuser": "garry@ycombinator.com",
  "from": "Alex Levy",
  "subject": "Re: Next Steps",
  "snippet": "Hey Garry, wanted to follow up on...",
  "timestamp": "2026-04-09T08:56:09Z",
  "is_unread": true,
  "is_noise": false,
  "is_signature": false,
  "gmail_link": "https://mail.google.com/mail/u/?authuser=garry@ycombinator.com#inbox/19d74109a811b9e7",
  "gmail_markdown": "[Open in Gmail](https://mail.google.com/mail/u/?authuser=garry@ycombinator.com#inbox/19d74109a811b9e7)"
}
```

The `gmail_link` and `gmail_markdown` fields are computed from `id` + `authuser` at
collection time. Three lines of code. Never wrong.

### Cron Integration

The email monitoring cron runs the collector first, then invokes the LLM:

```
1. node email-collector.mjs collect     → deterministic API pull, store JSON
2. node email-collector.mjs digest      → generate markdown with links baked in
3. node email-collector.mjs signatures  → list pending e-signature items
4. LLM reads digest + signatures        → classifies, enriches, posts to user
```

The collector runs in under 10 seconds. The LLM analysis takes 30-60 seconds. Total:
under 90 seconds for a full inbox sweep with brain enrichment.

### Where Else This Pattern Applies

The deterministic-collector pattern works for any recurring data pull where the LLM
was previously responsible for both fetching AND formatting:

| Signal Source | Collector Generates | LLM Adds |
|--------------|-------------------|----------|
| **Email** | Gmail links, sender metadata, signature detection | Urgency classification, enrichment, reply drafts |
| **X/Twitter** | Tweet links, engagement metrics, deletion detection | Sentiment analysis, narrative detection, content ideas |
| **Calendar** | Event links, attendee lists, conflict detection | Prep briefings, meeting context from brain |
| **Slack** | Channel links, thread links, mention detection | Priority classification, action item extraction |
| **GitHub** | PR/issue links, diff stats, CI status | Code review context, priority assessment |

The principle: if a piece of output MUST be present and MUST be formatted correctly
every time, generate it in code. If a piece of output requires judgment, context, or
creativity, generate it with the LLM. Don't ask the LLM to do both in the same pass.

### The Lesson

When an LLM keeps failing at a mechanical task despite repeated prompt fixes:

1. **Stop adding more prompt language.** You've already written "NO EXCEPTIONS" and
   "ZERO TOLERANCE." The LLM read it. The failure is probabilistic, not comprehension.
2. **Identify what's mechanical vs. analytical.** URL generation is mechanical.
   Classification is analytical. State tracking is mechanical. Commentary is analytical.
3. **Move the mechanical work to a script.** Node.js, Python, bash -- anything
   deterministic. No LLM calls, no external dependencies if possible.
4. **Feed the LLM pre-formatted data.** The script's output becomes the LLM's input.
   Links are already there. Metadata is already structured. The LLM just adds judgment.
5. **Wire it into your cron.** Script runs first (fast, cheap, reliable), then LLM
   reads the output (slower, expensive, creative).

This is not about the LLM being bad. It's about using the right tool for the right
job. Code is 100% reliable at string concatenation. LLMs are 90% reliable at string
concatenation but 10x better at understanding what an email means. Use both.
