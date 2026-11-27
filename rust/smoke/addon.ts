/**
 * Loads the Rust engine addon for the smoke tests. The path comes only from
 * GBRAIN_RUST_ENGINE_ADDON (printed by `bun run rust:build`); nothing is searched for.
 *
 * It uses process.dlopen with a path computed at run time. A literal `require('x.node')` would be
 * bundled by `bun build --compile`; a computed path is not, which is what the compiled-binary
 * check in selfcheck.ts depends on.
 */

export interface ShutdownReport {
  cancelledQueued: number;
  finishedRunning: number;
  abandonedRunning: number;
}

export interface CancelToken {
  cancel(): void;
  readonly cancelled: boolean;
}

export interface Pool {
  readonly state: string;
  readonly queued: number;
  readonly running: number;
  readonly workers: number;
  blockFor(ms: number): Promise<number>;
  runSteps(steps: number, stepMs: number, token?: CancelToken): Promise<number>;
  sumF32(values: Float32Array): Promise<number>;
  scaleF32(values: Float32Array, factor: number): Promise<Float32Array>;
  probePanic(): Promise<number>;
  shutdown(waitMs: number): Promise<ShutdownReport>;
}

export interface Sink {
  emit(value: number): string;
  emitFromThread(count: number): Promise<string[]>;
  close(): void;
}

export interface BrainInfo {
  brain_id: string;
  format_version: number;
  schema_version: number;
  created: boolean;
}

export interface SourceRow {
  id: string;
  name: string | null;
  local_path: string | null;
  last_sync_at: string | null;
  config: Record<string, unknown>;
  incarnation: string;
}

export interface PageSnapshot {
  page: Record<string, any>;
  tags: string[];
  revision: string;
  sourceIncarnation: string;
  withdrawals: unknown[];
}

export interface PageScope {
  sourceId?: string;
  sourceIds?: string[];
  includeDeleted?: boolean;
}

/** The store class (crates/gbrain-napi/src/store_binding.rs). Every method is documented in rust/README.md. */
export interface Brain {
  readonly isOpen: boolean;
  open(path: string, options?: { schemaVersion?: number; createdBy?: string; concurrentWrites?: boolean }): Promise<BrainInfo>;
  close(): Promise<void>;
  info(): Promise<BrainInfo>;
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<null>;
  unsetConfig(key: string): Promise<number>;
  listConfigKeys(prefix: string): Promise<string[]>;
  getAllConfig(): Promise<Record<string, string>>;
  listAllSources(options?: { includeArchived?: boolean; localPathOnly?: boolean }): Promise<SourceRow[]>;
  getSourceById(id: string): Promise<SourceRow | null>;
  upsertSource(input: { id: string; name?: string; local_path?: string; last_sync_at?: string; config?: Record<string, unknown> }): Promise<SourceRow>;
  updateSourceConfig(id: string, patch: Record<string, unknown>): Promise<boolean>;
  setSourceArchived(id: string, archived: boolean): Promise<boolean>;
  readPageSnapshot(slug: string, options?: PageScope): Promise<PageSnapshot | null>;
  putPage(
    slug: string,
    page: Record<string, unknown>,
    options?: { sourceId?: string; allowEmptyOverwrite?: boolean; expectedRevision?: string | null; force?: boolean },
  ): Promise<Record<string, any>>;
  listPages(filters?: Record<string, unknown>): Promise<Record<string, any>[]>;
  countPages(options?: { sourceId?: string }): Promise<number>;
  lockPageKeys(keys: { sourceId: string; slug: string }[]): Promise<null>;
  resolveSlugs(partial: string, options?: PageScope): Promise<string[]>;
  softDeletePage(slug: string, options?: { sourceId?: string }): Promise<{ slug: string } | null>;
  restorePage(slug: string, options?: { sourceId?: string }): Promise<boolean>;
  deletePage(slug: string, options?: { sourceId?: string }): Promise<null>;
  getTags(slug: string, options?: PageScope): Promise<string[]>;
  addTag(slug: string, tag: string, options?: { sourceId?: string }): Promise<null>;
  removeTag(slug: string, tag: string, options?: { sourceId?: string }): Promise<null>;
  createVersion(slug: string, options?: { sourceId?: string }): Promise<Record<string, any>>;
  getVersions(
    slug: string,
    options?: PageScope & { limit?: number; includeBody?: boolean },
  ): Promise<Record<string, any>[]>;
  upsertChunks(
    slug: string,
    chunks: Array<Record<string, any>>,
    options?: { sourceId?: string; expectedRevision?: string; deferSeal?: boolean },
  ): Promise<null>;
  getChunks(slug: string, options?: PageScope): Promise<Array<Record<string, any>>>;
  deleteChunks(slug: string, options?: { sourceId?: string }): Promise<null>;
  countChunks(): Promise<number>;
  searchKeyword(query: string, options?: Record<string, any>): Promise<Array<Record<string, any>>>;
  addLink(from: string, to: string, options?: Record<string, any>): Promise<null>;
  addLinksBatch(links: Array<Record<string, any>>): Promise<number>;
  removeLink(from: string, to: string, options?: Record<string, any>): Promise<number>;
  getLinks(slug: string, options?: Record<string, any>): Promise<Array<Record<string, any>>>;
  getBacklinks(slug: string, options?: Record<string, any>): Promise<Array<Record<string, any>>>;
  traverseGraph(slug: string, depth?: number, options?: Record<string, any>): Promise<Array<Record<string, any>>>;
  traversePaths(slug: string, options?: Record<string, any>): Promise<Array<Record<string, any>>>;
  traversePathsDetailed(
    slug: string,
    options?: Record<string, any>,
  ): Promise<{ paths: Array<Record<string, any>>; truncated: boolean }>;
  addTimelineEntry(slug: string, entry: Record<string, any>, options?: Record<string, any>): Promise<boolean>;
  addTimelineEntriesBatch(entries: Array<Record<string, any>>): Promise<number>;
  getTimeline(slug: string, options?: Record<string, any>): Promise<Array<Record<string, any>>>;
  getBrainIdentity(): Promise<{ brain_id: string }>;
  registerLocalWriter(writer: { id: string; lane: 'cli' | 'stdio'; credentialHash: string; grantCeiling?: Record<string, any> }): Promise<Record<string, any>>;
  readLocalWriter(id: string): Promise<Record<string, any> | null>;
  revokeLocalWriter(id: string): Promise<boolean>;
  admitWrite(admission: Record<string, any>, limits?: { principalOutstanding?: number; brainOutstanding?: number }): Promise<Record<string, any>>;
  getWriteRequest(principal: { kind: string; id: string }, requestId: string): Promise<Record<string, any> | null>;
  getWriteReceipt(principal: { kind: string; id: string }, requestId: string): Promise<Record<string, any> | null>;
  finishWrite(
    principal: { kind: string; id: string },
    requestId: string,
    finish: { state: string; outcome?: Record<string, any>; errorCode?: string; errorMessage?: string; blockedReason?: string },
  ): Promise<Record<string, any>>;
  journalOutstanding(): Promise<{ brain: number; principals: Record<string, number> }>;
  // Called with hostile arguments by the boundary fuzz in cases.ts, so the arguments are loose on purpose.
  getConfigValues(keys: unknown): Promise<Array<{ key: string; value: string }>>;
  insertFact(args: unknown): Promise<Record<string, any>>;
  listFactsByEntity(query: unknown): Promise<Array<Record<string, any>>>;
  expireFact(args: unknown): Promise<boolean>;
  expireFactsByWithdrawal(args: unknown): Promise<Array<Record<string, any>>>;
  planFactPurgeIds(args: unknown): Promise<Array<Record<string, any>>>;
  insertFactPurge(row: unknown): Promise<boolean>;
  searchKeywordChunks(query: string, options?: unknown): Promise<Array<Record<string, any>>>;
  countKeywordPages(query: string, options?: unknown): Promise<number>;
  admitJob(spec: unknown): Promise<Record<string, any>>;
  getJob(id: number): Promise<Record<string, any> | null>;
  listJobs(filter?: unknown): Promise<Array<Record<string, any>>>;
  claimNextJob(spec: unknown): Promise<Record<string, any> | null>;
  completeJob(id: number, lockToken: string, result?: unknown): Promise<Record<string, any> | null>;
  renewJobLease(id: number, lockToken: string, lockDurationMs: number): Promise<boolean>;
  submitPageMutation(
    mutation: {
      principal: { kind: string; id: string };
      requestId?: string;
      clientRequestId?: string;
      sourceIncarnation?: string;
      slug: string;
      page: Record<string, any>;
      options?: Record<string, any>;
      authority?: Record<string, any>;
    },
    limits?: { principalOutstanding?: number; brainOutstanding?: number },
  ): Promise<Record<string, any>>;
}

export interface Addon {
  target: string;
  engineAbi: number;
  engineBuild: string;
  catalogVersion: number;
  formatVersions: unknown[];
  sinkMaxQueueSize: number;
  sumF32(values: Float32Array): number;
  scaleF32(values: Float32Array, factor: number): Float32Array;
  scaleInPlaceF32(values: Float32Array, factor: number): number;
  probePanicSync(): void;
  liveWorkers(): number;
  CancelToken: new () => CancelToken;
  Pool: new (workers: number) => Pool;
  Brain: new (pool: Pool) => Brain;
  Sink: new (callback: (value: number) => void) => Sink;
}

export function loadAddon(path: string | undefined = process.env.GBRAIN_RUST_ENGINE_ADDON): Addon {
  if (!path) {
    throw new Error(
      'GBRAIN_RUST_ENGINE_ADDON is not set. Run `bun run rust:build` and export the path it prints.',
    );
  }
  const module = { exports: {} as unknown };
  process.dlopen(module as NodeJS.Module, path);
  return module.exports as Addon;
}
