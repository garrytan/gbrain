# MCP tool reference (starter surface)

The tool descriptions an MCP client receives are kept short, because every
connected agent pays for the whole tool list on every turn. This page keeps
the longer guidance for people: what each starter-surface tool does, its
defaults, and the edge cases behind each parameter. The served schemas
remain the contract; when they and this page differ, the schemas win.

Say to your agent: *"Before you call a gbrain tool you have not used yet,
check docs/mcp/TOOL_REFERENCE.md for its defaults."*

Search and query rows are lean for remote callers by default; see
[Search and query result rows](README.md#search-and-query-result-rows).
The `fields` parameter on `search` and `query` (`lean` or `full`) selects
the row shape per call.

## `add_timeline_entry`

Append an entry to the canonical Markdown timeline and structured timeline store in one committed write. Exact replay changes neither store.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `request_id` | string | Optional caller-generated UUID for this write. Reuse the same UUID and original arguments to recover its outcome after a timeout; a different intent requires a new UUID. |
| `slug` (required) | string | Slug of the page whose timeline to append to. |
| `date` (required) | string | Entry date, strict YYYY-MM-DD (e.g. '2026-04-03'). Timestamps and non-calendar dates are rejected. |
| `summary` (required) | string | One-line summary of what happened on that date. |
| `detail` | string | Longer free-text detail behind the summary. |
| `source` | string | Provenance ref for the entry, e.g. a meeting slug like 'meetings/2026-04-03' or a URL. |

## `cancel_job`

Cancel a waiting, active, or delayed job. Agent-scoped tokens (no admin) can cancel only jobs they own.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `id` (required) | number | Job ID |

## `cancel_write_request`

Cancel your accepted write before publication starts. Returns the actual receipt: running/recovering or already-terminal requests may remain unchanged. Cancellation cannot undo published bytes or a committed fact withdrawal.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `request_id` (required) | string | The original request UUID. Only this principal’s currently authorized requests are accessible. |

## `capture`

Capture a quick note into the brain — the "just remember this" write. Auto-derives a stable inbox/ slug from the content date + hash (recapturing identical text is idempotent), merges frontmatter, refuses binary/empty payloads, then delegates to put_page (inheriting its fences and provenance stamping). Prefer capture for quick notes and put_page when you need to control the slug, type, or an existing page's content. For structured facts about entities, prefer remember.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `source_id` | string | Source to mutate. Defaults to the selected source. Remote callers may only use their current write source. |
| `expected_revision` | string | Revision returned by the page read. Required when replacing an existing page unless force is true. Omit both for create-only writes. Carry the read's `source_id` with it: if this revision is the current revision of the same slug in another source you can read, the `revision_conflict` refusal names that source and its fix re-reads the page there. |
| `force` | boolean | Explicitly overwrite the current revision. Mutually exclusive with expected_revision; does not bypass authorization or the empty-content guard. |
| `request_id` | string | Optional caller-generated UUID for this write. Reuse the same UUID and original arguments to recover its outcome after a timeout; a different intent requires a new UUID. |
| `who` | string | For event captures, comma-separated entity slugs. |
| `what` | string | For event captures, the event description. |
| `where` | string | For event captures, the location. |
| `kind` | string | For event captures, the event kind. |
| `depth` | string | For event captures, the depth page to link. |
| `content` (required) | string | Markdown or plain text to capture. File paths are NOT accepted over MCP — read the file yourself and pass its content (the CLI --file lane is local-only). |
| `local_file` | string | Trusted local CLI only (--file): the absolute path of the captured file. Recorded as the page origin only when it lies inside the source and names the slug; the path itself is never stored. Remote callers are refused. |
| `slug` | string | Target slug. Default: inbox/YYYY-MM-DD-<sha8-of-content> (stable per content — recapturing identical text hits the same slug); type diary/event routes under life/. Fenced clients: the default lands under your first bound prefix. |
| `type` | string | Page type for the stamped frontmatter. Omitted: the content's frontmatter `type:` when present, else 'note'. An explicit type (this param or a frontmatter `type:`) must be declared by the active schema pack; undeclared types are rejected before writing, naming the declared vocabulary. |

## `context_pack`

MEMORY VERB (v1): budget-packed session-boundary bundle for a set of standing entities — entity cards + open threads + hot facts, zero-LLM, sub-second. Call at session start (warm cold context) and after compaction (rehydrate what the summary lost). WORLD-ONLY by default; pass include_private (honored for LOCAL trusted callers only) to widen all arms. budget_tokens packs server-side (response reports budget_used + dropped_count; cards pack first, then facts). Branch on structured fields, never prose. protocol_version rides every response.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `entities` (required) | string | Comma-separated entity names/slugs to bundle. Capped at 8. |
| `budget_tokens` | number | Server-side token budget (char/4). Cards pack first, then facts; each item costs its rendered line and the envelope + section headers are reserved, so `text` fits the budget. Response adds budget_tokens, budget_used (tokens of `text`), dropped_count. |
| `since` | string | ISO 8601 datetime. When set, open-thread events are filtered to those after this cursor. |
| `session_id` | string | Opaque session id; keys the hot-memory cache and (on the push path) the session cursor. |
| `include_private` | boolean | Local trusted callers only: widen ALL arms to include private facts. Ignored (world-only) for remote callers. Default false. |

## `delta`

MEMORY VERB (v1): "what changed since T" for heartbeats — pages updated after `since` + hot facts newer than `since` + open-thread events after `since`, zero-LLM. Lets a periodic wake maintain warm state in O(changes) instead of re-deriving. Optionally scope thread deltas to `entities`. WORLD-ONLY by default; include_private honored for local trusted callers only. budget_tokens packs server-side (pages first, then facts; threads are never dropped). protocol_version rides every response.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `since` | string | ISO 8601 cursor. Returns pages/facts/thread-events newer than this timestamp. Optional when session_id carries an established cursor. |
| `since_slug` | string | Stateless keyset resume: pass back `next_cursor.slug` from the previous response (paired with `since`=next_cursor.since) to page through pages sharing one timestamp. Ignored when session_id is set (the session cursor carries it). |
| `entities` | string | Optional comma-separated entity scope for thread-event deltas. Capped at 8. |
| `budget_tokens` | number | Server-side token budget (char/4). Pages pack first, then facts; each item costs its rendered line and the envelope + section headers + every thread line are reserved, so `text` fits the budget. Threads are never dropped (budget_used can exceed the budget only when the header + threads alone do). Response adds budget_tokens, budget_used (tokens of `text`), dropped_count. |
| `session_id` | string | Opaque session id. Drives the per-session cursor: the first call establishes it, each call advances it to the newest DELIVERED change (at-least-once — with has_more:true the undelivered tail returns on the next wake). Without it, pass an explicit `since` for a stateless delta. |
| `include_private` | boolean | Local trusted callers only: widen ALL arms to include private facts. Ignored (world-only) for remote callers. Default false. |

## `edit_page`

Change part of an existing page without resending it: prefer this over put_page for small changes to large pages. Read get_page with include_content:true and pass its revision as expected_revision. Each edit replaces old_text with new_text; edits apply in order, each to the text the previous edit produced, and each old_text must match exactly once in that content. Protected takes and facts sections never match (use the takes_* operations or remember/forget). All edits publish together or none do, through the same receipts, fences and write-through as put_page. Returns the new revision and a unified diff of your view (at most 8 KB). Refusals name the edit: edit_no_match, edit_ambiguous_match (with match_count), edit_protected_span, edit_invalid; a stale revision returns revision_conflict with current_revision. Retain request_id and repeat identical arguments after a pending receipt.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `slug` (required) | string | Slug of the existing page to edit. |
| `expected_revision` (required) | string | The `revision` from get_page include_content:true. The edit is refused if the page changed since. |
| `edits` (required) | array | 1 to 50 replacements, applied in order and all or nothing. |
| `source_id` | string | Source to mutate. Defaults to the selected source. Remote callers may only use their current write source. |
| `request_id` | string | Optional caller-generated UUID for this write. Reuse the same UUID and original arguments to recover its outcome after a timeout; a different intent requires a new UUID. |

## `entity`

MEMORY VERB (v1): inspect ONE known person/company/project card — zero LLM calls, sub-100ms. Resolution: alias > exact title > slug-suffix; ties break on most-recently-touched. NEVER errors on a miss: returns found:false plus near-miss suggestions with create_safety hints (exists | probable | unknown — whether writing a new page would duplicate). Routing: for facts/snippets retrieval use recall; for broad questions needing reasoning use synthesize (expensive).

| Parameter | Type | Guidance |
| --- | --- | --- |
| `name` (required) | string | Free-text name, alias, or slug (e.g. "Alice Example", "people/alice-example"). |

## `find_anomalies`

Returns statistical anomalies in recent page activity, grouped by cohort (tag or type). Use this for questions about what stood out, what's unusual, or what changed recently. Returns explanatory cohorts (e.g. '15 pages tagged wedding touched on 2026-04-28, baseline 0.3/day') so you can speak about patterns the user wouldn't have searched for. Cohort kinds: tag, type. Year cohort is deferred to a later release.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `since` | string | ISO date YYYY-MM-DD. Default = today (UTC). |
| `lookback_days` | number | Days of history for the baseline. Default 30. |
| `sigma` | number | Sigma threshold. Default 3.0. |

## `forget`

MEMORY VERB (v1): expire a remembered fact by id — the protocol delete verb. `id` is the opaque string id returned by remember and recall (facts[].fact_id) — never a page slug. Idempotent: forgetting an already-expired fact returns expired:false (success), unknown id returns a not_found error. The fact is expired (audit trail kept), not deleted.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `request_id` | string | Optional caller-generated UUID for this write. Reuse the same UUID and original arguments to recover its outcome after a timeout; a different intent requires a new UUID. |
| `id` (required) | string | Opaque fact id from remember/recall (facts[].fact_id). Never a page slug. |
| `reason` | string | Optional reason, written to the fact's audit trail. Default: "forgotten". |

## `get_agent_job`

Poll an agent job submitted via submit_agent. Returns a trimmed status view (id, status, timestamps, error_text, result) plus queue_position (waiting jobs ahead in claim order; 0 = next) while the job is still waiting. Requires the `agent` OAuth scope; only jobs owned by the calling client are visible.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `id` (required) | number | Job id returned by submit_agent |

## `get_backlinks`

List incoming links to a page

| Parameter | Type | Guidance |
| --- | --- | --- |
| `slug` (required) | string | Slug of the page whose incoming links to list. |
| `source_id` | string | Scope the read to one source (a multi-source brain can hold the same slug in several sources). Omitted: your granted sources remotely (a connection with no grant reads every federated source); locally, the resolved source, or every federated source when no --source / GBRAIN_SOURCE / .gbrain-source pinned it. '__all__' spans every source for trusted local callers and only your readable sources for remote callers. |
| `all_sources` | boolean | Span sources (equivalent to source_id=__all__): every source locally, only your readable sources remotely. |

## `get_ingest_log`

Get recent ingestion log entries

| Parameter | Type | Guidance |
| --- | --- | --- |
| `limit` | number | Max entries (default 20) |

## `get_page`

Read a page by slug (supports optional fuzzy matching). Slug aliases left by renames redirect to the canonical page in the source that owns the alias (archived sources excluded); a redirected read reports `resolved_slug`. To edit a page, pass include_content: true — the returned `content` field is the canonical full markdown (frontmatter + body + timeline sentinel); edit THAT and pass it back to put_page to round-trip losslessly. Reassembling compiled_truth/timeline by hand risks dropping sections. Soft-deleted pages are hidden by default; pass include_deleted: true to surface them with deleted_at populated (restorable until the purge cutoff, 72h by default, when the autopilot purge phase or `gbrain pages purge-deleted` hard-deletes them). `timeline` is only the markdown section after the timeline sentinel; entries written by add_timeline_entry or extraction live in timeline rows, which include_timeline_entries: true returns as `timeline_entries` (the same rows get_timeline returns). `file_held` means sync holds this page's newer file: you are reading the last good revision, and put_page refuses until the file is repaired (follow its `fix`).

| Parameter | Type | Guidance |
| --- | --- | --- |
| `slug` (required) | string | Page slug |
| `fuzzy` | boolean | Enable fuzzy slug resolution (default: false) |
| `include_content` | boolean | Include the canonical serialized `content` field (frontmatter + body + timeline sentinel) for lossless get→edit→put_page round-trips. Default false — it roughly duplicates compiled_truth + timeline, so read-only callers should not pay for it. |
| `content_only` | boolean | With include_content: true, return only the round-trip fields: `slug`, `source_id`, `type`, `title`, `revision`, `tags` and `content` (plus `deleted_at`, `resolved_slug`, `content_flag`, `file_held` and `timeline_entries` when they apply), without the duplicate compiled_truth / timeline / frontmatter. Ignored without include_content. To write back, send `content` to put_page with this `source_id` and `revision` as expected_revision: on a multi-source brain the same slug can live in several sources, and a write without source_id goes to your default source. |
| `include_deleted` | boolean | Surface soft-deleted pages with deleted_at populated (default: false). Used by restore workflows. |
| `include_timeline_entries` | boolean | Also return `timeline_entries`, the page's timeline rows (the same rows and filtering as get_timeline for this caller). Default false to keep the payload small. |
| `source_id` | string | Scope the lookup to a single source (a multi-source brain can hold the same slug in several sources). Defaults to ctx.sourceId / the caller's grant. '__all__' spans every source for trusted local callers, your granted sources for remote callers. |

## `get_recent_salience`

Returns readable pages recently touched and ranked by activity salience and recency. Unrestricted local reads include deterministic 0..1 emotional_weight, take density, and recency decay. Holder-restricted reads count only permitted active takes, use zero emotional_weight, and select recent pages by updated_at; unrestricted local reads retain take-driven touches. Use this when the user asks what's been going on, what's notable, what's hot, anything crazy happening, or for any open-ended 'current state' question about themselves or their work. Do NOT run a semantic search for these — salience surfaces what's unusual without needing a search term.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `days` | number | Window in days. Default 14. |
| `limit` | number | Max results (default 20, capped at 100). |
| `slugPrefix` | string | Optional slug-prefix filter, e.g. 'personal' or 'wiki/people'. |
| `recency_bias` | string (`flat`, `on`) | How to weight recency in the salience score.<br>  'flat' (DEFAULT) — every page gets 1/(1+days_old).<br>                     Stable, predictable; what most callers want.<br>  'on'             — Per-prefix decay map. concepts/originals/writing/<br>                     become evergreen (recency component = 0); daily/,<br>                     media/x/, chat/ decay aggressively. Use when the<br>                     user explicitly biases for recency-aware salience<br>                     ('what's been salient lately' vs 'what matters<br>                     in this brain regardless of when'). |

## `get_skill`

Fetch one skill's full instructions by name. Returns `{name, frontmatter (sanitized), body, usable_tools, unavailable_tools, client_guidance}`. The `body` is prose — read it as your operating instructions for this task, and when it says to search / store / look something up, call the same-named MCP tool on THIS server. There is nothing to 'execute' — the value is the instructions plus your tool calls back to this server. Tools listed in `unavailable_tools` won't work for you (not exposed here, or beyond your access) — adapt accordingly. Size-capped; read-scope; requires the owner to have enabled mcp.publish_skills. On a shared brain, pass schema_version:2 with qualified_id and revision from discovery to fetch exact instructions and their approved dependency manifest. get_skill_asset retrieves declared files from that revision as data; downloading never grants execution or tool permissions.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `schema_version` | number | Request 2 for an immutable canonical revision. |
| `qualified_id` | string | Exact version 2 qualified skill identity. |
| `expected_brain_id` | string | Assert the connected persistent brain identity from version 2 discovery. This never routes to another brain. |
| `source_incarnation` | string | Source incarnation from version 2 discovery. |
| `pack_id` | string | Canonical pack identifier. |
| `revision` | string | Exact immutable revision, or omit for the current head. |
| `name` | string | Skill name exactly as returned by list_skills (or the brain-pack skill slug when source_id is set). |
| `source_id` | string | Optional: fetch a brain-resident pack skill from this source instead of the host catalog. Disambiguates a slug that exists on more than one source (see list_brain_skillpack). |

## `get_skill_asset`

Read a bounded, owner-approved file from an exact sealed skill revision. Does not execute downloaded bytes.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `source_id` | string | Exactly one granted source. |
| `source_incarnation` | string | Expected source incarnation from the qualified catalog. |
| `name` | string | Skill name when not selecting by qualified_id. |
| `pack_id` | string | Pack identifier when not selecting by qualified_id. |
| `qualified_id` | string | Qualified skill key from version 2 discovery. |
| `expected_brain_id` | string | Assert this connected persistent brain identity without routing to another brain. |
| `revision` (required) | string | Immutable revision from get_skill. |
| `path` (required) | string | Exact path in the approved revision file manifest. |

## `get_write_request`

Read your durable write receipt by request_id. Requires write scope and this operation in the current grant. Foreign, missing, and no-longer-accessible requests return the same not_found error; private journal input and recovery bytes are never returned.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `request_id` (required) | string | The original request UUID. Only this principal’s currently authorized requests are accessible. |

## `list_brain_skillpack`

List brain-resident skillpacks this brain ships (per-source). Returns each pack's skills, one-line descriptions, the schema pack it targets + whether that matches this brain, and a git scaffold spec. Read-only; gated by mcp.publish_skills. After orienting, call this and ask the user whether to install any pack the brain offers (gbrain skillpack scaffold <spec>).

## `list_link_sources`

List distinct link_source provenances in the brain with edge counts (e.g. citation-graph, manual, markdown)

## `list_pages`

List pages with optional filters. For 'what's recent / what did I touch this week' questions, use list_pages with sort=updated_desc instead of semantic search. Default 50 rows; remote callers are capped at 100 (local CLI callers' explicit limits are honored). A result with exactly `limit` rows may be truncated. For exhaustive listing, page with updated_after=<last row's updated_at_iso> + updated_after_slug=<last row's slug> until a page returns fewer rows than the limit (the keyset forces sort=updated_asc; a bare updated_after cursor skips rows sharing the cursor timestamp).

| Parameter | Type | Guidance |
| --- | --- | --- |
| `type` | string | Filter by page type |
| `tag` | string | Filter by tag |
| `limit` | number | Max results (default 50; remote callers are capped at 100) |
| `offset` | number | Skip first N rows (pagination). |
| `updated_after` | string | ISO date (YYYY-MM-DD) or full timestamp. Returns pages with updated_at > value. Bare (without updated_after_slug) this is LOSSY across rows sharing one timestamp — a bulk sync stamps one now() across a transaction; pair with updated_after_slug to page exactly. |
| `updated_after_slug` | string | Keyset cursor slug: pass the last row's slug together with updated_after set to that row's updated_at_iso (column precision — a millisecond-rounded value re-selects same-millisecond rows). Resumes strictly after (updated_at, slug) and forces sort=updated_asc. |
| `updated_before` | string | ISO date (YYYY-MM-DD) or full timestamp. Returns pages with updated_at < value (strict). Pair with updated_after for a window (e.g. pages untouched since a date), or bound an updated_after + updated_after_slug walk; a `listing_truncated` continuation keeps it. Advertised on the full surface only. |
| `slug_prefix` | string | Literal slug prefix, matched against the lowercase slug: `people/` lists that path, while `people` also reaches `peoplex/…`. `_` and `%` match themselves. Composes with source_id, type, tag and the updated_* bounds; remote callers still never see private pages. A leading `/`, a backslash or a control character is refused with `invalid_params`. Advertised on the full surface only. |
| `sort` | string (`updated_desc`, `updated_asc`, `created_desc`, `slug`) | Sort order. Default updated_desc. Options: updated_desc, updated_asc, created_desc, slug. |
| `include_deleted` | boolean | Include soft-deleted pages (default: false). Used by restore workflows and operator diagnostics. |
| `source_id` | string | Scope listing to a single source. Defaults to OperationContext.sourceId / federated scope. Pass '__all__' to span every source for trusted local callers; for remote callers '__all__' spans only your granted sources. |

## `list_skills`

List the skills this agent's brain publishes. A skill is a named prose instruction set (NOT executable code) that teaches you how to do a task using this server's other tools. Returns a flat catalog — each entry has a name, one-line description, triggers (phrasings that should invoke it), and `usable_tools` / `unavailable_tools` (which tools the skill calls that you CAN vs CANNOT call given this server + your access). To actually use a skill, call get_skill with its name, read the returned prose, and follow it — calling the correspondingly-named tools on THIS server. The response also carries an `instructions` envelope explaining this protocol. On a shared brain, use schema_version:2 for source-qualified identities, immutable revisions, pagination and complete declared requirements. Only authorized sources and owner-approved file classes are visible; pre-migration servers retain their legacy prose catalog. Read-scope; published only when the brain owner enabled mcp.publish_skills.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `schema_version` | number | Request 2 for the canonical source-qualified sealed catalog; omitted preserves version 1. |
| `limit` | number | Version 2 page size, 1-100. |
| `cursor` | string | Version 2 opaque snapshot cursor. |
| `source_id` | string | Narrow version 2 enumeration to one permitted source. |
| `section` | string | Optional: only skills whose routing section matches this exactly. |

## `list_write_requests`

List your currently authorized write receipts in one source, newest first. Useful when an acknowledgment was lost. Results and pagination exclude other principals and inaccessible targets; no private payloads or cross-principal queue counts are exposed.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `source_id` | string | Source to inspect. Defaults to the caller’s resolved source. |
| `limit` | number | Number of visible receipts, 1–100. Default 25. |
| `before` | string | Opaque next cursor from the previous response. |

## `put_page`

Replace a complete canonical Markdown page. Read get_page with include_content:true and pass its revision as expected_revision; force explicitly overwrites the current revision. Omitting both permits creation only. Retain a UUID request_id and repeat identical arguments after transport failure or a pending receipt. Content, tags, sanitized text projections, versions and the committed receipt publish together; embedding and optional Git effects have separate status. Remote callers preserve protected facts/takes fences. For remote writes, `[[wikilinks]]` and markdown links in the body that point at pages already in the same source become plain `mentions` links after the commit (a journaled `links` effect; the receipt's `auto_links.mention_links` says it is queued; `mcp.remote_auto_links false` turns it off). Typed and frontmatter links are skipped for untrusted writes: a stdio `gbrain serve` sweeps them at startup + on idle; `gbrain serve --http` does not self-sweep — run `gbrain sweep --once` or use trusted local capture/put_page for inline link extraction. Pass `wait_ms` (up to 30000) to hold the reply until the commit instead of polling get_write_request. For more than 3 pages, use `put_pages` (full surface). Remote callers receive write_through.warning when no repo is configured. For file input use gbrain capture --file PATH --slug SLUG.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `source_id` | string | Source to mutate. Defaults to the selected source. Remote callers may only use their current write source. |
| `expected_revision` | string | Revision returned by the page read. Required when replacing an existing page unless force is true. Omit both for create-only writes. |
| `force` | boolean | Explicitly overwrite the current revision. Mutually exclusive with expected_revision; does not bypass authorization or the empty-content guard. |
| `request_id` | string | Optional caller-generated UUID for this write. Reuse the same UUID and original arguments to recover its outcome after a timeout; a different intent requires a new UUID. |
| `slug` (required) | string | Page slug |
| `content` (required) | string | Complete markdown content with YAML frontmatter. REPLACES the entire page; this is not a partial edit. Read the canonical page first with `get_page include_content:true` before modifying it. |
| `allow_empty` | boolean | Allow overwriting an existing non-empty page with empty/whitespace-only content (default: false). Without it, put_page rejects the empty overwrite — the empty-stdin failure class. |
| `wait_ms` | number | How long the reply waits for the commit, counted from arrival: 0-30000 ms, default 5000. Not part of the write's identity, so a replay with a different wait is still the same write. Out of range refuses with `invalid_write_wait` before anything is admitted. |
| `source_kind` | string | Ingestion channel taxonomy (capture-cli \| put_page \| webhook \| …). Remote callers: SERVER-STAMPED, client value ignored. |
| `source_uri` | string | Original URI/path/message-id the event carried. Remote callers: SERVER-STAMPED null. |
| `ingested_via` | string | Richer label paired with source_kind. Remote callers: SERVER-STAMPED. |

## `query`

Hybrid search with vector + keyword + multi-query expansion. Prefer `query` for concept / synonym / landscape questions ('all the X that do Y', 'the landscape of Z') — expansion recovers synonym- and outcome-phrased matches a single embedding misses. Still top-K, and the default count when `limit` is omitted depends on the configured search mode (10 conservative / 25 balanced / 50 tokenmax — see the `limit` param description); pass `limit` explicitly for a stable count regardless of mode. When the answer needs the surrounding conversation or section, pass `return_unit` ('page' / 'section' / 'window') to get that evidence in one call instead of get_page per hit; conversation pages already come back whole by default (return_unit 'auto'; 'chunk' opts out). For exhaustive enumeration use list_pages; for exact known tokens `search` is cheaper (no expansion LLM call). For personal/emotional questions ('what's going on with me', 'anything notable', 'how am I feeling'), prefer get_recent_salience, find_anomalies, or get_recent_transcripts. Semantic search returns polished pages and misses recent activity bursts. Do NOT assume words like 'crazy', 'notable', or 'big' mean impressive — they often mean difficult or emotionally charged.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `query` | string | Question or topic text for hybrid retrieval with expansion (e.g. 'agents that do web research'). This is the search text param — there is no `text` or `q` param. Optional ONLY because `image` is the alternative entry point; a call with neither fails with invalid_params. |
| `image` | string | Base64-encoded image bytes for image-similarity search (CLI: --image <path>). |
| `image_mime` | string | MIME type for the image bytes (auto-derived from path on CLI; required when calling op directly). |
| `limit` | number | Max results. Omitted or 0 resolves from the active search mode (10 conservative / 25 balanced / 50 tokenmax by default, or the configured `search.searchLimit` override) — for both text queries and image-similarity queries (`image` param). |
| `offset` | number | Skip first N results (for pagination) |
| `types` | array | Filter results to pages whose `type` is in this list (e.g. ['person','company']). CLI: --types person,company. Applied at SQL level on every retrieval leg — the same filter `whoknows` uses. Stacks with all other filters. |
| `snippet_chars` | number | Cap each result's chunk_text at N characters (a "… [truncated]" marker names the get_page recovery move). 0 forces full text. Unset: subagent tool loops default to the agent.search_snippet_chars config (300; 0=full); every other caller gets full text. |
| `return_unit` | string (`chunk`, `window`, `section`, `page`, `auto`) | Evidence unit returned in each result's chunk_text (default: config search.return_unit, which defaults to 'auto').<br>  'chunk'   — the ranked chunk only (~300-450 tokens per result).<br>  'window'  — the hit chunk plus return_window neighbor chunks each side (local context, ~3x chunk).<br>  'section' — the enclosing markdown section, or the conversation rounds around the hit.<br>  'page'    — the whole page/session, capped. Use for multi-session or temporal questions where the answer needs the whole conversation.<br>  'auto'    — the whole page for conversation pages (conversation/transcript/chat/meeting/slack/imessage types, chat/ or conversations/ slugs), the ranked chunk unchanged for everything else. When no hit is a conversation the response is exactly the chunk response.<br>Non-chunk units return one result per page, packed into token_budget (default 6000, auto 24000; remote max 32000), with a `delivered` object (unit, chunk_ids, match_spans, tokens, truncated; reason under auto) per result and `delivery` in the response meta. |
| `return_window` | number | Neighbor chunks on each side for return_unit 'window' (integer 1-3, default 1). |
| `token_budget` | number | Token budget. Chunk mode, and whenever return_unit is omitted: caps the cumulative chunk payload (results that would overflow are skipped). Explicit non-chunk return_unit: the budget for delivered evidence (default search.return_budget_default = 6000, auto 24000; remote max search.return_budget_max_remote = 32000). |
| `expand` | boolean | Request multi-query expansion (default: true in every search mode, regardless of search.expansion). Set false to opt out. Requires configured embedding and expansion providers; a cloud expander receives the query and may charge for the call. Response metadata expansion_applied reports whether variants were actually used. |
| `detail` | string | Result detail level: low (compiled truth only), medium (default, all with dedup), high (all chunks) |
| `mode` | string | Search mode (conservative\|balanced\|tokenmax). Local callers only; remote uses configured mode. |
| `lang` | string | Filter to chunks where content_chunks.language matches (e.g., typescript, python, ruby) |
| `symbol_kind` | string | Filter to chunks where content_chunks.symbol_type matches (e.g., function, class, method, type, interface) |
| `near_symbol` | string | Anchor retrieval at this qualified symbol name (e.g., BrainEngine.searchKeyword). Enables A2 two-pass. |
| `walk_depth` | number | Structural walk depth 1-2. Default 0 (off). Expands anchors through code_edges with 1/(1+hop) decay. |
| `salience` | string (`off`, `on`, `strong`) | Salience boost — emotional_weight + take_count, NO time component.<br>  'off' — default for entity / canonical / definitional queries<br>  'on'  — surface emotionally-weighted + take-rich pages<br>  'strong' — aggressive mattering tilt<br>Omit and gbrain auto-detects from query text. Independent of `recency`. |
| `recency` | string (`off`, `on`, `strong`) | Recency boost — per-prefix age decay, NO mattering signal.<br>  'off' — default for canonical truth<br>  'on'  — daily/, media/x/, chat/ decay aggressively; concepts/, originals/, writing/ stay evergreen<br>  'strong' — multiplies the recency factor by 1.5 (use for 'today' / 'right now')<br>Omit and gbrain auto-detects. Independent of `salience` (orthogonal axes). |
| `since` | string | Filter to pages whose effective_date is >= this. ISO-8601 (YYYY-MM-DD or full timestamp) OR relative ('7d', '2w', '1y'). |
| `until` | string | Filter to effective_date <= this. Same format as `since`. YYYY-MM-DD lands at end-of-day. |
| `source_id` | string | Scope search to a single source. Defaults to OperationContext.sourceId (set from CLI --source / GBRAIN_SOURCE / .gbrain-source dotfile). Pass '__all__' to span every source for trusted local callers. For remote callers, '__all__' uses the same scope as omission: an OAuth grant when present, otherwise the transport-computed federated sources for grantless local stdio. |
| `cross_modal` | string (`text`, `image`, `both`, `auto`) | Cross-modal search routing.<br>  'text' (default for non-image-intent queries) — text-only path.<br>  'image' — route the query through Voyage multimodal-3 + the embedding_image column. Best for 'show me photos of...' phrasings.<br>  'both' — run text AND image searches in parallel; merge via weighted RRF.<br>  'auto' — same effect as omitting the field; intent classifier decides based on query phrasing. |
| `embedding_column` | string | Route vector search through a non-default embedding column. Defaults to 'embedding' (the brain's primary column) unless `search_embedding_column` config sets a different default. Per-call override for A/B benchmarking across providers (e.g. 'embedding_voyage', 'embedding_openai'). Column MUST be declared in the `embedding_columns` config registry — unknown names throw with a paste-ready hint listing valid columns. |
| `adaptive_return` | boolean | Return a TIGHT, intent-sized result set instead of the full top-K. YOU (the agent) set this per query to serve the user well:<br>  TRUE when the user's question has a small, specific answer — a lookup ('what is X', 'who is Y', 'what's my <thing>', 'what did Z decide'), a single-fact recall, or when you'll route the result into a precise downstream step (a classifier, a decision, an exact citation). The user gets the answer, not a wall of loosely-related pages, and you spend fewer tokens reading noise.<br>  Omit / FALSE for breadth — 'everything about X', 'list all', 'what do I know about Y', exploration, brainstorming, or any time you'd rather see more candidates and judge for yourself. Recall matters more there, so take the full top-K.<br>Safe by construction: it NEVER returns empty when there are matches (you always get at least the top hit), and it only applies to the first page (omit when paginating). Caps come from config (search.adaptive_return_entity_max / _other_max; default 2 / 6) — pass `limit` 1 alongside this for a hard single-answer cap. |
| `autocut` | boolean | Cut the ranked results where the relevance score drops off a cliff, so an obvious single answer comes back as 1 result and a genuine handful comes back as that handful, not a fixed wall of 20+. Off by default in every search mode; a brain can turn it on with `gbrain config set search.autocut true`.<br>  Pass TRUE for a tight, confident set on one call. Pass FALSE to force the full top-K on a brain whose config turned autocut on, when you deliberately want breadth: broad exploration, 'show me everything about X', enumeration, or when you suspect the top hit is wrong.<br>Safe by construction: never returns empty when there are matches, only applies to the first page (omit when paginating), and is a no-op when no reranker scored the results (so it can't cut on an untrustworthy signal). Distinct from `adaptive_return`: autocut cuts on the score cliff; adaptive_return caps by question intent. Leave both unset for the brain's configured default. |
| `relational` | boolean | Relational recall arm. SMART DEFAULT (on in balanced/tokenmax). When the question is about a RELATIONSHIP ('who invested in widget-co', 'who introduced me to alice', 'what connects fund-a and fund-b'), the brain resolves the named entity and walks its typed-edge graph (invested_in, works_at, founded, …), surfacing the answer even when no passage mentions both sides. Pure no-op for non-relational questions. Pass FALSE to force lexical/vector-only retrieval (e.g. debugging why a graph answer appeared). You almost never set this. |

## `recall`

MEMORY VERB (v1): retrieve saved facts/snippets — the protocol read verb. Filters hot-memory facts by entity / since / session_id; pass `query` to ALSO run hybrid search over pages (results[] arm); pass `budget_tokens` for server-side packing (response reports budget_used + dropped_count — never trims client-side). Remote callers see visibility=world facts only. Routing: for ONE known person/company/project card use `entity` (zero LLM); for broad questions needing reasoning use `synthesize` (expensive). Branch on structured fields (status/kind/evidence), never on prose. Every response carries protocol_version.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `entity` | string | Entity slug (canonical). Returns facts about this entity newest first, each labelled with its source_id. Across several granted sources, same-slug entities that no entity-identity group links are different entities: facts comes back empty and ambiguous_entity names each (source_id, entity_slug); pass source_id to read one. |
| `query` | string | MEMORY_VERBS v1: free-text retrieval over pages (hybrid search arm). Response adds results[] (slug, title, chunk, evidence, create_safety, provenance). Combinable with entity (both arms run). Degrades to keyword-only search when no embedding provider is configured (search_degraded notes it; never an error). |
| `budget_tokens` | number | MEMORY_VERBS v1: server-side token budget (char/4 estimate). Facts pack first, then results. Response adds budget_tokens, budget_used, dropped_count. |
| `budget_policy` | string (`facts_first`, `query_first`) | Optional packing order. facts_first (default) packs facts first, then page results. query_first packs the ranked page prefix before facts only with a nonblank query and positive finite budget; a positive budget below one token keeps neither arm. Without a nonblank query and an active budget, packing stays facts_first. Neither policy skips oversized items or truncates. Supplying this option adds budget_packing accounting. Keep fact-focused/entity-filtered questions on facts_first. |
| `source_id` | string | Optional concrete source id for both facts and page results. Narrows the caller’s authorized scope, including an explicit default; a denied, missing, or archived source fails rather than widening. Omit to preserve the existing context/grant scope. |
| `since` | string | ISO 8601 datetime or duration shorthand (e.g. "8 hours ago"). Filters the FACTS arm only, on event time (valid_from, falling back to created_at); composes with `entity` and `session_id`. An unparseable value is rejected (invalid_params). |
| `session_id` | string | Source session id (e.g. topic-A). Returns facts captured in that session. |
| `include_expired` | boolean | When true, include expired_at IS NOT NULL rows. Default false. |
| `supersessions` | boolean | When true, return only the supersession audit log (facts with superseded_by set), newest first by COALESCE(expired_at, valid_until). |
| `limit` | number | Per-arm cap: max fact rows AND max search results. Default 50, cap 100. |
| `grep` | string | Substring filter on fact text (case-insensitive). Applied in SQL before the limit, so matches on high-cardinality entities are found even outside the newest-N window. |
| `include_pending` | boolean | When true, response includes pending_consolidation_count (facts not yet promoted to takes by the dream-cycle consolidate phase). One round trip; backward-compatible (field omitted when false). |
| `return_unit` | string (`chunk`, `window`, `section`, `page`, `auto`) | Evidence unit for the results[] arm (needs `query`; default config search.return_unit = 'auto'). 'window' adds neighbor chunks, 'section' the enclosing section or conversation rounds, 'page' the whole page/session (best for multi-session questions), 'auto' the whole page for conversation pages and the ranked chunk unchanged for everything else (budget_tokens or budget_policy without return_unit keeps chunk packing). Non-chunk units return one result per page with `delivered` metadata and a top-level `delivery` block; the evidence is budgeted by budget_tokens (default 6000, auto 24000) and then packed by recall's usual rules. |
| `return_window` | number | Neighbor chunks on each side for return_unit 'window' (integer 1-3, default 1). |

## `remember`

MEMORY VERB (v1): save one fact to durable agent memory — the protocol write verb. provenance is REQUIRED (free text, e.g. "conversation 2026-06-12", "user said in chat", "import: notes.md"). Set `entity` whenever the fact is about a specific person/company/project — entity-scoped recall will not find it otherwise. ttl accepts duration shorthand ("30d", "12h") or an absolute ISO 8601 timestamp; ISO-8601 durations like "P30D" are rejected with a fix. visibility defaults to "world" (readable by every agent connected to this brain; pass "private" for local-CLI-only facts). Response: branch on `status` (inserted|duplicate|superseded), never on `status_text` (human rendering only). On duplicate, `id` is the EXISTING fact's id. For bulk extraction from a raw transcript use extract_facts instead.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `source_id` | string | Source to mutate. Defaults to the selected source. Remote callers may only use their current write source. |
| `expected_revision` | string | Revision returned by the page read. Required when replacing an existing page unless force is true. Omit both for create-only writes. |
| `force` | boolean | Explicitly overwrite the current revision. Mutually exclusive with expected_revision; does not bypass authorization or the empty-content guard. |
| `request_id` | string | Optional caller-generated UUID for this write. Reuse the same UUID and original arguments to recover its outcome after a timeout; a different intent requires a new UUID. |
| `fact` (required) | string | The fact to remember, one claim per call. |
| `provenance` (required) | string | Where this fact came from (REQUIRED, free text, max 500 chars). Examples: "conversation 2026-06-12", "user said in chat", "import: meeting-notes.md". |
| `ttl` | string | Optional expiry: duration shorthand ("30d", "12h", "45m") or absolute ISO 8601 timestamp ("2026-07-12T00:00:00Z"). NOT ISO-8601 durations ("P30D" is rejected). Omit = never expires. |
| `entity` | string | Person/company/project this fact is about (name or slug; canonicalized server-side). Set it whenever the fact has a subject — entity-scoped recall misses unattributed facts. |
| `infer_entity` | boolean | Default true. When `entity` is omitted, link the fact to the one entity page the text names exactly (response `entity_inferred: "mention"`); pass false to save it unattributed. |
| `kind` | string (`event`, `preference`, `commitment`, `belief`, `fact`) | Fact kind: event \| preference \| commitment \| belief \| fact (default). |
| `visibility` | string (`world`, `private`) | world (default): readable by every agent connected to this brain — required for the remote remember→recall round-trip. private: local CLI reads only. |

## `request_tools`

Discover this brain's tool catalog and optionally unlock a wider tool surface for your client. No arguments → the catalog visible to YOUR credentials, grouped by area (tool names + one-line summaries). {tools: ["name", ...]} → full read-only schemas for the visible subset of those names (unknown/hidden names are silently omitted). {surface: "verbs"|"starter"|"full"} → persist that tool surface for this client (bounded by the server ceiling; denied when an operator pinned the surface; ~5 changes/hour), then re-issue tools/list to see the new catalog.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `tools` | array | Fetch full read-only tool schemas for these names. Names outside your visible surface are silently omitted. |
| `surface` | string (`verbs`, `starter`, `full`) | Persist this tool surface for your client. Must not exceed the server ceiling; ignored surfaces stay available via no-arg discovery. Takes effect on your next tools/list. |

## `resolve_slugs`

Fuzzy-resolve a partial slug to matching page slugs

| Parameter | Type | Guidance |
| --- | --- | --- |
| `partial` (required) | string | Partial slug or title text to match, e.g. 'alice-ex' or 'meeting notes'. This is the search text param — there is no `text` param. |
| `source_id` | string | Scope resolution to a single source. Defaults to OperationContext.sourceId; when unset, an unqualified resolve spans every federated source (matching search/get_page). Pass '__all__' to span every source for trusted local callers; for remote callers '__all__' spans only your granted sources. |

## `search`

Cheap hybrid search (vector + keyword + RRF) with no LLM expansion. Best for exact known tokens, names, and structured-field lookups. A populated result set is NOT proof of coverage — for concept / synonym / landscape questions use `query` (adds multi-query expansion); for exhaustive enumeration use list_pages pagination. Pass `return_unit` ('window' / 'section' / 'page') for whole evidence instead of chunks; conversation pages already come back whole by default (return_unit 'auto'; 'chunk' opts out). For personal/emotional questions, prefer get_recent_salience or find_anomalies — they surface activity bursts without needing a search term. For code-symbol questions (callers, callees, definitions, blast radius), use code_callers / code_callees / code_def / code_refs instead — those return structural graph data, not text chunks. For agent memory reads (saved facts + budget-packed retrieval), prefer the `recall` verb.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `query` (required) | string | Search text. Exact tokens, names, and structured-field values work best here (e.g. 'acme-example series A'), since this op does no LLM expansion. This is the search text param — there is no `text` or `q` param. |
| `limit` | number | Max results (default 20) |
| `offset` | number | Skip first N results (for pagination) |
| `mode` | string | Search mode (conservative\|balanced\|tokenmax). Local callers only. |
| `source_id` | string | Scope search to a single source. Defaults to OperationContext.sourceId (set from CLI --source / GBRAIN_SOURCE / .gbrain-source dotfile); when unset, an unqualified read spans every federated source. Pass '__all__' to span every source for trusted local callers; for remote callers '__all__' spans only your granted sources. |
| `types` | array | Filter results to pages whose `type` is in this list (e.g. ['person','company']). CLI: --types person,company. Applied at SQL level on every retrieval leg — the same filter `whoknows` uses. Stacks with all other filters. |
| `snippet_chars` | number | Cap each result's chunk_text at N characters (a "… [truncated]" marker names the get_page recovery move). 0 forces full text. Unset: subagent tool loops default to the agent.search_snippet_chars config (300; 0=full); every other caller gets full text. |
| `return_unit` | string (`chunk`, `window`, `section`, `page`, `auto`) | Evidence unit returned in each result's chunk_text (default: config search.return_unit, which defaults to 'auto').<br>  'chunk'   — the ranked chunk only (~300-450 tokens per result).<br>  'window'  — the hit chunk plus return_window neighbor chunks each side (local context, ~3x chunk).<br>  'section' — the enclosing markdown section, or the conversation rounds around the hit.<br>  'page'    — the whole page/session, capped. Use for multi-session or temporal questions where the answer needs the whole conversation.<br>  'auto'    — the whole page for conversation pages (conversation/transcript/chat/meeting/slack/imessage types, chat/ or conversations/ slugs), the ranked chunk unchanged for everything else. When no hit is a conversation the response is exactly the chunk response.<br>Non-chunk units return one result per page, packed into token_budget (default 6000, auto 24000; remote max 32000), with a `delivered` object (unit, chunk_ids, match_spans, tokens, truncated; reason under auto) per result and `delivery` in the response meta. |
| `return_window` | number | Neighbor chunks on each side for return_unit 'window' (integer 1-3, default 1). |
| `token_budget` | number | Token budget for delivered evidence when return_unit is not 'chunk' (default search.return_budget_default = 6000; auto: search.return_budget_conversation = 24000). Ignored in chunk mode. |
| `salience` | string (`off`, `on`, `strong`) | Salience boost (emotional_weight + take_count, no time component): 'off' \| 'on' \| 'strong'. Omit and gbrain auto-detects from query text. Independent of `recency`. |
| `recency` | string (`off`, `on`, `strong`) | Recency boost (per-prefix age decay, no mattering signal): 'off' \| 'on' \| 'strong'. Omit and gbrain auto-detects. Independent of `salience`. Ignored on the keyword-only opt-out path. |

## `submit_agent`

Submit an LLM agent job that the worker dispatches via the gateway-native tool loop. Requires the `agent` OAuth scope. Tools, source, slug prefixes, max concurrency, and daily budget are bound at OAuth client registration time.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `prompt` (required) | string | User prompt for the agent |
| `model` | string | provider:model string (defaults to models.tier.subagent) |
| `allowed_tools` | array | Subset of bound_tools the agent may invoke |
| `allowed_slug_prefixes` | array | Subset of delegated_slug_prefixes for writes; omit for a job-owned namespace |
| `max_turns` | number | Max LLM turns (default 20, hard cap 100) |
| `queue` | string | Queue name (default "default") |

## `synthesize`

[EXPENSIVE / SLOW — makes LLM calls, seconds-to-minutes latency, costs money] MEMORY VERB (v1): answer a broad question using cross-page LLM reasoning with citations and gap analysis. Prefer recall (facts/snippets) or entity (one known card, zero LLM) for lookups — use synthesize only when the answer requires combining evidence across pages. Response carries a best-effort cost block (model, tokens, usd_estimate) plus compose-status fields (synthesis_status, pages_gathered, takes_gathered, warnings); when the LLM compose step fails but retrieval succeeded, `answer` degrades to an extractive digest of retrieved pages (synthesis_status: "extractive_fallback") instead of an error.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `question` (required) | string | The question to answer. |
| `since` | string | Optional temporal window start (ISO 8601 date or datetime). |
| `until` | string | Optional temporal window end (ISO 8601 date or datetime). |

## `traverse_graph`

Traverse link graph from a page. Remote callers default to bidirectional edges (GraphPath[]) at depth 2 (pass depth explicitly for deeper walks); trusted local no-filter callers get the legacy node shape at depth 5.

| Parameter | Type | Guidance |
| --- | --- | --- |
| `slug` (required) | string | Slug of the page to start the traversal from, e.g. 'people/alice-example'. This is the start-node param — there is no `start` or `root` param. |
| `depth` | number | Max traversal depth (capped at 10). Default 5, except a remote call that lets direction default to 'both' uses 2 (bidirectional path enumeration is combinatorial on hubs); an explicit depth is always honored up to the cap. |
| `link_type` | string | Filter to one link type (per-edge filter, traversal only follows matching edges) |
| `direction` | string (`in`, `out`, `both`) | Traversal direction ('in', 'out', or 'both'). Remote callers default to 'both'; trusted local no-filter callers get the legacy outgoing-node output. |
| `hops` | array of `{link_type, toward}` | Typed chain of 1-3 hops from the start page, e.g. `[{"link_type":"invested_in","toward":"object"},{"link_type":"founded","toward":"subject"}]` (companies the person invested in, then their founders). `toward` follows the relationship's meaning (`object`: subject → object; `subject`: object → subject), not stored link direction. Returns `{anchor, answers, paths, diagnostics}` with each answer's evidence edges; a chain that finds nothing carries a `relational_chain` notice with the next call. Not combinable with `depth`, `link_type` or `direction`; each hop walks live relationships. Advertised on the full surface only. Chain link types: founded, invested_in, led_round, advises, works_at, attended, yc_partner. See docs/guides/multi-hop.md. |
| `source_id` | string | Scope the read to one source (a multi-source brain can hold the same slug in several sources). Omitted: your granted sources remotely (a connection with no grant reads every federated source); locally, the resolved source, or every federated source when no --source / GBRAIN_SOURCE / .gbrain-source pinned it. '__all__' spans every source for trusted local callers and only your readable sources for remote callers. |
| `all_sources` | boolean | Span sources (equivalent to source_id=__all__): every source locally, only your readable sources remotely. |

## `whoami`

Introspect the calling identity. Returns one of three transport shapes: {transport: "oauth", client_id, client_name, scopes, expires_at, source_id, federated_read}, {transport: "legacy", token_name, scopes, expires_at: null}, or {transport: "local", scopes: []}, or {transport: "stdio", scopes: []} for the auth-less stdio MCP pipe. Throws unknown_transport when the context is ambiguous (remote=true without auth and no transport marker) — fail-closed, per the trust-boundary contract.

