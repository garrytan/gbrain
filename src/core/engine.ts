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

/** Maximum results returned by search operations. Internal bulk operations (listPages) are not clamped. */
export const MAX_SEARCH_LIMIT = 100;

/** Clamp a user-provided search limit to a safe range. */
export function clampSearchLimit(limit: number | undefined, defaultLimit = 20): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || Number.isNaN(limit)) return defaultLimit;
  if (limit <= 0) return defaultLimit;
  return Math.min(Math.floor(limit), MAX_SEARCH_LIMIT);
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
