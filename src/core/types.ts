// Page types
// v0.38: `PageType` opens from a closed 23-element union to `string`. The
// closed union was always a fiction — every gbrain user accumulated organic
// types (`apple-note`, `therapy-session`, `tweet-bundle`, etc.) via
// `as PageType` casts the engine never enforced. v0.38 schema packs make
// the runtime authoritative: validation moves from compile-time
// exhaustiveness to pack-driven runtime checks against the active schema
// pack's declared types.
//
// Backward compat: `ALL_PAGE_TYPES` stays as the canonical list of types
// `gbrain-base` declares (the universal starter pack). It is NO LONGER an
// exhaustive enum — it is the seed set that reproduces pre-v0.38 hardcoded
// behavior. Schema packs can add, alias, or remove types via their manifest;
// the engine consults `loadActivePack()` for the runtime view.
//
// Historical type docs (kept for `gbrain-base` codegen reference):
// - email | slack | calendar-event: native Page types for inbox/chat/calendar
//   ingest (and the amara-life-v1 eval corpus in the sibling gbrain-evals repo).
//   Previously these collapsed into `source`, which lost workflow semantics
//   (e.g. "attended meetings" vs "received emails").
// - `code` (v0.19.0): tree-sitter-chunked source files; consumed by code-def /
//   code-refs / code-callers / code-callees + Cathedral II two-pass retrieval.
// - `image` (v0.27.1): multimodal-embedded images (PNG/JPG/HEIC/AVIF). One page
//   per image; chunk lives in content_chunks with modality='image' +
//   embedding_image vector(1024). Bytes never enter the DB; the brain repo
//   holds the file and `files.storage_path` references it.
// - `synthesis` (v0.28): think-generated provenance pages.
export type PageType = string;

/**
 * v0.38: Seed list of types declared by the built-in `gbrain-base` schema
 * pack. NO LONGER exhaustive — schema packs add their own types via manifest.
 * This array is referenced by `scripts/generate-gbrain-base.ts` codegen to
 * produce the `gbrain-base.yaml` pack manifest that reproduces today's
 * hardcoded behavior byte-for-byte.
 *
 * Pre-v0.38 contract: this list was exhaustive and the `page-type-exhaustive`
 * test walked every value through public surfaces. v0.38 relaxes that —
 * the test now verifies these BASE types are still recognized, but new
 * pack-declared types are validated by the schema-pack runtime, not by
 * type-system exhaustiveness.
 */
export const ALL_PAGE_TYPES: readonly string[] = [
  'person', 'company', 'deal', 'yc', 'civic', 'project', 'concept',
  'source', 'media', 'writing', 'analysis', 'guide', 'hardware',
  'architecture', 'meeting', 'note', 'email', 'slack', 'calendar-event',
  // v0.41.11+ — `conversation` (imported chat/transcript pages, lives
  // under conversations/) and `atom` (smallest extractable claim unit,
  // lives under atoms/). Both promoted into the gbrain-base seed list
  // so they share the universal validation surface with the rest of
  // the base types; their pack entries are declared in
  // src/core/schema-pack/base/gbrain-base.yaml.
  'conversation', 'atom',
  'code', 'image', 'synthesis',
  // v0.42 — `extract_receipt` pages record extraction-run outcomes as
  // first-class brain memory. Slug-prefix `extracts/`. Demoted in search
  // via DEFAULT_SOURCE_BOOSTS (factor 0.3) and excluded from extraction
  // loops via the dream_generated:true + type:extract_receipt belt-and-
  // suspenders pattern per plan D-EXTRACT-19.
  'extract_receipt',
  // v0.42.x — Life Chronicle (#2390). `event` = timeline atom
  // (when·where·who·what), lives under life/events/; `diary` = first-person
  // interiority, lives under life/diary/. Both temporal-primitive,
  // extractable:false (events are one-line atoms; diary is private interiority
  // never mined into the facts table). Pack entries in gbrain-base.yaml.
  'event', 'diary',
] as const;

/**
 * v0.38: PageType is now `string`. The pre-v0.38 `assertNever` helper used
 * to enforce exhaustive switches over the closed PageType union; with the
 * open-type model, that pattern moves to per-primitive switches (the
 * 5-element primitive enum still gives compile-time exhaustiveness via
 * narrowing, but page types themselves no longer do).
 *
 * Kept as a generic exhaustiveness helper for switches over the closed
 * `PackPrimitive` enum (entity | media | temporal | annotation | concept)
 * declared by `src/core/schema-pack/primitives.ts`. NOT used on PageType
 * itself anymore.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}

export interface Page {
  id: number;
  slug: string;
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash?: string;
  /** v0.29 — deterministic 0..1 score; populated by the recompute_emotional_weight cycle phase. */
  emotional_weight?: number;
  created_at: Date;
  updated_at: Date;
  /**
   * v0.26.5: when present, the page is soft-deleted. Hidden from search and
   * from `getPage` / `listPages` by default; surface via `include_deleted: true`.
   * The autopilot purge phase hard-deletes rows where `deleted_at < now() - 72h`.
   */
  deleted_at?: Date | null;
  /**
   * v0.29.1: content date computed from frontmatter precedence chain
   * (event_date / date / published / filename / fallback). Populated by
   * `computeEffectiveDate`; immune to auto-link updated_at churn. Read by
   * the recency boost and since/until filter; nothing in the default search
   * path consults it.
   */
  effective_date?: Date | null;
  /**
   * v0.29.1: which precedence step won (`event_date | date | published |
   * filename | fallback`). Powers the doctor's `effective_date_health` check
   * to detect pages that fell back to updated_at because frontmatter was
   * unparseable.
   */
  effective_date_source?: EffectiveDateSource | null;
  /**
   * v0.29.1: basename without extension captured at import (e.g.
   * "2024-03-15-acme-call"). Used by computeEffectiveDate for filename-date
   * precedence on `daily/` and `meetings/` prefixes. NULL for older rows
   * imported pre-v0.29.1.
   */
  import_filename?: string | null;
  /**
   * v0.29.1: bumped by `recompute_emotional_weight` when the page's
   * emotional_weight changes. The salience query window uses
   * `GREATEST(updated_at, salience_touched_at)` so newly-salient old pages
   * surface in `get_recent_salience`.
   */
  salience_touched_at?: Date | null;
  /**
   * v0.31.12: source that owns this page. Populated by rowToPage from the
   * `source_id` column so callers like `embed` can thread it through
   * getChunks / upsertChunks without defaulting to 'default'.
   *
   * v0.32.8: required. The DB column is `NOT NULL DEFAULT 'default'`, so
   * `rowToPage` always returns it from the engine. Callers can now thread
   * `page.source_id` directly without `!` non-null assertions.
   *
   * Test fixtures building synthetic Page rows must include this field.
   */
  source_id: string;

  // v0.39.3.0 provenance read-path (WARN-8 + CV5). Migration v81 columns
  // surfaced through getPage / list_pages so `gbrain call get_page | jq
  // .source_kind` actually returns the value the put_page op wrote. NULL
  // on historical pages that pre-date v0.38. Three-state read pattern
  // (undefined: not in projection, null: column NULL, populated: real
  // value) — matches the v0.26.5 deleted_at convention so SELECTs that
  // don't project these columns continue to compile.
  /** Ingestion-channel taxonomy. See PageInput.source_kind for the closed set. */
  source_kind?: string | null;
  /** Original URI/path/message-id the ingestion event carried. */
  source_uri?: string | null;
  /** Richer label paired with source_kind (often same value; indexable separately). */
  ingested_via?: string | null;
  /** Server-stamped first-write audit timestamp; CV12 COALESCE-preserved across edits. */
  ingested_at?: Date | null;
  /**
   * v0.40.3.0 (renumbered from v0.40.3.0 v81 to v90 on master merge):
   * which contextual retrieval tier the page was last embedded under. One
   * of CRMode ('none' | 'title' | 'per_chunk_synopsis'). NULL on pre-v90
   * rows; drift detection treats NULL as 'none' for reindex predicates,
   * so unmigrated pages enter the sweep on first upgrade to non-conservative
   * mode.
   */
  contextual_retrieval_mode?: CRMode | null;
  /**
   * v0.40.3.0 (renumbered from v0.40.3.0 v81 to v90 on master merge):
   * composite hash of (synopsis_prompt_version, haiku_model,
   * title_wrapper_version, embedding_model) captured at write time by
   * `reembedPageWithContextualRetrieval`. Used by `query_cache.page_generations`
   * for document-side cache invalidation per D27 P1-5. NULL on pre-v90 rows.
   */
  corpus_generation?: string | null;
}

export type EffectiveDateSource =
  | 'event_date'
  | 'date'
  | 'published'
  | 'filename'
  | 'fallback';

// `image` (v0.27.1): multimodal ingestion path, parallel to markdown + code.
export type PageKind = 'markdown' | 'code' | 'image';

/**
 * v0.40.3.0 — contextual retrieval tier ladder per `search.mode`.
 *
 *   none                — no wrapper applied at embed time (conservative)
 *   title               — `<context>{title}</context>\n{chunk}` (balanced)
 *   per_chunk_synopsis  — per-chunk Haiku synopsis prepended (tokenmax)
 *
 * Resolution chain (highest wins): page frontmatter > source row > global
 * mode bundle. Mount-frontmatter overrides are honored only when the
 * source's `trust_frontmatter_overrides` flag is true (host source
 * id='default' is always trusted). See
 * `src/core/contextual-retrieval-resolver.ts`.
 */
export const CR_MODES = ['none', 'title', 'per_chunk_synopsis'] as const;
export type CRMode = typeof CR_MODES[number];

/** Type guard for parsing untrusted frontmatter / config values. */
export function isCRMode(value: unknown): value is CRMode {
  return typeof value === 'string' && (CR_MODES as readonly string[]).includes(value);
}

export interface PageInput {
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  content_hash?: string;
  /**
   * v0.19.0: distinguishes markdown vs code pages at the DB level. Defaults
   * to 'markdown' when omitted so existing callers work unchanged. Set to
   * 'code' by importCodeFile; drives orphans filter, auto-link bypass, and
   * `query --lang` filtering.
   */
  page_kind?: PageKind;
  /**
   * v0.29.1: content date from frontmatter precedence (computed by importer
   * via `computeEffectiveDate`). When omitted, putPage leaves the column
   * unchanged on conflict (preserves any existing value); on insert the
   * column is NULL. NULL is fine — recency paths COALESCE to updated_at.
   */
  effective_date?: Date | null;
  /** v0.29.1: paired with effective_date; NULL when effective_date is NULL. */
  effective_date_source?: EffectiveDateSource | null;
  /** v0.29.1: basename without extension captured at import. */
  import_filename?: string | null;
  /**
   * v0.32.7 CJK wave: bumped to MARKDOWN_CHUNKER_VERSION (2) on import so the
   * post-upgrade `gbrain reindex --markdown` sweep can find pre-bump pages
   * via `WHERE chunker_version < 2`. Defaults to 1 at the schema level when
   * omitted (existing rows pre-migration inherit 1; new imports overwrite
   * with the current version).
   */
  chunker_version?: number | null;
  /**
   * v0.32.7 CJK wave: repo-relative import path. Lets sync's delete/rename
   * paths resolve a frontmatter-fallback slug back to its filesystem source
   * (CJK + emoji + exotic-script files whose path doesn't derive a slug).
   * NULL on legacy / non-file callers (MCP `put_page`, fixture seeds).
   */
  source_path?: string | null;

  // v0.39.3.0 provenance write-through (WARN-8 + A1 + CV6).
  // Migration v81 added these 4 nullable columns to `pages`. Until v0.39.3.0,
  // put_page wrote them into the file's frontmatter (via the write-through
  // path) but never to the DB columns — `gbrain call get_page | jq .source_kind`
  // returned null even though the JSON receipt claimed `capture-cli`. These
  // params close the loop. Trust gate lives at the put_page op layer
  // (operations.ts): ONLY ctx.remote === false (trusted local callers like
  // capture CLI, autopilot, dream cycle) may populate these fields. Remote
  // MCP callers get server-stamped `mcp:put_page` regardless of what they
  // pass (CV6 fail-closed; closes the spoofing surface where a write-scope
  // OAuth token could poison the audit trail with arbitrary labels).
  //
  // Storage shape: nullable TEXT columns; the engine's putPage SQL uses
  // COALESCE-preserve UPDATE semantics (CV12) so omitting these fields on
  // a later put_page (e.g. a routine edit) does NOT erase the original
  // ingestion's audit trail. First-write wins.
  /**
   * Ingestion-channel taxonomy: 'capture-cli' | 'webhook' | 'file-watcher' |
   * 'inbox-folder' | 'cron-scheduler' | 'put_page' | 'mcp:put_page' |
   * '<skillpack-kind>'. Server stamps `mcp:put_page` for remote callers.
   */
  source_kind?: string | null;
  /** Original URI/path/message-id the event carried (file path, mail message-id, URL). NULL when unknown. */
  source_uri?: string | null;
  /**
   * Richer label paired with source_kind (often the same value; kept narrow
   * + indexable separately per migration v81's documented intent).
   */
  ingested_via?: string | null;
  /**
   * Always server-stamped at put_page time when any provenance is being
   * written (NEVER client-controlled — keeps the audit timestamp truthful).
   * NULL on historical rows that pre-date v0.38.
   */
  ingested_at?: Date | null;
}

export interface PageFilters {
  type?: PageType;
  tag?: string;
  limit?: number;
  offset?: number;
  /** ISO date string (YYYY-MM-DD or full ISO timestamp). Filter to pages updated_at > value. */
  updated_after?: string;
  /**
   * Prefix-match filter on slug. Implemented as `WHERE slug LIKE prefix || '%'`
   * in both engines so it uses the (source_id, slug) UNIQUE constraint's btree
   * index for efficient range scans on large brains. Used by storage-tiering
   * commands (gbrain storage status, gbrain export --restore-only) to scope
   * queries to a tier directory without loading every page into memory.
   */
  slugPrefix?: string;
  /**
   * v0.26.5: include soft-deleted pages (rows with `deleted_at IS NOT NULL`).
   * Default false: hides soft-deleted pages from `list_pages` so agents see the
   * same set search returns. Set true to enumerate the recoverable set during
   * the 72h window before the autopilot purge phase hard-deletes them.
   */
  includeDeleted?: boolean;
  /**
   * v0.29: ORDER BY enum. Default `updated_desc` matches pre-v0.29 behavior
   * (engines hardcoded `ORDER BY updated_at DESC`). New options: `updated_asc`,
   * `created_desc`, `slug` (alphabetical, useful for stable pagination).
   * Whitelisted enum — no SQL-injection risk; engines map to literal SQL fragments.
   */
  sort?: 'updated_desc' | 'updated_asc' | 'created_desc' | 'slug';
  /**
   * v0.31.12: filter to a specific source. When omitted, listPages returns
   * pages from all sources (pre-existing semantics). Use to scope embed/extract
   * operations to a single source.
   */
  sourceId?: string;
  /**
   * v0.34.1 (#876, D9): filter to ANY of these sources (federated read).
   * Engine applies `WHERE p.source_id = ANY($N::text[])` when array is set.
   * Caller precedence: if BOTH `sourceId` and `sourceIds` are set, the array
   * wins (the federated semantics subsume the single-source case via an
   * array of length 1). When neither is set, no filter applies — the
   * pre-v0.34 unscoped behavior is preserved for local CLI callers.
   */
  sourceIds?: string[];
}

/** v0.26.5 — opts for getPage / softDeletePage / restorePage. */
export interface GetPageOpts {
  /** Filter to a specific source. When omitted, getPage returns the first slug match across sources (pre-existing semantics). */
  sourceId?: string;
  /**
   * Filter to a federated set of sources (the caller's allowedSources grant).
   * Takes precedence over `sourceId` when non-empty. Closes the #1393 leak: the
   * get_page exact path must honor a federated grant, not just scalar sourceId.
   */
  sourceIds?: string[];
  /** Include soft-deleted pages. Default false. See PageFilters.includeDeleted. */
  includeDeleted?: boolean;
}

/** v0.29: literal ORDER BY fragments for the PageFilters.sort enum. Whitelisted. */
export const PAGE_SORT_SQL: Record<NonNullable<PageFilters['sort']>, string> = {
  updated_desc: 'p.updated_at DESC',
  updated_asc:  'p.updated_at ASC',
  created_desc: 'p.created_at DESC',
  slug:         'p.slug ASC',
};

/**
 * v0.29 — Salience: pages ranked by emotional + activity salience over a recency window.
 * See `src/core/cycle/emotional-weight.ts` for the score formula and
 * `engine.getRecentSalience` for the SQL.
 */
/**
 * v0.37.0 — domain-bank sampling for `gbrain brainstorm` / `gbrain lsd`.
 * Pulls one page per prefix from a caller-supplied prefix list.
 * Tiebreaker via JOIN to page_links (inbound link count = "structural centrality").
 * Stale-bias optional (LSD mode prefers forgotten pages via `last_retrieved_at`).
 * sourceId/sourceIds threaded from day 1 per [source-id-canonical-thread].
 */
export interface DomainBankSampleOpts {
  /** Top-level slug prefixes to sample from (e.g. ['wiki/vc', 'wiki/biology']). */
  prefixes: string[];
  /** Slugs to exclude (typically the close-set from hybridSearch). */
  excludeSlugs?: string[];
  /** When true, prefer pages with NULL last_retrieved_at or > staleThresholdDays old. */
  staleBias?: boolean;
  /** Days threshold for "stale" classification. Default 90. */
  staleThresholdDays?: number;
  /** Single-source scope (canonical scalar form). */
  sourceId?: string;
  /** Federated read scope (array form, wins over scalar). */
  sourceIds?: string[];
}

/** v0.37.0 — corpus-sampling fallback for `gbrain brainstorm` when prefix-stratified can't fill M. */
export interface CorpusSampleOpts {
  /** Number of pages to sample. */
  n: number;
  /** Slugs to exclude (close-set + already-picked-by-prefix-stratified). */
  excludeSlugs?: string[];
  /** Stable seed for deterministic sampling in tests. Falls back to random when omitted. */
  seed?: number;
  /** Single-source scope. */
  sourceId?: string;
  /** Federated read scope. */
  sourceIds?: string[];
}

/** v0.37.0 — one row per page returned by domain-bank's prefix/corpus sampling. */
export interface DomainBankRow {
  slug: string;
  source_id: string;
  /** Top-level prefix (`^[^/]+/[^/]+`) or null for short slugs. */
  prefix: string | null;
  page_id: number;
  title: string | null;
  /** Page body — what gets injected into the brainstorm prompt as "the user wrote..." */
  compiled_truth: string;
  /** COUNT(page_links.id WHERE to_page_id = this) — inbound link count, the "structural centrality" tiebreaker (D10). */
  connection_count: number;
  /** When this page was last surfaced by a user-facing search/query. Powers LSD stale-bias. */
  last_retrieved_at: Date | null;
  /** Lowest chunk_index with non-null embedding on the default embedding_column. Null if no embedded chunks. */
  representative_chunk_id: number | null;
}

export interface SalienceOpts {
  /** Window in days. Default 14. */
  days?: number;
  /** Max rows to return (clamped at 100). Default 20. */
  limit?: number;
  /** Optional slug-prefix filter (e.g., `personal`, `wiki/people`). */
  slugPrefix?: string;
  /**
   * v0.29.1 — recency-decay treatment for the salience formula's third term.
   *   - 'flat' (default): v0.29.0 behavior, `1.0 / (1 + days_old)` for every page
   *   - 'on': per-prefix decay from DEFAULT_RECENCY_DECAY (concepts/originals
   *     evergreen; daily/, media/x/ aggressive). Use when the agent wants
   *     "recency-biased salience" — what's been mattering AND fresh.
   * Default preserves v0.29.0 ranking; 'on' is opt-in.
   */
  recency_bias?: 'flat' | 'on';
}

export interface SalienceResult {
  slug: string;
  source_id: string;
  title: string;
  type: PageType;
  updated_at: Date;
  emotional_weight: number;
  take_count: number;
  take_avg_weight: number;
  score: number;
}

/**
 * v0.41.39 (issue #1700) — `gbrain enrich --thin` candidate selection.
 *
 * One source-aware SQL query enumerates thin (stub) pages of the given
 * types, computes a source-correct inbound-link count per page, applies an
 * optional re-enrich recency guard, orders by the chosen signal, and slices
 * to `limit`. Returns a LIGHTWEIGHT projection (no page bodies) so a 100K-
 * page brain doesn't pull every stub body into memory just to rank them.
 *
 * Why a dedicated engine method instead of composing `listPages` +
 * `getBacklinkCounts` in memory:
 *   - `getBacklinkCounts` groups by bare `slug`, so the same slug in two
 *     sources collapses/contaminates the count. This query counts inbound
 *     links per page row (`to_page_id = p.id`), which is source-correct by
 *     construction.
 *   - `listPages` returns full `Page` rows (bodies). 500 stub bodies per
 *     type per source is not a memory guarantee. This projection carries
 *     only `body_len`, never the body.
 */
export interface EnrichCandidatesOpts {
  /** Page types to consider (e.g. ['person', 'company']). Empty → no rows. */
  types: PageType[];
  /** Body-length (chars) below which a page is "thin". */
  thinThreshold: number;
  /** Ordering signal. Whitelisted via ENRICH_ORDER_SQL. */
  order: 'inbound-links' | 'updated' | 'salience';
  /** Max rows to return. */
  limit: number;
  /**
   * Skip pages whose frontmatter `enriched_at` is newer than
   * `now - reenrichAfterMs`. Omitted/0 → no recency guard (every thin page
   * is eligible). Pages never enriched (no `enriched_at`) are always eligible.
   */
  reenrichAfterMs?: number;
  /** Single-source scope (canonical scalar form). */
  sourceId?: string;
  /** Federated read scope (array form, wins over scalar). */
  sourceIds?: string[];
}

/** v0.41.39 — one row per enrich candidate. Lightweight: NO page body. */
export interface EnrichCandidate {
  slug: string;
  source_id: string;
  title: string;
  type: PageType;
  /** char_length(compiled_truth) + char_length(timeline). */
  body_len: number;
  /** Source-correct inbound-link count (excludes `link_source='mentions'`). */
  inbound_count: number;
}

/**
 * v0.41.39 — whitelisted ORDER BY fragments for EnrichCandidatesOpts.order.
 * No SQL-injection risk: callers pass the enum, engines map to these literal
 * fragments. Every fragment ends with the (source_id, slug) tiebreaker so
 * tied scores produce a deterministic order across engines and runs.
 */
export const ENRICH_ORDER_SQL: Record<EnrichCandidatesOpts['order'], string> = {
  'inbound-links': 'inbound_count DESC, p.source_id ASC, p.slug ASC',
  'updated':       'p.updated_at DESC, p.source_id ASC, p.slug ASC',
  'salience':      'p.emotional_weight DESC, inbound_count DESC, p.source_id ASC, p.slug ASC',
};

/**
 * v0.29 — Anomaly detection: cohorts (tag, type) with unusually-high activity in a window.
 * Cohort baseline is computed over `lookback_days` excluding `since`; current count is
 * the number of distinct pages touched on `since`. A cohort is anomalous when its
 * current count exceeds `mean + sigma * stddev`. Year cohort deferred to v0.30.
 */
export interface AnomaliesOpts {
  /** ISO date (YYYY-MM-DD). Default = today (UTC). */
  since?: string;
  /** Days of history for the baseline. Default 30. */
  lookback_days?: number;
  /** Sigma threshold. Default 3.0. */
  sigma?: number;
}

export interface AnomalyResult {
  cohort_kind: 'tag' | 'type';
  cohort_value: string;
  count: number;
  baseline_mean: number;
  baseline_stddev: number;
  sigma_observed: number;
  page_slugs: string[];
}

/**
 * v0.29 — Per-page tag + take inputs to the emotional-weight formula.
 * Returned in batch by `engine.batchLoadEmotionalInputs` so the cycle phase
 * computes weights for many pages with two SQL round-trips total.
 */
export interface EmotionalWeightInputRow {
  slug: string;
  source_id: string;
  tags: string[];
  takes: {
    holder: string;
    weight: number;
    kind: string;
    active: boolean;
  }[];
}

/**
 * v0.29 — Multi-source-safe write batch. Composite-keyed on `(slug, source_id)`
 * because `pages.slug` is only unique within a source. Slug-only UPDATE would
 * fan out across sources.
 */
export interface EmotionalWeightWriteRow {
  slug: string;
  source_id: string;
  weight: number;
}

// Chunks
export interface Chunk {
  id: number;
  page_id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline' | 'fenced_code';
  embedding: Float32Array | null;
  model: string;
  token_count: number | null;
  embedded_at: Date | null;
  /** v0.19.0 code metadata (NULL for markdown chunks). */
  language?: string | null;
  symbol_name?: string | null;
  symbol_type?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  /** v0.20.0 Cathedral II (NULL for markdown chunks). */
  parent_symbol_path?: string[] | null;
  doc_comment?: string | null;
  symbol_name_qualified?: string | null;
}

/**
 * Lightweight row shape returned by `BrainEngine.listStaleChunks()`.
 * Excludes the `embedding` column on purpose — only chunks needing
 * an embedding come back, and we don't ship the (always-null on stale
 * rows) embedding bytes over the wire. See `embed --stale` egress fix.
 */
export interface StaleChunkRow {
  slug: string;
  chunk_index: number;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline';
  model: string | null;
  token_count: number | null;
  /** v0.31.12: source_id so embed --stale can thread it through getChunks/upsertChunks. */
  source_id: string;
  /** v0.33.3: page_id for cursor pagination in listStaleChunks. */
  page_id: number;
}

/**
 * v0.42.7 (#1696) — a page that needs link/timeline extraction, returned by
 * `listStalePagesForExtraction`. Carries the page CONTENT (compiled_truth +
 * timeline + frontmatter) so `gbrain extract --stale` extracts in ~1 query per
 * batch instead of an N+1 `getPage` per page (mirrors how StaleChunkRow carries
 * chunk_text). `id` is the keyset cursor; `updated_at` lets callers reason about
 * the edited-since-extract staleness arm.
 */
export interface StalePageRow {
  id: number;
  slug: string;
  source_id: string;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  updated_at: Date;
  /**
   * Full-precision (microsecond) UTC ISO string of `updated_at`, projected
   * straight from the DB via `to_char(... AT TIME ZONE 'UTC', '...US"Z"')`.
   * `updated_at` (a JS `Date`) is millisecond-truncated, so stamping it back as
   * `links_extracted_at` left the row permanently stale on Postgres (#1768).
   * `extractStaleFromDB` stamps THIS instead, so `links_extracted_at` equals the
   * DB `updated_at` exactly and the staleness predicate clears.
   */
  updated_at_iso: string;
}

export interface ChunkInput {
  chunk_index: number;
  chunk_text: string;
  /**
   * 'image_asset' added in v0.27.1. Image chunks live in content_chunks
   * alongside text/code chunks; modality='image' rows are filtered out of
   * searchKeyword by default so OCR text doesn't drown text-page search.
   */
  chunk_source: 'compiled_truth' | 'timeline' | 'fenced_code' | 'image_asset';
  embedding?: Float32Array;
  model?: string;
  token_count?: number;
  /**
   * v0.27.1 multimodal. modality 'image' carries its 1024-dim Voyage vector
   * in embedding_image (not embedding). Markdown + code chunks omit both
   * fields and inherit modality='text' via column DEFAULT.
   */
  modality?: 'text' | 'image';
  embedding_image?: Float32Array;
  /**
   * v0.19.0: optional code-chunk metadata. Populated by importCodeFile from
   * the tree-sitter AST; NULL for markdown chunks. Drives `query --lang`,
   * `code-def`, `code-refs`, and the new searchCodeChunks engine method.
   */
  language?: string;
  symbol_name?: string;
  symbol_type?: string;
  start_line?: number;
  end_line?: number;
  /**
   * v0.20.0 Cathedral II: qualified symbol identity + parent scope +
   * doc-comment. All populated by importCodeFile from the AST (Layer 5/6);
   * NULL for markdown chunks unless D2 fence extraction populated them.
   */
  parent_symbol_path?: string[];
  doc_comment?: string;
  symbol_name_qualified?: string;
}

// Search
export interface SearchResult {
  slug: string;
  page_id: number;
  title: string;
  type: PageType;
  chunk_text: string;
  chunk_source: 'compiled_truth' | 'timeline';
  chunk_id: number;
  chunk_index: number;
  score: number;
  stale: boolean;
  /**
   * v0.42 (issue #1699) content-quality gate agent-warning channel. Set
   * when the result's page carries a `frontmatter.content_flag` marker
   * (fuzzy markup-heavy or oversize). The page is still searchable — this
   * is the "this looks odd, examine if you expected real content" signal
   * the agent reads to decide whether to trust the page. Stamped post-
   * fusion by `stampContentFlags` (the v0.41.34 stampEvidence precedent).
   * Absent when the page is clean.
   */
  content_flag?: { reason: string; detail: string };
  /**
   * v0.36 (cross-modal wave): the chunk's modality discriminator from
   * content_chunks.modality. 'text' for the existing text-embedding rows,
   * 'image' for rows populated by importImageFile. Surfaced so callers /
   * renderers can distinguish text matches from image matches in `'both'`
   * mode results. Optional for back-compat with engines that don't project
   * the column (defaults to 'text' in renderers when absent).
   */
  modality?: 'text' | 'image';
  /**
   * v0.18.0: the sources.id the page belongs to. Dedup composite-keys
   * on (source_id, slug) — see src/core/search/dedup.ts. Defaults to
   * 'default' for pre-v0.17 rows that lacked the column.
   */
  source_id?: string;
  /**
   * v0.34 — page-level effective_date (and its source) carried through from
   * the pages join. Format: YYYY-MM-DD (ISO date-only). Consumers (currently
   * the contradiction probe's date-aware judge prompt + date pre-filter)
   * treat null and undefined the same: "no temporal anchor for this chunk."
   * Pre-v0.34 engines that don't project these columns leave both undefined.
   */
  effective_date?: string | null;
  effective_date_source?: string | null;
  /**
   * v0.40.4 graph signals — populated by applyGraphSignals when the
   * graph_signals mode-bundle knob is on. Surfaced in JSON envelope
   * for agent introspection + the `gbrain search --explain` formatter.
   */
  /** Number of OTHER top-K pages linking to this page (>= ADJACENCY_MIN_HITS). */
  graph_adjacency_hits?: number;
  /** Number of distinct OTHER source_ids (excluding this page's own source)
   *  linking to this page from within top-K (>= CROSS_SOURCE_MIN_HITS). */
  graph_cross_source_hits?: number;
  /** True when this result was demoted (score multiplied by SESSION_DEMOTE)
   *  because it shares a session prefix with a higher-scoring result. */
  graph_session_demoted?: boolean;
  /** Slug prefix used for the session-diversification grouping. */
  graph_session_prefix?: string;
  /**
   * v0.43 relational recall arm — set when this result was surfaced by
   * typed-edge traversal (not lexical/vector). Drives `gbrain search
   * --explain` attribution ("surfaced via invested_in edge from widget-co").
   * Absent for organic keyword/vector results.
   */
  /** Edge types the result was reached by (e.g. ['invested_in']). */
  relational_via_link_types?: string[];
  /** The resolved seed entity slug the traversal started from. */
  relational_seed?: string;
  /** Shortest hop distance from the seed (1 = direct neighbor). */
  relational_hop?: number;
  /** Shortest connecting slug path seed→…→result (for "how I know this"). */
  relational_path?: string[];
  /**
   * v0.40.4 full attribution (D12=A) — per-stage score deltas for the
   * `gbrain search --explain` formatter. Every boost stage stamps its
   * contribution so the formatter can reconstruct the score derivation.
   *
   * base_score is captured once at runPostFusionStages entry BEFORE any
   * mutation; the other fields are stamped by their respective stages.
   */
  /** RRF + cosine score BEFORE any boost stage mutated it. */
  base_score?: number;
  /** Multiplier applied by applyBacklinkBoost (1.0 = unchanged). */
  backlink_boost?: number;
  /** Multiplier applied by applySalienceBoost. */
  salience_boost?: number;
  /** Multiplier applied by applyRecencyBoost. */
  recency_boost?: number;
  /** v0.42.x (#2390) — multiplier applied by applyChronicleTypeBoost (event/diary on temporal queries). */
  chronicle_boost?: number;
  /** Multiplier applied by applyExactMatchBoost. */
  exact_match_boost?: number;
  /** Multiplier applied by applyGraphSignals (adjacency hit). */
  graph_adjacency_boost?: number;
  /** Multiplier applied by applyGraphSignals (cross-source hit). */
  graph_cross_source_boost?: number;
  /** Multiplier applied by applyGraphSignals (session demote; <1.0). */
  session_demote_factor?: number;
  /** Post-rerank rank delta: original_index - new_index in the reranker's
   *  topNIn head. Positive means rank improved (moved closer to top).
   *  Undefined when no reranker fired. The raw reranker relevance score
   *  is separately stamped as `rerank_score` for back-compat. */
  reranker_delta?: number;
  /** Raw cross-encoder relevance score stamped by applyReranker on the
   *  reranked head (undefined when no reranker fired). Distinct from `score`
   *  (RRF + boosts). v0.42.3.0 autocut cuts on this — the trustworthy
   *  separatrix — never on RRF/cosine. */
  rerank_score?: number;
  /**
   * v0.42 (T19, plan D6) — multiplier applied by applyAliasResolvedBoost
   * (1.0 = unchanged; default 1.05x). Fires when the result's slug is
   * a canonical_slug in slug_aliases — the page is the authoritative
   * version of 1+ aliases. Signals "user explicitly disambiguated this
   * as canonical" and lets canonicals outrank fuzzy matches.
   */
  alias_resolved_boost?: number;
  /**
   * T2 (retrieval-maxpool incident) — multiplier applied by applyTitleBoost
   * (1.0 = unchanged; default ~1.25x). Fires when the normalized query is a
   * contiguous token-run inside the page title (or an exact full-title match).
   * Floor-ratio-gated + clamped so a title hit reorders without burying a
   * strong semantic match or lying about base_score (the agent's dedup gate
   * keys off base_score / evidence, not the boosted score).
   */
  title_match_boost?: number;
  /**
   * T3 (retrieval-maxpool incident) — set when this result was surfaced or
   * boosted by the free-text alias hop (the query exactly matched a page's
   * declared alias in page_aliases). An injected canonical that wasn't in the
   * organic candidate set carries alias_hit=true with score = top-of-organic
   * + epsilon. Drives the evidence=alias_hit signal the agent's don't-duplicate
   * decision keys off (T4).
   */
  alias_hit?: boolean;
  /**
   * T4 — the strongest signal that surfaced this page (alias_hit >
   * exact_title_match > high_vector_match > keyword_exact > weak_semantic).
   * Computed by classifyEvidence at the end of the hybrid pipeline.
   */
  evidence?: import('./search/evidence.ts').Evidence;
  /**
   * T4 — derived "is this page already in the brain?" hint. The agent's
   * don't-write-a-duplicate decision keys off THIS, not a raw score:
   * 'exists' = strong (don't duplicate), 'probable' = prefer update,
   * 'unknown' = look closer. This is the contract that prevents the
   * incident's duplicate-stub class.
   */
  create_safety?: import('./search/evidence.ts').CreateSafety;
}

/**
 * v0.40.4 — adjacency aggregates for a single page within a
 * subgraph induced by an input set. Returned by
 * BrainEngine.getAdjacencyBoosts.
 */
export interface AdjacencyRow {
  /** Distinct from_page_id count, restricted to the input set. */
  hits: number;
  /**
   * Distinct OTHER source_id count, restricted to the input set,
   * EXCLUDING the target page's own source. A page in source A linked
   * from 2 pages in source A reports cross_source_hits = 0. Linked
   * from 1 in source B + 1 in source C reports 2. The exclusion of
   * self-source matches the "cross-team corroboration" intent
   * (D15=A in the v0.40.4 plan).
   */
  cross_source_hits: number;
}

/**
 * v0.36 (D12) — declared shape of one entry in the `embedding_columns`
 * config registry. Users declare entries via `gbrain config set
 * embedding_columns '...JSON...'` (DB plane); resolver merges with
 * built-ins. Field validation lives in src/core/search/embedding-column.ts
 * and runs at load time:
 *
 *   provider:   parseable 'provider:model' (e.g. 'voyage:voyage-3-large')
 *   dimensions: positive integer 1..8192
 *   type:       'vector' | 'halfvec'
 *
 * The registry KEY itself (the column name) is also regex-validated
 * (/^[a-z_][a-z0-9_]*$/) so a malicious config write can't smuggle a
 * SQL fragment in via the key.
 */
export interface EmbeddingColumnConfig {
  /** 'provider:model' identifier, e.g. 'voyage:voyage-3-large'. */
  provider: string;
  /** Dimensions of the stored vector. Must match actual DB column. */
  dimensions: number;
  /** pgvector type — drives the SQL cast at search time. */
  type: 'vector' | 'halfvec';
}

/**
 * v0.36 (D11) — fully resolved descriptor for an embedding column. The
 * resolver (src/core/search/embedding-column.ts) produces these at the
 * hybrid/op boundary; engines consume them. The engine NEVER reads config
 * or calls the resolver itself — it sees only this validated descriptor.
 *
 * `name` is identifier-quoted at SQL-build time by buildVectorCastFragment
 * (D12 defense in depth), but the resolver also enforces a strict regex
 * at load time so this string is already known-safe by the time the engine
 * sees it.
 */
export interface ResolvedColumn {
  /** Column name in content_chunks (already validated against the registry). */
  name: string;
  /** pgvector type — `$N::vector` or `$N::halfvec(N)`. */
  type: 'vector' | 'halfvec';
  /** Embedding dimensions — must match actual DB column dim. */
  dimensions: number;
  /** 'provider:model' identifier, e.g. 'voyage:voyage-3-large'. */
  embeddingModel: string;
}

export interface SearchOpts {
  limit?: number;
  offset?: number;
  /**
   * v0.42 — intent-aware adaptive return-sizing. `true` enables with config/
   * default caps; an object overrides caps per-call; omitted/`false` = off
   * (default, no behavior change). Trims the ranked set to an intent-driven
   * cap (entity → tight, else → recall-preserving). Only fires when offset===0.
   * See src/core/search/return-policy.ts.
   */
  adaptiveReturn?: import('./search/return-policy.ts').AdaptiveReturnInput;
  /**
   * v0.42.3.0 — autocut (score-discontinuity result-sizing). Default-ON in
   * reranked modes (the floor). Pass `false` to force the full top-K for breadth
   * / exploration (the ceiling override). Cuts the ranked set at the largest
   * cross-encoder rerank-score cliff; no-op without a reranker. Only fires when
   * offset===0. See src/core/search/autocut.ts.
   */
  autocut?: import('./search/autocut.ts').AutocutInput;
  type?: PageType;
  /**
   * v0.33: multi-type filter. When set, search results are filtered to
   * pages whose `type` is in this list, pushed to SQL via
   * `AND p.type = ANY($N::text[])` in both engines. Stacks with the
   * single-value `type` filter (both are AND-applied). Primary consumer
   * is `gbrain whoknows` (filters to ['person','company']); future
   * entity-only search reuses the parameter.
   */
  types?: PageType[];
  exclude_slugs?: string[];
  /**
   * Slug-prefix excludes — additive over DEFAULT_HARD_EXCLUDES (test/,
   * attachments/, .raw/) and the GBRAIN_SEARCH_EXCLUDE env var. Stacks with
   * `exclude_slugs` (exact match) — a row is filtered if it matches either set.
   * NOTE (issue #1777): `archive/` is NOT hard-excluded; it is demoted (0.5x)
   * via DEFAULT_SOURCE_BOOSTS so archived content stays findable by default.
   */
  exclude_slug_prefixes?: string[];
  /**
   * Opt-back-in list — subtracts entries from the resolved hard-exclude set.
   * E.g. `include_slug_prefixes: ['test/']` lets a query see test/ pages even
   * though they're hard-excluded by default.
   */
  include_slug_prefixes?: string[];
  detail?: 'low' | 'medium' | 'high';
  /**
   * v0.20.0 Cathedral II: filter by content_chunks.language (e.g., 'typescript',
   * 'python', 'ruby'). Used by `gbrain query --lang <lang>`. NULL/undefined
   * returns all languages.
   */
  language?: string;
  /**
   * v0.20.0 Cathedral II: filter by content_chunks.symbol_type (e.g., 'function',
   * 'class', 'method', 'type', 'interface'). Used by `gbrain query --symbol-kind`.
   */
  symbolKind?: string;
  /**
   * v0.20.0 Cathedral II: anchor the two-pass retrieval at a specific qualified
   * symbol name. Pairs with walkDepth. Used by `gbrain query --near-symbol`.
   */
  nearSymbol?: string;
  /**
   * v0.20.0 Cathedral II: structural walk depth for two-pass retrieval. 0 = off
   * (default), 1 or 2 = expand that many hops through code_edges_chunk. Capped
   * at 2 in A2. When walkDepth > 0, dedup's per-page cap lifts to
   * min(10, walkDepth * 5).
   */
  walkDepth?: number;
  /**
   * v0.20.0 Cathedral II: scope search to a specific source. When set,
   * results are filtered by pages.source_id. Use '__all__' or leave
   * undefined to search all sources.
   */
  sourceId?: string;
  /**
   * v0.34.1 (#876, D9): filter to ANY of these sources (federated read).
   * Engine applies `WHERE p.source_id = ANY($N::text[])` when the array
   * is set. Caller precedence: if BOTH `sourceId` and `sourceIds` are
   * provided, the array wins (the federated semantics subsume the
   * single-source case). When neither is set, no filter applies — the
   * pre-v0.34 unscoped behavior is preserved for local CLI callers.
   *
   * The op-handler layer resolves: `ctx.auth?.allowedSources` (federated
   * client) → `sourceIds`; otherwise `ctx.sourceId` (scalar) → `sourceId`.
   */
  sourceIds?: string[];
  /**
   * v0.27.1 / v0.36 (D11): target column for vector search. Two shapes:
   *
   * 1. String name (legacy + user-facing). Engine and hybridSearch convert
   *    to ResolvedColumn at the boundary via `resolveEmbeddingColumn()`.
   *    Built-in names: 'embedding' (default, text), 'embedding_image'
   *    (multimodal). v0.36 cross-modal wave adds 'embedding_multimodal'
   *    (unified column populated by `gbrain reindex --multimodal`). Custom
   *    user-declared names also accepted when registered in
   *    `embedding_columns` config.
   *
   * 2. ResolvedColumn descriptor (internal). The engine ONLY accepts
   *    this shape — hybridSearch resolves once at entry and passes the
   *    descriptor in so the engine stays config-independent (D11 — engine
   *    is a pure SQL composer).
   *
   * The two-shape union is the transition seam. External callers
   * (operations.ts image branch, tests, gbrain-evals) pass strings;
   * hybridSearch resolves; engine sees descriptor.
   *
   * searchKeyword is unaffected — modality filtering on the keyword path
   * is independent.
   */
  embeddingColumn?: 'embedding' | 'embedding_image' | 'embedding_multimodal' | string | ResolvedColumn;
  /**
   * @deprecated v0.29.1: use `since` instead. Removed in v0.30.
   * v0.27.0: filter results to pages updated/created after this date. ISO-8601 string.
   */
  afterDate?: string;
  /**
   * @deprecated v0.29.1: use `until` instead. Removed in v0.30.
   * v0.27.0: filter results to pages updated/created before this date. ISO-8601 string.
   */
  beforeDate?: string;
  /**
   * @deprecated v0.29.1: use `recency` ('off' | 'on' | 'strong') instead. Removed in v0.30.
   * v0.27.0: recency boost strength. 0 = off, 1 = moderate, 2 = aggressive.
   */
  recencyBoost?: 0 | 1 | 2;
  /**
   * v0.29.1: salience boost on emotional_weight + take_count. Independent of recency.
   * 'off' (default) disables; 'on' applies a moderate boost; 'strong' more aggressive.
   */
  salience?: 'off' | 'on' | 'strong';
  /**
   * v0.29.1: recency boost on per-prefix age decay. Independent of salience.
   * 'off' (default) disables; 'on' applies the per-prefix decay map; 'strong' multiplies by 1.5.
   */
  recency?: 'off' | 'on' | 'strong';
  /**
   * v0.29.1: ISO-8601 date OR relative duration ('7d', '2w', '1y'). Filter to
   * pages whose effective_date >= this time. Replaces afterDate (kept as alias).
   */
  since?: string;
  /**
   * v0.29.1: same shape as `since`. Filter to effective_date <= this time.
   * Boundary semantics: end-of-day for plain YYYY-MM-DD.
   */
  until?: string;
  /**
   * v0.32.x (search-lite): cap the cumulative token cost of returned results.
   * Applied AFTER all scoring, ranking, dedup, and boosts — the budget is the
   * LAST stage of the pipeline. Token counting uses a char/4 heuristic (no
   * tokenizer dep). When undefined or <= 0, this is a no-op (pre-v0.32
   * behavior).
   *
   * Use cases: keep an agent's search payload under its context window;
   * cap an MCP tool response to fit a router budget; emit a deterministic
   * upper bound on result size.
   */
  tokenBudget?: number;
  /**
   * v0.32.x (search-lite): enable/disable the semantic query cache for this
   * call. When undefined, the cache decision falls back to global config
   * (search.cache.enabled, default true). Set to `false` to force a fresh
   * search; set to `true` to opt in even when global config has it off.
   */
  useCache?: boolean;
  /**
   * v0.32.x (search-lite): force enable/disable the zero-LLM intent
   * classifier weight adjustments. Defaults to enabled. Set to `false` to
   * pin the legacy (pre-search-lite) weighting — useful when callers want
   * deterministic behavior independent of query phrasing.
   */
  intentWeighting?: boolean;
  /**
   * v0.35.0.0+: cross-encoder reranker config. Resolved from mode bundle by
   * default — tokenmax sets `enabled: true`, conservative + balanced set
   * `enabled: false`. Per-call SearchOpts.reranker overrides the mode
   * bundle. Slots in between dedupResults and enforceTokenBudget in
   * hybrid.ts. Defined here as a structural type to avoid a circular
   * import on src/core/search/rerank.ts; the runtime type lives there.
   */
  reranker?: {
    enabled: boolean;
    topNIn: number;
    topNOut: number | null;
    model?: string;
    timeoutMs?: number;
    // Test seam — never set in production code.
    rerankerFn?: (input: { query: string; documents: string[]; topN?: number; model?: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<{ index: number; relevanceScore: number }[]>;
  };
  /**
   * v0.35.6.0 — floor-ratio gate for metadata-axis boost stages.
   * Number in [0, 1] or undefined (default = no gate). When set, each gated
   * stage skips results whose pre-boost score is below `floorRatio * topScore`.
   * Same threshold gates all three metadata stages; exact-match boost runs
   * independently. Out-of-range values silently disable the gate.
   * Sensible operator overrides for dense-embedder corpora: 0.85-0.95.
   */
  floorRatio?: number;
  /**
   * v0.36 cross-modal wave: route this search through the multimodal
   * embedding space (Voyage multimodal-3 by default).
   *
   * - 'text' (default for queries that don't match image-intent regex):
   *   existing text-embedding path. No behavior change vs pre-v0.36.
   * - 'image': force routing through the multimodal model + embedding_image
   *   column. Skip LLM expansion (image embeddings handle synonyms in-space)
   *   and skip keyword search (no FTS index on image content).
   * - 'both': run text and image vector searches in parallel; merge via
   *   modality-weighted RRF.
   * - 'auto' (literal): same effect as undefined — let intent classifier
   *   decide. Accepted on the wire so MCP callers can be explicit.
   *
   * Cross-modal override matrix (D9): when effective modality is 'image',
   * cross-modal path overrides expansion (false) and reranker (false)
   * regardless of mode bundle. zerank-2 can't rerank image embeddings;
   * sending them produces garbage scores.
   */
  crossModal?: 'text' | 'image' | 'both' | 'auto';
  /**
   * v0.40.4 — per-call override for the graph-signals stage. Threads
   * through to PostFusionOpts.graphSignalsEnabled. When undefined,
   * falls through to the active mode bundle default (conservative=false,
   * balanced/tokenmax=true) via the resolveSearchMode chain.
   *
   * Primary consumer is eval gates: `graph-signals-eval.test.ts` runs
   * each fixture question twice (off vs on) and needs explicit per-call
   * control, not mode-bundle default. Without this field, both branches
   * would resolve to the same mode default and the gate would be a no-op.
   */
  graph_signals?: boolean;
  /**
   * v0.43 — relational recall arm per-call override. Per-call wins over the
   * `search.relational_retrieval` config key wins over the mode bundle. Eval
   * A/B gates need explicit per-call control or both branches resolve to the
   * same mode default. `relationalRetrievalDepth` caps traversal hops (1..3).
   */
  relationalRetrieval?: boolean;
  relationalRetrievalDepth?: number;
}

/**
 * v0.20.0 Cathedral II: input for addCodeEdges. One row per edge.
 * from_chunk_id is always known (we're extracting edges from a freshly
 * imported chunk). to_chunk_id may be null (target symbol not yet
 * resolved — row lands in code_edges_symbol instead of code_edges_chunk).
 */
export interface CodeEdgeInput {
  from_chunk_id: number;
  /** Resolved target chunk ID. Undefined/null → row lands in code_edges_symbol. */
  to_chunk_id?: number | null;
  from_symbol_qualified: string;
  to_symbol_qualified: string;
  /** 'calls' | 'imports' | 'extends' | 'implements' | 'mixes_in' | 'type_refs' | 'declares'. */
  edge_type: string;
  edge_metadata?: Record<string, unknown>;
  source_id?: string | null;
}

/**
 * v0.20.0 Cathedral II: result row from code edge queries (getCallersOf,
 * getCalleesOf, getEdgesByChunk). `resolved=true` means the row came from
 * code_edges_chunk (to_chunk_id is a known chunk); `resolved=false` means
 * code_edges_symbol (to_chunk_id is null).
 */
export interface CodeEdgeResult {
  id: number;
  from_chunk_id: number;
  to_chunk_id: number | null;
  from_symbol_qualified: string;
  to_symbol_qualified: string;
  edge_type: string;
  edge_metadata: Record<string, unknown>;
  source_id: string | null;
  resolved: boolean;
}

// Links
export interface Link {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
  /**
   * Provenance (v0.13+). NULL = legacy row (pre-v0.13, unknown source).
   * 'markdown' = extracted from `[Name](path)` refs. 'frontmatter' = extracted
   * from YAML frontmatter fields (company, investors, attendees, etc.).
   * 'manual' = user-created via addLink with explicit source.
   * Reconciliation in runAutoLink filters on link_source to avoid touching
   * markdown / manual edges when rewriting a page's frontmatter.
   */
  link_source?: string | null;
  /**
   * For link_source='frontmatter': the slug of the page whose frontmatter
   * created this edge. Lets reconciliation scope "my edges" precisely when
   * multiple pages reference the same (from, to, type) tuple.
   */
  origin_slug?: string | null;
  /**
   * The frontmatter field name that created this edge (e.g. 'key_people',
   * 'investors'). Used for debug output and the `unresolved` response list.
   */
  origin_field?: string | null;
}

export interface GraphNode {
  slug: string;
  title: string;
  type: PageType;
  depth: number;
  links: { to_slug: string; link_type: string }[];
}

/**
 * Edge in a graph traversal. Used by traversePaths() and graph-query.
 * Unlike GraphNode (which only carries outgoing links), GraphPath represents an
 * actual edge with direction, type, and depth from the root.
 */
export interface GraphPath {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
  /** Depth of `to_slug` from the root (1 for direct neighbors). */
  depth: number;
}

/**
 * One reached node from a typed-edge relational fan-out (v0.43). The recall
 * arm hydrates these into SearchResult rows and injects them as a fourth RRF
 * arm. Aggregated to the page level: `hop` is the shortest distance from any
 * seed, `edge_count` is a connection-richness proxy (distinct edge types via
 * which the node is reached), `via_link_types` names them, `path` is the
 * shortest connecting slug chain (for --explain), and `canonical_chunk_id` is
 * the page's lowest-ordinal chunk (null for frontmatter-only entity pages).
 */
export interface RelationalFanoutRow {
  source_id: string;
  slug: string;
  hop: number;
  edge_count: number;
  via_link_types: string[];
  path: string[];
  canonical_chunk_id: number | null;
}

/** Options for BrainEngine.relationalFanout. */
export interface RelationalFanoutOpts {
  /** Edge types to traverse; null/empty = type-agnostic. */
  linkTypes?: string[] | null;
  /** Direction from each seed. Default 'both'. */
  direction?: 'in' | 'out' | 'both';
  /** Max hops. Default 2, hard-capped at 3. */
  depth?: number;
  /** Include `link_source='mentions'` edges. Default false (typed edges only). */
  includeMentions?: boolean;
  /** Single-source scope. */
  sourceId?: string;
  /** Federated scope; traversal stays WITHIN each seed's own source. */
  sourceIds?: string[];
  /** Hard cap on returned candidate nodes. Default 50. */
  limit?: number;
}

// Timeline
export interface TimelineEntry {
  id: number;
  page_id: number;
  date: string;
  source: string;
  summary: string;
  detail: string;
  created_at: Date;
}

export interface TimelineInput {
  date: string;
  source?: string;
  summary: string;
  detail?: string;
}

export interface TimelineOpts {
  limit?: number;
  after?: string;
  before?: string;
  /**
   * v0.31.8: when set, scope the page-id lookup to this source. When omitted,
   * the read returns timeline entries for every same-slug page across sources
   * (pre-v0.31.8 behavior; preserved by the two-branch query in both engines).
   */
  sourceId?: string;
  /**
   * #2200: federated read grant (caller's allowedSources). Takes precedence over
   * scalar `sourceId` when non-empty; scopes the page-id lookup to
   * `source_id = ANY($::text[])` so a federated read honors the whole grant
   * (union of allowed sources), not just one source. Mirrors `GetPageOpts.sourceIds`.
   */
  sourceIds?: string[];
}

// v0.42.x — Life Chronicle (#2390): timeline read surfaces.
// A ChronicleTimelineRow is a timeline_entries projection JOINed to its depth
// page (always) and, when it is an event projection, to the event page (for
// intra-day order via effective_date, the backlink slug, and the event kind).
export interface ChronicleTimelineRow {
  date: string;               // YYYY-MM-DD (the projection date, pinned tz)
  summary: string;
  detail: string;
  source: string;
  page_id: number;            // depth page id (the rich page the row belongs to)
  page_slug: string;          // depth page slug (backlink target)
  event_page_id: number | null;
  event_slug: string | null;  // the type:event page, when this is an event projection
  effective_date: string | null; // event page effective_date — drives intra-day order
  kind: string | null;        // event.kind from the event page frontmatter
}

export interface ChronicleTimelineOpts {
  /** getTimelineForDate: expand to the ISO week (Mon–Sun) containing `date`. */
  week?: boolean;
  /** getSince: filter event projections by `event.kind`. */
  kind?: string;
  limit?: number;
  /** Source scope (scalar). Federated `sourceIds` takes precedence when set. */
  sourceId?: string;
  sourceIds?: string[];
}

export interface LastSeenResult {
  entity_slug: string;
  /** Most recent timeline date the entity appears in (own page or an event's who). NULL if never. */
  last_date: string | null;
  /** The most recent event page slug involving the entity, if the last hit was an event. */
  last_event_slug: string | null;
  /** Whole days between last_date and `asof` (default today). NULL when last_date is NULL. */
  days_ago: number | null;
}

// v0.42.x — Life Chronicle (#2390) per-entity ontology (rides the `facts` table).
// An observation is a sourced, confidence-weighted, bi-temporal claim that an
// entity has dimension=value (e.g. role=advisor). Supersession/validity/visibility
// are inherited from facts columns.
export interface OntologyObservationInput {
  entitySlug: string;
  dimension: string;
  value: string;
  /** 0..1; default 0.7. */
  confidence?: number;
  /** Provenance — written to facts.source_markdown_slug (the dedup key + retraction key). */
  source: string;
  validFrom?: string | null; // ISO; null = -infinity
  validTo?: string | null;   // ISO; null = open/current
  visibility?: 'private' | 'world';
  /** Novel/LLM-proposed dimensions land 'quarantined' (excluded from current resolution). */
  status?: 'active' | 'quarantined';
  sourceId?: string;
}
export interface OntologyMergeResult {
  action: 'inserted' | 'corroborated' | 'superseded_prior' | 'noop';
  factId: number | null;
  supersededId: number | null;
}
export interface OntologyValue {
  dimension: string;
  value: string;
  confidence: number;
  source: string | null;
  valid_from: string | null;
  valid_to: string | null;
  status: string;          // 'active' | 'quarantined'
  fact_id: number;
}
export interface OntologyDimensionStat { dimension: string; entities: number; observations: number }
export interface OntologyConflict {
  entity_slug: string;
  dimension: string;
  values: { value: string; source: string | null; confidence: number; fact_id: number }[];
}
export interface OntologyReadOpts {
  asof?: string;
  minConfidence?: number;
  includeQuarantined?: boolean;
  sourceId?: string;
  sourceIds?: string[];
}

// Raw data
export interface RawData {
  source: string;
  data: Record<string, unknown>;
  fetched_at: Date;
}

// Versions
export interface PageVersion {
  id: number;
  page_id: number;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  snapshot_at: Date;
}

// Stats + Health
export interface BrainStats {
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  link_count: number;
  tag_count: number;
  timeline_entry_count: number;
  pages_by_type: Record<string, number>;
}

export interface BrainHealth {
  page_count: number;
  embed_coverage: number;
  stale_pages: number;
  /**
   * Islanded pages — zero inbound AND zero outbound links. A hub page
   * that has references out but no back-references is NOT an orphan under
   * this definition (it's working as intended as an index). The metric
   * aims at "pages I forgot to connect to anything", not the stricter
   * graph-theory "no inbound" definition. Both engines share this
   * semantics after Bug 11 doc-drift fix.
   */
  orphan_pages: number;
  missing_embeddings: number;
  /**
   * Composite quality score, 0-100. Weighted sum of five components: embed
   * coverage, link density, timeline coverage, orphan avoidance, dead-link
   * avoidance. See the per-component *_score fields below for breakdown.
   */
  brain_score: number;
  /**
   * Number of links whose to_page_id no longer resolves to a page. Under
   * `ON DELETE CASCADE` this is always 0, but malformed data or direct SQL
   * DELETEs can produce dangling references.
   */
  dead_links: number;
  /** Fraction of entity pages (person/company) with >= 1 inbound link. */
  link_coverage: number;
  /** Fraction of entity pages (person/company) with >= 1 structured timeline entry. */
  timeline_coverage: number;
  /** Top 5 entities by total link count (in + out). */
  most_connected: Array<{ slug: string; link_count: number }>;
  /**
   * Per-component contribution to brain_score. Sum equals brain_score by
   * construction. Displayed by `gbrain doctor` when brain_score < 100.
   * Field names are distinct from the entity-scoped link_coverage /
   * timeline_coverage above to avoid semantic collision (these reflect
   * whole-brain measures used in the score formula).
   */
  embed_coverage_score: number;     // 0-35
  link_density_score: number;        // 0-25
  timeline_coverage_score: number;   // 0-15
  no_orphans_score: number;          // 0-15
  no_dead_links_score: number;       // 0-10
  /**
   * v0.30.1 (Cherry D7 + Codex C3): explicit migrations diagnostic surface
   * exposed to MCP get_health callers so remote agents can detect a wedged
   * brain WITHOUT shelling SSH + gbrain doctor. Two ledgers (schema +
   * orchestrator) per Codex T5 namespacing.
   *
   * `schema_version` ("1") on the parent BrainHealth pins the additive
   * contract — clients should default-handle missing fields and never
   * assume removed ones.
   */
  schema_version?: '1';
  migrations?: {
    schema: {
      /** Current numeric config.version. */
      version: number;
      /** Latest available migration. */
      latest_version: number;
      /**
       * Optional drift evidence — names of columns/tables a verify hook
       * surfaced as missing on opt-in migrations. Empty array means no
       * drift detected (or no verify hook ran).
       */
      verify_drift?: string[];
    };
    orchestrator: {
      pending: Array<{ version: string; name: string; status: 'pending' | 'partial' }>;
      wedged: Array<{ version: string; name: string; consecutive_partials: number }>;
    };
  };
}

// Ingest log
export interface IngestLogEntry {
  id: number;
  /** v0.31.2: brain source identifier; default 'default'. Added by migration v47. */
  source_id: string;
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
  created_at: Date;
}

export interface IngestLogInput {
  /** v0.31.2: brain source identifier; defaults to 'default' on the engine. */
  source_id?: string;
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
}

// Eval capture (v0.25.0)
// Real MCP/CLI/subagent query+search calls are captured into eval_candidates
// so gbrain-evals can replay them as BrainBench-Real. The companion
// eval_capture_failures table records insert failures so gbrain doctor can
// surface silent capture drops cross-process.
export interface EvalCandidateInput {
  tool_name: 'query' | 'search';
  /** Already PII-scrubbed by captureEvalCandidate before this point. */
  query: string;
  retrieved_slugs: string[];
  retrieved_chunk_ids: number[];
  source_ids: string[];
  /** Whether multi-query Haiku expansion was enabled on the call. Null for 'search'. */
  expand_enabled: boolean | null;
  /** The detail level the call requested (pre-auto-detect). */
  detail: 'low' | 'medium' | 'high' | null;
  /** What hybridSearch actually ran (post-auto-detect). Null for 'search'. */
  detail_resolved: 'low' | 'medium' | 'high' | null;
  /** True when vector search actually ran (false when OPENAI_API_KEY missing or embed failed). */
  vector_enabled: boolean;
  /** True when Haiku expansion actually fired. */
  expansion_applied: boolean;
  latency_ms: number;
  /** ctx.remote: true for MCP callers (untrusted), false for local CLI. */
  remote: boolean;
  job_id: number | null;
  subagent_id: number | null;
  /**
   * v0.36 (D16 / CDX-10): the embedding column resolved at capture time.
   * Optional for back-compat with pre-v0.36 callers + test fixtures.
   * Engines coalesce undefined to NULL at insert time so the column is
   * always either a known column name or DB NULL — never JS undefined.
   *
   * Replay (`gbrain eval replay`) re-runs the captured query against the
   * brain. Without this field, a replay after the user flipped
   * `search_embedding_column` produces "regressions" that are just
   * column changes. Replay reads this and uses it as a per-row override
   * so capture and replay run in the same embedding space.
   */
  embedding_column?: string | null;
}

export interface EvalCandidate extends EvalCandidateInput {
  id: number;
  created_at: Date;
}

export type EvalCaptureFailureReason =
  | 'db_down'
  | 'rls_reject'
  | 'check_violation'
  | 'scrubber_exception'
  | 'other';

export interface EvalCaptureFailure {
  id: number;
  ts: Date;
  reason: EvalCaptureFailureReason;
}

/**
 * Side-channel metadata that hybridSearch reports about what actually ran.
 * Surfaced via the optional `onMeta` callback in HybridSearchOpts so
 * existing SearchResult[] consumers (Cathedral II, gbrain-evals, etc.)
 * stay unchanged. Used by op-layer eval capture to distinguish
 * "keyword-only fallback" from "full hybrid with expansion."
 */
export interface HybridSearchMeta {
  /** True iff vector search actually ran. False when OPENAI_API_KEY missing or embed failed. */
  vector_enabled: boolean;
  /** Post-auto-detect detail level. */
  detail_resolved: 'low' | 'medium' | 'high' | null;
  /** True iff multi-query expansion (Haiku) actually fired and produced variants. */
  expansion_applied: boolean;
  /**
   * v0.32.x (search-lite): the intent the zero-LLM classifier inferred for
   * this query. Surfaced for debugging — agents and the `gbrain query`
   * command can show "intent: temporal" alongside results to make the
   * weighting decision auditable.
   */
  intent?: 'entity' | 'temporal' | 'event' | 'general';
  /**
   * v0.42 — adaptive return-sizing decision (intent, cap, kept, total).
   * Omitted when the gate is off. Surfaced for `gbrain search --explain`.
   */
  adaptive_return?: import('./search/return-policy.ts').AdaptiveReturnDecision;
  /**
   * v0.42.3.0 — autocut decision (signal, cut point, kept/total, gapRatio).
   * Omitted when autocut didn't run (no reranker). Surfaced for
   * `gbrain search --explain`.
   */
  autocut?: import('./search/autocut.ts').AutocutDecision;
  /**
   * v0.32.x (search-lite): token budget enforcement metadata. Omitted when
   * no budget was applied (backward-compatible with pre-search-lite
   * consumers).
   */
  token_budget?: {
    budget: number;
    used: number;
    kept: number;
    dropped: number;
  };
  /**
   * v0.32.x (search-lite): cache hit/miss tracking. Omitted when the
   * semantic query cache wasn't consulted (cache disabled, vector search
   * unavailable, etc.).
   */
  cache?: {
    /** 'hit' when results came from the cache; 'miss' when search ran fresh. */
    status: 'hit' | 'miss' | 'disabled';
    /** Similarity of the cached query's embedding (0..1). Only set on hit. */
    similarity?: number;
    /** Age of the cached entry in seconds. Only set on hit. */
    age_seconds?: number;
  };
  /**
   * v0.32.3 (search-lite mode): the active search mode for this call.
   * 'conservative' | 'balanced' | 'tokenmax'. Resolved from
   * config.search.mode with per-call + per-key overrides applied. Surfaced
   * so observability sees what mode actually ran (which can differ from
   * the operator's `config.search.mode` setting if per-call overrides win).
   */
  mode?: 'conservative' | 'balanced' | 'tokenmax';
  /**
   * v0.36 (D16 / CDX-10): the embedding column that actually ran this
   * search. Threaded through to eval_candidates capture so replay can
   * use the same column even after `search_embedding_column` is
   * flipped. Always set on hybridSearch paths; omitted on
   * non-hybridSearch capture paths (keyword-only `search` op).
   */
  embedding_column?: string;
}

// Config
export interface EngineConfig {
  database_url?: string;
  database_path?: string;
  engine?: 'postgres' | 'pglite';
}

// Errors
export class GBrainError extends Error {
  constructor(
    public problem: string,
    public cause_description: string,
    public fix: string,
    public docs_url?: string,
  ) {
    super(`${problem}: ${cause_description}. Fix: ${fix}`);
    this.name = 'GBrainError';
  }
}
