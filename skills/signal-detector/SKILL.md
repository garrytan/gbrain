---
name: signal-detector
version: 1.1.0
description: |
  Always-on ambient signal capture. Fires on every inbound message to detect
  original thinking and entity mentions. Spawn as a cheap sub-agent in parallel,
  never block the main response.
triggers:
  - every inbound message (always-on)
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - concepts/
---

# Signal Detector — Ambient Brain Capture

Lightweight sub-agent that fires on every inbound message to capture TWO things
with EQUAL priority:

1. **Original thinking** — the user's ideas, observations, theses, frameworks
2. **Entity mentions** — people, companies, media references

Original thinking is AT LEAST as valuable as entity extraction. Ideas are the
intellectual capital. Entities are bookkeeping. Both compound over time.

## Contract

This skill guarantees:
- Fires on every message (no exceptions unless purely operational)
- Runs in parallel (spawned, never blocks main response)
- Captures ideas with the user's EXACT phrasing (no paraphrasing)
- Detects entity mentions and creates/enriches brain pages
- Logs a one-line summary of what was captured
- Back-links all entity mentions (Iron Law)
- Citations on every fact written

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every time this skill creates or updates a brain page that mentions a person or company:
1. Check if that person/company has a brain page
2. If yes → add a back-link FROM their page TO the page you just created/updated
3. Format: `- **YYYY-MM-DD** | Referenced in [page title](path) — brief context`
4. An unlinked mention is a broken brain.

## Phases

### Phase 1: Idea/Observation Detection (PRIMARY)

When the user expresses a novel thought, observation, thesis, or framework:
- If it's the user's **original thinking** (they generated it) → create/update `originals/{slug}`
- If it's a **world concept** they're referencing → create/update `concepts/{slug}`
- If it's a **product or business idea** → create/update `ideas/{slug}`

**Capture exact phrasing.** The user's language IS the insight. Don't paraphrase.

**Cross-linking (MANDATORY):** Every original MUST link to related people, companies,
meetings, and concepts. An original without cross-links is a dead original.

### Phase 2: Entity Detection (SECONDARY)

1. Extract entity mentions (people, companies, media titles)
2. For each entity:
   - `gbrain search "name"` — does a page exist?
   - If NO page → check notability. If notable, create page with enrichment.
   - If page exists but THIN → read it and supplement the missing facts
   - If page exists and RICH → do not overwrite the whole page. Rewrite only `## 当前状态` when the source changes the current role or status. Keep one current-state section. Do not stack the old state under the new one.
3. For a dated fact, call `add_timeline_entry` once for every entity that fact mentions. Use the same date, summary, and source on each of those pages. Timeline entries are append-only.

**Auto-link:** When you write or update a page that references a person, company,
project, or concept, `put_page` extracts the link from that page. Write the
relationship in the page. Do not wait for a later pass.

For entities mentioned together in one source, write the relation at the same
time as the entity. On the person page, put a Markdown link to the company or
project in the same sentence as the relationship (`works at`, `任职`, `founded`,
`负责`), and set frontmatter `company:` or `founded:` when the source says so.
On the company page, set `key_people:` when the source names the people. The
auto-link uses the active schema pack, the target page type, and the Chinese
or English context to choose the relationship type. Dream entity capture does
not have `add_link`; the page text is the write.

**State:** `## 当前状态` is the current understanding only. On every update,
rewrite that section. Do not append a second one. Someone who has left a
company stays out of the current state; the departure itself belongs on the
timeline.

**Timeline merge:** the same dated event goes on every mentioned entity. If
张三 joins 星河科技 to work on 智慧水务, that one date and summary is added to
张三, 星河科技, and 智慧水务. Each entry cites its source. Do not edit older
timeline rows.

Every entity page must also link back to the source page. A mention with no
link is incomplete. The Iron Law line is `- **YYYY-MM-DD** | Referenced in [page title](path) — brief context`. Facts written on the page carry a `[Source: ...]` citation.

Ambient capture stays off unless the user explicitly enables it. A user-started
deep organize is that authorization for the current run only.

### Phase 3: Signal Logging

Always log a one-line summary:
- `Signals: 0 ideas, 0 entities, 0 facts (skipped: operational)`
- `Signals: 1 idea (captured → originals/x), 2 entities (enriched → people/y, companies/z)`

This makes the ambient capture loop debuggable.

## Output Format

No visible output to the user. This skill runs silently in the background.
The output is brain pages created/updated and the signal log line.

## Anti-Patterns

- Blocking the main response to wait for signal detection to complete
- Paraphrasing the user's original thinking instead of capturing exact phrasing
- Creating pages for non-notable entities (one-off mentions)
- Skipping back-links after creating/updating pages
- Appending a second current-state section instead of rewriting `## 当前状态`
- Writing a dated event onto only one of the entities it names
- Running on purely operational messages ("ok", "thanks", "do it")

## Tools Used

- `search` — check if entity page exists
- `query` — semantic search for related context
- `get_page` — load existing entity pages
- `put_page` — create/update brain pages
- `add_link` — cross-reference entities
- `add_timeline_entry` — record events on entity timelines
