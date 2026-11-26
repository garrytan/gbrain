# executeRaw calls on the CLI import path and seven read commands

Research map, pinned to `rust-cli-parity` at `889e2bdf97` (on master `aca965d45a`). It lists each
`executeRaw` call that a real CLI run makes on a PGLite brain, and the typed `BrainEngine` member that can replace
it on a Rust brain. On a Rust brain `executeRaw` is not implemented (capability `raw_sql`), so every call below
that is not already inside a typed member refuses with `engine_capability_missing`.

## Counts

| Class | Sites | Meaning |
|---|---:|---|
| covered by scope B | 15 | A typed member for the call exists on `typed-import-search` at `5492962200`. 13 calls already use it there; 2 calls do not yet. |
| existing typed member | 7 | A member on master already returns the same rows. The call site can switch with no new engine code. |
| new member needed | 39 | No member returns these rows. A new typed member (or an extended one) is needed. |
| total to move | 61 | |
| already inside a typed member | 24 | The SQL runs inside the PGLite code of a member that Rust implements natively. Excluded. |
| schema group | 68 | Migration-runner SQL under `initSchema`. Covered by the existing `initSchema` member. Excluded. |
| traced sites | 153 | 1,041 calls in all. |

Scope B is branch `typed-import-search` at `5492962200`. It is still in progress. A call is "covered by scope B"
only when the member exists on that commit; the member name is in the table.

## Method

- Fixture: the 20-page brain in `test/fixtures/rust-cli-parity-brain/`, imported into a fresh PGLite brain.
- Commands, in order: `import` (fresh brain), `extract all --source db`, then `search-exact`, `wanted`, `whois`,
  `rank-entities`, `recall`, `sources list`, `extraction-pending`, and `whoami` as a connect-only control.
  The arguments match `test/rust-cli-parity.serial.test.ts`. All ten runs exit 0.
- A scratch patch (never committed) to the PGLite `executeRaw` logs the SQL text and the JavaScript stack of every
  call. The same run was repeated on scope B (775 calls, 140 sites) to find the calls it moves.
- A site is the first stack frame outside the engine and the SQL helpers. Lines are `rust-cli-parity` lines, which
  match master for every file listed.
- A call is "already inside a typed member" when its stack passes through a `BrainEngine` method other than
  `transaction`, for example `replaceDerivedLinksBatch` or `putPage`. A call is in the schema group when its stack
  passes through the migration runner.
- Scope B is compared by file and SQL text: 13 sites are gone on scope B, and no site is new.

## Limits

- One fixture and one run per command: branches that the fixture does not take are not traced. Examples: the
  catch fallback at `source-resolver.ts:386`, the lag-read retries in `extraction-lag.ts`, and the `plan_cache_mode`
  `set_config` call that scope B still has in `belief/ledger.ts:105`.
- `import` ran on a fresh brain, so its schema group is large. A second import on a current brain skips it.
- "Existing typed member" means the same rows; some of these members read more than the call needs. The notes say
  so.
- `source-resolver.ts:358` swallows its error (`.catch(() => null)`), so on a Rust brain a refusal there falls back
  silently. `whoami` was equal on both engines for this reason. Treat it as a hidden refusal, not as parity.

## New members needed, grouped

| Group | Sites |
|---|---|
| Startup persistence reads (lane 5 owns the connect gate) | `graduation-schema.ts:129`, `deactivation.ts:330`, `deactivation.ts:359`, `writer-versions.ts:125` |
| Source lists and source rows | `source-resolver.ts:338`, `source-resolver.ts:358`, `source-resolver.ts:532`, `sources-load.ts:249`, `company-brain/profile.ts:33`, `company-brain/profile.ts:34` |
| Guest-source checks | `guests/admission.ts:96`, `guests/note.ts:40`, `guests/marker.ts:38`, `eligibility/stamp.ts:49` |
| Planner statistics after import (8; a Rust no-op may be the right answer, a decision) | `projection-statistics.ts:221`, `:243`, `:316`, `planner-stats.ts:105`, `:252`, `:260`, `:265`, `:303` |
| Extract reads | `wanted-links-store.ts:36`, `link-reconciliation.ts:25`, `timeline-extract.ts:386`, `commands/extract.ts:150` |
| Read-command queries | `search/exact-scan.ts:187`, `wanted-links-store.ts:157`, `:159`, `ops/whois.ts:139`, `ops/graph-rank.ts:209`, `ops/extraction.ts:149`, `review-lists.ts:31` |
| Mentions and entity resolution | `mentions/stale.ts:25`, `mentions/pass.ts:133`, `mentions/siblings.ts:80`, `entities/resolve.ts:855`, `extraction-lag.ts:68`, `search/ignored-privacy-labels.ts:157` |

## Per command

Each site appears once, in the first section whose command calls it. "Calls" counts calls per command in the
traced run.

## Connect and startup (every command)

These calls run before the command body. Lane 5 (branch `rust-cli-connect`) owns the connect fix.
`source-resolver.ts:338` is the import-time fallback of the same resolver read as `:358`.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/core/persistence/deactivation.ts:330` | import 1, extract 1 | `SELECT outcome FROM persistence_topology_changes WHERE operation='writer_deactivate' AND state=…` | persistence_topology_changes | new member needed | new member: committed writer-deactivate outcomes (startup) |
| `src/core/persistence/deactivation.ts:359` | import 1, extract 1 | `SELECT to_regclass('persistence_topology_changes') IS NOT NULL AS present` | persistence_topology_changes (probe) | new member needed | new member: topology-changes table probe (startup) |
| `src/core/persistence/graduation-schema.ts:129` | import 1, extract 1, search-exact 1, wanted 1, whois 1, rank-entities 1, recall 1, sources-list 1, extraction-pending 1 (+whoami) | `SELECT role, run_id::text AS run_id, state, source_data_dir FROM persistence_graduation WHERE s…` | persistence_graduation | new member needed | new member: graduation row read (lane 5, connect gate) |
| `src/core/source-resolver.ts:338` | import 2 | `SELECT id, local_path, archived FROM sources WHERE local_path IS NOT NULL` | sources | new member needed | new member: fallback list with `archived`; listAllSources lacks `archived` |
| `src/core/source-resolver.ts:358` | search-exact 1, wanted 1, whois 1, rank-entities 1, recall 1, extraction-pending 1 (+whoami) | `SELECT id, local_path, archived, config, EXISTS (SELECT 1 FROM pages WHERE source_id = 'default…` | pages, sources | new member needed | new member: sources snapshot with `archived` + default_has_pages; listAllSources lacks both. Error is swallowed (`.catch(() => null)`), so a refusal falls back silently |

## `import` (fresh brain, 20 files)

Only sites first seen in this command are listed; earlier sections hold the shared ones.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/commands/import.ts:976` | import 1 | `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE type IS NULL OR type = '')::text AS unty…` | pages | existing typed member | `getStats`({ sourceId }): page_count, untyped = pages_by_type keys for NULL and "" (a NULL type maps to the key "null") |
| `src/core/belief/ledger.ts:94` | import 20, extract 1 | `SELECT q.*, (SELECT COALESCE(json_agg(json_build_object('enabled', b.enabled)), '[]'::json) FRO…` | persistence_brain, belief_events | covered by scope B | `readLedgerSource` (call moved on B) |
| `src/core/company-brain/profile.ts:33` | import 2 | `SELECT config,incarnation FROM sources WHERE id=$1` | sources | new member needed | new member: config + incarnation; getSource (B) has no incarnation |
| `src/core/company-brain/profile.ts:34` | import 2 | `SELECT r.id FROM source_ingestion_receipts r JOIN sources s ON s.id=r.source_id AND s.incarnati…` | source_ingestion_receipts, sources | new member needed | new member: profile ingestion receipt lookup |
| `src/core/contextual-retrieval-service.ts:906` | import 20 | `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, contextual_retrieva…` | sources | covered by scope B | `getSource` (call moved on B) |
| `src/core/guests/admission.ts:96` | import 2 | `SELECT (pg_catalog.row_security_active('guest_sources') AND NOT EXISTS (SELECT 1 FROM pg_catalo…` | guest_sources, pg_policy (catalog) | new member needed | new member: Postgres catalog: row_security_active + pg_policy on guest_sources |
| `src/core/import-file.ts:790` | import 20 | `DELETE FROM tags t USING pages p WHERE p.id = t.page_id AND p.source_id = $1 AND p.slug = $2 AN…` | tags | covered by scope B | `pruneFrontmatterTags` (call moved on B) |
| `src/core/mentions/pass.ts:218` | import 20 | `DELETE FROM page_aliases WHERE source_id = $1 AND slug = $2 AND origin IN ('declared','subject'…` | page_aliases | covered by scope B | `replaceDerivedAliases` (call moved on B) |
| `src/core/mentions/policy.ts:79` | import 20 | `SELECT key, value FROM config WHERE key = ANY($1::text[])` | config | covered by scope B | `getConfigValues` (call moved on B) |
| `src/core/minions/source-filesystem.ts:63` | import 1 | `SELECT local_path FROM sources WHERE local_path IS NOT NULL AND local_path <> ''` | sources | covered by scope B | `listSourceLocalPaths` (call moved on B) |
| `src/core/page-state/tags.ts:32` | import 20 | `INSERT INTO tags(page_id,tag,tag_source) SELECT $1,t,'frontmatter' FROM (SELECT DISTINCT unnest…` | tags | covered by scope B | `addPageTagsById` (call moved on B) |
| `src/core/page-state/text-seal.ts:19` | import 20 | `UPDATE pages SET text_projection_revision=knowledge_revision, search_vector=setweight(to_tsvect…` | pages | covered by scope B | `writeTextProjectionSeal` (call moved on B) |
| `src/core/persistence/context.ts:32` | import 20, extract 1 | `SELECT current_setting('gbrain.write_request',true) AS s0,current_setting('gbrain.write_princip…` | session settings | covered by scope B | `readTransactionSettings` (call moved on B) |
| `src/core/persistence/context.ts:35` | import 20, extract 1 | `SELECT set_config('gbrain.write_request',$1,true),set_config('gbrain.write_principal_kind',$2,t…` | session settings | covered by scope B | `applyTransactionSettings` (call moved on B) |
| `src/core/persistence/context.ts:40` | import 20, extract 1 | `SELECT set_config('gbrain.write_request',$1,true),set_config('gbrain.write_principal_kind',$2,t…` | session settings | covered by scope B | `applyTransactionSettings` (call moved on B) |
| `src/core/persistence/identity.ts:204` | import 20, extract 1 | `SELECT brain_id FROM persistence_brain WHERE singleton=1` | persistence_brain | covered by scope B | `readPersistenceBrainId` (call moved on B) |
| `src/core/persistence/maintenance.ts:81` | import 20 | `SELECT COALESCE(config->>'canonical','')='git' AS strict FROM sources WHERE id=$1` | sources | covered by scope B | `getSourceStrictness` (call moved on B) |
| `src/core/persistence/managed-mode.ts:54` | import 22, extract 1, rank-entities 1 | `SELECT enabled FROM persistence_brain WHERE singleton=1` | persistence_brain | covered by scope B | `readManagedModeRows` (same SQL text, MANAGED_MODE_SQL; B line 53) (call not moved yet) |
| `src/core/persistence/writer-versions.ts:125` | import 1 | `WITH win AS (SELECT now()-($1::double precision*interval '1 day') AS since) SELECT 'admitter' A…` | persistence_requests, persistence_worktrees | new member needed | new member: writer-version window read |
| `src/core/planner-stats.ts:105` | import 1 | `SELECT to_regclass('planner_stats_deltas') IS NOT NULL AND to_regclass('planner_stats_state') I…` | planner_stats_deltas, planner_stats_state (probe) | new member needed | new member: planner stats tables probe |
| `src/core/planner-stats.ts:252` | import 1 | `SELECT t.table_name, COALESCE((SELECT max(d.id) FROM planner_stats_deltas d WHERE d.table_name …` | planner_stats_deltas | new member needed | new member: delta watermarks |
| `src/core/planner-stats.ts:260` | import 6 | `INSERT INTO planner_stats_state (table_name, analyzed_through, analyzed_at, last_analyze_ms) VA…` | planner_stats_state | new member needed | new member: upsert planner_stats_state |
| `src/core/planner-stats.ts:265` | import 6 | `DELETE FROM planner_stats_deltas WHERE table_name = $1 AND id <= $2` | planner_stats_deltas | new member needed | new member: trim planner_stats_deltas |
| `src/core/planner-stats.ts:303` | import 1 | `SELECT to_regclass('planner_stats_state') IS NOT NULL AS ok` | planner_stats_state (probe) | new member needed | new member: planner stats state probe |
| `src/core/search/ignored-privacy-labels.ts:157` | import 1 | `SELECT p.type, p.frontmatter FROM pages p WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) A…` | pages | new member needed | new member: type + frontmatter for a slug list, privacy filter in SQL |
| `src/core/search/projection-statistics.ts:221` | import 1 | `SELECT pg_has_role(current_user, p.relowner, 'USAGE') OR r.rolsuper AS can_analyze FROM pg_clas…` | pg_class, pg_roles (catalog) | new member needed | new member: can-ANALYZE ownership check (planner maintenance) |
| `src/core/search/projection-statistics.ts:243` | import 1 | `SELECT c.reltuples::float8 AS reltuples, $1::text = 'postgres' OR NOT EXISTS (SELECT 1 FROM pg_…` | pg_class (catalog) | new member needed | new member: pg_class reltuples (planner maintenance) |
| `src/core/search/projection-statistics.ts:316` | import 1 | `ANALYZE` | whole database | new member needed | new member: ANALYZE (planner maintenance) |
| `src/core/source-resolver.ts:375` | import 2 | `SELECT 1 AS one FROM pages WHERE source_id = 'default' AND deleted_at IS NULL LIMIT 1` | pages | existing typed member | `getStats`({ sourceId: "default" }).page_count > 0 (exact rows; reads much more than one row) |
| `src/core/source-resolver.ts:382` | import 2 | `SELECT id, config FROM sources WHERE local_path IS NOT NULL AND id != 'default' AND archived = …` | sources | existing typed member | `listAllSources`({ localPathOnly: true }), drop `default` in TS (same filters: `archived` is NOT NULL; adds ORDER BY) |
| `src/core/source-resolver.ts:532` | import 1 | `SELECT COALESCE(SUM(CASE WHEN source_id = 'default' THEN 1 ELSE 0 END), 0) AS default_pages, CO…` | pages, sources | new member needed | new member: default vs non-default page and source counts (write guard) |
| `src/core/trust/channel.ts:251` | import 20 | `SELECT config FROM sources WHERE id = $1` | sources | covered by scope B | `getSource` (`.config`) (call not moved yet) |

## `extract all --source db`

Only sites first seen in this command are listed; earlier sections hold the shared ones.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/commands/extract.ts:150` | extract 1 | `SELECT p.slug,p.source_id FROM pages p JOIN unnest($1::text[],$2::text[],$3::text[]) AS t(sourc…` | pages | new member needed | new member: pages still at a given knowledge_revision; snapshot revision sentinel differs from SQL NULL compare |
| `src/core/guests/note.ts:40` | extract 2 | `SELECT s.id FROM sources s WHERE s.id = ANY($1::text[]) AND (COALESCE(s.config->>'guest' = 'tru…` | sources, guest_sources | new member needed | new member: guest source ids among a list |
| `src/core/link-reconciliation.ts:25` | extract 1 | `SELECT slug, source_id, type, title, frontmatter->'aliases' AS aliases, knowledge_revision FROM…` | pages | new member needed | new member: every live page with aliases + knowledge_revision |
| `src/core/sources-load.ts:249` | extract 1, sources-list 1 | `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at, archived, newest_co…` | sources | new member needed | new member: full sources list (last_commit, created_at, archived, newest_content_at); listAllSources lacks them |
| `src/core/timeline-extract.ts:386` | extract 20 | `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary, t.detail FROM timeline…` | timeline_entries, pages | new member needed | new member: all stored timeline rows of one page, date as text; getTimeline has limit 100 and other shape |
| `src/core/wanted-links-store.ts:36` | extract 1 | `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at` | none (clock) | new member needed | new member: database clock (clock_timestamp) |

## `search-exact`

Only sites first seen in this command are listed; earlier sections hold the shared ones.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/core/eligibility/stamp.ts:49` | search-exact 1 | `SELECT pages.id, pages.source_id, pages.slug, trust_tier, write_origin, ((CASE pages.trust_tier…` | pages, sources, guest_sources | new member needed | new member: page trust rows |
| `src/core/guests/marker.ts:38` | search-exact 1, wanted 1, whois 1, rank-entities 1 | `SELECT EXISTS (SELECT 1 FROM sources read_source WHERE (COALESCE(read_source.config->>'guest' =…` | sources, guest_sources | new member needed | new member: does the read scope include a guest source |
| `src/core/search/exact-scan.ts:187` | search-exact 1 | `WITH batch AS MATERIALIZED ( SELECT p.id FROM pages p JOIN sources s ON s.id = p.source_id WHER…` | pages, sources | new member needed | new member: exact-scan page batch |

## `wanted`

Only sites first seen in this command are listed; earlier sections hold the shared ones.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/core/wanted-links-store.ts:157` | wanted 1 | `WITH wanted AS ( SELECT w.target_source_id, w.target_ref, w.ref_kind, w.link_type, w.first_seen…` | wanted_links, pages | new member needed | new member: wanted-links listing |
| `src/core/wanted-links-store.ts:159` | wanted 1 | `WITH wanted AS ( SELECT w.target_source_id, w.target_ref, w.ref_kind, w.link_type, w.first_seen…` | wanted_links, pages | new member needed | new member: wanted-links listing (second shape) |

## `whois`

Only sites first seen in this command are listed; earlier sections hold the shared ones.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/core/ops/whois.ts:139` | whois 1 | `WITH cand AS ( SELECT p.id FROM pages p WHERE p.source_id = ANY($1::text[]) AND lower(p.title) …` | pages | new member needed | new member: title/alias candidate match |

## `rank-entities`

Only sites first seen in this command are listed; earlier sections hold the shared ones.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/core/extraction-lag.ts:68` | rank-entities 1 | `SELECT count(*)::int AS total, count(*) FILTER (WHERE deleted_at IS NULL AND NOT (COALESCE(page…` | pages (+ wanted_links, guest_sources) | new member needed | new member: lag row (total, stale, attendance_blocked, held); countStalePagesForExtraction returns one number |
| `src/core/mentions/pass.ts:133` | rank-entities 1 | `SELECT count(*)::int AS n FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id WHERE…` | pages, page_mention_state, p | new member needed | new member: pages due for a mention pass |
| `src/core/mentions/stale.ts:25` | rank-entities 1 | `SELECT to_char(max(last_pass_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last FROM…` | mention_index_status | new member needed | new member: last mention pass time |
| `src/core/ops/graph-rank.ts:209` | rank-entities 1 | `WITH RECURSIVE readable AS MATERIALIZED ( SELECT vp.id FROM pages vp WHERE vp.deleted_at IS NUL…` | pages | new member needed | new member: recursive graph rank |
| `src/core/verbs/entity-variants.ts:157` | rank-entities 5 | `SELECT slug, title, type, frontmatter FROM pages WHERE deleted_at IS NULL AND source_id = $1 AN…` | pages | existing typed member | `readPageSnapshotsBatch`(refs, { absentIsNull: true }), drop slug $3 in TS (reads full page) |

## `recall`

Only sites first seen in this command are listed; earlier sections hold the shared ones.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/core/entities/resolve.ts:855` | recall 1 | `SELECT slug FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL AND NOT (lower…` | pages | new member needed | new member: exact slug with retired-page filter (retiredPageSql); getPage has no such filter |
| `src/core/mentions/siblings.ts:80` | recall 1 | `SELECT slug, title, type, frontmatter->>'identity' AS identity FROM pages WHERE source_id = $1 …` | pages | new member needed | new member: sibling entity candidates by type |
| `src/core/mentions/siblings.ts:134` | recall 1 | `SELECT title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL` | pages | existing typed member | `getPage`(slug, { sourceId }).title |
| `src/core/mentions/siblings.ts:152` | recall 1 | `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[]) L…` | pages | existing typed member | `readPageSnapshotsBatch`(refs, { absentIsNull: true }), first non-null (SQL LIMIT 1 has no ORDER BY) |

## `sources-list`

Only sites first seen in this command are listed; earlier sections hold the shared ones.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/commands/sources.ts:140` | sources-list 1 | `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL` | pages | existing typed member | `getStats`({ sourceId }).page_count (countPagesBy is close but drops archived sources) |

## `extraction-pending`

Only sites first seen in this command are listed; earlier sections hold the shared ones.

| Site | Calls | SQL (short) | Tables | Class | Replacing member |
|---|---|---|---|---|---|
| `src/core/ops/extraction.ts:149` | extraction-pending 1 | `SELECT p.slug, p.title, p.type, p.source_id, p.frontmatter ->> 'source' AS extracted_from, p.cr…` | pages, sources | new member needed | new member: extraction-pending page list |
| `src/core/review-lists.ts:31` | extraction-pending 1 | `SELECT id, fact, kind, visibility, source_id, created_at::text AS created_at, source FROM facts…` | facts | new member needed | new member: unattributed facts |

## Already inside a typed member (excluded)

These calls run inside the PGLite implementation of a typed member. On a Rust brain the member is native Rust, so the SQL never runs. Nothing to add.

| Site | Calls | SQL (short) | Inside member |
|---|---|---|---|
| `src/core/derived-links.ts:167` | extract 1 | `SELECT value FROM config WHERE key = $1 FOR SHARE` | inside `replaceDerivedLinksBatch` |
| `src/core/derived-links.ts:306` | extract 3 | `SELECT 1 FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_slug text, from_source_id text)…` | inside `replaceDerivedLinksBatch` |
| `src/core/derived-links.ts:336` | extract 20 | `DELETE FROM links WHERE link_source=ANY($2::text[]) AND (origin_page_id=$1 OR (origin_page_id I…` | inside `replaceDerivedLinksBatch` |
| `src/core/link-relationships.ts:134` | extract 11 | `INSERT INTO link_relationships (from_page_id, to_page_id, link_type, scope, source_id, semantic…` | inside `replaceDerivedLinksBatch` |
| `src/core/link-relationships.ts:164` | extract 2 | `SELECT nextval('graph_generation_seq')` | inside `replaceDerivedLinksBatch` |
| `src/core/link-relationships.ts:55` | extract 11 | `SELECT v.from_page_id, v.to_page_id, v.link_type, COALESCE(l.origin_page_id, l.from_page_id) AS…` | inside `replaceDerivedLinksBatch` |
| `src/core/link-relationships.ts:66` | extract 11 | `SELECT v.from_page_id, v.to_page_id, v.link_type, lt.origin_page_id AS origin_id, lt.kind, lt.o…` | inside `replaceDerivedLinksBatch` |
| `src/core/link-relationships.ts:77` | extract 11 | `SELECT lr.from_page_id, lr.to_page_id, lr.link_type, lr.scope, lr.recorded_at, lr.retired_at, l…` | inside `replaceDerivedLinksBatch` |
| `src/core/link-temporal-apply.ts:46` | extract 40 | `SELECT from_page_id, to_page_id, link_type FROM links WHERE (origin_page_id = $1 OR (origin_pag…` | inside `replaceDerivedLinksBatch` |
| `src/core/page-snapshot-batch.ts:49` | extract 3 | `WITH wanted AS ( SELECT v.slug AS batch_slug, v.source_id AS batch_source_id, v.n AS batch_n, p…` | `readPageSnapshotsBatch` |
| `src/core/page-state/guards.ts:32` | extract 1 | `SELECT incarnation FROM sources WHERE id=$1 FOR SHARE` | `lockPageKeys` |
| `src/core/page-state/guards.ts:43` | import 20, extract 1 | `SELECT incarnation FROM sources WHERE id=$1 FOR SHARE` | `lockPageKeys` |
| `src/core/page-state/snapshot.ts:100` | import 80 | `WITH chosen AS ( SELECT p.* FROM pages p WHERE p.slug=$1 AND p.source_id=$2 ORDER BY (p.slug=$1…` | `readPageSnapshot` |
| `src/core/page-state/transactions.ts:84` | import 60, extract 69 | `INSERT INTO page_write_guards(source_incarnation,slug) SELECT incarnation,$2 FROM sources WHERE…` | `lockPageKeys` |
| `src/core/persistence/filesystem-guard.ts:18` | import 2, extract 1, search-exact 1, wanted 1, whois 1, rank-entities 1, recall 1, sources-list 1, extraction-pending 1 (+whoami) | `SELECT to_regclass('persistence_brain') IS NOT NULL AS present` | `connect` (PGLite open path) |
| `src/core/persistence/managed-mode.ts:69` | import 3, extract 2, search-exact 1, wanted 1, whois 1, rank-entities 1, recall 1, sources-list 1, extraction-pending 1 (+whoami) | `SELECT brain_id,enabled,to_jsonb(persistence_brain)->>'mode_epoch' AS mode_epoch, (to_jsonb(per…` | `initSchema` |
| `src/core/persistence/origin-guard.ts:116` | import 20 | `SELECT id, slug, source_path, deleted_at FROM pages WHERE source_id=$1 AND slug=$2` | `putPage` |
| `src/core/persistence/origin-guard.ts:126` | import 20 | `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))` | `putPage` |
| `src/core/persistence/origin-guard.ts:129` | import 20 | `SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path=A…` | `putPage` |
| `src/core/persistence/origin-guard.ts:81` | import 20 | `SELECT local_path, config->>'slug_root_mode' AS mode FROM sources WHERE id=$1` | `putPage` |
| `src/core/stored-embedding-identity.ts:19` | import 1 | `SELECT format_type(a.atttypid, a.atttypmod) AS formatted FROM pg_attribute a JOIN pg_class c ON…` | `initSchema` |
| `src/core/stored-embedding-identity.ts:28` | import 1 | `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_…` | `initSchema` |
| `src/core/wanted-links-store.ts:100` | extract 1 | `INSERT INTO wanted_links (origin_page_id, source_id, producer, ref_kind, target_source_id, targ…` | inside `replaceDerivedLinksBatch` |
| `src/core/wanted-links-store.ts:91` | extract 20 | `DELETE FROM wanted_links w WHERE w.origin_page_id = $1 AND w.producer IN (SELECT jsonb_array_el…` | inside `replaceDerivedLinksBatch` |

## Schema group (68 sites, 33 files)

All come from `import` on a fresh brain, under `initSchema` and the migration runner (`migrate.ts`). One existing member covers them: `initSchema` (capability `schema`). On Rust each migration gets a disposition (`catalog_only`, `postgres_only` or a Rust handler; docs/designs/RUST_ENGINE.md, "Migration and rollback"), and its SQL never runs. `facts/fts-index.ts:54/55` (the facts FTS index swap) is a migration step too.

- `src/core/facts/fts-index.ts`: 27, 54, 55
- `src/core/function-search-path.ts`: 78
- `src/core/grants/legacy-token.ts`: 349
- `src/core/grants/migration.ts`: 11, 14, 16, 39
- `src/core/guard-ledger-checks.ts`: 57
- `src/core/migrate.ts`: 392
- `src/core/migration-preludes.ts`: 61, 86, 95, 123, 217
- `src/core/page-state/revision-backfill-schema.ts`: 95
- `src/core/pages-upsert-arbiter.ts`: 63, 80
- `src/core/persistence/connector-checkpoint-migration.ts`: 44, 84, 128, 130, 134, 135
- `src/core/persistence/connector-state.ts`: 166
- `src/core/persistence/origin-index.ts`: 20, 30
- `src/core/schema-migrations/helpers.ts`: 126, 159, 177
- `src/core/schema-migrations/v045-facts-hot-memory-v0-31.ts`: 34
- `src/core/schema-migrations/v055-query-cache-search-lite.ts`: 41
- `src/core/schema-migrations/v123-configurable-fts-language.ts`: 67, 68
- `src/core/schema-migrations/v124-page-search-vector-drop-compiled-truth.ts`: 51
- `src/core/schema-migrations/v142-takes-embedding-dimension-matches-config.ts`: 13, 17, 25, 38, 41, 42, 43, 45
- `src/core/schema-migrations/v144-open-loops.ts`: 82, 89
- `src/core/schema-migrations/v153-verified-text-projection-activation.ts`: 11
- `src/core/schema-migrations/v164-shared-brain-skills-and-membership.ts`: 10
- `src/core/schema-migrations/v191-alias-source-cascade.ts`: 51, 59
- `src/core/schema-migrations/v210-clamp-oauth-token-ttl.ts`: 30, 44
- `src/core/schema-migrations/v225-drop-duplicate-embedding-null-index.ts`: 25
- `src/core/schema-migrations/v232-fts-cjk-boundary.ts`: 31, 32, 33
- `src/core/schema-migrations/v234-persistence-git-durability.ts`: 22
- `src/core/schema-migrations/v245-page-search-vector-bounded-timeline.ts`: 28
- `src/core/schema-migrations/v281-derived-state-maintainers-fail-closed.ts`: 36
- `src/core/schema-migrations/v302-link-transitions-source.ts`: 47
- `src/core/search-vector-backfill.ts`: 63, 106
- `src/core/search/projection-statistics.ts`: 40
- `src/core/timeline-dedup-repair.ts`: 80, 87, 204, 211
- `src/core/vector-index.ts`: 41
