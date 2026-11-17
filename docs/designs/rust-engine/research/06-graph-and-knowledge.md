# Knowledge layer map: graph, entities, facts, takes, timeline

Line numbers refer to gbrain 36bd05806a.

Scope: the knowledge layer of gbrain v0.60.733.0 (commit 36bd05806a, read-only reference at garrytan/gbrain). Eval references are in garrytan/gbrain-evals (commit 9ecc5b20).

Legend: unmarked claims were read in code and cite file:line. "[inferred]" marks conclusions drawn from comments, naming, or standard Postgres behavior that I did not run.

## 1. Summary

- The knowledge layer is one graph (`links`, with provenance columns), two entity-side tables (`page_aliases`, mention index), three fact-like stores (`facts`, `takes`, `timeline_entries`), and several DB-only ledgers (withdrawals, purge tombstones, belief events).
- Markdown is canonical for file-backed knowledge. The `takes` and `facts` tables are derived indexes over fenced Markdown tables. Withdrawals, purge tombstones, belief events, and DB-only facts are not rebuildable from Markdown. (docs/architecture/system-of-record.md:44-100)
- Postgres features in use: recursive CTEs (BFS with array visited sets), `pg_trgm`, `jsonb` containment, `jsonb_to_recordset` batch writes, `NULLS NOT DISTINCT` (PG15+), HNSW on `halfvec`/`vector`, `tsvector` GIN, advisory and row locks, and SQL triggers.
- Search-time graph signals are multiplicative boosts from link counts (backlinks, adjacency, cross-source, session demotion), not embeddings.
- Identity resolution is exact matches, then a same-name trigram check, then slugify. `whois` is exact-only.
- Facts are fence-first, with a DB-only fallback. Forget is a DB withdrawal plus a Markdown strike. Purge is a separate owner-only tombstone operation.

## 2. Authority: what can be rebuilt from Markdown

| Store | Table(s) | Authority | Rebuild source / note |
|---|---|---|---|
| Page body, frontmatter | `pages`, `content_chunks` | FS canonical; DB-only pages exist | `sync` + `extract` (system-of-record.md:50-75) |
| Markdown-derived links | `links` (origin_page_id set) | Derived | Re-extract from body and frontmatter |
| Manual DB-only edges | `links` (origin NULL) | DB-only | Not in Markdown (link-temporal-schema.ts:6-8) |
| Wanted links | `wanted_links` | Derived; page text is truth | wanted-links.ts:1-14 |
| Temporal evidence | `link_transitions` | Derived from origin page | Replaced with origin's derived links (link-temporal-schema.ts:6-8) |
| Temporal state cache | `link_relationships` | Derived cache | Rebuilt from transitions; `graph_generation_seq` invalidates query caches |
| Edge contradiction proposals | `link_edge_proposals` | Operational state [inferred] | Apply/undo state, not Markdown |
| Takes | `takes` (+ `synthesis_evidence`) | FS canonical via `## Takes` fence | takes-write.ts:1-12; takes-fence.ts:1-30 |
| Facts | `facts` | FS canonical when file-backed; DB-only otherwise | system-of-record.md:138-143 |
| Forget withdrawals | `fact_withdrawals` | DB-only, authoritative | withdrawal-schema.ts:84-93; system-of-record.md:378-400 |
| Purge tombstones | `fact_purges`, `take_purges`, `page_purges` | DB-only, authoritative | purge-schema.ts:36-64 |
| Belief events | `belief_events`, `belief_page_lifetimes`, `belief_commit_marks`, `belief_retier_manifest`, `belief_redactions` | DB-only by design | belief/schema.ts:17-93; system-of-record.md:98 |
| Timeline rows | `timeline_entries` | Derived from Markdown | system-of-record.md:57-60 |
| Tags | `tags` | Derived from frontmatter; `tag_source='added'` rows are DB-claimed | page-state/tags.ts:12-14 |
| Page versions | `page_versions` | Audit history; "rebuildable in principle but not in practice" | system-of-record.md:72-74 |
| Entity aliases | `page_aliases` | Derived from frontmatter/declared/subject | v110-page-aliases.ts:32-44; v206 |
| Calibration profiles | `calibration_profiles` | Published snapshots [inferred: history not rebuildable] | v068-calibration-profiles-v0-36.ts:34-60 |

Note: docs/architecture/system-of-record.md:98 lists the belief ledger as DB-only. The design doc (docs/designs/BELIEF_LEDGER.md) still says "Status: design, not built," but src/core/belief/ contains about 4,100 lines of implementation. The code is the more recent source. Treat the belief ledger as shipped but confirm with the owners.

## 3. Links and the graph

### 3.1 Schema

`links` (src/schema.sql:549-584):
- Columns: endpoints `from_page_id` and `to_page_id` (FK cascade), `link_type`, `context`, `link_source`, `link_kind`, `origin_page_id` (FK set null), `origin_field`, `resolution_type`, `assertion_tense`, `created_at`.
- Unique key: `UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)`. The comment ties this to PG15+.
- Indexes: `from_page_id`, `to_page_id`, `link_source`, `origin_page_id`, and a partial index on `to_page_id` where `link_type='supersedes'`.

`wanted_links` (schema.sql:595-611): authored references whose target does not exist yet. Columns include `producer` (`body` | `frontmatter`), `ref_kind` (`slug` | `name`), `target_source_id`, `target_ref`, `checked_at`. Unique on `(origin_page_id, producer, ref_kind, target_source_id, target_ref)`. A live target updated after `checked_at` makes the origin stale for extraction (wanted-links.ts:1-14).

`code_edges_chunk` and `code_edges_symbol` (schema.sql:472-515): call-graph edges between `content_chunks`. Unique on `(from_chunk_id, to_chunk_id, edge_type)` and `(from_chunk_id, to_symbol_qualified, edge_type)`. Writes use `ON CONFLICT DO NOTHING` (engine-sql/code-edges.ts:46-55). The PGLite path splits binds below 30,000 per statement because of a parameter-bridge limit (code-edges.ts header).

### 3.2 Writes

- `addLink` (engine-sql/links.ts:102-157) resolves both endpoints and upserts in one statement. Endpoint lookups take `FOR KEY SHARE` (links.ts:118-124) so a concurrent hard delete linearizes. A missing endpoint raises `PageMissingError`.
- Batch writes (`addLinksBatch`, links.ts:216-256) pass one JSONB document and use `jsonb_to_recordset` with `ON CONFLICT ... DO NOTHING`.
- `replaceDerivedLinks` (derived-links.ts:170) replaces all links owned by one origin page, plus its `wanted_links` rows, in one transaction. It checks origin revision and endpoint revisions and raises `DerivedLinkEndpointChangedError` on mismatch.
- `link_source = 'mentions'` rows are body-text mentions. They feed orphan and traversal logic but are excluded from backlink counts and ranking (schema.sql:553-556; graph-rank.ts:116).

### 3.3 Reads

- `getLinks` / `getBacklinks` (links.ts:366, 437) are indexed point reads with privacy, source, and temporal filters.
- Link types that do not count for ranking come from a code constant: `NON_RANKING_LINK_TYPES = ['amends']` (link-ranking-policy.ts:21). The SQL predicate is `link_type <> ALL(ARRAY['amends'])` (link-ranking-policy.ts:33-35).

### 3.4 `traverse_graph`: the BFS walk

`traverseGraph` (links.ts:659) and `traversePathsDetailed` (links.ts:711) share `bfsWalkCtes` (links.ts:609-648). This is a `WITH RECURSIVE` query over an array state, not a path enumeration:

- Row 0 is the seed set, `array_agg(id ORDER BY slug, id)`.
- Each step expands the frontier with `LATERAL`, dedupes neighbors with `NOT EXISTS (... unnest(visited))`, orders them by `(slug, id)`, and caps each layer with `LIMIT`.
- `visited` grows as `bfs.visited || n.next`. The walk stops when `depth >= maxLayer`.
- A window function `row_number() OVER (ORDER BY depth, ord)` gives each page a `pos`.

Constants (engine-constants.ts):
- `TRAVERSE_WALK_ROW_CAP = 20000` (line 48): total pages visited. `pos > cap` is dropped.
- `TRAVERSE_PATH_ROW_CAP = 5000` (line 37): returned edges. Excess sets `truncated: true`.
- Default `depth` 5 (links.ts:659). `frontierCap` bounds new pages per layer.

Privacy and scope apply at the seed, at each step, and on both endpoints of every edge. This keeps graph reads inside the caller's source scope (comment at links.ts:672-674).

### 3.5 `rank_entities`

`rankEntitiesStatement` (graph-rank.ts:115-185) returns entities ordered by inbound, outbound, or both degree. Its structure:

1. `readable` (MATERIALIZED): pages that the caller may read (live, unquarantined, unarchived source, optional private exclusion).
2. `retired` (MATERIALIZED): pages with `canonical: false`, `superseded_by`, `merged_into`, or a status word `alias|redirect|redirected` (entities/resolve.ts:210-215).
3. `chain` (`WITH RECURSIVE`): follows redirect targets up to `MAX_RETIREMENT_HOPS = 5` (resolve.ts:217).
4. `fold` (MATERIALIZED, `DISTINCT ON`): the first live, readable target of each retired chain.
5. `edges` (MATERIALIZED, `SELECT DISTINCT`): endpoints folded to targets, self-links dropped, non-ranking types dropped.
6. `ends` / `d`: counts of in, out, and distinct neighbors per node, filtered by entity type.

Ordering is `key DESC, slug COLLATE "C", source_id COLLATE "C"`. The doc comment (graph-rank.ts:20-30) gives a benchmark: about 3 s on Postgres 16 with 200k pages and 985k links, local and remote.

### 3.6 Search boosts (not SQL-side)

Two boost paths, both computed after fusion in `src/core/search/`:

- Backlink boost (`applyBacklinkBoost`, hybrid.ts:257-300): counts distinct linking pages, excluding self-links and mention links. Factor `1 + 0.05 * ln(1 + count)`. Examples from the comment: 1 link gives about 1.035, 10 about 1.12, 100 about 1.23. Results below the floor threshold are skipped. Counts come from `readBacklinkCounts` (read-enrichment.ts:243-263), keyed by `page_id`.
- Adjacency and cross-source boost (graph-signals.ts:54-68): among the top `DEFAULT_TOP_K = 20` results, a page linked from at least `ADJACENCY_MIN_HITS = 2` other top-K pages gets `ADJACENCY_BOOST = 1.05`. At least `CROSS_SOURCE_MIN_HITS = 2` distinct other sources gets `CROSS_SOURCE_BOOST = 1.10`. Session-prefix duplicates are demoted to `SESSION_DEMOTE = 0.95`. Fail-open: an error returns input unchanged. The SQL is `readAdjacencyBoosts` (read-enrichment.ts:265-287), with candidate ids inlined as integers to avoid a bad generic plan.
- Hub dampening (search/hub-dampening.ts:11-14): `hubWeight(n, H) = 1 / (1 + ((max(n,1)-1)/H)^2)`. Call sites were not traced.

BrainBench Cat 27 (gbrain-evals/eval/runner/cat27-graph-signals.ts:1-12) A/B-tests these signals on PGLite.

### 3.7 Derived-link provenance

Derived links carry `origin_page_id` and `origin_field`, so one page's re-extraction replaces only its own rows. Attendance and frontmatter-link rules are in docs/architecture/key-files/graph-and-facts.md.

## 4. Entities and identity resolution

### 4.1 Resolver ladder

`resolveEntitySlug` (src/core/entities/resolve.ts:60-168) returns a slug or null. Its order, as read:

1. Exact slug, when the input looks like a slug. A retired exact match follows its redirect (`followRetirement`).
2. Exact own name: a live page whose slug basename equals the input wins over another page's alias (resolve.ts comment at 1.25).
3. Organization directory variant (`orgDirVariants`) and `alias_exact` hits from `page_aliases` (resolve.ts:530-534).
4. Same-name trigram candidate (only for multi-token inputs with `sameName`): `lower(title) % $2 OR slug ILIKE '%'||$3||'%'`, `ORDER BY GREATEST(similarity(title), similarity(slug)) DESC, slug`, `LIMIT 5` (resolve.ts:538-552). Accepted only if `isFactEntityPage` and `sameEntityName` both hold.
5. Bare-name prefix expansion (`findPrefixCandidates`, resolve.ts:687). A single prefix candidate resolves. Several return `{miss: 'unverified'}`.
6. Fallback to a deterministic `slugify` by the caller. It does not prefix a directory (resolve.ts:53 comment).

`sameEntityName` (resolve.ts:195-199): both sides normalize to a sorted, de-duplicated token set, with accents folded, punctuation dropped, `NAME_NOISE_TOKENS` removed (resolve.ts:166). "Example, Alice" matches "Alice Example". "Alicia Example" does not. The token list is code state, so the Rust port must copy it exactly.

### 4.2 Trigram use

pg_trgm is required by schema (`CREATE EXTENSION IF NOT EXISTS pg_trgm`, schema.sql:4) and indexed:
- `idx_pages_trgm` on `pages(title gin_trgm_ops)` (schema.sql:282).
- `idx_pages_slug_trgm` on `pages(slug gin_trgm_ops)` (schema.sql:286).

Uses:
- `resolve.ts:544, 592, 883-891`: `%` plus `similarity()`.
- `similar-pages.ts:58-59`: title `%` plus `similarity >= TITLE_SIMILARITY_FLOOR = 0.55` (similar-pages.ts:23).
- `engine-sql/pages.ts:775-779`: fuzzy page lookup.
- `engine-sql/takes.ts:343-371`: `query <% t.claim` with `word_similarity`. Ordered by score, then weight.
- `resolve.ts:868-918`, `tryFuzzyMatch`. Two modes:
  - Same-name mode (default): `LIMIT 5`, exactly one `isFactEntityPage` + `sameEntityName` candidate wins. Two namesakes are ambiguous and return null.
  - Phantom-canonical mode: a winner needs score >= 0.7 and a margin of at least 0.1 over the runner-up (resolve.ts:868-918).
- If pg_trgm is missing (`42883` or the operator error), the fuzzy arm is skipped and the resolver falls through to slugify (resolve.ts:920-925).

[inferred] The `%` operator uses the pg_trgm default threshold 0.3, and `<%` uses `word_similarity_threshold` 0.6. No override was found in the repo, but I did not check the config table or extension defaults.

### 4.3 `whois`: exact-match rule

`whois` (src/core/ops/whois.ts:1-22) answers only on an exact match. It accepts an email address or a name, and matches the frontmatter `email`/`emails` value, the page title, or a declared alias. Folding: case, accents (NFKD minus marks, stroke letters folded), compatibility width forms, and surrounding whitespace or quotes. An email query compares whole addresses case-insensitively, with no accent folding. There is no nickname, typo, prefix, or semantic match, and no search fallback.

Candidate SQL (engine-sql/exact-identity.ts:41-100) is a `UNION` of index-served equality probes, one per arm:
- `lower(p.title) = ANY(keys)`: `idx_pages_source_title_lower`.
- `regexp_replace(p.slug, '^.*/', '') = ANY(basenames)`: `idx_pages_slug_basename`.
- `page_aliases.alias_norm = ANY(keys)`: `(source_id, alias_norm)` index.
- `p.frontmatter @> {email: x}` and three other shapes: GIN `idx_pages_frontmatter`. Each address gets its own arm, because an `OR` plans worse.

Limits: query at most 320 characters (`WHOIS_MAX_QUERY_CHARS`), at most 20 types, at most 100 candidates (`WHOIS_CANDIDATE_CAP`, whois.ts:24-27). Output includes `ambiguous: matches.length > 1`.

### 4.4 Name variants and near-name index

`name-variants.ts:23-28` classifies seven variant kinds; `typo` and `surname` are weak and need a single matching page overall. `near-name.ts` builds an in-process index (names 3-64 chars, at most 200,000 entities), not SQL.

### 4.5 Retirement

A retired page hands its identity to a target: `superseded_by` or `merged_into`, or `canonical: false`, or a status word. Chains stop at `MAX_RETIREMENT_HOPS = 5` and at cycles (resolve.ts:210-234). `rank_entities` folds retired edges onto the target. The redirect field is read from frontmatter with regex (graph-rank.ts:80-83).

## 5. Facts

### 5.1 Schema

`facts` (created by migration v045, src/core/schema-migrations/v045-facts-hot-memory-v0-31.ts:113-160; later columns from v047, v051, v067, v089, v122, v166, v215, v273):

- Identity: `id BIGSERIAL`, `source_id`, `entity_slug`, `fact`, `kind` (`event|preference|commitment|belief|fact|idea`), `visibility` (`private|world`), `notability`, `attributed_to`.
- Validity and dedup: `valid_from`, `valid_until`, `expired_at`, `superseded_by`, `consolidated_at`, `consolidated_into`.
- Provenance: `source`, `source_session`, `confidence REAL` (0..1), `row_num` and `source_markdown_slug` (fence round-trip), `source_window JSONB`.
- Typed claim: `claim_metric`, `claim_value`, `claim_unit`, `claim_period`, `event_type`, `dimension`, `value`, `dim_status`.
- Embedding: `halfvec(N)` or `vector(N)` (N default 1536, v045:32), with `embedding_model`, `embedded_at`, and `embedded_text_hash = md5(fact)` gating comparability.

Indexes: partial `expired_at IS NULL` indexes on entity, session, and time; an unconsolidated index; a partial HNSW index on live embeddings, skipped if the dimension exceeds the pgvector limit for the type (v045:99-106); a keyword index `idx_facts_fts` (fts-index.ts:1-25); and a partial unique index on `(source_id, source_markdown_slug, row_num)`.

halfvec requires pgvector >= 0.7. Migration v045 falls back to `vector` below that (v045:60-75). PGLite always uses halfvec (v045:89-91).

### 5.2 `remember`: write path

Verb (src/core/verbs.ts:67-120): requires `provenance` for a single fact (max 500 chars). `entity` is the subject. `ttl` is optional. Batch `items` are capped at 20.

Implementation (src/core/facts/write-single.ts:1-20):
1. Resolve the entity (section 4).
2. Dedup via `decideSingleFact`: exact fingerprint first (always runs), then embedding cosine at the model's calibrated threshold.
3. If the top candidate scores at or above threshold with the same `kind` but different text, the new fact supersedes it. Same text is a duplicate and returns the existing id.
4. Fence-first write to Markdown. Legacy DB-only fallback for thin clients, unparented sources, or `sync.write_through` off (fence-write.ts:314-365).

Thresholds (src/core/facts/supersession-threshold.ts:14-30): cosine supersession applies only to calibrated `provider:model@dims`. The one entry is `voyage:voyage-4@1024 = 0.95`. Uncalibrated models insert without superseding, and conflict review handles the pair. Operators can set `facts.supersession_thresholds`, or `off`.

The fingerprint (withdrawal-schema.ts:27-40): `gbrain_fact_fingerprint` = sha256 hex of a normalized claim (lowercased, punctuation translated to spaces, whitespace collapsed, trimmed). `gbrain_fact_fingerprint_v1` trims, lowercases with the host's `lower()`, collapses whitespace and hashes; it does no punctuation folding. The fingerprint is stored in `fact_withdrawals` and `fact_purges`, so it must match byte-for-byte.

Concurrency (engine-sql/facts.ts:88-170): when `entity_slug` is set, the insert takes `pg_advisory_xact_lock(hashtextextended(source_id || ':' || entity_slug, 0))`. The supersede path also updates the old row inside the same transaction. The comment in write-single.ts:14-17 says dedupe is sequential, so two identical submissions racing can both insert.

### 5.3 `recall`

`recall` (src/core/ops/facts.ts:298-330) reads facts by entity, `since`, or `session_id`. `query` also searches pages. Remote callers get world-visibility facts only, except a caller bound to the brain owner, which also reads private facts (`worldOnlyFacts`); source grants and member access still apply. Dedupe candidates for a write use `findCandidateDuplicates` (engine-sql/facts.ts:580-636): `k` clamped to `[1, 20]` (default 5), filtered by `source_id`, `entity_slug`, `expired_at IS NULL`, `valid_until` in the future, and `embedding <=> query` when comparable. The keyword arm (`findKeywordCandidates`, engine-sql/facts.ts:638-666) uses `plainto_tsquery`, `to_tsvector @@ q`, and `ts_rank_cd`.


### 5.4 `forget`: withdrawal

`forget` (src/core/verbs.ts:484-516) takes a fact id and an optional reason. It is idempotent. The result is `ok`, `path` (`fence` | `legacy_db` | `not_found` | `already_expired`), and a reason.

The mechanism (forget.ts:1-15, withdrawal.ts:1-30, withdrawal-schema.ts:84-100):
- Insert a row into `fact_withdrawals (source_id, visibility, subject, fact_hash, withdrawn_at)`, primary key on the four key columns. `subject='*'` means every entity.
- Trigger `facts_preserve_withdrawal` (BEFORE INSERT OR UPDATE OF fact, source_id, visibility, entity_slug, expired_at) re-applies withdrawal to matching new rows.
- Expire the row (`expired_at`, `valid_until`). Strike the Markdown row and append the reason. Withdrawal is DB-first and does not require a filesystem owner (system-of-record.md:378-392).
- A forgotten claim without an entity is withdrawn for every entity. Remembering the same text again is refused with `fact_withdrawn` (withdrawal.ts:20).

"Forget expires, never deletes" is the invariant (purge.ts:1-7).

### 5.5 `purge_fact`: separate and destructive

`purge_fact` (src/core/facts/purge.ts:1-30) runs only from the trusted local CLI. It is not a mode of `forget`. One transaction:
- Write `fact_purges` (text-free tombstone), and `take_purges` for verbatim takes.
- Hide and rederive derived rows (`derivation_inputs`, `needs_rederive`).
- Delete the fact row and drop fence rows from stored page bodies and `page_versions` snapshots.
- Redact carried request intents. Drop P8 review rows.
- Post-commit: rewrite the Markdown file and commit `gbrain: purge fact <hash8>`.

Refusal triggers (purge-schema.ts:124-187): `facts_refuse_purged` (BEFORE INSERT OR UPDATE OF fact, source_id, visibility, entity_slug), `takes_refuse_purged`, and `pages_refuse_purged` block reinsertion of purged content.

### 5.6 Consolidation

`consolidateFact` (engine-sql/facts.ts:668-670) sets `consolidated_at` and `consolidated_into` (a take id). The caller is the publication path in src/core/persistence/prepared-maintenance.ts:780-800: a consolidation request creates a take with `kind='fact'`, `holder='self'`, then marks each source fact as consolidated into that take, inside the same transaction. Consolidated facts are excluded by `idx_facts_unconsolidated`.

### 5.7 Trajectory

`find_trajectory` (ops/insights.ts:301) calls `findTrajectory` (engine-sql/facts.ts:672-740):
- Filters: `entity_slug`, `source_id` or `source_ids`, `expired_at IS NULL`, world visibility for remote callers, `projectionEligibleSql` (quarantine and rederive gates), optional `claim_metric`, `kind` (`metric` or `event`), `since`/`until` on `valid_from`.
- `ORDER BY valid_from DESC, id DESC LIMIT n`, then reversed to chronological. `clampSearchLimit(limit, 100, 500)`.
- Embeddings returned only when `embedding_model` matches the config value and `embedded_text_hash = md5(fact)`.

The math lives in TypeScript (src/core/trajectory.ts:1-25): a regression fires when a comparable pair (same metric, unit, period, strictly later) drops at least 10% (`GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD`). Drift is `1 - mean(cosine(emb[i], emb[i-1]))`, clamped to [0,1], null with fewer than 3 embedded points.

## 6. Takes, beliefs, calibration

### 6.1 Takes

`takes` (migration v037, src/core/schema-migrations/v037-takes-and-synthesis-evidence.ts:25-49; later changes v043, v048, v080, v094, v142, v251):
- `id BIGSERIAL`, `page_id` (FK cascade), `row_num`, `UNIQUE (page_id, row_num)`.
- `claim`, `kind` (`fact|take|bet|hunch`), `holder TEXT`, `weight REAL` in [0,1] (grid-rounded, v048), `since_date`, `until_date`, `source`, `superseded_by`, `active`.
- Resolution: `resolved_at`, `resolved_outcome`, `resolved_value`, `resolved_unit`, `resolved_source`, `resolved_by`, `resolved_quality` (`correct|incorrect|partial|unresolvable`, v043).
- `embedding VECTOR(N)`, with N matched to config (v142), HNSW partial on `active AND embedding IS NOT NULL`.

Authority: markdown `## Takes` fence is canonical. The DB row is a mirror written through `addTakesBatch` (takes-write.ts:1-20). Writers that create DB-only takes are forbidden because the next sync clobbers them. Resolution columns are rendered into the fence when any row on the page has them (takes-fence.ts:85-93).

### 6.2 Scorecard and calibration

- `getScorecard` (engine-sql/takes.ts:599-648): Brier over resolved `correct`/`incorrect` bets as `AVG((weight - 1{correct})^2)`, plus counts `total_bets`, `resolved`, `correct`, `incorrect`, `partial`, `unresolvable_count`. Scoped by holder, domain prefix, since/until, sources, and privacy.
- `getCalibrationCurve` (engine-sql/takes.ts:650-695): bins by `FLOOR(weight::numeric / bucket)`, `LEAST(..., max_idx)`. The comment (lines 678-681) explains that `NUMERIC` is required because float bucketing differs between Postgres and PGLite at boundaries (e.g. 0.7/0.1 = 6.999...). Rust must use exact decimal or integer arithmetic here.
- Domain assignment: `take_domain_assignments` (v094), with aggregators in src/core/calibration/domain-aggregators.ts:1-20. The aggregator set is closed in code; domain names are open in pack manifests.
- Profiles: `calibration_profiles` (v068:34-60), with `domain_scorecards JSONB`, `active_bias_tags TEXT[]` with GIN, a `published` flag, voice-gate fields, and `model_id`.
- Contradiction runs and an expiring judge cache (engine-sql/takes.ts:141-292).

### 6.3 Synthesis evidence

`synthesis_evidence` (v037): a synthesis page cites `(take_page_id, take_row_num)` with a `citation_index`. Primary key `(synthesis_page_id, take_page_id, take_row_num)`. Derived from markdown by `extract takes` (system-of-record.md:73).

### 6.4 Beliefs: the ledger

"Beliefs" in gbrain names the belief ledger, not the takes. It records what the brain had recorded, and when (BELIEF_LEDGER.md section 1).

`belief_events` (src/core/belief/schema.ts:17-52):
- `event_key BYTEA UNIQUE`, `source_id`, `source_incarnation UUID`, `page_lifetime UUID`, `slug`, `subject_kind` in `page|fact|take|link|link_transition|coverage`, `subject_key`, `event_type`, `origin` in `live|unmanaged|baseline|backfill|reconcile`, `trust_tier`, `visibility`, `publication_id UUID`, `ord`, `recorded_at DEFAULT clock_timestamp()`, `valid_from`, `valid_until`, `value JSONB`, `value_hash`, `prior_hash`, `state_hash`, `cause JSONB`, `claim_fp`, `purged BOOLEAN`, `redacted_fields TEXT[]`.
- Partial index on `claim_fp`; indexes on subject, page lifetime, and publication.

Supporting tables: `belief_page_lifetimes` (partial unique on open lifetimes, schema.ts:54-64), `belief_commit_marks`, `belief_retier_manifest`, `belief_redactions`.

Writes happen in `withBeliefBatch` (belief/ledger.ts:1-25): every committing transaction records one event per changed logical key, before the terminal receipt. Source rows are read under the held page keys.

Purge and redaction are mirrored into the ledger (belief/purge-mirror.ts, belief/purge.ts).

Withdrawal, purge, and redaction are compared in section 5.4-5.5. Forget keeps the expired row and the withdrawal. Purge keeps only text-free tombstones.

## 7. Timeline

`timeline_entries` (schema.sql:645-676):
- `page_id`, `date DATE`, `source TEXT DEFAULT ''`, `summary`, `detail`, `event_page_id` (FK cascade, for Life Chronicle event projections), `created_at`.
- Unique index `idx_timeline_dedup ON (page_id, date, md5(summary), source)`. The md5 key exists because a raw long summary overflowed the btree row limit (#3737, schema.sql:657-660).
- Partial unique `idx_timeline_event_dedup ON (event_page_id, date) WHERE event_page_id IS NOT NULL`.

Writes: `addTimelineEntry` and batch insert via `jsonb_to_recordset` with `ON CONFLICT (page_id, date, md5(summary), source) DO NOTHING` (engine-sql/timeline.ts:38-84).
- `add_timeline_entry` is markdown-first (ops/timeline.ts:45-75). The Markdown Timeline section and inline `[Source: ..., YYYY-MM-DD]` citations are canonical (system-of-record.md:57-60).
- Event projection `upsertEventProjection` (engine-sql/timeline.ts:255-268) writes rows with `event_page_id`. Reads hide rows whose event page is soft-deleted.
- `last_seen` (engine-sql/timeline.ts:225-260): latest dated entry for an entity, considering both direct page matches and `event.who` entries in event frontmatter (`jsonb_array_elements_text`). Uses `date <= as-of`.

## 8. Tags

`tags` (schema.sql:616-628): `page_id` (FK cascade), `tag`, `tag_source` (`frontmatter` | `added` | NULL legacy), `UNIQUE(page_id, tag)`. Indexes on `tag` and `page_id`.

- Frontmatter tags are import-owned: removing one from frontmatter deletes its `frontmatter` row (import-file.ts:828-835).
- An explicit add claims the row as `added`, so import keeps it (page-state/tags.ts:12-14). Whether the add rewrites frontmatter was not traced.
- `getTags` (engine-sql/tags.ts:12-33) is a `SELECT DISTINCT` over the page's rows.

## 9. Page versions

`page_versions` (schema.sql:679-690): `page_id`, `compiled_truth`, `frontmatter JSONB`, `snapshot_at`. Migrations add `timeline`, `knowledge_revision`, `title`, `type`, `tags`, `is_deleted`, `source_path`, `change_reason`, and segmented body references.

- Written on each page write by `createPageVersion` (page-state/versions.ts:30-40).
- Large pages (over `PAGE_INLINE_MAX_BYTES = 1 MiB`, page-size-policy.ts:35) keep only the newest `LARGE_PAGE_VERSIONS_KEPT = 5` (page-body/limits.ts:125). Older rows are deleted with `OFFSET`, and `markPrunedHistory` records the gap (versions.ts:35-40).


## Rust engine implications

What must be preserved exactly:
- Fact fingerprint bytes: `gbrain_fact_fingerprint` normalization and sha256 hex. Withdrawal and purge tombstones key on it. A different normalizer silently un-withdraws facts on reimport.
- Link identity: the five-part unique key with NULL-as-equal semantics, plus `link_source`, `origin_page_id`, and `origin_field`. Derived-link replacement is per origin.
- Entity resolution order and token rule (`sameEntityName`, its noise-token list, the retirement chain of 5 hops, `followRetirement`). Ambiguous namesakes stay unresolved.
- `whois` exact arms and caps (320 chars, 20 types, 100 candidates) and its ambiguity flag.
- Traversal contract: BFS by layer, `(slug, id)` ordering, `TRAVERSE_WALK_ROW_CAP = 20000`, `TRAVERSE_PATH_ROW_CAP = 5000`, `truncated` flags, depth default 5.
- Boost constants and formulas (backlink log factor, adjacency 1.05 with min 2 hits, cross-source 1.10, session demote 0.95, top-K 20), and the floor gate.
- Calibration bucketing with exact decimal arithmetic.
- Supersession thresholds, including "uncalibrated model never cosine-supersedes."
- Timeline dedupe key `(page_id, date, summary-hash, source)`.
- Fence formats for facts and takes, including strikethrough encodings (`superseded by #N`, `forgotten: <reason>`).

What can be simplified:
- Recursive CTEs become in-memory BFS over per-source adjacency maps (forward and reverse). Keep the caps and ordering, not the SQL.
- `pg_advisory_xact_lock` on `source:entity` becomes a per-key mutex in the single writer. `FOR KEY SHARE` and `FOR UPDATE` become write-path serialization, since an embedded store with one writer does not need row locks.
- Triggers (`facts_preserve_withdrawal`, `facts_refuse_purged`, `takes_refuse_purged`, `pages_refuse_purged`) become invariant checks inside the one write function. They must run in the same transaction as the write.
- RLS (enabled on purge and belief tables when the role bypasses RLS) becomes application-level authorization.
- Keep the `near-name` index in process, and keep `page_versions` retention as is.

Postgres feature dependencies:

| Feature | Used by | Rust replacement |
|---|---|---|
| WITH RECURSIVE, MATERIALIZED, DISTINCT ON | traverse, rank_entities, retirement chains | BFS and fold in code |
| pg_trgm `%`, `similarity`, `word_similarity` | resolver fuzzy arm, similar-pages, takes search | Trigram sets computed in Rust; must reproduce pg_trgm scores |
| GIN `jsonb @>` | whois email arms, frontmatter lookup | Hash index on normalized email and frontmatter keys |
| `jsonb_to_recordset` | batch link, takes, timeline inserts | Native batch insert |
| `NULLS NOT DISTINCT` | links unique key | Sentinel for absent origin |
| partial unique indexes | timeline event dedupe, belief lifetimes, takes | Key-prefixed unique tables |
| HNSW halfvec / vector | facts and takes semantic search | HNSW crate or equivalent, f16 or f32 storage |
| tsvector GIN, ts_rank_cd | facts keyword arm, page FTS | Full-text index; ranking will differ |
| advisory xact locks | facts insert, mentions, writeback | Single-writer or per-key locks |
| FOR UPDATE / FOR KEY SHARE | links, withdrawals, purge | Serialized write path |
| SQL triggers | withdrawal and purge guards | Checks in the write function |
| clock_timestamp(), UUID, BYTEA | belief ledger | Native types |

Risks:
- Trigram scores must match pg_trgm closely, because resolver tie-breaks sort on `similarity DESC, slug ASC`. Without a reference implementation, add a golden test set from the TypeScript resolver.
- `ts_rank_cd` ordering will not match BM25. The facts keyword dedupe arm is only a candidate source, so the risk is a different candidate set near the cutoff.
- Calibration bucket boundaries: float arithmetic will misplace boundary weights.
- Authoritative DB-only state (withdrawals, purges, belief events, DB-only facts) has no Markdown backup. The embedded store must be backed up and migrated as the system of record. system-of-record.md:398-440 says rebuild does not recover these.
- The 3-second whole-graph `rank_entities` figure is from Postgres 16. In-memory Rust needs its own benchmark, and memory use for 985k edges must be measured.
- Derived-link revision checks (`DerivedLinkEndpointChangedError`) depend on page revisions. Keep the revision field and check it on publish.

## Open questions

1. Is pg_trgm at default thresholds (0.3 for `%`, 0.6 for `<%`) in production, or is there a config override? The Rust port needs the exact value. [inferred defaults]
2. How many facts are DB-only (no fence) in real brains? system-of-record.md says they are not recoverable from Markdown, and the port's backup plan depends on the count.
3. Is the belief ledger enabled by default? BELIEF_LEDGER.md says "not built," but src/core/belief/ is about 4,100 lines. Owners must confirm before porting.
4. Where is hub dampening (`hubWeight`) wired? No call site was traced.
5. Are `timeline_entries` event-projection rows (`event_page_id`) fully derivable from event pages' frontmatter?
6. Are `calibration_profiles` published snapshots authoritative history, or recomputable views?
7. Does a tag add with `tag_source='added'` write back to frontmatter? page-state/tags.ts was only partly read.
8. Which code-constant vocabularies must be copied exactly? At least NAME_NOISE_TOKENS (resolve.ts:166) and the correction cue lists in search/saved-facts-match.ts.
