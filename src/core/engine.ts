import type {
  Page, PageInput, PageFilters, GetPageOpts,
  Chunk, ChunkInput, StaleChunkRow,
  SearchResult, SearchOpts,
  Link, GraphNode, GraphPath,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
  CodeEdgeInput, CodeEdgeResult,
  EvalCandidate, EvalCandidateInput,
  EvalCaptureFailure, EvalCaptureFailureReason,
  SalienceOpts, SalienceResult, AnomaliesOpts, AnomalyResult,
  EmotionalWeightInputRow, EmotionalWeightWriteRow,
} from './types.ts';

/**
 * v0.27.1: file row for binary-asset metadata. Mirrors the `files` table
 * shape on both engines (Postgres has had it since v0.18; PGLite gets it
 * via migration v36).
 */
export interface FileRow {
  id: number;
  source_id: string;
  page_slug: string | null;
  page_id: number | null;
  filename: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  content_hash: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/**
 * v0.27.1: spec for upsertFile. Identity is (source_id, storage_path).
 * Re-upserting the same identity with a different content_hash updates the
 * row in place (image was replaced); same content_hash is a no-op.
 */
export interface FileSpec {
  source_id?: string;
  page_slug?: string | null;
  page_id?: number | null;
  filename: string;
  storage_path: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  content_hash: string;
  metadata?: Record<string, unknown>;
}

/** Input row for addLinksBatch. Optional fields default to '' (matches NOT NULL DDL). */
export interface LinkBatchInput {
  from_slug: string;
  to_slug: string;
  link_type?: string;
  context?: string;
  /**
   * Provenance (v0.13+). Pass 'frontmatter' for edges derived from YAML
   * frontmatter, 'markdown' for [Name](path) refs, 'manual' for user-created.
   * NULL means "legacy / unknown" and is only used by pre-v0.13 rows; new
   * writes should always set this. Missing on input defaults to 'markdown'.
   */
  link_source?: string;
  /** For link_source='frontmatter': slug of the page whose frontmatter created this edge. */
  origin_slug?: string;
  /** Frontmatter field name (e.g. 'key_people', 'investors'). */
  origin_field?: string;
  /**
   * v0.18.0: source id for each endpoint. When omitted, the engine JOINs
   * against `source_id='default'`. Pass explicit values when the edge
   * lives in a non-default source OR crosses sources.
   *
   * Without these fields, the batch JOIN `pages.slug = v.from_slug` fans
   * out across every source containing that slug, silently creating wrong
   * edges in a multi-source brain. The source_id filter eliminates the
   * fan-out. Origin pages (frontmatter provenance) get their own
   * source_id so reconciliation can't delete edges from another source's
   * frontmatter.
   */
  from_source_id?: string;
  to_source_id?: string;
  origin_source_id?: string;
}

/** Input row for addTimelineEntriesBatch. Optional fields default to '' (matches NOT NULL DDL). */
export interface TimelineBatchInput {
  slug: string;
  date: string;
  source?: string;
  summary: string;
  detail?: string;
  /**
   * v0.18.0: source id for the owning page. When omitted, the engine JOINs
   * against `source_id='default'`. Without this, two pages sharing the
   * same slug across sources would fan out timeline rows to both.
   */
  source_id?: string;
}

/**
 * A single dedicated database connection, isolated from the engine's pool.
 *
 * Used by migration paths that need session-level GUCs (e.g.
 * `SET statement_timeout = '600000'` before a `CREATE INDEX CONCURRENTLY`)
 * without leaking into the shared pool, and by write-quiesce designs
 * that need a session-lifetime Postgres advisory lock that survives
 * across transaction boundaries.
 *
 * On Postgres: backed by postgres-js `sql.reserve()`; the same backend
 * process serves every `executeRaw` call within the callback. Released
 * automatically when the callback returns or throws.
 *
 * On PGLite: a thin pass-through. PGLite has no pool, so every call is
 * already on the single backing connection. The interface is still
 * exposed so cross-engine callers don't need to branch.
 *
 * Not safe to call from inside `transaction()`. The transaction holds a
 * different backend; reserving a second one can deadlock on a row the
 * transaction itself is waiting to write.
 */
export interface ReservedConnection {
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * v0.28: Takes — typed/weighted/attributed claims, indexed in Postgres.
 * Markdown is source of truth (fenced table on the page); this row is the
 * derived index. Page-scoped via page_id (NOT slug — slug is unique only
 * within a source). `(page_id, row_num)` is the natural unique key.
 */
export interface TakeKindLiteral { kind: 'fact' | 'take' | 'bet' | 'hunch' }
export type TakeKind = TakeKindLiteral['kind'];

/** Input row for addTakesBatch. */
export interface TakeBatchInput {
  page_id: number;
  row_num: number;
  claim: string;
  kind: TakeKind;
  holder: string;
  weight?: number;          // 0..1, default 0.5; clamped server-side
  since_date?: string;      // ISO date 'YYYY-MM-DD'
  until_date?: string;
  source?: string;
  superseded_by?: number | null;
  active?: boolean;         // default true
}

/** Take row as returned by listTakes / searchTakes. */
export interface Take {
  id: number;
  page_id: number;
  page_slug: string;        // joined from pages
  row_num: number;
  claim: string;
  kind: TakeKind;
  holder: string;
  weight: number;
  since_date: string | null;
  until_date: string | null;
  source: string | null;
  superseded_by: number | null;
  active: boolean;
  resolved_at: string | null;
  resolved_outcome: boolean | null;
  /**
   * v0.30.0: 3-state outcome label. Sits alongside `resolved_outcome` for
   * back-compat. New writes populate both; legacy v0.28-resolved rows have
   * `resolved_quality` backfilled by migration v40 from the boolean.
   * Null on unresolved rows. Schema CHECK enforces (quality, outcome) consistency:
   * `correct` ↔ `outcome=true`, `incorrect` ↔ `outcome=false`, `partial` ↔ `outcome=NULL`.
   */
  resolved_quality: 'correct' | 'incorrect' | 'partial' | null;
  resolved_value: number | null;
  resolved_unit: string | null;
  resolved_source: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TakesListOpts {
  page_id?: number;
  page_slug?: string;       // resolved via JOIN
  holder?: string;
  kind?: TakeKind;
  active?: boolean;         // default true (only active rows)
  resolved?: boolean;       // true = only resolved; false = only unresolved; undefined = both
  /** Per-token MCP allow-list. Server applies AND holder = ANY($takesHoldersAllowList) when set. */
  takesHoldersAllowList?: string[];
  sortBy?: 'weight' | 'since_date' | 'created_at';
  limit?: number;
  offset?: number;
}

/** Search result row from searchTakes / searchTakesVector. */
export interface TakeHit {
  take_id: number;
  page_id: number;
  page_slug: string;
  row_num: number;
  claim: string;
  kind: TakeKind;
  holder: string;
  weight: number;
  score: number;            // search rank score (ts_rank for keyword, 1-cos_dist for vector)
}

/** v0.28 stale-takes row (mirrors StaleChunkRow shape). Embedding column intentionally omitted. */
export interface StaleTakeRow {
  take_id: number;
  page_slug: string;
  row_num: number;
  claim: string;
}

/** Resolution metadata for resolveTake. */
export interface TakeResolution {
  /**
   * v0.30.0: primary 3-state input. When set, takes precedence over `outcome`
   * and the engine writes both columns (quality directly; outcome derived:
   * `correct→true`, `incorrect→false`, `partial→null`).
   */
  quality?: 'correct' | 'incorrect' | 'partial';
  /**
   * v0.28 back-compat input. Keep submitting for v0.28 callers; the engine
   * derives quality (`true→correct`, `false→incorrect`). When `quality` is
   * also set, `quality` wins. When neither is set, the engine throws.
   * Mutually-exclusive with `quality === 'partial'` because partial isn't
   * binary.
   */
  outcome?: boolean;
  value?: number;
  unit?: string;       // 'usd' | 'pct' | 'count' | other
  source?: string;
  resolvedBy: string;  // slug or 'garry'
}

/** v0.30.0: scorecard aggregate. */
export interface TakesScorecard {
  total_bets: number;
  resolved: number;
  correct: number;
  incorrect: number;
  partial: number;
  /** Accuracy = correct / (correct + incorrect). NULL when n=0. */
  accuracy: number | null;
  /**
   * Brier score over rows where `resolved_quality IN ('correct','incorrect')`.
   * Maps `correct→1`, `incorrect→0`, computes `mean((weight − outcome)²)`.
   * Lower is better; 0 = perfect; 0.25 = always-50% baseline.
   * Excludes partial — that label hides hedging behavior; `partial_rate`
   * surfaces it as a separate signal. NULL when no correct+incorrect rows.
   */
  brier: number | null;
  /** partial / resolved. NULL when n=0. */
  partial_rate: number | null;
}

export interface TakesScorecardOpts {
  holder?: string;
  domainPrefix?: string; // e.g. 'companies/' to scope the scorecard
  since?: string;        // ISO date 'YYYY-MM-DD'
  until?: string;        // ISO date 'YYYY-MM-DD'
}

/** v0.30.0: calibration curve bucket. */
export interface CalibrationBucket {
  /** Lower bound of the weight bucket, inclusive. */
  bucket_lo: number;
  /** Upper bound, exclusive (except for the final bucket which is inclusive of 1.0). */
  bucket_hi: number;
  /** Count of resolved correct+incorrect bets falling in this weight range. */
  n: number;
  /** correct / n. NULL when n=0. */
  observed: number | null;
  /** mean(weight) within the bucket — what was predicted on average. NULL when n=0. */
  predicted: number | null;
}

export interface CalibrationCurveOpts {
  holder?: string;
  bucketSize?: number; // default 0.1
}

/** Synthesis evidence row input (provenance from think synthesis pages). */
export interface SynthesisEvidenceInput {
  synthesis_page_id: number;
  take_page_id: number;
  take_row_num: number;
  citation_index: number;
}

/** Dream-cycle Haiku verdict on whether a transcript is worth processing. */
export interface DreamVerdict {
  worth_processing: boolean;
  reasons: string[];
  judged_at: string;
}

/** Input shape for putDreamVerdict — judged_at defaults to now() server-side. */
export interface DreamVerdictInput {
  worth_processing: boolean;
  reasons: string[];
}

// ============================================================
// v0.31 Hot Memory: facts table + recall surface
// ============================================================

/** Allowed `facts.kind` values. Different decay halflives apply per kind. */
export type FactKind = 'event' | 'preference' | 'commitment' | 'belief' | 'fact';

export const ALL_FACT_KINDS: readonly FactKind[] = [
  'event', 'preference', 'commitment', 'belief', 'fact',
] as const;

/** Visibility tier on a fact row. Mirrors takes' world-default ACL contract (D21). */
export type FactVisibility = 'private' | 'world';

/** Status returned by insertFact. */
export type FactInsertStatus = 'inserted' | 'duplicate' | 'superseded';

/** A fact row read from the facts table. */
export interface FactRow {
  id: number;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: FactKind;
  visibility: FactVisibility;
  /**
   * v0.31.2: salience tier the LLM assigned at extraction time. Surfaces
   * to consumers (recall response, daily-page writer, admin dashboard,
   * agents reading via MCP `_meta.brain_hot_memory`). Pre-v45 brains had
   * no notability column; migration v46 backfills with default 'medium'.
   */
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date;
  valid_until: Date | null;
  expired_at: Date | null;
  superseded_by: number | null;
  consolidated_at: Date | null;
  consolidated_into: number | null;
  source: string;
  source_session: string | null;
  confidence: number;
  embedding: Float32Array | null;
  embedded_at: Date | null;
  created_at: Date;
}

/** Input for insertFact. source_id supplied via the ctx arg. */
export interface NewFact {
  fact: string;
  kind?: FactKind;                     // default 'fact'
  entity_slug?: string | null;
  visibility?: FactVisibility;          // default 'private'
  context?: string | null;
  valid_from?: Date;                   // default now()
  valid_until?: Date | null;
  source: string;                       // 'mcp:put_page' | 'mcp:extract_facts' | 'cli:think' | etc
  source_session?: string | null;
  confidence?: number;                  // [0,1], default 1.0
  notability?: 'high' | 'medium' | 'low'; // salience filter for extraction gate
  embedding?: Float32Array | null;     // pre-computed; if null, insertFact computes via gateway
}

/** Options shared by list-facts methods. */
export interface FactListOpts {
  /** Hide expired_at IS NOT NULL rows. Default true. */
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
  /** Restrict to specific kinds. Default: all kinds. */
  kinds?: FactKind[];
  /**
   * Visibility filter. When undefined, returns all. When set, only matches
   * are returned. Remote (untrusted) callers must supply ['world'].
   */
  visibility?: FactVisibility[];
}

/** Per-source operational health snapshot consumed by `gbrain doctor`. */
export interface FactsHealth {
  source_id: string;
  total_active: number;          // facts where expired_at IS NULL
  total_today: number;           // created in last 24h
  total_week: number;            // created in last 7d
  total_expired: number;         // expired_at IS NOT NULL
  total_consolidated: number;    // consolidated_at IS NOT NULL
  top_entities: Array<{ entity_slug: string; count: number }>;
  /** Optional counters fed by the queue / classifier — populated when those modules report. */
  drop_counter?: number;
  classifier_fail_counter?: number;
  p50_latency_ms?: number;
  p99_latency_ms?: number;
}

/** Maximum results returned by search operations. Internal bulk operations (listPages) are not clamped. */
export const MAX_SEARCH_LIMIT = 100;

/** Clamp a user-provided search limit to a safe range. */
export function clampSearchLimit(limit: number | undefined, defaultLimit = 20, cap = MAX_SEARCH_LIMIT): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || Number.isNaN(limit)) return defaultLimit;
  if (limit <= 0) return defaultLimit;
  return Math.min(Math.floor(limit), cap);
}

export interface BrainEngine {
  /** Discriminator: lets migrations and other consumers branch on engine kind without instanceof + dynamic imports. */
  readonly kind: 'postgres' | 'pglite';

  // Lifecycle
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;
  /**
   * Run `fn` with a dedicated connection (Postgres: reserved backend;
   * PGLite: pass-through). See `ReservedConnection` for semantics and
   * usage constraints. Release is automatic.
   */
  withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T>;

  // Pages CRUD
  /**
   * Fetch a page by slug.
   * v0.26.5: by default soft-deleted rows return null (matches the search
   * filter contract). Pass `opts.includeDeleted: true` to surface them with
   * `deleted_at` populated — used by `gbrain pages purge-deleted` listing,
   * by `restore_page` flow, and by operator diagnostics.
   */
  getPage(slug: string, opts?: GetPageOpts): Promise<Page | null>;
  /**
   * Insert or update a page. When `opts.sourceId` is omitted, the row is
   * written under the schema DEFAULT ('default'). When provided, `source_id`
   * is included in the INSERT column list so ON CONFLICT (source_id, slug)
   * DO UPDATE actually targets the intended row instead of fabricating a
   * duplicate at (default, slug). Multi-source brains MUST pass sourceId.
   */
  putPage(slug: string, page: PageInput, opts?: { sourceId?: string }): Promise<Page>;
  /**
   * Hard-delete a page row. Cascades to content_chunks, page_links,
   * chunk_relations via existing FK ON DELETE CASCADE.
   *
   * v0.26.5: this is no longer the public-facing `delete_page` op handler —
   * the op now soft-deletes via `softDeletePage` instead. `deletePage` stays
   * as the underlying primitive used by `purgeDeletedPages` and by callers
   * that explicitly want hard-delete semantics (e.g. test setup teardown).
   */
  /**
   * v0.18.0+ multi-source: `opts.sourceId` scopes the DELETE so a source-A
   * delete doesn't hard-delete the same-slug pages in sources B/C/D. Without
   * it, the bare DELETE matches every row with that slug across all sources.
   * Cascades through content_chunks / page_links / chunk_relations via FKs.
   */
  deletePage(slug: string, opts?: { sourceId?: string }): Promise<void>;
  /**
   * v0.26.5 — set `deleted_at = now()` on a page. Returns the slug if a row
   * was soft-deleted, null if no row matched (already soft-deleted OR not found).
   * Idempotent-as-null. The page stays in the DB and cascade rows (chunks,
   * links) stay intact; the autopilot purge phase hard-deletes after 72h.
   */
  softDeletePage(slug: string, opts?: { sourceId?: string }): Promise<{ slug: string } | null>;
  /**
   * v0.26.5 — clear `deleted_at` on a soft-deleted page. Returns true iff a
   * row was restored. False if the slug is unknown OR the page is not
   * currently soft-deleted (idempotent-as-false).
   */
  restorePage(slug: string, opts?: { sourceId?: string }): Promise<boolean>;
  /**
   * v0.26.5 — hard-delete pages whose `deleted_at` is older than the cutoff.
   * Called by the autopilot purge phase and by the `gbrain pages purge-deleted`
   * CLI escape hatch. Cascades through existing FKs.
   */
  purgeDeletedPages(olderThanHours: number): Promise<{ slugs: string[]; count: number }>;
  /**
   * v0.26.5: by default `listPages` excludes soft-deleted rows. Set
   * `filters.includeDeleted: true` to surface them.
   */
  listPages(filters?: PageFilters): Promise<Page[]>;
  /**
   * v0.31.4: optional `sourceId` scopes both exact and fuzzy matching to a
   * single source. Unset = federated (matches local CLI + Robin super-reader).
   */
  resolveSlugs(partial: string, opts?: { sourceId?: string }): Promise<string[]>;
  /**
   * Returns the slug of every page in the brain. Used by batch commands as a
   * mutation-immune iteration source (alternative to listPages OFFSET pagination,
   * which is unstable when ordering by updated_at and writes are happening).
   *
   * v0.31.8 (D12): `opts.sourceId` scopes the result to a single source
   * (used by the source-aware reconcileLinks path so wikilink resolution
   * doesn't span unrelated sources). When omitted, returns the union of
   * slugs across every source (pre-v0.31.8 behavior).
   */
  getAllSlugs(opts?: { sourceId?: string }): Promise<Set<string>>;

  // Search
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;
  getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>>;

  // Chunks
  /**
   * Replace the chunk set for a page. Internal page-id lookup is sourceId-
   * scoped when `opts.sourceId` is given; without it, the schema DEFAULT
   * matches and bare-slug lookup blows up if the same slug exists in
   * multiple sources (Postgres 21000).
   */
  upsertChunks(slug: string, chunks: ChunkInput[], opts?: { sourceId?: string }): Promise<void>;
  /**
   * Read every chunk for a page. `opts.sourceId` source-scopes the page
   * lookup; without it, multi-source brains return chunks from every
   * same-slug source (importCodeFile uses this for incremental embedding
   * reuse, which would then attach the wrong source's embeddings).
   */
  getChunks(slug: string, opts?: { sourceId?: string }): Promise<Chunk[]>;
  /**
   * Count chunks across the entire brain where embedded_at IS NULL.
   * Pre-flight short-circuit for `embed --stale` so a 100%-embedded brain
   * does no further work after a single SELECT count(*) (~50 bytes wire).
   */
  countStaleChunks(): Promise<number>;
  /**
   * Return every chunk where embedded_at IS NULL, with the metadata needed
   * to call embedBatch + upsertChunks. The `embedding` column is omitted
   * by design — stale rows have NULL embeddings, so shipping them wastes
   * wire bytes for no gain. Caller groups by slug, embeds, and re-upserts.
   *
   * Bounded by an internal LIMIT of 100000 to mirror listPages.
   */
  listStaleChunks(): Promise<StaleChunkRow[]>;
  /**
   * Delete every chunk for a page. Internal page-id lookup is sourceId-scoped
   * when `opts.sourceId` is given; otherwise the bare-slug subquery returns
   * the wrong row count in multi-source brains.
   */
  deleteChunks(slug: string, opts?: { sourceId?: string }): Promise<void>;

  // Links
  /**
   * Single-row link insert. linkSource defaults to 'markdown' for back-compat
   * with pre-v0.13 callers. Pass 'frontmatter' + originSlug + originField for
   * frontmatter-derived edges; 'manual' for user-initiated edges.
   */
  /**
   * v0.18.0+ multi-source: each endpoint can live in a different source.
   * `opts.fromSourceId` / `opts.toSourceId` / `opts.originSourceId` default to
   * 'default'. Without these, the original cross-product `FROM pages f, pages t`
   * fanned out across every source containing the slug.
   */
  addLink(
    from: string,
    to: string,
    context?: string,
    linkType?: string,
    linkSource?: string,
    originSlug?: string,
    originField?: string,
    opts?: { fromSourceId?: string; toSourceId?: string; originSourceId?: string },
  ): Promise<void>;
  /**
   * Bulk insert links via a single multi-row INSERT...SELECT FROM (VALUES) JOIN pages
   * statement with ON CONFLICT DO NOTHING. Returns the count of rows actually inserted
   * (RETURNING clause excludes conflicts and JOIN-dropped rows whose slugs don't exist).
   * Used by extract.ts to avoid 47K sequential round-trips on large brains.
   */
  addLinksBatch(links: LinkBatchInput[]): Promise<number>;
  /**
   * Remove links from `from` to `to`. If linkType is provided, only that specific
   * (from, to, type) row is removed. If omitted, ALL link types between the pair
   * are removed (matches pre-multi-type-link behavior). linkSource additionally
   * constrains the delete to a specific provenance ('frontmatter', 'markdown',
   * 'manual') — used by runAutoLink reconciliation to avoid deleting edges from
   * other provenances when pruning frontmatter-derived edges.
   */
  removeLink(
    from: string,
    to: string,
    linkType?: string,
    linkSource?: string,
    opts?: { fromSourceId?: string; toSourceId?: string },
  ): Promise<void>;
  /**
   * v0.31.8 (D12 + D16): `opts.sourceId` source-scopes the from-page lookup.
   * When omitted, the read returns links from every same-slug page across
   * sources (pre-v0.31.8 behavior; preserved via two-branch query in both
   * engines). When set, the from-page filter becomes
   * `WHERE f.slug = $1 AND f.source_id = $X`.
   */
  getLinks(slug: string, opts?: { sourceId?: string }): Promise<Link[]>;
  /**
   * v0.31.8 (D12 + D16): same `opts.sourceId` semantics as `getLinks`,
   * applied to the to-page side of the join.
   */
  getBacklinks(slug: string, opts?: { sourceId?: string }): Promise<Link[]>;
  /**
   * Fuzzy-match a display name to a page slug using pg_trgm similarity.
   * Zero embedding cost, zero LLM cost — designed for the v0.13 resolver used
   * during migration/batch backfill where 5K+ lookups must stay sub-second.
   *
   * Returns the best match whose title similarity is at or above `minSimilarity`
   * (default 0.55). If `dirPrefix` is given (e.g. 'people' or 'companies'),
   * only slugs starting with that prefix are considered. Returns null when no
   * page meets the threshold.
   *
   * Uses the `%` trigram operator (GIN-indexed) + the standard `similarity()`
   * function. Both engines support pg_trgm (PGLite 0.3+, Postgres always).
   */
  findByTitleFuzzy(
    name: string,
    dirPrefix?: string,
    minSimilarity?: number,
  ): Promise<{ slug: string; similarity: number } | null>;
  /**
   * v0.31.4 (P0/leak-2026-05-11): `opts.sourceId` constrains visited nodes to a
   * single source. When omitted (federated/super-reader), all sources visible.
   * MCP-bound callers MUST pass `{ sourceId: ctx.sourceId }` so cross-source
   * pages can't be discovered via graph metadata even when get_page denies them.
   */
  traverseGraph(slug: string, depth?: number, opts?: { sourceId?: string }): Promise<GraphNode[]>;
  /**
   * Edge-based graph traversal with optional type and direction filters.
   * Returns a list of edges (GraphPath[]) instead of nodes. Supports:
   * - linkType: per-edge filter, only follows matching edges (per-edge semantics)
   * - direction: 'in' (follow to->from), 'out' (follow from->to), 'both'
   * - depth: max depth from root (default 5)
   * - sourceId: v0.31.4, see traverseGraph note above
   * Uses cycle prevention (visited array in recursive CTE).
   */
  traversePaths(
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both'; sourceId?: string },
  ): Promise<GraphPath[]>;
  /**
   * For a list of slugs, return how many inbound links each has.
   * Used by hybrid search backlink boost. Single SQL query, not N+1.
   * Slugs with zero inbound links are present in the map with value 0.
   */
  getBacklinkCounts(slugs: string[]): Promise<Map<string, number>>;
  /**
   * v0.27.0: for a list of slugs, return their updated_at timestamps (or created_at fallback).
   * Used by hybrid search recency boost. Single SQL query, not N+1.
   * Slugs with no timestamp get no entry in the map.
   *
   * @deprecated v0.29.1: prefer getEffectiveDates (composite-keyed, multi-source-safe).
   * Kept for back-compat with PR #618 callers.
   */
  getPageTimestamps(slugs: string[]): Promise<Map<string, Date>>;
  /**
   * v0.29.1: for a list of (slug, source_id) refs, return COALESCE(effective_date,
   * updated_at) per ref. Single SQL query. Composite-keyed map (key format:
   * `${source_id}::${slug}`) so multi-source brains don't conflate pages with
   * the same slug across sources (codex pass-1 finding #3).
   *
   * Drives the new applyRecencyBoost post-fusion stage. Returns NULL for refs
   * with no row; map omits them.
   */
  getEffectiveDates(refs: Array<{slug: string; source_id: string}>): Promise<Map<string, Date>>;
  /**
   * v0.29.1: for a list of (slug, source_id) refs, return the salience score
   * (emotional_weight × 5 + ln(1 + take_count)) per ref. Single SQL query.
   * Composite-keyed (`${source_id}::${slug}`) like getEffectiveDates.
   *
   * Drives the new applySalienceBoost post-fusion stage. Pages with no row
   * (or zero emotional_weight + zero takes) get score = 0; the boost stage
   * skips them.
   */
  getSalienceScores(refs: Array<{slug: string; source_id: string}>): Promise<Map<string, number>>;
  /**
   * Return every page with no inbound links (from any source).
   * Domain comes from the frontmatter `domain` field (null if unset).
   * The caller filters pseudo-pages + derives display domain.
   * Used by `gbrain orphans` and `runCycle`'s orphan sweep phase.
   */
  findOrphanPages(): Promise<Array<{ slug: string; title: string; domain: string | null }>>;

  // Tags
  /**
   * v0.18.0+ multi-source: `opts.sourceId` scopes the page-id lookup. When
   * omitted, the schema DEFAULT 'default' applies; in multi-source brains
   * with the same slug across sources the bare-slug lookup returns >1 row
   * and the INSERT/DELETE fails with Postgres 21000.
   */
  addTag(slug: string, tag: string, opts?: { sourceId?: string }): Promise<void>;
  removeTag(slug: string, tag: string, opts?: { sourceId?: string }): Promise<void>;
  getTags(slug: string, opts?: { sourceId?: string }): Promise<string[]>;

  // Timeline
  /**
   * Insert a timeline entry. By default verifies the page exists and throws if not.
   * Pass opts.skipExistenceCheck=true for batch operations where the slug is already
   * known to exist (e.g., from a getAllSlugs() snapshot). Duplicates are silently
   * deduplicated by the (page_id, date, summary) UNIQUE index (ON CONFLICT DO NOTHING).
   */
  /**
   * Insert a timeline entry. By default verifies the page exists and throws if not.
   * `opts.skipExistenceCheck` skips the pre-check for batch loops where the slug
   * is already known to exist. `opts.sourceId` source-scopes both the existence
   * check AND the page-id lookup inside the INSERT — required for multi-source
   * brains where the slug exists in 2+ sources.
   */
  addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean; sourceId?: string },
  ): Promise<void>;
  /**
   * Bulk insert timeline entries via a single multi-row INSERT...SELECT FROM (VALUES)
   * JOIN pages statement with ON CONFLICT DO NOTHING. Returns the count of rows
   * actually inserted (RETURNING excludes conflicts and JOIN-dropped rows whose
   * slugs don't exist). Used by extract.ts to avoid sequential round-trips.
   */
  addTimelineEntriesBatch(entries: TimelineBatchInput[]): Promise<number>;
  getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]>;

  // Raw data
  /**
   * v0.31.8 (D21): `opts.sourceId` source-scopes the page-id lookup. When
   * omitted, the write targets the bare slug (pre-v0.31.8 behavior); the
   * Postgres 21000 hazard for multi-source brains exists on this path.
   * Multi-source callers MUST pass sourceId to land on the intended row.
   */
  putRawData(slug: string, source: string, data: object, opts?: { sourceId?: string }): Promise<void>;
  /**
   * v0.31.8 (D21): `opts.sourceId` source-scopes the page-id lookup. Without
   * it, multi-source brains return raw_data rows from every same-slug page
   * (preserved via two-branch query for back-compat).
   */
  getRawData(slug: string, source?: string, opts?: { sourceId?: string }): Promise<RawData[]>;

  // Files (v0.27.1: binary asset metadata + storage_path. Image bytes never
  // enter the DB; storage_path references a path inside the brain repo or an
  // external store).
  upsertFile(spec: FileSpec): Promise<{ id: number; created: boolean }>;
  getFile(sourceId: string, storagePath: string): Promise<FileRow | null>;
  listFilesForPage(pageId: number): Promise<FileRow[]>;

  // ============================================================
  // v0.28: Takes (typed/weighted/attributed claims) + synthesis evidence
  // ============================================================
  /**
   * Bulk insert/upsert takes. Uses `unnest()` (Postgres) or manual `$N`
   * placeholders (PGLite). Idempotency: ON CONFLICT (page_id, row_num) DO UPDATE
   * — re-extract on a changed claim/weight updates the row in place.
   * Returns the number of rows inserted OR updated.
   *
   * Weight outside [0, 1] is clamped server-side and surfaces a stderr
   * warning per call (`TAKES_WEIGHT_CLAMPED`). Invalid `kind` values
   * fail the whole batch via the CHECK constraint — caller is responsible
   * for parser validation upstream.
   */
  addTakesBatch(rows: TakeBatchInput[]): Promise<number>;

  /** List takes filtered by holder/kind/active/etc. Resolves page_slug via JOIN. */
  listTakes(opts?: TakesListOpts): Promise<Take[]>;

  /**
   * Keyword search across active takes. Uses pg_trgm similarity over claim text.
   * Honors `takesHoldersAllowList` via WHERE filter so MCP-bound calls cannot
   * retrieve holders outside the token's allow-list.
   */
  searchTakes(query: string, opts?: SearchOpts & { takesHoldersAllowList?: string[] }): Promise<TakeHit[]>;

  /**
   * Vector search across active takes. Cosine distance against `embedding`.
   * Skipped (returns []) when no embedding column has been populated yet.
   */
  searchTakesVector(
    embedding: Float32Array,
    opts?: SearchOpts & { takesHoldersAllowList?: string[] },
  ): Promise<TakeHit[]>;

  /** Look up embeddings by take id (mirrors getEmbeddingsByChunkIds). */
  getTakeEmbeddings(ids: number[]): Promise<Map<number, Float32Array>>;

  /** Pre-flight count for `gbrain embed --stale`. WHERE active AND embedding IS NULL. */
  countStaleTakes(): Promise<number>;

  /** List stale takes (no embedding column in payload — same pattern as listStaleChunks). */
  listStaleTakes(): Promise<StaleTakeRow[]>;

  /**
   * Update a take's mutable fields. May NOT change claim/kind/holder per the
   * supersession invariants — those route through supersedeTake. Throws
   * `TAKE_ROW_NOT_FOUND` when (page_id, row_num) doesn't exist.
   */
  updateTake(
    pageId: number,
    rowNum: number,
    fields: { weight?: number; since_date?: string; source?: string },
  ): Promise<void>;

  /**
   * Supersede the take at (page_id, oldRow). Marks old row active=false +
   * sets superseded_by; appends new row at the next row_num for the page;
   * returns both row_nums. Atomic (transactional). Cycle prevention: if newRow
   * sets superseded_by pointing to a chain that comes back to oldRow, throws
   * `TAKES_SUPERSEDE_CYCLE`. Resolved bets (`resolved_at IS NOT NULL`) cannot
   * be superseded — throws `TAKE_RESOLVED_IMMUTABLE`.
   */
  supersedeTake(
    pageId: number,
    oldRow: number,
    newRow: Omit<TakeBatchInput, 'page_id' | 'row_num' | 'superseded_by'>,
  ): Promise<{ oldRow: number; newRow: number }>;

  /**
   * Resolve a bet (or take). Sets resolved_* columns. Immutable: re-resolve
   * attempts throw `TAKE_ALREADY_RESOLVED`. Use supersede to express a new bet.
   *
   * v0.30.0: accepts either `quality` (3-state, primary) or `outcome` (boolean,
   * back-compat). When both set, `quality` wins. The engine writes BOTH columns
   * derived from whichever input was given: `quality='correct'/'incorrect'` →
   * `outcome=true/false`; `quality='partial'` → `outcome=NULL`. The schema
   * `takes_resolution_consistency` CHECK constraint catches contradictory
   * states at the DB layer as a defense-in-depth backstop.
   */
  resolveTake(pageId: number, rowNum: number, resolution: TakeResolution): Promise<void>;

  /**
   * v0.30.0: aggregate calibration scorecard. Pure SQL aggregation; no LLM.
   * Counts resolved bets, computes accuracy, Brier score (correct+incorrect
   * only), and `partial_rate`. Filtering: `holder` scopes to one identity;
   * `domainPrefix` scopes to a slug-prefix (e.g. `companies/`); `since`/`until`
   * scope to a `since_date` window.
   *
   * Privacy (D4 from plan): `allowList` is REQUIRED in the TS signature.
   * The engine applies `WHERE holder = ANY($allowList)` INSIDE the GROUP BY
   * so hidden-holder rows contribute zero to aggregates. Pass an empty array
   * to enforce zero-results; pass `undefined` only from server-side trusted
   * callers that have already verified the request is unrestricted.
   */
  getScorecard(opts: TakesScorecardOpts, allowList: string[] | undefined): Promise<TakesScorecard>;

  /**
   * v0.30.0: calibration curve. Bins resolved correct+incorrect bets by stated
   * weight (default bucket size 0.1) and reports observed vs predicted frequency
   * per bucket. Same allow-list contract as `getScorecard`. Excludes partial
   * (consistent with Brier — partial has no binary outcome to compare against).
   */
  getCalibrationCurve(opts: CalibrationCurveOpts, allowList: string[] | undefined): Promise<CalibrationBucket[]>;

  /** Persist think provenance. ON CONFLICT DO NOTHING; returns rows inserted. */
  addSynthesisEvidence(rows: SynthesisEvidenceInput[]): Promise<number>;

  // Dream-cycle significance verdict cache (v0.23).
  // Keyed by (file_path, content_hash). Distinct from raw_data, which is
  // page-scoped — transcripts being judged aren't pages yet.
  getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null>;
  putDreamVerdict(filePath: string, contentHash: string, verdict: DreamVerdictInput): Promise<void>;

  // ============================================================
  // v0.31 Hot memory — facts table operations
  // ============================================================
  /**
   * Insert a fact into the per-source hot memory. The handler:
   *   1. canonicalizes entity_slug against pages (caller may pre-canonicalize)
   *   2. queries findCandidateDuplicates (entity-prefiltered, k=5 cap)
   *   3. cosine ≥0.95 fast-path → mark duplicate, skip classifier
   *   4. else classifier (caller's job; this engine method handles the
   *      DB-side INSERT/UPDATE only). On insert.status === 'duplicate' or
   *      'superseded' the engine returns the existing/superseding row id.
   * Per-entity advisory lock on Postgres serializes the dedup window.
   * PGLite no-op for the lock (single-process).
   *
   * `status` reflects what the engine wrote:
   *   'inserted'   → row inserted
   *   'duplicate'  → no new row (returns the matching candidate id)
   *   'superseded' → new row inserted; old row got expired_at + superseded_by
   */
  insertFact(
    input: NewFact,
    ctx: { source_id: string; supersedeId?: number },
  ): Promise<{ id: number; status: FactInsertStatus }>;

  /**
   * Mark a fact expired. Never DELETE. Returns true iff a row was updated.
   * Idempotent-as-false (already expired returns false without changing state).
   */
  expireFact(id: number, opts?: { supersededBy?: number; at?: Date }): Promise<boolean>;

  /** List active facts about an entity within a source, newest first. */
  listFactsByEntity(
    source_id: string,
    entitySlug: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]>;

  /** List facts created since a given timestamp within a source. */
  listFactsSince(
    source_id: string,
    since: Date,
    opts?: FactListOpts & { entitySlug?: string },
  ): Promise<FactRow[]>;

  /** List facts captured under a session id within a source. */
  listFactsBySession(
    source_id: string,
    sessionId: string,
    opts?: FactListOpts,
  ): Promise<FactRow[]>;

  /**
   * Audit log: facts that were superseded (expired_at + superseded_by both set),
   * newest first. Drives `gbrain recall --supersessions`.
   */
  listSupersessions(
    source_id: string,
    opts?: { since?: Date; limit?: number },
  ): Promise<FactRow[]>;

  /**
   * Find candidate duplicates for a new fact within a source+entity bucket.
   * Entity-prefilter is mandatory (bounds the contradiction-classifier blast
   * radius). Hard cap k=5 by default. Embedding-cosine when both sides have
   * embeddings; recency fallback otherwise.
   */
  findCandidateDuplicates(
    source_id: string,
    entitySlug: string,
    factText: string,
    opts?: { k?: number; embedding?: Float32Array },
  ): Promise<FactRow[]>;

  /**
   * Mark a fact as consolidated into a take. Sets consolidated_at + consolidated_into.
   * Never DELETE — facts stay as audit trail.
   */
  consolidateFact(id: number, takeId: number): Promise<void>;

  /** Per-source operational metrics for `gbrain doctor` facts_health check. */
  getFactsHealth(source_id: string): Promise<FactsHealth>;

  // Versions
  /**
   * Snapshot a page row into page_versions. Source-scoped via `opts.sourceId`;
   * without it the bare-slug lookup snapshots whichever row Postgres returns
   * first when the slug exists across multiple sources.
   */
  createVersion(slug: string, opts?: { sourceId?: string }): Promise<PageVersion>;
  /**
   * v0.31.8 (D12 + D16): `opts.sourceId` source-scopes the page-id lookup.
   * When omitted, returns versions for every same-slug page across sources
   * (pre-v0.31.8 behavior; preserved via two-branch query).
   */
  getVersions(slug: string, opts?: { sourceId?: string }): Promise<PageVersion[]>;
  /**
   * v0.31.8 (D12): `opts.sourceId` source-scopes both the version lookup
   * and the page revert. Without it, multi-source brains can revert the
   * wrong row when the slug exists in 2+ sources.
   */
  revertToVersion(slug: string, versionId: number, opts?: { sourceId?: string }): Promise<void>;

  // Stats + health
  getStats(): Promise<BrainStats>;
  getHealth(): Promise<BrainHealth>;

  // Ingest log
  logIngest(entry: IngestLogInput): Promise<void>;
  getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]>;

  // Sync
  /**
   * Rename a page's slug (chunks + links + tags + timeline + versions all
   * preserved via stable page_id). `opts.sourceId` scopes the UPDATE — without
   * it, the bare `WHERE slug = old` matches every row across every source and
   * would either rename them all OR violate the (source_id, slug) UNIQUE.
   */
  updateSlug(oldSlug: string, newSlug: string, opts?: { sourceId?: string }): Promise<void>;
  rewriteLinks(oldSlug: string, newSlug: string): Promise<void>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;

  // Migration support
  runMigration(version: number, sql: string): Promise<void>;
  getChunksWithEmbeddings(slug: string): Promise<Chunk[]>;

  // Raw SQL (for Minions job queue and other internal modules)
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  // ============================================================
  // v0.20.0 Cathedral II: code edges (Layer 5 populates, Layer 7 consumes)
  // ============================================================
  /**
   * Bulk-insert code edges. Resolved edges (to_chunk_id set) land in
   * code_edges_chunk; unresolved refs (to_chunk_id null, to_symbol_qualified
   * set) land in code_edges_symbol. ON CONFLICT DO NOTHING handles idempotency.
   * Returns count of rows actually inserted.
   */
  addCodeEdges(edges: CodeEdgeInput[]): Promise<number>;

  /**
   * Delete all code edges involving these chunk IDs, in BOTH directions, across
   * both code_edges_chunk and code_edges_symbol. Called by importCodeFile on
   * per-chunk invalidation (codex SP-2): when a chunk's text changed, stale
   * inbound edges from other pages pointing at the old symbol must wipe before
   * new edges write.
   */
  deleteCodeEdgesForChunks(chunkIds: number[]): Promise<void>;

  /**
   * "Who calls this symbol?" Returns UNION of code_edges_chunk +
   * code_edges_symbol matching `to_symbol_qualified = qualifiedName`.
   * Source scoping (codex SP-3): if opts.sourceId is set, filter by the
   * anchor chunk's source; if opts.allSources, ignore scoping.
   */
  getCallersOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<CodeEdgeResult[]>;

  /**
   * "What does this symbol call?" Returns edges from chunks whose
   * from_symbol_qualified = qualifiedName. Same source-scoping semantics
   * as getCallersOf.
   */
  getCalleesOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<CodeEdgeResult[]>;

  /**
   * All edges touching a chunk in the given direction. Used by A2 two-pass
   * retrieval to expand from anchor chunks. direction='in' returns edges
   * pointing AT the chunk; 'out' returns edges FROM it; 'both' unions.
   */
  getEdgesByChunk(
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<CodeEdgeResult[]>;

  /**
   * Chunk-grain keyword search. Ranks by content_chunks.search_vector
   * without the dedup-to-page pass that searchKeyword applies. Consumed
   * by A2 two-pass retrieval as its anchor source. Most callers should
   * prefer searchKeyword (external contract: page-grain best-chunk-per-page).
   */
  searchKeywordChunks(query: string, opts?: SearchOpts): Promise<SearchResult[]>;

  // Eval capture (v0.25.0 — BrainBench-Real substrate).
  // Captured at the op-layer wrapper in src/core/operations.ts; reads via
  // `gbrain eval export` (NDJSON) for sibling gbrain-evals consumption.
  // Adding these to BrainEngine is a breaking-interface change for third-
  // party engine implementers — this is why v0.25.0 is a minor bump.
  /** Insert a captured candidate. Returns the new row id. Best-effort: callers swallow failures and route them through `logEvalCaptureFailure`. */
  logEvalCandidate(input: EvalCandidateInput): Promise<number>;
  /** Read candidates by time window / limit / tool filter. Used by `gbrain eval export`. */
  listEvalCandidates(filter?: { since?: Date; limit?: number; tool?: 'query' | 'search' }): Promise<EvalCandidate[]>;
  /** Delete candidates created before `date`. Returns rows deleted. Used by `gbrain eval prune`. */
  deleteEvalCandidatesBefore(date: Date): Promise<number>;
  /** Log a capture failure so `gbrain doctor` can surface drops cross-process. Best-effort; symmetric with logEvalCandidate (failure-of-failure is lost). */
  logEvalCaptureFailure(reason: EvalCaptureFailureReason): Promise<void>;
  /** Read capture failures within an optional time window. Used by `gbrain doctor`. */
  listEvalCaptureFailures(filter?: { since?: Date }): Promise<EvalCaptureFailure[]>;

  // ============================================================
  // v0.29 — Salience + Anomaly Detection
  // ============================================================
  // The brain surfaces what's unusual and emotionally charged without being
  // asked. Cost: ~zero at query time (deterministic SQL), with backfill done
  // during the new `recompute_emotional_weight` cycle phase.

  /**
   * Batch-load tag + take inputs for the emotional-weight formula. One CTE-shaped
   * query: `pages` LEFT JOIN aggregated `tags` and aggregated `takes` (each
   * pre-aggregated in its own CTE so the page × N tags × M takes cartesian
   * product is avoided).
   *
   * If `slugs` is undefined, returns inputs for every page in the brain
   * (full-mode backfill). If provided, returns only matching slugs (incremental
   * recompute after sync / synthesize touched specific pages).
   *
   * Multi-source-aware: each row carries its `source_id` so the matching
   * `setEmotionalWeightBatch` UPDATE can composite-key correctly.
   */
  batchLoadEmotionalInputs(slugs?: string[]): Promise<EmotionalWeightInputRow[]>;

  /**
   * Apply pre-computed emotional weights in a single UPDATE. Composite-keyed
   * on `(slug, source_id)` because `pages.slug` is only unique within a
   * source — a slug-only UPDATE would fan out across sources, the same bug
   * that the v0.18.0 link batches fixed for cross-source edges.
   *
   * Returns the count of rows actually updated. Pages whose `(slug, source_id)`
   * tuple doesn't exist (race with delete) are silently skipped.
   */
  setEmotionalWeightBatch(rows: EmotionalWeightWriteRow[]): Promise<number>;

  /**
   * Salience query: pages recently touched, ranked by a deterministic
   * `(emotional_weight * 5) + ln(1 + take_count) + recency_decay` score.
   *
   * The handler computes the time boundary in JS (`now - days * 86400000`)
   * and binds it as TIMESTAMPTZ so the SQL is identical across PGLite +
   * Postgres (eng review D5 — avoids dialect drift on `interval` binding).
   */
  getRecentSalience(opts: SalienceOpts): Promise<SalienceResult[]>;

  /**
   * Anomaly detection: cohorts (tag, type) with unusually-high page activity
   * on a target day vs baseline mean+stddev over the previous N days. Year
   * cohort is deferred to v0.30 (slug-regex year extraction is fragile).
   *
   * Baseline densifies the day series via `generate_series` zero-fill so
   * sparse-day rare cohorts don't look "normally active" — a sparse-day cohort
   * with one touch in 30 days has a low baseline mean and high sigma at 7 touches,
   * not a misleading mean of 1.
   */
  findAnomalies(opts: AnomaliesOpts): Promise<AnomalyResult[]>;
}
