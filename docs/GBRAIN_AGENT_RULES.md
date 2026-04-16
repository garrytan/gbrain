<!-- gbrain-agent-rules-version: 0.5.2 -->
<!-- source: https://raw.githubusercontent.com/garrytan/gbrain/master/docs/GBRAIN_AGENT_RULES.md -->
# GBrain Agent Rules

These are the behavioral rules your AI agent must follow to operate gbrain as a
compounding knowledge system. Without these rules the MCP tools are available but
the brain-agent loop does not run -- knowledge stops compounding.

For the full reference architecture (enrichment pipelines, meeting ingestion,
cron schedules, page templates), call the `get_skillpack` MCP tool with a
specific section name (e.g. `get_skillpack section="enrichment"`).

---

## 1. The Brain-Agent Loop (always-on)

Every conversation must follow this cycle:

```
Signal arrives (message, meeting, email, link)
  → Detect entities (people, companies, concepts, technical systems)
  → READ brain first (gbrain search / query / get)
  → Respond with brain context
  → WRITE new info back to brain (gbrain put_page)
  → Sync index (gbrain sync_brain)
  → Next signal: agent is smarter than last time
```

**Two invariants -- never break these:**

1. **Every READ improves the response.** If you answered a question about a person
   without checking their brain page first, you gave a worse answer.
2. **Every WRITE improves future reads.** If a conversation revealed new information
   about an entity and you did not update the brain page, you created a gap.

---

## 2. Brain-First Lookup Protocol

When using GBrain for lookup (triggered by the MCP server instructions):

```
1. gbrain search "name"          -- keyword match, fast, always works
2. gbrain query "what do we know about name"  -- hybrid search (needs embeddings)
3. gbrain get <slug>             -- direct page read when you know the slug
```

Stop at the first step that gives you what you need. External APIs and web
search fill gaps the brain does not have -- they are fallbacks, not starting
points.

---

## 3. Entity Detection (run on every message)

On EVERY inbound message, detect:

### Original Thinking (highest priority)

The user's own ideas, observations, theses, frameworks. Capture their EXACT phrasing
-- the language IS the insight.

| Signal | Destination |
|--------|-------------|
| User generated the idea | `brain/originals/{slug}.md` |
| World concept they reference | `brain/concepts/{slug}.md` |
| Product or business idea | `brain/ideas/{slug}.md` |

### Entity Mentions

People, companies, concepts. For each:

1. Check if brain page exists (`gbrain search "name"`)
2. No page and notable → create it
3. Thin page → enrich in background
4. Rich page → load silently for context
5. New facts → append to timeline

### Technical Concept Mentions

In addition to people/company/deal entities, detect:

| Signal | Destination |
|--------|-------------|
| User asks "how does X work" | `brain/concepts/{x-slug}.md` |
| User mentions a system/repo | `brain/systems/{system-slug}.md` |
| User asks a cross-system question | Check all relevant concept + system pages |
| Agent discovers a reusable code pattern | Update or create a concept page with `codemap` |

### Rules

- Fire on EVERY message (no exceptions unless purely operational)
- Don't block the conversation -- detect and update asynchronously
- User's direct statements are the HIGHEST authority signal

---

## 4. Source Attribution (every fact needs a citation)

Every fact written to a brain page needs `[Source: ...]` with full provenance.

**Format:** `[Source: {who}, {channel/context}, {date} {time} {tz}]`

**Examples:**
- `[Source: User, direct message, 2026-04-07 12:33 PM PT]`
- `[Source: Meeting notes "Team Sync" #12345, 2026-04-03 12:11 PM PT]`
- `[Source: X/@handle tweet, topic, date](https://x.com/handle/status/ID)`

Source attribution applies to compiled truth AND timeline. Every claim needs a source.

**Source hierarchy for conflicts:**
1. User's direct statements (highest)
2. Primary sources (meetings, emails)
3. Enrichment APIs
4. Web search
5. Social media

When sources conflict, note the contradiction -- don't silently pick one.

---

## 5. Back-Linking (iron law)

**Every mention of an entity MUST link back to the source.**

When you update a person page because they were mentioned in a meeting:
- The meeting page links to the person page
- The person page links back to the meeting with context

Format for timeline back-links:
`- **YYYY-MM-DD** | Referenced in [page title](path/to/page.md) -- context`

An unlinked mention is a broken brain. The graph must be bidirectional.

---

## 6. Sync After Write

After creating or updating any brain page, sync immediately:

```
gbrain sync_brain (with no_pull: true, no_embed: true)
```

This indexes new/changed pages without pulling from git or regenerating embeddings.
Embeddings refresh later in batch (`gbrain embed --stale`).

---

## 7. Compiled Truth + Timeline Pattern

Every brain page has two zones separated by `---`:

**Above the line: Compiled truth.** Current best understanding. Rewritten when new
evidence changes the picture. Read only this to know the state of play.

**Below the line: Timeline.** Append-only, reverse chronological evidence log.
Never rewritten, never deleted.

---

## 8. What gbrain stores vs. what agent memory stores

| Layer | What it stores | When to use |
|-------|---------------|-------------|
| **gbrain** | World knowledge: people, companies, deals, meetings, concepts | "Who is Pedro?", "What happened at the board meeting?" |
| **agent memory** | Operational state: preferences, decisions, session context | "How does the user like formatting?", "What did we decide?" |

Check both. gbrain for facts about the world. Agent memory for how to behave.

---

## Reference

For detailed patterns not covered here (enrichment pipelines, meeting ingestion
format, cron schedules, page templates, upgrade procedures), use the
`get_skillpack` MCP tool with a section number or keyword.

| Section | Topic |
|---------|-------|
| 5 | Enrichment pipeline (7-step protocol, tier system) |
| 6 | Compiled truth + timeline pattern (detailed) |
| 8 | Meeting ingestion format |
| 9 | Reference cron schedule |
| 12 | Email monitoring architecture |
| 15 | Five operational disciplines |
| 17 | Upgrade and auto-update flow |
| 18 | Live sync setup |
| 19 | Technical knowledge maps |
