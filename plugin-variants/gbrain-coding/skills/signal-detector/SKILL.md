---
name: signal-detector
version: 1.1.0
description: |
  Opt-in ambient signal capture. After explicit enablement, applies on
  substantive inbound messages to detect original thinking and entity mentions.
  Use an authorized sub-agent where supported; otherwise detect inline.
  Aim to never block the main response.
triggers:
  - every substantive inbound message after automatic-capture opt-in
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

After the user enables automatic capture, apply this lightweight pass to
substantive inbound messages within their chosen scope. It watches for:

1. **Original thinking** — the user's ideas, observations, theses, frameworks
2. **Entity mentions** — people, companies, media references

Original thinking is AT LEAST as valuable as entity extraction. Ideas are the
intellectual capital. Entities are bookkeeping. Both compound over time.

## Contract

This skill guarantees:
- Applies only after explicit automatic-capture opt-in (skips: no recorded
  choice, capture off, chat-only requests, and purely operational messages)
- Spawns as a sub-agent where the harness supports it; otherwise runs the
  detection inline before composing the reply. Never blocking the response
  is the intent, not a runtime contract
- Checks the user's stored capture choice before writing and honors narrower
  per-message instructions; a first-fire announcement is not consent
- Captures ideas with the user's EXACT phrasing (no paraphrasing)
- Detects entity mentions and creates/enriches brain pages
- Logs a one-line summary of what was captured
- Back-links all entity mentions (Iron Law)
- Citations on every fact written

Ambient routing is a harness convention that a well-behaved agent
follows, not a mechanical guarantee; nothing in the gbrain runtime blocks
a reply if the skill never loads. On harnesses without per-message ambient
routing (Claude Code, Codex), apply this skill as an agent convention or
wire it via a prompt-submit hook. When the operator has enabled
`memory.auto_writeback` (off by default; `gbrain config set
memory.auto_writeback salient`), the MCP server's initialize instructions
and the managed bootstrap instruction blocks carry the ambient-writeback
contract to the agent, and on Claude Code a Stop-hook extraction backstop
catches turns the convention missed. That is still a convention on the
agent side — server-delivered instructions plus a backstop, not a
mechanical guarantee.

> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Every time this skill creates or updates a brain page that mentions a person or company:
1. Check if that person/company has a brain page
2. If yes → add a back-link FROM their page TO the page you just created/updated
3. Format: `- **YYYY-MM-DD** | Referenced in [page title](path) — brief context`
4. An unlinked mention is a broken brain.

## Enablement before capture

Automatic capture is off by default. Before writing, establish an explicit
user choice for this brain and capture scope. A stored opt-in or an explicitly
enabled `memory.auto_writeback` mode can supply that choice; `off`, a missing or
unreadable choice cannot. Reading this skill, installing GBrain, an available
API key, silence, or an announcement that capture is on does not authorize it.

If the user asks to enable capture, explain what will be retained and record
the accepted choice. Honor an existing choice without asking again. A request
to remember one fact authorizes that fact, not future ambient capture.
Delegation and paid enrichment are separate capabilities: capture opt-in alone
does not authorize spawning workers or making paid provider calls.

After activation, confirm the chosen scope once and explain how to turn it off.
Do not capture the current turn while awaiting a required answer.

## Per-User Storage Policy

If the user turns capture off, record the requested setting and stop capture:
no content pages, links, or timeline entries. A chat-only instruction suppresses
capture for that message without changing the standing setting; do not save
the chat-only content as a preference. Re-enable only on request. Explicit
remembering and relevant recall remain available when capture is off.

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
   - If NO page → check notability. If notable, save the supplied information with provenance.
   - If page exists but THIN → enrich only within separately authorized capabilities and spending
   - If page exists and RICH → no action
3. For new FACTS with specific dates → call `gbrain timeline-add <slug> <date> "<summary>"`

**Auto-link (v0.10.1):** When you write/update an originals or ideas page that
references a person or company, the auto-link post-hook on `put_page`
automatically creates the link from the new page to that entity. You don't
need to call `gbrain link` manually. Timeline entries still need explicit calls.

### Phase 3: Signal Logging

Always log a one-line summary:
- `Signals: 0 ideas, 0 entities, 0 facts (skipped: operational)`
- `Signals: 0 ideas, 0 entities, 0 facts (skipped: capture off)`
- `Signals: 1 idea (captured → originals/x), 2 entities (enriched → people/y, companies/z)`

This makes the ambient capture loop debuggable.

## Output Format

After opt-in, report observed writes and their provenance. Keep the signal log
brief and verify captured content with an actual readback. Without opt-in,
perform no capture writes; a skipped-capture diagnostic is not a reason to
interrupt every response or ask for enablement repeatedly.

## Anti-Patterns

- Blocking the main response to wait for signal detection to complete
- Paraphrasing the user's original thinking instead of capturing exact phrasing
- Creating pages for non-notable entities (one-off mentions)
- Skipping back-links after creating/updating pages
- Running on purely operational messages ("ok", "thanks", "do it")
- Capturing without explicit opt-in, after capture was disabled, or on a chat-only turn
- Treating a first-fire announcement, one explicit memory, or an API key as standing authorization
- Starting paid enrichment or delegation just because capture is enabled

## Tools Used

- `search` — check if entity page exists
- `query` — semantic search for related context
- `get_page` — load existing entity pages
- `put_page` — create/update brain pages
- `add_link` — cross-reference entities
- `add_timeline_entry` — record events on entity timelines
