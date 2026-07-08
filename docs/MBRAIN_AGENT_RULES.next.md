<!-- mbrain-agent-rules-next: N-1 restructure DRAFT. Not live. Do not inject.
     The full rules cut is gated on an EV-2 A/B eval; setup-agent keeps injecting
     docs/MBRAIN_AGENT_RULES.md until this draft wins that A/B.
     Measured 2026-07-08 (wc -w / wc -c, tokens ~= chars/4):
       live  docs/MBRAIN_AGENT_RULES.md (full file, as injected) 811 words / 6304 chars / ~1576 tokens
       live  body only (minus 2-line version header)             803 words / 6157 chars / ~1539 tokens
       draft body (below this comment block)                     477 words / 3839 chars / ~960 tokens
       reduction: 41% fewer words / 39% fewer est. tokens vs injected live file;
                  40.6% fewer words body-to-body. -->
# MBrain Agent Rules

MBrain is the user's durable knowledge layer. Writes are governed; secrets are never canonical memory; the daily memory report is the review surface.

## When to read

Read MBrain only on a durable-knowledge signal: a named person, company, meeting, or project; a technical concept or internal system; the user's ideas or preferences; a cross-system or historical question. Pure code/git/file work: skip.

## Five surfaces

1. Probe — `retrieve_context "question"`: returns `required_reads`, maybe `candidate_signals`.
2. Evidence — `read_context --selectors '<json>'`: the canonical evidence boundary. Read `required_reads` before any factual answer.
3. Discover — `search` (exact names, slugs, dates), `query` (semantic).
4. Page I/O — `get_page <slug>` full read; `put_page` governed, hash-gated write (below).
5. Sync — after any page write: `sync_brain` with `no_pull: true`, `no_embed: true`.

Use the lightest surface first; stop once enough. `search`/`query` chunks and Memory Inbox `candidate_signals` are pointers, not answer evidence — never answer from a probe. If `required_reads` miss but `candidate_signals` exist: say canonical evidence is absent/different; inbox signals are non-canonical; targetless candidates are never evidence. Codex lazy-loading: if `read_context` is not callable after retrieve, `tool_search` for `mbrain read_context`.

## Writing memory — route before write

Default: `remember({content, source_refs, evidence_kind, ...})` — one call runs the governed ladder (route, reconcile, verify, promote, write, handoff); trust its receipt: `stored | needs_review | rejected`.

Manual ladder (when not using `remember`):

- `route_memory_writeback` first; `apply: true` when source refs exist and the signal is inferred, ambiguous, contradictory, code-sensitive, session-end, trace-review, or meeting/import-derived. Routing requires `target_snapshot_hash`: current page `content_hash`, or `null` only after confirming absence.
- `put_page` only after the router returns `canonical_write_allowed`; blind writes are rejected (`route_first`). Prefer the router's `write_session_id`; otherwise pass `expected_content_hash` = current `content_hash`, or explicit `null` for a confirmed-absent page.
- With `write_session_id`: only the routed compiled truth plus source citations, no timeline. Without one: attributed compiled truth plus timeline evidence.
- Router verdicts: `create_candidate` — do not also call `put_page`; `defer` — record what's missing; `no_write` — skip.
- Candidates: `verify_memory_candidate_entry` before promotion; block refuted candidates. Targetless candidates need an approved target proposal before binding; approval never calls `put_page`. Promotion alone yields no retrievable markdown (`canonical_write_pending`) — write the page to clear the debt.
- Session capture: `preview_agent_session_memory` before `capture_agent_session_memory`; default `write_mode: candidate_only`; file/envelope capture is not canonical authority.
- Never write secrets, transient task mechanics, private chain-of-thought, or generic facts outside the user's knowledge graph.

## Filing

originals: `brain/originals/{slug}.md`; concepts: `brain/concepts/`; ideas: `brain/ideas/`; systems: `brain/systems/`; project docs: `brain/projects/<project>/docs/`. No vague or numeric-only slugs; ask if identity is unclear.

## Page shape

Two zones split by `---`: compiled truth above (rewritten best understanding); append-only reverse-chronological timeline below. Cite every claim: `[Source: User, direct message, YYYY-MM-DD HH:MM TZ]`. Record contradictions; the user's direct statements outrank other sources.

## Backlinks

When page A mentions page B, append to B's timeline: `- **YYYY-MM-DD** | Referenced in [page title](path/to/page.md) -- context`. Then sync (surface 5).
