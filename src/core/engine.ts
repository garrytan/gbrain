import type {AutoPromoteVerdictKey,
  AutoPromoteVerdictRow,
  BrainHealth,
  BrainStats,
  CanonicalHandoffEntry,
  CanonicalHandoffEntryInput,
  CanonicalHandoffFilters,
  CanonicalTargetProposalDraftPatch,
  CanonicalTargetProposalEntry,
  CanonicalTargetProposalEntryInput,
  CanonicalTargetProposalFilters,
  CanonicalTargetProposalStatusEvent,
  CanonicalTargetProposalStatusEventFilters,
  CanonicalTargetProposalStatusEventInput,
  CanonicalTargetProposalStatusPatch,
  Chunk, ChunkInput,
  ContextAtlasEntry,
  ContextAtlasEntryInput,
  ContextAtlasFilters,
  ContextMapEntry,
  ContextMapEntryInput,
  ContextMapFilters,
  DerivedArtifactKind,
  DerivedIndexState,
  DerivedIndexStateFilters,
  DerivedJob,
  DerivedJobFailureInput,
  DerivedJobFilters,
  DerivedJobInput,
  DerivedJobLeaseInput,
  DerivedJobLeaseReleaseInput,
  EngineConfig,GraphNode,
  IngestLogEntry, IngestLogInput,
  Link,
  MemoryCandidateContradictionEntry,
  MemoryCandidateContradictionEntryInput,
  MemoryCandidateEntry,
  MemoryCandidateEntryInput,
  MemoryCandidateFilters,
  MemoryCandidatePatchOperationStatePatch,
  MemoryCandidatePromotionPatch,
  MemoryCandidateTargetBindingPatch,
  MemoryCandidateStatusEvent,
  MemoryCandidateStatusEventFilters,
  MemoryCandidateStatusEventInput,
  MemoryCandidateStatusPatch,
  MemoryCandidateSupersessionEntry,
  MemoryCandidateSupersessionInput,
  MemoryCandidateVerificationPatch,
  MemoryMutationEvent,
  MemoryMutationEventFilters,
  MemoryMutationEventInput,
  MemoryRealm,
  MemoryRealmFilters,
  MemoryRealmInput,
  MemoryRedactionPlan,
  MemoryRedactionPlanFilters,
  MemoryRedactionPlanInput,
  MemoryRedactionPlanItem,
  MemoryRedactionPlanItemFilters,
  MemoryRedactionPlanItemInput,
  MemoryRedactionPlanItemStatusPatch,
  MemoryRedactionPlanStatusPatch,
  MemorySession,
  MemorySessionAttachment,
  MemorySessionAttachmentFilters,
  MemorySessionAttachmentInput,
  MemorySessionFilters,
  MemorySessionInput,
  NoteManifestEntry,
  NoteManifestEntryInput,
  NoteManifestFilters,
  NoteSectionEntry,
  NoteSectionEntryInput,
  NoteSectionFilters,
  Page, PageFilters, PageInput, PageLineSpanProjection, PageLineSpanProjectionOptions, PageProjection, PageProjectionOptions,
  PageVersion,
  PersonalEpisodeEntry,
  PersonalEpisodeEntryInput,
  PersonalEpisodeFilters,
  ProfileMemoryEntry,
  ProfileMemoryEntryInput,
  ProfileMemoryFilters,
  RawData,
  RetrievalTrace,
  RetrievalTraceInput,
  RetrievalTraceWindowFilters,SearchOpts,
  SearchResult,
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
  TimelineEntry, TimelineInput, TimelineOpts,
} from './types.ts';

// BrainEngine is composed from focused capability interfaces below. The
// composition keeps the single `BrainEngine` contract that all engines
// implement while making each capability independently referenceable (e.g.
// for offline-profile capability gating and navigability). Method signatures
// are unchanged from the original flat interface.

export interface EngineLifecycle {
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;
}

export interface PageStore {
  // Pages CRUD
  getPage(slug: string): Promise<Page | null>;
  getPageProjection(slug: string, options?: PageProjectionOptions): Promise<PageProjection | null>;
  getPageLineSpanProjection(slug: string, options: PageLineSpanProjectionOptions): Promise<PageLineSpanProjection | null>;
  getPageForUpdate(slug: string): Promise<Page | null>;
  putPage(slug: string, page: PageInput): Promise<Page>;
  deletePage(slug: string): Promise<void>;
  listPages(filters?: PageFilters): Promise<Page[]>;
  resolveSlugs(partial: string): Promise<string[]>;

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
  getChunksWithEmbeddings(slug: string): Promise<Chunk[]>;

  // Links
  addLink(from: string, to: string, context?: string, linkType?: string): Promise<void>;
  removeLink(from: string, to: string): Promise<void>;
  getLinks(slug: string): Promise<Link[]>;
  getBacklinks(slug: string): Promise<Link[]>;
  getLinksForSlugs?(slugs: string[]): Promise<Map<string, Link[]>>;
  getBacklinksForSlugs?(slugs: string[]): Promise<Map<string, Link[]>>;
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
}

export interface SearchEngine {
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;
}

export interface EngineDiagnostics {
  // Stats + health
  getStats(): Promise<BrainStats>;
  getHealth(): Promise<BrainHealth>;

  // Ingest log
  logIngest(entry: IngestLogInput): Promise<void>;
  getIngestLog(opts?: { limit?: number; offset?: number }): Promise<IngestLogEntry[]>;
}

export interface OperationalMemoryStore {
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
}

export interface PersonalMemoryStore {
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
}

export interface MemoryGovernanceStore {
  // Governance inbox foundations
  createMemoryCandidateEntry(input: MemoryCandidateEntryInput): Promise<MemoryCandidateEntry>;
  getMemoryCandidateEntry(id: string): Promise<MemoryCandidateEntry | null>;
  getAutoPromoteVerdict(key: AutoPromoteVerdictKey): Promise<AutoPromoteVerdictRow | null>;
  putAutoPromoteVerdict(row: AutoPromoteVerdictRow): Promise<void>;
  listMemoryCandidateEntries(filters?: MemoryCandidateFilters): Promise<MemoryCandidateEntry[]>;
  createMemoryCandidateStatusEvent(input: MemoryCandidateStatusEventInput): Promise<MemoryCandidateStatusEvent>;
  listMemoryCandidateStatusEvents(filters?: MemoryCandidateStatusEventFilters): Promise<MemoryCandidateStatusEvent[]>;
  listMemoryCandidateStatusEventsByInteractionIds(interactionIds: string[]): Promise<MemoryCandidateStatusEvent[]>;
  updateMemoryCandidateEntryStatus(id: string, patch: MemoryCandidateStatusPatch): Promise<MemoryCandidateEntry | null>;
  updateMemoryCandidateEntryVerification(id: string, patch: MemoryCandidateVerificationPatch): Promise<MemoryCandidateEntry | null>;
  updateMemoryCandidatePatchOperationState(id: string, patch: MemoryCandidatePatchOperationStatePatch): Promise<MemoryCandidateEntry | null>;
  bindMemoryCandidateTarget(id: string, patch: MemoryCandidateTargetBindingPatch): Promise<MemoryCandidateEntry | null>;
  promoteMemoryCandidateEntry(id: string, patch?: MemoryCandidatePromotionPatch): Promise<MemoryCandidateEntry | null>;
  supersedeMemoryCandidateEntry(input: MemoryCandidateSupersessionInput): Promise<MemoryCandidateSupersessionEntry | null>;
  getMemoryCandidateSupersessionEntry(id: string): Promise<MemoryCandidateSupersessionEntry | null>;
  createMemoryCandidateContradictionEntry(input: MemoryCandidateContradictionEntryInput): Promise<MemoryCandidateContradictionEntry | null>;
  getMemoryCandidateContradictionEntry(id: string): Promise<MemoryCandidateContradictionEntry | null>;
  listMemoryCandidateContradictionEntriesForCandidateIds(candidateIds: string[]): Promise<MemoryCandidateContradictionEntry[]>;
  createCanonicalHandoffEntry(input: CanonicalHandoffEntryInput): Promise<CanonicalHandoffEntry | null>;
  getCanonicalHandoffEntry(id: string): Promise<CanonicalHandoffEntry | null>;
  listCanonicalHandoffEntries(filters?: CanonicalHandoffFilters): Promise<CanonicalHandoffEntry[]>;
  listCanonicalHandoffEntriesByInteractionIds(interactionIds: string[]): Promise<CanonicalHandoffEntry[]>;
  createCanonicalTargetProposalEntry(input: CanonicalTargetProposalEntryInput): Promise<CanonicalTargetProposalEntry>;
  getCanonicalTargetProposalEntry(id: string): Promise<CanonicalTargetProposalEntry | null>;
  listCanonicalTargetProposalEntries(filters?: CanonicalTargetProposalFilters): Promise<CanonicalTargetProposalEntry[]>;
  updateCanonicalTargetProposalDraft(id: string, patch: CanonicalTargetProposalDraftPatch): Promise<CanonicalTargetProposalEntry | null>;
  updateCanonicalTargetProposalStatus(id: string, patch: CanonicalTargetProposalStatusPatch): Promise<CanonicalTargetProposalEntry | null>;
  createCanonicalTargetProposalStatusEvent(input: CanonicalTargetProposalStatusEventInput): Promise<CanonicalTargetProposalStatusEvent>;
  listCanonicalTargetProposalStatusEvents(filters?: CanonicalTargetProposalStatusEventFilters): Promise<CanonicalTargetProposalStatusEvent[]>;
  listMemoryCandidateSupersessionEntriesByInteractionIds(interactionIds: string[]): Promise<MemoryCandidateSupersessionEntry[]>;
  listMemoryCandidateContradictionEntriesByInteractionIds(interactionIds: string[]): Promise<MemoryCandidateContradictionEntry[]>;
  deleteMemoryCandidateEntry(id: string): Promise<void>;

  // Memory mutation ledger
  createMemoryMutationEvent(input: MemoryMutationEventInput): Promise<MemoryMutationEvent>;
  listMemoryMutationEvents(filters?: MemoryMutationEventFilters): Promise<MemoryMutationEvent[]>;

  // Memory realms
  upsertMemoryRealm(input: MemoryRealmInput): Promise<MemoryRealm>;
  getMemoryRealm(id: string): Promise<MemoryRealm | null>;
  listMemoryRealms(filters?: MemoryRealmFilters): Promise<MemoryRealm[]>;

  // Memory sessions and realm attachments
  createMemorySession(input: MemorySessionInput): Promise<MemorySession>;
  getMemorySession(id: string): Promise<MemorySession | null>;
  listMemorySessions(filters?: MemorySessionFilters): Promise<MemorySession[]>;
  closeMemorySession(id: string): Promise<MemorySession | null>;
  attachMemoryRealmToSession(input: MemorySessionAttachmentInput): Promise<MemorySessionAttachment>;
  listMemorySessionAttachments(filters?: MemorySessionAttachmentFilters): Promise<MemorySessionAttachment[]>;

  // Memory redaction plans
  createMemoryRedactionPlan(input: MemoryRedactionPlanInput): Promise<MemoryRedactionPlan>;
  getMemoryRedactionPlan(id: string): Promise<MemoryRedactionPlan | null>;
  listMemoryRedactionPlans(filters?: MemoryRedactionPlanFilters): Promise<MemoryRedactionPlan[]>;
  createMemoryRedactionPlanItem(input: MemoryRedactionPlanItemInput): Promise<MemoryRedactionPlanItem>;
  listMemoryRedactionPlanItems(filters?: MemoryRedactionPlanItemFilters): Promise<MemoryRedactionPlanItem[]>;
  updateMemoryRedactionPlanStatus(id: string, patch: MemoryRedactionPlanStatusPatch): Promise<MemoryRedactionPlan | null>;
  updateMemoryRedactionPlanItemStatus(id: string, patch: MemoryRedactionPlanItemStatusPatch): Promise<MemoryRedactionPlanItem | null>;
}

export interface NoteStructureStore {
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
}

export interface DerivedJobStore {
  // Durable derived jobs and freshness state
  enqueueDerivedJob(input: DerivedJobInput): Promise<DerivedJob>;
  claimNextDerivedJob(input: DerivedJobLeaseInput): Promise<DerivedJob | null>;
  releaseDerivedJobLease(input: DerivedJobLeaseReleaseInput): Promise<DerivedJob | null>;
  markDerivedJobFailed(input: DerivedJobFailureInput): Promise<DerivedJob | null>;
  listDerivedJobs(filters?: DerivedJobFilters): Promise<DerivedJob[]>;
  getDerivedIndexState(
    scopeId: string,
    slug: string,
    artifactKind: DerivedArtifactKind,
  ): Promise<DerivedIndexState | null>;
  listDerivedIndexStates(filters?: DerivedIndexStateFilters): Promise<DerivedIndexState[]>;
  markDerivedIndexReady(input: {
    scope_id: string;
    slug: string;
    artifact_kind: DerivedArtifactKind;
    target_content_hash: string;
    indexed_content_hash: string;
    manifest_path?: string | null;
    derived_parameters?: Record<string, unknown>;
    extractor_version?: string;
    derived_schema_version?: string;
    lease_owner?: string;
    require_active_job?: boolean;
  }): Promise<DerivedIndexState>;
}

export interface ContextRegistryStore {
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
}

export interface EngineSyncConfig {
  // Sync
  updateSlug(oldSlug: string, newSlug: string): Promise<void>;
  rewriteLinks(oldSlug: string, newSlug: string): Promise<void>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
}

export interface BrainEngine
  extends EngineLifecycle,
    PageStore,
    SearchEngine,
    EngineDiagnostics,
    OperationalMemoryStore,
    PersonalMemoryStore,
    MemoryGovernanceStore,
    NoteStructureStore,
    DerivedJobStore,
    ContextRegistryStore,
    EngineSyncConfig {}
