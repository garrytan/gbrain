---
name: brain-ops
version: 1.1.0
upstream: brain-ops@fc834ee
description: |
  Brain knowledge base operations. The core read/write cycle: brain-first lookup,
  read-enrich-write loop, source attribution, ambient enrichment, back-linking.
  Read this before any brain interaction.
triggers:
  - any brain read/write/lookup/citation
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - get_backlinks
  - sync_brain
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - deals/
  - concepts/
  - meetings/
---

# Brain Operations — The Ambient Context Layer

The brain is not an archive. It is a live context membrane that every interaction
flows through in both directions.

> **Convention:** See `skills/conventions/brain-first.md` for the 5-step lookup protocol.
> **Convention:** See `skills/conventions/quality.md` for citation and back-link rules.

> **Memory verbs (MEMORY_VERBS v1, gbrain ≥ 0.43).** Over MCP, prefer the five
> frozen memory verbs for the read/write cycle: **`remember(fact, provenance,
> ttl?)`** to save a single durable fact (mandatory provenance; dedupes +
> supersedes), **`recall(query | entity, budget_tokens)`** to read it back
> budget-packed, **`entity(name)`** for a zero-LLM card, **`synthesize(question)`**
> for the expensive cross-page answer, **`forget(id)`** to expire a fact. Use
> `remember` instead of `extract_facts` when you already have ONE formed fact;
> `put_page` / `add_link` / `add_timeline_entry` stay the page/graph write path.
> Fall back to the classic ops when the verbs aren't on the surface. Contract:
> `docs/protocol/MEMORY_VERBS_v1.md`.
>
> **Keyless brains:** when `extract_facts` returns `skipped:
> extraction_unavailable`, YOU are the extractor — pull the facts from the turn
> yourself and write each one via `remember` with `kind` set (event | preference
> | commitment | belief | fact — those five are the frozen protocol enum; the
> `idea` kind the extractor and DB carry is NOT one of them) and the
> visibility the envelope's `agent_action` names
> (default private — pin it; `remember` defaults to world), or author a
> `## Facts` fence on the entity page. A `skipped: extraction_failed` envelope
> (server-side extractor errored on this turn; `reason` names why) invites the
> same manual `remember` fallback for that turn — automatic extraction stays
> on for future writes.

## Contract

This skill guarantees:
- Brain is checked BEFORE any external API call (brain-first lookup)
- Every inbound signal triggers the READ → ENRICH → WRITE loop
- Every outbound response checks brain for relevant context
- Source attribution on every fact written (inline `[Source: ...]` citations)
- User's direct statements are highest-authority data
- Back-links maintained on every brain write (Iron Law)

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. An unlinked mention is a
broken brain. See `skills/conventions/quality.md` for format.

## Phases

### Phase 1: Brain-First Lookup (MANDATORY)

Before using ANY external API to research a person, company, or topic:

1. `gbrain entity "<name>"` (v0.43+) — ONE known person/company/project → full card (description, aliases, open threads, recent events, edges, backlink/fact counts). Zero LLM calls, sub-100ms. This one call replaces steps 2–6 for known-entity lookups; near-misses return suggestions.
2. `gbrain search "name"` — exact-token lookup for existing pages (cheap hybrid, no expansion)
3. `gbrain query "natural question about name"` — concept/landscape questions go here FIRST (expansion recovers synonym phrasings; a nonzero `search` count is not proof of completeness)
4. `gbrain get <slug>` — if you know the slug, read the full page
5. Check backlinks: who references this entity?
6. Check timeline: recent events involving this entity

The brain almost always has something. External APIs fill gaps, not start from scratch.

**⚠️ NEVER scope/count a corpus with shallow `ls` — query gbrain or `find`.** Federated sources often carry MULTIPLE coexisting directory conventions — a flat legacy layer AND a date-nested `meetings/YYYY/MM/` layer. A non-recursive `ls dir/*.md` sees only one and undercounts massively. Real example: a shallow `ls` of one source's `meetings/` counted 132 files, almost all the user's, and concluded that WAS the corpus — missing thousands of transcripts nested under `meetings/YYYY/MM/`. To count/scope a brain corpus:
  - **Best:** `gbrain sources list` (shows per-source indexed page counts) + `gbrain query`. gbrain indexes ALL federated sources correctly; trust its index, not the filesystem.
  - **If you must hit the FS:** `find <dir> -name '*.md' | wc -l`, never `ls *.md`. Then map the layout: `find <dir> -name '*.md' | sed -E 's#(.*/)[^/]+$#\1#' | sort | uniq -c`.
  - The bug is never "gbrain can't see the source" — it's almost always a shallow FS glob. Verify against `gbrain sources list` before believing a low count.

### Phase 1.5: Analytical Queries (gbrain think)

For questions that need synthesis, temporal grounding, or analytical answers —
not just "find the page" but "answer the question":

1. Use `gbrain think "<question>"` — multi-hop synthesis across pages + takes +
   the graph. Temporal questions route through trajectory analysis; everything
   else gets an LLM-synthesized, cited answer with conflict + gap analysis.
   Returns a grounded answer, not just a list of matching pages.
2. Best for: "when did acme-example last raise", "what was the ARR in March",
   "what changed since Q1", "who is alice-example's cofounder and what are they
   working on", "summarize our relationship with acme-example".
3. Falls back gracefully to standard retrieval when no timeline facts match.
4. Cost: LLM calls per question — this is the expensive path. Use `query` for
   simple page lookups where you just need the slug or a quick context check.

### Phase 2: On Every Inbound Signal (READ → ENRICH → WRITE)

Every message, meeting, email, or conversation that references a person or company:

1. **Detect entities** — people, companies, deals mentioned
2. **Load brain pages** — read existing pages for context before responding
3. **Identify new information** — what does this signal tell us that the page doesn't know?
4. **Write it back** — update the brain page with new info + timeline entry + source citation
5. **Create if missing** — if notable and no page exists, create via enrich skill

**User's direct statements are the highest-value data source.** Write them to brain
pages immediately with attribution `[Source: User, YYYY-MM-DD]`.

### Phase 2.5: Structured Graph Updates (automatic)

Every `put_page` call automatically extracts entity references and writes them
to the graph (`links` table) with inferred relationship types. Stale links
(refs no longer in the page text) are removed in the same call. This is
"auto-link" reconciliation.

- No manual `add_link` calls needed for ordinary page writes.
- Inferred link types: `attended` (meeting -> person), `works_at`, `invested_in`,
  `founded`, `advises`, `source` (frontmatter), `mentions` (default).
- The `put_page` MCP response includes `auto_links: { created, removed, errors }`
  so the agent can verify outcomes.
- To disable: `gbrain config set auto_link false`. Default is on.
- Timeline entries with specific dates still need explicit `gbrain timeline-add`
  (or batch via `gbrain extract timeline --source db`).

### Phase 3: On Every Outbound Response (READ → PULL → RESPOND)

Before answering any question about a person, company, or topic:

1. **Check the brain** — read relevant pages
2. **Pull context** — use compiled truth + recent timeline
3. **Respond with context** — the brain makes every answer better

Don't answer from general knowledge when a brain page exists.

### Phase 4: Ambient Enrichment

This is not a special mode. This is the default. Everything the user says is an
ingest event.

- Person mentioned → check brain, create/enrich if needed (spawn background)
- Company mentioned → same
- Link shared → ingest it (delegate to idea-ingest)
- Data shared → delegate to appropriate skill

**Rules:**
- Never interrupt the conversation to do enrichment
- Spawn sub-agents for anything that would slow down the response
- Never announce "I'm enriching the brain" — just do it silently

## Output Format

No separate output. Brain-ops is an always-on behavior layer, not a report generator.
The output is updated brain pages and enriched responses.

## Cross-source citation format (v0.18.0+)

When a brain has multiple sources (wiki, gstack, yc-media, etc.), every
citation MUST include the source id: `[source-id:slug]`. Example:

> You told me about the retry budget approach — see
> [wiki:topics/resilience] and [gstack:plans/retry-policy] for where
> this came from.

Rules:
- The key is `sources.id` (immutable), never `sources.name` (mutable display).
- Single-source brains still write `[default:slug]` OR may omit the prefix
  for backward compat.
- Every page payload returned by `search`, `query`, `get_page`, `list_pages`
  carries `source_id` — always use it when citing, never guess.

If a search result has `source_id: "gstack"` and `slug: "plans/foo"`,
the citation is `[gstack:plans/foo]`. That's the whole rule.

## Anti-Patterns

- Answering questions about people/companies without checking the brain first
- Using external APIs before checking the brain
- Writing facts without inline `[Source: ...]` citations
- Blocking the response to do enrichment
- Overwriting user's direct statements with lower-authority sources
- Creating brain pages for non-notable entities
- Creating duplicate pages for the same entity — always check first before creating: `gbrain entity "<name>"` (catches aliases + near-misses), then `query` with name variants

## Tools Used

- `search` — cheap hybrid search (vector + keyword, no expansion)
- `query` — hybrid search + LLM multi-query expansion (concept/landscape questions)
- `get_page` — read a brain page
- `put_page` — create/update brain pages
- `add_link` — cross-reference entities
- `add_timeline_entry` — record events
- `get_backlinks` — check who references an entity
- `sync_brain` — sync changes to the index
