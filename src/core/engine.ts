import type {
  Page, PageInput, PageFilters,
  NoteManifestEntry,
  NoteManifestEntryInput,
  NoteManifestFilters,
  NoteSectionEntry,
  NoteSectionEntryInput,
  NoteSectionFilters,
  ContextMapEntry,
  ContextMapEntryInput,
  ContextMapFilters,
  ContextAtlasEntry,
  ContextAtlasEntryInput,
  ContextAtlasFilters,
  MemoryCandidateEntry,
  MemoryCandidateContradictionEntry,
  MemoryCandidateContradictionEntryInput,
  MemoryCandidateEntryInput,
  MemoryCandidateFilters,
  MemoryCandidatePromotionPatch,
  MemoryCandidateSupersessionEntry,
  MemoryCandidateSupersessionInput,
  MemoryCandidateStatusPatch,
  CanonicalHandoffEntry,
  CanonicalHandoffEntryInput,
  CanonicalHandoffFilters,
  ProfileMemoryEntry,
  ProfileMemoryEntryInput,
  ProfileMemoryFilters,
  PersonalEpisodeEntry,
  PersonalEpisodeEntryInput,
  PersonalEpisodeFilters,
  Chunk, ChunkInput,
  SearchResult, SearchOpts,
  Link, GraphNode,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
  TaskAttempt,
  TaskAttemptInput,
  TaskDecision,
  TaskDecisionInput,
  TaskThread,
  TaskThreadFilters,
  TaskThreadInput,
  TaskThreadPatch,
  TaskWorkingSet,
  TaskWorkingSetInput,
  RetrievalTrace,
  RetrievalTraceInput,
  RetrievalTraceWindowFilters,
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
  getPageEmbeddings(type?: Page['type']): Promise<Array<{
    page_id: number;
    slug: string;
    embedding: Float32Array | null;
  }>>;
  updatePageEmbedding(slug: string, embedding: Float32Array | null): Promise<void>;

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

  // Operational memory
  createTaskThread(input: TaskThreadInput): Promise<TaskThread>;
  updateTaskThread(id: string, patch: TaskThreadPatch): Promise<TaskThread>;
  listTaskThreads(filters?: TaskThreadFilters): Promise<TaskThread[]>;
  getTaskThread(id: string): Promise<TaskThread | null>;
  getTaskWorkingSet(taskId: string): Promise<TaskWorkingSet | null>;
  upsertTaskWorkingSet(input: TaskWorkingSetInput): Promise<TaskWorkingSet>;
  recordTaskAttempt(input: TaskAttemptInput): Promise<TaskAttempt>;
  listTaskAttempts(taskId: string, opts?: { limit?: number }): Promise<TaskAttempt[]>;
  recordTaskDecision(input: TaskDecisionInput): Promise<TaskDecision>;
  listTaskDecisions(taskId: string, opts?: { limit?: number }): Promise<TaskDecision[]>;
  putRetrievalTrace(input: RetrievalTraceInput): Promise<RetrievalTrace>;
  getRetrievalTrace(id: string): Promise<RetrievalTrace | null>;
  listRetrievalTraces(taskId: string, opts?: { limit?: number }): Promise<RetrievalTrace[]>;
  listRetrievalTracesByWindow(filters: RetrievalTraceWindowFilters): Promise<RetrievalTrace[]>;

  // Personal profile memory
  upsertProfileMemoryEntry(input: ProfileMemoryEntryInput): Promise<ProfileMemoryEntry>;
  getProfileMemoryEntry(id: string): Promise<ProfileMemoryEntry | null>;
  listProfileMemoryEntries(filters?: ProfileMemoryFilters): Promise<ProfileMemoryEntry[]>;
  deleteProfileMemoryEntry(id: string): Promise<void>;

  // Personal episodes
  createPersonalEpisodeEntry(input: PersonalEpisodeEntryInput): Promise<PersonalEpisodeEntry>;
  getPersonalEpisodeEntry(id: string): Promise<PersonalEpisodeEntry | null>;
  listPersonalEpisodeEntries(filters?: PersonalEpisodeFilters): Promise<PersonalEpisodeEntry[]>;
  deletePersonalEpisodeEntry(id: string): Promise<void>;

  // Governance inbox foundations
  createMemoryCandidateEntry(input: MemoryCandidateEntryInput): Promise<MemoryCandidateEntry>;
  getMemoryCandidateEntry(id: string): Promise<MemoryCandidateEntry | null>;
  listMemoryCandidateEntries(filters?: MemoryCandidateFilters): Promise<MemoryCandidateEntry[]>;
  updateMemoryCandidateEntryStatus(id: string, patch: MemoryCandidateStatusPatch): Promise<MemoryCandidateEntry | null>;
  promoteMemoryCandidateEntry(id: string, patch?: MemoryCandidatePromotionPatch): Promise<MemoryCandidateEntry | null>;
  supersedeMemoryCandidateEntry(input: MemoryCandidateSupersessionInput): Promise<MemoryCandidateSupersessionEntry | null>;
  getMemoryCandidateSupersessionEntry(id: string): Promise<MemoryCandidateSupersessionEntry | null>;
  createMemoryCandidateContradictionEntry(input: MemoryCandidateContradictionEntryInput): Promise<MemoryCandidateContradictionEntry | null>;
  getMemoryCandidateContradictionEntry(id: string): Promise<MemoryCandidateContradictionEntry | null>;
  createCanonicalHandoffEntry(input: CanonicalHandoffEntryInput): Promise<CanonicalHandoffEntry | null>;
  getCanonicalHandoffEntry(id: string): Promise<CanonicalHandoffEntry | null>;
  listCanonicalHandoffEntries(filters?: CanonicalHandoffFilters): Promise<CanonicalHandoffEntry[]>;
  listCanonicalHandoffEntriesByInteractionIds(interactionIds: string[]): Promise<CanonicalHandoffEntry[]>;
  listMemoryCandidateSupersessionEntriesByInteractionIds(interactionIds: string[]): Promise<MemoryCandidateSupersessionEntry[]>;
  listMemoryCandidateContradictionEntriesByInteractionIds(interactionIds: string[]): Promise<MemoryCandidateContradictionEntry[]>;
  deleteMemoryCandidateEntry(id: string): Promise<void>;

  // Note manifest
  upsertNoteManifestEntry(input: NoteManifestEntryInput): Promise<NoteManifestEntry>;
  getNoteManifestEntry(scopeId: string, slug: string): Promise<NoteManifestEntry | null>;
  listNoteManifestEntries(filters?: NoteManifestFilters): Promise<NoteManifestEntry[]>;
  deleteNoteManifestEntry(scopeId: string, slug: string): Promise<void>;

  // Note sections
  replaceNoteSectionEntries(
    scopeId: string,
    pageSlug: string,
    entries: NoteSectionEntryInput[],
  ): Promise<NoteSectionEntry[]>;
  getNoteSectionEntry(scopeId: string, sectionId: string): Promise<NoteSectionEntry | null>;
  listNoteSectionEntries(filters?: NoteSectionFilters): Promise<NoteSectionEntry[]>;
  deleteNoteSectionEntries(scopeId: string, pageSlug: string): Promise<void>;

  // Persisted context maps
  upsertContextMapEntry(input: ContextMapEntryInput): Promise<ContextMapEntry>;
  getContextMapEntry(id: string): Promise<ContextMapEntry | null>;
  listContextMapEntries(filters?: ContextMapFilters): Promise<ContextMapEntry[]>;
  deleteContextMapEntry(id: string): Promise<void>;

  // Persisted context atlas registry
  upsertContextAtlasEntry(input: ContextAtlasEntryInput): Promise<ContextAtlasEntry>;
  getContextAtlasEntry(id: string): Promise<ContextAtlasEntry | null>;
  listContextAtlasEntries(filters?: ContextAtlasFilters): Promise<ContextAtlasEntry[]>;
  deleteContextAtlasEntry(id: string): Promise<void>;

  // Sync
  updateSlug(oldSlug: string, newSlug: string): Promise<void>;
  rewriteLinks(oldSlug: string, newSlug: string): Promise<void>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;

  getChunksWithEmbeddings(slug: string): Promise<Chunk[]>;
}
