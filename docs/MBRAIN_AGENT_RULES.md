<!-- mbrain-agent-rules-version: 0.5.10 -->
<!-- source: https://raw.githubusercontent.com/meghendra6/mbrain/master/docs/MBRAIN_AGENT_RULES.md -->
# MBrain Agent Rules

MBrain is the managed Postgres + pgvector target runtime and durable knowledge
layer for people, companies, concepts, systems, meetings, projects, and originals.

Agents run with session-scoped trust. automatic canonical writeback exists, but
governed writes route durable signals through the assertion pipeline and `route_memory_writeback`;
direct `put_page` needs router permission. raw source access is scoped; secrets are never canonical memory.
daily memory report is the primary review surface.

---

## 1. Read First When MBrain Is Relevant

Before answering, do a lightweight scan for durable knowledge signals:

- a person, company, deal, meeting, project, or organization
- a technical concept, internal system, repo, architecture, or pattern
- the user's idea, thesis, observation, product thought, or preference
- a cross-system or historical question that external search or raw grep cannot answer

Read MBrain only when a signal is present. Pure code editing, git work, file
management, public library docs, or general programming does not need MBrain
unless one of those triggers applies.

## 2. Lookup Order

Use the lightest lookup:

1. `retrieve_context` / `mbrain retrieve-context "question"` - probe; returns
   `required_reads` and may include Memory Inbox `candidate_signals`.
2. `read_context` / `mbrain read-context --selectors '<json>'` - evidence
   boundary; use `required_reads` before factual answers.
3. `search` / `mbrain search "name"` - exact names, slugs, dates, terms.
4. `query` / `mbrain query "conceptual question"` - semantic discovery.
5. `get_page` / `mbrain get <slug>` - full-page canonical read.

`search`/`query` chunks and Memory Inbox `candidate_signals` are both pointers,
not answer evidence; `read_context` is the canonical evidence boundary before
factual claims. If required reads miss but `candidate_signals` exist, say
canonical evidence is absent/different and Memory Inbox has non-canonical signals.
Remember: targetless candidates are not evidence for factual answers. Inspect,
verify, promote, reject, or supersede candidates; use
`verify_memory_candidate_entry` before promotion, and block refuted candidates.
Known selectors/slugs: use `read_context` or `get_page`.
Stop once enough.

## 3. Route Durable Writeback

When durable knowledge appears, call `route_memory_writeback` before mutating
memory. Use `apply: true` when source refs exist and the signal is inferred,
ambiguous, contradictory, code-sensitive, session-end, trace-review,
meeting/import-derived, or not ready for compiled truth.

Call `put_page` only after the router returns `canonical_write_allowed`. Canonical
write routing requires `target_snapshot_hash`: pass the current page
`content_hash`, or pass `null` only after confirming the target page is absent.
When calling `put_page`, pass the router's
`canonical_write_requirements.expected_content_hash` as `expected_content_hash`,
then write attributed compiled truth plus timeline evidence. If the router
returns `create_candidate`, do not also call `put_page`. If it returns `defer`,
record missing provenance, scope, target, or snapshot. If it returns `no_write`,
skip the write.

Targetless Memory Inbox candidates need a canonical target proposal before
binding. Review the proposed home; approve or reject the proposal. approval must
not call put_page. If the page is missing, use patch candidate review/apply, then
complete binding; promotion or handoff happens later.

Never write transient task mechanics, private chain-of-thought, or generic facts
that do not belong in the user's knowledge graph.

## Agent Session Memory

Use `preview_agent_session_memory` before apply. Use
`capture_agent_session_memory` with `apply: true` only with source refs and an
acceptable route. Default `write_mode: candidate_only`; direct personal/profile
writes need preflight. File/envelope capture is a wrapper, not canonical authority.

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

Brain pages use two zones separated by `---`:

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
