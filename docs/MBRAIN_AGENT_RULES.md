<!-- mbrain-agent-rules-version: 0.5.7 -->
<!-- source: https://raw.githubusercontent.com/meghendra6/mbrain/master/docs/MBRAIN_AGENT_RULES.md -->
# MBrain Agent Rules

MBrain is the durable knowledge layer for people, companies, concepts, internal
systems, meetings, projects, and the user's original thinking. Use it to make
answers context-aware and to keep durable knowledge compounding across sessions.

For detailed patterns, call `get_skillpack` with a section name or number
(examples: `enrichment`, `meeting`, `compiled-truth`, `19`).

---

## 1. Read First When MBrain Is Relevant

Before answering, check whether the user message mentions or depends on:

- a person, company, deal, meeting, project, or organization
- a technical concept, internal system, repo, architecture, or reusable code pattern
- the user's own idea, thesis, observation, product thought, or preference
- a cross-system or historical question that external search or raw grep cannot answer

For every message, do a lightweight scan for durable knowledge signals; only
read or write when a signal is present.

If yes, read MBrain before responding. If the task is purely code editing, git
work, file management, public library documentation, or general programming,
only use MBrain when one of the triggers above is present.

## 2. Lookup Order

Use the lightest lookup that can answer the question:

1. `retrieve_context` / `mbrain retrieve-context "question"` - agent probe.
   It finds candidates, applies route/scope context, and returns
   `required_reads`.
2. `read_context` / `mbrain read-context --selectors '<json>'` - evidence
   boundary. Use the probe's `required_reads` before answering factual
   questions.
3. `search` / `mbrain search "name"` - fast keyword candidate discovery for
   exact names, slugs, dates, and terms.
4. `query` / `mbrain query "conceptual question"` - semantic candidate
   discovery when keyword search misses likely pages.
5. `get_page` / `mbrain get <slug>` - full-page canonical read when the slug is
   known or a bounded read is insufficient.

`search` and `query` chunks are not answer evidence. Treat them as candidate
pointers, then call `retrieve_context` or `read_context` before making factual
claims. For exact known selectors or slugs, skip fuzzy discovery and go directly
to `read_context` or `get_page`.

Stop once you have enough context. Use web search, external APIs, or codebase
search only for gaps MBrain cannot answer.

## 3. Route Durable Writeback

When durable knowledge appears, call `route_memory_writeback` before mutating
memory. Use `apply: true` when source refs are available and the signal is
inferred, ambiguous, contradictory, code-sensitive, session-end, trace-review,
meeting/import-derived, or not ready for compiled truth.

Call `put_page` only after the router returns `canonical_write_allowed`. Canonical
write routing requires `target_snapshot_hash`: pass the current page
`content_hash`, or pass `null` only after confirming the target page is absent.
When calling `put_page`, pass the router's
`canonical_write_requirements.expected_content_hash` as `expected_content_hash`,
then write source-attributed compiled truth plus timeline evidence. If the router
returns `create_candidate`, do not also call `put_page` for the same signal. If
it returns `defer`, ask for or record the missing provenance, scope, target, or
target snapshot. If it returns `no_write`, skip the write.

Never write transient task mechanics, private chain-of-thought, or generic facts
that do not belong in the user's knowledge graph.

## 4. Filing Rules

- Original user thinking -> `brain/originals/{slug}.md`
- World concepts -> `brain/concepts/{slug}.md`
- Product or business ideas -> `brain/ideas/{slug}.md`
- Technical systems or repos -> `brain/systems/{slug}.md`
- Project-specific docs -> `brain/projects/<project>/docs/<specific-topic>.md`

Before creating a durable page, avoid vague or numeric-only slugs such as
`readme`, `docs`, `untitled`, `90`, or `123`. Ask for clarification if the
identity is unclear.

## 5. Page Structure And Evidence

Every brain page uses two zones separated by `---`:

- Above the line: compiled truth, rewritten as the current best understanding.
- Below the line: reverse-chronological timeline, append-only evidence.

Every factual claim written to MBrain needs source attribution:
`[Source: User, direct message, YYYY-MM-DD HH:MM TZ]`

If sources conflict, record the contradiction instead of silently choosing one.
The user's direct statements outrank other sources.

## 6. Backlinks And Sync

Every entity mention must be bidirectionally linked. When page A mentions page B,
page B's timeline should link back to page A with context:
`- **YYYY-MM-DD** | Referenced in [page title](path/to/page.md) -- context`

After creating or updating any brain page, sync immediately:

Call `sync_brain` with `no_pull: true` and `no_embed: true`.

Embeddings can refresh later in batch.
