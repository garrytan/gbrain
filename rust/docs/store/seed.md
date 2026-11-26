# The brain store: Shadow seed

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The shadow seed copies a primary brain (PGLite or Postgres) into a fresh Rust store, so a shadow run starts from the
same data. `gbrain engine shadow seed` reads the primary in one read-only snapshot and sends each relation, in batches,
to `importRelation`. The method is a handle method (`RustStore.importRelation` in `src/core/rust-engine/store.ts`),
not a `BrainEngine` member, and no capability table lists it.

Rows keep what the primary gave them: ids, timestamps, revisions, incarnations, trust tiers and source ids. Each call
is one write transaction that goes through the family writers, so every index key a family keeps (slug index, link
index keys, timeline dedup key, take row key, chunk postings, vectors) is written the way that family's own writes
write it. Every id counter and sequence is raised past the highest id copied, so a later write never reuses a
copied id. A write stamps the seed trust: a backfill at `user_confirmed`.

Keys (tag `M`):

- `M shadow_seed` holds `{ seed_id, started_at_us, relations: { <relation>: { imported, skipped, dropped } } }`, the
  seed that owns the store and the running totals of each relation.

## Claiming the store

The first call of a seed writes the manifest. It is refused (`invalid_state`) unless the store is fresh: only the
records a new store holds (`Mformat`, `Cversion`, `Sdefault`). A later call is refused (`invalid_state`) unless it
carries the same seed id. So a second seed never lands on top of a first, and a retried batch of the same seed skips
the rows it already stored. A refused batch stores nothing, the manifest included. To seed again, the caller opens a
new store directory: `gbrain engine shadow stop --delete`, then `gbrain engine shadow seed` (the command refuses
`--reseed` and a second seed with that step).

## The command and `seed.json`

`gbrain engine shadow seed [--json]` (`src/commands/engine-shadow.ts`, reads in `src/shadow/seed.ts`) refuses while
shadow mode is on or the store is locked (the shadow child holds it): stop shadow mode first. It opens the primary
without the shadow wrapper and reads every relation of `seedPlan()` in key order, in batches of 500 rows, inside one
read-only transaction (`REPEATABLE READ` on Postgres), so a write during the seed is neither copied nor counted. The
`pages` read joins each page's `page_projection_jobs` row (on the source incarnation and slug) as the
`projection_job_*` columns; generated and `tsvector` columns are not read (the store derives its own). The seed stops
with a refusal after 30 minutes (`SeedBudgetError`); the store it began is then used only through a new directory.

After the copy, in the same snapshot, it counts the unseeded gap rows (`countSeedGaps`, below), the rows of each
`not_copied` table, the unfinished `minion_jobs` (status other than `completed`, `failed`, `dead`, `cancelled`) and
the segmented pages, and writes `<shadow dir>/seed.json` (0600): `seed_id`, `started_at`, `finished_at`,
`primary_engine`, per relation `{ rows_read, imported, skipped, dropped, unmapped_columns }`, `losses { values,
not_copied, gaps }`, `unseeded_gap_rows` and its total, `non_terminal_jobs`, `segmented_pages`, `storage { managed, checked_at, reason? }` (whether the brain used managed storage
when the seed read it, right before the snapshot; a seed written before the field existed has none) and `digests: true` (the store holds a digest entry for every row it copied; a
`seed.json` without it was written before follow existed, is not followed and makes `reconcile` refuse it). `status --json`
shows `seed { seed_id, finished_at, unseeded_gap_rows_total, storage }` (nulls before a seed, and a null `storage` for a seed
written before the field; otherwise `storage` is `{ managed, checked_at, note, reason? }`), and the provisional report names
the seed, its age, the segmented pages and each gap that holds rows. `seedSwapCheck` refuses a swap with no seed
(`not_seeded`) or while any gap holds a row (`unseeded_gaps`).

### What the seed writes

The seed reads the primary in one read-only snapshot and writes nothing to it: no table row, source file, managed-root
ownership marker or registry entry. A PGLite open takes the datastore lock, and PGLite rewrites its own control and WAL files
until the seed closes the brain; that is the one change to the primary's files, and it is PGLite's own. A brain with an
open repair episode is not opened (`repair_episode_open`), because a healthy open would close the episode and prune its
backups, and a PGLite brain another process holds is not opened either (`pglite_busy`): the seed exits 1 with
`could not open the brain (<code>)` before it creates anything. What the seed does write is under the shadow directory:
the Rust store and `seed.json`.

## Rows

A row is `{ <column>: <text> | null }`: each column is the Postgres text of its value (`::text`, with the session
time zone at UTC). The decoders read `t`/`f` booleans, `YYYY-MM-DD HH:MM:SS[.f]+HH[:MM]` and ISO timestamps,
`YYYY-MM-DD` dates, JSON, `[a,b]` vectors and `{a,"b c"}` text arrays. A missing column reads as null. A value that
does not decode is `invalid_argument` with `seed <relation>.<column>`; every row error names the row
(`<relation> row <n>: ...`) and fails the whole batch.

The caller imports the relations in the order `seedPlan()` gives (`seed::plan`), because a row names rows of
earlier relations. `seedPlan()` also gives each relation's primary key columns, so the caller reads each table in
keyset batches in key order. The relations come in groups, each in its own file under `seed/`:

| Relation | Kept | Notes |
| --- | --- | --- |
| `sources` | the source record | a row equal to the stored record is skipped; a different one replaces it (the fresh store holds `default`) |
| `config` | the key and value | a row equal to the stored value is skipped. `version` is never copied: a different value is dropped (`config_version_differs`), so the store keeps its own schema version |
| `pages` | the page record, its body state, salience, contextual-retrieval state, page signature, extraction record and projection job | an id already held is skipped; a slug held by another id is `constraint_violation`. The row also carries the page's `page_projection_jobs` row as `projection_job_revision`, `projection_job_reason` and `projection_job_updated_at` (a left join on the page's source incarnation and slug, null when the primary queued no job). A job row is stored with the primary's revision, reason and time |
| `tags` | the tag and its `tag_source` | the page's `updated_at` and revisions do not move |
| `content_chunks` | the chunk, its search meta, its vector and embedding state | a retired chunk (`retired_chunk`) and a body-segment chunk (`segment_chunk`) are dropped. An `embedding_text_hash` equal to the md5 of the chunk text becomes the store's own hash, so the chunk does not read as drifted; another hash is kept as it is |
| `links` | the link and its three index keys | both pages, and the origin page when set, must exist |
| `timeline_entries` | the entry, its dedup key, its tier and origin and its write receipt | the page and the event page must exist |
| `slug_aliases`, `page_aliases` | the alias; a derived page alias (`declared`, `subject`) keeps `case_sensitive` and `alias_text` | a held alias is skipped |
| `facts` | the fact, its tier, its write receipt and its embedding | an id already held is skipped |
| `takes` | the take, its tier and origin, its write receipt and its row key | `claim_rev` starts at 0. The vector is kept only when it is current (hash equals the md5 of the claim, model and `embedded_at` set) |
| `owner_only_marks` | the mark of a page | a mark on another table is dropped (`owner_only_mark_not_a_page`); the page need not exist (a hard delete leaves the mark), and the page id counter is raised past the marked id so no new page takes it |
| `slug_rename_history` | the old-to-new pair | alias rows are not touched |
| `fact_withdrawals` | the withdrawal, with the primary's `fact_hash` and `withdrawn_at` | the hash is not computed again |
| `page_purges` | the purge tombstone (slug, request id, time) | |
| `oauth_clients` | the spend columns: client id, name, scope, bound tools, daily budget, `deleted_at` | every other column is reported as unmapped (the store keeps no credentials yet) |
| `page_versions` | the snapshot, its tier and origin, change reason and body reference | the version id and `snapshot_at` are kept |
| `files` | the file, its page index entry | a path held by another id is `constraint_violation` |
| `raw_data` | the raw data of a page and source | the serial `id` is not kept; `fetched_at` is kept |
| `code_edges_chunk`, `code_edges_symbol` | the edge, its unique key and every index key | both chunks must exist (checked against the chunk id counter) |
| `open_loops` | the loop with its status, times and dedup key | a dedup key held by another id is `constraint_violation` |
| `synthesis_evidence` | the citation and its reverse index | the take must be stored |
| `trust_proposals` | the proposal with its status and decision, the pending unique key (pending rows) and the row index | the proposer's principal and `write_request_id` are not kept |
| `wanted_links` | the row with `checked_at` (`-infinity` is no time) and `first_seen_at` | |
| `page_facts_reconcile` | the watermark | |
| `fact_relink_attempts` | the attempt and its memo index | no foreign key: the fact need not exist |
| `derived_generations`, `derived_generation_items` | the generation, with its items inline | the ledger columns `listUnwithdrawnFacts` does not read are reported as unmapped; an item needs its generation |
| `mcp_spend_log` | the ledger row with its id and time, and its owner index entries | |
| `mcp_spend_reservations` | the hold with its status, times, actual and every index its status has | `job_id` is stored as null (`spend_hold_job_dropped`): jobs are not copied |
| `decide_state`, `decide_spend`, `decide_calibrations`, `decision_receipts` | the row with its id and time, and its time index | |
| `decide_proposals`, `decide_sweep_deferred`, `decide_review_proposals`, `decide_review_queue` | the row with its id, state and times, and its unique keys (sweep slot, claim pair, review key) | a unique key held by another row is `constraint_violation` |
| `calibration_profiles` | the profile with its id and time | the source must exist; `cost_usd` and `judge_model_agreement` are reported as unmapped when set |
| `dream_synthesis_completions` | the completion and its time | |
| `wake_crons`, `wake_cron_runs`, `wake_forgets`, `wake_terms_acceptances` | the row with its id and time, and the pending forget index | a second pending forget of one user is `constraint_violation` |
| `mcp_request_log_rollup` | the lifetime tally per token | a null token name is the key `''`, as the family keys it |
| `entity_identities` | the membership of a page in an entity group: group, source, confidence, author, time and the canonical flag | the store keys a membership by its page, so the serial `id` is not kept (named unmapped). The page must exist. A page that already holds the same source's membership is skipped (a retried batch); one that holds a membership of another source stops the import (`invalid_argument`): the store keeps one membership per page, and a loss would not stop a swap |
| `link_relationships` | the derived state of a relationship (`from`, `to`, `link_type`, `scope`): ranges, status, dates, counts, evidence hash, `recorded_at`, `retired_at` and `refreshed_at` | both pages must exist. The row is stored under the source of its from page, as the family keys it. `refreshed_at` is the primary's, not the seed's clock. A range bound may be the explicit `-infinity` (lower) or `infinity` (upper), kept apart from an omitted bound as Postgres prints it; an exclusive `(-infinity` or inclusive `infinity]` bound is refused |
| `link_transitions` | the dated start or end of a relationship, with its id, producer, origin page, `line_hash`, `link_source` and `created_at` | both pages, and the origin page when set, must exist. The row is stored under the source of its from page, where the evidence reads look, and keeps its own source id in the record. Another id with the identity of a held row (`origin, from, to, link_type, link_source, kind, occurred_on, producer`) is skipped. The transition id counter is raised past the highest id copied |
| `fact_purges` | the purge tombstone (source, visibility, subject, claim hash) with its request id, actor, reason and time | the source must exist; a held key is skipped. The guard reads it for every claim saved or updated, so a purged claim stays refused. The relation is listed before `facts`, so a reconcile removes a tombstone the primary cleared before it imports the claim it guarded. The tombstone keeps only the claim hash the primary computed: when the primary's `lower()` or `[[:space:]]` differs from PGLite's for some code point, the fingerprint probe fails while any tombstone exists (`fact_purges_unverifiable`), because the claim text is gone and cannot be checked |
| `access_tokens` | the bearer token with every column the credential family keeps: hash, name, scopes, grants, grant revision, floor, member binding, attest columns and times | the table's `CHECK` lists and the unique `token_hash` apply (`constraint_violation`, never naming a value). A token with no `created_at` is stored at time 0 (`token_without_created_at`). A `text[]` column with a NULL element (`{read,NULL}`) is refused (`invalid_argument`): the primary reads some grant arrays as a whole, so dropping the element could widen a grant. A NULL column stays NULL and an empty array stays empty. The follow removes a stale token that holds the hash of a row it imports under another id, with its digest entry, unless the store holds a newer generation of it. The hash is stored once, in the token record: the digest entry of a token holds its id only, and no loss, error or `seed.json` field carries a hash |

Every id counter and sequence of these families is raised past the highest id copied. A row whose source or page is
missing is `source_not_found` or `page_not_found`.

## Every other primary table

`seedPlan()` names every primary table the seed leaves behind on purpose (`seed::NOT_COPIED`, pinned by a test).
Any primary table that is neither copied, carried (`page_projection_jobs` rides in `pages`) nor on that list is a
gap: `gbrain engine shadow seed` counts its rows into `unseeded_gap_rows` in `seed.json`, and a swap to the seeded
store is refused while any gap count is above zero. A table a migration adds is a gap until the seed copies it or the
list names it. A listed table can still hold rows that are brain state (`gap_rows`): those rows are a gap of their
own. `op_checkpoints` rows of op `sync-identity-downgrade` are pending rename repairs (the purge of deleted pages holds
the old page of such a record, and the rename repair reads it), so they count as the gap `sync_identity_downgrades`; checkpoints of
every other op are machine-local.

### Left behind on purpose (`seed::NOT_COPIED`)

| Tables | What reads differently on the seeded store |
| --- | --- |
| `minion_jobs` | `gbrain jobs list` is empty. The seed counts the jobs that are not finished, so swap on a drained queue. A Postgres brain of an older release can hold budget-owner rows here; none carry |
| `minion_inbox`, `minion_attachments`, `minion_budget_log`, `minion_lease_pressure_log`, `minion_self_fix_log`, `subagent_messages`, `subagent_tool_executions`, `subagent_rate_leases` | job runtime goes with the jobs: `gbrain agent logs`, `gbrain jobs stats` and `gbrain jobs watch` show no earlier runs |
| `wake_subscriptions` | open watches are not carried and never wake. A watch copied without its job or write request would wake on the first tick, so none is copied. (`wake_crons` is copied: a lost cron would make every `watch_cron` read `not_found`) |
| `search_telemetry`, `mcp_request_log`, `chat_usage_log`, `ingest_log`, `page_retrievals`, `retrieval_events`, `retrieval_event_pages`, `retrieval_event_links`, `eval_*`, `migration_impact_log`, `think_ab_results`, `take_nudge_log` | logs and counters start at zero: `gbrain search stats`, per-client usage in `gbrain auth`, `get_usage`. Lifetime request totals carry in `mcp_request_log_rollup` |
| `query_cache`, `code_traversal_cache`, `conversation_parser_llm_cache`, `dream_verdicts`, `take_grade_cache`, `extract_rollup_7d`, `page_view_digests`, `mention_gazetteer_entries`, `page_generation_clock` | caches the next read or run rebuilds; `dream_verdicts` means each transcript is triaged again (a paid call); cached query results recompute (`page_generation_clock` is the query cache's clock, and no store read uses it) |
| `page_segment_texts`, `page_body_manifest`, `page_segment_derivations`, `page_segment_derivation_purges`, `page_segment_derivation_purge_pages`, `page_body_staging*` | a segmented page reads as its shell, without its text or its sealed keyword vector (`segmented_body`) |
| `page_write_guards` | a lock anchor, with no read that differs. A page write inserts the row (`INSERT ... ON CONFLICT DO NOTHING`) and then selects it `FOR UPDATE` (`src/core/page-state/guards.ts`); the row holds nothing a read returns. The store holds the same lock on the page key inside the transaction (`transactions.rs`, `lockPageKeys` and `hold_page_keys`). Its kind in `seed.json` is `lock_anchor` |
| `persistence_*`, `write_gate_holds`, `write_gate_receipts`, `op_checkpoints` (except the rows below), `op_checkpoint_paths`, `gbrain_cycle_locks`, `sync_notifier_*`, `sync_wanted_markers`, `session_context_state`, `extract_atoms_*_state`, `page_mention_state`, `mention_index_status`, `reason_purge_tombstones`, `planner_stats_*`, `trust_policy_state`, `file_migration_ledger`, `engine_writer_observations`, `engine_writer_sessions`, `engine_writer_coverage_gaps` | the write path, locks, checkpoints and run state of the primary machine; an interrupted bulk operation starts again; the swap's writer evidence starts empty |

### Gaps: not served by the Rust store on master

Each of these blocks a swap while it holds rows. The branch named is where the Rust family is today; the seed adds the
relation when that family reaches master, in the same PR as the store bridge that serves it or before it.

| Tables | Rust family | What reads differently without it |
| --- | --- | --- |
| `access_members`, `access_groups`, `access_group_members` | `rust-engine/access-member-writes`, `rust-engine/access-rule-writes-3`, `rust-engine/access-reads-rust` | `readable_by member:` and `group:` grants resolve to no one |
| `access_rules`, `access_policy_state`, `access_policy_revisions`, `access_policy_migrations`, `access_pending_coverage` | `rust-engine/access-rule-writes-3`, `rust-engine/access-reads-rust`, `rust-engine/chronicle-decision-rust` | folder-restricted pages read as unrestricted |
| `access_member_links` | `rust-engine/admin-unowned-rust` | attested outside identities are unlinked from members |
| `access_member_sources`, `access_handovers` | none found | personal sources are unbound; handover undo is lost |
| `oauth_tokens` | `rust-engine/access-rule-writes-3`, `rust-engine/access-reads-rust` | issued OAuth tokens do not authorize |
| `oauth_codes` | `rust-engine/oauth-http-rust` | an OAuth handshake in flight restarts |
| `oauth_grant_audit`, `guest_marks`, `guest_promotions` | none found | grant audit and guest promotion history are not listed |
| `guest_sources`, `context_volunteer_events`, `retrieval_feedback` | `rust-engine/collate-equal` | guest writer lists and tier ceilings are not enforced; doctor volunteer counts and feedback history start empty |
| `chronicle_page_state`, `chronicle_judge_reservations` | `rust-engine/chronicle-decision-rust` | `hasExtractedEvents` and chronicle ledger stats differ; the 24-hour judge cap restarts at zero |
| `page_embedding_budget` | `rust-engine/main` | held large pages could embed without consent |
| `derivation_inputs`, `needs_rederive` | `rust-engine/derivation-trust`; `derivation_inputs` also on `rust-engine/sweep-facts-rust` | rows derived from owner-only inputs, and rows the primary hides for re-derivation, show |
| `take_purges` | `rust-engine/page-purge-rust` (with the `putPage` purged-content guard) | a purged take or page can be written again |
| `sync_identity_downgrades` (`op_checkpoints` rows of op `sync-identity-downgrade`) | `rust-engine/main`, `rust-engine/identity-downgrade-rust` | pending rename repairs are lost: the purge of deleted pages no longer holds the old page, so the repair can find nothing to restore |
| `budget_ledger`, `budget_reservations` | key tag only on `rust-engine/main` | the resolver's daily budget restarts at zero |
| `retrieval_weights` | key tag only on `rust-engine/main` | ranking: every page weight reads 0.5, so the feedback boost is off |
| `belief_*`, `core_edit_notices`, `derived_generation_activations`, `derived_generation_attempts`, `derived_generation_valve`, `drift_decisions`, `entity_identity_reviews`, `git_canonical_brain`, `ingest_applied_captures`, `link_edge_proposals`, `loop_suppressions`, `memory_proposals`, `page_derivation_spend`, `page_extraction_state`, `page_label_guards`, `pinned_questions`, `question_evidence`, `secret_store`, `secret_store_occurrence`, `shared_skill_*`, `source_ingestion_receipts`, `take_domain_assignments`, `take_horizons`, `take_proposals`, `trust_allow_rules` | none on master or `rust-engine/main` | each is user data, security or spend state the primary reads |

### Gap columns (`seed::GAP_COLUMNS`)

A column of a copied relation that the store cannot keep yet is a gap too: a row that holds a value there blocks a
swap, counted under the gap name. `seedPlan().gap_columns` lists `{ table, column, gap }`; a column the primary lacks
(an older schema) counts nothing.

| Column | Gap | What reads differently without it |
| --- | --- | --- |
| `pages.frontmatter_raw` | `pages.frontmatter_raw` | the page's stored raw frontmatter text is missing (the column arrives with the frontmatter change; the store keeps it once its Rust field lands) |
| `page_versions.frontmatter_raw` | `page_versions.frontmatter_raw` | the same, for a page version |

### Swap readiness: the gaps a real-shaped brain fills (measured 2026-11-20)

The gap count (`src/shadow/seed-gaps.ts`) ran on three PGLite brains built at commit `fb2c18687f`:

- A: a fresh `gbrain init --pglite --no-embedding`.
- B: A, then the real CLI. The commands imported and synced a 12-page corpus with facts and takes fences, ran
  `extract`, `sync` with a git rename, `auth` tokens and OAuth clients with `POST /token`, `access` members, groups,
  rules, sources and links, `loops mute`, `questions pin`, `guests init`, `watch`, `takes horizon set`,
  `beliefs enable` and `forget --purge`.
- C: the graduation legacy fixture (`test/fixtures/graduation/legacy-brain.ts`).

Every gap below held rows on at least one of them, so each blocks a swap of such a brain until the seed copies it.
Its Rust family must reach master first. "Branch" is the newest branch with a real family on 2026-11-20 (UTC).

| Gap | Rows A / B / C | Rust family | Branch, head | On `rust-engine/main` |
| --- | --- | --- | --- | --- |
| `git_canonical_brain` | 1 / 1 / 1 | none | none | no |
| `shared_skill_state` | 1 / 1 / 1 | `shared_skill_members.rs` | `rust-engine/cli-members-next` f2283364a4 | no |
| `shared_skill_heads`, `shared_skill_revisions`, `shared_skill_policies`, `shared_skill_policy_audit` | 3, 3, 1, 1 / same / 0 | `shared_skill_catalog.rs` | `rust-engine/cli-members-next` f2283364a4 | no |
| `shared_skill_packs` | 1 / 1 / 0 | `shared_skill_publication.rs` | `rust-engine/cli-members-next` f2283364a4 | no |
| `chronicle_page_state` | 0 / 4 / 0 | `chronicle_ledger.rs`, `chronicle_state.rs` | `rust-engine/page-mutation-reads` cb983366e3 (also `rust-engine/chronicle-decision-rust` e4420913f5) | no |
| `sync_identity_downgrades` | 0 / 1 / 0 | `persistence/identity_downgrade.rs` (reader); `persistence/op_checkpoint.rs` (writer, on main) | `rust-engine/identity-downgrade-rust` 73096ca1f8 | writer only |
| `oauth_tokens` | 0 / 3 / 1 | `jobs/oauth_tokens.rs` | `rust-engine/write-path-stops-rust` d1ec6f64c1 | no |
| `oauth_grant_audit` | 0 / 3 / 0 | `jobs/client_grants.rs` | `rust-engine/admin-followups-rust` 8e72de1bb6 | no |
| `access_members`, `access_groups`, `access_group_members` | 0 / 2, 1, 2 / 0 | `access_members.rs` | `rust-engine/coll-pa3` 9e0c35e58c | no |
| `access_rules`, `access_policy_state`, `access_policy_revisions` | 0 / 2, 1, 2 / 0 | `access_rules.rs` | `rust-engine/page-mutation-reads` cb983366e3 | no |
| `access_member_links` | 0 / 1 / 0 | `access_member_links.rs` | `rust-engine/admin-followups-rust` 8e72de1bb6 | no |
| `access_member_sources` | 0 / 1 / 0 | none | none | no |
| `loop_suppressions` | 0 / 2 / 2 | `facts/loops/mutes.rs` | `rust-engine/repair-rust` 90a7284da0 | no |
| `belief_events`, `belief_commit_marks`, `belief_page_lifetimes` | 0 / 24, 22, 18 / 0 | `trust/belief_events.rs`, `trust/belief_lifetimes.rs` | `rust-engine/page-purge-rust` 4bcab3a4f1 | no |
| `take_purges` | 0 / 1 / 0 | `facts/take_purges.rs` | `rust-engine/page-purge-rust` 4bcab3a4f1 | no |
| `take_horizons` | 0 / 1 / 0 | `takes/horizons.rs` | `rust-engine/page-purge-rust` 4bcab3a4f1 | no |
| `guest_sources` | 0 / 1 / 0 | `guest_sources.rs` | `rust-engine/collate-equal` 3a2532707c | no |
| `pinned_questions` | 0 / 1 / 0 | `jobs/pinned_questions.rs` | `rust-engine/collate-equal` 3a2532707c | no |
| `context_volunteer_events` | 0 / 1 / 0 | `volunteer_events.rs` | `rust-engine/collate-equal` 3a2532707c | no |

`page_generation_clock` (1 row on every brain) was a gap in this measurement and is now left behind on purpose (a
cache). Since the measurement, `link_relationships` (0 / 68 / 0 rows), `link_transitions` (0 / 7 / 0), `access_tokens`
(0 / 3 / 2) and `fact_purges` (0 / 1 / 0) are copied, `entity_identities` (empty on all three brains) is copied too,
and `page_write_guards` (0 / 32 / 7) is left behind on purpose as a lock anchor (see above), so none of them counts as a gap. No measured brain wrote rows to the other 38 gap tables. Those tables need a paid model key, a browser or tty step,
or an event the run did not make, so this measurement does not clear them.

## What the seed does not keep

Nothing is dropped silently. `unmapped_columns` names each column that held a value other than its default in some
row and that the store does not keep (for example `pages.last_retrieved_at`, the `write_*` columns, tag and alias
ids, chunk `created_at`). `losses` counts, by reason, the rows dropped and the values the store could not carry:

| Reason | What was lost |
| --- | --- |
| `config_version_differs` | the primary's schema `version` |
| `segmented_body` | the segments of a segmented body (the page and its body columns are kept). The page's sealed keyword vector is not copied either, so its title search reads the title only until the page is written again |
| `emotional_weight_without_touch` | a non-zero weight on a page with no `salience_touched_at` |
| `corpus_generation_without_mode` | a corpus generation with no contextual-retrieval mode |
| `retired_chunk`, `segment_chunk` | the dropped chunk rows |
| `embedding_image`, `embedding_multimodal` | the chunk's image or multimodal vector |
| `projection_job_seed_time` | the time of a projection job the page write queued when the primary row gave no job time (no job row, or one with no `updated_at`): the job keeps the seed transaction's time |
| `vector_without_embedded_at` | the embed time of a vector with none (stored as time 0) |
| `take_vector_not_current` | a take vector that is not current |
| `frontmatter_alias_columns` | `case_sensitive` or `alias_text` on a `frontmatter` page alias (the store keeps both columns for the derived origins only) |
| `owner_only_mark_not_a_page` | an owner-only mark on a table other than `pages` (the store marks pages only) |
| `spend_hold_job_dropped` | the job of a spend hold (stored as null: jobs are not copied) |
| `segmented_version_body` | the segments a segmented page version references (its generation and size are kept) |
| `legacy_version_columns` | a page version with NULL `title`, `type`, `tags`, `knowledge_revision` or `is_deleted`: the store holds an empty value |
| `token_without_created_at` | the creation time of an access token whose `created_at` is NULL (the column is nullable): stored at time 0 |

Some unmapped columns are expected, not losses:

| Column | Why it shows in `unmapped_columns` | Readers |
| --- | --- | --- |
| `pages.generation` | unmapped, known value: the primary's cache clock; the Rust store keeps 1 | the `query_cache` freshness check (`query_cache` is not copied) and the dedupe plan fence (`identity-decisions.ts`, applied only when `p.generation = pl.generation`), which a Rust identity-decisions family must replace. The store refuses `applyIdentityDecisions` today, so no read differs yet |

## The seed calls

The JS methods of the seed on `RustStore` (`src/core/rust-engine/store.ts`):

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.seedPlan()` | `{ relations: [{ relation, key, removable }], carried: [[table, relation]], not_copied: [{ table, kind, read, gap_rows }], gap_columns: [{ table, column, gap }] }`: the relations in import order with their key columns and whether the store can remove their rows (`removable`, see "Follow and reconcile"), the tables carried in them, the tables left behind on purpose, and the gap columns | none |
| `brain.importRelation(seedId, relation, rows, digests?)` | `{ imported, skipped, dropped, unmapped_columns, losses }` for the batch. `imported` counts rows stored (for `sources` and `config`, also rows that replaced a different value), `skipped` rows already held, `dropped` rows the store cannot hold. `invalid_argument` for an unknown relation, an empty seed id or a NUL byte, or `digests` that do not align with `rows` (see "Follow and reconcile"); `invalid_state` for a store another seed owns or a store that is not fresh | none (the seed reads the primary's tables) |

## Follow and reconcile

After the seed, the store is kept level with the primary by comparing and replacing rows, not by replaying the
primary's writes. The caller (`src/shadow/`) hashes each primary row, sends the changed rows, and compares a digest of
a sort interval on each side. The store keeps the hashes and the sort keys as opaque bytes; it never computes them.

### The digest index

A row sent with a digest gets a digest entry, written in the same write transaction as the row:

- Key: `M shadow_digest/<relation>/<sort bytes>`. The entries of a relation are therefore in sort-key order.
- Value: the 32-byte row digest, the generation (u64, big-endian), and the row's identity as JSON `{ column: text }`.
  The identity is the primary key columns plus the natural-key and parent columns the relation's family needs to find
  the row again (for example a link's `from_page_id` and `to_page_id`). It is how a row is removed later, by sort key
  alone.

`importRelation` with digests stores an entry at generation 0 for every row it was given: stored, skipped and dropped.
The entry records the primary row the caller read, whether or not the store could hold it, so a dropped row still counts
in the interval digest. A retried batch rewrites its generation 0 entries and never lowers a later generation. A row
imported without digests has no entry: it is neither counted in `relationDigest` nor found by a delete that names only
a sort key, and a remover that lacks the columns it finds the row by removes nothing.

### The byte contract

The sort key and the row digest are defined by `src/shadow/follow-digest.ts` (the vectors in its tests pin them). The
store takes both as lowercase hex of whole bytes and a digest is exactly 32 bytes; anything else is
`invalid_argument`. The interval digest, which the store computes, is the sha256 over each entry in sort order of
`u32be(length of sort) || sort || row digest`. An empty interval is the sha256 of nothing,
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

### The calls

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.importRelation(seedId, relation, rows, digests)` | as above, with `digests: [{ sort, digest }]` aligned with `rows`: one entry per row at generation 0. `invalid_argument` when the lengths differ, a value is not hex, a digest is not 32 bytes or two rows share a sort key | none |
| `brain.replaceRelationRows(seedId, relation, generation, keys, rows, digests)` | `{ upserted, deleted, skipped_older, displaced, dropped, unmapped_columns, losses }`. `keys: [{ sort, key: { column: text } }]` are the rows the primary changed. A key with a row in `rows` (its digest has the key's sort) is stored over its old version, or inserted: `upserted`. A key with no row is deleted: `deleted`. Deletes run before stores, so a natural key a deleted row held is free for a new row, and every row's old version is removed before any new version is stored, so rows can swap a unique natural key (see "Natural keys that move"). One write transaction; an error stores nothing. `invalid_argument` for an unknown relation, a generation that is not a whole number from 0 to 2^53-1, lengths that differ, a row whose sort is not among the keys or two keys or rows with one sort; `invalid_state` when no seed owns the store or another seed does; `unsupported` for a relation that is not `removable` | none |
| `brain.replaceInterval(seedId, relation, generation, lo, hi, rows, digests)` | the same result. `lo` is inclusive and `hi` exclusive, as hex sort keys; `null` is unbounded. The primary holds exactly `rows` in `[lo, hi)`: every entry in the interval that is not among them is deleted, the rows are stored or inserted. One write transaction. A row whose sort is outside `[lo, hi)` is `invalid_argument` and stores nothing. The call also records a fence over `[lo, hi)` (see "The generation rule"). Other errors as above | none |
| `brain.relationDigest(seedId, relation, lo, hi)` | `{ rows, digest }`: the entry count and the hex digest of the entries in `[lo, hi)`. Read only. `invalid_argument` for an unknown relation or a bad bound; `invalid_state` as above | none |
| `brain.relationEntries(seedId, relation, lo, hi, limit)` | `[{ sort, digest, generation }]`: the digest entries with a sort key in `[lo, hi)` (hex; `null` is unbounded), in sort order, at most `limit`, as hex sort key, hex row digest and the generation of the call that last wrote the entry. The caller counts exactly which rows differ inside an interval whose `relationDigest` differs. Read only. `invalid_argument` for a `limit` that is not a whole number from 1 to 5000, an unknown relation or a bad bound; `invalid_state` as above | none |
| `brain.allocatorCheck(seedId, primaryMax)` | `[{ relation, counter, primary_max, ok }]` for every relation whose import raises an id counter, in import order. `primaryMax` is `{ [relation]: text }`, the primary's highest integer id per relation; a relation that is absent or `null` has an empty table. `counter` is the id the store hands out next, as text (1 when nothing raised it). `primary_max` echoes the input (`null` when empty). `ok` is `counter > primary_max`, and true for an empty table. A relation that keeps no counter is not reported. `invalid_argument` for an unknown relation in `primaryMax` or a value that is not a non-negative whole number up to 2^64-1; `invalid_state` as above. Read only | none |
| `brain.factFingerprints(texts)` | `[{ fingerprint, fingerprint_v1 }]`, one per text, in order. `fingerprint` is `gbrain_fact_fingerprint(claim)`, the sha256 hex of the normalized claim. `fingerprint_v1` is the sha256 hex of `regexp_replace(lower(btrim(claim)), '[[:space:]]+', ' ', 'g')`, which keeps punctuation (`"Hello,  World."` and `"hello, world."` share it; the normalized one drops it). Needs no seed | none |

The relations `allocatorCheck` reports are those whose import raises an id counter: `pages`, `content_chunks`,
`links`, `timeline_entries`, `facts`, `takes`, `page_versions`, `files`, `code_edges_chunk`, `code_edges_symbol`,
`open_loops`, `trust_proposals`, `wanted_links`, `mcp_spend_log`, `decide_calibrations`, `decision_receipts`,
`decide_proposals`, `decide_review_proposals`, `calibration_profiles`, `wake_cron_runs`, `wake_forgets` and
`link_transitions`. Every
write that stores a row with an id (`importRelation`, `replaceRelationRows` and `replaceInterval` alike) raises its
counter past that id, also for a row the store drops (a retired or segment chunk), so the store never hands out an id
the primary used. A delete does not lower a counter.

`seedId` is claimed the way `importRelation` claims it: a store no seed owns, or one another seed owns, is
`invalid_state` and nothing is written.

### The generation rule

Each call carries a generation, a counter the caller raises with each read of the primary. A call at generation `g`
leaves a key alone, and counts it in `skipped_older`, when the store holds a newer record of it, which is the highest of:

- the generation of the key's live digest entry;
- the generation of a tombstone of the key;
- the generation of the interval fence that covers the key.

So a read taken before another cannot undo it, whatever order the calls land in, also where the newer call removed the
row and its entry. A record at the same or a lower generation does not stop the call. Entries imported without a
generation are generation 0.

A delete removes a row's digest entry, which would take its generation along, so two small records keep it:

- A tombstone, `M shadow_tomb/<relation>/<sort>`, is written by a `replaceRelationRows` delete at the call's generation,
  also for a key the store never held. It holds the generation and nothing else: no digest, so it is not an entry and
  `relationDigest` and `relationEntries` never count it. A delete never lowers a tombstone. A stored row at a generation
  at or above it removes it.
- An interval fence, `M shadow_fence/<relation>/<lo>`, is written by `replaceInterval` over `[lo, hi)` at the call's
  generation. Entries it removed need no tombstone, and a key it found absent is covered by the fence. The fences of a
  relation are disjoint pieces of one function from sort key to the highest generation that read the key: a new fence
  raises the pieces it overlaps and merges neighbours of equal generation, so repeating a pass over the same intervals
  leaves one fence per interval and passes over adjacent intervals at one generation leave one fence in all.

A `replaceInterval` at `g` also removes the tombstones inside `[lo, hi)` with a generation up to `g`, which its own
fence supersedes. What stays is bounded by the keys followers deleted since the last pass over their sort range, plus
one fence per interval. `importRelation` writes neither record and does not check them.

A row the store cannot hold (`dropped`, with its reason in `losses`) still gets its entry at the call's generation.

### Natural keys that move

A primary update can move a unique natural key from one row to another: two chunks trade their `chunk_index`, two pages
their slug, two aliases their name. The store handles it in two steps.

1. In one call, the old version of every row to store is removed first (`Mode::Replace`, so dependents stay). Rows that
   trade a key within the call then store without meeting each other's old version.
2. A new version that still collides with a stored row the call does not name, because the primary's change to that
   row has not arrived yet, displaces it: the stale row is removed and so is its digest entry, with no tombstone, and
   the call retries the row once. The importers refuse such a row (`constraint_violation`), or skip it silently for the
   aliases. `displaced` counts the rows removed. The relation is then behind the primary until the row's own change
   arrives or a reconcile restores it from the primary, so the caller marks the relation dirty when `displaced` is above
   zero.

The generation rule applies to both steps. Before anything is removed, a row that moves a unique key (its old version
held another value) is checked against the stored rows that hold the key it takes, with the same guard as for any write:
the holder's entry generation, tombstone and covering fence. When one of them is newer than the call, the row is
`skipped_older`: it is not released, so its old version stays, it is not stored and no entry is written for it, and
nothing is displaced. A new row (no old version) that meets a newer holder when it is stored is skipped the same way,
before the holder is removed. An older holder is displaced as before, so a newer call still wins either order.

A page is the one row whose record holds rows of other relations: its tags and their sources. Displacing a page removes
the record, so the tags go with it, and when the page is stored again nothing carries them back (a replace carries them
across; a displacement has no row to carry them from). So displacing a page also deletes the digest entries of its
`tags` rows (the `tags` entries whose `page_id` is the page's id): the next reconcile of `tags` finds them missing and
restores them. The other dependents of a page (chunks, links, timeline entries, versions, raw data, takes, wanted links)
are rows under keys of their own, which `Mode::Replace` leaves alone, and so are the code edges of a chunk, the evidence
of a take and the referrers of a fact; they keep their entries.

The relations whose rows are looked up this way, with the column sets that are unique, are the `unique` lists of each
relation's follow spec: `pages` (source, slug), `tags` (page, tag), `content_chunks` (page, index), `links` (from, to,
type, source, origin), `slug_aliases`, `page_aliases`, `facts` (the markdown row fence and the stint index), `timeline_entries` (page, date, summary, source), `takes`
(page, row), `raw_data`, `files` (storage path), `open_loops`, `wanted_links`, `trust_proposals` (the pending key),
`code_edges_chunk`, `code_edges_symbol`, `decide_proposals`, `decide_review_proposals`, `wake_forgets`, `entity_identities` (source, page) and
`link_transitions` (origin, from, to, type, link source, kind, day, producer). The holder is
found through the digest entries' identity columns (an `access_tokens` row that takes the hash of a stored token finds that
token by the hash itself, which no digest entry holds), scanning the relation's entries once per call that has a row to
check (a row that moves a key, or collides), so a swap costs a pass over the relation. A stored row that has no digest entry (imported without digests) cannot be found:
the collision stays an error, except for a row with no entry of its own, which replaces the stored row it names by its
primary key as before.

### Delete and replace

- Delete (the primary row is gone, or a key has no row): the row, every index key its family keeps, and its digest
  entry go. Rows that depend on it go or change the way the primary's foreign keys say: `ON DELETE CASCADE` removes them
  and their digest entries, `SET NULL` clears the column. Deleting a page removes its tags, chunks (and their
  code edges), links from and to it, timeline entries, versions, raw data, takes (and the citations of those takes),
  wanted links, facts reconcile mark, entity identity memberships, link relationship state and link transitions, and the
  digest entries of those rows go with them.
- Replace (the row changed): the old row is removed or overwritten in place and the new one stored, and its dependents
  stay. Replacing a page keeps its chunks, links and tags readable. Where a relation's importer
  overwrites a different stored value itself (`sources`, `config`), the row is stored over the old one.

A delete that finds no stored row still removes its digest entry, and counts as `deleted` only when it removed a row
or an entry.

### Relations the store cannot remove

`seedPlan()` marks each relation `removable`. Every relation is removable except:

| Relation | Why |
| --- | --- |
| `sources` | the store has no source delete: a source is only added or updated, and the rows of other relations name it. A changed source row is replaced in place; a delete is `unsupported` and writes nothing |

`config` rows are removable, except the key `version`, which is never copied or removed: the store keeps its own
schema version, and the importer drops a different primary value (`config_version_differs`).
