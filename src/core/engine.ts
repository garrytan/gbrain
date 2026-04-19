import type {
  Page, PageInput, PageFilters,
  Chunk, ChunkInput,
  SearchResult, SearchOpts,
  Link, GraphNode, GraphPath,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
} from './types.ts';

/** Input row for addLinksBatch. Optional fields default to '' (matches NOT NULL DDL). */
export interface LinkBatchInput {
  from_slug: string;
  to_slug: string;
  link_type?: string;
  context?: string;
}

/** Input row for addTimelineEntriesBatch. Optional fields default to '' (matches NOT NULL DDL). */
export interface TimelineBatchInput {
  slug: string;
  date: string;
  source?: string;
  summary: string;
  detail?: string;
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
  // Lifecycle
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;

  // Pages CRUD
  getPage(slug: string): Promise<Page | null>;
  putPage(slug: string, page: PageInput): Promise<Page>;
  deletePage(slug: string): Promise<void>;
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
  deleteChunks(slug: string): Promise<void>;

  // Links
  addLink(from: string, to: string, context?: string, linkType?: string): Promise<void>;
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
   * are removed (matches pre-multi-type-link behavior).
   */
  removeLink(from: string, to: string, linkType?: string): Promise<void>;
  getLinks(slug: string): Promise<Link[]>;
  getBacklinks(slug: string): Promise<Link[]>;
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
}
