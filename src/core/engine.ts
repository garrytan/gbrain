import type {
  Page, PageInput, PageFilters,
  Chunk, ChunkInput,
  SearchResult, SearchOpts,
  Link, GraphNode,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
} from './types.ts';

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

  // Search
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;

  // Chunks
  upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void>;
  getChunks(slug: string): Promise<Chunk[]>;
  deleteChunks(slug: string): Promise<void>;

  // Links
  addLink(from: string, to: string, context?: string, linkType?: string): Promise<void>;
  removeLink(from: string, to: string): Promise<void>;
  getLinks(slug: string): Promise<Link[]>;
  getBacklinks(slug: string): Promise<Link[]>;
  traverseGraph(slug: string, depth?: number): Promise<GraphNode[]>;

  // Tags
  addTag(slug: string, tag: string): Promise<void>;
  removeTag(slug: string, tag: string): Promise<void>;
  getTags(slug: string): Promise<string[]>;

  // Timeline
  addTimelineEntry(slug: string, entry: TimelineInput): Promise<void>;
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
}

/**
 * Hard ceiling on the number of rows any search operation returns.
 *
 * Authenticated callers can pass arbitrary `limit` values through the
 * remote MCP `search` / `query` tools and through `gbrain` CLI flags.
 * Without a server-side clamp, a bearer token holder can request
 * `{ limit: 10_000_000 }` and force Postgres to do a full FTS pass +
 * sort + materialization, then ship the whole result set to the Edge
 * Function isolate before any JS-side slice runs. This ceiling bounds
 * the worst case to a predictable amount of work regardless of what
 * the caller asks for.
 *
 * All `searchKeyword` / `searchVector` implementations must apply this
 * cap at entry. `hybridSearch` must also apply it before multiplying
 * `limit * 2` for internal expansion. See M001 in report/findings.md.
 */
export const MAX_SEARCH_LIMIT = 100;

/**
 * Clamp a caller-supplied search limit into the [1, MAX_SEARCH_LIMIT]
 * range.
 *
 * - undefined / null → defaultLimit (itself clipped to the ceiling)
 * - NaN → defaultLimit (caller sent garbage, don't guess intent)
 * - zero or negative → defaultLimit (almost certainly a caller bug)
 * - fractional → floored
 * - +Infinity → MAX_SEARCH_LIMIT (caller meant "all of them", we bound it)
 * - values above MAX_SEARCH_LIMIT → MAX_SEARCH_LIMIT
 */
export function clampSearchLimit(limit: number | undefined, defaultLimit = 20): number {
  const raw = limit ?? defaultLimit;
  if (Number.isNaN(raw)) return Math.min(defaultLimit, MAX_SEARCH_LIMIT);
  if (raw < 1) return Math.min(defaultLimit, MAX_SEARCH_LIMIT);
  const integral = Math.floor(raw);
  // Math.min(Infinity, N) === N, so +Infinity flows through as MAX_SEARCH_LIMIT
  // without a special case.
  return Math.min(integral, MAX_SEARCH_LIMIT);
}
