# Schema map

This map lists every table, column, index, view, function, trigger and migration in the gbrain database, with the code that reads and writes each object.

- Reference: `garrytan/gbrain` at commit `8bbfd0b5e8` (master, 2026-11-16). Every `path:line` citation is relative to the gbrain repo root at that commit.
- Fresh-install DDL: `src/schema.sql` (3,794 lines). It is hand-edited, except the `BEGIN/END GENERATED` regions, which `scripts/build-schema.ts` copies from TS fragment modules. The same script builds the two engine blobs: `src/core/schema-embedded.generated.ts` (Postgres) and `src/core/pglite-schema.generated.ts` (PGLite).
- Migrations: 313 files, `src/core/schema-migrations/v002-*.ts` through `v318-*.ts` (no v017-v019, no v100), run by `src/core/migrate.ts`. The schema version is the `config.version` row.
- Method: four research passes, split by line range and migration range. Reader and writer lists come from a grep of `src/` for SQL keywords next to each table name. They name the main files, not every call site.

## Contents

| Section | Scope | Count |
|---|---|---|
| [Tables and objects, part 1](#tables-and-objects-part-1-schemasql-lines-1-1898) | `schema.sql` 1-1898 | 56 tables, 114 indexes, 8 functions, 7 triggers, 1 sequence, 3 extensions |
| [Tables and objects, part 2](#tables-and-objects-part-2-schemasql-lines-1899-3794) | `schema.sql` 1899-3794 | 76 tables, 2 sequences, 13 functions, 17 triggers (28 attachments), 32 `DO` blocks, 19 generated regions |
| [Migration system and migrations v002-v160](#migration-system-and-migrations-v002-v160) | runner, blobs, v002-v160, runtime DDL | 155 migrations |
| [Migrations v161-v318](#migrations-v161-v318) | v161-v318 | 158 migrations |

Totals: 132 tables in `schema.sql`. There are no views, `CREATE POLICY`, `GRANT`, `REVOKE` or `SECURITY DEFINER` statements. RLS is turned on for about 37 tables by a `DO` block only when the connected role has `BYPASSRLS`; authorization is in application code and in GUC-based trigger guards.

## Headline findings

- Most correctness rules live in the database, not in TypeScript: about 25 plpgsql trigger functions maintain derived state (search vectors, revision counters, projection queues, generation clocks) and refuse writes with typed messages (`writer_coordinator_required`, `git_protocol_required`). A Rust engine must port each trigger as an explicit write-path step, with tests that compare it to the trigger.
- About 20 columns are added only by migrations or referenced only inside trigger bodies. A fresh Rust schema must declare them to match an upgraded brain (listed in part 1).
- Many functions and triggers are redefined several times across migrations (for example `gbrain_access_origin_restricted` in v282, v283, v285 and v305). A fresh Rust schema needs only the final definitions.
- About 17 migrations in v161-v318 (and more in v002-v160) backfill data. Those matter only if the Rust engine imports an existing PGLite or Postgres brain in place; an export-and-import path avoids them.
- `files` has `UNIQUE(storage_path)`, while `getFile` looks up by `(source_id, storage_path)`. Some unique keys use `NULLS NOT DISTINCT`, which SQLite does not have.

---

## Tables and objects, part 1 (schema.sql lines 1-1898)

Source: `src/schema.sql` lines 1-1898. Part 2 starts at line 1899 (`CREATE TABLE IF NOT EXISTS page_write_guards`). Citations are `schema.sql:line`. Reader/writer paths are relative to `src/`. Engine SQL lives in `core/engine-sql/*.ts`; the engines are `core/postgres-engine.ts` and `core/pglite-engine.ts`. Migrations are `core/schema-migrations/vNNN-*.ts` and were excluded from the reader/writer lists below (they are listed separately where they matter).

### Scope totals

| Object kind | Count in range | Where |
|---|---|---|
| Extensions | 3 (`vector`, `pg_trgm`, `pgcrypto`) | 3, 4, 6 |
| Tables (`CREATE TABLE IF NOT EXISTS`) | 56 | 26 to 1772 |
| Indexes (`CREATE [UNIQUE] INDEX`) | 114 (incl. partial, GIN, HNSW, trigram, expression, unique-expression) | 88 to 1784 |
| Functions | 8 `CREATE OR REPLACE FUNCTION`; 1 `DROP FUNCTION IF EXISTS` (1243) | 64, 182, 267, 313, 432, 444, 1196, 1789, 1813 |
| Triggers | 7 `CREATE TRIGGER` (+ `DROP TRIGGER IF EXISTS` before each) | 209, 275, 332, 455, 1231, 1809, 1824 |
| Sequences | 1 (`page_generation_clock_seq`) | 255 |
| Views / materialized views | 0 | none |
| `CREATE POLICY` / `GRANT` / `COMMENT ON` | 0 / 0 / 0 | none |
| Seed `INSERT`s | 3 (`sources` default 78, `page_generation_clock` 246, `config` 725) | |
| `DO $$` blocks | 3 (RLS enablement 1834; `sources.incarnation` 1867; `pages.knowledge_revision` 1880) | |
| RLS enablement | Conditional `ENABLE ROW LEVEL SECURITY` on 35 named tables, only if the current role has BYPASSRLS or superuser (1834-1865). No policies are created in this range. | 1834 |

Columns added by `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in range: `files` drop of `storage_url` (1153); `pages.search_vector` (1183); `minion_attachments.content SET STORAGE EXTERNAL` (1351); `gbrain_cycle_locks.acquisition_token` (1530, inside a GENERATED block); `sources.incarnation` (1867-1879); `pages.knowledge_revision` and `pages.text_projection_revision`, `page_versions.knowledge_revision/timeline/title/type/tags/is_deleted` (1880-1898).

Out-of-range ALTERs that belong to these tables (for part 2 readers): `page_versions.source_path` (about schema.sql:1966), `sources.upstream_checked_at`, `upstream_commit`, `upstream_behind` (about schema.sql:3559-3561).

### Migration-added columns the fresh DDL in range does not declare

Several columns are only mentioned in comments in lines 1-1898 and are added by migrations on every install. Their ordinals are shared with upgraded brains, so a Rust fresh-install must declare them explicitly to match.

| Table | Columns (comment only, not in CREATE TABLE) | Evidence |
|---|---|---|
| `pages` | `body_storage`, `body_bytes`, `truth_bytes`, `body_lines`, `body_generation`, `segment_count`, `segmenter_version`, `body_flags`, `truth_lead`, `timeline_lead`, `links_attendance_blocked_revision`/`_at`; `compiled_truth` and `timeline` become NULL-able; `pages_body_storage_chk` | comment 173-176; `body_generation` is read by `bump_page_generation_fn` at 199 |
| `content_chunks` | `occurrence_id`, `local_ordinal`, `raw_byte_start/end`, `body_generation`, `retired_generation`, `embedding_pending_since`, `projected_byte_start/end` | comments 370-376 (retired_generation is read by released readers but written by nothing) |
| `page_versions` | `body_storage`, `body_generation`, `body_bytes`, `content_hash`; `compiled_truth` NULL-able; `page_versions_body_chk` | comment 685-687 (v248, v254 and others) |
| `minion_jobs` | `spend_authorization`, `spend_claim_token` | trigger reads them at 1799; added by `core/schema-migrations/v205-minion-spend-authorization.ts` |
| `ingest_log` | `writer_version`, `writer_host_id`, `writer_segment_reader` | declared inline at 706-708 (v254), so these ARE in range |

---

### Global objects

#### Extensions (schema.sql:3-6)
- `vector` (pgvector): `vector(1536)` and `vector(1024)` columns, HNSW indexes with `vector_cosine_ops`.
- `pg_trgm`: `gin_trgm_ops` on `pages.title` and `pages.slug`.
- `pgcrypto`: fallback for `gen_random_uuid()` (also core in PG13+).

#### Functions (all in range)

| Function | Lines | Kind / attributes | Purpose |
|---|---|---|---|
| `gbrain_try_jsonb(text) -> jsonb` | 64-72 | plpgsql IMMUTABLE STRICT; catches `data_exception` and returns NULL | Safe text-to-jsonb cast for double-encoded config/payload (#7112, v263). |
| `bump_page_generation_fn()` | 182-205 | trigger fn, plpgsql | On INSERT: `generation = MAX(generation)+1`. On UPDATE: `generation = OLD+1` when any of compiled_truth, timeline, frontmatter, deleted_at, contextual_retrieval_mode, title, type, page_kind, corpus_generation or content_hash changes (IS DISTINCT FROM). Also bumps when `body_generation` changes and `compiled_truth` is NULL on both sides. |
| `bump_page_generation_clock_fn()` | 267-272 | trigger fn, plpgsql | `PERFORM nextval('page_generation_clock_seq')`; returns NULL (statement trigger). |
| `gbrain_forget_page_retrievals()` | 313-330 | trigger fn, plpgsql | On DELETE from `pages` (statement level): `DELETE FROM page_retrievals USING gbrain_deleted_pages` (transition table). Raises `writer_coordinator_required` (P0001) if RLS is active and the role cannot read the needed `pg_policy` rows for `r` and `d`. |
| `gbrain_fts_input(t text) -> text` | 432-436 | SQL IMMUTABLE STRICT PARALLEL SAFE | Inserts a space at CJK/Kana/Hangul vs ASCII-alnum boundaries (two regexp_replace passes) before tsvector. No-op on non-CJK text (#6370). |
| `update_chunk_search_vector()` | 444-452 | trigger fn | `search_vector = setweight(to_tsvector('english', gbrain_fts_input(doc_comment)),'A') || ...symbol_name_qualified,'A' || ...chunk_text,'B'`. |
| `update_page_search_vector()` | 1196-1228 | trigger fn, plpgsql | On UPDATE, raises `writer_coordinator_required` if `timeline_entries` is RLS-protected and the role cannot read it. Builds `pages.search_vector`: title at weight A; `COALESCE(NEW.timeline, timeline_lead)` capped at 65536 chars at weight C; joined `timeline_entries` (summary || ' ' || detail, ORDER BY id) capped at 32768 chars at weight C. |
| `enforce_minion_queue_protocol()` | 1789-1807 | trigger fn, plpgsql | Protocol gate for `minion_jobs`. INSERT requires `submission_authority IS NOT NULL` and `claim_generation = 0`. A transition to `active` (or a `lock_token` change) requires `claim_generation = OLD+1` and, if `spend_authorization` is set, `spend_claim_token = claim_generation`. Any other `claim_generation` change raises. |
| `notify_minion_job_change()` | 1813-1821 | trigger fn, plpgsql | `pg_notify('minion_jobs', json{id,status,name,queue,prev_status})`. Comment at 1819 says Postgres only, not PGLite. |

Also in range: `DROP FUNCTION IF EXISTS update_page_search_vector_from_timeline()` (1243) removes an old function. `ts_filter(tsvector, '{a}')` at 1187 is a Postgres built-in (tsvector filter, PG 14+); it is not defined in this repo.

#### Triggers (all in range)

| Trigger | On | Timing / scope | Fn | Lines |
|---|---|---|---|---|
| `bump_page_generation_trg` | `pages` | BEFORE INSERT OR UPDATE, FOR EACH ROW | `bump_page_generation_fn` | 209-212 |
| `bump_page_generation_clock_trg` | `pages` | AFTER INSERT OR UPDATE OR DELETE, FOR EACH STATEMENT | `bump_page_generation_clock_fn` | 275-278 |
| `pages_forget_retrievals` | `pages` | AFTER DELETE, REFERENCING OLD TABLE AS `gbrain_deleted_pages`, FOR EACH STATEMENT | `gbrain_forget_page_retrievals` | 332-334 |
| `chunk_search_vector_trigger` | `content_chunks` | BEFORE INSERT OR UPDATE OF chunk_text, doc_comment, symbol_name_qualified, FOR EACH ROW | `update_chunk_search_vector` | 455-457 |
| `trg_pages_search_vector` | `pages` | BEFORE INSERT OR UPDATE OF title, timeline, FOR EACH ROW | `update_page_search_vector` | 1231-1233 |
| `minion_queue_protocol` | `minion_jobs` | BEFORE INSERT OR UPDATE, FOR EACH ROW | `enforce_minion_queue_protocol` | 1809-1810 |
| `minion_job_notify` | `minion_jobs` | AFTER INSERT OR UPDATE OF status, FOR EACH ROW | `notify_minion_job_change` | 1824-1825 |

Dropped in range: `trg_timeline_search_vector` on `timeline_entries` (1242) and its function (1243).

#### Sequence and clock (schema.sql:242-265)
- `page_generation_clock` table (242-245): single row `id=1 CHECK (id=1)`, `value BIGINT DEFAULT 0`. Seeded from `MAX(pages.generation)` (246-248). Kept for compatibility; the live clock is the sequence.
- `page_generation_clock_seq` (255): created with `CREATE SEQUENCE IF NOT EXISTS`. Re-runnable seed at 260-265: `setval(seq, GREATEST(1, seq.last_value, clock.value, MAX(pages.generation)))`. Comment says the 2-arg setval makes the first write strictly exceed the seed, and the GREATEST prevents a replay from moving `last_value` backward (stale query_cache bookmark risk).

#### Row-level and statement-level bump contract (for Rust parity)
- `pages.generation` (per-row, Layer 2) is written by `bump_page_generation_fn`.
- `page_generation_clock_seq` (global, Layer 1) is advanced by `nextval` in a statement trigger on every INSERT/UPDATE/DELETE statement on `pages`. Readers read `last_value` (see `core/health-memo.ts:83`).

---

### Sources and tenancy

#### sources (schema.sql:26-90)
Purpose: logical brain-within-the-DB registry. Every page/file/ingest row carries `source_id`. The `default` row is seeded (78-82) with `config={"federated": true}`.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | TEXT | PK, NOT NULL | Immutable citation key `[a-z0-9-]{1,32}` (app-enforced) |
| name | TEXT | NOT NULL, UNIQUE | Mutable display label |
| local_path | TEXT | NULL | Git checkout root for filesystem sources |
| last_commit | TEXT | NULL | |
| last_sync_at | TIMESTAMPTZ | NULL | |
| config | JSONB | NOT NULL DEFAULT '{}' | `federated`, `access_policy`, `github_repo` |
| chunker_version | TEXT | NULL | Forces full walk when mismatched (v0.20) |
| archived | BOOLEAN | NOT NULL DEFAULT false | Soft-delete |
| archived_at | TIMESTAMPTZ | NULL | |
| archive_expires_at | TIMESTAMPTZ | NULL | Purge when `<= now()` |
| contextual_retrieval_mode | TEXT | NULL | Per-source override; NULL = global |
| trust_frontmatter_overrides | BOOLEAN | NOT NULL DEFAULT false | Mount trust gate |
| newest_content_at | TIMESTAMPTZ | NULL | Newest HEAD commit time at last sync (v0.41.32) |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| incarnation | UUID | NOT NULL DEFAULT gen_random_uuid() | Added by DO block 1867-1878, not inline; unique index 1879 |

Indexes:
- `sources_github_repo_idx` (88-90): btree on `(config->>'github_repo')` WHERE `config ? 'github_repo'`. Partial expression index. The `?` (JSONB key-exists) operator is used in the predicate.
- `sources_incarnation_key` UNIQUE (`incarnation`) (1879).
- PK and UNIQUE(name) are implicit.

Functions used by sources: `gbrain_try_jsonb` (64) is defined here and used by source-config SQL.

Readers/writers:
- Writers: `core/sources-ops.ts`, `core/persistence/source-lifecycle.ts`, `core/persistence/managed-sync-orphans.ts`, `core/engine-sql/sources.ts`.
- Readers: `core/source-resolver.ts`, `commands/sources.ts`, `core/sync-anchor.ts`, `core/source-config-sql.ts`.
- Engines use the shared `core/engine-sql/*` for both PGLite and Postgres (`core/postgres-engine.ts`, `core/pglite-engine.ts`).

---

### Pages and content

#### pages (schema.sql:99-206)
Purpose: core content table. One row per page, unique by `(source_id, slug)`. Holds compiled truth, timeline text, frontmatter, and the soft-delete, salience, retrieval and extraction watermarks.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| source_id | TEXT | NOT NULL DEFAULT 'default' | FK `sources(id)` ON DELETE CASCADE |
| slug | TEXT | NOT NULL | |
| type | TEXT | NOT NULL | Page type (also drives `event` projections) |
| page_kind | TEXT | NOT NULL DEFAULT 'markdown' | CHECK in (`markdown`,`code`,`image`) |
| title | TEXT | NOT NULL | |
| compiled_truth | TEXT | NOT NULL DEFAULT '' | Becomes NULL-able in v248 (migration) |
| timeline | TEXT | NOT NULL DEFAULT '' | Becomes NULL-able in v248 (migration) |
| frontmatter | JSONB | NOT NULL DEFAULT '{}' | |
| content_hash | TEXT | NULL | |
| emotional_weight | REAL | NOT NULL DEFAULT 0.0 | Deterministic 0..1 salience |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| deleted_at | TIMESTAMPTZ | NULL | Soft delete; purge after 72h |
| effective_date | TIMESTAMPTZ | NULL | Salience/recency |
| effective_date_source | TEXT | NULL | 'event_date' / 'date' / 'published' / 'filename' / 'fallback' |
| import_filename | TEXT | NULL | |
| salience_touched_at | TIMESTAMPTZ | NULL | |
| last_retrieved_at | TIMESTAMPTZ | NULL | Legacy; readers take GREATEST with `page_retrievals` |
| links_extracted_at | TIMESTAMPTZ | NULL | Extraction watermark (v112) |
| database_only_reason | TEXT | NULL | `'unbound_source'` marks DB-only pages (v177) |
| contextual_retrieval_mode | TEXT | NULL | Tier last embedded under |
| corpus_generation | TEXT | NULL | Composite hash for cache invalidation |
| generation | BIGINT | NOT NULL DEFAULT 1 | Per-row counter, see trigger |
| search_vector | TSVECTOR | NULL | `ALTER TABLE ADD COLUMN IF NOT EXISTS` at 1183 |
| knowledge_revision | UUID | DEFAULT gen_random_uuid(); NOT NULL only when table empty | DO block 1880-1891 |
| text_projection_revision | UUID | NULL | 1892 |

Constraints: `CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)` (line 178). `page_kind` CHECK as above.

Indexes:
- `pages_generation_idx` (219): btree (`generation`).
- `idx_pages_type` (280): btree (`type`).
- `idx_pages_frontmatter` (281): GIN (`frontmatter`).
- `idx_pages_trgm` (282): GIN (`title gin_trgm_ops`).
- `idx_pages_slug_basename` (283): btree (`source_id`, `regexp_replace(slug,'^.*/','')`). Expression index for basename lookup.
- `idx_pages_source_title_lower` (285): btree (`source_id`, `lower(title)`) (v240).
- `idx_pages_slug_trgm` (286): GIN (`slug gin_trgm_ops`).
- `idx_pages_updated_at_desc` (288): btree (`updated_at DESC`).
- `idx_pages_source_id` (290): btree (`source_id`).
- `pages_deleted_at_purge_idx` (296): partial btree (`deleted_at`) WHERE `deleted_at IS NOT NULL`.
- `pages_links_extracted_at_idx` (342): btree (`source_id`, `links_extracted_at`). No partial predicate (NULL and `<` arms are covered).
- `pages_coalesce_date_idx` (348): expression btree on `COALESCE(effective_date, updated_at)`.
- `idx_pages_search` (1185): GIN (`search_vector`).
- `idx_pages_title_search` (1187): GIN (`ts_filter(search_vector,'{a}')`). Title-only slice (v267).

Triggers: `bump_page_generation_trg` (209), `bump_page_generation_clock_trg` (275), `pages_forget_retrievals` (332, AFTER DELETE), `trg_pages_search_vector` (1231).

Readers/writers:
- Main engine SQL: `core/engine-sql/pages.ts` (45 SQL-keyword hits), `core/engine-sql/links.ts` (joins), `core/engine-sql/chunks.ts`, `core/engine-sql/bootstrap.ts`.
- Other readers: `core/search/read-enrichment.ts`, `core/facts/purge-verify.ts`, `core/page-state/*`.
- Engines: `core/postgres-engine.ts`, `core/pglite-engine.ts` (both delegate to engine-sql).

#### page_generation_clock (schema.sql:242-248)
Purpose: legacy single-row global clock. Kept for upgrade compatibility; the live clock is `page_generation_clock_seq`.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | INTEGER | PK, CHECK (id = 1) | |
| value | BIGINT | NOT NULL DEFAULT 0 | Seeded from `MAX(pages.generation)` |

Indexes: none beyond PK.
Readers/writers: no live writer in range. Only `core/schema-migrations/v107-*.ts` and `v118-*.ts` touch it. Live readers use the sequence (`core/health-memo.ts:83`, `last_value`).

#### page_retrievals (schema.sql:308-334)
Purpose: retrieval telemetry, split out of `pages` so the per-read upsert is a HOT update of a narrow row (not an UPDATE of `pages`, which would advance the generation clock). Written at most once per page per 5 minutes.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| page_id | INTEGER | PK | No FK (comment at 300-307: KEY SHARE lock would dirty `pages`) |
| last_retrieved_at | TIMESTAMPTZ | NOT NULL | |

Indexes: PK only.
Triggers: `pages_forget_retrievals` (331-334) removes rows whose `page_id` was hard-deleted (statement trigger on DELETE).
Readers/writers:
- Writer: `core/last-retrieved.ts`.
- Readers: `core/engine-sql/pages.ts` (2 hits), `core/verbs/entity-card.ts`.
- Trigger SQL source: `core/derived-state-maintainers.ts` (GENERATED block at 310-312).

#### page_versions (schema.sql:679-691)
Purpose: snapshot history for compiled truth and frontmatter (v248 adds segmented snapshots that reference a generation, not a copy).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| page_id | INTEGER | NOT NULL | FK `pages(id)` ON DELETE CASCADE |
| compiled_truth | TEXT | NOT NULL | NULL-able after v248 (migration) |
| frontmatter | JSONB | NOT NULL DEFAULT '{}' | |
| snapshot_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| knowledge_revision | UUID | NULL | ALTER at 1893 |
| timeline | TEXT | NULL | ALTER at 1894 |
| title | TEXT | NULL | ALTER at 1895 |
| type | TEXT | NULL | ALTER at 1896 |
| tags | JSONB | NULL | ALTER at 1897 |
| is_deleted | BOOLEAN | NULL | ALTER at 1898 |

Indexes: `idx_versions_page` (690): btree (`page_id`).
Readers/writers: writers and readers are `core/page-state/versions.ts` (main), `core/page-state/schema.ts`, `core/engine-sql/pages.ts`, `core/facts/purge.ts`. Migration `core/schema-migrations/v248-segmented-page-storage.ts` also writes.

#### raw_data (schema.sql:631-642)
Purpose: sidecar JSON per page and source (replaces `.raw/` files).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| page_id | INTEGER | NOT NULL | FK `pages(id)` ON DELETE CASCADE |
| source | TEXT | NOT NULL | Sidecar kind |
| data | JSONB | NOT NULL | |
| fetched_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: `UNIQUE (page_id, source)`. Indexes: `idx_raw_data_page` (640) btree (`page_id`).
Readers/writers: `core/postgres-engine.ts` (8 hits), `core/pglite-engine.ts` (3), `core/repair/secret-spans.ts`, `core/persistence/twin-merge.ts`, `commands/export.ts`.

#### tags (schema.sql:616-627)
Purpose: per-page tags.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| page_id | INTEGER | NOT NULL | FK `pages(id)` ON DELETE CASCADE |
| tag | TEXT | NOT NULL | |
| tag_source | TEXT | NULL | `'frontmatter'` (import-owned, deleted when it leaves frontmatter), `'added'`, or NULL legacy |

Constraints: `UNIQUE (page_id, tag)`. Indexes: `idx_tags_tag` (625) btree (`tag`); `idx_tags_page_id` (626) btree (`page_id`).
Readers/writers: `core/page-state/tags.ts` (main), `core/engine-sql/salience.ts`, `core/persistence/twin-merge.ts`, `core/repair/segmented-tiling.ts`.

#### timeline_entries (schema.sql:645-674)
Purpose: structured timeline. Also the date-index projection for `type:event` pages (Life Chronicle).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| page_id | INTEGER | NOT NULL | FK `pages(id)` ON DELETE CASCADE (the depth/meeting page) |
| date | DATE | NOT NULL | |
| source | TEXT | NOT NULL DEFAULT '' | Meeting provenance; part of dedup key |
| summary | TEXT | NOT NULL | |
| detail | TEXT | NOT NULL DEFAULT '' | |
| event_page_id | INTEGER | NULL | FK `pages(id)` ON DELETE CASCADE; set for event projections |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Indexes:
- `idx_timeline_page` (662): btree (`page_id`).
- `idx_timeline_date` (663): btree (`date`).
- `idx_timeline_dedup` (670): UNIQUE btree (`page_id`, `date`, `md5(summary)`, `source`). Keyed on md5 to avoid the btree row-size cap (#3737). Used for `ON CONFLICT` inference at both insert sites.
- `idx_timeline_event_page` (673): partial btree (`event_page_id`) WHERE `event_page_id IS NOT NULL`.
- `idx_timeline_event_dedup` (674): partial UNIQUE (`event_page_id`, `date`) WHERE `event_page_id IS NOT NULL`.

Triggers: none in range (the `timeline_entries` search trigger was removed at 1242).
Readers/writers: `core/engine-sql/timeline.ts` (main, 8 hits), `core/timeline-dedup-repair.ts`, `core/repair/timeline.ts`, `core/persistence/twin-merge.ts`, `core/timeline-extract.ts`. `update_page_search_vector` reads it (1196-1228).

#### files (schema.sql:1136-1166)
Purpose: binary attachments (originally Supabase Storage).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| source_id | TEXT | NOT NULL DEFAULT 'default' | FK `sources(id)` ON DELETE CASCADE |
| page_slug | TEXT | NULL | Legacy, FK dropped (no ON UPDATE CASCADE) |
| page_id | INTEGER | NULL | FK `pages(id)` ON DELETE SET NULL |
| filename | TEXT | NOT NULL | |
| storage_path | TEXT | NOT NULL, UNIQUE | `storage_url` dropped at 1153 |
| mime_type | TEXT | NULL | |
| size_bytes | BIGINT | NULL | |
| content_hash | TEXT | NOT NULL | |
| metadata | JSONB | NOT NULL DEFAULT '{}' | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Indexes: `idx_files_page` (1155) btree (`page_slug`); `idx_files_page_id` (1156); `idx_files_source_id` (1157); `idx_files_hash` (1158) btree (`content_hash`). Plus UNIQUE(`storage_path`).
Readers/writers: `core/ops/files.ts` (10 hits), `commands/files.ts` (9), `core/engine-sql/files.ts`. Backfill and migration: `core/schema-migrations/v023-*.ts`, `v039-*.ts`.

#### file_migration_ledger (schema.sql:1168-1181)
Purpose: state machine for the v0.18.0 storage-object rewrite. Keyed by `file_id` so two sources can share an old path.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| file_id | INTEGER | PK | FK `files(id)` ON DELETE CASCADE |
| storage_path_old | TEXT | NOT NULL | |
| storage_path_new | TEXT | NOT NULL | |
| status | TEXT | NOT NULL DEFAULT 'pending' | CHECK in (`pending`,`copy_done`,`db_updated`,`complete`,`failed`) |
| error | TEXT | NULL | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Indexes: `idx_file_migration_ledger_status` (1177) partial btree (`status`) WHERE `status != 'complete'`.
Readers/writers: `commands/migrations/v0_18_0-storage-backfill.ts` (5 hits), `core/schema-migrations/v023-files-source-id-page-id-ledger.ts`.

#### ingest_log (schema.sql:700-718)
Purpose: ingest/facts-absorb audit log. `source_id` scopes failure counts per source.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| source_id | TEXT | NOT NULL DEFAULT 'default' | (no FK in DDL) |
| source_type | TEXT | NOT NULL | |
| source_ref | TEXT | NOT NULL | |
| pages_updated | JSONB | NOT NULL DEFAULT '[]' | |
| summary | TEXT | NOT NULL DEFAULT '' | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| writer_version | TEXT | NULL | v254 |
| writer_host_id | UUID | NULL | v254 |
| writer_segment_reader | BOOLEAN | NULL | v254; NULL from older binaries |

Indexes: `idx_ingest_log_source_type_created` (714) btree (`source_id`, `source_type`, `created_at DESC`).
Readers/writers: `core/postgres-engine.ts` (2 hits), `core/pglite-engine.ts` (3), `core/persistence/writer-versions.ts`, `core/facts/absorb-log.ts`. Migration `core/schema-migrations/v050-ingest-log-source-id.ts` and `v254-segment-reader-marks.ts`.

#### config (schema.sql:720-732)
Purpose: brain-level key/value settings.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| key | TEXT | PK | |
| value | TEXT | NOT NULL | |

Seed (725-731, `ON CONFLICT DO NOTHING`): `version='1'`, `embedding_model='text-embedding-3-large'`, `embedding_dimensions='1536'`, `chunk_strategy='semantic'`.
Indexes: PK only.
Readers/writers: `core/postgres-engine.ts` (5), `core/pglite-engine.ts` (5), `core/persistence/limits.ts`, `core/repair/content-receipt-root.ts`, `core/cycle/dream-breaker.ts`, `core/backup/quarantine.ts`. Broadest-used table in this set (104 files, mostly migration-driven).

#### Pages domain: parity note
`pages` plus its triggers is the Postgres-specific core of the generation and search system: `nextval` sequence, plpgsql triggers, statement-level transition tables (`REFERENCING OLD TABLE`), `ts_filter`, `tsvector` weights and GIN. See the parity list at the end of this file.

---

### Chunks and embeddings

#### content_chunks (schema.sql:354-427)
Purpose: chunked page content with vector embeddings (text, image, multimodal) and code-chunk metadata. Chunks are re-INSERTed on page change; there is no `updated_at`.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| page_id | INTEGER | NOT NULL | FK `pages(id)` ON DELETE CASCADE |
| chunk_index | INTEGER | NOT NULL | Unique per page (see index) |
| chunk_text | TEXT | NOT NULL | |
| chunk_source | TEXT | NOT NULL DEFAULT 'compiled_truth' | |
| embedding | vector(1536) | NULL | Text embedding, default model `text-embedding-3-large` |
| model | TEXT | NOT NULL DEFAULT 'text-embedding-3-large' | |
| token_count | INTEGER | NULL | |
| embedded_at | TIMESTAMPTZ | NULL | |
| embedded_text_hash | TEXT | NULL | md5(chunk_text) at embed time (v133); NULL = pre-v133 |
| embedding_input_hash | TEXT | NULL | Provenance of embedding input (v171) |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| language | TEXT | NULL | Code chunks only |
| symbol_name | TEXT | NULL | Code chunks only |
| symbol_type | TEXT | NULL | Code chunks only |
| start_line | INTEGER | NULL | Code chunks only |
| end_line | INTEGER | NULL | Code chunks only |
| parent_symbol_path | TEXT[] | NULL | v0.20 |
| doc_comment | TEXT | NULL | v0.20 |
| symbol_name_qualified | TEXT | NULL | v0.20 |
| search_vector | TSVECTOR | NULL | Weighted A (doc_comment, qualified name), B (chunk_text) |
| modality | TEXT | NOT NULL DEFAULT 'text' | `text` vs image rows |
| embedding_image | vector(1024) | NULL | Voyage multimodal image vectors (v0.27.1) |
| embedding_multimodal | vector(1024) | NULL | Unified cross-modal column (v0.36, v75). No index in range. |

Migration-added, not declared in range (see the top-level table): `occurrence_id`, `local_ordinal`, `raw_byte_start/end`, `body_generation`, `retired_generation`, `embedding_pending_since`, `projected_byte_start/end`.

Indexes:
- `idx_chunks_page_index` (406): UNIQUE btree (`page_id`, `chunk_index`).
- `idx_chunks_page` (407): btree (`page_id`).
- `idx_chunks_embedding` (408): HNSW (`embedding vector_cosine_ops`), no WHERE.
- `idx_chunks_symbol_name` (410): partial btree (`symbol_name`) WHERE `symbol_name IS NOT NULL`.
- `idx_chunks_language` (411): partial btree (`language`) WHERE `language IS NOT NULL`.
- `idx_chunks_embedding_image` (414-415): partial HNSW (`embedding_image vector_cosine_ops`) WHERE `embedding_image IS NOT NULL`.
- `idx_chunks_search_vector` (418): GIN (`search_vector`).
- `idx_chunks_symbol_qualified` (419-420): partial btree (`symbol_name_qualified`) WHERE NOT NULL.
- `content_chunks_stale_idx` (426-427): partial btree (`page_id`, `chunk_index`) WHERE `embedding IS NULL`. Serves `embed --stale`.

Triggers: `chunk_search_vector_trigger` (454-457). Its function is `update_chunk_search_vector` (444-452). It fires only when `chunk_text`, `doc_comment` or `symbol_name_qualified` change. `gbrain_fts_input` (432-436) is applied inside it.

Readers/writers:
- Main: `core/engine-sql/chunks.ts` (34 hits, reads and writes).
- Others: `core/embedding-migration.ts`, `core/page-state/projections.ts`, `core/engine-sql/bootstrap.ts`, `core/page-body/projection.ts`, `core/schema-migrations/v248-segmented-page-storage.ts`.
- Searches: `searchKeyword()` queries `content_chunks.search_vector`, not `pages.search_vector` (comment at 1190-1194, #2704).

#### code_edges_chunk (schema.sql:472-494)
Purpose: resolved structural code edges where both endpoints are known chunk IDs. Readers UNION this with `code_edges_symbol`.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| from_chunk_id | INTEGER | NOT NULL | FK `content_chunks(id)` ON DELETE CASCADE |
| to_chunk_id | INTEGER | NOT NULL | FK `content_chunks(id)` ON DELETE CASCADE |
| from_symbol_qualified | TEXT | NOT NULL | |
| to_symbol_qualified | TEXT | NOT NULL | |
| edge_type | TEXT | NOT NULL | |
| edge_metadata | JSONB | NOT NULL DEFAULT '{}' | |
| source_id | TEXT | NULL | FK `sources(id)` ON DELETE CASCADE |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: `code_edges_chunk_unique` UNIQUE (`from_chunk_id`, `to_chunk_id`, `edge_type`). `source_id` is not in the key; `from_chunk_id` pins the source.

Indexes:
- `idx_code_edges_chunk_from` (485): btree (`from_chunk_id`, `edge_type`).
- `idx_code_edges_chunk_to` (487): btree (`to_chunk_id`, `edge_type`).
- `idx_code_edges_chunk_to_symbol` (489): btree (`to_symbol_qualified`, `edge_type`).
- `idx_code_edges_chunk_from_symbol` (494): btree (`from_symbol_qualified`). Comment: `getCalleesOf` was a seq scan without it (v116).

Readers/writers: `core/engine-sql/code-edges.ts` (main), `core/pglite-engine/code-edges.ts`, `core/chunkers/symbol-resolver.ts`.

#### code_edges_symbol (schema.sql:497-515)
Purpose: unresolved references. The target is known by qualified name, but its defining chunk is not imported yet. No promotion step; readers UNION it with `code_edges_chunk`.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| from_chunk_id | INTEGER | NOT NULL | FK `content_chunks(id)` ON DELETE CASCADE |
| from_symbol_qualified | TEXT | NOT NULL | |
| to_symbol_qualified | TEXT | NOT NULL | |
| edge_type | TEXT | NOT NULL | |
| edge_metadata | JSONB | NOT NULL DEFAULT '{}' | |
| source_id | TEXT | NULL | FK `sources(id)` ON DELETE CASCADE |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: `code_edges_symbol_unique` UNIQUE (`from_chunk_id`, `to_symbol_qualified`, `edge_type`).

Indexes:
- `idx_code_edges_symbol_from` (509): btree (`from_chunk_id`, `edge_type`).
- `idx_code_edges_symbol_to` (511): btree (`to_symbol_qualified`, `edge_type`).
- `idx_code_edges_symbol_from_symbol` (515): btree (`from_symbol_qualified`). Companion to the chunk-table index (v116).

Readers/writers: `core/engine-sql/code-edges.ts` (main), `core/chunkers/symbol-resolver.ts` (writer, 5 hits), migrations `v027`, `v058`, `v116`.

---

### Links and graph

#### links (schema.sql:549-592)
Purpose: typed cross-references between pages. Provenance is an open kebab-case tag, not a closed enum (v114 / #1941).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| from_page_id | INTEGER | NOT NULL | FK `pages(id)` ON DELETE CASCADE |
| to_page_id | INTEGER | NOT NULL | FK `pages(id)` ON DELETE CASCADE |
| link_type | TEXT | NOT NULL DEFAULT '' | |
| context | TEXT | NOT NULL DEFAULT '' | |
| link_source | TEXT | NULL | CHECK NULL or (`~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'` AND `char_length <= 64`). Managed built-ins: `markdown`, `frontmatter`, `mentions`, `wikilink-resolved`. User: `manual`, or any kebab tag. |
| link_kind | TEXT | NULL | CHECK NULL or in (`plain`,`typed_ner`) (v98) |
| origin_page_id | INTEGER | NULL | FK `pages(id)` ON DELETE SET NULL. Set for `frontmatter` edges. |
| origin_field | TEXT | NULL | Frontmatter field name, e.g. `key_people` |
| resolution_type | TEXT | NULL | CHECK NULL or in (`qualified`,`unqualified`) (v0.18 Step 4) |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| assertion_tense | TEXT | NULL | CONSTRAINT `links_assertion_tense_check`: NULL or in (`present`,`past`) |

Constraints:
- `links_from_to_type_source_origin_unique`: UNIQUE NULLS NOT DISTINCT (`from_page_id`, `to_page_id`, `link_type`, `link_source`, `origin_page_id`) (PG15+ syntax). Manual and frontmatter edges with the same tuple coexist; NULL origin values collide as expected.

Indexes:
- `idx_links_from` (586): btree (`from_page_id`).
- `idx_links_to` (587): btree (`to_page_id`).
- `idx_links_source` (588): btree (`link_source`).
- `idx_links_origin` (589): btree (`origin_page_id`).
- `idx_links_supersedes_to` (590): partial btree (`to_page_id`) WHERE `link_type = 'supersedes'`.

Readers/writers:
- Main: `core/engine-sql/links.ts` (25 hits, plus joins on `pages`).
- Others: `core/search/read-enrichment.ts`, `core/persistence/manual-links.ts` (writer, `add_link` path), `core/engine-sql/health.ts`, `core/page-state/rename-alias.ts`.
- Migration `core/schema-migrations/v011-links-provenance-columns.ts`.

#### wanted_links (schema.sql:595-611)
Purpose: authored links whose target does not exist yet. A live target updated after `checked_at` marks the origin stale for extraction (`core/wanted-links.ts`).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| origin_page_id | INTEGER | NOT NULL | FK `pages(id)` ON DELETE CASCADE |
| source_id | TEXT | NOT NULL | FK `sources(id)` ON DELETE CASCADE |
| producer | TEXT | NOT NULL | CHECK in (`body`,`frontmatter`) |
| ref_kind | TEXT | NOT NULL | CHECK in (`slug`,`name`) |
| target_source_id | TEXT | NOT NULL | No FK |
| target_ref | TEXT | NOT NULL | |
| link_type | TEXT | NOT NULL DEFAULT '' | |
| context | TEXT | NOT NULL DEFAULT '' | |
| checked_at | TIMESTAMPTZ | NOT NULL | |
| first_seen_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: `wanted_links_reference_unique` UNIQUE (`origin_page_id`, `producer`, `ref_kind`, `target_source_id`, `target_ref`).
Indexes: `wanted_links_target_idx` (610) btree (`target_source_id`, `target_ref`); `wanted_links_source_idx` (611) btree (`source_id`).
Readers/writers: `core/wanted-links-store.ts` (main, 3 hits), `core/engine-sql/pages.ts` (2), migration `core/schema-migrations/v214-wanted-links.ts`.

---

### Auth, access and OAuth

#### access_tokens (schema.sql:735-748)
Purpose: bearer tokens for remote MCP access (hashed).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | UUID | PK DEFAULT gen_random_uuid() | |
| name | TEXT | NOT NULL | |
| token_hash | TEXT | NOT NULL, UNIQUE | |
| scopes | TEXT[] | NULL | |
| created_at | TIMESTAMPTZ | DEFAULT now() | Nullable (no NOT NULL in DDL) |
| last_used_at | TIMESTAMPTZ | NULL | |
| revoked_at | TIMESTAMPTZ | NULL | |

Indexes: `idx_access_tokens_hash` (745): partial btree (`token_hash`) WHERE `revoked_at IS NULL`. The UNIQUE on `token_hash` also creates an index.
Readers/writers: `core/grants/legacy-token.ts` (12 hits), `core/grants/access-token-schema.ts`, `core/token-mint.ts`, `core/persistence/authority.ts`, `core/access/members.ts`.

#### mcp_request_log (schema.sql:750-762)
Purpose: usage log for remote MCP requests; feeds the admin dashboard.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| token_name | TEXT | NULL | |
| agent_name | TEXT | NULL | |
| operation | TEXT | NOT NULL | |
| latency_ms | INTEGER | NULL | |
| status | TEXT | NOT NULL DEFAULT 'success' | |
| params | JSONB | NULL | |
| error_message | TEXT | NULL | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Indexes: `idx_mcp_log_time_agent` (865) btree (`created_at`, `token_name`); `idx_mcp_log_agent_time` (866) btree (`agent_name`, `created_at DESC`).
Readers/writers: writer `commands/serve-http-mcp.ts` (6 hits); reader `commands/serve-http-admin-api.ts` (8 hits); retention `core/mcp-request-log-retention.ts`; `core/engine-sql/bootstrap.ts` (4). RLS listed at 1834-1865.

#### oauth_clients (schema.sql:765-811)
Purpose: OAuth 2.1 registered clients, including per-client grant axes: source scope, federated read, budget, agent binding, tool surface, and takes holders.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| client_id | TEXT | PK | |
| client_secret_hash | TEXT | NULL | |
| client_name | TEXT | NOT NULL | |
| redirect_uris | TEXT[] | NULL | |
| grant_types | TEXT[] | DEFAULT '{"client_credentials"}' | |
| scope | TEXT | NULL | |
| token_endpoint_auth_method | TEXT | NULL | |
| client_id_issued_at | BIGINT | NULL | |
| client_secret_expires_at | BIGINT | NULL | |
| token_ttl | INTEGER | NULL | |
| deleted_at | TIMESTAMPTZ | NULL | |
| source_id | TEXT | NULL | FK `sources(id)` ON DELETE RESTRICT (not CASCADE) |
| federated_read | TEXT[] | NOT NULL DEFAULT '{}' | |
| budget_usd_per_day | NUMERIC(10,2) | NULL | v84 |
| bound_tools | TEXT[] | NULL | v85 agent binding |
| bound_source_id | TEXT | NULL | v85 |
| bound_brain_id | TEXT | NULL | v85 |
| bound_slug_prefixes | TEXT[] | NULL | v85 |
| bound_max_concurrent | INTEGER | NOT NULL DEFAULT 1 | |
| surface | TEXT | NULL | v127 tool surface; open value space |
| surface_set_by | TEXT | NULL | `operator`, `self`, `dcr_default` |
| allowed_operations | TEXT[] | NULL | |
| delegated_slug_prefixes | TEXT[] | NULL | |
| delegated_namespace | TEXT | NOT NULL DEFAULT 'prefixes' | |
| grant_profile | TEXT | NULL | |
| grant_revision | INTEGER | NOT NULL DEFAULT 0 | |
| grant_repair_reasons | TEXT[] | NOT NULL DEFAULT '{}' | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| source_grant | TEXT | NULL | CHECK (`source_grant IN ('none')`). Added by `grants/oauth-client-axes-schema.ts`. |
| takes_holders | TEXT[] | NULL | NULL = `['world']` |

Indexes: `idx_oauth_clients_source_id` (806-807) partial btree (`source_id`) WHERE NOT NULL; `idx_oauth_clients_federated_read` (808-809) GIN (`federated_read`).
Readers/writers: `core/oauth-provider.ts` (19 hits, main), `core/grants/service.ts` (writer), `core/grants/schema.ts`, `commands/auth.ts` (7), migration `v085-oauth-clients-agent-binding.ts`. RLS listed at 1834-1865.

#### oauth_grant_audit (schema.sql:813-825, GENERATED from `core/grants/schema.ts`)
Purpose: append-only audit of grant changes per client.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| client_id | TEXT | NOT NULL | No FK |
| actor | TEXT | NOT NULL | |
| action | TEXT | NOT NULL | |
| revision | INTEGER | NOT NULL | |
| before_grant | JSONB | NULL | |
| after_grant | JSONB | NOT NULL | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Indexes: `idx_oauth_grant_audit_client` (823) btree (`client_id`, `created_at`).
Readers/writers: writer `core/grants/service.ts` (3 hits); `core/grants/lifecycle.ts`, `core/grants/migration.ts`, `core/grants/schema.ts`. Migration `v210-clamp-oauth-token-ttl.ts`.

#### fact_withdrawals (schema.sql:828-836, GENERATED from `core/facts/withdrawal-schema.ts`)
Purpose: withdrawal tombstones for facts, scoped by source and visibility (private or world).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| source_id | TEXT | NOT NULL | FK `sources(id)` ON DELETE CASCADE |
| visibility | TEXT | NOT NULL | CHECK in (`private`,`world`) |
| subject | TEXT | NOT NULL DEFAULT '*' | |
| fact_hash | TEXT | NOT NULL | |
| withdrawn_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: PK (`source_id`, `visibility`, `subject`, `fact_hash`). Indexes: PK only in range. Facts index and withdrawal trigger are installed by migrations 60 and 148 (comment at 826, outside range).
Readers/writers: `core/facts/withdrawal.ts` (5 hits, main), `core/facts/withdrawal-schema.ts` (11), `core/facts/single-prepare.ts`, `core/persistence/effect-targets.ts`, `core/repair/conversation-labels.ts`.

#### oauth_tokens (schema.sql:838-849)
Purpose: issued OAuth access and refresh tokens (hashed).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| token_hash | TEXT | PK | |
| token_type | TEXT | NOT NULL | |
| client_id | TEXT | NOT NULL | FK `oauth_clients(client_id)` ON DELETE CASCADE |
| scopes | TEXT[] | NULL | |
| expires_at | BIGINT | NULL | Epoch seconds |
| resource | TEXT | NULL | RFC 8707 resource |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Indexes: `idx_oauth_tokens_expiry` (848) btree (`expires_at`); `idx_oauth_tokens_client` (849) btree (`client_id`).
Readers/writers: `core/oauth-provider.ts` (6), `core/oauth-grants.ts` (6), `commands/serve-http-admin-api.ts` (2), `core/shared-skills/restore.ts`. RLS listed at 1834-1865.

#### oauth_codes (schema.sql:851-863)
Purpose: short-lived PKCE authorization codes (hashed).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| code_hash | TEXT | PK | |
| client_id | TEXT | NOT NULL | FK `oauth_clients(client_id)` ON DELETE CASCADE |
| scopes | TEXT[] | NULL | |
| code_challenge | TEXT | NOT NULL | PKCE |
| code_challenge_method | TEXT | NOT NULL DEFAULT 'S256' | |
| redirect_uri | TEXT | NOT NULL | |
| state | TEXT | NULL | |
| resource | TEXT | NULL | |
| expires_at | BIGINT | NOT NULL | Epoch seconds |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Indexes: none in range (no index on `expires_at`).
Readers/writers: `core/oauth-grants.ts` (4 hits, main), `core/oauth-provider.ts` (2), `core/grants/service.ts` (1), `core/shared-skills/restore.ts`. RLS listed at 1834-1865.

---

### Jobs, minions, checkpoints and locks

#### minion_jobs (schema.sql:1248-1321)
Purpose: Postgres-native job queue (BullMQ-inspired). Holds queue state, retry and backoff, parent and child trees, locks and timeouts, token accounting, and the protocol-1 claim generation.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| name | TEXT | NOT NULL | Job kind |
| queue | TEXT | NOT NULL DEFAULT 'default' | |
| status | TEXT | NOT NULL DEFAULT 'waiting' | CHECK in (waiting, active, completed, failed, delayed, dead, cancelled, waiting-children, paused) |
| priority | INTEGER | NOT NULL DEFAULT 0 | |
| submission_authority | JSONB | NULL | NULL = legacy row; local authorization needed before workers start |
| claim_generation | BIGINT | NOT NULL DEFAULT 0 | Advanced only by protocol-aware claims |
| data | JSONB | NOT NULL DEFAULT '{}' | |
| max_attempts | INTEGER | NOT NULL DEFAULT 3 | CHECK >= 1 |
| attempts_made | INTEGER | NOT NULL DEFAULT 0 | CHECK attempts_made <= attempts_started |
| attempts_started | INTEGER | NOT NULL DEFAULT 0 | |
| backoff_type | TEXT | NOT NULL DEFAULT 'exponential' | CHECK in (fixed, exponential) |
| backoff_delay | INTEGER | NOT NULL DEFAULT 1000 | ms |
| backoff_jitter | REAL | NOT NULL DEFAULT 0.2 | CHECK 0.0..1.0 |
| stalled_counter | INTEGER | NOT NULL DEFAULT 0 | CHECK >= 0 |
| max_stalled | INTEGER | NOT NULL DEFAULT 5 | CHECK >= 0 |
| lock_token | TEXT | NULL | |
| lock_until | TIMESTAMPTZ | NULL | |
| delay_until | TIMESTAMPTZ | NULL | |
| parent_job_id | INTEGER | NULL | FK `minion_jobs(id)` ON DELETE SET NULL |
| on_child_fail | TEXT | NOT NULL DEFAULT 'fail_parent' | CHECK in (fail_parent, remove_dep, ignore, continue) |
| tokens_input | INTEGER | NOT NULL DEFAULT 0 | |
| tokens_output | INTEGER | NOT NULL DEFAULT 0 | |
| tokens_cache_read | INTEGER | NOT NULL DEFAULT 0 | |
| result | JSONB | NULL | |
| progress | JSONB | NULL | |
| error_text | TEXT | NULL | |
| stacktrace | JSONB | DEFAULT '[]' | |
| depth | INTEGER | NOT NULL DEFAULT 0 | CHECK >= 0 |
| max_children | INTEGER | NULL | CHECK > 0 |
| timeout_ms | INTEGER | NULL | CHECK > 0 |
| lock_duration_ms | INTEGER | NULL | CHECK NULL or 5000..3600000 |
| timeout_at | TIMESTAMPTZ | NULL | |
| remove_on_complete | BOOLEAN | NOT NULL DEFAULT FALSE | |
| remove_on_fail | BOOLEAN | NOT NULL DEFAULT FALSE | |
| idempotency_key | TEXT | NULL | Unique when not NULL |
| private_queue_owner_job_id | INTEGER | NULL | FK `minion_jobs(id)` ON DELETE SET NULL |
| private_queue_owner_token | TEXT | NULL | |
| private_queue_lease_until | TIMESTAMPTZ | NULL | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| started_at | TIMESTAMPTZ | NULL | |
| finished_at | TIMESTAMPTZ | NULL | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints (named): `chk_status`, `chk_backoff_type`, `chk_on_child_fail`, `chk_jitter_range`, `chk_attempts_order`, `chk_nonnegative` (attempts, stalled, max_attempts >= 1, max_stalled >= 0), `chk_depth_nonnegative`, `chk_max_children_positive`, `chk_timeout_positive`, `chk_lock_duration_positive` (lines 1292-1302).

Migration-added (not in range): `spend_authorization`, `spend_claim_token` (v205), read by trigger 1799.

Indexes:
- `idx_minion_jobs_claim` (1304): btree (`queue`, `priority ASC`, `created_at ASC`) WHERE `status='waiting'`. Claim path.
- `idx_minion_jobs_status` (1305): btree (`status`).
- `idx_minion_jobs_stalled` (1306): partial btree (`lock_until`) WHERE `status='active'`.
- `idx_minion_jobs_delayed` (1307): partial btree (`delay_until`) WHERE `status='delayed'`.
- `idx_minion_jobs_parent` (1308): btree (`parent_job_id`).
- `idx_minion_jobs_timeout` (1309): partial btree (`timeout_at`) WHERE `status='active' AND timeout_at IS NOT NULL`.
- `idx_minion_jobs_parent_status` (1310): partial btree (`parent_job_id`, `status`) WHERE `parent_job_id IS NOT NULL`.
- `uniq_minion_jobs_idempotency` (1311): UNIQUE partial btree (`idempotency_key`) WHERE NOT NULL.
- `idx_minion_jobs_queue_status_updated` (1314): btree (`queue`, `status`, `updated_at`). Wedge signal (v127).
- `idx_minion_jobs_private_queue_recovery` (1315-1317): partial btree (`queue`, `private_queue_lease_until`) WHERE `queue LIKE 'dream-inline-%' AND status IN (waiting, active, delayed, waiting-children, paused)`.
- `idx_minion_jobs_private_queue_owner` (1319-1320): partial btree (`private_queue_owner_job_id`) WHERE NOT NULL.

Triggers: `minion_queue_protocol` (1808-1810, BEFORE INSERT OR UPDATE, FOR EACH ROW) runs `enforce_minion_queue_protocol`. `minion_job_notify` (1823-1825, AFTER INSERT OR UPDATE OF status) runs `notify_minion_job_change` (`pg_notify`, Postgres only).
RLS: listed in the DO block at 1834-1865.

Readers/writers:
- Main: `core/minions/queue.ts` (93 hits, claim, insert, update, and reads).
- Others: `commands/doctor/checks/queue-jobs.ts` (13), `core/minions/job-insight.ts` (10), `core/minions/authorize-legacy.ts` (8), `core/minions/supervisor.ts` (wedge queries), `core/ops/jobs.ts`.
- Migration `core/schema-migrations/v007-agent-parity-layer.ts` and v024-v205 family.

#### minion_inbox (schema.sql:1324-1333)
Purpose: sidechannel messages to a job (child_done notices, etc.).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| job_id | INTEGER | NOT NULL | FK `minion_jobs(id)` ON DELETE CASCADE |
| sender | TEXT | NOT NULL | |
| payload | JSONB | NOT NULL | |
| sent_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| read_at | TIMESTAMPTZ | NULL | |

Indexes: `idx_minion_inbox_unread` (1332): partial btree (`job_id`) WHERE `read_at IS NULL`. `idx_minion_inbox_child_done` (1333): partial btree (`job_id`, `sent_at`) WHERE `payload->>'type' = 'child_done'`.
RLS listed at 1834-1865.
Readers/writers: `core/minions/queue.ts` (7), `core/ops/jobs.ts` (1). Migrations v006, v007, v024.

#### minion_attachments (schema.sql:1336-1351)
Purpose: per-job binary blobs (manifests, agent outputs). Either inline bytes or an external URI.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| job_id | INTEGER | NOT NULL | FK `minion_jobs(id)` ON DELETE CASCADE |
| filename | TEXT | NOT NULL | |
| content_type | TEXT | NOT NULL | |
| content | BYTEA | NULL | `STORAGE EXTERNAL` (1351, TOAST setting, not semantic) |
| storage_uri | TEXT | NULL | |
| size_bytes | INTEGER | NOT NULL | CHECK >= 0 |
| sha256 | TEXT | NOT NULL | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: `uniq_minion_attachments_job_filename` UNIQUE (`job_id`, `filename`); `chk_attachment_storage` CHECK (`content IS NOT NULL OR storage_uri IS NOT NULL`).
Indexes: `idx_minion_attachments_job` (1350) btree (`job_id`).
Readers/writers: `core/minions/queue.ts` (5). Migrations v007, v024.

#### migration_impact_log (schema.sql:1377-1399)
Purpose: before/after metric stats per onboard remediation. Delta is computed at read time (no stored generated column).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| remediation_id | TEXT | NOT NULL | |
| metric_name | TEXT | NOT NULL | |
| metric_before | NUMERIC | NULL | |
| metric_after | NUMERIC | NULL | |
| job_id | BIGINT | NULL | FK `minion_jobs(id)` ON DELETE SET NULL |
| source_id | TEXT | NULL | No FK |
| brain_id | TEXT | NULL | |
| started_at | TIMESTAMPTZ | NULL | |
| idempotency_key | TEXT | NULL | |
| applied_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| applied_by | TEXT | NULL | |
| details | JSONB | DEFAULT '{}' | |

Indexes: `migration_impact_log_remediation_idx` (1392) btree (`remediation_id`, `applied_at DESC`); `migration_impact_log_attribution_idx` (1394) partial btree (`job_id`, `source_id`) WHERE `job_id IS NOT NULL`.
Readers/writers: `core/onboard/impact-capture.ts` (writer), `commands/onboard.ts` (reader), migration `core/schema-migrations/v103-migration-impact-log-and-priority-recent-idx.ts`. Note the table is placed after `minion_jobs` on purpose (comment at 1354-1372, v0.41.25.0 ordering fix).

#### subagent_messages (schema.sql:1403-1425)
Purpose: durable Anthropic-shape or provider-neutral message blocks, one row per message in a subagent loop.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| job_id | BIGINT | NOT NULL | FK `minion_jobs(id)` ON DELETE CASCADE |
| message_idx | INTEGER | NOT NULL | UNIQUE with job_id |
| role | TEXT | NOT NULL | CHECK in (user, assistant) |
| content_blocks | JSONB | NOT NULL | ChatBlock[] (schema_version 2) or legacy blocks (1) |
| schema_version | INTEGER | NOT NULL DEFAULT 1 | |
| provider_id | TEXT | NULL | e.g. anthropic, openai, deepseek |
| tokens_in | INTEGER | NULL | |
| tokens_out | INTEGER | NULL | |
| tokens_cache_read | INTEGER | NULL | |
| tokens_cache_create | INTEGER | NULL | |
| model | TEXT | NULL | |
| ended_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: `uniq_subagent_messages_idx` UNIQUE (`job_id`, `message_idx`); `chk_subagent_messages_role`.
Indexes: `idx_subagent_messages_job` (1424) btree (`job_id`, `message_idx`); `idx_subagent_messages_provider` (1425) btree (`job_id`, `provider_id`).
Readers/writers: `core/minions/handlers/subagent.ts` (2), `core/minions/handlers/subagent-persistence.ts` (2), `core/minions/transcript.ts` (1). Migration v036 (provider-neutral persistence).

#### subagent_tool_executions (schema.sql:1438-1463)
Purpose: two-phase tool-call ledger (pending, then complete or failed). Identity is `(job_id, message_idx, ordinal)`; `tool_use_id` is not unique per job (#4155, uniq dropped in v131).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| job_id | BIGINT | NOT NULL | FK `minion_jobs(id)` ON DELETE CASCADE |
| message_idx | INTEGER | NOT NULL | |
| tool_use_id | TEXT | NOT NULL | Raw provider id, NOT unique |
| tool_name | TEXT | NOT NULL | |
| input | JSONB | NOT NULL | |
| status | TEXT | NOT NULL | CHECK in (pending, complete, failed) |
| output | JSONB | NULL | |
| error | TEXT | NULL | |
| schema_version | INTEGER | NOT NULL DEFAULT 1 | |
| provider_id | TEXT | NULL | |
| ordinal | INTEGER | NULL | v0.38 D11; NULL on pre-v82 rows |
| gbrain_tool_use_id | UUID | NULL | uuid v7, NULL on legacy rows |
| started_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| ended_at | TIMESTAMPTZ | NULL | |

Constraints: `subagent_tool_executions_stable_id` UNIQUE (`job_id`, `message_idx`, `ordinal`).
Indexes: `idx_subagent_tools_job` (1463) btree (`job_id`, `status`).
Readers/writers: `core/minions/handlers/subagent-persistence.ts` (13, main), `core/minions/handlers/subagent.ts` (4), `core/minions/handlers/subagent-oneshot.ts` (3), `core/cycle/patterns.ts` (4).

#### subagent_rate_leases (schema.sql:1469-1476)
Purpose: concurrency cap on outbound providers. Acquire = insert if active < max under advisory lock; release = delete. Expired leases are pruned on next acquire.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| key | TEXT | NOT NULL | e.g. `anthropic:messages` |
| owner_job_id | BIGINT | NOT NULL | FK `minion_jobs(id)` ON DELETE CASCADE |
| acquired_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| expires_at | TIMESTAMPTZ | NOT NULL | |

Indexes: `idx_rate_leases_key_expires` (1476) btree (`key`, `expires_at`).
Readers/writers: `core/minions/rate-leases.ts` (5, main). RLS listed at 1834-1865.

#### op_checkpoints (schema.sql:878-894)
Purpose: shared checkpoint table for long-running ops. Fingerprint is a sha8 over canonical JSON of op-relevant params.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| op | TEXT | NOT NULL | PK part |
| fingerprint | TEXT | NOT NULL | PK part |
| completed_keys | JSONB | NOT NULL DEFAULT '[]' | CHECK `jsonb_typeof = 'array'` (constraint `op_checkpoints_completed_keys_array`) |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | GC after 7 days in cycle purge |

Constraints: PK (`op`, `fingerprint`).
Indexes: `op_checkpoints_updated_at_idx` (889) btree (`updated_at`); `op_checkpoints_sync_hold_page_idx` (892-893) partial expression btree on `(completed_keys->0->>'page_id')` WHERE `op = 'sync-hold'` (#5988, v200).
Readers/writers: `core/persistence/sync-holds.ts` (29, main), `core/persistence/managed-sync-orphans.ts` (16), `core/persistence/sync-run.ts` (13), `core/persistence/sync-failures.ts` (12), `core/persistence/atom-maintenance.ts` (12), `core/op-checkpoint.ts` (generic loader).

#### op_checkpoint_paths (schema.sql:900-912)
Purpose: append-only delta rows for `completed_keys` (#1794). Replaces rewriting the whole JSON array on each flush.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| op | TEXT | NOT NULL | PK part; FK part |
| fingerprint | TEXT | NOT NULL | PK part; FK part |
| path | TEXT | NOT NULL | PK part |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: PK (`op`, `fingerprint`, `path`); FK (`op`, `fingerprint`) REFERENCES `op_checkpoints` ON DELETE CASCADE (`op_checkpoint_paths_parent_fk`).
Indexes: none beyond PK.
Readers/writers: `core/op-checkpoint.ts` (3), migration `v115-op-checkpoint-paths-append-table.ts`.

#### dream_verdicts (schema.sql:1485-1506)
Purpose: cache of the cheap "is this transcript worth processing" verdict per (file_path, content_hash). Triage v1 fields added by v129; 30-day TTL (v138).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| file_path | TEXT | NOT NULL | PK part |
| content_hash | TEXT | NOT NULL | PK part |
| worth_processing | BOOLEAN | NOT NULL | |
| reasons | JSONB | NULL | |
| judged_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| score | DOUBLE PRECISION | NULL | Triage v1, ordinal in [0,1] |
| content_type | TEXT | NULL | |
| segments | JSONB | NULL | |
| entities | JSONB | NULL | |
| model | TEXT | NULL | |
| triage_version | INT | NULL | |
| expires_at | TIMESTAMPTZ | NOT NULL DEFAULT (now() + interval '30 days') | |

Constraints: PK (`file_path`, `content_hash`).
Indexes: `dream_verdicts_expires_idx` (1505) btree (`expires_at`).
Readers/writers: `core/postgres-engine.ts` (3), `core/pglite-engine.ts` (3), `core/engine-sql/bootstrap.ts` (in DDL), `core/deletion-inventory.ts`. Migrations v030, v129, v143. Rebuildable cache (`gbrain dream retriage --force`). Not page-scoped, so it has no `page_id` (comment at 1487-1491 contrasts it with `raw_data`).

#### gbrain_cycle_locks (schema.sql:1516-1532)
Purpose: cycle coordination lock (runCycle primitive). Holders refresh `ttl_expires_at`; crashed holders auto-release at TTL. Chosen over session advisory locks so it works through PgBouncer transaction pooling.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | TEXT | PK | Lock name |
| holder_pid | INT | NOT NULL | |
| holder_host | TEXT | NULL | |
| acquired_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| ttl_expires_at | TIMESTAMPTZ | NOT NULL | |
| last_refreshed_at | TIMESTAMPTZ | NULL | v97; `--break-lock --max-age` |
| acquisition_token | UUID | NOT NULL DEFAULT gen_random_uuid() | ALTER at 1530-1531 (lease token, generated block) |

Indexes: `idx_cycle_locks_ttl` (1528) btree (`ttl_expires_at`).
Readers/writers: `core/db-lock.ts` (22, main), `core/page-embedding-lease.ts` (3), `core/persistence/skill-activation.ts` (2), `core/migration-orchestration-lock.ts`, `commands/apply-migrations.ts`, `commands/embed.ts`. RLS listed at 1834-1865.

---

### Retrieval feedback and session context

#### context_volunteer_events (schema.sql:915-931)
Purpose: feedback log for pages volunteered by push-based context (`volunteer_context` op, retrieval reflex, `gbrain watch`). Rationale is a deterministic template, not raw text. 90-day prune in the dream purge phase.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NOT NULL | No FK |
| slug | TEXT | NOT NULL | |
| confidence | DOUBLE PRECISION | NOT NULL | |
| match_arm | TEXT | NOT NULL | |
| rationale | TEXT | NOT NULL DEFAULT '' | |
| channel | TEXT | NOT NULL DEFAULT 'op' | |
| session_id | TEXT | NULL | |
| turn | INTEGER | NULL | |
| volunteered_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Indexes: `context_volunteer_events_src_time_idx` (927) btree (`source_id`, `volunteered_at DESC`); `context_volunteer_events_src_slug_idx` (929) btree (`source_id`, `slug`).
Readers/writers: `core/context/volunteer-events.ts` (2, writer), `commands/doctor/checks/core-health.ts` (2), `core/persistence/purge-name-stores.ts`, `core/facts/purge-verify.ts`. Migration v117.

#### retrieval_events (schema.sql:936-942)
Purpose: one row per answer-producing retrieval (query, search, think, synthesize, recall). Feeds use-attributed feedback. No query text stored.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| client_id | TEXT | NOT NULL DEFAULT 'local' | |
| op | TEXT | NOT NULL | CHECK in (query, search, think, synthesize, recall) |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Indexes: `retrieval_events_time_idx` (942) btree (`created_at`).
Readers/writers: `core/feedback/store.ts` (4, writer and reader). Migration v207.

#### retrieval_event_pages (schema.sql:943-951)
Purpose: pages returned by a retrieval event, with the revision hash used.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| event_id | TEXT | NOT NULL | FK `retrieval_events(id)` ON DELETE CASCADE |
| source_id | TEXT | NOT NULL | No FK |
| slug | TEXT | NOT NULL | |
| content_hash | TEXT | NULL | Revision that was retrieved |
| rank | INTEGER | NOT NULL | |
| cited | BOOLEAN | NOT NULL DEFAULT false | |

Constraints: PK (`event_id`, `source_id`, `slug`). Indexes: PK only.
Readers/writers: `core/feedback/store.ts` (3). `core/facts/purge-verify.ts` (1).

#### retrieval_event_links (schema.sql:952-958)
Purpose: relational-path edges used by an answer.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| event_id | TEXT | NOT NULL | FK `retrieval_events(id)` ON DELETE CASCADE |
| source_id | TEXT | NOT NULL | No FK |
| edge_key | TEXT | NOT NULL | |
| to_slug | TEXT | NOT NULL | |

Constraints: PK (`event_id`, `source_id`, `edge_key`, `to_slug`). Indexes: PK only.
Readers/writers: `core/feedback/store.ts` (3). `core/facts/purge-verify.ts` (1).

#### retrieval_feedback (schema.sql:959-973)
Purpose: explicit or cited ratings that move per-element weights (neutral 0.5).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| event_id | TEXT | NOT NULL | FK `retrieval_events(id)` ON DELETE CASCADE |
| signal | TEXT | NOT NULL | CHECK in (explicit, cited) |
| element_kind | TEXT | NOT NULL | CHECK in (page, link) |
| source_id | TEXT | NOT NULL | No FK |
| element_key | TEXT | NOT NULL | |
| client_id | TEXT | NOT NULL DEFAULT 'local' | |
| rating | SMALLINT | NOT NULL | CHECK 1..5 |
| weight_before | REAL | NOT NULL | |
| weight_after | REAL | NOT NULL | |
| applied_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: PK (`event_id`, `signal`, `element_kind`, `source_id`, `element_key`).
Indexes: `retrieval_feedback_client_time_idx` (972) btree (`client_id`, `applied_at DESC`).
Readers/writers: `core/feedback/store.ts` (9, main writer).

#### retrieval_weights (schema.sql:974-989)
Purpose: learned per-element weight (page or link) per source. The search ranking stage reads it.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| source_id | TEXT | NOT NULL | FK `sources(id)` ON DELETE CASCADE |
| element_kind | TEXT | NOT NULL | CHECK in (page, link) |
| element_key | TEXT | NOT NULL | |
| weight | REAL | NOT NULL DEFAULT 0.5 | CHECK 0 <= w <= 1 |
| content_hash | TEXT | NULL | |
| updates | INTEGER | NOT NULL DEFAULT 0 | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: PK (`source_id`, `element_kind`, `element_key`). Indexes: PK only.
Readers/writers: `core/feedback/store.ts` (10, writer), `core/search/feedback-boost.ts` (LEFT JOIN, reader), migration v207.

#### session_context_state (schema.sql:991-1007)
Purpose: per-session cursor and dedup for the `delta` verb and heartbeat (ambient recall).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| source_id | TEXT | NOT NULL | No FK |
| client_id | TEXT | NOT NULL DEFAULT 'local' | |
| session_id | TEXT | NOT NULL | |
| standing_entities | JSONB | NOT NULL DEFAULT '[]' | |
| surfaced_slugs | JSONB | NOT NULL DEFAULT '[]' | |
| checkpoint_manifest | JSONB | NOT NULL DEFAULT '[]' | |
| last_wake_at | TIMESTAMPTZ | NULL | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| facts_cursor_at | TIMESTAMPTZ | NULL | Facts keyset (v208) |
| facts_cursor_id | BIGINT | NULL | Facts keyset (v208) |
| degraded_wakes | INTEGER | NOT NULL DEFAULT 0 | Consecutive incomplete wakes |

Constraints: PK (`source_id`, `client_id`, `session_id`).
Indexes: `session_context_state_updated_idx` (1005) btree (`updated_at`).
Readers/writers: `core/context/session-state.ts` (8, main), migrations v126, v132, v208.

#### extract_atoms_transcript_state (schema.sql:1036-1050)
Purpose: failure streak and tombstone for transcript extraction items. Transcripts are files, not pages, so `raw_data` cannot hold this. Keyed on source_id because extraction is source-scoped.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| source_id | TEXT | NOT NULL DEFAULT 'default' | No FK |
| file_path | TEXT | NOT NULL | PK part |
| content_hash | TEXT | NOT NULL | PK part (16-char prefix); an edit resets the streak |
| fail_count | INTEGER | NOT NULL DEFAULT 0 | |
| tombstoned | BOOLEAN | NOT NULL DEFAULT FALSE | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| partial_input_chars | INTEGER | NULL | Input cap a cut transcript was read under (v240, #6503) |

Constraints: PK (`source_id`, `file_path`, `content_hash`).
Indexes: `extract_atoms_transcript_state_tombstoned_idx` (1048) partial btree (`source_id`, `content_hash`) WHERE `tombstoned`.
Readers/writers: `core/cycle/extract-atoms-input.ts` (3, reader), `core/cycle/extract-atoms.ts` (2, writer). Migrations v146, v242. RLS: covered by the v35 auto RLS event trigger (comment at 1034-1035), not the DO block.

---

### Facts, loops and usage

#### open_loops (schema.sql:1078-1112)
Purpose: Gmail-first open-loop engine. Records who is waiting on you and what you promised. Deduped per source on `dedup_key`. Loops close by state transition, never delete.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NOT NULL | FK `sources(id)` ON DELETE CASCADE |
| dedup_key | TEXT | NOT NULL | |
| loop_type | TEXT | NOT NULL | CHECK in (commitment_owed_by_me, commitment_owed_to_me, unanswered_inbound, unanswered_outbound, decision_pending) |
| counterparty_slug | TEXT | NULL | |
| counterparty_email | TEXT | NULL | |
| summary | TEXT | NOT NULL | |
| evidence | JSONB | NOT NULL DEFAULT '[]' | |
| thread_id | TEXT | NULL | |
| page_slug | TEXT | NULL | |
| due_at | TIMESTAMPTZ | NULL | |
| status | TEXT | NOT NULL DEFAULT 'open' | CHECK in (open, done, dropped, stale) |
| detector | TEXT | NOT NULL | CHECK in (deterministic_thread, llm_extract, manual) |
| confidence | REAL | NOT NULL DEFAULT 1.0 | |
| fact_id | BIGINT | NULL | Projection into `facts` (no FK in DDL) |
| opened_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| last_activity_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| closed_at | TIMESTAMPTZ | NULL | |
| closed_by | TEXT | NULL | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: `open_loops_dedup` UNIQUE (`source_id`, `dedup_key`).
Indexes: `open_loops_status_idx` (1104) btree (`source_id`, `status`, `last_activity_at DESC`); `open_loops_counterparty_idx` (1106) partial btree (`source_id`, `counterparty_slug`) WHERE `status='open'`; `open_loops_thread_idx` (1108) partial btree (`source_id`, `thread_id`) WHERE `status='open'`.
Readers/writers: `core/loops/loops-store.ts` (13, main), `core/persistence/loop-fact-retirement.ts` (5), `core/repair/conversation-labels.ts` (2), `core/loops/loops-schema.ts` (2). Migration v144. RLS: not in the DO list at 1834-1865.

#### loop_suppressions (schema.sql:1114-1122)
Purpose: `gbrain loops mute <sender|thread>`. Suppressed senders or threads never open new loops.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NOT NULL | FK `sources(id)` ON DELETE CASCADE |
| kind | TEXT | NOT NULL | CHECK in (sender, thread) |
| value | TEXT | NOT NULL | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

Constraints: `loop_suppressions_uniq` UNIQUE (`source_id`, `kind`, `value`). Indexes: none beyond the unique.
Readers/writers: `core/loops/loops-store.ts` (4). Migration v144.

#### chat_usage_log (schema.sql:1057-1076)
Purpose: durable per-call usage ledger for successful gateway chat calls. `cost_usd` is NULL when the model has no pricing (never a fake 0).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| model | TEXT | NOT NULL | |
| provider | TEXT | NULL | |
| phase | TEXT | NULL | |
| input_tokens | INTEGER | NOT NULL DEFAULT 0 | |
| output_tokens | INTEGER | NOT NULL DEFAULT 0 | |
| cache_read_tokens | INTEGER | NOT NULL DEFAULT 0 | |
| cache_write_tokens | INTEGER | NOT NULL DEFAULT 0 | |
| cost_usd | DOUBLE PRECISION | NULL | |

Indexes: `idx_chat_usage_log_created` (1069) btree (`created_at`); `idx_chat_usage_log_model` (1071) btree (`model`, `created_at`).
Readers/writers: writer `core/ai/chat-usage.ts` (1), reader `core/ops/usage.ts` (2, the `get_usage` op). Migration v140. RLS: covered by the v35 auto event trigger (comment at 1035).

---

### Evals, takes and calibration

#### eval_candidates (schema.sql:1543-1576)
Purpose: captured query and search calls from the op-layer wrapper, PII-scrubbed before insert, for BrainBench-Real replay.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| tool_name | TEXT | NOT NULL | CHECK in (query, search) |
| query | TEXT | NOT NULL | CHECK `length(query) <= 51200` (characters in PG) |
| retrieved_slugs | TEXT[] | NOT NULL DEFAULT '{}' | |
| retrieved_chunk_ids | INTEGER[] | NOT NULL DEFAULT '{}' | |
| source_ids | TEXT[] | NOT NULL DEFAULT '{}' | |
| expand_enabled | BOOLEAN | NULL | |
| detail | TEXT | NULL | CHECK in (low, medium, high) |
| detail_resolved | TEXT | NULL | CHECK in (low, medium, high) |
| vector_enabled | BOOLEAN | NOT NULL | |
| expansion_applied | BOOLEAN | NOT NULL | |
| latency_ms | INTEGER | NOT NULL | |
| remote | BOOLEAN | NOT NULL | |
| job_id | INTEGER | NULL | No FK |
| subagent_id | INTEGER | NULL | No FK |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| as_of_ts | TIMESTAMPTZ | NULL | v0.29.1 |
| salience_param | TEXT | NULL | v0.29.1 |
| recency_param | TEXT | NULL | v0.29.1 |
| salience_resolved | TEXT | NULL | v0.29.1 |
| recency_resolved | TEXT | NULL | v0.29.1 |
| salience_source | TEXT | NULL | v0.29.1 |
| recency_source | TEXT | NULL | v0.29.1 |
| embedding_column | TEXT | NULL | v68 / v0.36.3; replay uses it |

Indexes: `idx_eval_candidates_created_at` (1576) btree (`created_at DESC`).
Readers/writers: writers `core/postgres-engine.ts` (3), `core/pglite-engine.ts` (3), `core/eval-capture-scrub.ts` (scrub before insert); pruning `commands/eval-prune.ts`; reads by `core/eval-contradictions/runner.ts`, `core/eval-contradictions/cost-tracker.ts`. Migrations v031, v042, v074. RLS: in DO list (1834-1865).

#### eval_capture_failures (schema.sql:1578-1584)
Purpose: cross-process audit of eval-capture insert failures, surfaced by `gbrain doctor` (in-process counters cannot cross the MCP/CLI boundary).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | SERIAL | PK | |
| ts | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |
| reason | TEXT | NOT NULL | CHECK in (db_down, rls_reject, check_violation, scrubber_exception, other) |

Indexes: `idx_eval_capture_failures_ts` (1583) btree (`ts DESC`).
Readers/writers: writers `core/postgres-engine.ts` (2), `core/pglite-engine.ts` (2); reader `commands/doctor/checks/knowledge-health.ts`. Migration v031. RLS: in DO list.

#### eval_takes_quality_runs (schema.sql:1591-1612)
Purpose: DB-authoritative receipts for the takes-quality eval. Re-running the same run is a no-op via the 4-sha unique key.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| receipt_sha8_corpus | TEXT | NOT NULL | UNIQUE part |
| receipt_sha8_prompt | TEXT | NOT NULL | UNIQUE part |
| receipt_sha8_models | TEXT | NOT NULL | UNIQUE part |
| receipt_sha8_rubric | TEXT | NOT NULL | UNIQUE part |
| rubric_version | TEXT | NOT NULL | |
| verdict | TEXT | NOT NULL | CHECK in (pass, fail, inconclusive) |
| overall_score | REAL | NOT NULL | |
| dim_scores | JSONB | NOT NULL | |
| cost_usd | REAL | NOT NULL | |
| receipt_json | JSONB | NOT NULL | Full receipt for `replay` |
| receipt_disk_path | TEXT | NULL | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT NOW() | |

Constraints: UNIQUE (`receipt_sha8_corpus`, `receipt_sha8_prompt`, `receipt_sha8_models`, `receipt_sha8_rubric`).
Indexes: `eval_takes_quality_runs_trend_idx` (1607) btree (`rubric_version`, `created_at DESC`).
Readers/writers: writer `core/takes-quality-eval/receipt-write.ts`; readers `core/takes-quality-eval/trend.ts`, `core/takes-quality-eval/replay.ts`. Migration v049.

#### eval_contradictions_cache (schema.sql:1614-1628)
Purpose: persistent judge verdicts for the contradiction probe. Prompt version and truncation policy are in the PK, so a prompt edit invalidates old verdicts. TTL via `expires_at`, swept periodically.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| chunk_a_hash | TEXT | NOT NULL | PK part |
| chunk_b_hash | TEXT | NOT NULL | PK part |
| model_id | TEXT | NOT NULL | PK part |
| prompt_version | TEXT | NOT NULL | PK part |
| truncation_policy | TEXT | NOT NULL | PK part |
| verdict | JSONB | NOT NULL | |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| expires_at | TIMESTAMPTZ | NOT NULL | |

Constraints: PK (`chunk_a_hash`, `chunk_b_hash`, `model_id`, `prompt_version`, `truncation_policy`).
Indexes: `eval_contradictions_cache_expires_idx` (1625) btree (`expires_at`).
Readers/writers: `core/engine-sql/takes.ts` (3), `commands/eval.ts`, `core/eval-contradictions/types.ts`. Migrations v052, v055, v070. RLS: in DO list.

#### eval_contradictions_runs (schema.sql:1631-1648)
Purpose: time-series of contradiction-probe runs, for the `trend` subcommand and the doctor `contradictions` check. `report_json` holds the full ProbeReport.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| run_id | TEXT | PK | |
| ran_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| schema_version | INTEGER | NOT NULL DEFAULT 1 | |
| judge_model | TEXT | NOT NULL | |
| prompt_version | TEXT | NOT NULL | |
| queries_evaluated | INTEGER | NOT NULL | |
| queries_with_contradiction | INTEGER | NOT NULL | |
| total_contradictions_flagged | INTEGER | NOT NULL | |
| wilson_ci_lower | REAL | NOT NULL | |
| wilson_ci_upper | REAL | NOT NULL | |
| judge_errors_total | INTEGER | NOT NULL | |
| cost_usd_total | REAL | NOT NULL | |
| duration_ms | INTEGER | NOT NULL | |
| source_tier_breakdown | JSONB | NOT NULL | |
| report_json | JSONB | NOT NULL | |

Indexes: `eval_contradictions_runs_ran_at_idx` (1648) btree (`ran_at DESC`).
Readers/writers: `core/eval-contradictions/cost-prompt.ts`, `core/eval-contradictions/run-health.ts`, `core/ops/insights.ts`, `core/engine-sql/takes.ts` (2), `commands/eval-suspected-contradictions.ts`, `commands/doctor/checks/knowledge-health.ts`. Migration v053. RLS: in DO list.

#### calibration_profiles (schema.sql:1659-1688)
Purpose: per-holder LLM narrative aggregation of takes scorecard data. `published` gates cross-brain sharing (D15).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NOT NULL | FK `sources(id)` ON DELETE CASCADE |
| holder | TEXT | NOT NULL | |
| wave_version | TEXT | NOT NULL DEFAULT 'v0.36.1.0' | |
| generated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| published | BOOLEAN | NOT NULL DEFAULT false | |
| total_resolved | INTEGER | NOT NULL | |
| brier | REAL | NULL | |
| accuracy | REAL | NULL | |
| partial_rate | REAL | NULL | |
| grade_completion | REAL | NOT NULL DEFAULT 1.0 | |
| domain_scorecards | JSONB | NOT NULL | |
| pattern_statements | TEXT[] | NOT NULL | |
| voice_gate_passed | BOOLEAN | NOT NULL | |
| voice_gate_attempts | SMALLINT | NOT NULL | |
| active_bias_tags | TEXT[] | NOT NULL | |
| model_id | TEXT | NOT NULL | |
| cost_usd | NUMERIC(10,4) | NULL | |
| judge_model_agreement | REAL | NULL | |

Indexes: `calibration_profiles_holder_recent_idx` (1680) btree (`source_id`, `holder`, `generated_at DESC`); `calibration_profiles_bias_tags_gin` (1682) GIN (`active_bias_tags`); `calibration_profiles_published_idx` (1684) partial btree (`source_id`, `published`, `holder`) WHERE `published = true`.
Readers/writers: writer `core/cycle/calibration-profile.ts` (2); `core/calibration/undo-wave.ts` (2), `core/calibration/voice-gate.ts`, `core/calibration/domain-aggregators.ts`, `core/ops/calibration.ts`, `commands/doctor/checks/calibration.ts` (2), `core/brainstorm/orchestrator.ts` (1). Migration v068. RLS: in DO list.

#### take_proposals (schema.sql:1690-1725)
Purpose: candidate takes proposed by the cycle, awaiting accept or reject. Per-claim idempotency (v125) via `md5(claim_text)`.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NOT NULL | FK `sources(id)` ON DELETE CASCADE |
| page_slug | TEXT | NOT NULL | No FK to pages (slug-keyed) |
| content_hash | TEXT | NOT NULL | |
| prompt_version | TEXT | NOT NULL | |
| wave_version | TEXT | NOT NULL DEFAULT 'v0.36.1.0' | |
| proposed_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| proposal_run_id | TEXT | NOT NULL | |
| status | TEXT | NOT NULL DEFAULT 'pending' | CHECK in (pending, accepted, rejected, superseded) |
| claim_text | TEXT | NOT NULL | |
| kind | TEXT | NOT NULL | |
| holder | TEXT | NOT NULL | |
| weight | REAL | NOT NULL | |
| domain | TEXT | NULL | |
| dedup_against_fence_rows | JSONB | NULL | |
| model_id | TEXT | NOT NULL | |
| acted_at | TIMESTAMPTZ | NULL | |
| acted_by | TEXT | NULL | |
| promoted_row_num | INTEGER | NULL | |
| predicted_brier | REAL | NULL | |
| predicted_brier_bucket_n | INTEGER | NULL | |

Indexes:
- `take_proposals_idempotency_idx` (1714): UNIQUE btree (`source_id`, `page_slug`, `content_hash`, `prompt_version`, `md5(claim_text)`).
- `take_proposals_pending_idx` (1716): partial btree (`source_id`, `status`, `proposed_at DESC`) WHERE `status='pending'`.
- `take_proposals_run_id_idx` (1719): btree (`proposal_run_id`).

Readers/writers: `core/take-proposals.ts` (7, main), `core/cycle/propose-takes.ts` (4), `core/cycle/propose-takes-failures.ts` (3), `core/facts/purge.ts`, `core/facts/purge-verify.ts`. Migrations v069, v125. RLS: in DO list.

#### take_grade_cache (schema.sql:1727-1747)
Purpose: `grade_takes` verdict cache. Composite PK means prompt, judge model or evidence change invalidates cleanly. `applied=false` by default (D17): grades do not mutate takes until an operator opts in.

| Column | Type | Null / default | Notes |
|---|---|---|---|
| take_id | BIGINT | NOT NULL | PK part; no FK in range |
| prompt_version | TEXT | NOT NULL | PK part |
| judge_model_id | TEXT | NOT NULL | PK part |
| evidence_signature | TEXT | NOT NULL | PK part |
| wave_version | TEXT | NOT NULL DEFAULT 'v0.36.1.0' | |
| graded_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| verdict | TEXT | NOT NULL | CHECK in (correct, incorrect, partial, unresolvable) |
| confidence | REAL | NOT NULL | |
| applied | BOOLEAN | NOT NULL DEFAULT false | |
| cost_usd | NUMERIC(10,4) | NULL | |

Constraints: PK (`take_id`, `prompt_version`, `judge_model_id`, `evidence_signature`).
Indexes: `take_grade_cache_applied_idx` (1741) btree (`take_id`, `applied`); `take_grade_cache_wave_idx` (1743) btree (`wave_version`, `graded_at DESC`).
Readers/writers: `core/cycle/grade-takes.ts` (3), `core/calibration/undo-wave.ts` (3), `core/engine-sql/takes.ts` (1), `commands/takes.ts`, `core/forecast-journal.ts`, `commands/doctor/checks/calibration.ts`, `core/cycle/phase-table.ts`. Migration v070. RLS: in DO list.

#### take_nudge_log (schema.sql:1749-1770)
Purpose: E7 nudge cooldown state. A nudge targets either a take or a pending proposal, never both (CDX-5).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NOT NULL | FK `sources(id)` ON DELETE CASCADE |
| take_id | BIGINT | NULL | |
| proposal_id | BIGINT | NULL | FK `take_proposals(id)` ON DELETE CASCADE |
| nudge_pattern | TEXT | NOT NULL | |
| fired_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| channel | TEXT | NOT NULL DEFAULT 'stderr' | |
| wave_version | TEXT | NOT NULL DEFAULT 'v0.36.1.0' | |

Constraints: `take_nudge_log_target_xor` CHECK ((`take_id` IS NOT NULL) <> (`proposal_id` IS NOT NULL)).
Indexes: `take_nudge_log_take_cooldown_idx` (1761) partial btree (`take_id`, `nudge_pattern`, `fired_at DESC`) WHERE `take_id IS NOT NULL`; `take_nudge_log_proposal_cooldown_idx` (1764) partial btree (`proposal_id`, `nudge_pattern`, `fired_at DESC`) WHERE `proposal_id IS NOT NULL`; `take_nudge_log_wave_idx` (1767) btree (`wave_version`, `fired_at DESC`).
Readers/writers: `core/calibration/undo-wave.ts` (2), `core/calibration/templates.ts`. Migration v071. RLS: in DO list.

#### think_ab_results (schema.sql:1772-1786)
Purpose: A/B harness rows for `think` (baseline vs with-calibration answers).

| Column | Type | Null / default | Notes |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NOT NULL | FK `sources(id)` ON DELETE CASCADE |
| wave_version | TEXT | NOT NULL DEFAULT 'v0.36.1.0' | |
| ran_at | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| question | TEXT | NOT NULL | |
| baseline_answer | TEXT | NOT NULL | |
| with_calibration_answer | TEXT | NOT NULL | |
| preferred | TEXT | NOT NULL | CHECK in (baseline, with_calibration, neither, tie) |
| model_id | TEXT | NULL | |
| notes | TEXT | NULL | |

Indexes: `think_ab_results_recent_idx` (1784) btree (`source_id`, `ran_at DESC`).
Readers/writers: `core/calibration/think-ab.ts` (2). Migration v073. RLS: not in DO list at 1834-1865 (grep did not list it there).

---

### Row-Level Security coverage in range (schema.sql:1834-1865)

RLS is enabled (conditionally, only when the role has BYPASSRLS or superuser; comment at 1829-1833 says a role without it would be locked out) on these 35 tables. No policies are created here.

`pages`, `content_chunks`, `links`, `wanted_links`, `tags`, `raw_data`, `timeline_entries`, `page_versions`, `ingest_log`, `config`, `files`, `minion_jobs`, `sources`, `file_migration_ledger`, `access_tokens`, `mcp_request_log`, `minion_inbox`, `minion_attachments`, `subagent_messages`, `subagent_tool_executions`, `subagent_rate_leases`, `gbrain_cycle_locks`, `dream_verdicts`, `eval_candidates`, `eval_capture_failures`, `eval_takes_quality_runs`, `eval_contradictions_cache`, `eval_contradictions_runs`, `calibration_profiles`, `take_proposals`, `take_grade_cache`, `take_nudge_log`, `oauth_clients`, `oauth_tokens`, `oauth_codes`.

Not in the DO list (RLS not enabled by this block): `page_retrievals`, `code_edges_chunk`, `code_edges_symbol`, `op_checkpoints`, `op_checkpoint_paths`, `context_volunteer_events`, `retrieval_events`, `retrieval_event_pages`, `retrieval_event_links`, `retrieval_feedback`, `retrieval_weights`, `session_context_state`, `extract_atoms_transcript_state`, `chat_usage_log`, `open_loops`, `loop_suppressions`, `fact_withdrawals`, `oauth_grant_audit`, `migration_impact_log`, `think_ab_results`. Comments at 1034-1035 say `session_context_state` (v126), `extract_atoms_transcript_state` and `chat_usage_log` (v140) get RLS from the v35 `auto_rls_on_create_table` event trigger, which is outside this range. The later backfill is `core/schema-migrations/v275-rls-backfill-unguarded-tables.ts`.

---

### Handoff notes for part 2

- Part 2 begins at schema.sql:1899 with `page_write_guards` and continues to the end of the file (out of scope here).
- Out-of-range ALTERs on tables covered above: `page_versions.source_path` (about schema.sql:1966); `sources.upstream_checked_at`, `upstream_commit`, `upstream_behind` (about schema.sql:3559-3561).
- Comments reference out-of-range objects: the `auto_rls_on_create_table` event trigger (v35), the facts index and withdrawal trigger (migrations 60 and 148, comment at 826), and `page_write_guards`.

### Verification notes

- Object counts were derived by `rg` over lines 1-1898 (56 `CREATE TABLE`, 114 `CREATE [UNIQUE] INDEX`, 8 `CREATE OR REPLACE FUNCTION`, 7 `CREATE TRIGGER`, 1 `CREATE SEQUENCE`, 3 extensions, 0 views, 0 policies, 0 grants, 0 `COMMENT ON`).
- Reader and writer lists are from SQL-keyword pattern counts (`FROM|INTO|UPDATE|JOIN|TABLE|ON <table>`) across `src/`, excluding `schema-migrations/` and the `*.generated.ts` copies. Counts are approximate and the lists show the main files, not every call site.
- Not checked: whether `src/core/pglite-schema.generated.ts` and `src/core/schema-embedded.generated.ts` match this file line for line. The `*.generated.ts` copies were excluded from reader and writer counts.
- Not checked: the migration ordinal order of migration-added columns in `core/migrate.ts`. The Rust fresh-install column order is taken from the comments in the schema.

### Parity risks noted

1. **Global generation clock is a sequence.** `page_generation_clock_seq` is advanced by `nextval` in a statement trigger on every INSERT, UPDATE or DELETE on `pages` (schema.sql:267-278). Its `setval` seed uses GREATEST over its own `last_value`, the legacy table and `MAX(pages.generation)` (260-265), so replays never move it backward. An embedded store needs a persisted, monotonic counter that never regresses across restarts, and it must bump once per statement rather than per row.
2. **Per-row generation rule.** `bump_page_generation_fn` (182-205) sets `generation = MAX+1` on insert and bumps only when a specific column allow-list changes (IS DISTINCT FROM). Any Rust port must reproduce the allow-list exactly, or query-cache invalidation will be wrong.
3. **Search vector depends on another table, updated only on page write.** `update_page_search_vector` (1196-1228) reads `timeline_entries` inside the trigger, but the trigger fires only on `pages` UPDATE OF title, timeline. A timeline_entries change does not refresh `pages.search_vector` until the page is written. Caps are 65536 and 32768 characters.
4. **Full-text uses Postgres `to_tsvector('english')`, `setweight`, `||` and GIN.** `gbrain_fts_input` (432-436) inserts spaces at CJK/ASCII boundaries before tokenizing. Stemming and stop words are Postgres-specific; ranking parity needs a test. `ts_filter(tsvector, '{a}')` (1187) is a Postgres built-in (PG 14+) with no repo definition.
5. **Chunk-grain FTS vs page-grain FTS.** `content_chunks.search_vector` (weights A/B) is the one `searchKeyword()` queries. `pages.search_vector` deliberately excludes `compiled_truth` because of the 1MB tsvector cap (comment near 1190-1194, #2704).
6. **pgvector HNSW.** `vector(1536)` on `embedding` with `vector_cosine_ops` (408); partial HNSW on `embedding_image` `vector(1024)` (414-415). `embedding_multimodal vector(1024)` (no index in range). Dimensions are enforced per column; a Rust ANN index must do the same and handle partial coverage.
7. **Trigram indexes.** `gin_trgm_ops` on `pages.title` (282) and `pages.slug` (286) back fuzzy entity lookup. Needs an equivalent fuzzy-match path.
8. **`NULLS NOT DISTINCT` unique constraint on `links`** (PG15+, 579-583): NULL `link_source` and NULL `origin_page_id` collide as equal. Rust must treat NULLs as equal for this dedup key.
9. **Expression-keyed unique indexes.** `timeline_entries` dedup on `md5(summary)` (670) and `take_proposals` idempotency on `md5(claim_text)` (1714). The `ON CONFLICT` inference depends on these exact expressions, and the note says the md5 exists to avoid the btree row-size cap (#3737).
10. **JSONB partial and expression indexes.** `config->>'github_repo'` WHERE `config ? 'github_repo'` (88-90); `payload->>'type'` WHERE `= 'child_done'` (1333); `completed_keys->0->>'page_id'` WHERE `op='sync-hold'` (892-893). Also `jsonb_typeof(completed_keys)='array'` (885-886) and `gbrain_try_jsonb` (64-72) swallowing `data_exception`.
11. **Regex CHECK in the database.** `links.link_source` uses `~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'` plus `char_length <= 64` (line 560). Rust must enforce the same predicate in code.
12. **ON DELETE semantics differ by table.** CASCADE on most child tables (pages children, chunks, code edges, sub-agent tables); SET NULL on `files.page_id`, `links.origin_page_id`, `migration_impact_log.job_id`, `minion_jobs.parent_job_id`, `minion_jobs.private_queue_owner_job_id`; RESTRICT on `oauth_clients.source_id` (line 777). Source deletion and purge flows rely on these, so an embedded store must reproduce them or move them into code.
13. **Deliberate FK omissions.** `page_retrievals` has no FK (comment 300-307) and is cleaned by a statement trigger with a transition table (`REFERENCING OLD TABLE`, 331-334). `retrieval_*`, `context_volunteer_events`, `session_context_state`, `extract_atoms_transcript_state`, `ingest_log`, `open_loops.fact_id` and several `source_id` columns have no FK. Rust should keep this exact set, not add FKs.
14. **Minion queue protocol enforced by trigger.** `enforce_minion_queue_protocol` (1789-1807) raises on protocol violations: an insert with NULL `submission_authority` or non-zero `claim_generation`, a claim without `claim_generation = OLD+1`, and spend-authorized claims from old workers. Claim atomicity and rejection of old workers must be reproduced in Rust code.
15. **`pg_notify` on job changes.** `minion_job_notify` (1813-1825) is Postgres-only (comment at 1812 says not PGLite). Rust needs an in-process or polling equivalent for supervisor wake-ups.
16. **Lease with UUID token and TTL.** `gbrain_cycle_locks` (1516-1532) avoids session advisory locks for PgBouncer transaction pooling. An embedded store has no pooler, but must keep the TTL and token semantics (`last_refreshed_at`, `acquisition_token`).
17. **RLS is a Postgres security layer.** The DO block (1834-1865) enables RLS on 35 tables with no policies, conditionally on BYPASSRLS/superuser. The trigger guards (317-330, 1202-1212) raise `writer_coordinator_required` when RLS state is unreadable. Rust has no RLS; it needs an equivalent access check or an explicit decision to drop it.
18. **Serial and bigserial ids cross the boundary.** Most tables use `SERIAL` (int4) ids. `links`, `content_chunks`, `retrieval_events` (TEXT id, not serial), `eval_*` and `minion_jobs` ids are referenced by other tables and by exports. Rust must keep compatible id types and sequences for migration and export.
19. **Defaults that call the database.** `now()` / `NOW()` for timestamps, `gen_random_uuid()` for `access_tokens.id`, `sources.incarnation`, `pages.knowledge_revision` and `gbrain_cycle_locks.acquisition_token`, and `now() + interval '30 days'` for `dream_verdicts.expires_at`. Rust must generate these in code with the same semantics.
20. **`knowledge_revision` NOT NULL is conditional.** The DO block (1880-1891) sets NOT NULL only when `pages` is empty. Existing rows may be NULL. Rust fresh-install and upgraded brains must accept both.
21. **Float width mismatch.** Many scores use `REAL` (float4) while `context_volunteer_events.confidence`, `dream_verdicts.score` and `chat_usage_log.cost_usd` use `DOUBLE PRECISION`. `NUMERIC(10,2)` budgets and `NUMERIC(10,4)` costs elsewhere. Rounding parity must be tested per column.
22. **`eval_candidates.query` length CHECK** (1546): `length(query) <= 51200` counts characters in Postgres. A Rust byte-length check would differ for multi-byte text.
23. **Array columns and GIN.** `TEXT[]` and `INTEGER[]` (scopes, slugs, `federated_read`, `active_bias_tags`, `parent_symbol_path`) with GIN on `oauth_clients.federated_read` (808) and `calibration_profiles.active_bias_tags` (1682). Array containment semantics must be reproduced.
24. **Migration-added columns not in the fresh DDL.** About 20 columns across `pages`, `content_chunks`, `page_versions`, `minion_jobs` are declared only in comments or by migrations (see the top-level table). A Rust fresh-install must declare them with the same ordinals, or upgraded and fresh brains will disagree.
25. **Trigger-driven writes that the engine must not duplicate.** The generation bump and `search_vector` are triggers, so the engine writes only the content columns. A Rust port must do these in the write path, and must do them within the same transaction.
26. **Dropped trigger cleanup.** `trg_timeline_search_vector` and `update_page_search_vector_from_timeline()` are dropped (1242-1243), and the code comments warn against double-weighting timeline text. Rust must not reintroduce the timeline_entries weighting.
27. **Soft-delete and purge windows are app-enforced.** `pages.deleted_at` (purge after 72h, 292-296), `sources.archive_expires_at`, `dream_verdicts.expires_at` (30 days), `eval_contradictions_cache.expires_at`, `context_volunteer_events` (90-day prune, comment at 913), `op_checkpoints` (7-day GC). No DB-side job; the Rust port must replicate the sweeps.


---

## Tables and objects, part 2 (schema.sql lines 1899-3794)

Scope: `src/schema.sql` lines 1899-3794 (end of file). Line numbers below are `schema.sql` lines. Readers and writers come from a grep of `src/` (TS, excluding `*.generated.ts` and tests) for `FROM|JOIN` (readers) and `INSERT INTO|UPDATE|DELETE FROM|ON CONFLICT` (writers). Each entry lists the first few matching files, not every call site. Treat the lists as a map to start from, not an exhaustive census.

Column notation: `NN` = NOT NULL, `D=` = default, `PK` = primary key, `FK->` = foreign key, `CK` = CHECK constraint, `UQ` = unique.

### Generated regions in this range

The file marks generated regions with `-- BEGIN GENERATED from <module> (<CONST>)` and `-- END GENERATED ...`. `scripts/build-schema.ts` (lines 1-40 and the import block) rewrites these regions from the TS fragment modules. Edit the module, then run `bun run build:schema`. Hand-written text goes outside the markers.

| schema.sql lines | Source module (constant) | Objects in region |
|---|---|---|
| 1866-1962 | `src/core/page-state/schema.ts` (`PAGE_STATE_SCHEMA_SQL`) | table `page_write_guards` (1899), functions `gbrain_advance_page_revision` (1904), `gbrain_advance_tag_revision` (1937), triggers `pages_knowledge_revision` (1934), `tags_knowledge_revision` (1959) |
| 2160-2246 | `src/core/page-body/schema.ts` (`PAGE_BODY_SCHEMA_SQL`) | sequence `page_body_occurrence_id_seq`, tables `page_segment_texts`, `page_body_manifest`, `page_body_stagings`, `page_body_staging_parts`, `page_body_staging_texts` |
| 2249-2383 | `src/core/page-body/schema.ts` (`PAGE_SEGMENT_DERIVATIONS_SQL`) | tables `page_segment_derivations`, `page_derivation_spend`, `page_segment_derivation_purges`, `page_segment_derivation_purge_pages`; functions `gbrain_mark_derivation_scope_entry`, `gbrain_refuse_purging_derivation`; triggers on `page_body_manifest` and `pages` |
| 2385-2398 | `src/core/page-body/schema.ts` (`PAGE_BODY_RLS_SQL`) | `DO $rls$` block enabling RLS on the page-body tables |
| 2401-2640 | `src/core/persistence/schema.ts` (`PERSISTENCE_SCHEMA_STATEMENTS`) | tables `persistence_brain`, `persistence_worktrees`, `persistence_source_bindings`, `persistence_host_bindings`, `persistence_local_writers`, `persistence_counters`, `persistence_requests`, `persistence_effects`, `persistence_consumers`; function `gbrain_require_managed_writer`; `DO $body$` attaching trigger `managed_writer_guard` to 10 tables |
| 2642-2680 | `src/core/persistence/git-canonical-schema.ts` (`GIT_CANONICAL_SCHEMA_SQL`) | table `git_canonical_brain`, function `gbrain_count_git_canonical_sources`, 3 triggers on `sources`, `DO $rls$` |
| 2682-2767 | `src/core/page-state/projection-schema.ts` (`PAGE_PROJECTION_SCHEMA_SQL`) | table `page_projection_jobs`, function `gbrain_queue_page_projection`, triggers `trg_pages_search_vector` (a DO block picks the column list), `pages_projection_queue` |
| 2770-2792 | `src/core/persistence/topology-schema.ts` (`PERSISTENCE_TOPOLOGY_SCHEMA_SQL`) | table `persistence_topology_changes` (plus an ALTER ADD COLUMN) |
| 2794-2817 | `src/core/persistence/worktree-refresh-schema.ts` (`WORKTREE_REFRESH_SCHEMA_SQL`) | table `persistence_worktree_refreshes` |
| 2819-2851 | `src/core/company-brain/receipt-schema.ts` (`SOURCE_INGESTION_RECEIPTS_SCHEMA_SQL`) | table `source_ingestion_receipts` (plus an ALTER ADD COLUMN) |
| 2853-3098 | `src/core/shared-skills/schema-all.ts` (`SHARED_SKILLS_SCHEMA_SQL`) | tables `shared_skill_state`, `shared_skill_policies`, `shared_skill_packs`, `shared_skill_policy_audit`, `shared_skill_heads`, `shared_skill_revisions`, `shared_skill_revision_leases`, `shared_skill_members`, `shared_skill_delivery_batches`, `persistence_writer_protocols`; ALTERs on `persistence_brain` and `persistence_requests`; functions `gbrain_require_persistence_protocol`, `gbrain_guard_request_protocol`, `gbrain_guard_effect_protocol`, `gbrain_guard_protocol_activation`, `gbrain_guard_skill_publication`, `gbrain_lease_shared_skill_delivery`; `DO $$` RLS block |
| 3101-3294 | `src/core/ai/decide/schema.ts` (`DECIDE_SCHEMA_SQL`) | tables `decision_receipts`, `decide_spend`, `decide_state`, `decide_calibrations`, `decide_proposals`, `decide_sweep_deferred`, `decide_review_queue`, `decide_review_proposals` |
| 3297-3316 | `src/core/facts/relink-schema.ts` (`FACT_RELINK_SCHEMA_SQL`) | table `fact_relink_attempts` |
| 3319-3400 | `src/core/link-temporal-schema.ts` (`LINK_TEMPORAL_SCHEMA_SQL`) | tables `link_transitions`, `link_relationships`, `link_edge_proposals`; sequence `graph_generation_seq` |
| 3403-3422 | `src/core/core-memory-schema.ts` (`CORE_EDIT_NOTICES_SCHEMA_SQL`) | table `core_edit_notices` |
| 3425-3497 | `src/core/facts/purge-schema.ts` (`MEMORY_PURGE_SCHEMA_SQL`) | tables `fact_purges`, `take_purges`, `page_purges`, `derivation_inputs`, `needs_rederive` |
| 3499-3502 | `src/core/facts/purge-schema.ts` (`FACT_PURGE_LOOKUP_INDEX_SQL`) | two indexes on `fact_purges` |
| 3505-3553 | `src/core/write-gate-schema.ts` (`WRITE_GATE_SCHEMA_SQL`) | tables `write_gate_receipts`, `write_gate_holds` |
| 3564-3626 | `src/core/questions/schema.ts` (`PINNED_QUESTIONS_SCHEMA_SQL`) | tables `pinned_questions`, `question_evidence` |
| 3629-3728 | `src/core/belief/schema.ts` (`BELIEF_LEDGER_SCHEMA_SQL`) | tables `belief_events`, `belief_page_lifetimes`, `belief_commit_marks`, `belief_retier_manifest`, `belief_redactions` |
| 3780-3794 | `src/core/function-search-path.ts` (`FUNCTION_SEARCH_PATH_HARDENING_SQL`) | `DO $harden$` that runs `ALTER FUNCTION ... SET search_path` on about 60 named `gbrain_*` and trigger functions |

Hand-written (outside any marker) in this range: lines 1966-2158 (`ALTER page_versions`, `extract_atoms_page_state`, `derived_generation*` tables, `page_embedding_budget`, `chronicle_*`, `dream_synthesis_completions`, `page_extraction_state`, `page_view_digests`); lines 3559-3561 (`ALTER sources` upstream columns); lines 3730-3777 (`sync_wanted_markers`, `sync_notifier_leases`, `sync_notifier_sources`). The ordering comments say that the `page-state` region must come before the `persistence` region, and that the `search_path` hardening DO block must run last (3779).

---

### Page state and revision guards

#### page_write_guards
Source: `schema.sql:1899` (generated, `page-state/schema.ts`). Presence row that serializes page-key writes per source incarnation, used by the write-lock helpers.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_incarnation | UUID | NN | FK -> `sources(incarnation)` ON DELETE CASCADE; PK part |
| slug | TEXT | NN | PK part |

- Indexes: PK `(source_incarnation, slug)`.
- Readers: `src/core/page-state/guards.ts` (`SELECT ... FOR UPDATE OF g`, joined to `sources`).
- Writers: `src/core/page-state/guards.ts` (`INSERT ... ON CONFLICT DO NOTHING`, line 46, 64, 75).

#### Objects in the page-state region (generated)
- Function `gbrain_advance_page_revision()` (1904-1933, trigger fn, plpgsql). On `pages` update, sets `knowledge_revision` to a new `gen_random_uuid()` when identity columns change (`source_id, slug, type, page_kind, title, compiled_truth, timeline, frontmatter, deleted_at`, or `body_generation` moves). It also clears `text_projection_revision`. A `gbrain.materializing_revision` GUC can suppress the bump.
- Trigger `pages_knowledge_revision` BEFORE UPDATE ON `pages` (1934-1936).
- Function `gbrain_advance_tag_revision()` (1937-1958). On `tags` insert/update/delete, it bumps `pages.knowledge_revision` for the affected page. Before that, it checks RLS: if `row_security_active('pages')` and the role lacks a permissive policy for `r` and `w`, it raises `writer_coordinator_required`.
- Trigger `tags_knowledge_revision` AFTER INSERT OR DELETE OR UPDATE ON `tags` (1959-1961).

---

### Derived state, extraction and budgets (hand-written)

#### page_versions (ALTER only)
Source: `schema.sql:1966`. `ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS source_path TEXT` (#5393, migration v182). The table itself is defined earlier in the file. Stores the canonical file path recorded when a version was taken.

#### extract_atoms_page_state
Source: `schema.sql:1967-1981`. Per-(source incarnation, page, content hash) fail counter and tombstone for the atom-extraction pipeline. `partial_input_chars` was added by #6503 (v240).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_incarnation | UUID | NN | FK -> `sources(incarnation)` ON DELETE CASCADE; PK |
| page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; PK |
| content_hash | TEXT | NN | PK |
| fail_count | INTEGER | NN, D=0 | CK >= 0 |
| tombstoned | BOOLEAN | NN, D=false | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |
| partial_input_chars | INTEGER | null | cap a cut page was read under (#6503) |

- Indexes: PK `(source_incarnation, page_id, content_hash)`; partial `extract_atoms_page_state_tombstoned_idx (source_incarnation, content_hash, page_id) WHERE tombstoned`; `extract_atoms_page_state_page_idx (page_id)`.
- Readers: `src/core/cycle/extract-atoms.ts`, `src/core/persistence/atom-maintenance.ts`, `src/core/derived-state-maintainers.ts`, `src/core/cycle/extract-atoms-page-state.ts`.
- Writers: `src/core/cycle/extract-atoms-page-state.ts`, `src/core/cycle/extract-atoms-input.ts`, `src/core/persistence/atom-maintenance.ts`, `src/core/derived-state-maintainers.ts`.

#### derived_generations
Source: `schema.sql:1984-2013` (GBRA-161 generation ledger, see `src/core/generations/`). One row per generation of a derived output set for `(source_id, kind, owner_key)`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE |
| kind | TEXT | NN | |
| owner_key | TEXT | NN | |
| generation | INTEGER | NN, D=0 | |
| state | TEXT | NN | CK in (`live`,`held`,`superseded`) |
| run_id | TEXT | null | |
| operation_id | TEXT | NN | |
| hold_id | TEXT | null | |
| input_pin | TEXT | null | |
| input_size | BIGINT | null | |
| completeness | JSONB | NN, D='{}' | |
| item_set_hash | TEXT | NN | |
| held_reason | TEXT | null | CK in (`shrunk`,`oversize`,`valve`,`no_proof`,`fence_absent`,`attempts_exhausted`,`segmented_unsupported`,`tie`) |
| held_context | JSONB | null | |
| proposal | JSONB | null | |
| proposal_bytes | INTEGER | null | |
| attempts | INTEGER | NN, D=0 | |
| superseded_by | BIGINT | null | |
| restore_of | BIGINT | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |
| locator | TEXT | null | |
| activation_id | TEXT | null | |

- Indexes: UNIQUE partial `derived_generations_one_live (source_id, kind, owner_key) WHERE state='live'`; UNIQUE partial `derived_generations_one_hold (...) WHERE state='held'`; `derived_generations_operation (operation_id)`; `derived_generations_state_created (state, created_at)`.
- Readers: `src/core/repair/unwithdrawn-facts.ts`, `src/core/repair/lost-fence-rows.ts`, `src/core/generations/ledger-scrub.ts`, `src/core/generations/fence-restore.ts`.
- Writers: `src/core/generations/publish.ts`, `src/core/generations/fence.ts`, `src/core/generations/ledger-scrub.ts`, `src/core/generations/adapters/fact-rows.ts`.

#### derived_generation_items
Source: `schema.sql:2014-2025`. Per-item action record inside a generation (published, retired, revived, kept, adopted), with a preimage for rollback.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| generation_id | BIGINT | NN | FK -> `derived_generations(id)` ON DELETE CASCADE; PK part |
| item_key | TEXT | NN | PK part |
| identity_hash | TEXT | NN | |
| action | TEXT | NN | CK in (`published`,`retired`,`revived`,`kept`,`adopted`) |
| preimage | JSONB | null | |
| preimage_bytes | INTEGER | null | |
| pending | BOOLEAN | NN, D=false | |

- Indexes: PK `(generation_id, item_key)`; `derived_generation_items_key (item_key)`; partial `derived_generation_items_pending (generation_id) WHERE pending`.
- Readers: `src/core/generations/repair.ts`, `src/core/generations/fence-evidence.ts`, `src/core/repair/unwithdrawn-facts.ts`, `src/core/repair/lost-fence-rows.ts`.
- Writers: `src/core/generations/managed.ts`, `src/core/generations/publish.ts`, `src/core/generations/ledger-scrub.ts`.

#### derived_generation_valve
Source: `schema.sql:2026-2033`. Per-(source, kind, window) retired counter, used as a rate valve.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE; PK part |
| kind | TEXT | NN | PK part |
| window_key | TEXT | NN | PK part |
| retired | INTEGER | NN, D=0 | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: PK `(source_id, kind, window_key)`.
- Readers and writers: `src/core/generations/publish.ts` (both).

#### derived_generation_attempts
Source: `schema.sql:2034-2043`. Attempt counter and reason codes per held generation.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| hold_id | TEXT | PK | |
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE |
| kind | TEXT | NN | |
| owner_key | TEXT | NN | |
| attempts | INTEGER | NN, D=0 | |
| codes | JSONB | NN, D='[]' | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: PK `(hold_id)`; `derived_generation_attempts_key (source_id, kind, owner_key)`.
- Readers and writers: `src/core/generations/publish.ts` (both).

#### derived_generation_activations
Source: `schema.sql:2044-2058`. Pending or activated handoff between an expected generation and the generation row it became.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | TEXT | PK | |
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE |
| kind | TEXT | NN | |
| owner_key | TEXT | NN | |
| expected_generation | INTEGER | NN | |
| input_pin | TEXT | null | |
| item_set_hash | TEXT | NN | |
| state | TEXT | NN | CK in (`pending`,`activated`) |
| generation_id | BIGINT | null | FK -> `derived_generations(id)` ON DELETE SET NULL |
| members | JSONB | NN, D='[]' | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: `derived_generation_activations_key (source_id, kind, owner_key, state)`.
- Readers: `src/core/generations/managed.ts`, `src/core/generations/adapters/atoms.ts`, `src/core/persistence/atom-maintenance.ts`.
- Writers: `src/core/generations/managed.ts`.

#### page_embedding_budget
Source: `schema.sql:2059-2074` (migration v246). Per-page embedding spend ledger. Held pages wait for approval. Capped pages are embedded partially up to `embed.max_usd_per_page`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| page_id | INTEGER | PK | FK -> `pages(id)` ON DELETE CASCADE |
| state | TEXT | NN, D='open' | CK in (`open`,`held`,`capped`) |
| reason | TEXT | null | |
| embedding_signature | TEXT | null | |
| spent_usd | DOUBLE PRECISION | NN, D=0 | CK >= 0 |
| reserved_usd | DOUBLE PRECISION | NN, D=0 | CK >= 0 |
| reserved_at | TIMESTAMPTZ | null | |
| unpriced_calls | INTEGER | NN, D=0 | CK >= 0 |
| cap_usd | DOUBLE PRECISION | null | CK null or >= 0 |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: partial `page_embedding_budget_state_idx (state) WHERE state <> 'open'`.
- Readers: `src/core/held-embedding.ts`, `src/core/page-size-policy.ts`, `src/commands/pages-status.ts`, `src/core/search/retrieval-coverage.ts`.
- Writers: `src/core/page-embedding-budget.ts`, `src/core/transcripts/archive.ts`, `src/core/oversized-backfill.ts`.

#### chronicle_page_state
Source: `schema.sql:2077-2114` (#5876, plus #6199 and #8972 columns). Life Chronicle ledger: one row per page content hash and extractor version, recording the automatic-extraction decision and outcome.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE; PK part |
| page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; PK part |
| content_hash | TEXT | NN | PK part |
| extractor_version | INTEGER | NN | PK part |
| slug | TEXT | NN | |
| state | TEXT | NN | CK in (`pending`,`skipped`,`extracted`,`failed`) |
| reason | TEXT | null | |
| trigger | TEXT | NN | CK in (`auto`,`backfill`) |
| principal_kind | TEXT | null | |
| principal_id | TEXT | null | |
| request_id | UUID | null | |
| no_extract | BOOLEAN | NN, D=false | |
| attempts | INTEGER | NN, D=0 | CK >= 0 |
| next_attempt_at | TIMESTAMPTZ | null | |
| cost_usd | NUMERIC | null | |
| unpriced | BOOLEAN | NN, D=false | |
| event_slugs | TEXT[] | NN, D='{}' | |
| event_hashes | TEXT[] | NN, D='{}' | |
| decided_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |
| campaign_id | TEXT | null | |
| attempt_cap_usd | NUMERIC | null | |
| max_attempts | INTEGER | null | CK > 0 |
| pricing_policy | TEXT | null | |
| campaign_max_usd | NUMERIC | null | |
| cost_attempts | INTEGER[] | NN, D='{}' | |
| judge_input_hash | TEXT | null | |
| judge_window_chars | INTEGER | null | CK >= 0 |
| judge_window_hash | TEXT | null | |
| judge_input_failures | INTEGER | NN, D=0 | CK >= 0 |

- PK: `(source_id, page_id, content_hash, extractor_version)`.
- Indexes: `chronicle_page_state_work_idx (source_id, state, next_attempt_at)`; `chronicle_page_state_page_idx (page_id)`.
- Readers: `src/core/chronicle/ledger.ts`, `src/core/chronicle/ledger-stats.ts`, `src/core/chronicle/campaign.ts`, `src/core/chronicle/execute.ts`.
- Writers: `src/core/chronicle/ledger.ts`, `src/core/chronicle/campaign.ts`, `src/core/chronicle/execute.ts`, `src/core/cycle/chronicle.ts`.

#### chronicle_judge_reservations
Source: `schema.sql:2115-2122`. Reservation log for judge calls, one row per reservation.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| reserved_at | TIMESTAMPTZ | NN, D=now() | |
| source_id | TEXT | NN | no FK |
| page_id | INTEGER | NN | no FK |
| content_hash | TEXT | NN | |

- Indexes: `chronicle_judge_reservations_at_idx (reserved_at)`.
- Readers: `src/core/chronicle/ledger-stats.ts`, `src/core/chronicle/ledger.ts`.
- Writers: `src/core/chronicle/ledger.ts`.

#### dream_synthesis_completions
Source: `schema.sql:2124-2129`. Durable record that a transcript was synthesized. It survives `minion_jobs` pruning.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | PK part; no FK |
| idempotency_key | TEXT | NN | PK part |
| completed_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: PK `(source_id, idempotency_key)`.
- Readers: `src/core/cycle/synthesize-completion.ts`.
- Writers: `src/core/minions/queue.ts`.

#### page_extraction_state
Source: `schema.sql:2132-2143` (v247, Large pages A7). Per-page, per-pipeline extraction watermark and receipt for a partial-input extraction.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; PK part |
| pipeline | TEXT | NN | PK part; CK in (`facts_backstop`,`extract_atoms`,`conversation_facts`) |
| pipeline_version | INTEGER | NN | |
| watermark_bytes | BIGINT | null | CK >= 0 |
| watermark_sha256 | TEXT | null | |
| input_truncated | JSONB | null | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: PK `(page_id, pipeline)`; partial `page_extraction_state_truncated_idx (pipeline, page_id) WHERE input_truncated IS NOT NULL`.
- Readers: `src/core/extraction-watermark.ts`, `src/commands/doctor/checks/extraction-input.ts`.
- Writers: `src/core/extraction-watermark.ts`.

#### page_view_digests
Source: `schema.sql:2146-2156` (v253, Wave B segmented pages). Size and digest of `get_page` views per page revision and audience.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; PK part |
| revision | TEXT | NN | PK part |
| view | TEXT | NN | PK part; CK in (`read`,`markdown`) |
| audience | TEXT | NN | PK part; CK in (`trusted`,`remote`) |
| total_bytes | BIGINT | NN | CK >= 0 |
| total_lines | BIGINT | NN | CK >= 0 |
| sha256 | TEXT | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: PK `(page_id, revision, view, audience)`.
- Readers: `src/core/page-window/segmented.ts`, `src/core/facts/purge.ts`, `src/core/repair/secret-spans.ts`.
- Writers: `src/core/page-window/segmented.ts`, `src/core/repair/secret-spans.ts`, `src/core/facts/purge.ts`.

---

### Segmented page body (generated, `page-body/schema.ts`)

#### page_segment_texts
Source: `schema.sql:2162-2170`. Content-addressed segment text store, keyed by `(source_id, sha256)`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE; PK part |
| sha256 | BYTEA | NN | PK part; CK octet_length = 32 |
| byte_len | INTEGER | NN | CK BETWEEN 1 AND 1048576 |
| line_count | INTEGER | NN | CK >= 0 |
| body | BYTEA | NN | |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: PK `(source_id, sha256)`.
- Readers: `src/core/engine-sql/pages.ts`, `src/core/engine-sql/page-body.ts`, `src/core/facts/withdrawal-discovery.ts`, `src/core/facts/purge.ts`.
- Writers: `src/core/engine-sql/pages.ts`, `src/core/engine-sql/page-body.ts`, `src/core/persistence/page-purge.ts`, `src/core/facts/purge.ts`.

#### page_body_manifest
Source: `schema.sql:2171-2202`. Generation-ranged manifest: each row is a cut of a page body (one segment) valid for `[gen_from, gen_to)`. A staged row carries `staging_id`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; PK part |
| occurrence_id | BIGINT | NN | PK part (from `page_body_occurrence_id_seq`) |
| gen_from | BIGINT | NN | PK part |
| gen_to | BIGINT | null | open when null |
| seq | INTEGER | NN | |
| region | TEXT | NN | CK in (`truth`,`timeline`) |
| source_id | TEXT | NN | FK (composite) -> `page_segment_texts(source_id, sha256)` |
| sha256 | BYTEA | NN | |
| byte_start | BIGINT | NN | |
| byte_len | INTEGER | NN | |
| line_start | BIGINT | NN | |
| line_count | INTEGER | NN | |
| cut_kind | TEXT | NN | CK in (`heading`,`day`,`message`,`blank`,`forced`,`region_end`,`eof`) |
| entry_state | JSONB | NN | |
| protected_regions | JSONB | NN, D='[]' | |
| facts_slots | JSONB | NN, D='[]' | |
| static_proj_bytes | BIGINT | NN | |
| static_proj_lines | INTEGER | NN | |
| outline | JSONB | NN, D='[]' | |
| date_min | DATE | null | |
| date_max | DATE | null | |
| hash_state | BYTEA | NN | |
| staging_id | UUID | null | |
| staging_key | UUID | GENERATED ALWAYS AS (COALESCE(staging_id, nil-uuid)) STORED | used in the PK so NULL staging is comparable |

- PK: `(page_id, occurrence_id, gen_from, staging_key)`.
- Indexes: UNIQUE partial `page_body_manifest_live_seq (page_id, seq) WHERE gen_to IS NULL AND staging_id IS NULL`; partial `page_body_manifest_live_bytes (page_id, byte_start) WHERE gen_to IS NULL`; `page_body_manifest_text (source_id, sha256)`; partial `page_body_manifest_staging (staging_id) WHERE staging_id IS NOT NULL`.
- Readers: `src/core/engine-sql/pages.ts`, `src/core/engine-sql/page-body.ts`, `src/core/sweep.ts`, `src/core/repair/split-facts.ts`.
- Writers: `src/core/engine-sql/page-body.ts`, `src/core/page-body/segment-rewrite.ts`, `src/core/persistence/segmented-apply.ts`.
- Trigger hook: `page_body_manifest_derivation_scope_retire` and `_delete` (see below), plus the managed-writer guard.

#### page_body_stagings
Source: `schema.sql:2203-2229`. Upload or edit staging session: a declared size and sha, parts accumulate, then a commit moves it to the manifest.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | UUID | PK | |
| kind | TEXT | NN | CK in (`upload`,`import`,`sync`,`put`,`append`,`edit`,`resegment`) |
| principal_kind | TEXT | NN | |
| principal_id | TEXT | NN | |
| client_request_id | UUID | NN | UQ with principal |
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE |
| source_incarnation | UUID | NN | no FK |
| slug | TEXT | NN | |
| page_id | INTEGER | null | FK -> `pages(id)` ON DELETE CASCADE |
| mode | TEXT | NN | CK in (`create`,`replace`,`append`) |
| base_revision | UUID | null | |
| base_generation | BIGINT | null | |
| declared_bytes | BIGINT | NN | CK >= 0 |
| declared_sha256 | BYTEA | null | |
| received_bytes | BIGINT | NN, D=0 | |
| next_part | INTEGER | NN, D=0 | |
| reserved_bytes | BIGINT | NN | |
| state | TEXT | NN, D='open' | CK in (`open`,`sealed`,`prepared`,`committed`,`aborted`,`expired`) |
| commit_request_id | UUID | null | |
| idle_expires_at | TIMESTAMPTZ | NN | |
| hard_expires_at | TIMESTAMPTZ | NN | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- UNIQUE `(principal_kind, principal_id, client_request_id)`.
- Indexes: partial `page_body_stagings_expiry (hard_expires_at) WHERE state IN ('open','sealed','prepared')`.
- Readers: `src/core/engine-sql/pages.ts`, `src/core/engine-sql/page-body.ts`, `src/core/page-body/schema.ts`, `src/core/facts/purge.ts`.
- Writers: `src/core/ops/page-upload.ts`, `src/core/engine-sql/pages.ts`, `src/core/engine-sql/page-body.ts`, `src/core/facts/purge.ts`.

#### page_body_staging_parts
Source: `schema.sql:2230-2238`. Byte parts of a staging upload.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| staging_id | UUID | NN | FK -> `page_body_stagings(id)` ON DELETE CASCADE; PK part |
| part_no | INTEGER | NN | PK part; CK >= 0 |
| byte_start | BIGINT | NN | |
| byte_len | INTEGER | NN | CK BETWEEN 1 AND 4194304 |
| sha256 | BYTEA | NN | |
| body | BYTEA | NN | |

- Indexes: PK `(staging_id, part_no)`.
- Readers: `src/core/engine-sql/page-body.ts`, `src/core/persistence/limits.ts`, `src/core/persistence/page-upload.ts`, `src/core/facts/purge.ts`.
- Writers: `src/core/engine-sql/page-body.ts`, `src/core/persistence/page-upload.ts`, `src/core/persistence/limits.ts`, `src/core/facts/purge.ts`.

#### page_body_staging_texts
Source: `schema.sql:2239-2245`. Segment texts that a staging will reference.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| staging_id | UUID | NN | FK -> `page_body_stagings(id)` ON DELETE CASCADE; PK part |
| source_id | TEXT | NN | |
| sha256 | BYTEA | NN | PK part |

- Indexes: PK `(staging_id, sha256)`; `page_body_staging_texts_text (source_id, sha256)`.
- Readers: `src/core/facts/purge.ts`, `src/core/page-body/schema.ts`, `src/core/persistence/page-purge.ts`.
- Writers: `src/core/engine-sql/page-body.ts`.

#### Sequence page_body_occurrence_id_seq
Source: `schema.sql:2161`. Supplies `occurrence_id` for `page_body_manifest`. Readers and writers: `src/core/engine-sql/page-body.ts`.

---

### Segment derivations and purge (generated, `page-body/schema.ts`)

#### page_segment_derivations
Source: `schema.sql:2250-2366`. Per-segment derivation watermark (links, mentions, timeline, fences, conversation_facts, facts_backstop, synopsis). Versions and context hashes decide whether a segment must re-derive.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; PK part |
| pipeline | TEXT | NN | PK part; CK in (`links`,`mentions`,`timeline`,`fences`,`conversation_facts`,`facts_backstop`,`synopsis`) |
| occurrence_id | BIGINT | NN | PK part |
| pipeline_version | INTEGER | NN | CK >= 0 |
| segment_sha256 | BYTEA | NN | CK octet_length = 32 |
| context_hash | BYTEA | NN | CK octet_length = 32 |
| state | TEXT | NN | CK in (`done`,`partial`,`failed`,`skipped`) |
| output | JSONB | null | |
| receipt | JSONB | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- PK: `(page_id, pipeline, occurrence_id)`.
- Indexes: partial `page_segment_derivations_unsettled (pipeline, page_id) WHERE state IN ('partial','failed')`.
- Trigger: `page_segment_derivations_refuse_purging` BEFORE INSERT OR UPDATE OF `output, receipt` (calls `gbrain_refuse_purging_derivation`).
- Readers: `src/core/engine-sql/page-body.ts`, `src/core/facts/purge-verify.ts`, `src/core/page-body/segment-derive.ts`, `src/core/repair/secret-spans.ts`.
- Writers: `src/core/page-body/segment-derive.ts`, `src/core/persistence/segmented-apply.ts`, `src/core/engine-sql/page-body.ts`, `src/core/repair/secret-spans.ts`.

#### page_derivation_spend
Source: `schema.sql:2265-2273`. Spend and reservation per page and family (`facts` or `synopsis`).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; PK part |
| family | TEXT | NN | PK part; CK in (`facts`,`synopsis`) |
| spent_usd | DOUBLE PRECISION | NN, D=0 | CK >= 0 |
| reserved_usd | DOUBLE PRECISION | NN, D=0 | CK >= 0 |
| reserved_at | TIMESTAMPTZ | null | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: PK `(page_id, family)`.
- Readers and writers: `src/core/page-spend.ts`.

#### page_segment_derivation_purges
Source: `schema.sql:2274-2292`. A purge request for derived segment outputs that contain given needles or patterns. It is swept in phases.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| request_id | UUID | PK | |
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE |
| needles | TEXT[] | NN | |
| patterns | TEXT[] | NN | |
| page_ids | INTEGER[] | NN, D='{}' | |
| phase | TEXT | NN, D='sweep' | CK in (`sweep`,`verify`,`recheck`) |
| recheck | INTEGER[] | null | |
| found | INTEGER | NN, D=0 | CK >= 0 |
| cursor_page | INTEGER | null | |
| cursor_pipeline | TEXT | null | |
| cursor_occurrence | BIGINT | null | |
| batch_rows | INTEGER | null | CK >= 1 |
| stalled_at | TIMESTAMPTZ | null | |
| stalled_reason | TEXT | null | CK in (`statement_timeout`,`paid_row_unreadable`) |
| pending_reason | TEXT | null | CK in (`scope_lock_busy`) |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: `page_segment_derivation_purges_source (source_id, created_at)`.
- Readers: `src/core/page-body/segment-derive.ts`, `src/core/page-body/schema.ts`, `src/commands/doctor/checks/derivation-purge-sweeps.ts`.
- Writers: `src/core/page-body/segment-derive.ts`.

#### page_segment_derivation_purge_pages
Source: `schema.sql:2293-2297`. Pages collected for a purge request.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| request_id | UUID | NN | PK part; no FK |
| page_id | INTEGER | NN | PK part; no FK |

- Indexes: PK `(request_id, page_id)`.
- Readers: `src/core/page-body/segment-derive.ts`.
- Writers: `src/core/page-body/segment-derive.ts`, `src/core/page-body/schema.ts` (trigger insert, see below).

#### Functions and triggers in the derivation region
- `gbrain_mark_derivation_scope_entry()` (2298-2335). Trigger fn for `page_body_manifest` (retire and delete) and for `pages` (soft delete). Checks RLS policies on `page_segment_derivation_purges` and `page_segment_derivation_purge_pages`. Takes `pg_advisory_xact_lock_shared(hashtextextended('gbrain:derivation-scope:' || src, 0))`. Then inserts `(request_id, page)` into `page_segment_derivation_purge_pages` for every open purge on that source (`ON CONFLICT DO NOTHING`).
- Triggers: `page_body_manifest_derivation_scope_retire` AFTER UPDATE OF `gen_to` WHEN the old row was open and not staged (2336-2338). `page_body_manifest_derivation_scope_delete` AFTER DELETE WHEN the row was open (2339-2341). `pages_derivation_scope_delete` AFTER UPDATE OF `deleted_at` WHEN the page becomes deleted (2342-2344).
- `gbrain_refuse_purging_derivation()` (2345-2379). BEFORE trigger on `page_segment_derivations`. If the row matches an open purge (by page id, page deletion, or missing live manifest row) and the text of `output` or `receipt` matches a purge pattern (after `lower`, `translate` of Greek final sigma and Turkish dotted i, then `gbrain_fact_normalize`), the trigger suppresses the row (`RETURN NULL`). Otherwise it passes it through. It also checks RLS visibility on `pages` and the purge table, raising `writer_coordinator_required` if unreadable.

---

### Page-body RLS block (generated, `PAGE_BODY_RLS_SQL`)

`DO $rls$` at `schema.sql:2386-2397`. If the current role is a superuser or has `BYPASSRLS` (checked via `pg_roles` and `pg_has_role`), it enables RLS on: `page_segment_texts`, `page_body_manifest`, `page_body_stagings`, `page_body_staging_parts`, `page_view_digests`, `page_body_staging_texts`, `page_segment_derivations`, `page_derivation_spend`, `page_segment_derivation_purges`, `page_segment_derivation_purge_pages`. The block skips tables that are already RLS-enabled.

---

### Persistence and managed writer (generated, `persistence/schema.ts`)

The persistence tables hold the durable write-queue state for the coordinator. The managed-writer trigger (below) makes direct writes to the canonical tables fail unless the session declares its capability through GUCs.

#### persistence_brain
Source: `schema.sql:2402-2408`, altered at 2939-2940. Singleton row for the managed-writer state.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| singleton | INTEGER | PK | CK = 1 |
| brain_id | UUID | NN, D=gen_random_uuid() | |
| enabled | BOOLEAN | NN, D=false | |
| activated_at | TIMESTAMPTZ | null | |
| writer_protocol_floor | INTEGER | NN, D=1 | CK in (1,2) (ALTER, shared-skills region) |
| skill_bundles_enabled | BOOLEAN | NN, D=false | (ALTER, shared-skills region) |

- Seeded with `INSERT ... (1) ON CONFLICT DO NOTHING` at 2408.
- Readers: `src/core/agent-install/shared-skills.ts`, `src/core/health-memo.ts`, `src/core/repair/rotation.ts`, `src/core/repair/agent-session-facts.ts`.
- Writers: `src/core/persistence/activation.ts`, `src/core/persistence/engine-graduation.ts`, `src/core/shared-skills/restore.ts`, `src/eval/brainbench/trust-scenario.ts`.

#### persistence_worktrees
Source: `schema.sql:2409-2418`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | UUID | PK, D=gen_random_uuid() | |
| owner_host_id | UUID | null | |
| owner_epoch | BIGINT | NN, D=0 | |
| topology_generation | BIGINT | NN, D=1 | |
| state | TEXT | NN, D='active' | CK in (`active`,`draining`,`recovering`) |
| manifest | JSONB | null | |
| heartbeat_at | TIMESTAMPTZ | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- Readers: `src/core/notifier/nudge.ts`, `src/core/notifier/resident.ts`, `src/core/repair/content-receipt-root.ts`, `src/core/connectors/item-holds-store.ts`.
- Writers: `src/core/persistence/ownership.ts`, `src/core/persistence/topology-locks.ts`, `src/core/persistence/topology-recovery.ts`, `src/core/shared-skills/restore.ts`.

#### persistence_source_bindings
Source: `schema.sql:2419-2425`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | PK | |
| source_incarnation | UUID | NN | |
| worktree_id | UUID | NN | FK -> `persistence_worktrees(id)` |
| relative_path | TEXT | NN, D='' | |
| topology_generation | BIGINT | NN, D=1 | |

- Readers: `src/core/notifier/nudge.ts`, `src/core/notifier/resident.ts`, `src/core/repair/segmented-mirror.ts`, `src/core/facts/withdrawal.ts`.
- Writers: `src/core/persistence/topology-recovery.ts`, `src/core/persistence/topology-locks.ts`, `src/core/source-delete.ts`, `src/core/shared-skills/restore.ts`.

#### persistence_host_bindings
Source: `schema.sql:2426-2433`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| worktree_id | UUID | NN | FK -> `persistence_worktrees(id)`; PK part |
| host_id | UUID | NN | PK part |
| local_path | TEXT | NN | |
| coordination_path | TEXT | NN | |
| git_durability | TEXT | null | CK in (`enabled`,`disabled`) |

- PK: `(worktree_id, host_id)`.
- Readers: `src/core/notifier/nudge.ts`, `src/core/notifier/resident.ts`, `src/core/repair/content-receipt-root.ts`, `src/core/shared-skills/content-freshness.ts`.
- Writers: `src/core/persistence/git-durability-administration.ts`, `src/core/persistence/ownership.ts`, `src/core/persistence/deactivation.ts`, `src/core/shared-skills/restore.ts`.

#### persistence_local_writers
Source: `schema.sql:2434-2441`. Credential-hash registry for local writer lanes.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | UUID | PK, D=gen_random_uuid() | |
| lane | TEXT | NN | CK in (`cli`,`stdio`) |
| credential_hash | TEXT | NN | UQ |
| grant_ceiling | JSONB | NN | |
| revoked_at | TIMESTAMPTZ | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- Readers: `src/core/ops/persistence.ts`, `src/core/ops/attribution.ts`, `src/core/embed-facts.ts`, `src/core/shared-skills/policy.ts`.
- Writers: `src/core/persistence/identity.ts`, `src/core/shared-skills/restore.ts`.

#### persistence_counters
Source: `schema.sql:2442-2449`. Outstanding-request and byte counters for admission control. One row per key.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| key | TEXT | PK | |
| outstanding_count | BIGINT | NN, D=0 | CK >= 0 |
| intent_bytes | BIGINT | NN, D=0 | CK >= 0 |
| lifetime_ids | BIGINT | NN, D=0 | CK >= 0 |
| terminal_bytes | BIGINT | NN, D=0 | CK >= 0 |
| recovery_bytes | BIGINT | NN, D=0 | CK >= 0 |

- Readers: `src/commands/doctor/checks/persistence-compaction.ts`, `src/commands/doctor/checks/persistence-capacity.ts`, `src/commands/doctor/checks/persistence-requests.ts`, `src/core/repair/core.ts`.
- Writers: `src/core/persistence/journal.ts`, `src/core/persistence/limits.ts`, `src/core/persistence/effect-recovery.ts`, `src/core/persistence/intent-redaction.ts`.

#### persistence_requests
Source: `schema.sql:2450-2488`, with ALTERs at 2941-2942 (shared-skills region). The write-request journal. Each row is one queued, running or finished mutation, with its authority and recovery payload.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | UUID | PK, D=gen_random_uuid() | |
| principal_kind | TEXT | NN | CK in (`oauth_client`,`legacy_token`,`local_cli`,`local_stdio`,`application`) |
| principal_id | TEXT | NN | UQ with principal_kind and request_id |
| request_id | UUID | NN | UQ part |
| operation | TEXT | NN | |
| source_id | TEXT | NN | no FK |
| source_incarnation | UUID | NN | no FK |
| page_id | INTEGER | null | |
| slug | TEXT | NN | |
| worktree_id | UUID | null | FK -> `persistence_worktrees(id)` |
| topology_generation | BIGINT | null | |
| digest | TEXT | NN | |
| intent | JSONB | null | |
| authority | JSONB | NN | |
| sequence | BIGSERIAL | NN, UQ | |
| state | TEXT | NN, D='queued' | CK in (`queued`,`running`,`recovering`,`committed`,`conflict`,`failed`,`cancelled`) |
| execution_token | UUID | null | |
| claim_expires_at | TIMESTAMPTZ | null | |
| recovery | JSONB | null | |
| recovery_bytes | BIGINT | NN, D=0 | |
| intent_bytes | BIGINT | NN | |
| terminal_reservation | BIGINT | NN | |
| outcome | JSONB | null | |
| error_code | TEXT | null | |
| error_message | TEXT | null | |
| blocked_reason | TEXT | null | |
| compacted | BOOLEAN | NN, D=false | |
| publication_started | BOOLEAN | NN, D=false | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |
| completed_at | TIMESTAMPTZ | null | |
| target_kind | TEXT | NN, D='page' | CK in (`page`,`skill_bundle`) (ALTER) |
| protocol_version | INTEGER | NN, D=1 | CK in (1,2) (ALTER) |

- Indexes: partial `persistence_requests_pending (worktree_id, sequence) WHERE state IN ('queued','running','recovering')`; partial `persistence_requests_recovery (worktree_id, sequence) WHERE recovery IS NOT NULL`; `persistence_requests_principal (principal_kind, principal_id, sequence DESC)`.
- Trigger: `gbrain_request_protocol` BEFORE INSERT OR UPDATE OR DELETE (calls `gbrain_guard_request_protocol`).
- Readers: `src/core/ops/persistence.ts`, `src/core/ops/page-upload.ts`, `src/core/ops/attribution.ts`, `src/core/repair/segmented-mirror.ts`.
- Writers: `src/core/persistence/journal.ts`, `src/core/persistence/import-deferral.ts`, `src/core/persistence/transient-retry.ts`, `src/core/shared-skills/restore.ts`.

#### persistence_effects
Source: `schema.sql:2489-2499`. Side-effect rows per request (e.g., a revision or data write), one per `(request_id, kind)`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| request_id | UUID | NN | FK -> `persistence_requests(id)`; UQ part |
| kind | TEXT | NN | UQ part |
| revision | UUID | null | |
| data | JSONB | NN | |
| state | TEXT | NN, D='queued' | CK in (`queued`,`running`,`committed`,`failed`) |
| execution_token | UUID | null | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Trigger: `gbrain_effect_protocol` BEFORE INSERT OR UPDATE OR DELETE (calls `gbrain_guard_effect_protocol`).
- Readers: `src/core/repair/segmented-mirror.ts`, `src/core/repair/receipt-compaction.ts`, `src/core/repair/readers.ts`, `src/core/facts/purge-verify.ts`.
- Writers: `src/core/repair/segmented-mirror.ts`, `src/core/facts/purge-reasons.ts`, `src/core/facts/withdrawal.ts`, `src/core/facts/purge.ts`.

#### persistence_consumers
Source: `schema.sql:2500-2520`. Heartbeat registry of consumer processes.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| host_id | UUID | NN | PK part |
| pid | INTEGER | NN | PK part |
| nonce | TEXT | NN | PK part |
| pid_ns | TEXT | null | |
| kind | TEXT | NN | |
| mode | TEXT | NN | CK in (`probing`,`full`,`waiter_only`,`promoted`) |
| started_at | TIMESTAMPTZ | NN, D=now() | |
| renewed_at | TIMESTAMPTZ | NN, D=now() | |
| restart_required | BOOLEAN | NN, D=false | |
| root_barrier_age_ms | INTEGER | null | |
| pool | JSONB | null | |
| host_json_path | TEXT | NN | |
| persistence_home | TEXT | NN | |
| minted_under | JSONB | null | |
| version | TEXT | NN | |
| boot_id | TEXT | null | |
| process_start | TEXT | null | |
| segment_reader | BOOLEAN | null | |

- PK: `(host_id, pid, nonce)`.
- Readers: `src/core/session-lane.ts`, `src/core/persistence/journal.ts`, `src/core/persistence/writer-versions.ts`, `src/core/persistence/consumer-heartbeat.ts`.
- Writers: `src/core/persistence/consumer-heartbeat.ts`.

#### persistence_topology_changes
Source: `schema.sql:2771-2792` (generated, `persistence/topology-schema.ts`). Topology-change journal (source moves, clones, etc.) with recovery state.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | UUID | PK, D=gen_random_uuid() | |
| principal_id | UUID | NN | UQ with request_id |
| request_id | UUID | NN | UQ part |
| digest | TEXT | NN | |
| operation | TEXT | NN | |
| source_id | TEXT | NN | no FK |
| source_incarnation | UUID | null | |
| worktree_ids | UUID[] | NN, D='{}' | |
| state | TEXT | NN | CK in (`recovering`,`committed`,`failed`) |
| recovery | JSONB | null | |
| recovery_bytes | BIGINT | NN, D=0 | CK >= 0 |
| intent_bytes | BIGINT | NN, D=0 | CK >= 0 (added by ALTER at 2790) |
| terminal_bytes | BIGINT | NN, D=2048 | CK >= 0 |
| outcome | JSONB | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: partial `persistence_topology_recovering (created_at) WHERE state='recovering'`.
- Readers: `src/core/shared-skills/restore.ts`, `src/core/shared-skills/migration-export.ts`, `src/core/source-default-search.ts`, `src/core/persistence/journal.ts`.
- Writers: `src/core/persistence/topology-recovery.ts`, `src/core/persistence/physical-root.ts`, `src/core/persistence/topology-receipts.ts`, `src/core/persistence/topology-clone.ts`.

#### persistence_worktree_refreshes
Source: `schema.sql:2795-2816` (generated, `persistence/worktree-refresh-schema.ts`). Worktree refresh (fetch and merge) state machine.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | UUID | PK, D=gen_random_uuid() | |
| worktree_id | UUID | NN | FK -> `persistence_worktrees(id)` |
| source_ids | TEXT[] | NN | |
| principal_id | UUID | NN | |
| owner_epoch | BIGINT | NN | |
| topology_generation | BIGINT | NN | |
| state | TEXT | NN | CK in (`draining`,`fenced`,`merged`,`syncing`,`completed`,`aborted`,`recovery_required`) |
| old_head | TEXT | NN | |
| target_head | TEXT | NN | |
| upstream_ref | TEXT | NN | |
| preserved_uncommitted | TEXT[] | NN, D='{}' | |
| outcome | JSONB | NN, D='{}' | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |
| completed_at | TIMESTAMPTZ | null | |

- Indexes: UNIQUE partial `persistence_worktree_refreshes_active (worktree_id) WHERE state IN ('draining','fenced','merged','syncing','recovery_required')`; partial `persistence_worktree_refreshes_completed (worktree_id, completed_at DESC) WHERE state='completed'`.
- Readers: `src/core/persistence/journal.ts`, `src/core/persistence/refresh-barrier.ts`, `src/core/persistence/head-blocker.ts`, `src/core/persistence/topology-locks.ts`.
- Writers: `src/core/persistence/worktree-refresh.ts`, `src/core/persistence/journal.ts`, `src/core/schema-migrations/v292-refresh-write-barrier.ts`.

---

### Git canonical (generated, `persistence/git-canonical-schema.ts`)

#### git_canonical_brain
Source: `schema.sql:2643-2646`, with its trigger and RLS block at 2647-2679. Singleton count of `sources` whose `config.canonical = 'git'`. Used to fence writes to git-canonical sources.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| singleton | INTEGER | PK, D=1 | CK = 1 |
| strict_sources | INTEGER | NN, D=0 | CK >= 0 |

- Triggers: `git_canonical_sources_count_insert` AFTER INSERT ON `sources` WHEN the new row is git-canonical; `_update` AFTER UPDATE WHEN the `canonical` value changes; `_delete` AFTER DELETE WHEN the old row is git-canonical. All call `gbrain_count_git_canonical_sources()` (2647-2668). That function raises `writer_coordinator_required` if RLS hides `sources`, then recounts and upserts the singleton.
- Seeded by an `INSERT ... ON CONFLICT` at 2669-2671.
- RLS: `DO $rls$` at 2672-2679 enables RLS when the role bypasses RLS.
- Readers: `src/core/persistence/writer-guard-schema.ts`.
- Writers: `src/core/persistence/git-canonical-schema.ts` (trigger function and seed; the managed-writer trigger reads it).

---

### Managed-writer guard (generated, `persistence/schema.ts`)

#### Function gbrain_require_managed_writer() and trigger managed_writer_guard
- Function at `schema.sql:2522-2627` (plpgsql, `RETURNS trigger`). Reads `persistence_brain.enabled`. If the row is missing, it raises `writer_coordinator_required` (RLS hid it). If the brain is not managed, it passes the write. If managed, it allows the write only when the session has `gbrain.write_sources` (a JSON array of allowed source ids) containing the target source. Source topology changes need `gbrain.topology_change = 'on'`. Git-canonical sources need `gbrain.git_protocol = '1'`. Row-level checks strip the physical-projection columns (`embedding_model`, `embedded_text_hash`, `write_origin`, and write-attribution columns) before comparing rows, so those changes pass.
- Trigger `managed_writer_guard` is attached by the `DO $body$` at 2629-2638 to: `pages`, `tags`, `slug_aliases`, `page_aliases`, `facts`, `takes`, `timeline_entries`, `sources`, `page_segment_texts`, `page_body_manifest`. Each attachment is skipped when the table does not exist.

---

### Page projection (generated, `page-state/projection-schema.ts`)

#### page_projection_jobs
Source: `schema.sql:2689-2696`. Work queue of pages that need a text projection rebuilt, keyed by `(source_incarnation, slug)`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_incarnation | UUID | NN | FK -> `sources(incarnation)` ON DELETE CASCADE; PK part |
| slug | TEXT | NN | PK part |
| revision | UUID | NN | |
| reason | TEXT | NN | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- PK: `(source_incarnation, slug)`.
- Readers: `src/core/page-body/projection.ts`, `src/core/search/retrieval-coverage.ts`, `src/core/persistence/consumer.ts`, `src/core/page-state/projection-status.ts`.
- Writers: `src/core/page-body/projection.ts`, `src/core/page-state/projections.ts`, `src/core/schema-migrations/v189-pages-credential-projection-pending.ts`, plus the trigger function below.

#### Objects in the projection region
- `gbrain_queue_page_projection()` (2697-2763). Trigger fn for `pages` insert, update, and delete. On delete it removes the page's queued job. On a source change or a changed `knowledge_revision` it upserts a job with `reason = 'canonical_change'` (`ON CONFLICT (source_incarnation, slug) DO UPDATE`). When the page is deleted or its text projection is already current, it removes the job instead.
- Trigger `pages_projection_queue` AFTER INSERT OR UPDATE OR DELETE ON `pages` (2764-2766).
- Trigger `trg_pages_search_vector` (2683-2688): dropped and recreated as `BEFORE INSERT OR UPDATE OF <cols> ON pages` calling `update_page_search_vector()`. The column list is `title,timeline,timeline_lead` if the `timeline_lead` column exists, else `title,timeline`. `update_page_search_vector` is defined outside this range.

---

### Source ingestion receipts (generated, `company-brain/receipt-schema.ts`)

#### source_ingestion_receipts
Source: `schema.sql:2820-2850`. Receipt for one ingestion run of a source at an approved revision. Phase goes ADMITTED to COMPLETE. An outcome is `complete` or `discarded`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | UUID | PK | |
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE |
| source_incarnation | UUID | NN | FK -> `sources(incarnation)` ON DELETE CASCADE |
| approved_revision | TEXT | NN | CK regex 40 or 64 lowercase hex |
| profile | TEXT | NN | CK length 1-128 |
| schema_fingerprint | TEXT | NN | CK regex 64 lowercase hex |
| extractor_version | TEXT | NN | CK length 1-128 |
| revision | INTEGER | NN, D=1 | CK > 0 |
| phase | TEXT | NN, D='ADMITTED' | CK in (`ADMITTED`,`CONTENT`,`GRAPH`,`VERIFY`,`COMPLETE`) |
| outcome | TEXT | NN, D='incomplete' | CK in (`incomplete`,`complete`,`discarded`) |
| counts | JSONB | NN, D='{}' | CK object and <= 4096 bytes |
| lifecycle_request_ids | UUID[] | NN, D='{}' | CK cardinality <= 128 |
| checkpoint_refs | JSONB | NN, D='[]' | CK array, <= 32 items, <= 16384 bytes |
| diagnostic | TEXT | null | CK in (`interrupted`,`content_incomplete`,`graph_incomplete`,`verification_failed`,`pending_writes`,`source_changed`,`checkpoint_missing`,`operation_failed`) |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |
| completed_at | TIMESTAMPTZ | null | |
| discarded_at | TIMESTAMPTZ | null | |
| policy_fingerprint | TEXT | null | CK regex 64 lowercase hex (ALTER at 2843) |

- Table CHECKs: `(phase='COMPLETE') = (outcome='complete')`; `(completed_at IS NOT NULL) = (outcome='complete')`; `(discarded_at IS NOT NULL) = (outcome='discarded')`.
- Indexes: `source_ingestion_receipts_source (source_id, source_incarnation, created_at DESC)`; partial `source_ingestion_receipts_retention (source_id, source_incarnation, completed_at DESC, id DESC) WHERE outcome='complete'`; partial `source_ingestion_receipts_active (id) WHERE outcome='incomplete'`.
- Readers: `src/core/shared-skills/content-freshness.ts`, `src/core/sync-dispatch-read.ts`, `src/core/persistence/page-mutations.ts`, `src/core/company-brain/receipts.ts`.
- Writers: `src/core/company-brain/receipts.ts`.

---

### Shared skills (generated, `shared-skills/schema-all.ts`)

#### shared_skill_state
Source: `schema.sql:2854-2859`. Singleton with a token secret and a serving epoch.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| singleton | INTEGER | PK | CK = 1 |
| token_secret | TEXT | NN, D=two `gen_random_uuid()` values with dashes removed (64 hex chars) | |
| serving_epoch | UUID | NN, D=gen_random_uuid() | |

- Seeded by `INSERT ... (1) ON CONFLICT DO NOTHING` (2859).
- Readers: `src/core/shared-skills/retention.ts`, `src/core/shared-skills/membership-authority.ts`, `src/core/shared-skills/catalog.ts`.
- Writers: `src/core/shared-skills/schema.ts`, `src/core/shared-skills/restore.ts`.

#### shared_skill_policies
Source: `schema.sql:2860-2865`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | PK part |
| source_incarnation | UUID | NN | PK part |
| epoch | UUID | NN, D=gen_random_uuid() | |
| policy | JSONB | NN | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- PK: `(source_id, source_incarnation)`.
- Readers: `src/core/shared-skills/setup.ts`, `src/core/shared-skills/policy.ts`, `src/core/shared-skills/restore.ts`, `src/core/shared-skills/catalog.ts`.
- Writers: `src/core/shared-skills/policy.ts`, `src/core/shared-skills/restore.ts`.

#### shared_skill_packs
Source: `schema.sql:2866-2871`. One pack per source incarnation.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | PK part |
| source_incarnation | UUID | NN | PK part |
| pack_id | TEXT | NN | UQ with source |
| revision | UUID | NN | |
| manifest | JSONB | NN | |
| manifest_hash | TEXT | NN | |

- PK `(source_id, source_incarnation)`; UQ `(source_id, source_incarnation, pack_id)`.
- Trigger: `gbrain_skill_publication` (see below).
- Readers: `src/core/shared-skills/publication.ts`, `src/core/shared-skills/compatibility.ts`, `src/core/shared-skills/adopted-packs.ts`, `src/core/shared-skills/migration.ts`.
- Writers: `src/core/shared-skills/publication.ts`.

#### shared_skill_policy_audit
Source: `schema.sql:2872-2879`. Append-only audit of policy epoch changes.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | UUID | PK, D=gen_random_uuid() | |
| source_id | TEXT | NN | |
| source_incarnation | UUID | NN | |
| principal_kind | TEXT | NN | |
| principal_id | TEXT | NN | |
| previous_epoch | TEXT | NN | |
| epoch | UUID | NN | |
| policy | JSONB | NN | |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: `shared_skill_policy_audit_source_idx (source_id, source_incarnation, created_at)`.
- Readers: none in `src/` TS outside the generated files (only inventory lists: `src/core/deletion-inventory.ts`, `src/core/persistence/graduation-inventory.ts`).
- Writers: `src/core/shared-skills/policy.ts`.

#### shared_skill_heads
Source: `schema.sql:2878-2895`, lines 2878-2883 for the table. Current head per skill name.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | PK part |
| source_incarnation | UUID | NN | PK part |
| pack_id | TEXT | NN | PK part |
| name | TEXT | NN | PK part |
| revision | UUID | NN | |
| metadata | JSONB | NN | |
| deleted | BOOLEAN | NN, D=false | |
| policy_epoch | TEXT | NN | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(source_id, source_incarnation, pack_id, name)`.
- Indexes: partial `shared_skill_heads_active_idx (source_id, source_incarnation, pack_id, name) WHERE NOT deleted`.
- Trigger: `gbrain_skill_publication`.
- Readers: `src/core/shared-skills/publication.ts`, `src/core/shared-skills/retention.ts`, `src/core/shared-skills/adopted-packs.ts`, `src/core/shared-skills/migration.ts`.
- Writers: `src/core/shared-skills/publication.ts`.

#### shared_skill_revisions
Source: `schema.sql:2884-2895`. Immutable revision of a skill. `stored_bytes` is computed.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | PK part |
| source_incarnation | UUID | NN | PK part |
| pack_id | TEXT | NN | PK part |
| name | TEXT | NN | PK part |
| revision | UUID | NN | PK part |
| metadata | JSONB | NN | |
| files | JSONB | NN | |
| deleted | BOOLEAN | NN, D=false | |
| policy_epoch | TEXT | NN | |
| request_id | UUID | NN | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| stored_bytes | BIGINT | GENERATED ALWAYS AS (octet_length(files::text) + octet_length(metadata::text)) STORED | |

- PK `(source_id, source_incarnation, pack_id, name, revision)`.
- Indexes: `shared_skill_revision_request_idx (request_id)`; `shared_skill_revision_retention_idx (source_id, source_incarnation, name, created_at DESC)`; `shared_skill_revision_uuid_idx (revision)`.
- Trigger: `gbrain_skill_publication`.
- Readers: `src/core/shared-skills/optimizer.ts`, `src/core/shared-skills/publication.ts`, `src/core/shared-skills/retention.ts`, `src/core/shared-skills/migration.ts`.
- Writers: `src/core/shared-skills/publication.ts`, `src/core/shared-skills/retention.ts`.

#### shared_skill_revision_leases
Source: `schema.sql:2896-2907`. Lease that pins a revision (`delivery` or `pin`) so retention does not delete it.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| lease_kind | TEXT | NN | PK part; CK in (`delivery`,`pin`) |
| lease_id | UUID | NN | PK part |
| source_id | TEXT | NN | PK part; FK (composite) -> `shared_skill_revisions(...)` ON DELETE RESTRICT |
| source_incarnation | UUID | NN | PK part |
| pack_id | TEXT | NN | PK part |
| name | TEXT | NN | PK part |
| revision | UUID | NN | PK part |
| principal_kind | TEXT | NN | |
| principal_id | TEXT | NN | |
| expires_at | TIMESTAMPTZ | NN | |

- Indexes: `shared_skill_revision_lease_expiry_idx (source_id, source_incarnation, expires_at)`; `shared_skill_revision_lease_target_idx (source_id, source_incarnation, pack_id, name, revision, expires_at)`.
- Trigger: `shared_skill_delivery_lease` on `shared_skill_delivery_batches` calls `gbrain_lease_shared_skill_delivery()` and inserts or extends delivery leases (24-hour TTL).
- Readers: `src/core/shared-skills/retention.ts`.
- Writers: `src/core/shared-skills/retention.ts`, `src/core/shared-skills/restore.ts`, `src/core/shared-skills/schema.ts`, and the lease trigger.

#### shared_skill_members
Source: `schema.sql:2906-2924`. Member installation registry (one per principal and adapter).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| installation_id | UUID | PK | |
| principal_kind | TEXT | NN | UQ part |
| principal_id | TEXT | NN | UQ part |
| adapter | TEXT | NN | UQ part |
| brain_id | UUID | NN | |
| epoch | BIGINT | NN, D=1 | |
| active | BOOLEAN | NN, D=true | |
| follow_policy | JSONB | NN | |
| issued_sequence | BIGINT | NN, D=0 | |
| acknowledged_sequence | BIGINT | NN, D=0 | |
| desired_view | TEXT | null | |
| acknowledged_view | TEXT | null | |
| joined_at | TIMESTAMPTZ | NN, D=now() | |
| last_seen_at | TIMESTAMPTZ | NN, D=now() | |
| join_window | TIMESTAMPTZ | NN, D=now() | |
| join_count | INTEGER | NN, D=1 | |

- UNIQUE `(principal_kind, principal_id, adapter)`.
- Readers: `src/core/shared-skills/migration-members.ts`, `src/core/shared-skills/membership.ts`, `src/core/skillpack/shared-brain-bridge.ts`, `src/core/bootstrap/harness-skills.ts`.
- Writers: `src/core/shared-skills/membership.ts`, `src/core/shared-skills/restore.ts`.

#### shared_skill_delivery_batches
Source: `schema.sql:2925-2940`. One issued delivery batch per member (token, epoch, sequence).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| token | UUID | PK | |
| installation_id | UUID | NN | FK -> `shared_skill_members(installation_id)` ON DELETE CASCADE; UQ part |
| epoch | BIGINT | NN | UQ part |
| sequence | BIGINT | NN | UQ part |
| view_token | TEXT | NN | |
| authority_digest | TEXT | NN | |
| revisions | JSONB | NN | |
| issued_at | TIMESTAMPTZ | NN, D=now() | |
| acknowledged_at | TIMESTAMPTZ | null | |
| evidence | JSONB | null | |

- UQ `(installation_id, epoch, sequence)`; index `shared_skill_delivery_member_idx (installation_id, epoch, issued_at)`.
- Trigger: `shared_skill_delivery_lease` AFTER INSERT OR UPDATE OF `revisions`.
- Readers: `src/core/shared-skills/membership.ts`, `src/core/shared-skills/migration-members.ts`.
- Writers: `src/core/shared-skills/membership.ts`.

#### persistence_writer_protocols
Source: `schema.sql:2943-2950`. Registers which owner hosts speak writer protocol 2.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| worktree_id | UUID | NN | FK -> `persistence_worktrees(id)`; PK part |
| host_id | UUID | NN | PK part |
| owner_epoch | BIGINT | NN | |
| protocol_version | INTEGER | NN | CK = 2 |
| registered_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(worktree_id, host_id)`.
- Readers: `src/core/shared-skills/restore.ts`, `src/core/shared-skills/persistence-schema.ts`, `src/core/persistence/protocol.ts`, `src/core/persistence/deactivation.ts`.
- Writers: `src/core/shared-skills/restore.ts`, `src/core/persistence/skill-activation.ts`.

#### Functions and triggers in the shared-skills region
- `gbrain_require_persistence_protocol(required int)` (2951-2956). Raises `writer_upgrade_required` (SQLSTATE 42501) unless `gbrain.persistence_protocol = '2'` when `required >= 2`.
- `gbrain_guard_request_protocol()` (2957-2995), trigger fn for `persistence_requests` (2996-2998). It checks the floor from `persistence_brain`, requires protocol 2 for `skill_bundle` targets, checks that the target kind and version are immutable, requires `put_skill`, `delete_skill` and `adopt_skillpack` operations to use a skill target, and validates the recovery JSON shape.
- `gbrain_guard_effect_protocol()` (2999-3010), trigger fn for `persistence_effects` (3008-3010).
- `gbrain_guard_protocol_activation()` (3011-3034), BEFORE UPDATE trigger on `persistence_brain` (3035-3037). Blocks lowering the floor. Raising the floor or enabling skill bundles requires quiesced writers (`gbrain.writer_quiesced`), no queued or running requests, no unreleased recovery, and drained owners.
- `gbrain_guard_skill_publication()` (3038-3054). Trigger fn on `shared_skill_packs`, `shared_skill_heads`, `shared_skill_revisions` (3055-3063). Requires an enabled brain with `skill_bundles_enabled` and floor 2, and `gbrain.write_sources` to include the row's source.
- `gbrain_lease_shared_skill_delivery()` (3064-3081). Trigger fn for the delivery-lease trigger (3082-3084). Validates each delivery revision is retained, takes `FOR KEY SHARE`, and upserts a lease with a 24-hour expiry.
- `DO $$` at 3085-3097: if the role bypasses RLS or is superuser, enables RLS on the 10 shared-skill and writer-protocol tables.

---

### Decide storage (generated, `ai/decide/schema.ts`)

#### decision_receipts
Source: `schema.sql:3102-3134`. One receipt per decision call (slot, provider, model, outcome, calibration reference).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| decision_id | TEXT | NN | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| source_id | TEXT | null | |
| slot | TEXT | NN | |
| mode | TEXT | NN | |
| provider | TEXT | NN | |
| model_alias | TEXT | null | |
| model_resolved | TEXT | null | |
| question_kind | TEXT | null | |
| state_hash | TEXT | null | |
| question_hash | TEXT | null | |
| answer_value | REAL | null | |
| answer_choice | TEXT | null | |
| confidence | REAL | null | |
| threshold | REAL | null | |
| outcome | TEXT | NN | |
| subject_ref | TEXT | null | |
| call_site | TEXT | NN | |
| lane | TEXT | NN | |
| policy_fingerprint | TEXT | null | |
| calibration_ref | TEXT | null | |
| latency_ms | INTEGER | null | |
| input_tokens | INTEGER | null | |
| error_reason | TEXT | null | |
| protected | BOOLEAN | NN, D=false | |
| min_keep | INTEGER | null | |
| rank | INTEGER | null | |
| k_used | INTEGER | null | |
| remote | BOOLEAN | NN, D=false | |
| run_meta | TEXT | null | |

- Indexes: `decision_receipts_slot_created_idx (slot, created_at)`; `decision_receipts_model_slot_idx (model_resolved, slot)`; `decision_receipts_decision_idx (decision_id)`.
- Readers: `src/core/ai/decide/proposals-store.ts`, `src/core/ai/decide/store.ts`, `src/core/ai/decide/review-lane.ts`.
- Writers: `src/core/ai/decide/store.ts`.

#### decide_spend
Source: `schema.sql:3138-3151`. Per-request spend ledger.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| request_id | TEXT | PK | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| source_id | TEXT | null | |
| slot | TEXT | NN | |
| provider | TEXT | NN | |
| model_resolved | TEXT | null | |
| lane | TEXT | NN | |
| remote | BOOLEAN | NN, D=false | |
| input_tokens | INTEGER | NN, D=0 | |
| cost_usd | DOUBLE PRECISION | NN, D=0 | |
| outcome | TEXT | NN | |

- Indexes: `decide_spend_created_idx (created_at)`.
- Readers: `src/eval/decide-eval-flags.ts`, `src/core/ai/decide/store.ts`.
- Writers: `src/core/ai/decide/store.ts`.

#### decide_state
Source: `schema.sql:3152-3156`. Key/value state store.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| key | TEXT | PK | |
| value | TEXT | NN | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Readers and writers: `src/core/ai/decide/store.ts`.

#### decide_calibrations
Source: `schema.sql:3173-3205`. Calibration run per slot and model: threshold, metric, qualification and retest or repack stability.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| slot | TEXT | NN | |
| call_site | TEXT | NN | |
| provider | TEXT | NN | |
| model_resolved | TEXT | NN | |
| threshold | REAL | NN | |
| min_keep | INTEGER | null | |
| metric | TEXT | NN | |
| metric_value | REAL | null | |
| ece | REAL | null | |
| retest_sd | REAL | null | |
| repack_sd | REAL | null | |
| action_precision_lb | REAL | null | |
| qualification | TEXT | null | |
| qualified_at | TIMESTAMPTZ | null | |
| policy_fingerprint | TEXT | null | |
| n | INTEGER | NN | |
| dataset_hash | TEXT | null | |
| split_hash | TEXT | null | |
| calibrate_ids_hash | TEXT | null | |
| calibrate_only | BOOLEAN | NN, D=true | |
| pack_shape | TEXT | NN | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| retired_at | TIMESTAMPTZ | null | |
| notes | TEXT | null | |

- Indexes: `decide_calibrations_lookup_idx (slot, provider, model_resolved, created_at DESC)`.
- Readers and writers: `src/core/ai/decide/store.ts`.

#### decide_proposals
Source: `schema.sql:3207-3250`. Proposed supersede or claim-conflict pairs between two facts, with a pending or decided status.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| source_id | TEXT | NN | |
| sweep_id | TEXT | NN | UQ part |
| pair_index | INTEGER | NN | UQ part |
| new_fact_id | BIGINT | NN | |
| old_fact_id | BIGINT | NN | |
| direction | TEXT | NN, D='new_supersedes_old' | |
| p_supersede | REAL | NN | |
| threshold | REAL | null | |
| proposal_floor | REAL | NN | |
| model_resolved | TEXT | null | |
| status | TEXT | NN, D='pending' | |
| decided_at | TIMESTAMPTZ | null | |
| before_state | TEXT | null | |
| after_state | TEXT | null | |

- UQ `(sweep_id, pair_index)`.
- Indexes: `decide_proposals_status_created_idx (status, created_at)`; UNIQUE partial `decide_proposals_claim_pair_uidx (source_id, LEAST(new,old), GREATEST(new,old)) WHERE sweep_id LIKE 'claim_conflicts:%'`; partial `decide_proposals_pending_new_idx (new_fact_id) WHERE status='pending'`; partial `decide_proposals_pending_old_idx (old_fact_id) WHERE status='pending'`.
- Readers: `src/core/facts/claim-conflicts.ts`, `src/core/facts/purge-verify.ts`, `src/core/facts/contested-claims.ts`, `src/core/facts/purge.ts`.
- Writers: `src/core/ai/decide/proposals-store.ts`, `src/core/facts/purge.ts`, `src/core/persistence/page-purge.ts`.

#### decide_sweep_deferred
Source: `schema.sql:3227-3236`. Deferred sweep work per fact.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | PK part |
| fact_id | BIGINT | NN | PK part |
| slot | TEXT | NN | PK part |
| reason | TEXT | NN | |
| attempts | INTEGER | NN, D=0 | |
| next_attempt_at | TIMESTAMPTZ | NN, D=now() | |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(slot, source_id, fact_id)`.
- Readers and writers: `src/core/ai/decide/proposals-store.ts`.

#### decide_review_queue
Source: `schema.sql:3252-3263`. Queue of pairs waiting for review.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| kind | TEXT | NN | PK part |
| source_id | TEXT | NN | PK part |
| a_ref | TEXT | NN | PK part |
| b_ref | TEXT | NN, D='*' | PK part |
| evidence | TEXT | null | |
| reason | TEXT | NN, D='queued' | |
| attempts | INTEGER | NN, D=0 | |
| next_attempt_at | TIMESTAMPTZ | NN, D=now() | |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(kind, source_id, a_ref, b_ref)`.
- Readers: `src/core/facts/purge.ts`, `src/core/ai/decide/review-lane.ts`, `src/core/persistence/page-purge.ts`.
- Writers: `src/core/ai/decide/review-lane.ts`, `src/core/facts/purge.ts`, `src/core/facts/withdrawal.ts`, `src/core/persistence/page-purge.ts`.

#### decide_review_proposals
Source: `schema.sql:3264-3282`. Review-lane proposal with an action probability.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| kind | TEXT | NN | UQ part |
| source_id | TEXT | NN | UQ part |
| sweep_id | TEXT | NN | |
| a_ref | TEXT | NN | UQ part |
| b_ref | TEXT | NN | UQ part |
| subject | TEXT | NN, D='*' | UQ part |
| visibility | TEXT | null | |
| p_action | REAL | NN | |
| threshold | REAL | null | |
| model_resolved | TEXT | null | |
| question_version | TEXT | null | |
| status | TEXT | NN, D='pending' | |
| decided_at | TIMESTAMPTZ | null | |
| receipt | TEXT | null | |

- UQ `(kind, source_id, a_ref, b_ref, subject)`; index `decide_review_proposals_status_idx (status, created_at)`.
- Readers: `src/core/facts/purge.ts`, `src/core/ai/decide/review-lane.ts`, `src/core/persistence/page-purge.ts`.
- Writers: `src/core/ai/decide/review-lane.ts`, `src/core/persistence/page-purge.ts`, `src/core/facts/purge.ts`.

#### RLS in the decide region
Each of `decision_receipts`, `decide_spend`, `decide_state`, `decide_calibrations`, `decide_proposals`, `decide_sweep_deferred`, `decide_review_queue`, `decide_review_proposals` gets its own `DO $rls$` block (3157-3293). The block enables RLS when the role bypasses RLS or is a superuser.

---

### Fact relink (generated, `facts/relink-schema.ts`)

#### fact_relink_attempts
Source: `schema.sql:3298-3315`. One attempt per fact to relink it to a page.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | PK part |
| fact_id | BIGINT | NN | PK part |
| outcome | TEXT | NN | |
| reason | TEXT | null | |
| tier | TEXT | null | |
| model | TEXT | null | |
| target_slug | TEXT | null | |
| run_id | TEXT | null | |
| attempted_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(source_id, fact_id)`; index `fact_relink_attempts_outcome_idx (source_id, outcome, attempted_at)`.
- Readers: `src/core/facts/relink.ts`, `src/core/facts/conversation-memo.ts`, `src/commands/doctor/checks/unlinked-facts.ts`.
- Writers: `src/core/facts/relink.ts`, `src/core/facts/conversation-relink.ts`, `src/core/facts/conversation-memo.ts`, `src/core/facts/relink-publish.ts`.

---

### Link temporal (generated, `link-temporal-schema.ts`)

#### link_transitions
Source: `schema.sql:3320-3343`. Dated start or end transition for a typed link (`from_page`, `to_page`, `link_type`).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NN | |
| from_page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE |
| to_page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE |
| link_type | TEXT | NN | |
| kind | TEXT | NN | CK in (`start`,`end`) |
| occurred_on | DATE | NN | |
| date_precision | TEXT | NN, D='day' | CK in (`day`,`month`,`year`) |
| producer | TEXT | NN | CK in (`timeline`,`explicit`,`frontmatter`,`manual`,`inline`,`dream`) |
| origin_page_id | INTEGER | null | FK -> `pages(id)` ON DELETE CASCADE |
| line_hash | TEXT | NN, D='' | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| link_source | TEXT | null | |

- Indexes: UNIQUE `link_transitions_identity_idx (origin_page_id, from_page_id, to_page_id, link_type, link_source, kind, occurred_on, producer) NULLS NOT DISTINCT`; `link_transitions_relationship_idx (from_page_id, to_page_id, link_type)`; `link_transitions_origin_idx (origin_page_id)`.
- RLS: `DO $rls$` at 3339-3343.
- Readers: `src/core/link-relationship-notes.ts`, `src/core/cycle/edge-contradictions.ts`, `src/commands/migrate-engine.ts`, `src/core/link-temporal-apply.ts`.
- Writers: `src/core/link-temporal-apply.ts`, `src/core/persistence/manual-links.ts`, `src/core/persistence/twin-merge.ts`, `src/core/links-fence-projection.ts`.

#### link_relationships
Source: `schema.sql:3344-3371`. Derived state per (from, to, link_type, scope): validity ranges and status.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| from_page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; PK part |
| to_page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; PK part |
| link_type | TEXT | NN | PK part |
| scope | TEXT | NN | PK part; CK in (`all`,`world`) |
| source_id | TEXT | NN | |
| semantics | TEXT | NN | CK in (`state`,`event`) |
| valid_ranges | DATEMULTIRANGE | NN | |
| status_now | TEXT | NN | CK in (`live`,`ended`,`ended_unknown_date`,`not_started`,`disputed`,`event`) |
| first_start | DATE | null | |
| last_start | DATE | null | |
| last_end | DATE | null | |
| undated_present | INTEGER | NN, D=0 | |
| undated_past | INTEGER | NN, D=0 | |
| disputed | BOOLEAN | NN, D=false | |
| recorded_at | TIMESTAMPTZ | NN, D=now() | |
| retired_at | TIMESTAMPTZ | null | |
| evidence_hash | TEXT | NN | |
| refreshed_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: `link_relationships_to_idx (to_page_id, link_type, scope)`; `link_relationships_source_idx (source_id, status_now)`.
- RLS: `DO $rls$` at 3367-3371.
- Readers: `src/core/mentions/referrers.ts`, `src/core/ops/valid-time-read.ts`, `src/core/cycle/edge-contradictions.ts`, `src/core/link-temporal-apply.ts`.
- Writers: `src/core/link-relationships.ts`.

#### link_edge_proposals
Source: `schema.sql:3372-3398`. Proposed typed edge with status and cost, one per (from, a_to, b_to, link_type, evidence_hash).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NN | |
| from_page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; UQ part |
| a_to_page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; UQ part |
| b_to_page_id | INTEGER | NN | FK -> `pages(id)` ON DELETE CASCADE; UQ part |
| link_type | TEXT | NN | UQ part |
| evidence_hash | TEXT | NN | UQ part |
| status | TEXT | NN | CK in (`proposed`,`applied`,`rejected`,`undone`,`stale`,`reverted_by_user`,`undated_unresolved`,`ambiguous_same_date`,`compatible`,`error`) |
| ending_to_page_id | INTEGER | null | FK -> `pages(id)` ON DELETE SET NULL |
| close_date | DATE | null | |
| born_closed | BOOLEAN | NN, D=false | |
| model | TEXT | null | |
| confidence | REAL | null | |
| cost_usd | REAL | null | |
| generated_line | TEXT | null | |
| detail | TEXT | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- UQ `(from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash)`.
- Indexes: `link_edge_proposals_status_idx (source_id, status, created_at)`.
- RLS: `DO $rls$` at 3394-3398.
- Readers: `src/commands/doctor/checks/edge-validity.ts`, `src/commands/edge-proposals.ts`, `src/core/cycle/edge-contradictions.ts`.
- Writers: `src/core/cycle/edge-contradictions.ts`, `src/commands/edge-proposals.ts`.

#### graph_generation_seq
Source: `schema.sql:3399`. Sequence `graph_generation_seq` (`link-temporal-schema.ts:18`, `:96`). Bumped with `SELECT nextval('graph_generation_seq')` in `src/core/link-relationships.ts:164` whenever relationship state changes, so cached graph queries can detect a change. Created by migration v204 (`src/core/schema-migrations/v204-links-temporal-state.ts`).

---

### Core edit notices (generated, `core-memory-schema.ts`)

#### core_edit_notices
Source: `schema.sql:3404-3421`. Remote-edit notice for always-loaded core memory, cleared when acknowledged.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NN | |
| slug | TEXT | NN | |
| page_id | BIGINT | null | |
| revision | TEXT | null | |
| base_revision | TEXT | null | |
| base_text | TEXT | null | |
| actor | TEXT | NN | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| acked_at | TIMESTAMPTZ | null | |

- Indexes: partial `core_edit_notices_pending_idx (source_id, slug, id) WHERE acked_at IS NULL`.
- RLS: `DO $rls$` at 3417-3421.
- Readers: `src/core/core-memory.ts`, `src/core/facts/purge-verify.ts`, `src/commands/core.ts`.
- Writers: `src/commands/core.ts`, `src/core/persistence/core-guard.ts`, `src/core/facts/purge.ts`.

---

### Purge tables (generated, `facts/purge-schema.ts`)

The purge tables record that a fact, take, or page was purged. Their guard triggers are installed by the memory_purge migration (comment at 3424).

#### fact_purges
Source: `schema.sql:3426-3441`. Tombstone for a purged fact, by hash and visibility.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE; PK part |
| visibility | TEXT | NN | PK part; CK in (`private`,`world`) |
| subject | TEXT | NN, D='*' | PK part |
| fact_hash | TEXT | NN | PK part |
| request_id | UUID | null | |
| actor | TEXT | null | |
| reason | TEXT | null | |
| purged_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(source_id, visibility, subject, fact_hash)`.
- Extra indexes (3500-3501): `fact_purges_subject_idx (source_id, subject, fact_hash) INCLUDE (visibility, purged_at)`; partial `fact_purges_all_subjects_idx (source_id, purged_at) WHERE subject = '*'`.
- RLS: `DO $rls$` at 3437-3441.
- Readers: `src/core/search-vector-backfill.ts`, `src/core/facts/purge-overlay.ts`, `src/core/facts/purge-schema.ts`, `src/core/facts/withdrawal.ts`.
- Writers: `src/core/facts/purge.ts`, `src/core/persistence/page-purge.ts`, `src/core/belief/purge-mirror.ts`.

#### take_purges
Source: `schema.sql:3442-3454`. Tombstone for a purged take (claim).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE; PK part |
| subject | TEXT | NN, D='*' | PK part |
| claim_hash | TEXT | NN | PK part |
| request_id | UUID | null | |
| purged_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(source_id, subject, claim_hash)`.
- RLS: `DO $rls$` at 3450-3454.
- Readers: `src/core/facts/purge-overlay.ts`, `src/core/facts/purge-schema.ts`, `src/core/persistence/page-purge.ts`, `src/core/belief/append.ts`.
- Writers: `src/core/facts/purge.ts`, `src/core/belief/purge-mirror.ts`, `src/core/persistence/page-purge.ts`.

#### page_purges
Source: `schema.sql:3455-3467`. Tombstone for a purged page by content hash.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE; PK part |
| content_hash | TEXT | NN | PK part |
| slug | TEXT | NN | |
| request_id | UUID | null | |
| purged_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(source_id, content_hash)`.
- RLS: `DO $rls$` at 3463-3467.
- Readers: `src/core/repair/purged-page-facts.ts`, `src/core/facts/purge-schema.ts`, `src/core/facts/purge-verify.ts`, `src/core/persistence/purged-intent.ts`.
- Writers: `src/core/persistence/page-purge.ts`, `src/core/belief/purge-mirror.ts`.

#### derivation_inputs
Source: `schema.sql:3468-3482`. Lineage: which input rows fed which derived row.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| derived_table | TEXT | NN | PK part |
| derived_id | TEXT | NN | PK part |
| input_table | TEXT | NN | PK part |
| input_id | TEXT | NN | PK part |
| source_id | TEXT | null | FK -> `sources(id)` ON DELETE CASCADE |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(derived_table, derived_id, input_table, input_id)`.
- Indexes: `idx_derivation_inputs_input (input_table, input_id)`.
- RLS: `DO $rls$` at 3478-3482.
- Readers: `src/core/facts/derivation-inputs.ts`, `src/core/facts/purge-verify.ts`, `src/core/trust/propagation.ts`, `src/core/search/transcript-quote.ts`.
- Writers: `src/core/facts/derivation-inputs.ts`.

#### needs_rederive
Source: `schema.sql:3483-3496`. Derived rows that must be recomputed.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| derived_table | TEXT | NN | PK part |
| derived_id | TEXT | NN | PK part |
| source_id | TEXT | null | FK -> `sources(id)` ON DELETE CASCADE |
| request_id | UUID | null | |
| reason | TEXT | NN | |
| marked_at | TIMESTAMPTZ | NN, D=now() | |

- PK `(derived_table, derived_id)`.
- RLS: `DO $rls$` at 3492-3496.
- Readers: `src/core/eligibility/sql.ts`, `src/core/eligibility/explain.ts`.
- Writers: `src/core/facts/derivation-inputs.ts`, `src/core/trust/propagation.ts`.

---

### Write gate (generated, `write-gate-schema.ts`)

#### write_gate_receipts
Source: `schema.sql:3506-3523`. Verdict receipt for a write-gate check on a page, fact, take or timeline entry.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| target_table | TEXT | NN | CK in (`pages`,`facts`,`takes`,`timeline_entries`,`write_gate_holds`) |
| target_id | TEXT | NN | UQ part |
| source_id | TEXT | null | |
| content_hash | TEXT | NN | UQ part |
| tier | TEXT | NN | |
| detector_version | INTEGER | NN | UQ part |
| verdict | TEXT | NN | CK in (`flag`,`quarantine`) |
| reason_families | TEXT[] | NN, D='{}' | |
| reasons | TEXT[] | NN, D='{}' | |
| detector_error | BOOLEAN | NN, D=false | |
| request_id | TEXT | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| last_seen_at | TIMESTAMPTZ | NN, D=now() | |

- UQ `write_gate_receipts_target_idx (target_table, target_id, content_hash, detector_version)`; index `write_gate_receipts_seen_idx (last_seen_at)`.
- RLS: `DO $rls$` at 3547-3552 (with `write_gate_holds`).
- Readers: `src/core/write-gate-store.ts`, `src/core/facts/purge.ts`, `src/core/trust/review.ts`, `src/eval/brainbench/metrics/trust-reads.ts`.
- Writers: `src/core/write-gate-store.ts`, `src/core/facts/purge.ts`, `src/core/persistence/page-purge.ts`, `src/core/persistence/purge-slug-stores.ts`.

#### write_gate_holds
Source: `schema.sql:3524-3552`. Held fact or take awaiting release or drop.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| kind | TEXT | NN | CK in (`fact`,`take`) |
| source_id | TEXT | NN | UQ part |
| slug | TEXT | NN, D='' | UQ part |
| fingerprint | TEXT | NN | UQ part |
| detector_version | INTEGER | NN | UQ part |
| tier | TEXT | NN | |
| reason_families | TEXT[] | NN, D='{}' | |
| reasons | TEXT[] | NN, D='{}' | |
| detector_error | BOOLEAN | NN, D=false | |
| payload | JSONB | NN | |
| write_origin | JSONB | null | |
| request_id | TEXT | null | |
| status | TEXT | NN, D='held' | CK in (`held`,`released`,`dropped`) |
| seen_count | INTEGER | NN, D=1 | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| last_seen_at | TIMESTAMPTZ | NN, D=now() | |
| decided_at | TIMESTAMPTZ | null | |
| decided_by | TEXT | null | |

- Indexes: UNIQUE `write_gate_holds_dedupe_idx (source_id, slug, fingerprint, detector_version)`; `write_gate_holds_status_idx (status, source_id, id)`.
- RLS: as above (3547-3552).
- Readers: `src/core/write-gate-store.ts`, `src/eval/brainbench/metrics/trust-reads.ts`, `src/core/trust/release-publish.ts`, `src/core/trust/owner-actions.ts`.
- Writers: `src/core/write-gate-store.ts`, `src/core/facts/purge.ts`, `src/core/trust/owner-actions.ts`, `src/core/source-delete.ts`.

---

### Sources upstream columns (hand-written, lines 3559-3561)

`ALTER TABLE sources ADD COLUMN IF NOT EXISTS` adds three columns to the `sources` table, which is defined earlier in the file. Columns: `upstream_checked_at TIMESTAMPTZ` (no default), `upstream_commit TEXT`, `upstream_behind INTEGER`. They record the last upstream observation per source (#5255/#5176; migration v190).

- Writers: `src/core/sync-upstream.ts` (line 73, `UPDATE sources SET upstream_checked_at=..., upstream_commit=..., upstream_behind=...`).
- Readers: `src/core/source-health.ts`, `src/core/sync-upstream.ts` (line 103-107), `src/core/deletion-inventory.ts`, `src/commands/doctor/checks/managed-guard.ts`, `src/commands/doctor/checks/extraction-sync.ts`, `src/core/persistence/worktree-refresh.ts`.

---

### Pinned questions (generated, `questions/schema.ts`)

#### pinned_questions
Source: `schema.sql:3565-3599`. A standing question per source and slug, with its answer, refresh lease and watermark (C4).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NN | UQ part |
| slug | TEXT | NN | UQ part |
| question | TEXT | NN | |
| scope_slug_prefix | TEXT | null | |
| scope_entity | TEXT | null | |
| state | TEXT | NN, D='active' | |
| inactive_reason | TEXT | null | |
| publish_mode | TEXT | NN, D='publish' | |
| model | TEXT | null | |
| cooldown_days | REAL | null | |
| origin | TEXT | NN, D='pin' | |
| created_by | TEXT | NN | |
| revision | BIGINT | NN, D=1 | |
| answer_revision | INTEGER | NN, D=0 | |
| answer | TEXT | null | |
| answer_model | TEXT | null | |
| last_refresh_at | TIMESTAMPTZ | null | |
| last_attempt_at | TIMESTAMPTZ | null | |
| last_error | TEXT | null | |
| watermark_generation | BIGINT | null | |
| watermark_fact_id | BIGINT | null | |
| watermark_at | TIMESTAMPTZ | null | |
| lease_token | TEXT | null | |
| lease_owner | TEXT | null | |
| lease_expires_at | TIMESTAMPTZ | null | |
| refresh_attempts | INTEGER | NN, D=0 | |
| spend_usd | DOUBLE PRECISION | NN, D=0 | |
| created_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |
| archived_at | TIMESTAMPTZ | null | |

- UQ constraint `pinned_questions_source_slug_key (source_id, slug)`. No FK to `sources`.
- Indexes: `pinned_questions_state_idx (state, source_id)`.
- RLS: `DO $rls$` at 3617-3619.
- Readers: `src/core/questions/refresh.ts`, `src/core/questions/store.ts`.
- Writers: `src/core/questions/refresh.ts`, `src/core/questions/store.ts`, `src/core/questions/auto-think-migration.ts`.

#### question_evidence
Source: `schema.sql:3600-3625`. Evidence pointers for each sentence of a pinned answer, pinned to an answer revision.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| question_id | BIGINT | NN | no FK |
| answer_revision | INTEGER | NN | |
| sentence_id | TEXT | NN | |
| kind | TEXT | NN | |
| source_id | TEXT | NN | |
| page_id | INTEGER | null | |
| page_slug | TEXT | null | |
| page_generation | BIGINT | null | |
| page_revision | TEXT | null | |
| item_id | BIGINT | null | |
| content_hash | TEXT | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: `question_evidence_question_idx (question_id, answer_revision)`.
- RLS: `DO $rls$` at 3621-3625.
- Readers: `src/core/questions/refresh.ts`, `src/core/questions/freshness.ts`.
- Writers: `src/core/questions/refresh.ts`.

---

### Belief ledger (generated, `belief/schema.ts`)

Append-only audit state. The design is in `docs/designs/BELIEF_LEDGER.md` (comment at 3628).

#### belief_events
Source: `schema.sql:3630-3670`. One row per belief event (page, fact, take, link, link transition, or coverage). Each row carries a hash chain (`prior_hash` to `state_hash`) and a publication id.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| event_key | BYTEA | NN, UQ | |
| source_id | TEXT | NN | |
| source_incarnation | UUID | NN | |
| page_lifetime | UUID | null | |
| slug | TEXT | NN | |
| subject_kind | TEXT | NN | CK in (`page`,`fact`,`take`,`link`,`link_transition`,`coverage`) |
| subject_key | TEXT | NN | |
| event_type | TEXT | NN | |
| origin | TEXT | NN, D='live' | CK in (`live`,`unmanaged`,`baseline`,`backfill`,`reconcile`) |
| trust_tier | TEXT | NN | |
| writer_tier | TEXT | null | |
| tier_basis | TEXT | NN, D='row' | CK in (`row`,`writer`,`unknown`) |
| visibility | TEXT | NN | |
| publication_id | UUID | NN | |
| ord | INTEGER | NN | |
| recorded_at | TIMESTAMPTZ | NN, D=clock_timestamp() | |
| source_time | TIMESTAMPTZ | null | |
| valid_from | TIMESTAMPTZ | null | |
| valid_until | TIMESTAMPTZ | null | |
| value | JSONB | null | |
| value_hash | TEXT | null | |
| prior_hash | TEXT | null | |
| state_hash | TEXT | NN | |
| cause | JSONB | NN | |
| claim_fp | TEXT | null | |
| purged | BOOLEAN | NN, D=false | |
| redacted_fields | TEXT[] | null | |

- Indexes: `belief_events_page (source_id, slug, id)`; `belief_events_subject (source_id, subject_kind, subject_key, id)`; `belief_events_recorded (recorded_at)`; partial `belief_events_claim_fp (source_id, claim_fp) WHERE claim_fp IS NOT NULL`; partial `belief_events_lifetime (page_lifetime, id) WHERE page_lifetime IS NOT NULL`; `belief_events_publication (publication_id)`.
- RLS: `DO $rls$` at 3666-3670.
- Readers: `src/core/ops/known-as-of.ts`, `src/core/facts/purge-verify.ts`, `src/core/forecast-journal.ts`, `src/core/belief/preimages.ts`.
- Writers: `src/core/belief/append.ts`, `src/core/belief/purge.ts`.

#### belief_page_lifetimes
Source: `schema.sql:3671-3686`. A page's lifetime (its identity across renames or recreation), open until `ended_at`.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| page_lifetime | UUID | PK | |
| source_id | TEXT | NN | |
| source_incarnation | UUID | NN | |
| slug | TEXT | NN | |
| page_id | INTEGER | null | no FK |
| started_at | TIMESTAMPTZ | NN, D=clock_timestamp() | |
| ended_at | TIMESTAMPTZ | null | |

- Indexes: UNIQUE partial `belief_page_lifetimes_open (source_incarnation, slug) WHERE ended_at IS NULL`; `belief_page_lifetimes_slug (source_id, slug)`.
- RLS: `DO $rls$` at 3682-3686.
- Readers: `src/core/forecast-journal.ts`, `src/core/belief/preimages.ts`, `src/core/belief/coverage-report.ts`, `src/core/belief/purge.ts`.
- Writers: `src/core/belief/lifetimes.ts`.

#### belief_commit_marks
Source: `schema.sql:3687-3695`. Observed commit time per publication.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| publication_id | UUID | PK | |
| observed_at | TIMESTAMPTZ | NN | |

- RLS: `DO $rls$` at 3691-3695.
- Readers: `src/core/belief/coverage-report.ts`, `src/core/belief/page-at-time.ts`.
- Writers: `src/core/belief/append.ts`.

#### belief_retier_manifest
Source: `schema.sql:3696-3709`. Manifest of tier changes applied by a summary event.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| summary_event | BIGINT | NN | PK part |
| source_id | TEXT | NN | |
| subject_kind | TEXT | NN | PK part |
| subject_key | TEXT | NN | PK part |
| from_tier | TEXT | null | |
| to_tier | TEXT | NN | |

- PK `(summary_event, subject_kind, subject_key)`.
- RLS: `DO $rls$` at 3705-3709.
- Readers and writers: `src/core/belief/retier.ts`.

#### belief_redactions
Source: `schema.sql:3710-3727`. Redacted field per subject, linked to the purge request that redacted it, with an optional release.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| id | BIGSERIAL | PK | |
| source_id | TEXT | NN | |
| subject_key | TEXT | NN | |
| field | TEXT | NN | |
| purge_request | UUID | NN | |
| field_hash | TEXT | NN | |
| released_by | UUID | null | |
| released_hash | TEXT | null | |
| created_at | TIMESTAMPTZ | NN, D=now() | |

- Indexes: `belief_redactions_subject (source_id, subject_key, field)`; `belief_redactions_field_hash (source_id, field_hash)`.
- RLS: `DO $rls$` at 3723-3727.
- Readers and writers: `src/core/belief/append.ts`, `src/core/belief/purge.ts`.

---

### Sync notifier (hand-written, lines 3730-3777)

#### sync_wanted_markers
Source: `schema.sql:3733-3744` (GBRA-133 PR 2a, migration v262). Pending sync request per source and intent (freshness, pull, full).

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | NN | FK -> `sources(id)` ON DELETE CASCADE; PK part |
| intent | TEXT | NN | PK part; CK in (`freshness`,`pull`,`full`) |
| source_incarnation | TEXT | null | stored as TEXT, not UUID |
| wanted_head | TEXT | null | |
| generation | BIGINT | NN, D=1 | |
| first_due_at | TIMESTAMPTZ | NN, D=now() | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |
| requested_by | TEXT | NN | |
| job_id | BIGINT | null | |

- PK `(source_id, intent)`.
- Readers: `src/core/notifier/store.ts`, `src/core/notifier/status.ts`, `src/core/sync-pending.ts`.
- Writers: `src/core/notifier/store.ts`.

#### sync_notifier_leases
Source: `schema.sql:3745-3753`. Per-host lease for the notifier process, with a fence counter.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| host_id | TEXT | PK | |
| owner_id | TEXT | NN | |
| fence | BIGINT | NN, D=1 | |
| resident_kind | TEXT | NN | |
| pid | INTEGER | null | |
| renewed_at | TIMESTAMPTZ | NN, D=now() | |
| expires_at | TIMESTAMPTZ | NN | |

- Readers: `src/core/notifier/store.ts`, `src/core/notifier/status.ts`.
- Writers: `src/core/notifier/store.ts`.

#### sync_notifier_sources
Source: `schema.sql:3754-3777`. Per-source notifier state: due or running or retry, last error, observed head and owner.

| Column | Type | Null / default | Constraints, FK |
|---|---|---|---|
| source_id | TEXT | PK; FK -> `sources(id)` ON DELETE CASCADE | |
| source_incarnation | TEXT | null | stored as TEXT |
| syncer_host_id | TEXT | null | |
| syncer_recorded_at | TIMESTAMPTZ | null | |
| state | TEXT | NN, D='idle' | CK in (`idle`,`due`,`running`,`retry`,`operator_blocked`) |
| reason | TEXT | null | |
| first_due_at | TIMESTAMPTZ | null | |
| attempts | INTEGER | NN, D=0 | |
| next_retry_at | TIMESTAMPTZ | null | |
| last_progress_at | TIMESTAMPTZ | null | |
| last_error_code | TEXT | null | |
| last_error | TEXT | null | |
| last_error_at | TIMESTAMPTZ | null | |
| trace_path | TEXT | null | |
| observed_head | TEXT | null | |
| observed_at | TIMESTAMPTZ | null | |
| detection_mode | TEXT | null | CK in (`watch`,`poll`) |
| owner_host_id | TEXT | null | |
| owner_kind | TEXT | null | |
| owner_pid | INTEGER | null | |
| owner_seen_at | TIMESTAMPTZ | null | |
| updated_at | TIMESTAMPTZ | NN, D=now() | |

- Readers: `src/core/notifier/store.ts`, `src/core/notifier/resident.ts`, `src/core/notifier/status.ts`, `src/core/sync-pending.ts`.
- Writers: `src/core/notifier/store.ts`.

---

### Search-path hardening (generated, `function-search-path.ts`)

`DO $harden$` at `schema.sql:3781-3793` runs last in the file (comment at 3779). For each function in `public` whose `proconfig` search_path is `pg_catalog, public` or `pg_catalog`, and whose name is in a fixed list of about 60 names (`gbrain_*` functions, `auto_enable_rls`, `bump_page_generation_fn`, `enforce_minion_queue_protocol`, `notify_minion_job_change`, `update_page_search_vector`, `update_chunk_search_vector`, and others), it runs `ALTER FUNCTION ... SET search_path = <path>, pg_temp`. The owner check is `pg_has_role(current_user, p.proowner, 'USAGE')`. The block also changes functions defined outside this range.

---

### Other objects in range

- No `GRANT`, `REVOKE` or `COMMENT ON` statements appear in lines 1899-3794 (checked with a line-start grep and by reading the range).
- Sequences: `page_body_occurrence_id_seq` (2161), `graph_generation_seq` (3399).
- Functions (13 in range, all plpgsql, all with `SET search_path = pg_catalog, public, pg_temp`): `gbrain_advance_page_revision`, `gbrain_advance_tag_revision`, `gbrain_mark_derivation_scope_entry`, `gbrain_refuse_purging_derivation`, `gbrain_require_managed_writer`, `gbrain_count_git_canonical_sources`, `gbrain_queue_page_projection`, `gbrain_require_persistence_protocol` (`RETURNS void`, a helper the other guards call), `gbrain_guard_request_protocol`, `gbrain_guard_effect_protocol`, `gbrain_guard_protocol_activation`, `gbrain_guard_skill_publication`, `gbrain_lease_shared_skill_delivery`.
- Distinct trigger names (17): `pages_knowledge_revision`, `tags_knowledge_revision`, `page_body_manifest_derivation_scope_retire`, `page_body_manifest_derivation_scope_delete`, `pages_derivation_scope_delete`, `page_segment_derivations_refuse_purging`, `managed_writer_guard` (10 tables), `git_canonical_sources_count_insert`, `git_canonical_sources_count_update`, `git_canonical_sources_count_delete`, `trg_pages_search_vector`, `pages_projection_queue`, `gbrain_request_protocol`, `gbrain_effect_protocol`, `gbrain_protocol_activation`, `gbrain_skill_publication` (3 tables), `shared_skill_delivery_lease`.
- Session GUCs read by these functions (set by the writer, not by DDL): `gbrain.materializing_revision`, `gbrain.write_sources`, `gbrain.topology_change`, `gbrain.git_protocol`, `gbrain.persistence_protocol`, `gbrain.writer_quiesced`. Grep for their setters is out of scope for this part.

---

### Table count in this range

Tables created in lines 1899-3794: 76 (every `CREATE TABLE` in the range has a section above). Tables altered but not created here: `page_versions`, `sources`. Sequences: 2. Functions: 13 (`CREATE OR REPLACE FUNCTION`). Triggers: 19 `CREATE TRIGGER` statements, 17 distinct names, 28 table attachments (the `managed_writer_guard` DO block attaches 10). `DO` blocks: 32, most of them RLS enablement.

---

### Parity risks noted

1. Session GUC capability model. `gbrain_require_managed_writer`, `gbrain_guard_skill_publication`, `gbrain_guard_protocol_activation` and the persistence protocol functions read `gbrain.write_sources`, `gbrain.topology_change`, `gbrain.git_protocol`, `gbrain.persistence_protocol` and `gbrain.writer_quiesced`. An embedded Rust store needs an equivalent per-connection capability context, or these guards silently disappear.
2. RLS-dependent logic. Several triggers call `row_security_active()` and introspect `pg_policy`, `pg_roles` and `pg_has_role`. Table RLS is enabled only for superuser or BYPASSRLS roles. None of this maps to PGLite or an embedded engine. The "writer state is unreadable to this role" error path has no clear analogue.
3. Trigger cascades that write other tables. Revision bumps (`pages.knowledge_revision` from `tags`), the projection queue (`page_projection_jobs`), derivation-purge fan-out (`page_segment_derivation_purge_pages`), delivery leases (`shared_skill_revision_leases`), and the git-canonical counter (`git_canonical_brain`) all run inside the DB. Each Rust write path must replicate them, or the invariants break.
4. Trigger-side text normalization. `gbrain_refuse_purging_derivation` lowercases text, maps Greek final sigma and Turkish dotted i with `translate`/`replace`, calls `gbrain_fact_normalize()`, pads with spaces, and matches with `LIKE ANY` and `strpos`. Purge matching in Rust must give identical results for these inputs.
5. JSON path semantics. The same trigger walks JSON with `jsonb_path_query(doc, 'strict $.** ? (@.type() == "string")')` and `keyvalue()`. Lease trigger uses the JSONB `?` operator. Rust JSON walking must match these in strict mode and for key/value enumeration.
6. Advisory locks. `pg_advisory_xact_lock_shared(hashtextextended('gbrain:derivation-scope:' || src, 0))` serializes purge fan-out per source. An embedded store needs an equivalent lock per source, with the same shared/exclusive semantics.
7. Clock and randomness defaults. `gen_random_uuid()` (many tables and triggers), `now()` (transaction time) and `clock_timestamp()` (wall clock; `belief_events.recorded_at`, `belief_page_lifetimes.started_at`) differ in meaning. Rust must pick the right one per column.
8. Generated columns in the PK. `page_body_manifest.staging_key` is `COALESCE(staging_id, nil-uuid) STORED` and is part of the PK, so NULL staging ids compare equal. `shared_skill_revisions.stored_bytes` is `octet_length(files::text)+octet_length(metadata::text)`, which depends on JSON text serialization.
9. Null-distinct semantics. `link_transitions_identity_idx` is `UNIQUE ... NULLS NOT DISTINCT` (requires PG 15+). Its `line_hash` defaults to `''`, not NULL. Several partial unique indexes depend on `WHERE` predicates (`derived_generations_one_live`, `belief_page_lifetimes_open`, `persistence_worktree_refreshes_active`, `decide_proposals_claim_pair_uidx` on `LEAST`/`GREATEST`).
10. Numeric types. `REAL` (4-byte) is used for decide probabilities and link confidences; `DOUBLE PRECISION` for spend; `NUMERIC` for chronicle costs. Rounding parity matters for threshold comparisons. `DATEMULTIRANGE` in `link_relationships.valid_ranges` has no direct embedded equivalent.
11. Regex and binary CHECKs. `source_ingestion_receipts` uses POSIX `~` regex on SHA strings; `shared_skill` lease trigger uses `substring(item from '@([^@]+)$')`; several columns use `octet_length(...) = 32` for raw digests (`BYTEA`).
12. Sequences as ordering keys. `persistence_requests.sequence` (BIGSERIAL, UNIQUE) is the queue order; `graph_generation_seq` is bumped by `nextval` to invalidate caches. Gaps and rollback behavior of sequences differ from a monotonic counter.
13. Foreign-key actions and targets. Mixed `ON DELETE CASCADE`, `SET NULL` and `RESTRICT`. `shared_skill_revision_leases` -> `shared_skill_revisions` is a composite FK with `RESTRICT`. Several FKs target `sources(incarnation)`, which needs a UNIQUE constraint defined earlier in the file. Some columns that look like keys have no FK (`belief_page_lifetimes.page_id`, `question_evidence.question_id`, `chronicle_judge_reservations.page_id`).
14. Inconsistent identifier types. `source_incarnation` is UUID in most tables but TEXT in `sync_wanted_markers` and `sync_notifier_sources`. `page_segment_derivation_purges.page_ids` is `INTEGER[]` and cast to `int[]` in triggers. `persistence_brain.brain_id` is UUID, but `shared_skill_delivery_batches.authority_digest` is TEXT.
15. Error contract. Triggers raise `P0001` or `42501` with message prefixes (`writer_coordinator_required:`, `writer_upgrade_required:`, `writer_not_quiesced:`, `git_protocol_required:`, `unsupported_mutation_protocol:`, `revision_unavailable:`) and a JSON `DETAIL` payload. These strings can surface in the CLI and MCP JSON output and must be preserved.
16. Column order is significant. Comments at 1963-1965 and 3558 say `ALTER ADD COLUMN` placement exists so a fresh install has the same ordinal positions as an upgraded brain. Any positional row mapping in Rust must use names, not ordinals.
17. Schema-DDL-as-code. The generated regions come from TS modules and are checked by `scripts/build-schema.ts`. Any Rust port that copies DDL from `schema.sql` must also copy the generated-region edits, or the two sources will drift (the build script exits non-zero on unknown statement kinds).


---

## Migration system and migrations v002-v160

Source: garrytan/gbrain at commit 8bbfd0b5e8 (read-only). Scope: runner, schema blobs, build scripts, and migration files v002-v160 (155 files; there are no files for v017-v019 or v100). Migrations v161-v318 are out of scope and are not covered.

Legend used below: "PG" = Postgres engine, "PGL" = PGLite engine, "tx" = wrapped in `engine.transaction()` by the runner, "NOTX" = `transaction: false`, "handler-only" = `sql` is empty and only a TS `handler` runs.

### (a1) Runner and version tracking

| Item | Where | Facts |
|---|---|---|
| Version key | `config` table, key `version` | Read by `getConfig('version')` (`src/core/migrate.ts:381-382`, `src/core/migrate-pending.ts:44-54`). Written with `setConfig('version', N)` after each migration succeeds (`src/core/migrate.ts:513`). Missing value is treated as `1`. |
| Seed | `src/schema.sql:726` and PGLite template (`scripts/build-schema.ts:426-429`) | Fresh blob inserts `('version','1')`; PGLite also inserts `('engine','pglite')`. Blob also seeds `embedding_model`, `embedding_dimensions`, `chunk_strategy`. |
| Latest | `src/core/migrate.ts:84-88`, `src/core/schema-migrations/latest.generated.ts:7` | `LATEST_VERSION` = max registry version (value `318` in the generated file, outside this part's range). `registeredLatestVersion()` re-reads the live registry. |
| Registry | `src/core/schema-migrations/registry.generated.ts` (639 lines) | Static imports of every `vNNN` export; `MIGRATIONS` array keeps a frozen historical order (`scripts/build-schema-migrations.ts:48-52`). The runner sorts by version before running (`src/core/migrate.ts:389`), so array order has no effect on execution. |
| Pending check | `src/core/migrate-pending.ts:44-54` | `hasPendingMigrations` reads `version` and compares to `LATEST_SCHEMA_VERSION`; on error it returns true. Used by `connectEngine` to skip `initSchema()` when nothing is pending. |
| Main entry | `src/core/migrate.ts:376-378` `runMigrations` -> `runMigrationsLocked` (`:380-542`) | Takes schema lock, re-reads `version`, sorts, runs each pending migration in order. |
| Fresh vs upgrade | `src/core/migrate.ts:485-498` | `freshInstall = current <= 1 && pending = all`. Fresh installs print one summary line; upgrades print each `[N] name`. `GBRAIN_MIGRATE_VERBOSE=1` forces the verbose output. |
| Self-heal passes (run every call, before pending loop) | `src/core/migrate.ts:401-449` | `repairTimelineDedupIndex` (#2038, `timeline-dedup-repair.ts:116`), `repairPagesUpsertArbiter` (#550, `pages-upsert-arbiter.ts:115`: restores UNIQUE(source_id,slug)), `repairLinkSourceCheck` (#4613, only if `current >= 114`, `link-source-check-repair.ts:103`). All best-effort, log to stderr. |
| Function search_path | `src/core/migrate.ts:457-469` | `hardenFunctionSearchPaths` (`function-search-path.ts:100`) puts `pg_temp` back on gbrain functions after any run, and in a `finally` (#7632). |
| Page revision backfill | `src/core/migrate.ts:451`, `:472`, `:540` | `resumePageRevisionBackfill` runs after the migration loop. |
| Pre-flight | `src/core/migrate.ts:133-145`, `:504` | Warns about PG `idle in transaction` sessions older than 5 minutes (`getIdleBlockers`, `:113-127`). |
| Owned-table guard | `src/core/migrate.ts:392` | `assertOwnedTableShapes` runs before any repair or migration (#9190). |

Per-migration execution (`applyOneMigration`, `src/core/migrate.ts:546-618`):

1. SQL choice: `const sql = m.sqlFor?.[engine.kind] ?? m.sql` (`:548`). `??` falls back to `sql` only when the engine key is absent; an explicit `''` (for example `v024` pglite, `v076` pglite) means "run nothing on that engine".
2. Retry wrapper `runMigrationSQLWithRetry` (`:157-207`): up to 3 attempts, backoff 5 s / 15 s / 45 s (`GBRAIN_MIGRATE_BACKOFF_MS` overrides for tests), retries only on statement timeout (57014) or connection-reset errors. Final retryable failure throws `MigrationRetryExhausted` (`:59-76`, `:190-197`). Migration preludes (`runMigrationPrelude`, `:184`) run before each attempt.
3. Execution (`runMigrationSQL`, `:214-244`): `useTransaction = m.transaction !== false`. If true, or the engine is PGLite, it runs inside `engine.transaction`. On PG the transaction first sets `SET LOCAL statement_timeout` (from `migrationStatementTimeoutMs()`) and `SET LOCAL lock_timeout` (`:226-234`, #5227). A PG lock timeout is rethrown as `schemaLockBlockedError` (`:238`). If `transaction: false` on PG, it goes through `runMigrationStatement` (`src/core/schema-migrations/helpers.ts:90-104`): a reserved backend with session `statement_timeout`, restored afterwards.
4. Handler (`:590-592`): runs after the SQL, outside the SQL transaction. A failure after the SQL committed leaves the schema changed but the version not stamped; the next run re-runs the migration.
5. Verify hook (`:598-616`): optional `verify(engine)`. On failure it re-runs an idempotent migration once, else throws `MigrationDriftError` (`:43-52`). No migration in v002-v160 declares `verify` (v091's only match is a comment; v160 uses `handler`).
6. Stamp: `setConfig('version', m.version)` after the migration (`:513`). Timeouts are recorded via `recordMigrationTimeout` (`:521`) and cleared at the end (`:539`).
7. Preludes: `src/core/migration-preludes.ts:233-234` maps version -> batched backfill prelude for `11, 28, 33, 116` (in range) and `161, 221` (out of range). `v011` batches `links.link_source`; `v028` batches `content_chunks` search vectors; `v033` batches `mcp_request_log` agent names; `v116` batches `source_id`. Each batch runs before the migration's SQL.

Lock (`src/core/schema-migration-lock.ts:15-38`):

- Postgres: `engine.holdSchemaMigrationLock` (key 42 in `src/core/postgres-engine/init-schema-lock.ts:29`, `INIT_SCHEMA_LOCK_KEY = 42`), held across processes and connections.
- PGLite (no such method): serialized in-process by a per-engine promise chain (`inProcessSchemaLocks`, `:12`, `:23-32`).
- `assertSchemaMigrationLockHeld()` runs before each migration (`src/core/migrate.ts:507`).
- Nested calls on the same engine reuse the lock through `AsyncLocalStorage` (`:11`, `:16-17`).

Retry on deadlock: `tryRunPendingMigrations` (`src/core/migrate.ts:303-356`) retries `initSchema` once after 250 ms on SQLSTATE 40P01, then polls `hasPendingMigrations` up to 5 s and returns `race_resolved` if another runner finished.

### (a2) initSchema entry points (what replays before migrations)

| Engine | Entry | Sequence |
|---|---|---|
| PGLite | `PGLiteEngine.initSchema` (`src/core/pglite-engine.ts:1147-1180`) | Snapshot short-circuit (`:1150-1152`). Embedding dims/model from settings, else gateway, else stored identity (`:1152-1171`). `withSchemaMigrationLock` -> `assertSchemaNotAhead` (#7776) -> `applyForwardReferenceBootstrap` -> `db.exec(getPGLiteSchema(dims, model))` -> `runMigrations`. |
| Postgres | `PostgresEngine.initSchema` (`src/core/postgres-engine.ts:576-660`) | Uses the DDL pool when dual-pool. Dims/model as PGLite. `withSchemaMigrationLock` -> `assertSchemaNotAhead` -> reserved conn -> `applyForwardReferenceBootstrap(conn)` -> `retrySchemaReplayOnDeadlock(withSchemaLockTimeout(conn.unsafe(getPostgresSchema)))` (`:642`) -> `runMigrations` (`:652`) -> `verifySchema` (`:656`) -> `dropZombieIndexes` sweep of invalid HNSW indexes (`:663-668`). |
| Standalone PG | `src/core/db.ts:596-612` (`initSchema`) | Session `pg_advisory_lock(42)`, `applyPostgresForwardReferenceBootstrap`, `conn.unsafe(SCHEMA_SQL)`, unlock. Does NOT call `runMigrations`. |

### (a3) Forward-reference bootstrap, schema verify, missing tables

- `src/core/engine-sql/bootstrap.ts` (756 lines). Single implementation for both engines. Runs before the blob replay so that older brains gain forward-referenced columns that the blob's `CREATE INDEX`/FK statements need.
  - Probes: `FORWARD_REFERENCE_PROBES` (`:116`), one round trip, e.g. `pages_exists`, `source_id_exists`, `deleted_at_exists`, `links_exists`, `link_source_exists`, `content_chunks`, `search_vector_exists`, `embedding_image_exists`, `mcp_log_exists`, `ingest_log_source_id_exists`, `files_page_id_exists`, `oauth_clients_*_exists`, plus later probes.
  - DDL: `applyCoreTableGaps` (`:394`) and `applyLaterColumnGaps` (`:601`) run `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and a `CREATE TABLE IF NOT EXISTS sources` (`:419`) for the gaps found.
  - Dialects (`:49-68`): `PGLITE_BOOTSTRAP_DIALECT` (probe schema `'public'`, no `dream_verdicts` forward reference, `chunksEmbeddingImageStep: 'after-pages-deleted-at'`) and `POSTGRES_BOOTSTRAP_DIALECT` (`current_schema()`, `dreamVerdictsForwardReference: true`, `'after-subagent-provider-id'`).
  - Pre-DDL guard: `assertOwnedTableShapes` (`:345`, #9190) refuses when a gbrain table name is owned by another application.
- `src/core/schema-verify.ts` (307 lines), Postgres only. `verifySchema` (`:243`) parses `CREATE TABLE` and `ALTER TABLE ADD COLUMN` from `SCHEMA_SQL` (`:16`, imported from `schema-embedded.generated.ts`), diffs with `information_schema.columns` (`getActualColumns`, `:154`), and self-heals with `ALTER TABLE x ADD COLUMN IF NOT EXISTS` (`:282`). `detectMissingColumns` (`:207`) is the read-only variant used by doctor. Called once at the end of PG `initSchema` (`postgres-engine.ts:656`). Rationale in its header (`:4-11`): PgBouncer transaction mode can drop ALTERs silently. PGLite does not call it.
- `src/core/schema-missing-tables.ts` (100 lines). `readMissingTables` (`:87`) checks `to_regclass` for every `GRADUATION_INVENTORY` table that the current version should have (`CREATED_BY` = `query_cache: 55`, `code_traversal_cache: 59`, `:60`). At head it checks all tables; below head only the rebuildable caches. `RECREATE` (`:45-60`) recreates `query_cache` (dims from the live `facts` column) and `code_traversal_cache` by calling the v055/v056/v090/v091/v059 SQL.

### (a4) Schema text pipeline: src/schema.sql -> blobs

Canonical sources: `src/schema.sql` (3794 lines) plus TS "fragment" modules (`scripts/build-schema.ts:82-126`, `FRAGMENTS`), which are spliced into `BEGIN/END GENERATED` regions of schema.sql. Outputs written by `bun run build:schema` (`scripts/build-schema.ts:318-325`, `:645-660`):

| Output | Lines | Produced by | Use |
|---|---|---|---|
| `src/core/schema-embedded.generated.ts` (`SCHEMA_SQL`, Postgres blob) | 3799 | `renderEmbedded` (`scripts/build-schema.ts:319-321`) | `postgres-engine.ts:75`, `db.ts:8`, `schema-verify.ts:16`, doctor schema-function-bodies. |
| `src/core/pglite-schema.generated.ts` (`PGLITE_SCHEMA_SQL_TEMPLATE`, `getPGLiteSchema(dims, model)`) | 3030 | `renderPgliteTemplateSql` (`scripts/build-schema.ts:523`) and `renderPgliteModule` (`:582`), statement-by-statement rules `PGLITE_RULES` (`:398-449`), DO-block classes `PGLITE_DO_BLOCKS` (`:451-453`), additions `PGLITE_ADDITIONS` (`:462-490`) | `src/core/pglite-schema.ts:8` re-exports; `pglite-engine.ts` initSchema. Placeholders `__EMBEDDING_DIMS__` / `__EMBEDDING_MODEL__` replaced at runtime, then `applyChunkEmbeddingIndexPolicy` and `applyFtsLanguagePolicy`. |
| `src/schema.sql` (regenerated regions) | 3794 | `renderSchemaSql` (`:307`) | Canonical text. |

The generator fails (exit 1) on unknown statement kinds, unclassified DO blocks, or stale PGLite rules (`:328`, `:397-411`, `:436-443`), so a schema edit cannot silently diverge the two blobs.

Diff of CREATE object names between the two blobs (computed for this part; name-level only, a few comment-text false positives such as "CREATE INDEX since" are ignored):

- Postgres blob only: `pgcrypto` extension; tables `dream_verdicts`, `code_edges_chunk`, `code_edges_symbol`, `file_migration_ledger`; indexes `dream_verdicts_expires_idx`, `idx_chunks_search_vector`, `idx_chunks_symbol_qualified`, `idx_code_edges_*` (7), `idx_file_migration_ledger_status`, `idx_pages_updated_at_desc`, `pages_generation_idx`; functions `notify_minion_job_change`, `update_chunk_search_vector`; triggers `chunk_search_vector_trigger`, `minion_job_notify`. Also the persistence indexes in `POSTGRES_CONCURRENT_PERSISTENCE_INDEXES` (`src/core/persistence/schema.ts:134-138`, 9 names) are filtered out of the PG blob (`scripts/build-schema.ts:104-107`) and built by migrations with CONCURRENTLY.
- PGLite blob only: view `page_links` (`CREATE OR REPLACE VIEW page_links AS SELECT id, from_page_id, to_page_id FROM links`, `build-schema.ts:466-472`); tables `slug_aliases`, `page_aliases` (`:482-511`) with their indexes; the 9 persistence indexes are created inline.
- Column-level PGLite omissions (from `PGLITE_RULES`): `sources.chunker_version`, `sources.upstream_checked_at/upstream_commit/upstream_behind`; `content_chunks.parent_symbol_path/doc_comment/symbol_name_qualified/search_vector` (`:412-420`); `dream_verdicts` table dropped (`:436-437`); `files.storage_url`, `minion_attachments.content` STORAGE EXTERNAL dropped; `minion_jobs` column order moved (`:441`); `page_links` / `pages_generation_idx` / `idx_pages_updated_at_desc` dropped. PGLite gets these from migrations.
- Removed from PGLite blob by `PGLITE_DO_BLOCKS` (`:452`): the RLS enablement DO block (`146e456b365a`), because PGLite has no role system.
- PGLite `update_page_search_vector` body has comment lines stripped (`:438-440`).

### (a5) Engine-specific ordering in the bootstrap and blobs

- Postgres blob contains `dream_verdicts`; PGLite creates it by migration v030 (`src/core/engine-sql/bootstrap.ts:26` and the dialect constants at `:58-62`).
- Fresh PGLite brains keep master's column order by using migrations for the missing columns (`scripts/build-schema.ts:392`).

### (a6) Build and scaffolding scripts

- `scripts/build-schema.ts` (660 lines): `bun run build:schema`. Evaluates FRAGMENTS, rewrites schema.sql regions, writes the Postgres blob and PGLite template. `--out-dir <dir>` writes elsewhere for a freshness guard (`:645-660`). `buildAll` at `:623`.
- `scripts/build-schema-migrations.ts` (321 lines): `bun run build:schema-migrations`. Scans `src/core/schema-migrations/v<NNN>-<name>.ts`, requires exactly one `export const vNNN: Migration = { version, name, ... }` per file whose version/name match the filename (`:78-107`), no duplicate versions (`:164`). Writes `registry.generated.ts` (static imports in historical order) and `latest.generated.ts` (`renderLatest`, `:220-230`). `--check` exits 1 when stale (`:297`). `bun run new:migration <name>` scaffolds `v<max+1>` (`scaffold`, `:233-260`).
- `src/core/schema-migrations/types.ts:20-61`: `Migration` interface. Fields: `version`, `name`, `sql`, `sqlFor?: {postgres?, pglite?}`, `transaction?` (default true, PG-only effect), `handler?`, `idempotent?` (default true; only the verify path reads it), `verify?`.
- `src/core/schema-migrations/helpers.ts`: `migrationNotice` (`:28`, suppressed on fresh-install replay), `dropInvalidConcurrentIndex` (`:53-73`, PG-only, probes `pg_index.indisvalid`, drops invalid leftovers from a failed CONCURRENTLY build, `to_regclass`-based), `runMigrationStatement` (`:90-104`), `buildIndexOnline` (`:119-156`: PG reserves a connection, runs `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS`, checks validity, then `analyzeAfterIndexBuild`; PGLite runs the plain `CREATE INDEX IF NOT EXISTS`, `:125-132`), `analyzeYieldingToVacuum` (`:172-184`, `lockTableForAnalyze`, 60 s statement cap on PG), `analyzeAfterIndexBuild` (`:196-207`).

### (a7) How PGLite vs Postgres variants are chosen

| Mechanism | Where | Behavior |
|---|---|---|
| `sqlFor.{postgres,pglite}` | `src/core/migrate.ts:548` | Engine-specific SQL overrides `sql`. Used in about 30 migrations in range (see table). |
| Handler branch on `engine.kind` | e.g. `v014`, `v034`, `v039`, `v041`, `v055`, `v066`, `v072`, `v091`, `v096`, `v097`, `v103`, `v104`, `v112`, `v134` | Postgres uses `CREATE INDEX CONCURRENTLY` with an invalid-index pre-drop; PGLite uses plain `CREATE INDEX`. `v023` returns immediately on PGLite (`handler`, `if (engine.kind === 'pglite') return`). |
| `transaction: false` | `src/core/migrate.ts:219-243`, `src/core/schema-migrations/types.ts:31-35` | Postgres only. PGLite always wraps in a transaction (`if (useTransaction || engine.kind === 'pglite')`, `:221`). |
| Postgres-only timeouts | `src/core/migrate.ts:225-234`, `helpers.ts:90-104` | `SET LOCAL statement_timeout`/`lock_timeout` inside a PG transaction; PGLite skips it (non-fatal try/catch). |
| Engine-specific blobs | `postgres-engine.ts:608`, `pglite-engine.ts:1177` | `getPostgresSchema` vs `getPGLiteSchema` with the dims/model resolved from settings or stored identity. |
| Dims-gated HNSW | `src/core/vector-index.ts` (`hnswMaxDimsForType`, `readExistingEmbeddingShape`), used in `v045`, `v055`, `v142`, `v144` | Index created only when dims fit the pgvector cap; `halfvec` used above the cap. |
| Postgres-only feature gates in migrations | `v011` (`server_version_num >= 150000`), `v039` (pgvector >= 0.5 preflight throws), `v024`/`v029`/`v030`/`v031`/`v032`/`v094` (BYPASSRLS guard, `RAISE EXCEPTION` or `WARNING`), `v035` (event trigger), `v120` (`ALTER FUNCTION ... SET search_path`) | Each is inside `DO $$` blocks or `sqlFor.postgres`. |

### (a8) Orchestrated version migrations (src/commands/migrations/)

These are version-upgrade orchestrators run by `gbrain apply-migrations`, not schema DDL. Registry in `src/commands/migrations/index.ts` (imports listed at `:18-37`).

- `index.ts`: TS registry compiled into the binary; `getMigration(version)` (`:62`).
- `types.ts`: `Migration` shape for orchestrators (phases, status, featurePitch, optOut).
- `fresh-install.ts`: stamps a brain created by `gbrain init` as already at the current schema (no replay).
- `in-process.ts`: runs migration phases in-process (no child process shell-out, #1605).
- `run-engine.ts`: one PGLite engine shared by consecutive migrations in one run.
- `opt-out.ts`: `optOut: { key }` lets the owner decline a host migration via a DB config key (#6466).
- `shared-content.ts`: `shared_skills.migration.enabled` opt-out migration (#6466).
- `v0_11_0.ts`: Minions adoption orchestrator, resumable phases.
- `v0_11_0-install.ts`: autopilot install; upgrade on a brain with no repo (#6755).
- `v0_12_0.ts`: knowledge-graph auto-wire on every install.
- `v0_12_2.ts`: repairs JSONB double-encoded by pre-0.12 writers.
- `v0_13_0.ts`: frontmatter relationship indexing (typed edges from YAML).
- `v0_13_1.ts`: retires the `validate: false` grandfather writer (#7814).
- `v0_14_0.ts`: shell-jobs adoption and autopilot cooperative fix.
- `v0_16_0.ts`: subagent runtime. Per its header (lines 9-13), no DDL here; it only verifies `subagent_messages`, `subagent_tool_executions`, `subagent_rate_leases` exist after schema init.
- `v0_18_0.ts`: multi-source brains orchestrator (sub-versions split for safety).
- `v0_18_0-storage-backfill.ts`: phase-B storage backfill; drives the `file_migration_ledger` state machine.
- `v0_18_1.ts`: RLS hardening; points at schema migration v024.
- `v0_21_0.ts`: Code Cathedral II orchestrator (14 bisectable layers).
- `v0_22_4.ts`: frontmatter guard adoption (shared validator, `parseMarkdown(..., {validate: true})`).
- `v0_28_0.ts`: Takes + Think + unified model config.
- `v0_29_1.ts`: backfill of `effective_date` for existing pages.
- `v0_31_0.ts`: Hot Memory (cross-session facts).
- `v0_32_2.ts`: facts join the system-of-record invariant (fence columns from schema v051).
- `v0_43_0.ts`: pitch-only (MEMORY_VERBS v1); no schema or data change.
- `v0_46_3.ts`: retired notice; orchestrator returns `skipped`, no data change.
- `v0_60_31.ts`: security fix wave: credential-safe re-chunk of existing pages (ENG-2), plus later phases.
- `v0_60_31-google-file-modes.ts`: one-time notice for Google sources whose directory is outside `~/.gbrain`.

### (b) Schema migrations v002-v160

Columns: Ver | name | objects touched | kind (DDL, DATA = backfill/DML, IDX = index build, RLS, FN = function/trigger/view, HANDLER = TS logic) | engine branches | runner mode (tx / NOTX / handler-only).

| Ver | name | objects touched | kind | engine branches | runner mode |
|---|---|---|---|---|---|
| v002 | slugify_existing_pages | page slugs and wikilinks rewritten via `engine.updateSlug` / `rewriteLinks`, using `slugifyPath` from `sync.ts` | DATA, HANDLER | none | handler-only |
| v003 | unique_chunk_index | DELETE duplicate `content_chunks`; UNIQUE INDEX `idx_chunks_page_index(page_id, chunk_index)` | DATA, IDX | none | tx |
| v004 | access_tokens_and_mcp_log | TABLE `access_tokens` + partial IDX `idx_access_tokens_hash`; TABLE `mcp_request_log` | DDL | none | tx |
| v005 | minion_jobs_table | TABLE `minion_jobs`; IDX claim, status, stalled, delayed, parent | DDL, IDX | none | tx |
| v006 | agent_orchestration_primitives | ALTER `minion_jobs` ADD tokens_input/output/cache_read; replace `chk_status` (adds `paused`); TABLE `minion_inbox` + IDX unread | DDL | none | tx |
| v007 | agent_parity_layer | ALTER `minion_jobs` (depth, max_children, timeout_ms, timeout_at, remove_on_complete/fail, idempotency_key) + CHECKs; IDX timeout, parent_status; UNIQUE `uniq_minion_jobs_idempotency`; TABLE `minion_attachments`; IDX inbox_child_done, attachments_job | DDL, IDX | none | tx |
| v008 | multi_type_links_constraint | DROP `links_from_page_id_to_page_id_key`, `links_from_to_type_unique`; DELETE dup links; ADD UNIQUE `links_from_to_type_unique(from,to,type)` | DATA, DDL | none | tx |
| v009 | timeline_dedup_index | DELETE dup `timeline_entries`; UNIQUE IDX `idx_timeline_dedup(page_id,date,summary)` | DATA, IDX | none | tx |
| v010 | drop_timeline_search_trigger | DROP TRIGGER `trg_timeline_search_vector`; DROP FUNCTION `update_page_search_vector_from_timeline` | FN | none | tx |
| v011 | links_provenance_columns | DO-block PG >= 15 gate; ALTER `links` ADD link_source (+CHECK `links_link_source_check`), origin_page_id, origin_field; UPDATE backfill; UNIQUE `links_from_to_type_source_origin_unique`; IDX `idx_links_source`, `idx_links_origin` | DDL, DATA, IDX | SQL version gate only; prelude `v011` batches link_source | tx |
| v012 | budget_ledger | TABLE `budget_ledger`, `budget_reservations`; IDX `idx_budget_reservations_expires` | DDL, IDX | none | tx |
| v013 | minion_quiet_hours_stagger | ALTER `minion_jobs` ADD quiet_hours JSONB, stagger_key; partial IDX `idx_minion_jobs_stagger_key` | DDL, IDX | none | tx |
| v014 | pages_updated_at_index | IDX `idx_pages_updated_at_desc` on `pages(updated_at DESC)` | IDX | `kind`: PG `CREATE INDEX CONCURRENTLY` after `dropInvalidConcurrentIndex`; PGL plain | handler-only |
| v015 | minion_jobs_max_stalled_default_5 | ALTER `minion_jobs.max_stalled` DEFAULT 5; UPDATE non-terminal rows with max_stalled < 5 | DDL, DATA | none | tx |
| v016 | cycle_locks_table | TABLE `gbrain_cycle_locks` (TTL lock); IDX `idx_cycle_locks_ttl` | DDL, IDX | none | tx |
| v020 | sources_table_additive | TABLE `sources`; INSERT seed `default` source from config `sync.repo_path` / `last_commit` | DDL, DATA | none | tx |
| v021 | pages_source_id_composite_unique | ALTER `pages` ADD source_id (FK `sources`, ON DELETE CASCADE); IDX `idx_pages_source_id`; DROP `pages_slug_key`; UNIQUE `pages_source_slug_key(source_id, slug)` | DDL, IDX | `sqlFor` PG and PGL (separate bodies) | tx |
| v022 | links_resolution_type | ALTER `links` ADD resolution_type; CHECK `links_resolution_type_check` (DO-guarded) | DDL | none | tx |
| v023 | files_source_id_page_id_ledger | `files`: drop `files_page_slug_fkey`, ADD source_id, page_id, IDX; `pages`: swap to `pages_source_slug_key`; TABLE `file_migration_ledger` + IDX `idx_file_migration_ledger_status`; INSERT ledger rows | DDL, DATA, IDX | handler returns immediately on PGL | handler (wrapped in `engine.transaction`) |
| v024 | rls_backfill_missing_tables | RLS ENABLE on `access_tokens`, `mcp_request_log`, `minion_inbox`, `minion_attachments`, `subagent_messages`, `subagent_tool_executions`, `subagent_rate_leases`, `gbrain_cycle_locks`, `budget_ledger`, `budget_reservations`; fails if role lacks BYPASSRLS | RLS | `sqlFor.pglite = ''` (no-op) | tx |
| v025 | pages_page_kind | ALTER `pages` ADD page_kind TEXT DEFAULT 'markdown'; CHECK `pages_page_kind_check`; PG: NOT VALID then VALIDATE | DDL | PG two-step; PGL inline CHECK | tx |
| v026 | content_chunks_code_metadata | ALTER `content_chunks` ADD language, symbol_name, symbol_type, start_line, end_line; IDX `idx_chunks_symbol_name`, `idx_chunks_language` (partial) | DDL, IDX | none | tx |
| v027 | cathedral_ii_foundation | ALTER `content_chunks` ADD parent_symbol_path, doc_comment, symbol_name_qualified, search_vector TSVECTOR; IDX `idx_chunks_search_vector` (GIN), `idx_chunks_symbol_qualified`; TABLE `code_edges_chunk` (+3 IDX), `code_edges_symbol` (+2 IDX); FN `update_chunk_search_vector`; TRIGGER `chunk_search_vector_trigger` | DDL, IDX, FN | none | tx |
| v028 | cathedral_ii_chunk_fts_backfill | UPDATE `content_chunks.search_vector` (weight A doc_comment and symbol_name_qualified, B chunk_text) WHERE NULL; prelude `v028` batches it | DATA | none | tx |
| v029 | cathedral_ii_code_edges_rls | ENABLE RLS on `code_edges_chunk`, `code_edges_symbol` (BYPASSRLS guard) | RLS | `sqlFor.postgres` (RLS); PGL branch without RLS | tx |
| v030 | dream_verdicts_table | TABLE `dream_verdicts` (PK file_path, content_hash); ENABLE RLS (BYPASSRLS guard) | DDL, RLS | PG-guarded RLS | tx |
| v031 | eval_capture_tables | TABLE `eval_candidates` (+IDX created_at), `eval_capture_failures` (+IDX ts); RLS on both (PG) | DDL, IDX, RLS | `sqlFor` PG (BYPASSRLS guard, RLS) and PGL | tx |
| v032 | oauth_infrastructure | TABLE `oauth_clients`, `oauth_tokens` (+2 IDX), `oauth_codes`; IDX `idx_mcp_log_time_agent`; ENABLE RLS on the three oauth tables if BYPASSRLS, else WARNING | DDL, IDX, RLS | PG-only RLS DO block | tx |
| v033 | admin_dashboard_columns_v0_26_3 | ALTER `oauth_clients` ADD token_ttl, deleted_at; ALTER `mcp_request_log` ADD agent_name, params JSONB, error_message; backfill agent_name; UPDATE `oauth_clients` (2 statements); IDX `idx_mcp_log_agent_time` | DDL, DATA, IDX | prelude `v033` batches agent names | tx |
| v034 | destructive_guard_columns | ALTER `pages` ADD deleted_at; ALTER `sources` ADD archived, archived_at, archive_expires_at; DATA from `sources.config` JSON; partial IDX `pages_deleted_at_purge_idx` | DDL, DATA, IDX | `kind`: PG `CREATE INDEX CONCURRENTLY`; PGL plain | handler (SQL run in-line), NOTX |
| v035 | auto_rls_event_trigger | FN `auto_enable_rls()`; EVENT TRIGGER `auto_rls_on_create_table` (ddl_command_end: CREATE TABLE, CREATE TABLE AS, SELECT INTO); ENABLE RLS on existing public tables; BYPASSRLS/superuser guard | FN, RLS | `sqlFor` PG and PGL (PGL body without RLS) | tx |
| v036 | subagent_provider_neutral_persistence_v0_27 | ALTER `subagent_messages`, `subagent_tool_executions` ADD schema_version (DEFAULT 1); `subagent_messages` ADD provider_id; IDX `idx_subagent_messages_provider` | DDL, IDX | none | tx |
| v037 | takes_and_synthesis_evidence | TABLE `takes` (+6 IDX incl. HNSW `idx_takes_embedding_hnsw`); TABLE `synthesis_evidence` (+IDX), RLS on it | DDL, IDX, RLS | `sqlFor.pglite` (no RLS); PG default SQL has RLS | tx |
| v038 | access_tokens_permissions | ALTER `access_tokens` ADD permissions JSONB DEFAULT `{"takes_holders":["world"]}`; UPDATE existing rows | DDL, DATA | none | tx |
| v039 | multimodal_dual_column_v0_27_1 | PG preflight: pgvector >= 0.5 (throws before DDL); PG: ALTER `content_chunks` ADD embedding_image vector(1024); partial HNSW IDX `idx_chunks_embedding_image`; CHECK `pages_page_kind_check` widened to include `image`. PGL: TABLE `files` + IDX `idx_files_page`, `idx_files_page_id`, `idx_files_source_id`, `idx_files_hash` | DDL, IDX | `kind` branches (PG vs PGL) | handler-only |
| v040 | pages_emotional_weight | ALTER `pages` ADD emotional_weight REAL NOT NULL DEFAULT 0 | DDL | none | tx |
| v041 | pages_recency_columns | ALTER `pages` ADD effective_date, effective_date_source, import_filename, salience_touched_at; IDX `pages_coalesce_date_idx` | DDL, IDX | `kind`: PG CONCURRENTLY; PGL plain | handler, NOTX |
| v042 | eval_candidates_recency_capture | ALTER `eval_candidates` ADD as_of_ts, salience_param, recency_param, salience_resolved, recency_resolved, salience_source, recency_source | DDL | none | tx |
| v043 | takes_resolved_quality_and_drift_decisions | UPDATE `takes` SET resolved_quality (backfill); DROP/ADD `takes_resolution_consistency`; IDX `idx_takes_scorecard`; TABLE `drift_decisions` (+2 IDX), RLS (PG) | DDL, DATA, IDX, RLS | `sqlFor.pglite` (no RLS) | tx |
| v044 | pages_emotional_weight_recomputed_at | ALTER `pages` ADD emotional_weight_recomputed_at (its index is built by the backfill registry, not here) | DDL | none | tx |
| v045 | facts_hot_memory_v0_31 | TABLE `facts` (+IDX entity_active, session, since, unconsolidated); HNSW `idx_facts_embedding_hnsw` (dims from config, halfvec above cap); RLS on `facts` (PG) | DDL, IDX, RLS | `kind` branch (PG pgvector check, RLS, HNSW) | handler |
| v046 | mcp_request_log_params_jsonb_normalize | UPDATE `mcp_request_log` SET params = unwrapped JSON where stored as a JSON string | DATA | none | tx |
| v047 | facts_notability_alter | ALTER `facts` ADD notability TEXT NOT NULL DEFAULT 'medium'; CHECK `facts_notability_check` (high/medium/low) | DDL | none | tx |
| v048 | takes_weight_round_to_grid | UPDATE `takes` SET weight rounded to the 0.05 grid where off by more than 0.001 | DATA | none | NOTX |
| v049 | eval_takes_quality_runs | TABLE `eval_takes_quality_runs` + IDX `eval_takes_quality_runs_trend_idx` | DDL, IDX | none | tx |
| v050 | ingest_log_source_id | ALTER `ingest_log` ADD source_id; IDX `idx_ingest_log_source_type_created` | DDL, IDX | none | tx |
| v051 | facts_fence_columns | ALTER `facts` ADD row_num, source_markdown_slug; UNIQUE IDX `idx_facts_fence_key` | DDL, IDX | none | tx |
| v052 | eval_contradictions_cache | TABLE `eval_contradictions_cache` + IDX `eval_contradictions_cache_expires_idx` | DDL, IDX | none | tx |
| v053 | eval_contradictions_runs | TABLE `eval_contradictions_runs` + IDX `eval_contradictions_runs_ran_at_idx` | DDL, IDX | none | tx |
| v054 | cjk_wave_pages_chunker_version_and_source_path | ALTER `pages` ADD chunker_version, source_path; IDX `pages_chunker_version_idx`, `pages_source_path_idx` | DDL, IDX | none | tx |
| v055 | query_cache_search_lite | TABLE `query_cache` + IDX `idx_query_cache_source_created`; HNSW `idx_query_cache_embedding_hnsw` (dims-gated) | DDL, IDX | `kind` branch: PG pgvector version check and HNSW | handler |
| v056 | query_cache_knobs_hash | ALTER `query_cache` ADD knobs_hash; IDX `idx_query_cache_source_knobs_created` | DDL, IDX | none | tx |
| v057 | search_telemetry_rollup | TABLE `search_telemetry` + IDX `idx_search_telemetry_date` | DDL, IDX | none | tx |
| v058 | edges_backfilled_at_v0_33_2 | ALTER `content_chunks` ADD edges_backfilled_at; IDX `idx_code_edges_symbol_resolver`, `idx_content_chunks_symbol_lookup`, `idx_content_chunks_edges_backfill` | DDL, IDX | none | tx |
| v059 | code_traversal_cache_v0_34 | TABLE `code_traversal_cache`; UNIQUE IDX `code_traversal_cache_key_idx`; IDX `code_traversal_cache_source_idx` | DDL, IDX | none | tx |
| v060 | oauth_clients_source_id_fk | ALTER `oauth_clients` ADD source_id; UPDATE NULL -> 'default'; DO-block FK `oauth_clients_source_id_fkey` (ON DELETE SET NULL); IDX `idx_oauth_clients_source_id` | DDL, DATA, IDX | none | tx |
| v061 | oauth_clients_federated_read_column | ALTER `oauth_clients` ADD federated_read TEXT[] NOT NULL DEFAULT '{}' | DDL | none | tx |
| v062 | oauth_clients_federated_read_backfill | UPDATE `oauth_clients` SET federated_read = ARRAY[source_id] (or '{}' when source_id NULL) where empty | DATA | none | tx |
| v063 | oauth_clients_federated_read_validate | DO-block raises if any row has source_id missing from federated_read (no DDL) | DATA (check) | none | tx |
| v064 | oauth_clients_source_id_fk_restrict | DO-block: drop `oauth_clients_source_id_fkey` if present, re-add FK ON DELETE RESTRICT | DDL | none | tx |
| v065 | oauth_clients_federated_read_gin_index | IDX `idx_oauth_clients_federated_read` (GIN) | IDX | none | tx |
| v066 | embed_stale_partial_index | partial IDX `idx_chunks_embedding_null` on `content_chunks` | IDX | `kind`: PG CONCURRENTLY with invalid pre-drop; PGL plain | handler |
| v067 | facts_typed_claim_columns | ALTER `facts` ADD claim_metric and typed-claim columns; IDX `facts_typed_claim_idx` | DDL, IDX | none | tx |
| v068 | calibration_profiles_v0_36 | TABLE `calibration_profiles` + IDX holder_recent, bias_tags (GIN), published | DDL, IDX | none | tx |
| v069 | take_proposals_v0_36 | TABLE `take_proposals`; UNIQUE IDX `take_proposals_idempotency_idx`; IDX pending, run_id | DDL, IDX | none | tx |
| v070 | take_grade_cache_v0_36 | TABLE `take_grade_cache` + IDX applied, wave | DDL, IDX | none | tx |
| v071 | take_nudge_log_v0_36 | TABLE `take_nudge_log` + IDX take_cooldown, proposal_cooldown, wave | DDL, IDX | none | tx |
| v072 | takes_resolved_at_trend_idx_v0_36 | IDX `takes_resolved_at_idx` | IDX | `kind`: PG CONCURRENTLY with invalid pre-drop; PGL plain | handler, NOTX |
| v073 | think_ab_results_v0_36 | TABLE `think_ab_results` + IDX recent | DDL, IDX | none | tx |
| v074 | eval_candidates_embedding_column | ALTER `eval_candidates` ADD embedding_column | DDL | `sqlFor.pglite` (PG uses default SQL, same statement) | tx |
| v075 | op_checkpoints_table | TABLE `op_checkpoints` + IDX `op_checkpoints_updated_at_idx` | DDL, IDX | none | tx |
| v076 | minion_jobs_doctor_run_id_index | GIN IDX `minion_jobs_doctor_run_id_idx` (data jsonb_path_ops, partial on `doctor_run_id`) | IDX | `sqlFor.postgres` GIN; `sqlFor.pglite = ''` (no-op) | tx |
| v077 | mcp_spend_log | TABLE `mcp_spend_log` + IDX token_time, client_time | DDL, IDX | `sqlFor.pglite` (PG default SQL) | tx |
| v078 | embedding_multimodal_column | ALTER `content_chunks` ADD embedding_multimodal | DDL | `sqlFor.pglite` | tx |
| v079 | pages_last_retrieved_at | ALTER `pages` ADD last_retrieved_at; IDX `pages_last_retrieved_at_idx` (plain, not CONCURRENTLY) | DDL, IDX | none | tx |
| v080 | takes_unresolvable_quality_v0_37_2_0 | DROP/ADD CHECKs `takes_resolved_quality_values` and `takes_resolution_consistency` (allow `unresolvable`) | DDL | none | tx |
| v081 | pages_provenance_columns | ALTER `pages` ADD ingested_via, ingested_at, source_uri, source_kind | DDL | none | tx |
| v082 | subagent_tool_executions_stable_id | ALTER `subagent_tool_executions` ADD ordinal, gbrain_tool_use_id; DROP/ADD constraint `subagent_tool_executions_stable_id` | DDL | `sqlFor.pglite` | tx |
| v083 | mcp_spend_reservations | TABLE `mcp_spend_reservations` + IDX client_time, pending_expires | DDL, IDX | none | tx |
| v084 | oauth_clients_budget_usd_per_day | ALTER `oauth_clients` ADD budget_usd_per_day NUMERIC(10,2) | DDL | none | tx |
| v085 | oauth_clients_agent_binding | ALTER `oauth_clients` ADD bound_tools, bound_source_id, bound_brain_id, bound_slug_prefixes, bound_max_concurrent; FK `fk_oauth_clients_bound_source` (ON DELETE SET NULL, exception-guarded) | DDL | `sqlFor.pglite` | tx |
| v086 | page_links_view_alias | VIEW `page_links` = SELECT id, from_page_id, to_page_id FROM `links` | FN (view) | none (PGL bootstrap also creates the view) | tx |
| v087 | takes_kind_drop_check | DROP CONSTRAINT `takes_kind_check` | DDL | none | tx |
| v088 | eval_candidates_schema_pack_per_source | ALTER `eval_candidates` ADD schema_pack_per_source | DDL | none | tx |
| v089 | facts_event_type_column | ALTER `facts` ADD event_type | DDL | none | tx |
| v090 | contextual_retrieval_columns | ALTER `pages` ADD contextual_retrieval_mode, corpus_generation; `sources` ADD contextual_retrieval_mode, trust_frontmatter_overrides; `query_cache` ADD page_generations | DDL | none | tx |
| v091 | pages_generation_trigger_and_bookmark | ALTER `pages` ADD generation BIGINT DEFAULT 1; `query_cache` ADD max_generation_at_store; FN `bump_page_generation_fn` + row TRIGGER `bump_page_generation_trg` (BEFORE INSERT/UPDATE); IDX `pages_generation_idx` | DDL, FN, IDX | `kind`: PG CONCURRENTLY; PGL plain | handler-only (no verify hook) |
| v092 | sources_github_repo_index | IDX `sources_github_repo_idx` | IDX | none | tx |
| v093 | minions_v0_41_audit_and_budget | TABLE `minion_lease_pressure_log`, `minion_budget_log`, `minion_self_fix_log` (+2 IDX each); ALTER `minion_jobs` ADD budget_* columns | DDL, IDX | none | tx |
| v094 | take_domain_assignments | TABLE `take_domain_assignments` (FK takes ON DELETE CASCADE, confidence CHECK 0..1) + IDX domain; RLS enable with BYPASSRLS guard | DDL, IDX, RLS | `sqlFor.pglite` (differs; RLS only in default SQL) | tx |
| v095 | links_link_source_check_includes_mentions | DROP/ADD `links_link_source_check` (adds `mentions`) | DDL | `sqlFor` PG and PGL | tx |
| v096 | facts_extract_conversation_session_index | IDX `idx_facts_extract_conversation_session` on facts(source_id, source_session) (partial) | IDX | `kind`: PG CONCURRENTLY; PGL plain | handler, NOTX |
| v097 | pages_dedup_partial_index | partial IDX `pages_dedup_idx` | IDX | `sqlFor.pglite` plain CREATE; PG CONCURRENTLY in handler | handler, NOTX |
| v098 | gbrain_cycle_locks_last_refreshed_at | ALTER `gbrain_cycle_locks` ADD last_refreshed_at; UPDATE backfill | DDL, DATA | none | tx |
| v099 | conversation_parser_llm_cache_table | TABLE `conversation_parser_llm_cache` + IDX created | DDL, IDX | `sqlFor.pglite` | tx |
| v101 | links_link_kind_column | ALTER `links` ADD link_kind TEXT CHECK (plain, typed_ner) | DDL | `sqlFor.pglite` (same text) | tx |
| v102 | timeline_entries_source_in_dedup | DROP + UNIQUE IDX `idx_timeline_dedup(page_id, date, summary, source)` | IDX | `sqlFor.pglite` (same text) | tx |
| v103 | migration_impact_log_and_priority_recent_idx | TABLE `migration_impact_log` + 2 IDX; IDX `content_chunks_stale_idx` | DDL, IDX | `kind`: PG CONCURRENTLY; PGL plain | handler, NOTX |
| v104 | pages_atom_source_hash_idx | IDX `pages_atom_source_hash_idx` | IDX | `kind`: PG CONCURRENTLY; PGL plain | handler, NOTX |
| v105 | slug_aliases | TABLE `slug_aliases` + IDX `slug_aliases_canonical_idx` (plain, no CONCURRENTLY) | DDL, IDX | none (PGL bootstrap also creates it) | handler-only |
| v106 | extract_rollup_7d_table | TABLE `extract_rollup_7d` + IDX day | DDL, IDX | none | tx |
| v107 | page_generation_clock_and_statement_trigger | TABLE `page_generation_clock` (singleton id=1); seed value = MAX(pages.generation); FN `bump_page_generation_clock_fn`; statement-level TRIGGER `bump_page_generation_clock_trg` AFTER INSERT/UPDATE/DELETE on `pages` (`DROP TRIGGER IF EXISTS` first, `:60`) | DDL, DATA, FN | none | tx |
| v108 | pages_embedding_signature | ALTER `pages` ADD embedding_signature | DDL | none | tx |
| v109 | sources_newest_content_at | ALTER `sources` ADD newest_content_at | DDL | none | tx |
| v110 | page_aliases | TABLE `page_aliases` (UNIQUE source_id, alias_norm, slug) + IDX lookup, slug | DDL, IDX | none (PGL bootstrap also creates it) | tx |
| v111 | search_telemetry_rank1_columns | ALTER `search_telemetry` ADD sum_rank, count_rank, rank-1 columns | DDL | none | tx |
| v112 | pages_links_extracted_at | ALTER `pages` ADD links_extracted_at; IDX `pages_links_extracted_at_idx` | DDL, IDX | `kind`: PG CONCURRENTLY; PGL plain | handler, NOTX |
| v113 | links_link_source_widen_for_wikilink_basename | DROP/ADD `links_link_source_check` (adds `wikilink-resolved`) | DDL | `sqlFor.pglite` (same text) | tx |
| v114 | links_link_source_check_kebab_regex | CHECK `links_link_source_check` replaced with kebab-case regex and <= 64 chars; PG: NOT VALID then VALIDATE | DDL | `sqlFor` PG two-phase vs PGL one-shot | NOTX |
| v115 | op_checkpoint_paths_append_table | TABLE `op_checkpoint_paths` | DDL | none (comment mentions NOTX, flag not set) | tx |
| v116 | code_edges_source_backfill_and_callee_index | UPDATE `code_edges_symbol` and `code_edges_chunk` SET source_id from pages; IDX `idx_code_edges_symbol_from_symbol`, `idx_code_edges_chunk_from_symbol`; prelude `v116` batches | DATA, IDX | none | tx |
| v117 | context_volunteer_events_table | TABLE `context_volunteer_events` + IDX src_time, src_slug | DDL, IDX | none | tx |
| v118 | page_generation_clock_sequence_swap | CREATE SEQUENCE `page_generation_clock_seq`; FN `bump_page_generation_clock_fn` uses nextval(); TRIGGER swapped; DELETE FROM `query_cache` | DDL, FN, DATA | none | tx |
| v119 | op_checkpoints_completed_keys_array_check | UPDATE `op_checkpoints.completed_keys` to array; CHECK `op_checkpoints_completed_keys_array` | DATA, DDL | none | tx |
| v120 | schema_lint_hardening_search_path_security_invoker | VIEW `page_links` SET (security_invoker = on); ALTER FUNCTION SET search_path for `bump_page_generation_fn`, `bump_page_generation_clock_fn`, `update_chunk_search_vector`, `update_page_search_vector`, `notify_minion_job_change`, `auto_enable_rls` (existing only) | FN, VIEW | `sqlFor` PG and PGL (different bodies) | tx |
| v121 | timeline_entries_event_page_id | ALTER `timeline_entries` ADD event_page_id + FK; IDX `idx_timeline_event_page`; UNIQUE IDX `idx_timeline_event_dedup` | DDL, IDX | none | tx |
| v122 | facts_ontology_dimension | ALTER `facts` ADD dimension, value, value_hash, dim_status; IDX `idx_facts_dimension`; UNIQUE IDX `idx_facts_ontology_dedup` | DDL, IDX | none | tx |
| v123 | configurable_fts_language | handler: CREATE OR REPLACE `update_page_search_vector` and `update_chunk_search_vector` with the configured language (`getFtsLanguage`); DATA re-derive `pages` (UPDATE pages SET id = id) and `content_chunks.search_vector` | FN, DATA | language setting, not engine | handler-only |
| v124 | page_search_vector_drop_compiled_truth | handler: CREATE OR REPLACE `update_page_search_vector` without compiled_truth | FN | none | handler-only |
| v125 | take_proposals_per_claim_idempotency | DROP and re-CREATE UNIQUE IDX `take_proposals_idempotency_idx` including md5(claim_text) | IDX | none | tx |
| v126 | session_context_state | TABLE `session_context_state` + IDX updated | DDL, IDX | none | tx |
| v127 | oauth_client_surface_and_minion_queue_index | ALTER `oauth_clients` ADD surface, surface_set_by; IDX `idx_minion_jobs_queue_status_updated` | DDL, IDX | none | tx |
| v128 | minion_jobs_timeout_backfill_and_duplicate_cycle_cleanup | UPDATE `minion_jobs` SET timeout_ms by job name; UPDATE duplicate cycle jobs to status `cancelled` | DATA | none | tx |
| v129 | dream_verdicts_triage_v1_columns | ALTER `dream_verdicts` ADD score, content_type, segments, entities, model, triage_version | DDL | none | tx |
| v130 | minion_jobs_lock_duration_ms | ALTER `minion_jobs` ADD lock_duration_ms; CHECK `chk_lock_duration_positive` | DDL | none | tx |
| v131 | drop_job_wide_subagent_tool_use_id_unique | DROP CONSTRAINT `uniq_subagent_tools_use_id` | DDL | none | tx |
| v132 | session_context_state_checkpoint_manifest | ALTER `session_context_state` ADD checkpoint_manifest | DDL | none | tx |
| v133 | content_chunks_embedded_text_hash | ALTER `content_chunks` ADD embedded_text_hash | DDL | none | tx |
| v134 | restore_chunks_embedding_null_partial_indexes | re-creates embedding-null partial indexes on `content_chunks` (names built in handler) | IDX | `kind`: PG CONCURRENTLY; PGL plain | handler, NOTX |
| v135 | facts_event_time_index | IDX `idx_facts_since_event_time` on facts | IDX | none | tx |
| v136 | minion_private_queue_owner_metadata | ALTER `minion_jobs` ADD private_queue_owner_job_id (self FK, ON DELETE SET NULL), private_queue_owner_token, private_queue_lease_until; IDX `idx_minion_jobs_private_queue_recovery`, `idx_minion_jobs_private_queue_owner` | DDL, IDX | none | tx |
| v137 | entity_identities | TABLE `entity_identities` + IDX `entity_identities_entity_idx` + UNIQUE `entity_identities_canonical_uniq` | DDL, IDX | none | tx |
| v138 | timeline_dedup_md5_summary | DROP `idx_timeline_dedup`; UNIQUE IDX `idx_timeline_dedup(page_id, date, md5(summary), source)` (plain build) | IDX | none | tx |
| v139 | timeline_legacy_source_split_repair | handler `repairLegacyTimelineSourceRows` (timeline-dedup-repair.ts): rewrites legacy rows to (source, summary) shape, deletes duplicates | DATA | none | handler-only |
| v140 | chat_usage_log | TABLE `chat_usage_log` + IDX created, model | DDL, IDX | none | tx |
| v141 | extract_rollup_expected_limit | ALTER `extract_rollup_7d` ADD expected_limit_count INT DEFAULT 0 | DDL | none | tx |
| v142 | takes_embedding_dimension_matches_config | handler: if `takes.embedding` dims differ from config `embedding_dimensions`: DROP HNSW `idx_takes_embedding_hnsw`; UPDATE takes SET embedding = NULL, embedded_at = NULL; DROP COLUMN embedding; ADD embedding VECTOR(dims); recreate HNSW. Destructive to takes embeddings | DDL, DATA, IDX | `kind` (pgvector) | handler-only |
| v143 | dream_verdicts_ttl | ALTER `dream_verdicts` ADD expires_at; SET DEFAULT now() + 30 days; UPDATE backfill; IDX `dream_verdicts_expires_idx` | DDL, DATA, IDX | none | tx |
| v144 | open_loops | handler: re-runs the takes embedding resize from v142 (dims-checked first) and the dream_verdicts expiry backfill; TABLE `open_loops` (+3 IDX); TABLE `loop_suppressions` | DDL, DATA, IDX | `kind` (pgvector) | handler-only |
| v145 | facts_kind_idea_alter | re-creates CHECK `facts_kind_check` (adds `idea`) | DDL | none | tx |
| v146 | extract_atoms_transcript_state_table | TABLE `extract_atoms_transcript_state`; DROP IDX `extract_atoms_transcript_state_live_idx`; IDX `..._tombstoned_idx` | DDL, IDX | none | tx |
| v147 | oauth_client_capability_grants | SQL: `GRANT_COLUMNS_SQL` (ALTER `oauth_clients` ADD allowed_operations, delegated_slug_prefixes, delegated_namespace, grant_profile, grant_revision, grant_repair_reasons) + `GRANT_AUDIT_SCHEMA_SQL` (TABLE `oauth_grant_audit` + IDX) + `GRANT_SPEND_COLUMNS_SQL` (ALTER `mcp_spend_reservations` ADD estimate_known, usage_unknown_reason); handler `repairLegacyClientGrants` | DDL, HANDLER | none | tx + handler |
| v148 | durable_fact_withdrawals | SQL: `FACT_WITHDRAWAL_SCHEMA_SQL` (TABLE `fact_withdrawals`; FN `gbrain_fact_fingerprint*`, `gbrain_preserve_fact_withdrawal`; TRIGGER `facts_preserve_withdrawal`) + `FACT_WITHDRAWAL_BACKFILL_SQL` (DATA) | DDL, FN, DATA | none | tx |
| v149 | minion_submission_authority | ALTER `minion_jobs` ADD submission_authority JSONB, claim_generation BIGINT DEFAULT 0; FN `enforce_minion_queue_protocol`; TRIGGER `minion_queue_protocol` (BEFORE INSERT/UPDATE) | DDL, FN | none | tx |
| v150 | canonical_page_revisions_and_guards | SQL: `PAGE_STATE_SCHEMA_SQL` (ALTER `sources` ADD incarnation + UNIQUE `sources_incarnation_key`; ALTER `pages` ADD knowledge_revision, text_projection_revision; ALTER `page_versions` ADD knowledge_revision, timeline, title, type, tags; TABLE `page_write_guards`; FN `gbrain_advance_page_revision`, `gbrain_advance_tag_revision`; TRIGGERs `pages_knowledge_revision`, `tags_knowledge_revision`) | DDL, FN | none | tx |
| v151 | durable_concurrent_persistence | SQL: all of `PERSISTENCE_SCHEMA_STATEMENTS` (TABLE `persistence_brain` and the persistence_* tables; plain CREATE INDEX for every index in the array, including the 9 that the PG blob omits) | DDL, IDX | none | tx |
| v152 | unique_lock_acquisition_tokens | ALTER `gbrain_cycle_locks` ADD acquisition_token UUID NOT NULL DEFAULT gen_random_uuid() | DDL | none | tx |
| v153 | verified_text_projection_activation | SQL: `PAGE_PROJECTION_SCHEMA_SQL` (TABLE `page_projection_jobs`; FN `gbrain_queue_page_projection`; TRIGGERs `trg_pages_search_vector`, `pages_projection_queue`) + `PAGE_PROJECTION_ACTIVATION_SQL` (DML); handler counts served vs text projection rows and prints | DDL, FN, DATA, HANDLER | none | tx + handler |
| v154 | preserve_sanitized_page_search_vectors | SQL: `PAGE_PROJECTION_SCHEMA_SQL` (restates the v153 objects without activation) | FN, DDL (idempotent restate) | none | tx |
| v155 | recoverable_postcommit_persistence_effects | ALTER `persistence_effects` ADD source_id, source_incarnation, worktree_id, claim_expires_at, next_attempt_at, attempts, error_code, outcome, recovery, recovery_bytes; IDX `persistence_effects_pending`, `persistence_effects_recovery` | DDL, IDX | none | tx |
| v156 | managed_alias_and_source_checkpoint_guards | FN `gbrain_require_managed_writer`; TRIGGER `managed_writer_guard` on each guarded table (page child tables) | FN | none | tx |
| v157 | recoverable_source_topology | TABLE `persistence_topology_changes` (ALTER intent_bytes); IDX `persistence_topology_recovering` | DDL, IDX | none | tx |
| v158 | canonical_version_deletion_state | ALTER `page_versions` ADD is_deleted | DDL | none | tx |
| v159 | index_retained_publication_recovery | plain IDX `persistence_requests_recovery(worktree_id, sequence) WHERE recovery IS NOT NULL` | IDX | none | tx |
| v160 | current_text_projection_planner_statistics | SQL `PROJECTION_STATISTICS_SQL`: CREATE STATISTICS `pages_text_projection_current_stats` ON ((text_projection_revision = knowledge_revision)) FROM pages; ANALYZE pages and content_chunks (columns in `SEARCH_STATISTICS_COLUMNS`); PG `sqlFor` prefixes `SET LOCAL statement_timeout = '30s'`, `lock_timeout = '2s'`; handler `verifyProjectionStatistics` | STATS, DATA (ANALYZE), HANDLER | `sqlFor.postgres` (timeouts); PGL uses the plain SQL | tx + handler |

Notes on the table:

- Migrations v011, v028, v033 and v116 also have a batched prelude (`src/core/migration-preludes.ts:126-166`) that runs before their SQL.
- `sqlFor` appears on about 30 migrations in range; "`sqlFor.pglite` (same text)" means the two bodies are identical in the first statements I compared.
- Migrations with both `sql` and `handler` run the SQL first inside a transaction, then the handler outside it (`src/core/migrate.ts:590`). v147, v153 and v160 use this split.

### (c) DB objects created at runtime outside src/schema.sql and the migrations

Brain database (PG and PGLite):

| Object(s) | Where created | When | Notes |
|---|---|---|---|
| Forward-reference ALTERs and `CREATE TABLE IF NOT EXISTS sources` | `src/core/engine-sql/bootstrap.ts:344-756` | Every `initSchema` before the blob replay | Adds columns the blob's CREATE INDEX/FK needs on old brains. |
| `timeline_entries` unique index `idx_timeline_dedup` (rebuild) | `src/core/timeline-dedup-repair.ts:116-160` (`DROP INDEX`, `CREATE UNIQUE INDEX IF NOT EXISTS ... md5(summary)`) | Every `runMigrations` call (#2038) | Also runs `DELETE` of duplicate rows (`:116-146`). |
| UNIQUE `pages_source_slug_key(source_id, slug)` (restore) | `src/core/pages-upsert-arbiter.ts:115` | Every `runMigrations` call (#550) | ADD-only; refuses on duplicates. |
| `links_link_source_check` CHECK (rewrite) | `src/core/link-source-check-repair.ts:103` | Every call when `current >= 114` (#4613) | Rewrites the constraint to the kebab-case allowlist. |
| `ALTER FUNCTION ... SET search_path ... pg_temp` | `src/core/function-search-path.ts:100` (called from `src/core/migrate.ts:459`) | Every call (#7632) | Owner-role functions are only named, not altered. |
| Missing-column ALTER `ADD COLUMN IF NOT EXISTS` | `src/core/schema-verify.ts:282` | End of PG `initSchema` (`postgres-engine.ts:656`) | Self-heal from blob parse. |
| Invalid HNSW index sweep | `src/core/vector-index.ts` `dropZombieIndexes`, called at `postgres-engine.ts:663-668` | After PG `initSchema` | DROP of indisvalid = false indexes. |
| `query_cache`, `code_traversal_cache` (re-create) | `src/core/schema-missing-tables.ts:45-60` | `gbrain repair missing-tables` | Reruns v055/v056/v090/v091/v059 SQL. |
| `idx_facts_fts` (+ `_next`, `_old`, rename swap) | `src/core/facts/fts-index.ts:38-49` via `buildIndexOnline` (`src/core/schema-migrations/helpers.ts:119`) | Called by migration v237 and `gbrain reindex-search-vector` (`src/commands/reindex-search-vector.ts:53`) | Built and swapped without blocking writers. |
| `persistence_requests_*` indexes (rebuild) | `src/core/repair/request-indexes.ts:14, 32` | `gbrain repair request-indexes` | Via `buildIndexOnline`. |
| `pages_live_origin_key` (UNIQUE partial) | `src/core/persistence/origin-index.ts:12-15`, `:51` | Migration v257 and `gbrain repair origin-twins --apply` (`src/core/repair/origin-twins.ts:54, 223`) | Pending while twins exist. |
| `open_loops.counterparty_source_id` + `open_loops_counterparty_source_idx` | `src/core/loops/loops-schema.ts:8-14` | Shared by migration v236 and the store | Header says the store and a migration share it. |
| `idx_pages_emotional_weight_pending` (CONCURRENTLY) | `src/core/backfill-registry.ts:132` | Backfill runner, not a migration | Migration v044's comment says this index is built by the backfill. |
| `embedding` column DROP + ADD, `idx_chunks_embedding*`, `idx_facts_embedding_hnsw`, `idx_takes_embedding_hnsw`, `idx_query_cache_embedding_hnsw` | `src/core/embedding-migration.ts:137-139, 169, 252-268, 312-313`; `src/core/embedding-dim-check.ts:252, 620-635` | `gbrain migrate embeddings` and dim-change flow | Full DROP INDEX + ALTER ... USING + CREATE INDEX. |
| Deferred HNSW builds | `src/core/embedding-ann-build.ts:103` (CONCURRENTLY on PG), `:119` (plain) | `gbrain migrate embeddings` after drain | Index definitions recorded in migration marker. |
| `idx_chunks_embedding` (temp index then swap) | `src/core/vector-index.ts:24, 253-290` | Vector index rebuild path | `CREATE INDEX CONCURRENTLY` on a temp name. |
| `planner_stats_deltas`, `planner_stats_state`, FN `gbrain_count_modifications`, triggers `planner_stats_ins/upd/del` on six hot tables | `src/core/planner-stats-schema.ts:17-44` | PGLite only, applied by migration v196 (`src/core/schema-migrations/v196-f4-planner-stats.ts:2`), outside this part's range | Not in either blob. |
| `auto_enable_rls` FN + event trigger `auto_rls_on_create_table` (graduation target) | `src/core/persistence/graduation-target.ts:296-298` | Persistence graduation to a Postgres target | Same DDL as migration v035; graduation runs it on the target DB. |
| Indexes copied from source definitions (`CREATE INDEX IF NOT EXISTS`) | `src/core/persistence/graduation-copy.ts:292, 360` | Graduation copy | Index defs come from the source DB. |
| Persistence/guard schema modules used by migrations, not by the blob | `src/core/facts/insert-guard-schema.ts`, `src/core/persistence/attribution-schema.ts`, `src/core/persistence/graduation-schema.ts`, `src/core/eligibility/generation-schema.ts`, `src/core/shared-skills/persistence-schema.ts` | Applied only by migrations (for example v193, v201, v230, v264, v278, v287) | Not in `build-schema.ts` FRAGMENTS, so they are migration-only text. |
| PG extension `vector` | `src/commands/init.ts:1490`; `src/commands/db-repair.ts:581, 802`; `src/core/pg-access-classify.ts:204-205` | `gbrain init` and `db-repair --yes` | Manual remediation text for others. |
| PG extension `pg_prewarm` | `src/core/vector-prewarm.ts:120-125` | `gbrain embeddings prewarm` remediation | Printed or run as `psql -c` argv. |
| `scratch_probe` table | `src/core/pglite-engine.ts:709` | PGLite install/probe in a scratch store directory | Not the brain DB. |

Non-brain stores (separate SQLite files, not in the brain schema):

| Object | Where | Notes |
|---|---|---|
| `paths` table in `manifest.sqlite` | `src/core/export-stage.ts:106` | Export staging manifest, journal off. |
| `embed_cache` table (WITHOUT ROWID) | `src/eval/shared/embed-cache.ts:107-115` | Eval embedding cache file, WAL. |

Checked and not runtime DDL:

- `src/core/sync.ts` has no DDL; its only match is a comment (`:124`).
- `src/commands/migrations/v0_16_0.ts` runs no DDL; it verifies the subagent tables exist (its header lines 9-13).
- `src/core/schema-migrations/` files are excluded from this search; they are part (b).

### Parity risks noted

1. Version key semantics: the runner reads and writes one `config` row `version` as an integer and refuses to run an older binary over a newer schema (`assertSchemaNotAhead`, #7776, `pglite-engine.ts:1176`). An embedded Rust store needs the same monotonic version or a migration path for brains that carry `version` in config.
2. Postgres-specific DDL in migrations: RLS plus BYPASSRLS checks (v024, v029, v030, v031, v032, v035, v094), event triggers (v035), CREATE STATISTICS and ANALYZE (v160), `ALTER VIEW ... security_invoker` (v120), `ALTER FUNCTION ... search_path` (v120, v277 per the search-path self-heal), regex CHECK with `~` (v114), PG 15 `UNIQUE NULLS NOT DISTINCT` (v011), pgvector HNSW and halfvec (v039, v045, v055, v142, v144). PGLite drops several of these via `sqlFor`; the Rust engine has to choose one shape.
3. Non-transactional builds: `transaction: false` on PG (NOTX list: v034, v041, v048, v072, v096, v097, v103, v104, v112, v114, v134) allow concurrent writes during the build; an embedded store that runs everything in one transaction would take a different lock profile. PG CONCURRENTLY fallbacks use an invalid-index recovery path (`dropInvalidConcurrentIndex`, `helpers.ts:53-73`) that has no Rust analogue.
4. SQL and handler are not atomic (`src/core/migrate.ts:590`): the handler runs after the SQL transaction commits. A crash between them leaves new schema with the version still behind. Any Rust port of v123, v139, v142, v144, v147, v153, v160 needs idempotent re-runs.
5. Destructive data changes inside migrations: v142 and v144 DROP COLUMN `takes.embedding` and NULL every take's embedding when dims differ from config (`src/core/schema-migrations/v142-takes-embedding-dimension-matches-config.ts`, `v144-open-loops.ts`); v008 and v009 DELETE duplicates; v119 and v128 rewrite rows; v107 and v118 rewrite the clock trigger. The embedded Rust store has no equivalent history and must decide what a fresh store does with these.
6. Engine-divergent blob shape: the PGLite blob lacks `dream_verdicts`, `code_edges_*`, `file_migration_ledger`, RLS, `pgcrypto`, and the chunk search_vector trigger; the PG blob lacks `page_links` view, `slug_aliases`, `page_aliases`. Parity tests have to compare resulting catalogs, not blobs.
7. Runtime self-heal on every start (migrate.ts:401-449): `idx_timeline_dedup` rebuild, `pages_source_slug_key` UNIQUE restore (needed by `putPage` ON CONFLICT upserts), `links_link_source_check` rewrite, `search_path` reset. A Rust store needs equivalent invariants enforced by construction, or these checks have no target.
8. Lock: Postgres uses advisory lock key 42 (`postgres-engine/init-schema-lock.ts:29`) and PGLite is single-process in-process serialization (`schema-migration-lock.ts:12-32`). A Rust store needs a process-wide exclusive lock file that covers both init and `apply-migrations`.
9. `sqlFor` `''` semantics: an explicit empty string means "skip on this engine" (v024 pglite, v076 pglite), and `??` only falls back when the key is absent (`migrate.ts:548`). A Rust port must reproduce per-engine no-ops, not just the PG SQL.
10. Verify and drift path: `verifySchema` (PG only, `schema-verify.ts:243`) self-heals columns that PgBouncer dropped. A Rust store without a pooler does not need this, but any column the blob declares must be created exactly once.
11. Dims policy: embedding dims come from settings, then stored identity, then gateway defaults (`pglite-engine.ts:1152-1171`, `postgres-engine.ts:586-607`), and HNSW presence depends on dims (`hnswMaxDimsForType`). Migrations v045, v055, v142, v144 bake this in; the Rust store has to reproduce the dims-gated index choice.
12. Missing versions 17-19 and 100 are gaps in the registry, not failures; a port that assumes contiguous numbering would break the `version > current` loop.
13. Migration-only modules (`facts/insert-guard-schema.ts`, `persistence/attribution-schema.ts`, `persistence/graduation-schema.ts`, `eligibility/generation-schema.ts`, `shared-skills/persistence-schema.ts`) are not in the blob. A Rust schema has to include their objects in its fresh-install shape (or they are missing on fresh installs that skip migrations).
14. Out-of-range but relevant: `planner_stats_*` (PGLite-only accounting, v196) and PGLite `page_links` view alias (v086) are objects a Rust store must provide because engine queries reference them (`scripts/build-schema.ts:462-490`).


---

## Migrations v161-v318

Scope: the 158 migration files `src/core/schema-migrations/v161-*.ts` through `v318-*.ts` in `garrytan/gbrain` (commit 8bbfd0b5e8). Paths below are relative to `src/core/schema-migrations/` unless prefixed. Where a migration imports its SQL from a schema module (most of them), the objects listed come from that module; the module path is given in brackets.

### How the runner applies a migration (shared by all 158)

- `src/core/migrate.ts:216-240` `applyOneMigration`: `useTransaction = m.transaction !== false`. SQL runs inside `engine.transaction()` when the flag is on, and always on PGLite. On Postgres with a transaction, it first sets `SET LOCAL statement_timeout` and `SET LOCAL lock_timeout` (`resolveSchemaLockTimeoutMs()`).
- `src/core/migrate.ts:589-591`: the `handler` runs after the SQL and outside the SQL transaction, whatever the `transaction` flag says. A handler-only migration therefore never shares a transaction with its own DDL.
- `migrate.ts` stamps `config.version` only after SQL, handler and verify all succeed (around line 511). A crash mid-handler re-runs the whole migration.
- `verify` hooks exist on only three migrations in scope: v164 (`shared_skill_heads` / `shared_skill_members` / `persistence_requests.target_kind` exist), v191 (both alias FKs validated), v234 (`persistence_host_bindings.git_durability` exists).
- Every migration in scope declares `idempotent: true`.
- `helpers.ts:119` `buildIndexOnline`: on Postgres it skips a valid index, reports `building` if another session is building it, drops an INVALID leftover, then runs `CREATE INDEX CONCURRENTLY` on a reserved connection and checks `indisvalid`. On PGLite it creates the index inline (if absent) and runs ANALYZE. Index migrations that call it are therefore not transactional on Postgres.
- `helpers.ts` `dropInvalidConcurrentIndex` (Postgres only) is called directly by v165, v170, v172, v173 and v187, and runs inside `buildIndexOnline` for the other IDX-ON migrations.
- Row-level security is enabled in most table migrations only behind the guard `IF EXISTS (SELECT 1 FROM pg_roles ... rolbypassrls OR rolsuper)`. The fresh-install and PGLite paths do not depend on it.

### Migration table

Kind codes: DDL = table/column/constraint/index DDL; FN = function or trigger (re)definition; IDX-ON = index built online through `buildIndexOnline`; DATA = a data change in the migration SQL or handler; RLS = row-level security enable; TX-F = `transaction: false`.

| Ver | Name (file) | Objects touched | Kind | Engine branch / transaction |
|---|---|---|---|---|
| 161 | index_pending_text_projections (`v161-index-pending-text-projections.ts`) | index `idx_pages_projection_pending` on pages(source_id, page_kind, slug), partial on live rows whose text projection revision differs from knowledge revision | DDL index (plain) | sqlFor.postgres adds `SET LOCAL statement_timeout 30s`, `lock_timeout 2s`; tx on |
| 162 | source_ingestion_receipts_with_policy (`v162`) | [company-brain/receipt-schema.ts] table `source_ingestion_receipts`, indexes `_active`, `_retention`, `_source`, column `policy_fingerprint` | DDL | tx on |
| 163 | derived_atom_page_scan_state (`v163`) | [sql in file] table `extract_atoms_page_state` (FK sources.incarnation, pages.id), indexes `_tombstoned_idx`, `_page_idx`; FN `gbrain_clear_atom_page_state`; TRIGGER `pages_clear_atom_scan_state` (AFTER UPDATE ON pages); RLS | DDL + FN + DATA (seed rows from live pages with a valid content_hash) | tx on; RLS only when role bypasses RLS |
| 164 | shared_brain_skills_and_membership (`v164`) | [shared-skills/schema-all.ts] `SHARED_SKILLS_SCHEMA_SQL`: `shared_skill_heads`, `shared_skill_members`, `persistence_requests.target_kind` | DDL | tx on; verify hook |
| 165 | index_database_only_pending_writes (`v165`) | index `persistence_requests_database_pending` [persistence/schema.ts] | IDX-ON | handler; TX-F; Postgres drops invalid then `CONCURRENTLY` |
| 166 | fact_embedding_identity (`v166`) | `facts.embedding_model`, `facts.embedded_text_hash` | DDL | tx on |
| 167 | facts_superseded_by_set_null (`v167`) | FK `facts_superseded_by_fkey` re-created `REFERENCES facts(id) ON DELETE SET NULL NOT VALID`, then VALIDATE | DDL constraint | tx on |
| 168 | dream_synthesis_completions (`v168`) | table `dream_synthesis_completions` | DDL | tx on |
| 169 | fact_withdrawal_subject (`v169`) | [facts/withdrawal-schema.ts] `fact_withdrawals.subject` column; pkey change. Existing rows keep the source-wide `'*'` subject (file comment) | DDL | tx on |
| 170 | index_parked_persistence_effects (`v170`) | index `persistence_effects_parked` [persistence/effect-schema.ts] | IDX-ON | handler; TX-F |
| 171 | content_chunks_embedding_input_hash (`v171`) | `content_chunks.embedding_input_hash` | DDL | tx on |
| 172 | pages_safe_chunk_pending_index (`v172`) | index `pages_safe_chunk_pending_idx` ON pages(source_id) WHERE chunker_version < 4 | IDX-ON | handler; TX-F |
| 173 | minion_jobs_dead_subagent_finished_index (`v173`) | index `idx_minion_jobs_dead_subagent_finished` ON minion_jobs(finished_at) WHERE name='subagent' AND status='dead' | IDX-ON | handler; TX-F |
| 174 | fact_withdrawal_normalized_fingerprint (`v174`) | [facts/withdrawal-schema.ts] FN `gbrain_fact_normalize`, `gbrain_fact_fingerprint`, `gbrain_fact_fingerprint_v1`; index `idx_facts_withdrawal_fingerprint`; (file comment: legacy exact rows keep matching) | FN + DDL index | tx on |
| 175 | tags_tag_source (`v175`) | `tags.tag_source` | DDL | tx on |
| 176 | connector_checkpoint_stable_identity (`v176`) | `op_checkpoints` rows with op `managed-connector` / `managed-connector-retry` re-keyed to stable connector identity [persistence/connector-checkpoint-migration.ts:127 `migrateConnectorCheckpoints`] | DATA (handler, no DDL) | handler; outside tx |
| 177 | pages_database_only_reason (`v177`) | `pages.database_only_reason` | DDL | tx on |
| 178 | persistence_writer_version_stamps (`v178`) | `persistence_requests`: `admitter_version`, `admitter_host_id`, `consumer_version`, `consumer_host_id`, `published_at`; `persistence_brain.writer_version_cutoff` then `UPDATE ... SET writer_version_cutoff = now() WHERE NULL` | DDL + DATA (stamp) | tx on |
| 179 | persistence_request_sync_run_indexes (`v179`) | indexes from `PERSISTENCE_SYNC_RUN_INDEXES` [persistence/schema.ts] on persistence_requests | IDX-ON | handler; TX-F |
| 180 | pages_links_attendance_blocked (`v180`) | `pages.links_attendance_blocked_revision` (uuid), `pages.links_attendance_blocked_at` | DDL | tx on |
| 181 | connector_dispatch_attempts (`v181`) | handler `seedConnectorDispatchAttempts` [persistence/connector-state.ts:165]: for each source with local_path, not archived, kind google or github, syncEnabled not false, records a sync attempt in `op_checkpoints` | DATA (handler) | handler |
| 182 | page_versions_source_path (`v182`) | `page_versions.source_path` | DDL | tx on |
| 183 | persistence_mode_epoch (`v183`) | `persistence_brain.mode_epoch bigint NOT NULL DEFAULT 1`; `persistence_worktrees_state_check` dropped and re-added | DDL constraint | tx on |
| 184 | decision_receipts (`v184`) | [ai/decide/schema.ts] `decision_receipts`, `decide_spend`, `decide_state`; indexes `decision_receipts_decision_idx`, `_model_slot_idx`, `_slot_created_idx`, `decide_spend_created_idx`; RLS | DDL | tx on |
| 185 | decide_calibrations (`v185`) | [ai/decide/schema.ts] `decide_calibrations`, index `decide_calibrations_lookup_idx`; RLS | DDL | tx on |
| 186 | decide_proposals (`v186`) | [ai/decide/schema.ts] `decide_proposals`, `decide_sweep_deferred`; indexes `decide_proposals_pending_new_idx`, `_pending_old_idx`, `_status_created_idx`; RLS | DDL | tx on |
| 187 | fact_relink_attempts (`v187`) | [facts/relink-schema.ts] table `fact_relink_attempts` + `fact_relink_attempts_outcome_idx`; index `idx_facts_unlinked_active` ON facts(source_id, id) WHERE entity_slug IS NULL | DDL + IDX-ON | handler; TX-F; Postgres CONCURRENTLY |
| 188 | facts_ontology_stint_dedup (`v188`) | UNIQUE index `idx_facts_ontology_stint_dedup` (source_id, entity_slug, dimension, value_hash, source_markdown_slug, valid_from) WHERE dimension NOT NULL; DROP `idx_facts_ontology_dedup` | DDL index (plain, in tx) | tx on |
| 189 | pages_credential_projection_pending (`v189`) | `UPDATE pages SET text_projection_revision = NULL` for markdown/code pages whose body or timeline contains a PEM private-key block; INSERT `page_projection_jobs` (reason `credential_projection`) ON CONFLICT upsert | DATA | tx on |
| 190 | sources_upstream_observation (`v190`) | `sources.upstream_checked_at`, `upstream_commit`, `upstream_behind` | DDL | tx on |
| 191 | alias_source_cascade (`v191`) | `DELETE` orphan rows in `page_aliases` and `slug_aliases` whose source_id has no sources row; FK `page_aliases_source_fk`, `slug_aliases_source_fk` ON DELETE CASCADE NOT VALID; handler VALIDATE both (handler labels its runMigration call as 190, not 191) | DATA + DDL constraint | sql tx on; handler; verify hook |
| 192 | take_embedding_identity (`v192`) | `takes.embedding_model`, `takes.embedded_text_hash` | DDL | tx on |
| 193 | f1_write_attribution (`v193`) | [persistence/attribution-schema.ts] FN `gbrain_stamp_write_attribution`, `gbrain_stamp_revision_attribution`, `gbrain_stamp_version_attribution`; TRIGGERs `gbrain_write_attribution`, `pages_revision_attribution`, `page_versions_write_attribution`; [persistence/writer-guard-schema.ts] FN `gbrain_require_managed_writer`, TRIGGER `managed_writer_guard` | FN + TRIGGER | tx on |
| 194 | f0_worktree_refreshes (`v194`) | [persistence/worktree-refresh-schema.ts] table `persistence_worktree_refreshes`; UNIQUE index `persistence_worktree_refreshes_active`; index `_completed` | DDL | tx on |
| 195 | f3_access_token_grants (`v195`) | [grants/access-token-schema.ts] `access_tokens`: `allowed_operations`, `federated_read`, `grant_revision`, `source_grant`, `source_id`, `takes_holders` | DDL | tx on |
| 196 | f4_planner_stats (`v196`) | [planner-stats-schema.ts] PGLite only: tables `planner_stats_state`, `planner_stats_deltas`; FN `gbrain_count_modifications` | DDL (PGLite only) | sqlFor.pglite only; Postgres is a no-op (`sql: ''`) |
| 197 | managed_guard_null_source_fallback (`v197`) | FN `gbrain_require_managed_writer` redefined (null source fallback) [persistence/writer-guard-schema.ts] | FN redefine | tx on |
| 198 | publication_failure_detail (`v198`) | `persistence_requests.error_detail jsonb`; FN `gbrain_require_managed_writer` redefined | DDL + FN | tx on |
| 199 | chronicle_page_state (`v199`) | tables `chronicle_page_state` (FK sources, pages), `chronicle_judge_reservations`; indexes `chronicle_page_state_work_idx`, `_page_idx`, `chronicle_judge_reservations_at_idx`; RLS on both | DDL | tx on |
| 200 | sync_hold_page_index (`v200`) | index `op_checkpoints_sync_hold_page_idx` on expression `completed_keys->0->>'page_id'`, WHERE op='sync-hold' | DDL index (plain) | sqlFor.postgres adds `SET LOCAL` timeouts; tx on |
| 201 | persistence_graduation (`v201`) | [persistence/graduation-schema.ts] table `persistence_graduation`; FN `gbrain_graduation_fence` | DDL + FN | tx on |
| 202 | legacy_token_grant_conversion (`v202`) | [grants/legacy-token.ts:334 `migrateLegacyTokens`, dryRun false] converts legacy token grants into the unified grant columns; malformed permissions stay denied and are reported by doctor | DATA (handler) | handler; outside tx |
| 203 | oauth_client_grant_axes (`v203`) | [grants/oauth-client-axes-schema.ts] `oauth_clients.source_grant`, `takes_holders` | DDL | tx on |
| 204 | links_temporal_state (`v204`) | [link-temporal-schema.ts] `links.assertion_tense` + CHECK; tables `link_relationships`, `link_edge_proposals`, `link_transitions`; UNIQUE `link_transitions_identity_idx`; indexes `link_relationships_source_idx`, `_to_idx`, `link_transitions_origin_idx`, `_relationship_idx`, `link_edge_proposals_status_idx`; RLS | DDL | tx on |
| 205 | minion_spend_authorization (`v205`) | `minion_jobs.spend_authorization jsonb`, `spend_claim_token bigint`; index `idx_minion_jobs_spend_group`; `mcp_spend_reservations.budget_key`, `client_id` DROP NOT NULL, CONSTRAINT `mcp_spend_reservations_one_budget_owner`, index `idx_mcp_spend_reservations_budget_key`; `mcp_spend_log.budget_key`, CONSTRAINT `mcp_spend_log_one_budget_owner`, index `idx_mcp_spend_log_budget_key`; FN `enforce_minion_queue_protocol` (SET search_path) | DDL + FN | tx on |
| 206 | entity_mention_index (`v206`) | `page_aliases`: `origin` (default 'frontmatter'), `case_sensitive`, `alias_text`; UNIQUE `page_aliases_origin_uniq` (source_id, alias_norm, slug, origin); DROP `page_aliases_uniq`; tables `page_mention_state`, `mention_gazetteer_entries`, `mention_index_status` + index `page_mention_state_source_idx`; RLS x3 | DDL | tx on |
| 207 | retrieval_feedback (`v207`) | tables `retrieval_events`, `retrieval_event_pages`, `retrieval_event_links`, `retrieval_feedback` (CHECK element_kind page/link), `retrieval_weights`; indexes `retrieval_events_time_idx`, `retrieval_feedback_client_time_idx` | DDL | tx on |
| 208 | delta_per_arm_cursor (`v208`) | `session_context_state`: `facts_cursor_at`, `facts_cursor_id bigint`, `degraded_wakes int NOT NULL DEFAULT 0`; `UPDATE session_context_state SET facts_cursor_at = last_wake_at, facts_cursor_id = 0 WHERE facts_cursor_at IS NULL` | DDL + DATA | tx on |
| 209 | page_facts_reconcile (`v209`) | table `page_facts_reconcile` (PK page_id, FK pages) | DDL + RLS | tx on |
| 210 | clamp_oauth_token_ttl (`v210`) | handler `clampOAuthTokenTtls` (v210 file:27): one transaction, `SELECT ... FROM oauth_clients FOR UPDATE`, sets `token_ttl` and `grant_revision`; `UPDATE oauth_tokens SET expires_at` for access tokens beyond the max TTL; INSERT `oauth_grant_audit` rows | DATA (handler, own transaction) | handler |
| 211 | function_search_path (`v211`) | [facts/withdrawal-schema.ts] `FACT_FINGERPRINT_FUNCTION_STATEMENTS` (FN re-create); then loop over every public plpgsql function with NULL proconfig and not extension-owned: `ALTER FUNCTION ... SET search_path = pg_catalog, public` | FN hardening | tx on |
| 212 | decide_review_proposals (`v212`) | [ai/decide/schema.ts] `decide_review_queue`, `decide_review_proposals`; index `decide_review_proposals_status_idx`; RLS | DDL | tx on |
| 213 | core_edit_notices (`v213`) | [core-memory-schema.ts] `core_edit_notices` + `core_edit_notices_pending_idx`; RLS | DDL | tx on |
| 214 | wanted_links (`v214`) | table `wanted_links` (ref_kind CHECK slug/name; UNIQUE `wanted_links_reference_unique`); indexes `wanted_links_target_idx`, `_source_idx`, `idx_pages_slug_basename`; RLS | DDL | tx on; RLS conditional |
| 215 | facts_attributed_to (`v215`) | `facts.attributed_to TEXT` CHECK in (user, assistant, other); [persistence/attribution-schema.ts] attribution triggers | DDL + FN | tx on |
| 216 | chronicle_campaign_stamps (`v216`) | `chronicle_page_state`: `campaign_id`, `attempt_cap_usd`, `max_attempts` (CHECK > 0), `pricing_policy`, `campaign_max_usd`, `cost_attempts int[] DEFAULT '{}'` | DDL | tx on |
| 217 | persistence_request_claim_phase (`v217`) | `persistence_requests.claim_phase jsonb` | DDL | tx on |
| 218 | purge_legacy_worktree_manifest_files (`v218`) | `UPDATE persistence_worktrees SET manifest = (manifest - 'files') || {file_count}` where a `files` object exists; `UPDATE persistence_topology_changes SET recovery` the same way under `recovery.manifest` | DATA | tx on; declared idempotent (second run matches no row) |
| 219 | pages_reconcile_name_indexes (`v219`) | indexes `pages_source_path_name_idx` (source_id, basename of source_path, WHERE source_path NOT NULL), `pages_file_uri_name_idx` (source_id, basename of source_uri, WHERE file: uri) | IDX-ON | handler; TX-F |
| 220 | persistence_request_preparation_attempts (`v220`) | `persistence_requests.preparation_attempts int NOT NULL DEFAULT 0` CHECK >= 0 | DDL | tx on |
| 221 | chunk_embedding_pending_since (`v221`) | `content_chunks.embedding_pending_since`; DO block: `UPDATE content_chunks SET embedding_pending_since = created_at WHERE <active embedding column> IS NULL AND embedding_pending_since IS NULL` (active column from `config.search_embedding_column`); config marker `embedding_pending_since_backfilled_at` | DDL + DATA | tx on |
| 222 | persistence_consumers (`v222`) | [persistence/schema.ts] table `persistence_consumers`; index `PERSISTENCE_COMMITTED_WATERMARK_INDEX` via IDX-ON | DDL + IDX-ON | handler |
| 223 | persistence_serve_loop_indexes (`v223`) | IDX-ON `PERSISTENCE_SYNC_WATERMARK_INDEX`, `PERSISTENCE_COMPACTABLE_INDEX`; DROP `persistence_requests_committed_watermark` (CONCURRENTLY on Postgres) | IDX-ON + index drop | handler |
| 224 | page_retrievals (`v224`) | table `page_retrievals` (page_id PK); FN `gbrain_forget_page_retrievals` and statement-level TRIGGER `pages_forget_retrievals` (AFTER DELETE ON pages, REFERENCING OLD TABLE); `INSERT ... SELECT` from `pages.last_retrieved_at` with GREATEST upsert; handler DROP `pages_last_retrieved_at_idx` (CONCURRENTLY on Postgres) | DDL + FN + DATA + index drop | sql tx on; handler |
| 225 | drop_duplicate_embedding_null_index (`v225`) | handler: DROP `idx_chunks_embedding_null` only when its definition duplicates another index (compares `pg_get_indexdef` with the name stripped) | index drop | handler; kind branch (CONCURRENTLY on Postgres) |
| 226 | trust_tiers (`v226`) | [trust/schema.ts] `TRUST_SCHEMA_SQL`: table `trust_proposals` + indexes `trust_proposals_pending_unique`, `_pending_idx`, `_target_idx`; `page_versions.trust_tier`; FN `gbrain_stamp_trust_tier`, `gbrain_snapshot_version_trust`; FN `gbrain_require_managed_writer`; config `trust.backfill_completed_at` inserted only if pages, facts, takes and timeline_entries are all empty | DDL + FN + config seed | tx on |
| 227 | write_gate (`v227`) | [write-gate-schema.ts] tables `write_gate_holds`, `write_gate_receipts`; UNIQUE indexes `write_gate_holds_dedupe_idx`, `write_gate_receipts_target_idx`; indexes `_status_idx`, `_seen_idx`; RLS; config `write_gate.scan_baseline` seeded with max id of pages, facts, takes, timeline_entries | DDL + config seed | tx on |
| 228 | memory_purge (`v228`) | [facts/purge-schema.ts] tables `fact_purges`, `page_purges`, `take_purges`, `derivation_inputs`, `needs_rederive`; index `idx_derivation_inputs_input`; FN `gbrain_refuse_purged_fact/page/take`; TRIGGERs `facts_refuse_purged`, `pages_refuse_purged`, `takes_refuse_purged`; RLS | DDL + FN + TRIGGER | tx on |
| 229 | trust_allow_rules (`v229`) | [trust/allow-rules.ts] `trust_allow_rules`, UNIQUE `trust_allow_rules_active_unique`, index `trust_allow_rules_active_idx` | DDL | tx on |
| 230 | trust_generation (`v230`) | [eligibility/generation-schema.ts] `BUMP_FUNCTION`: FN `gbrain_bump_trust_generation` (line 30 `TRUST_GENERATION_FUNCTION`) and its per-table triggers (line 88); RLS on one table | DDL + FN + TRIGGER | tx on |
| 231 | fact_purge_lookup_indexes (`v231`) | IDX-ON `fact_purges_subject_idx`, `fact_purges_all_subjects_idx` [facts/purge-schema.ts] | IDX-ON | handler |
| 232 | fts_cjk_boundary (`v232`) | FN re-create `FTS_INPUT_FUNCTION_SQL`, page and chunk search-vector trigger functions for `getFtsLanguage()`; handler `backfillPageVectors` and `backfillChunkVectors` for rows matching the CJK-boundary regex (checkpointed); unsetConfig of both checkpoints | FN + DATA (search-vector rebuild) | handler; batches outside tx |
| 233 | oauth_client_registered_via (`v233`) | `oauth_clients.registered_via TEXT`; CONSTRAINT `oauth_clients_registered_via_check` CHECK ('dcr') NOT VALID then VALIDATE | DDL constraint | tx on |
| 234 | persistence_git_durability (`v234`) | [persistence/schema.ts] `persistence_host_bindings.git_durability` | DDL | sqlFor.postgres adds `SET LOCAL` timeouts; verify hook; tx on |
| 235 | pinned_questions (`v235`) | [questions/schema.ts] tables `pinned_questions`, `question_evidence`; indexes `pinned_questions_state_idx`, `question_evidence_question_idx`; RLS; handler `migrateAutoThinkToPins` [questions/auto-think-migration.ts:76] | DDL + DATA (handler) | sql tx on; handler |
| 236 | open_loops_counterparty_source (`v236`) | [loops/loops-schema.ts] `open_loops.counterparty_source_id`; IDX-ON `open_loops_counterparty_source_idx` | DDL + IDX-ON | sql tx on; handler |
| 237 | facts_question_recall_indexes (`v237`) | IDX-ON `idx_facts_unembedded` (WHERE expired_at NULL AND (embedding NULL OR hash mismatch)), `idx_facts_embedding_model`; `ensureFactsFtsIndex` [facts/fts-index.ts] builds `idx_facts_fts` | IDX-ON | handler |
| 238 | persistence_client_request_id (`v238`) | `persistence_requests.client_request_id text` | DDL | tx on |
| 239 | extract_rollup_halt_reasons (`v239`) | `extract_rollup_7d` columns for halt reasons | DDL | tx on |
| 240 | pages_name_lookup_indexes (`v240`) | IDX-ON `idx_pages_source_title_lower` (source_id, lower(title)); IDX-ON GIN `idx_pages_slug_trgm` (slug gin_trgm_ops, needs pg_trgm) | IDX-ON | handler; TX-F |
| 241 | persistence_request_slug_intent_index (`v241`) | IDX-ON `PERSISTENCE_REQUEST_SLUG_INTENT_INDEX` | IDX-ON | handler; TX-F |
| 242 | extract_atoms_partial_input (`v242`) | `extract_atoms_page_state` and `extract_atoms_transcript_state` columns for partial input | DDL | tx on |
| 243 | persistence_consumer_process_start (`v243`) | `persistence_consumers.boot_id`, `process_start` | DDL | tx on |
| 244 | chunk_projected_spans (`v244`) | `content_chunks.projected_byte_start`, `projected_byte_end` (bigint) | DDL | tx on |
| 245 | page_search_vector_bounded_timeline (`v245`) | FN page search-vector trigger re-create with `PAGE_TIMELINE_FTS_MAX_CHARS`; handler `backfillPageVectors` for pages with timeline over half the cap (checkpointed) | FN + DATA (search-vector rebuild) | handler |
| 246 | page_embedding_budget (`v246`) | table `page_embedding_budget` (PK page_id); index `page_embedding_budget_state_idx` WHERE state <> 'open' | DDL | tx on |
| 247 | page_extraction_state (`v247`) | table `page_extraction_state` (page_id, pipeline); index `page_extraction_state_truncated_idx` WHERE input_truncated NOT NULL | DDL | tx on |
| 248 | segmented_page_storage (`v248`) | [page-body/schema.ts] `PAGE_BODY_SCHEMA_SQL` (`page_body_manifest`, `page_body_stagings`, `page_segment_texts`, `page_body_staging_parts`, etc.) and `PAGE_GENERATION_BUMP_FN_SQL`; `pages`: `body_storage` (default 'inline'), `body_bytes`, `truth_bytes`, `body_lines`, `body_generation` (default 0), `segment_count`, `segmenter_version`, `body_flags`, `truth_lead`, `timeline_lead`; `compiled_truth` and `timeline` DROP NOT NULL; CONSTRAINT `pages_body_storage_chk`. `content_chunks`: `occurrence_id`, `local_ordinal`, `raw_byte_start`, `raw_byte_end`, `body_generation`, `retired_generation`. `page_versions`: `compiled_truth` DROP NOT NULL, `body_storage`, `body_generation`; CONSTRAINT `page_versions_body_chk`. Handler: VALIDATE both CHECKs, IDX-ON `content_chunks_occurrence_idx`, Postgres ANALYZE of `pages(body_generation)` and `content_chunks` | DDL + constraints + IDX-ON + ANALYZE. No UPDATE or INSERT in the file (grep), so existing pages are not rewritten here | sqlFor.postgres and sqlFor.pglite (both `COMMON_SQL` plus a branch); TX-F; handler |
| 249 | belief_ledger (`v249`) | [belief/schema.ts] tables `belief_events`, `belief_page_lifetimes` (UNIQUE `belief_page_lifetimes_open`), `belief_redactions`, `belief_commit_marks`, `belief_retier_manifest` + indexes (`belief_events_*`, `belief_redactions_*`, `belief_page_lifetimes_slug`); RLS; `sources.purge_epoch`; handler IDX-ON `idx_facts_belief_stream` | DDL + IDX-ON | sql tx on; handler |
| 250 | persistence_request_id_index (`v250`) | IDX-ON `PERSISTENCE_REQUEST_ID_INDEX` | IDX-ON | handler; TX-F |
| 251 | take_horizons (`v251`) | table `take_horizons` (take_id PK FK takes); index `take_horizons_date_idx` | DDL | tx on |
| 252 | segmented_chunk_gc_index (`v252`) | IDX-ON `content_chunks_generation_idx` (page_id, body_generation WHERE NOT NULL) | IDX-ON | handler; TX-F |
| 253 | page_view_digests (`v253`) | table `page_view_digests` (page_id FK) | DDL | tx on |
| 254 | segment_reader_marks (`v254`) | `persistence_requests.admitter_segment_reader`, `consumer_segment_reader`; `persistence_consumers.segment_reader`; `ingest_log.writer_version`, `writer_host_id`, `writer_segment_reader`; IDX-ON `ingest_log_unmarked_idx` | DDL + IDX-ON | handler; TX-F |
| 255 | page_body_staging_texts (`v255`) | [page-body/schema.ts] `PAGE_BODY_STAGING_TEXTS_SQL` (table `page_body_staging_texts`, index `page_body_staging_texts_text`); `content_chunks.retired_generation` | DDL | tx on |
| 256 | chunk_retirement_index (`v256`) | IDX-ON `content_chunks_occurrence_generation_idx` (page_id, occurrence_id, body_generation) | IDX-ON | handler; TX-F |
| 257 | pages_live_origin_key (`v257`) | handler `buildOriginIndexIfClean` [persistence/origin-index.ts]: builds the live-origin unique index on pages only when no source has duplicate-origin groups; otherwise defers with a notice and changes nothing | IDX-ON (conditional) | handler; TX-F |
| 258 | pages_links_extract_failure (`v258`) | `pages.links_extract_failure jsonb` | DDL | tx on |
| 259 | ingest_log_marked_index (`v259`) | IDX-ON `ingest_log_marked_idx` (created_at WHERE writer_segment_reader IS TRUE) | IDX-ON | handler; TX-F |
| 260 | segmented_page_size_index (`v260`) | IDX-ON `pages_segmented_body_bytes_idx` (body_bytes WHERE body_storage='segmented') | IDX-ON | handler; TX-F |
| 261 | persistence_request_transient_retries (`v261`) | `persistence_requests.transient_interruptions int NOT NULL DEFAULT 0`, `next_attempt_at timestamptz` | DDL | tx on |
| 262 | commit_notifier (`v262`) | tables `sync_wanted_markers`, `sync_notifier_leases`, `sync_notifier_sources` | DDL | tx on |
| 263 | try_jsonb_function (`v263`) | FN `gbrain_try_jsonb(text) RETURNS jsonb` (IMMUTABLE STRICT, SET search_path) | FN | tx on |
| 264 | set_based_fact_insert_guards (`v264`) | [persistence/attribution-schema.ts] `STAMP_ROW_FUNCTION`; [facts/insert-guard-schema.ts] FN `gbrain_guard_inserted_facts`; TRIGGERs `facts_guard_inserted`, `facts_refuse_purged`, `facts_preserve_withdrawal_insert` | FN + TRIGGER | tx on |
| 265 | derived_generations (`v265`) | tables `derived_generations`, `derived_generation_items`, `derived_generation_valve`, `derived_generation_attempts`; UNIQUE partial `derived_generations_one_live`, `derived_generations_one_hold`; indexes `_operation`, `_state_created`, `derived_generation_items_key`, `derived_generation_attempts_key` | DDL | tx on |
| 266 | derived_generation_activations (`v266`) | `derived_generations.locator`, `activation_id`; `derived_generation_items.pending bool NOT NULL DEFAULT false` + partial index `derived_generation_items_pending`; table `derived_generation_activations` + index `derived_generation_activations_key` | DDL | tx on |
| 267 | pages_title_search_index (`v267`) | IDX-ON GIN `idx_pages_title_search` on `ts_filter(search_vector, '{a}')` | IDX-ON | handler; TX-F |
| 268 | effect_claim_owner (`v268`) | `persistence_effects.claim_owner jsonb` | DDL | tx on |
| 269 | links_supersedes_index (`v269`) | IDX-ON `idx_links_supersedes_to` (to_page_id WHERE link_type='supersedes') | IDX-ON | handler; TX-F |
| 270 | pages_source_created_index (`v270`) | IDX-ON `pages_source_created_idx` (source_id, created_at WHERE deleted_at NULL) | IDX-ON | handler; TX-F |
| 271 | facts_superseded_by_index (`v271`) | IDX-ON `idx_facts_superseded_by` | IDX-ON | handler; TX-F |
| 272 | git_canonical_declared (`v272`) | [persistence/git-canonical-schema.ts] table `git_canonical_brain` + RLS; FN `gbrain_count_git_canonical_sources`; TRIGGERs `git_canonical_sources_count_insert/update/delete` on sources; FN `gbrain_require_managed_writer` | DDL + FN + TRIGGER | tx on |
| 273 | segment_derivations (`v273`) | [page-body/schema.ts] `PAGE_SEGMENT_DERIVATIONS_SQL` (`page_segment_derivations`, `page_segment_derivation_purges`, `page_segment_derivation_purge_pages`, index `page_segment_derivations_unsettled`); `facts.source_window jsonb`; CHECK `facts_source_window_chk` NOT VALID, then handler VALIDATE | DDL + constraint | sql via runMigrationStatement; TX-F |
| 274 | pages_withheld_source_path (`v274`) | `pages.withheld_source_path text` | DDL | tx on |
| 275 | rls_backfill_unguarded_tables (`v275`) | handler `protectTables` (v275 file:111): ENABLE ROW LEVEL SECURITY on each listed gbrain table where it is off, the current role owns it, and the table comment is not exempt; one short transaction per table with SET LOCAL timeouts | RLS | handler; TX-F; Postgres only (no-op on PGLite) |
| 276 | persistence_foreground_committed_index (`v276`) | IDX-ON `PERSISTENCE_FOREGROUND_COMMITTED_INDEX` | IDX-ON | handler; TX-F |
| 277 | function_search_path_pg_temp (`v277`) | handler `hardenFunctionSearchPaths` [function-search-path.ts:100]: adds pg_temp to function search_path for gbrain functions | FN hardening | handler; TX-F |
| 278 | writer_fence_fail_closed (`v278`) | FN re-create: `gbrain_require_managed_writer`, `gbrain_count_git_canonical_sources`, `gbrain_guard_request_protocol`, `gbrain_guard_effect_protocol`, `gbrain_guard_protocol_activation` (shared-skills and persistence guard bodies) | FN redefine | tx on |
| 279 | outcome_markers_skip_purge_guard (`v279`) | FN `gbrain_guard_inserted_facts` re-create (FACT_INSERT_GUARD_FUNCTION_SQL) | FN redefine | tx on |
| 280 | principal_private_pages (`v280`) | `access_tokens.private_pages` and `oauth_clients.private_pages` TEXT NOT NULL DEFAULT 'none' | DDL | tx on |
| 281 | derived_state_maintainers_fail_closed (`v281`) | FN re-create (7 functions): `gbrain_forget_page_retrievals`, `gbrain_clear_atom_page_state`, tag revision, snapshot version, stamp version, page projection queue, `gbrain_bump_trust_generation` (`BUMP_FUNCTION`); handler re-runs the page search-vector trigger function | FN redefine | sql tx on; handler |
| 282 | member_read_access (`v282`) | tables `access_members`, `access_groups`, `access_group_members` (+ index `access_group_members_member_idx`); `pages.page_readers TEXT[]`; `access_tokens` and `oauth_clients`: `member_id`, `may_act_for TEXT[]`; FN `gbrain_access_norm_readers`, `gbrain_access_readers`, `gbrain_access_origin_restricted`, `gbrain_access_mark_restricted`, `gbrain_access_derive_page_readers`; TRIGGERs `pages_access_derive_readers`, `pages_access_mark_restricted`, `access_members_mark_restricted`; config `access.restrictions_present` = '1' when any page has `readable_by` or any member exists; RLS. The file says nothing is rewritten on upgrade (comment at v282 lines 9-16) | DDL + FN + TRIGGER + config seed | tx on |
| 283 | folder_access_rules (`v283`) | `pages.folder_rule_ids TEXT[]`; tables `access_policy_state`, `access_rules`, `access_policy_revisions` (UNIQUE partial `access_policy_revisions_operation_idx`), `access_pending_coverage`, `access_policy_migrations`; FN `gbrain_access_folder_rules`, `gbrain_access_state_unreadable`, `gbrain_access_pending_covers`, `gbrain_access_stamp_folder_rules`; TRIGGER `pages_access_stamp_folder_rules` (BEFORE INSERT/UPDATE OF slug, source_id, folder_rule_ids); FN `gbrain_access_origin_restricted` re-create | DDL + FN + TRIGGER | tx on |
| 284 | access_page_indexes (`v284`) | IDX-ON GIN `pages_page_readers_gin` (WHERE page_readers NOT NULL), GIN `pages_folder_rule_ids_gin` | IDX-ON | handler; TX-F |
| 285 | slug_rename_history (`v285`) | table `slug_rename_history` (source_id FK) + index `slug_rename_history_new_idx`; FN `gbrain_access_state_unreadable` and `gbrain_access_origin_restricted` re-create | DDL + FN | tx on |
| 286 | qm_actor_links (`v286`) | table `access_member_links` + index `access_member_links_member_idx`, RLS; `access_tokens` and `oauth_clients`: `attest_actor`, `attest_ops TEXT[]`; `oauth_tokens.grant_type` | DDL | tx on |
| 287 | multi_page_recovery_record (`v287`) | [shared-skills/persistence-schema.ts] `REQUEST_PROTOCOL_GUARD_V287_SQL` (persistence request protocol guard FN redefinition) | FN redefine | tx on |
| 288 | decide_proposals_claim_pair_index (`v288`) | [ai/decide/schema.ts] UNIQUE index `decide_proposals_claim_pair_uidx` | DDL index (plain) | tx on |
| 289 | page_change_reasons (`v289`) | `page_versions.change_reason`, `successor_pruned`; `pages.version_history_gap_at`; table `reason_purge_tombstones` (FK sources), RLS | DDL | tx on |
| 290 | wake_subscriptions (`v290`) | table `wake_subscriptions` (principal_kind CHECK oauth_client/legacy_token/local_stdio); indexes `wake_subscriptions_open_idx` (partial), `_principal_idx`, UNIQUE partial `wake_subscriptions_open_unique`; RLS | DDL | tx on |
| 291 | persistence_request_replay_indexes (`v291`) | IDX-ON `PERSISTENCE_REQUEST_REPLAY_ID_INDEX`, `PERSISTENCE_REQUEST_SLUG_SEQUENCE_INDEX` | IDX-ON | handler; TX-F |
| 292 | refresh_write_barrier (`v292`) | `persistence_worktree_refreshes.barrier_sequence bigint`, `released_at timestamptz`; `UPDATE ... SET released_at = COALESCE(completed_at, updated_at) WHERE state IN (completed, aborted) AND released_at IS NULL`; `persistence_requests.deferred_refresh_id uuid` + FK `persistence_requests_deferred_refresh_id_fkey`; `persistence_consumers.capabilities text[] DEFAULT '{}'`; FN `gbrain_release_refresh_barrier` + TRIGGER `gbrain_refresh_release` (BEFORE UPDATE OF state); FN `gbrain_guard_deferred_request` + TRIGGER `gbrain_request_deferred` (BEFORE UPDATE OF state on persistence_requests); DROP/re-add `persistence_requests_state_check`; IDX-ON `persistence_requests_open` | DDL + DATA + FN + TRIGGER + index | sqlFor.postgres and sqlFor.pglite; TX-F; handler |
| 293 | qm_attest_sources (`v293`) | `access_tokens.attest_sources`, `oauth_clients.attest_sources` (TEXT[]) | DDL | tx on |
| 294 | refresh_barrier_import_deferral (`v294`) | `persistence_requests.deferred_import_from text`; FN `gbrain_guard_deferred_request` re-create | DDL + FN | tx on |
| 295 | refresh_retry_hint_history_index (`v295`) | index `persistence_worktree_refreshes_completed` (worktree_id, completed_at DESC WHERE state='completed') | DDL index (plain) | tx on |
| 296 | ingest_applied_captures (`v296`) | table `ingest_applied_captures` (idempotency_key PK) + index `ingest_applied_captures_applied_at_idx`; INSERT ... SELECT DISTINCT ON (idempotency_key) from completed `ingest_capture` jobs (non-tombstone), ON CONFLICT DO NOTHING; RLS | DDL + DATA | tx on |
| 297 | chronicle_judge_window (`v297`) | `chronicle_page_state`: `judge_input_hash`, `judge_window_chars` (CHECK >= 0), `judge_window_hash`, `judge_input_failures int NOT NULL DEFAULT 0` (CHECK >= 0) | DDL | tx on |
| 298 | attest_read (`v298`) | `access_tokens.attest_read`, `oauth_clients.attest_read` (TEXT) | DDL | tx on |
| 299 | access_member_sources (`v299`) | table `access_member_sources` (member_id FK) + index `access_member_sources_source_idx`; RLS | DDL | tx on |
| 300 | memory_proposals (`v300`) | table `memory_proposals` (PK principal_kind, principal_id, request_id; kind CHECK timeline/link); indexes `memory_proposals_request_idx`, `_pending_actor_idx`, `_pending_source_idx` (partial awaiting_owner), `_closed_idx`; RLS | DDL | tx on |
| 301 | member_email (`v301`) | `access_members.email TEXT`; UNIQUE index `access_members_email_key` | DDL | tx on |
| 302 | link_transitions_source (`v302`) | `link_transitions.link_source TEXT`; IDX-ON `link_transitions_identity_next_idx` (UNIQUE ... NULLS NOT DISTINCT over origin_page_id, from/to, link_type, link_source, kind, occurred_on, producer); then one transaction: DROP `link_transitions_identity_idx`, RENAME next index to `link_transitions_identity_idx`; lock-timeout handling; throws if another session is building it | DDL + IDX-ON + index rename | TX-F; handler; kind branches (Postgres timeouts) |
| 303 | access_page_rules (`v303`) | CONSTRAINT `access_rules_prefix_check` and `access_pending_coverage_prefix_check` replaced with folder-or-page check; FN `gbrain_access_folder_rules` re-create (trailing '/' or exact match); FN `gbrain_access_pending_covers` re-create | DDL constraint + FN | tx on |
| 304 | access_owner_origin (`v304`) | FN `gbrain_access_origin_closed_for` (new), `gbrain_access_origin_hidden_for` (new) (plpgsql); pending-coverage and alias/rename resolution | FN | tx on |
| 305 | access_lineage_designs (`v305`) | `access_rules.covers_derived BOOLEAN NOT NULL DEFAULT true`; `access_members.kind TEXT NOT NULL DEFAULT 'person'` + CHECK in (person, audience); FN `gbrain_access_lineage_rules` (new); FN `gbrain_access_origin_restricted` re-create | DDL + FN | tx on |
| 306 | member_page_withdrawal_scope (`v306`) | [facts/withdrawal-schema.ts] `FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL`; [facts/insert-guard-schema.ts] `FACT_INSERT_GUARD_FUNCTION_SQL` (FN re-creates) | FN redefine | tx on |
| 307 | page_label_guards (`v307`) | table `page_label_guards` (page_id PK FK pages); RLS | DDL | tx on |
| 308 | access_labelled_only (`v308`) | `access_members.labelled_only BOOLEAN NOT NULL DEFAULT false`; FN `gbrain_access_origin_labelled_for` (new) | DDL + FN | tx on |
| 309 | requester_scope (`v309`) | `access_tokens.reads_unscoped`, `oauth_clients.reads_unscoped` (TIMESTAMPTZ); FN `gbrain_access_refresh_serves` (new, sets config `access.serves_derived`) and `gbrain_access_refresh_serves_trigger`; TRIGGERs `access_members_refresh_serves` (AFTER INSERT/DELETE/UPDATE OF disabled_at, tombstoned_at), `config_serves_refresh` and `config_serves_refresh_delete` on config; config `access.serves_since` inserted; `UPDATE config SET value = derived` | DDL + FN + TRIGGER + config seed | tx on |
| 310 | mcp_request_log_rollup (`v310`) | table `mcp_request_log_rollup`; RLS | DDL | tx on |
| 311 | concept_inputs_private (`v311`) | FN `gbrain_concept_inputs_private(page_id) RETURNS boolean` (new) | FN | tx on |
| 312 | guest_notes (`v312`) | [guests/schema.ts] `GUEST_NOTES_SCHEMA_SQL`: tables `guest_marks`, `guest_promotions`, `guest_sources`; indexes `guest_marks_audience_saved_idx`, `guest_promotions_guest_page_idx`; TRIGGERs `guest_marks_immutable`, `guest_source_database_only`; FN `gbrain_guard_guest_records`; RLS; [trust/schema.ts] `GUEST_AWARE_STAMP_TIER_FUNCTION` | DDL + FN + TRIGGER | tx on |
| 313 | wake_events (`v313`) | `wake_subscriptions.target_ref TEXT`; tables `wake_crons`, `wake_cron_runs` (+ index `wake_cron_runs_name_idx`), `wake_terms_acceptances`, `wake_forgets` (UNIQUE partial `wake_forgets_pending_unique`, index `wake_forgets_due_idx`); RLS x4 | DDL | tx on |
| 314 | guest_notes_fail_closed (`v314`) | FN `gbrain_guard_guest_records` and `GUEST_FAIL_CLOSED_STAMP_TIER_FUNCTION` re-create; DO block: UNIQUE index `guest_promotions_link_key` (guest_page_id, target_source_id, target_slug) if no duplicates, else RAISE WARNING and no index | FN + conditional index | tx on |
| 315 | facts_context_head_index (`v315`) | IDX-ON `idx_facts_context_head` (source_id, md5(split_part(context, ' — ', 1)) WHERE source_markdown_slug IS NULL) | IDX-ON | handler |
| 316 | pages_source_type_index (`v316`) | IDX-ON `idx_pages_source_type` (source_id, type WHERE deleted_at NULL) | IDX-ON | handler |
| 317 | pages_projection_waiting_index (`v317`) | IDX-ON `idx_pages_projection_waiting` (partial: text projection revision differs from knowledge revision and from ACTIVATION_SERVED_REVISION) | IDX-ON | handler |
| 318 | guard_ledgers_fail_closed (`v318`) | handler `failClosedLedgerGuards` [guard-ledger-checks.ts:32]: finds purge and withdrawal guard functions that read their ledgers as empty for a write role without ledger policy; writes a stderr instruction to `ALTER FUNCTION ... OWNER TO` the role; no data change | FN ownership (handler only) | handler |

### Patterns

#### Data backfills a Rust port must reproduce for upgrade-from-existing-brain

These change existing rows or seed state. A fresh Rust schema has none of them, so each needs an upgrade-path equivalent (or a one-shot upgrade step):

| Ver | What it changes on an existing brain |
|---|---|
| 163 | Seed `extract_atoms_page_state` from live pages with valid content_hash |
| 176 | Re-key `managed-connector` and `managed-connector-retry` op_checkpoints to stable identity (TS, `connector-checkpoint-migration.ts:127`) |
| 178 | Set `persistence_brain.writer_version_cutoff = now()` where null |
| 181 | Record a connector sync attempt for each active google/github source with a local_path (`connector-state.ts:165`) |
| 189 | Clear `text_projection_revision` and enqueue `credential_projection` jobs for pages containing PEM private-key text |
| 191 | Delete orphan `page_aliases`/`slug_aliases` rows; add and validate source FKs with ON DELETE CASCADE |
| 202 | Convert legacy token grants into unified grant columns (`grants/legacy-token.ts:334`) |
| 208 | Seed `facts_cursor_at` / `facts_cursor_id` from `last_wake_at` |
| 210 | Clamp `oauth_clients.token_ttl` and shorten over-long access-token `expires_at`; write `oauth_grant_audit` rows (own transaction) |
| 218 | Rewrite `persistence_worktrees.manifest` and `persistence_topology_changes.recovery.manifest`: drop `files`, set `file_count` |
| 221 | Set `content_chunks.embedding_pending_since = created_at` where the active embedding is NULL; config marker |
| 224 | Seed `page_retrievals` from `pages.last_retrieved_at` (GREATEST upsert) |
| 226, 227, 282, 309 | Config seeds: `trust.backfill_completed_at`, `write_gate.scan_baseline` (max ids), `access.restrictions_present`, `access.serves_derived` / `access.serves_since` |
| 232, 245 | Rebuild page and chunk keyword search vectors with new FTS input functions (CJK boundary; bounded timeline), checkpointed |
| 235 | `migrateAutoThinkToPins` (`questions/auto-think-migration.ts:76`) |
| 292 | Backfill `persistence_worktree_refreshes.released_at` for completed or aborted rows |
| 296 | Seed `ingest_applied_captures` from completed `ingest_capture` jobs |

Not in migrations, but a related port risk: `v282` says nothing is rewritten on upgrade. Existing pages get `page_readers` and `folder_rule_ids` only through the repair paths (`core/repair/access.ts:20-35`, `core/access/policy.ts:200-213`). A Rust upgrade must either run the same derivation or accept NULL until repair.

#### Pure DDL that a fresh Rust schema can collapse

Most of the 158 migrations are DDL only. A fresh Rust schema can take the final state directly:

- Plain add-column, add-table, and add-index migrations (most rows above, e.g. 166, 171, 175, 177, 180, 182, 190, 192, 220, 238, 243, 244, 246, 247, 251, 253, 258, 261, 262, 268, 274, 280, 289, 293, 298, 301, 307, 310, 313 and similar). Their output is simply part of the final table definition.
- Function and trigger redefinitions: keep only the last definition. Many functions are redefined several times across the range:
  - `gbrain_access_origin_restricted`: 282, 283, 285, 305.
  - `gbrain_access_folder_rules`: 283, 303.
  - `gbrain_access_state_unreadable`: 283, 285.
  - `gbrain_require_managed_writer`: 193, 197, 198, 226, 272, 278.
  - `gbrain_guard_deferred_request`: 292, 294.
  - `gbrain_guard_inserted_facts`: 264, 279.
  - `gbrain_guard_guest_records`: 312, 314.
  - `gbrain_fact_*` and `FACT_INSERT_GUARD` / `FACT_WITHDRAWAL_PRESERVE`: 169/174, 211, 306.
  - The search-vector trigger function: 232, 245, 281.
- Constraints added as NOT VALID and then VALIDATE: 167, 191, 233, 273. Keep only the validated end state.
- Index build and drop sequences that exist only for online rebuild on Postgres: 165, 170, 172, 173, 179, 187, 219, 222, 223, 224, 225, 231, 240, 241, 250, 252, 254, 256, 257, 259, 260, 267, 269, 270, 271, 276, 284, 291, 302, 315, 316, 317. The final index set is all a fresh schema needs. Dropped indexes need no entry: `idx_facts_ontology_dedup` (188), `persistence_requests_committed_watermark` (223), `pages_last_retrieved_at_idx` (224), `idx_chunks_embedding_null` (225), and the old `link_transitions_identity_idx` (302, replaced by the NULLS NOT DISTINCT version).
- RLS enables: collapse to enabled-on-every-gbrain-table (v275 is the backfill). The conditional `rolbypassrls` guard exists only for Postgres roles, and RLS does not exist in an embedded engine.
- PGLite-only (196) and Postgres-only (275, 248 ANALYZE) branches: drop them.

Keep the handler-only migrations' effect (non-transactional, after SQL) in mind: a migration whose SQL is empty and whose effect is in the handler will run that effect again on a retry.

### Parity risks noted

- Access-control state is enforced by SQL functions and triggers (v282 through v318 define `gbrain_access_*`, `gbrain_guard_*`, `gbrain_refuse_purged_*`, `*_refresh_serves`). Embedded storage without RLS must reproduce these checks in Rust or the access model silently changes.
- Row-level security is enabled conditionally on `rolbypassrls`/`rolsuper`, and v275 and v318 depend on the database role's ownership of functions. Neither concept exists in an embedded engine. Their intent (deny-by-default on write roles) must be ported explicitly.
- `v282` relies on `config.access.restrictions_present` (sticky flag set by trigger) to keep pre-upgrade read paths. Losing the sticky semantics changes read behavior for brains without restrictions.
- `v282` and `v283` do not backfill existing rows. Pages carry NULL `page_readers` and `folder_rule_ids` until `core/repair/access.ts` or `core/access/policy.ts` runs. A Rust upgrade that skips these repairs leaves restricted pages readable.
- `v210` runs its own transaction with `FOR UPDATE` on oauth_clients and shortens token lifetimes. Behavior is observable to clients.
- Handler-only work (v165, v170, v176, v181, v202, v210, v223, v231, v232, v235, v245, v257, v275, v277, v302 index rename step, v318) runs outside the SQL transaction. The runner calls the handler after the SQL (`migrate.ts:589-591`). A crash partway leaves partial effects, and the version is not stamped until the whole migration succeeds; Rust needs idempotent re-runs.
- `v302` builds a NULLS NOT DISTINCT unique index and renames it while the old one is dropped; `v257` builds a unique live-origin index only when duplicates are absent. Rust needs the same uniqueness semantics or it will accept duplicate origin rows.
- `v188` and `v302` change unique-index definitions in place; `v188` adds a unique index that fails on existing duplicates (no pre-check). Upgrade paths can fail where a fresh schema would not.
- `v232` and `v245` rebuild search vectors from a PL/pgSQL trigger that uses `getFtsLanguage()` and CJK regexes. Rust's FTS tokenizer must match on existing brains or search results drift.
- `v248` changes `pages.compiled_truth` and `timeline` to NULL-able and adds segmented-body storage with `body_storage` default 'inline'. The migration file has no UPDATE or INSERT (grep), so existing pages are not rewritten. Confirm the Rust port keeps inline bodies valid.
- `v249` belief ledger, `v262` commit notifier, `v265`/`v266` derived generations, and `v273` segment derivations use long-lived lock and generation state. Their semantics are not in the SQL alone; the Rust port must model the same leases.
- `v226` seeds `trust.backfill_completed_at` only when pages, facts, takes and timeline_entries are all empty; `v227` seeds `write_gate.scan_baseline` from current max ids. A Rust fresh install and an upgrade must set these markers the same way or the upgrade gate changes.
- `v221` and `v224` backfill from `created_at` and `last_retrieved_at` at upgrade time, so exact timestamps are a parity point.
- Several migrations depend on Postgres `pg_trgm` (v240 `gin_trgm_ops`), `NULLS NOT DISTINCT` (v302), `md5()` expression indexes (v315), and PL/pgSQL `pg_proc` introspection (v211, v277). An embedded replacement needs equivalent indexes or a different lookup path.
- `v313` and `v290` depend on wake subscriptions and cron state with `FOR UPDATE`-style semantics that the Rust engine must reproduce for correctness.


---

