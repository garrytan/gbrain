# 02 Schema map: `src/schema.sql`

Line numbers refer to gbrain 36bd05806a.

Reference: `garrytan/gbrain` v0.60.733.0, commit 36bd05806a (read-only). All 3,794 lines were read. "Verified" means read in the file or in code. "Inferred" means taken from a table name or comment. Line numbers refer to `src/schema.sql` unless a path is given.

## 1. Shape of the file

- Applied as one batch. `src/core/postgres-engine.ts:194-206` rewrites `vector(1536)`, the default embedding model, and the `embedding_dimensions` config row first. HNSW is skipped above 2,000 dimensions (`src/core/vector-index.ts:20-33`).
- Extensions: `vector`, `pg_trgm`, `pgcrypto` (lines 3-6).
- Grep counts (verified): 132 top-level `CREATE TABLE IF NOT EXISTS` (the phrase appears 134 times; two hits are comments at 1368 and 1376). 191 `CREATE [UNIQUE] INDEX`, including 2 HNSW, 8 GIN, 2 trigram. 26 literal `CREATE TRIGGER`, plus one dynamic loop. 22 functions. 3 sequences. 2 generated columns. 28 direct `ENABLE ROW LEVEL SECURITY` statements, plus three loops. Zero `CREATE POLICY` in `src/`.
- About 46 more tables come from migrations (section 10).
- 27 blocks are marked `BEGIN GENERATED from src/core/<module>.ts`. The TS module is the spec for each block.

## 2. Classes, hot paths, conventions

- **AUTH**: cannot be rebuilt from Markdown (`docs/architecture/system-of-record.md`, "DB-only by design").
- **DER**: derived index or cache. Rebuildable from Markdown or by re-running work, which can cost money.
- **LOG**: log or telemetry, droppable.
- **COORD**: locks, queues, leases, state machines, request journals. Some must not be dropped.
- **Hot**: R = search or read path; W = every write; blank = cold.
- **GI** = loss kind from `src/core/persistence/graduation-inventory.ts`, a code-level classification. Compared in section 12.

## 3. Core content

| Tables (lines) | Keys, constraints, indexes | Class | Hot |
|---|---|---|---|
| `sources` (26-90, 1867-1879, 3559-3561) | PK `id`; UQ `name`, `incarnation` (UUID); `config` JSONB; `archived` + `archive_expires_at` (72h soft delete); partial IX on `config->>'github_repo'`. Seeds `default` (78-81). | AUTH | R |
| `pages` (99-179, 1183-1234, 1880-1892) | PK `id` SERIAL; UQ `(source_id, slug)`; FK `source_id` CASCADE; CK `page_kind` markdown/code/image. Columns: `compiled_truth`, `timeline`, `frontmatter` JSONB, `content_hash`, `deleted_at`, `generation`, `knowledge_revision` UUID, `text_projection_revision`, `search_vector`, `links_extracted_at`, `database_only_reason`. Indexes include frontmatter GIN, title and slug trigram GIN, `search_vector` GIN, `(source_id, lower(title))`, `updated_at DESC`, and `COALESCE(effective_date, updated_at)`. | DER for file-backed rows; AUTH where `database_only_reason` is set | R+W |
| `page_generation_clock` (242-248), seq `page_generation_clock_seq` (255-265) | Single row, CK `id = 1`; `value`. The sequence is the live clock. | COORD | W |
| `page_retrievals` (308-311) | PK `page_id`, no FK on purpose (305). Written at most once per page per 5 min (298-307). | LOG | W (read) |
| `content_chunks` (354-420, 432-458) | PK `id`; UQ `(page_id, chunk_index)`; FK CASCADE. `chunk_text`; `embedding vector(1536)` (rewritten at init); `embedding_image vector(1024)`; `embedding_multimodal vector(1024)`; `search_vector` TSVECTOR; `modality`; hashes; code columns (`symbol_name`, `symbol_name_qualified`, `parent_symbol_path` TEXT[], `doc_comment`, lines). IX: HNSW cosine on `embedding`; partial HNSW on `embedding_image`; GIN on `search_vector`; partial `WHERE embedding IS NULL`. | DER (GI user_data: paid embeddings) | R+W |
| `code_edges_chunk` (472-495), `code_edges_symbol` (497-516) | Resolved edges UQ `(from_chunk_id, to_chunk_id, edge_type)`; unresolved refs UQ `(from_chunk_id, to_symbol_qualified, edge_type)`. FKs to chunks CASCADE; `source_id` FK. | DER | R |
| `links` (549-590) | PK `id`; UQ NULLS NOT DISTINCT `(from, to, link_type, link_source, origin_page_id)` (582-583). CK `link_source` regex `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, ≤64 chars; CKs on `link_kind`, `resolution_type`, `assertion_tense`. `origin_page_id` FK SET NULL. Partial IX on `to_page_id` WHERE `link_type='supersedes'`. | DER for markdown, frontmatter, mention edges; AUTH for `manual` and CLI-added edges (inferred from 521-548) | R+W |
| `wanted_links` (595-611) | BIGSERIAL; UQ `(origin_page_id, producer, ref_kind, target_source_id, target_ref)`. | DER | |
| `tags` (616-626) | UQ `(page_id, tag)`; `tag_source` ('frontmatter', 'added', NULL). | DER; 'added' AUTH (inferred) | R+W |
| `raw_data` (631-640) | UQ `(page_id, source)`; `data` JSONB sidecar. | AUTH (named DB-only in system-of-record.md) | |
| `timeline_entries` (645-674) | FK `page_id`, `event_page_id` CASCADE. UQ expression `(page_id, date, md5(summary), source)` (670). Partial UQ `(event_page_id, date)` (674). | DER | R+W |
| `page_versions` (679-690; cols 1893-1898, 1966) | FK CASCADE; `compiled_truth`, `frontmatter`, `snapshot_at`; added `knowledge_revision`, `timeline`, `title`, `type`, `tags`, `is_deleted`, `source_path`. Attribution columns come from migrations. | DER per doc; attribution not rebuildable | W |
| `ingest_log` (700-715) | `source_type`, `source_ref`, `pages_updated` JSONB, `writer_version`, `writer_host_id`. | LOG | W |
| `config` (720-730) | PK `key`; `value` TEXT. Seeds version, embedding model, dimensions, chunk strategy. | AUTH (some keys site-local) | R |
| `files` (1136-1158), `file_migration_ledger` (1168-1178) | `files`: UQ `storage_path`; FKs source CASCADE, `page_id` SET NULL; `content_hash`, `metadata`. Ledger: PK `file_id`, CK status (5). | `files` AUTH (inferred); ledger COORD | |
| `page_write_guards` (1899-1903) | PK `(source_incarnation, slug)`; FK incarnation CASCADE. | COORD (inferred) | W |
| `page_projection_jobs` (2689-2696) | PK `(source_incarnation, slug)`; `revision`, `reason`. Filled by trigger. | COORD | W |
| `page_embedding_budget` (2062-2074) | PK `page_id`; CK state open/held/capped; spend and reserve ≥0. | COORD | W |
| `page_extraction_state` (2132-2143) | PK `(page_id, pipeline)`; watermark bytes and sha256; `input_truncated` JSONB. | COORD | W |
| `page_view_digests` (2146-2156) | PK `(page_id, revision, view, audience)`; byte and line totals, sha256. | DER (GI rebuild) | R |
| `page_segment_texts` (2162-2170) | PK `(source_id, sha256)`; `body` BYTEA; CK `byte_len` 1 to 1,048,576. | DER per doc; GI user_data | R |
| `page_body_manifest` (2171-2202) | PK `(page_id, occurrence_id, gen_from, staging_key)`; `staging_key` GENERATED STORED (2195). FK `(source_id, sha256)`→segment texts. Partial UQ `(page_id, seq)` for live, unstaged rows. | DER manifest; staging rows COORD | R |
| `page_body_stagings` (2203-2229), `_parts` (2230-2238), `_texts` (2239-2245) | Upload staging: states open, sealed, prepared, committed, aborted, expired; parts ≤4 MiB; hard-expiry partial IX. | COORD | |

## 4. Auth, grants, withdrawal ledger

| Tables (lines) | Keys, constraints | Class | Hot |
|---|---|---|---|
| `access_tokens` (735-745) | UUID PK; `token_hash` UQ (hash only); `scopes`; `revoked_at`; partial IX for unrevoked. | AUTH | R (inferred) |
| `mcp_request_log` (750-760, 865-866) | SERIAL; `token_name`, `agent_name`, `operation`, `latency_ms`, `params` JSONB. Retention rollup is a migration table. | LOG | W |
| `oauth_clients` (765-809) | PK `client_id`; `client_secret_hash`; `redirect_uris`; `federated_read` (GIN); FK `source_id` RESTRICT; budget, binding, `surface`, `grant_revision`; CK `source_grant` in ('none'). | AUTH | R (inferred) |
| `oauth_tokens` (838-849), `oauth_codes` (851-862) | Token PK `token_hash`; code PK `code_hash` with PKCE fields; FK client CASCADE; `expires_at` BIGINT. | AUTH; GI discard for codes (243) | R (tokens) |
| `oauth_grant_audit` (813-823) | BIGSERIAL; `before_grant`, `after_grant` JSONB; IX `(client_id, created_at)`. | LOG (GI security) | |
| `fact_withdrawals` (828-835) | PK `(source_id, visibility, subject, fact_hash)`; CK visibility private/world; `subject` default `*`. | AUTH (withdrawal ledger, per doc) | R (inferred) |

## 5. Operations, telemetry, per-domain state

| Tables (lines) | Keys, constraints | Class | Hot |
|---|---|---|---|
| `op_checkpoints` (878-893), `op_checkpoint_paths` (900-908) | PK `(op, fingerprint)`; `completed_keys` JSONB array (CK); expression IX for sync holds. Paths PK `(op, fingerprint, path)`, FK CASCADE. | COORD (paths droppable after sync, per doc) | |
| `context_volunteer_events` (915-930) | BIGSERIAL; slug, confidence, `match_arm`; 90-day prune. | LOG | W |
| `retrieval_events` (936-942), `retrieval_event_pages` (943-951), `retrieval_event_links` (952-958) | Event TEXT PK; CK op (query, search, think, synthesize, recall). Pages PK `(event_id, source_id, slug)`, `rank`, `cited`. Links `edge_key`, `to_slug`. | LOG | W (inferred) |
| `retrieval_feedback` (959-973) | PK `(event_id, signal, element_kind, source_id, element_key)`; rating 1-5; weight before and after. | LOG | |
| `retrieval_weights` (974-983) | PK `(source_id, element_kind, element_key)`; weight REAL CK 0-1, default 0.5. | DER (learned; reset if feedback lost; inferred) | R (inferred) |
| `session_context_state` (991-1006) | PK `(source_id, client_id, session_id)`; JSONB arrays; `facts_cursor_at`/`_id`; `degraded_wakes`. | COORD | R+W (inferred) |
| `extract_atoms_transcript_state` (1036-1050), `extract_atoms_page_state` (1967-1981) | Transcript PK `(source_id, file_path, content_hash)`; page PK `(source_incarnation, page_id, content_hash)`. Failure streak, `tombstoned`. | COORD | |
| `chat_usage_log` (1057-1072) | BIGSERIAL; token counts; `cost_usd` NULL when unpriced (1054). | LOG | W |
| `open_loops` (1078-1109), `loop_suppressions` (1114-1121) | Loops: UQ `(source_id, dedup_key)`; CKs on `loop_type` (5), `status` (4), `detector`; `fact_id` with no FK. Suppressions UQ `(source_id, kind, value)`. Loops close, never delete (1076). | AUTH (inferred) | R (inferred) |
| `migration_impact_log` (1377-1395) | BIGSERIAL; before and after metrics; `job_id` FK SET NULL. | LOG | |
| `dream_verdicts` (1485-1505) | PK `(file_path, content_hash)`; `score`; JSONB `segments`, `entities`; `expires_at` default now()+30 days. | DER (paid triage cache; GI operational) | W |
| `dream_synthesis_completions` (2124-2129), `chronicle_judge_reservations` (2115-2122) | Completions PK `(source_id, idempotency_key)`; reservations BIGSERIAL, no FK. | COORD | |
| `chronicle_page_state` (2077-2114) | PK `(source_id, page_id, content_hash, extractor_version)`; CKs on state (4) and trigger; `attempts`, `next_attempt_at`, `cost_usd`, `event_slugs` TEXT[]. | COORD (GI user_data: "paid work done") | W |

## 6. Queues, locks, request journal, persistence

| Tables (lines) | Keys, constraints, indexes | Class | Hot |
|---|---|---|---|
| `minion_jobs` (1248-1321; triggers 1789-1825) | SERIAL; CK status (9 values, 1292); `claim_generation` BIGINT; `submission_authority` JSONB; `lock_token`, `lock_until`; `parent_job_id` FK SET NULL; `idempotency_key` partial UQ; CK `lock_duration_ms` 5,000-3,600,000. Claim IX partial WHERE waiting. | COORD | W |
| `minion_inbox` (1324-1333), `minion_attachments` (1336-1351) | Inbox FK CASCADE. Attachments UQ `(job_id, filename)`; `content` BYTEA EXTERNAL; CK content or `storage_uri` present. | COORD (attachments droppable, per doc) | |
| `subagent_messages` (1403-1425), `subagent_tool_executions` (1438-1463) | Messages UQ `(job_id, message_idx)`, `content_blocks` JSONB. Tool executions UQ `(job_id, message_idx, ordinal)`; CK status. | COORD (replay state) | |
| `subagent_rate_leases` (1469-1476), `gbrain_cycle_locks` (1516-1532) | Leases FK job CASCADE, IX `(key, expires_at)`. Cycle lock PK `id`; `ttl_expires_at`; `acquisition_token` UUID. | COORD (GI discard) | |
| `persistence_requests` (2450-2488) | UUID PK; UQ `(principal_kind, principal_id, request_id)`; UQ `sequence`; CK state (7); `digest`; JSONB `intent`, `authority`, `outcome`, `recovery`; CK `target_kind`, `protocol_version`. | COORD; idempotent replay identity, not droppable | W |
| `persistence_effects` (2489-2499) | BIGSERIAL; FK request; UQ `(request_id, kind)`; CK state (4). Outbox. | COORD; not droppable | W |
| `persistence_topology_changes` (2771-2791), `persistence_worktree_refreshes` (2795-2816) | Topology UQ `(principal_id, request_id)`; refresh partial UQ: one active per worktree. | COORD | |
| `persistence_worktrees` (2409-2418), `_source_bindings` (2419-2425), `_host_bindings` (2426-2433), `_counters` (2442-2449), `_consumers` (2500-2521), `_writer_protocols` (2943-2950) | Worktree UUID PK; source binding PK `source_id`; host binding PK `(worktree_id, host_id)`; counters non-negative CKs; consumers PK `(host_id, pid, nonce)` (heartbeats); protocol PK `(worktree_id, host_id)`. | COORD (`consumers` GI discard) | W |
| `persistence_local_writers` (2434-2441) | UUID PK; `credential_hash` UQ; `grant_ceiling` JSONB; `revoked_at`. | AUTH (credential) | |
| `persistence_brain` (2402-2408; ALTERs 2939-2940) | singleton CK 1; `brain_id` UUID; `enabled`; `writer_protocol_floor` CK 1/2; `skill_bundles_enabled`. | AUTH (GI rebind) | R (guards) |
| `git_canonical_brain` (2643-2646) | Singleton; `strict_sources` counter kept by three triggers on `sources` (2660-2671). | COORD | W |
| `sync_wanted_markers` (3733-3744), `sync_notifier_leases` (3745-3753), `sync_notifier_sources` (3754-3777) | Markers PK `(source_id, intent)`; leases PK `host_id`, fence BIGINT; sources PK `source_id`, CK state (5). | COORD (leases and sources GI discard) | |
| `needs_rederive` (3483-3496), `core_edit_notices` (3404-3421) | Rederive PK `(derived_table, derived_id)`. Notices BIGSERIAL, partial IX on unacked. | COORD | |

## 7. Generations, derivations, purges

| Tables (lines) | Keys, constraints | Class | Hot |
|---|---|---|---|
| `derived_generations` (1984-2013), `_items` (2014-2025), `_valve` (2026-2033), `_attempts` (2034-2043), `_activations` (2044-2058) | Generations: CK state (live, held, superseded), CK `held_reason` (8 values); partial UQs: one live and one held per `(source_id, kind, owner_key)` (2010-2011). Items PK `(generation_id, item_key)`. Valve PK `(source_id, kind, window_key)`. | COORD (GI user_data for generations) | |
| `page_segment_derivations` (2250-2264) | PK `(page_id, pipeline, occurrence_id)`; CK pipeline (7); 32-byte `segment_sha256`, `context_hash`; CK state; JSONB `output`, `receipt`. Trigger refuses purged content (2345-2382). | DER watermarks (GI operational) | W |
| `page_derivation_spend` (2265-2273) | PK `(page_id, family)`; family facts or synopsis; spend and reserve ≥0. | COORD | W |
| `page_segment_derivation_purges` (2274-2292), `_purge_pages` (2293-2297) | Request PK `request_id`; `needles`, `patterns` TEXT[]; phase CK sweep/verify/recheck; cursors. | COORD | |
| `derivation_inputs` (3468-3481) | PK `(derived_table, derived_id, input_table, input_id)`; IX on input. | DER (lineage) | |
| `fact_purges` (3426-3436), `take_purges` (3442-3449), `page_purges` (3455-3462) | PKs `(source, visibility, subject, fact_hash)`, `(source, subject, claim_hash)`, `(source, content_hash)`. | AUTH (inferred: purge ledger) | R (inferred) |
| `write_gate_receipts` (3506-3523), `write_gate_holds` (3524-3553) | Receipts UQ `(target_table, target_id, content_hash, detector_version)`. Holds UQ `(source_id, slug, fingerprint, detector_version)`; CKs on kind, status (held/released/dropped); `payload` JSONB. | Receipts LOG; holds AUTH (inferred: only copy until decided) | W |
| `fact_relink_attempts` (3298-3315) | PK `(source_id, fact_id)`; `outcome`, `attempted_at`. | LOG | |

## 8. Links, questions, decisions, eval, takes

| Tables (lines) | Keys, constraints | Class | Hot |
|---|---|---|---|
| `link_transitions` (3320-3343) | BIGSERIAL; identity UQ NULLS NOT DISTINCT over 8 columns (3335-3336); CKs on kind and producer (includes `manual`). | DER (mixed: manual rows are DB-only) | |
| `link_relationships` (3344-3370) | PK `(from, to, link_type, scope)`; `valid_ranges` DATEMULTIRANGE; CK `status_now` (6). | DER | |
| `link_edge_proposals` (3372-3392), `graph_generation_seq` (3399) | UQ `(from, a_to, b_to, link_type, evidence_hash)`; CK status (10). | COORD | |
| `pinned_questions` (3565-3598), `question_evidence` (3600-3615) | Questions UQ `(source_id, slug)`; definitions plus lease and spend columns. Evidence: `answer_revision`, page refs. | Questions AUTH (inferred); evidence DER | R (inferred) |
| `belief_events` (3630-3669) | BIGSERIAL; `event_key` BYTEA UQ; CKs on `subject_kind` (6) and `origin` (5); `value`, `value_hash`, `prior_hash`, `state_hash`, `cause` JSONB. Append-only. | AUTH (history not rebuildable, per doc) | W |
| `belief_page_lifetimes` (3671-3686), `belief_commit_marks` (3687-3690), `belief_retier_manifest` (3696-3709), `belief_redactions` (3710-3727) | Lifetimes PK UUID; partial UQ `(source_incarnation, slug)` while open. Commit marks PK `publication_id`. Retier PK `(summary_event, subject_kind, subject_key)`. Redactions BIGSERIAL. | AUTH | |
| `decision_receipts` (3102-3137), `decide_spend` (3138-3151) | Receipts BIGSERIAL with `decision_id`, `slot`, `outcome`. Spend PK `request_id`, `cost_usd`. | LOG | W |
| `decide_state` (3152-3156), `decide_proposals` (3207-3226), `decide_sweep_deferred` (3227-3236), `decide_review_queue` (3252-3263), `decide_review_proposals` (3264-3283) | State KV PK `key`. Proposals UQ `(sweep_id, pair_index)` and claim-pair UQ (3248), CK status. Deferred PK `(slot, source_id, fact_id)`. Review queue PK `(kind, source_id, a_ref, b_ref)`. | COORD | |
| `decide_calibrations` (3173-3200) | BIGSERIAL; `threshold`, `metric`, `ece`, `qualification`, `retired_at`. | DER | |
| `eval_candidates` (1543-1576), `eval_capture_failures` (1578-1583), `eval_contradictions_runs` (1631-1649), `think_ab_results` (1772-1785), `take_nudge_log` (1749-1768) | Candidates: CK query length ≤51,200; `retrieved_slugs` TEXT[]; `retrieved_chunk_ids` INTEGER[]. Nudge log XOR CK on take or proposal. | LOG | |
| `eval_takes_quality_runs` (1591-1612) | UQ on four sha8 columns; CK verdict; `receipt_json`. Code comment calls these DB-authoritative (1585-1590). | LOG per name; comment disagrees | |
| `eval_contradictions_cache` (1614-1626), `calibration_profiles` (1659-1686), `take_grade_cache` (1727-1747) | Cache PK on five columns with `expires_at`. Profiles FK CASCADE, GIN on `active_bias_tags`. Grade cache PK on four columns, CK verdict, `applied` default false. | DER | |
| `take_proposals` (1690-1720) | UQ expression `(source_id, page_slug, content_hash, prompt_version, md5(claim_text))`; CK status (4); `acted_by`. | COORD | |

## 9. Triggers, functions, RLS, GUCs

**Triggers** (all in this file):

| Trigger (table, timing) | Function (lines) | Effect |
|---|---|---|
| `bump_page_generation_trg` (pages, row, before I/U) | `bump_page_generation_fn` (182-205) | Insert: `generation` = max+1. Update: +1 when a content column changes (`compiled_truth`, `timeline`, `frontmatter`, `deleted_at`, `title`, `type`, `page_kind`, `content_hash`, others). |
| `bump_page_generation_clock_trg` (pages, statement, after I/U/D) | `bump_page_generation_clock_fn` (267-278) | `nextval(page_generation_clock_seq)`. Global cache-bookmark clock. |
| `pages_forget_retrievals` (pages, statement, after delete) | `gbrain_forget_page_retrievals` (313-334) | Deletes `page_retrievals` rows of deleted pages. |
| `chunk_search_vector_trigger` (content_chunks, row, before I/U OF text, doc, qualified name) | `update_chunk_search_vector` (444-458) | `search_vector` = A(doc comment, qualified name) \|\| B(chunk text). |
| `trg_pages_search_vector` (pages, row, before I/U OF title, timeline, timeline_lead) | `update_page_search_vector` (1196-1234; re-declared 2683-2688) | Title weight A; timeline text weight C. Body not indexed (1189-1192). |
| `pages_knowledge_revision` (pages, row, before U) | `gbrain_advance_page_revision` (1904-1936) | New `knowledge_revision` UUID on identity or content change. Honours GUC `gbrain.materializing_revision` (1920-1925). |
| `tags_knowledge_revision` (tags, row, after I/U/D) | `gbrain_advance_tag_revision` (1937-1961) | Bumps owning page's `knowledge_revision`. |
| `pages_projection_queue` (pages, row, after I/U/D) | `gbrain_queue_page_projection` (2697-2766) | Upserts or deletes `page_projection_jobs`. |
| `page_body_manifest_derivation_scope_retire` / `_delete`, `pages_derivation_scope_delete` | `gbrain_mark_derivation_scope_entry` (2298-2335) | Shared advisory lock on the source; copies in-flight purge requests into `_purge_pages`. |
| `page_segment_derivations_refuse_purging` (before I/U OF output, receipt) | `gbrain_refuse_purging_derivation` (2345-2379) | Rejects writes containing purged needles (normalized text, `jsonb_path_query`). |
| `minion_queue_protocol` (minion_jobs, row, before I/U) | `enforce_minion_queue_protocol` (1789-1810) | Claims must advance `claim_generation` by 1; old workers refused; spend tokens checked. |
| `minion_job_notify` (minion_jobs, row, after I/U OF status) | `notify_minion_job_change` (1813-1825) | `pg_notify('minion_jobs', …)`. |
| `managed_writer_guard` (created in loop, 2629-2638) | `gbrain_require_managed_writer` (2522-2627) | On pages, tags, slug_aliases, page_aliases, facts, takes, timeline_entries, sources, page_segment_texts, page_body_manifest: refuses writes outside GUC `gbrain.write_sources`; enforces git-canonical and topology gates. |
| `git_canonical_sources_count_*` (sources, after I/U/D) | `gbrain_count_git_canonical_sources` (2647-2659) | Recounts strict sources. |
| `gbrain_request_protocol`, `gbrain_effect_protocol` (persistence_requests, persistence_effects) | `gbrain_guard_request_protocol` (2957-2995), `gbrain_guard_effect_protocol` (2999-3007) | Protocol floor; skill-target and recovery-version checks. |
| `gbrain_protocol_activation` (persistence_brain, before U) | `gbrain_guard_protocol_activation` (3011-3034) | Floor only rises; activation needs quiesced writers. |
| `gbrain_skill_publication` (shared_skill_packs, _heads, _revisions) | `gbrain_guard_skill_publication` (3038-3054) | Requires a coordinated source capability. |
| `shared_skill_delivery_lease` (shared_skill_delivery_batches, after I / U OF revisions) | `gbrain_lease_shared_skill_delivery` (3064-3081) | FOR KEY SHARE on each revision; inserts 24h leases. |

Migration v035 adds an event trigger, `auto_rls_on_create_table`, that is not in this file.

**Functions:** 22 in this file. Besides the 19 in the trigger table, there are `gbrain_try_jsonb` (64), `gbrain_fts_input` (432-436; spaces between CJK and ASCII runs), and `gbrain_require_persistence_protocol` (2951; raises 42501 unless GUC `gbrain.persistence_protocol` = '2'). Lines 3781-3793 reset `search_path` on 56 named functions, some created by migrations.

**GUCs the guards read:** `gbrain.write_sources` (allowlist JSON), `gbrain.topology_change`, `gbrain.git_protocol`, `gbrain.persistence_protocol`, `gbrain.writer_quiesced`, `gbrain.materializing_revision`.

**RLS (verified):** 28 direct `ENABLE ROW LEVEL SECURITY` statements, plus loops over 35 names (1846-1853), 10 page-body tables (2390-2394), and 10 shared-skill tables (3091-3094). All are conditional on the role having BYPASSRLS or superuser (1841-1861). No `CREATE POLICY` exists in `src/`, so any other role sees zero rows in these tables. Some guards raise `unreadable` errors when they cannot see a row they must check (2584, 2612).

**Sequences:** `page_generation_clock_seq` (255), `page_body_occurrence_id_seq` (2161), `graph_generation_seq` (3399). About 47 lines declare SERIAL or BIGSERIAL (grep). **Generated columns:** `page_body_manifest.staging_key` (2195), `shared_skill_revisions.stored_bytes` (2889).

## 10. Migration-only tables (outside this file)

About 46 tables come from migrations and `schema-missing-tables.ts`. Groups: `facts` (v045, line 113) and `takes` (v037); `slug_aliases` (v105); `page_aliases` (v110); `query_cache` (v055) and `code_traversal_cache` (v059); `synthesis_evidence`; `access_*` (eight tables, v282-v299: members, groups, rules, policy state and revisions, pending coverage, migrations); `budget_*` and `mcp_spend_*`; `mcp_request_log_rollup`; `memory_proposals`; `page_mention_state`, `mention_index_status`, `mention_gazetteer_entries`; `drift_decisions`; `entity_identities`; `search_telemetry`; six `wake_*` tables; `reason_purge_tombstones`; `slug_rename_history`; `page_label_guards`; `take_domain_assignments`, `take_horizons`; `ingest_applied_captures`. Later drops: not verified. `facts` embedding is templated (`${vecType}(${embeddingDim})`, `src/core/engine-sql/facts.ts`). `takes` embedding was rebuilt to the config dimension in v142.

## 11. Hot paths

- **Search and read (R):** `sources` (filter on every search); `content_chunks` (keyword GIN and vector HNSW; 27 query sites in `engine-sql/chunks.ts`); `pages` (join, `deleted_at IS NULL`, `search_vector`, trigram); `links` (graph ranking; 15 FROM and 7 JOIN sites in `engine-sql/links.ts`); `tags` and `takes` (salience, `engine-sql/salience.ts`); `code_edges_*`; `facts`; segmented-page tables; Auth tables per request (inferred).
- **Every page write (W):** `pages` (three triggers, guard, projection queue); `page_generation_clock`; `tags`; `content_chunks` (re-inserted on page change, 422-423); `page_versions` (snapshot per update); `ingest_log`; `persistence_requests` and `persistence_effects`; `page_projection_jobs`; `timeline_entries`.
- **Per read (W, telemetry):** `page_retrievals`, throttled to once per 5 min (298-307). The comment explains the split: updating `pages` would fire triggers and advance the clock, expiring the query cache. Other per-read writes are inferred: `retrieval_events`, `mcp_request_log`, `access_tokens.last_used_at`.

## 12. Where the code's classification differs from the doc

The graduation inventory has 184 entries: 170 `carry` (78 user_data, 19 security, 73 operational), 2 `rebind` (persistence_brain, persistence_host_bindings), 3 `rebuild` (query_cache, code_traversal_cache, page_view_digests at 231-233), and 9 `discard` (the COORD tables marked GI discard in sections 5-6).

Disagreements:
- `content_chunks`: DER in the doc, GI user_data (58). Re-embedding is paid work.
- `page_segment_texts` and `page_body_manifest`: DER in the doc, GI user_data (150, 133). Segmented bodies live in the DB.
- `chronicle_page_state`: COORD here, GI user_data (52).
- `page_segment_derivations` and `dream_verdicts`: DER in the doc, GI operational (147, 76).
- `eval_takes_quality_runs`: the code comment says DB-authoritative (1585-1590); this map says LOG. Undecided.

## Rust engine implications

**Preserve exactly**
- Page identity: integer page ids with UQ `(source_id, slug)`. Links, chunks, timeline, versions, and derivations all reference them.
- Generation rules: the column predicate in `bump_page_generation_fn` (182-205) and the global clock (255-278). Layer-1 cache correctness depends on monotonic values.
- Revision rules: `knowledge_revision` and `text_projection_revision` transitions (1904-1961). These gate caching and projection.
- Search weights and tokenizer: A title, C timeline, A doc comment, B chunk text, English stemming, CJK spacing (432-436). Ranking drift moves the `gbrain-evals` baselines.
- Timeline dedup key `(page_id, date, md5(summary), source)`; NULLS NOT DISTINCT uniqueness on links.
- Append-only ledgers (withdrawal, purge, belief). If Rust must read existing brains, `event_key`, `state_hash`, `prior_hash` need byte-compatible hashing.
- Request idempotency: `persistence_requests` UQ `(principal, request_id)` returns the stored outcome on replay.
- Credentials stored as hashes only (`token_hash`, `code_hash`, `credential_hash`).

**Can be simplified**
- RLS (28 statements, 3 loops), BYPASSRLS checks, search-path hardening (3781-3793), and the auto-RLS event trigger exist because Postgres has roles. A single-process embedded engine has none of these.
- The managed-writer guard and GUC allowlist (2522-2627) matter only with several writer processes. Keep them only if shared multi-host writes stay in scope.
- LISTEN/NOTIFY becomes an in-process channel.
- Triggers become one place in the write transaction; keep the semantics identical and test every write path.
- About 46 migration-only tables and roughly 300 migration versions should not be replayed. Start from the final shape and use the graduation inventory as the carry list.
- Most partial and expression indexes become application-maintained indexes. Keep the hot ones (claim, pending, generation, dedup).

**Postgres features and their dependencies**

| Feature | Used by | Rust substitute | Risk |
|---|---|---|---|
| pgvector HNSW, cosine | `content_chunks.embedding`, `embedding_image` (partial), facts, takes | ANN index plus exact fallback; dims from config; HNSW cap 2,000 (`vector-index.ts:20`) | recall and latency parity |
| tsvector, GIN, English config | `pages.search_vector`, `content_chunks.search_vector` | tokenizer, stemmer, weights, CJK split | ranking drift |
| pg_trgm GIN | `pages.title`, `pages.slug` (282, 286) | trigram index | fuzzy-match parity |
| JSONB, GIN, jsonpath | `frontmatter`, payloads, purge matching (2367-2374) | serde_json plus field index | purge semantics |
| Triggers | section 9 | in-transaction code | missed write paths |
| LISTEN/NOTIFY | `minion_jobs` | in-process channel | cross-process workers |
| FOR UPDATE SKIP LOCKED | `minions/queue.ts` (1511, 1585) | single-writer claim or lease row | double claim |
| Advisory xact lock (2330), row locks | derivation scope, persistence | per-source mutex | deadlock |
| Sequences | `page_generation_clock_seq` | atomic counter persisted with the row | monotonicity across restart |
| NULLS NOT DISTINCT (PG15+) | links, link_transitions | sentinel-normalized unique keys | |
| DATEMULTIRANGE | `link_relationships.valid_ranges` | interval-set type | low (no index) |
| Partial unique indexes | one live and one held generation; open lifetime; claim pair; minion idempotency | enforced in transaction | |
| BYTEA with EXTERNAL storage | segment texts, attachments | blob store | size |

**Risks**
- The schema is generated from TS modules. Port from those modules, not from this file, or drift follows.
- The access-control tables (migrations v282-v299) are GI `security`. Dropping them silently changes who can read pages.
- Segment bodies are DB-only per GI but DER per doc. Treating them as rebuildable from files that do not exist loses large-page bodies.
- Telemetry must stay off the `pages` row, or triggers and cache invalidation storm.
- Vector dimension is set at init; changing it rebuilds columns (see v142).
- One failed statement aborts the whole batch (1368-1376). Do not replay the file as is.

## Open questions

1. Is Rust v1 single-process embedded only, or must it keep the multi-host persistence protocol (12 `persistence_*` tables) and the shared-skill tables?
2. Are segmented page bodies the only copy of a body (GI user_data), or is the Markdown always the copy (doc)?
3. Which of the ~46 migration-only tables are in v1 scope? Needs the full graduation list plus migration history.
4. Must Rust read existing Postgres brains and verify belief and purge hashes, or start fresh?
5. Is `eval_takes_quality_runs` authoritative (code comment) or a log (this map)?
6. Are `session_context_state` and `retrieval_weights` per-client or per-brain state?
7. Not checked: migration bodies (ALTER and DROP history) and triggers on migration-only tables.
