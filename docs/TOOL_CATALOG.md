# MCP tool catalog

<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate: bun run scripts/generate-tool-catalog.ts -->
<!-- Freshness-guarded by scripts/check-tool-catalog-fresh.sh (bun run verify). -->

Every non-localOnly operation on the MCP surface: 118 tools across 22 areas. **Starter** marks membership in the ~27-op `starter` surface (`src/mcp/surface.ts`); **Gate** names the config key that must be true before remote callers see/call the op (`gbrain config set <key> true`). What a given token actually sees is further filtered per request by scope, bound-client fence, publish gates, and the per-client surface — see `docs/operations/mcp-surface-runbook.md`. Area names are non-contractual groupings.

## admin

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `get_health` | Brain health dashboard (embed coverage, stale pages, orphans). | admin |  |  |
| `get_stats` | Brain statistics (page count, chunk count, etc.) | admin |  |  |
| `get_status_snapshot` | Snapshot for `gbrain status` thin-client mode: sync freshness + last cycle + queue depths + worker liveness. | admin |  |  |
| `get_usage` | Aggregate chat usage + cost from the chat_usage_log ledger (per-model and per-phase token counts, cache reads/writes, USD estimates) with explicit coverage fields. | admin |  |  |
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
| `request_tools` | Discover this brain's tool catalog and optionally unlock a wider tool surface for your client. | read | yes |  |

## entities

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `entity_identity_list` | List cross-source entity identity groups and their member pages. | read |  |  |
| `extract_entities` | Extract entity names (people, companies) from text and create/update their brain stub pages. | write |  |  |
| `extraction_pending` | List unverified auto-extracted entity stubs awaiting owner review (the quarantine lane from extract_entities). | read |  |  |

## identity

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `get_brain_identity` | Brain identity + counters for thin-client banner. | read |  |  |
| `whoami` | Introspect the calling identity. | read | yes |  |

## ingest

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `get_ingest_log` | Get recent ingestion log entries | read | yes |  |
| `log_ingest` | Log an ingestion event | write |  |  |

## insights

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `find_anomalies` | Returns statistical anomalies in recent page activity, grouped by cohort (tag or type). | read | yes |  |
| `find_contradictions` | v0.32.6 — return suspected-contradiction findings from the most recent `gbrain eval suspected-contradictions` probe run, optionally filtered by slug and/or severity. | read |  |  |
| `find_experts` | Answers 'who in my brain knows about <topic>'. | read |  |  |
| `find_trajectory` | v0.35.4 — return the chronological claim trajectory for an entity (typed metric values over time, plus auto-detected regressions and narrative drift). | read |  |  |
| `get_calibration_profile` | Read the active calibration profile for a holder. | read |  |  |
| `get_recent_salience` | Returns pages recently touched and ranked by emotional + activity salience (deterministic 0..1 emotional_weight + take density + recency decay). | read | yes |  |
| `volunteer_context` | Push-based context: volunteer brain pages relevant to a rolling conversation window WITHOUT being asked. | read |  |  |

## jobs

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `cancel_job` | Cancel a waiting, active, or delayed job. | admin |  |  |
| `get_agent_job` | Poll an agent job submitted via submit_agent. | agent | yes |  |
| `get_job` | Get job status and details by ID. | admin |  |  |
| `get_job_progress` | Get structured progress for a running job. | admin |  |  |
| `get_job_stats` | Job queue statistics. | admin |  |  |
| `list_jobs` | List jobs with optional filters. | admin |  |  |
| `pause_job` | Pause a waiting, active, or delayed job | admin |  |  |
| `replay_job` | Replay a completed/failed/dead job, optionally with modified data | admin |  |  |
| `resume_job` | Resume a paused job back to waiting | admin |  |  |
| `retry_job` | Re-queue a failed or dead job for retry | admin |  |  |
| `send_job_message` | Send a sidechannel message to a running job's inbox | admin |  |  |
| `submit_agent` | Submit an LLM agent job that the worker dispatches via the gateway-native tool loop. | agent | yes |  |
| `submit_job` | Submit a background job to the Minions queue. | admin |  |  |

## links

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `add_link` | Create link between pages | write |  |  |
| `find_orphans` | Find disconnected pages. | read |  |  |
| `get_backlinks` | List incoming links to a page | read | yes |  |
| `get_links` | List outgoing links from a page | read |  |  |
| `list_link_sources` | List distinct link_source provenances in the brain with edge counts (e.g. | read | yes |  |
| `remove_link` | Remove link between pages | write |  |  |
| `traverse_graph` | Traverse link graph from a page. | read | yes |  |

## memory

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `extract_facts` | v0.31: extract personal-knowledge facts (events, preferences, commitments, beliefs) from a conversation turn into the per-source hot memory. | write |  |  |
| `forget_fact` | v0.32.2: forget a fact. | write |  |  |

## memory-verbs

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `context_pack` | MEMORY VERB (v1): budget-packed session-boundary bundle for a set of standing entities — entity cards + open threads + hot facts, zero-LLM, sub-second. | read | yes |  |
| `delta` | MEMORY VERB (v1): "what changed since T" for heartbeats — pages updated after `since` + hot facts newer than `since` + open-thread events after `since`, zero-LLM. | read | yes |  |
| `entity` | MEMORY VERB (v1): inspect ONE known person/company/project card — zero LLM calls, sub-100ms. | read | yes |  |
| `forget` | MEMORY VERB (v1): expire a remembered fact by id — the protocol delete verb. | write | yes |  |
| `recall` | MEMORY VERB (v1): retrieve saved facts/snippets — the protocol read verb. | read | yes |  |
| `remember` | MEMORY VERB (v1): save one fact to durable agent memory — the protocol write verb. | write | yes |  |
| `synthesize` | [EXPENSIVE / SLOW — makes LLM calls, seconds-to-minutes latency, costs money] MEMORY VERB (v1): answer a broad question using cross-page LLM reasoning with citations and gap analysis. | read | yes |  |

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
| `capture` | Capture a quick note into the brain — the "just remember this" write. | write | yes |  |
| `delete_page` | Soft-delete a page. | write |  |  |
| `fetch` | Fetch the full text of one search result by its `id` (OpenAI deep-research contract: the search/fetch pair). | read |  |  |
| `get_chunks` | Get content chunks for a page | read |  |  |
| `get_page` | Read a page by slug (supports optional fuzzy matching). | read | yes |  |
| `get_raw_data` | Retrieve raw data for a page | read |  |  |
| `get_versions` | Page version history | read |  |  |
| `list_pages` | List pages with optional filters. | read | yes |  |
| `put_page` | Write/update a page (markdown with frontmatter). | write | yes |  |
| `put_raw_data` | Store raw API response data for a page | write |  |  |
| `resolve_slugs` | Fuzzy-resolve a partial slug to matching page slugs | read | yes |  |
| `restore_page` | v0.26.5 — restore a soft-deleted page (clear deleted_at). | write |  |  |
| `revert_version` | Revert page to a previous version | write |  |  |

## schema

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `get_active_schema_pack` | v0.40.6.0: cheap identity packet for the active schema pack. | read |  |  |
| `list_schema_packs` | v0.40.6.0: list installed schema packs (bundled + user-installed). | read |  |  |
| `reload_schema_pack` | v0.40.6.0: flush the in-process schema pack cache so the next loadActivePack re-reads from disk. | admin |  |  |
| `schema_apply_mutations` | v0.40.7.0: batched schema pack mutation. | admin |  |  |
| `schema_explain_type` | v0.40.6.0: resolved settings for a single page_type in the active pack. | read |  |  |
| `schema_graph` | v0.40.6.0: schema pack graph as JSON edges. | read |  |  |
| `schema_lint` | v0.40.6.0: lint the active (or named) schema pack. | read |  |  |
| `schema_review_orphans` | v0.40.6.0: list pages with no active-pack type match. | read |  |  |
| `schema_stats` | v0.40.6.0: per-type page counts + typed-coverage from the DB. | read |  |  |

## search

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `cache_stats` | Semantic query-cache introspection: resolved knobs (enabled, similarity threshold, TTL) plus row counts and total hits. | admin |  |  |
| `query` | Hybrid search with vector + keyword + multi-query expansion. | read | yes |  |
| `search` | Cheap hybrid search (vector + keyword + RRF) with no LLM expansion. | read | yes |  |
| `search_by_image` | v0.36 cross-modal Phase 2: image-as-query retrieval. | read |  |  |
| `search_modes` | Read-only search-mode dashboard: active mode, per-knob resolved value with attribution (mode default vs config override), and the three frozen bundles. | read |  |  |
| `search_stats` | Search observability over a window: cache hit rate, intent/mode mix, budget drops, rank-1 score drift, graph-signals failure counts. | admin |  |  |
| `search_tune` | Read-only tuning recommendations derived from the last 7 days of search telemetry: what should change, why, and the paste-ready config command per recommendation — relay them to the user. | admin |  |  |

## skills

| Tool | Description | Scope | Starter | Gate |
|---|---|---|---|---|
| `get_skill` | Fetch one skill's full instructions by name. | read |  | `mcp.publish_skills` |
| `list_brain_skillpack` | List brain-resident skillpacks this brain ships (per-source). | read |  | `mcp.publish_skills` |
| `list_skills` | List the skills this agent's brain publishes. | read |  | `mcp.publish_skills` |

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
| `add_tag` | Add tag to page | write |  |  |
| `get_tags` | List tags for a page | read |  |  |
| `remove_tag` | Remove tag from page | write |  |  |

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
| `add_timeline_entry` | Add timeline entry to a page. | write | yes |  |
| `get_timeline` | Get timeline entries for a page, optionally filtered by date window | read |  |  |

