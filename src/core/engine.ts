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
} from './types.ts';

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
  putPage(slug: string, page: PageInput): Promise<Page>;
  /**
   * Hard-delete a page row. Cascades to content_chunks, page_links,
   * chunk_relations via existing FK ON DELETE CASCADE.
   *
   * v0.26.5: this is no longer the public-facing `delete_page` op handler —
   * the op now soft-deletes via `softDeletePage` instead. `deletePage` stays
   * as the underlying primitive used by `purgeDeletedPages` and by callers
   * that explicitly want hard-delete semantics (e.g. test setup teardown).
   */
  deletePage(slug: string): Promise<void>;
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
  resolveSlugs(partial: string): Promise<string[]>;
  /**
   * Returns the slug of every page in the brain. Used by batch commands as a
   * mutation-immune iteration source (alternative to listPages OFFSET pagination,
   * which is unstable when ordering by updated_at and writes are happening).
   */
  getAllSlugs(): Promise<Set<string>>;

  // Search
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;
  getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>>;

  // Chunks
  upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void>;
  getChunks(slug: string): Promise<Chunk[]>;
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
  deleteChunks(slug: string): Promise<void>;

  // Links
  /**
   * Single-row link insert. linkSource defaults to 'markdown' for back-compat
   * with pre-v0.13 callers. Pass 'frontmatter' + originSlug + originField for
   * frontmatter-derived edges; 'manual' for user-initiated edges.
   */
  addLink(
    from: string,
    to: string,
    context?: string,
    linkType?: string,
    linkSource?: string,
    originSlug?: string,
    originField?: string,
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
  removeLink(from: string, to: string, linkType?: string, linkSource?: string): Promise<void>;
  getLinks(slug: string): Promise<Link[]>;
  getBacklinks(slug: string): Promise<Link[]>;
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
  traverseGraph(slug: string, depth?: number): Promise<GraphNode[]>;
  /**
   * Edge-based graph traversal with optional type and direction filters.
   * Returns a list of edges (GraphPath[]) instead of nodes. Supports:
   * - linkType: per-edge filter, only follows matching edges (per-edge semantics)
   * - direction: 'in' (follow to->from), 'out' (follow from->to), 'both'
   * - depth: max depth from root (default 5)
   * Uses cycle prevention (visited array in recursive CTE).
   */
  traversePaths(
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' },
  ): Promise<GraphPath[]>;
  /**
   * For a list of slugs, return how many inbound links each has.
   * Used by hybrid search backlink boost. Single SQL query, not N+1.
   * Slugs with zero inbound links are present in the map with value 0.
   */
  getBacklinkCounts(slugs: string[]): Promise<Map<string, number>>;
  /**
   * Return every page with no inbound links (from any source).
   * Domain comes from the frontmatter `domain` field (null if unset).
   * The caller filters pseudo-pages + derives display domain.
   * Used by `gbrain orphans` and `runCycle`'s orphan sweep phase.
   */
  findOrphanPages(): Promise<Array<{ slug: string; title: string; domain: string | null }>>;

  // Tags
  addTag(slug: string, tag: string): Promise<void>;
  removeTag(slug: string, tag: string): Promise<void>;
  getTags(slug: string): Promise<string[]>;

  // Timeline
  /**
   * Insert a timeline entry. By default verifies the page exists and throws if not.
   * Pass opts.skipExistenceCheck=true for batch operations where the slug is already
   * known to exist (e.g., from a getAllSlugs() snapshot). Duplicates are silently
   * deduplicated by the (page_id, date, summary) UNIQUE index (ON CONFLICT DO NOTHING).
   */
  addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean },
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
  putRawData(slug: string, source: string, data: object): Promise<void>;
  getRawData(slug: string, source?: string): Promise<RawData[]>;

  // Dream-cycle significance verdict cache (v0.23).
  // Keyed by (file_path, content_hash). Distinct from raw_data, which is
  // page-scoped — transcripts being judged aren't pages yet.
  getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null>;
  putDreamVerdict(filePath: string, contentHash: string, verdict: DreamVerdictInput): Promise<void>;

  // Versions
  createVersion(slug: string): Promise<PageVersion>;
  getVersions(slug: string): Promise<PageVersion[]>;
  revertToVersion(slug: string, versionId: number): Promise<void>;

  // Stats + health
  getStats(): Promise<BrainStats>;
  getHealth(): Promise<BrainHealth>;

  // Ingest log
  logIngest(entry: IngestLogInput): Promise<void>;
  getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]>;

  // Sync
  updateSlug(oldSlug: string, newSlug: string): Promise<void>;
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
}
