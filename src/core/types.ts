// Page types
// email | slack | calendar-event: native Page types for inbox/chat/calendar
// ingest (and the amara-life-v1 eval corpus in the sibling gbrain-evals repo).
// Previously these collapsed into `source`, which lost workflow semantics
// (e.g. "attended meetings" vs "received emails").
// `code` (v0.19.0): tree-sitter-chunked source files; consumed by code-def /
// code-refs / code-callers / code-callees + Cathedral II two-pass retrieval.
// `image` (v0.27.1): multimodal-embedded images (PNG/JPG/HEIC/AVIF). One page
// per image; chunk lives in content_chunks with modality='image' +
// embedding_image vector(1024). Bytes never enter the DB; the brain repo
// holds the file and `files.storage_path` references it.
// `synthesis` (v0.28): think-generated provenance pages.
export type PageType = 'person' | 'company' | 'deal' | 'yc' | 'civic' | 'project' | 'concept' | 'source' | 'media' | 'writing' | 'analysis' | 'guide' | 'hardware' | 'architecture' | 'meeting' | 'note' | 'email' | 'slack' | 'calendar-event' | 'code' | 'image' | 'synthesis';

/**
 * Canonical list of every PageType value. Kept in sync with the union above.
 * Used by the v0.27.1 page-type-exhaustive contract test to walk every value
 * through public surfaces (serialize, slug registry, frontmatter validate)
 * and assert no surprise. Adding a value to PageType MUST also add it here —
 * the contract test enforces parity.
 */
export const ALL_PAGE_TYPES: readonly PageType[] = [
  'person', 'company', 'deal', 'yc', 'civic', 'project', 'concept',
  'source', 'media', 'writing', 'analysis', 'guide', 'hardware',
  'architecture', 'meeting', 'note', 'email', 'slack', 'calendar-event',
  'code', 'image', 'synthesis',
] as const;

/**
 * Exhaustiveness helper. Use in the default branch of any `switch (x.type)`
 * to force the TypeScript compiler to error if the union grows. The CI guard
 * scripts/check-pagetype-exhaustive.sh enforces that any new switch on a
 * PageType-shaped discriminator imports and uses this helper in default.
 *
 *   switch (page.type) {
 *     case 'person': return ...;
 *     case 'company': return ...;
 *     // ... every other PageType ...
 *     default: return assertNever(page.type);
 *   }
 *
 * If a new PageType is added without a corresponding case, `assertNever`
 * fails to type-check (the parameter is no longer `never`), preventing the
 * silent default-branch fall-through that bit gbrain v0.20 / v0.22.
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
}

export type EffectiveDateSource =
  | 'event_date'
  | 'date'
  | 'published'
  | 'filename'
  | 'fallback';

// `image` (v0.27.1): multimodal ingestion path, parallel to markdown + code.
export type PageKind = 'markdown' | 'code' | 'image';

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
}

export interface SearchOpts {
  limit?: number;
  offset?: number;
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
   * Slug-prefix excludes — additive over DEFAULT_HARD_EXCLUDES (test/, archive/,
   * attachments/, .raw/) and the GBRAIN_SEARCH_EXCLUDE env var. Stacks with
   * `exclude_slugs` (exact match) — a row is filtered if it matches either set.
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
   * v0.27.1: target column for vector search. 'embedding' (default) hits
   * the brain's primary text-embedding column. 'embedding_image' targets
   * the multimodal column populated by importImageFile. The two columns
   * may live in different dim spaces (e.g. OpenAI 1536 + Voyage 1024)
   * which is why the dual-column schema landed in v0.27.1. searchKeyword
   * is unaffected — modality filtering on the keyword path is independent.
   */
  embeddingColumn?: 'embedding' | 'embedding_image';
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
