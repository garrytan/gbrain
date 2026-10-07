# MCP tool catalog

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate: bun run scripts/generate-tool-catalog.ts -->
<!-- Freshness-guarded by scripts/check-tool-catalog-fresh.sh (bun run verify). -->

Every non-localOnly operation on the MCP surface: 140 tools across 23 areas. **Starter** marks membership in the ~40-op `starter` surface (`src/mcp/surface.ts`); **Gate** names the config key that must be true before remote callers see/call the op (`gbrain config set <key> true`). What a given token actually sees is further filtered per request by scope, bound-client fence, publish gates, and the per-client surface — see `docs/operations/mcp-surface-runbook.md`. Area names are non-contractual groupings.

## admin

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `get_health` | Brain health dashboard (embed coverage, stale pages, orphans) — remote callers see counters confined to their source grant. | admin |  |  |
| `get_stats` | Brain statistics (page count, chunk count, etc.) — remote callers see counters confined to their source grant. | admin |  |  |
| `get_status_snapshot` | Snapshot for `gbrain status` thin-client mode: sync freshness + last cycle + queue depths + worker liveness. | admin |  |  |
| `get_usage` | Aggregate chat usage + cost from the chat_usage_log ledger (per-model and per-phase token counts, cache reads/writes, USD estimates) with explicit coverage fields. | admin |  |  |
| `get_write_attribution` | Admin read: who created and who last changed a page, or one of its facts, takes or timeline entries. | admin |  |  |
| `mute_notice` | Stop a coaching or info notice (or first_run_decisions) from appearing for this client; muted: false unmutes. | write | yes |  |
| `quarantine_list` | List quarantined (hidden) and optionally content-flagged pages by scanning page frontmatter, newest-updated first. | admin |  |  |
| `run_doctor` | Run brain health checks and return a structured DoctorReport (thin-client doctor surface). | admin |  |  |
| `run_onboard` | Probe brain health + optionally submit onboard remediations. | admin |  |  |
| `run_skillopt` | Run SkillOpt against a single skill. | admin |  |  |

## advisor

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `advisor` | Ranked, read-only "what to do next" for this brain: version drift, pending migrations, schema-pack issues, stalled jobs, usage-shape gaps, and setup smells. | read |  | `mcp.publish_advisor` |

## chronicle

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `chronicle_day` | Life Chronicle: events + timeline entries on a given day (or its ISO week when week=true), ordered chronologically; each row backlinks to its depth page. | read |  |  |
| `chronicle_last_seen` | Life Chronicle: when an entity was last seen — its own timeline rows OR an event's `who`. | read |  |  |
| `chronicle_on_this_day` | Life Chronicle: events from the same calendar day in PRIOR years ("on this day"). | read |  |  |
| `chronicle_since` | Life Chronicle: events + timeline entries on or after a date, optionally filtered by event kind. | read |  |  |
| `volunteer_chronicle` | Life Chronicle agent-orientation: the recent timeline (last N days) + the current validity-resolved ontology for the named entities, in one zero-LLM payload, so an agent orients before acting. | read |  |  |

## code

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `code_blast` | BEFORE editing any function, run code_blast with the symbol name to surface every transitive caller grouped by depth (direct → 2-hop → 3-hop). | read |  |  |
| `code_callees` | When tracing how a function flows to its dependencies (DB calls, HTTP calls, file I/O), run code_callees from the entry point. | read |  |  |
| `code_callers` | BEFORE editing any function, run code_callers with the symbol name to find every caller (the people who'd be affected by your change). | read |  |  |
| `code_def` | Where is this symbol defined? | read |  |  |
| `code_flow` | When tracing how a request flows through the codebase from entry point to side effect (DB write, HTTP call, file I/O), run code_flow from the entry point. | read |  |  |
| `code_refs` | Find every reference to a symbol across the codebase (every file, every line). | read |  |  |

## discovery

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `request_tools` | More tools: no arguments lists your catalog; {tools: [names]} returns schemas; {surface} widens it (per OAuth client; stdio: this session). | read | yes |  |

## entities

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `entity_identity_list` | List cross-source entity identity groups and their member pages. | read |  |  |
| `extract_entities` | Extract entity names (people, companies) from text and create/update their brain stub pages. | write |  |  |
| `extraction_pending` | List unverified auto-extracted entity stubs awaiting owner review (the quarantine lane from extract_entities). | read |  |  |

## identity

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `get_brain_identity` | Brain identity + counters for thin-client banner — remote callers see counters confined to their source grant. | read |  |  |
| `whoami` | Your identity: transport, scopes and, over OAuth, client, source_id and federated_read. | read | yes |  |

## ingest

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `get_ingest_log` | Recent ingestion log entries. | read | yes |  |
| `log_ingest` | Record one ingestion event (source type, reference, pages updated, summary) in the brain's ingest log. | write |  |  |

## insights

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `find_anomalies` | Anomalies in recent page activity, grouped by cohort (tag or type) against a baseline. | read | yes |  |
| `find_contradictions` | Stored contradiction reports are temporarily available only to trusted local callers without a source filter. | read |  |  |
| `find_experts` | Answers 'who in my brain knows about <topic>'. | read |  |  |
| `find_trajectory` | Return the chronological claim trajectory for an entity (typed metric values over time, plus auto-detected regressions and narrative drift). | read |  |  |
| `get_calibration_profile` | Read the active calibration profile for a holder. | read |  |  |
| `get_recent_salience` | Recently touched pages ranked by salience. | read | yes |  |
| `volunteer_context` | Push-based context: volunteer brain pages relevant to a rolling conversation window WITHOUT being asked. | read |  |  |

## jobs

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `cancel_job` | Cancel a waiting, active or delayed job you may manage. | admin | yes |  |
| `get_agent_job` | Poll a submit_agent job: status, result, queue_position. | agent | yes |  |
| `get_job` | Get job status and details by ID. | admin |  |  |
| `get_job_progress` | Get structured progress for a running job. | admin |  |  |
| `get_job_stats` | Job queue statistics. | admin |  |  |
| `list_jobs` | List background jobs with optional status/queue/name filters; pass fields to project each job to the columns you need. | admin |  |  |
| `pause_job` | Pause a waiting, active or delayed background job. | admin |  |  |
| `replay_job` | Replay a completed/failed/dead job, optionally with modified data | admin |  |  |
| `resume_job` | Resume a paused background job (back to waiting). | admin |  |  |
| `retry_job` | Re-queue a failed or dead background job. | admin |  |  |
| `send_job_message` | Send a sidechannel message to a running job's inbox (for jobs that read steering messages). | admin |  |  |
| `submit_agent` | Submit an agent job (agent scope; tools and budget bound to your client). | agent | yes |  |
| `submit_job` | Submit a background job. | admin |  |  |

## links

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `add_link` | Create a typed link (edge) from one page to another in the same source. | write |  |  |
| `find_orphans` | Find disconnected pages. | read |  |  |
| `get_backlinks` | Links to a page; group:"page" pages by referrer, newest first. | read | yes |  |
| `get_links` | List a page's outgoing links (typed edges to other pages). | read |  |  |
| `list_link_sources` | Link provenances in the brain (e.g. | read | yes |  |
| `remove_link` | Remove a link between two pages (optionally only one link_type or link_source). | write |  |  |
| `traverse_graph` | Walk the link graph from a page. | read | yes |  |
| `wanted_pages` | Link targets that have no page yet, most-referenced first: each was written as a link but its page does not exist, so no edge exists. | read |  |  |

## loops

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `loops_close` | Close an open loop by id: status 'done' (handled) or 'dropped' (not going to). | write |  |  |
| `loops_mute` | Suppress a sender (email address) or thread id from opening NEW loops — the detector feedback primitive behind "never track this sender". | write |  |  |
| `loops_unmute` | Remove a sender/thread suppression added by loops_mute, so the detector can open NEW loops for it again. | write |  |  |
| `open_loops` | The open-loop engine's killer output: who is waiting on you, what you promised, and the context needed to respond. | read |  |  |

## memory

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `extract_facts` | Extract personal-knowledge facts (events, preferences, commitments, beliefs, ideas, and plain facts) from a conversation turn into the per-source hot memory. | write |  |  |
| `forget_fact` | Forget a fact by recording a durable withdrawal in its source and visibility. | write |  |  |

## memory-verbs

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `context_pack` | MEMORY VERB (v1): core memory, budget-packed cards, open threads and hot facts for up to 8 entities, zero LLM. | read | yes |  |
| `delta` | MEMORY VERB (v1): pages, facts, thread events changed since a cursor, zero LLM. | read | yes |  |
| `entity` | MEMORY VERB (v1): person/company/account card, zero LLM. | read | yes |  |
| `forget` | MEMORY VERB (v1): expire a remembered fact by its fact_id (never a page slug). | write | yes |  |
| `recall` | MEMORY VERB (v1): read saved facts by entity, since or session_id; `query` also searches pages. | read | yes |  |
| `remember` | MEMORY VERB (v1): save facts with provenance. | write | yes |  |
| `synthesize` | [EXPENSIVE / SLOW: LLM calls, costs money] MEMORY VERB (v1): answer a broad question across pages with citations. | read | yes |  |

## ontology

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `ontology_conflicts` | Life Chronicle: dimensions with ≥2 distinct current values from ≥2 provenances (genuine disagreement, not temporal supersession). | read |  |  |
| `ontology_dimensions` | Life Chronicle meta-ontology: which dimensions the brain tracks across entities, with entity + observation counts. | read |  |  |
| `ontology_get` | Life Chronicle: the current resolved per-entity ontology (dimension → value) at `asof` (default now), with provenance + confidence + validity. | read |  |  |
| `ontology_propose` | Life Chronicle: record one ontology observation (entity has dimension=value), sourced + confidence-weighted + bi-temporal. | write |  |  |

## pages

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `cancel_write_request` | Cancel your accepted write before it publishes. | write | yes |  |
| `capture` | Quick note ("just remember this"): auto-slugged under inbox/ by date + content hash, so recapturing is idempotent. | write | yes |  |
| `delete_page` | Soft-delete a page and remove its markdown file from the source working tree (the source local_path, or sync.repo_path when the source has none). | write |  |  |
| `edit_page` | Change part of a page: prefer this over put_page for small changes. | write | yes |  |
| `fetch` | Fetch the full text of one search result by its opaque, source-qualified `id` (OpenAI deep-research contract: the search/fetch pair). | read |  |  |
| `get_chunks` | Return a page's indexed content chunks (the units search ranks). | read |  |  |
| `get_page` | Read a page by slug (fuzzy optional; renamed slugs redirect). | read | yes |  |
| `get_raw_data` | Retrieve raw data for a page. | read |  |  |
| `get_versions` | Page version history, newest snapshot first. | read |  |  |
| `get_write_request` | Read your write's receipt by request_id (after write_pending or a lost reply). | write | yes |  |
| `list_pages` | List pages with filters. | read | yes |  |
| `list_write_requests` | List your write receipts in one source, newest first. | write | yes |  |
| `put_page` | Complete content REPLACES the whole page: read get_page include_content:true, then send its revision as expected_revision and a request_id. | write | yes |  |
| `put_pages` | Write up to 50 complete Markdown pages (8 MB total) in one call; use instead of put_page for more than 3 pages. | write |  |  |
| `put_raw_data` | Store a raw provider payload (API response JSON) alongside a page, keyed by source. | write |  |  |
| `resolve_slugs` | Fuzzy-match a partial slug or title to page slugs. | read | yes |  |
| `restore_page` | Restore a soft-deleted page (clear deleted_at) and re-create its markdown file on disk (the counterpart to delete_page removing it; the result write_through field reports the outcome). | write |  |  |
| `revert_version` | Restore a page to an earlier version from its history (a new revision; history is kept). | write |  |  |

## schema

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `get_active_schema_pack` | Cheap identity packet for the active schema pack. | read |  |  |
| `list_schema_packs` | List installed schema packs (bundled + user-installed). | read |  |  |
| `reload_schema_pack` | Flush the in-process schema pack cache so the next loadActivePack re-reads from disk. | admin |  |  |
| `schema_apply_mutations` | Batched schema pack mutation. | admin |  |  |
| `schema_explain_type` | Resolved settings for a single page_type in the active pack. | read |  |  |
| `schema_graph` | Schema pack graph as JSON edges. | read |  |  |
| `schema_lint` | Lint the active (or named) schema pack. | read |  |  |
| `schema_review_orphans` | List pages with no active-pack type match. | read |  |  |
| `schema_stats` | Per-type page counts + typed-coverage from the DB. | read |  |  |

## search

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `assemble_evidence` | Deliver whole evidence for an ordered list of search hits (each {source_id, slug, chunk_id} from a prior search/query result): the same windows, sections or pages `query` returns with return_unit, packed into token_budget. | read |  |  |
| `cache_stats` | Semantic query-cache introspection: resolved knobs (enabled, similarity threshold, TTL) plus row counts and total hits. | admin |  |  |
| `query` | Hybrid search plus multi-query expansion for concept or landscape questions (expansion recovers synonym-phrased matches). | read | yes |  |
| `rate_answer` | Rate how useful an answer's retrieved evidence was, so this brain ranks better next time (zero LLM calls). | write |  |  |
| `search` | Cheap hybrid search (vector + keyword), no LLM expansion, top 20: for exact tokens, names, field values. | read | yes |  |
| `search_by_image` | Image-as-query retrieval. | read |  |  |
| `search_modes` | Read-only search-mode dashboard: active mode, EVERY mode-bundle knob resolved with attribution (mode default vs config override), the three frozen bundles, and a reranker_readiness verdict (whether the resolved reranker will actually run; remote callers get the verdict without the host key inventory). | read |  |  |
| `search_stats` | Search observability over a window: cache hit rate, intent/mode mix, budget drops, rank-1 score drift, graph-signals failure counts. | admin |  |  |
| `search_tune` | Read-only tuning recommendations derived from the last 7 days of search telemetry: what should change, why, and the paste-ready config command per recommendation — relay them to the user. | admin |  |  |

## skills

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `delete_skill` | CAS-delete a canonical shared skill and revoke future managed activation. | write + skill_editor | yes |  |
| `get_skill` | Fetch a skill's prose and follow it: when it says search or store, call the same-named MCP tool here. | read | yes | `mcp.publish_skills` |
| `get_skill_asset` | Read an approved file from an exact skill revision (data only; never executed). | read | yes | `mcp.publish_skills` |
| `get_skill_policy` | Read the owner publication policy and CAS epoch, including when sharing is disabled. | admin + skill_publisher |  |  |
| `join_brain` | Enroll this authenticated principal to follow approved shared skills. | read + skills_member_self | yes |  |
| `leave_brain` | Stop only this principal’s enrollment. | read + skills_member_self | yes |  |
| `list_brain_skillpack` | Skillpacks this brain ships, with skills and a scaffold spec to offer the user. | read | yes | `mcp.publish_skills` |
| `list_skills` | Skills: prose instruction sets (NOT executable code) for tasks with this server's tools, with triggers, usable_tools and unavailable_tools. | read | yes | `mcp.publish_skills` |
| `put_skill` | Publish a complete file-canonical skill revision with CAS and a durable receipt. | write + skill_editor | yes |  |
| `set_skill_policy` | Explicitly approve a versioned shared-skill disclosure and follow policy. | admin + skill_publisher |  |  |
| `sync_brain_skills` | Get a complete authorized shared-skills view and optionally record an own issued-batch delivery acknowledgment. | read + skills_member_self | yes |  |

## sources

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `sources_add` | Register a new source. | sources_admin |  |  |
| `sources_list` | List registered sources with page counts and remote_url. | read |  |  |
| `sources_remove` | Hard-remove a source (cascades pages/chunks/embeddings). | sources_admin |  |  |
| `sources_status` | Per-source diagnostic. | read |  |  |

## tags

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `add_tag` | Add one tag to a page (idempotent). | write |  |  |
| `get_tags` | List the tags on one page. | read |  |  |
| `remove_tag` | Remove one tag from a page. | write |  |  |

## takes

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `takes_add` | Record a take (typed claim) on a page: fact / take / bet / hunch, with a holder (who holds the belief: world, people/<slug>, companies/<slug>, or brain), weight 0..1, and optional source/since date. | write |  |  |
| `takes_calibration` | Calibration curve: resolved correct/incorrect bets binned by stated weight; observed vs predicted per bucket. | read |  |  |
| `takes_list` | List takes (typed/weighted/attributed claims) filtered by holder/kind/active/etc. | read |  |  |
| `takes_resolve` | Resolve a take: quality correct / incorrect / partial / unresolvable, with optional evidence text and measured value/unit. | write |  |  |
| `takes_scorecard` | Calibration scorecard for resolved bets: counts, accuracy, Brier (correct ∨ incorrect only), partial_rate. | read |  |  |
| `takes_search` | Keyword search across takes (pg_trgm similarity over claim text) | read |  |  |
| `takes_supersede` | Supersede a take with a replacement claim: the old row is struck through (kept for archaeology), the replacement appends at the next fence row number. | write |  |  |
| `takes_update` | Update a take's mutable fields (weight, source, since date). | write |  |  |
| `think` | Multi-hop synthesis across pages + takes + graph. | read |  |  |

## timeline

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `add_timeline_entry` | Append a dated entry to a page timeline. | write | yes |  |
| `get_timeline` | Get timeline entries for a page, optionally filtered by date window | read |  |  |

