import type { BrainEngine } from '../../src/core/engine.ts';
import * as embedStaleWork from '../../src/core/engine-sql/embed-stale-work.ts';
import { readPageProvenanceComplete } from '../../src/core/engine-sql/embedding-provenance.ts';

/** Minimal coherent read/transaction surface for provider orchestration tests. */
export function mockEmbedProjectionEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  // Raw SQL the stale drain issues (the page-provenance stamp check) reads an
  // empty result set unless a test models it — the Proxy's null default would
  // throw on indexing and count the page as a failed embed.
  const revision = '00000000-0000-4000-8000-000000000001';
  const pages = new Map<string, number>();
  const pageKinds = new Map<number, string>();
  overrides = {
    executeRaw: async (sql: string) => sql.startsWith('SELECT count(*)::int AS n FROM pages p')
      && sql.includes('p.text_projection_revision IS DISTINCT FROM p.knowledge_revision') ? [{ n: 0 }] : [],
    getConfigKeys: async () => [],
    // No vector column, as the empty raw catalog read above answered before the typed member existed.
    readChunkVectorColumn: async () => ({ exists: false, dims: null }),
    // One well-formed unmanaged mode row (#6482), read through the typed import guard method.
    readManagedModeRows: async () => [{ enabled: false }],
    // No held or capped large pages, as the empty raw budget reads answered before the typed members existed.
    listBudgetLimitedRows: async () => [],
    readBudgetHoldAge: async () => undefined,
    // The cycle lock (src/core/db-lock.ts) is always free and always held by us in this single-process mock.
    acquireCycleLock: async (lockId: string) => ({ id: lockId, fence: '1' }),
    refreshCycleLock: async () => true,
    releaseCycleLock: async () => true,
    readCycleLocks: async () => [],
    deleteCycleLock: async () => true,
    deleteCycleLockIfStale: async () => ({ deleted: false, lastRefreshedAt: null }),
    // The per-page embedding lease (src/core/page-embedding-lease.ts) is always free, and its install-time renewal always holds, in this single-process mock.
    takePageEmbeddingLease: async () => true,
    renewPageEmbeddingLease: async () => true,
    releasePageEmbeddingLease: async () => undefined,
    transaction: async (run: (tx: BrainEngine) => Promise<unknown>) => run(engine),
    // The page embedding ledger (page-embedding-budget.ts) has no row and no hold marker: every page is unmetered.
    readPageEmbeddingBudget: async () => ({ marker: null, state: null, reason: null, embedding_signature: null, spent_usd: null,
      reserved_usd: null, cap_usd: null, unpriced_calls: null, reservation_window: null }),
    reservePageEmbedding: async () => ({ kind: 'unmetered' }),
    readPageSnapshot: async (slug: string, opts?: { sourceId?: string }) => {
      const page = overrides.getPage ? await overrides.getPage(slug, opts) : { slug, compiled_truth: 'Fixture body', timeline: '' };
      if (!page) return null;
      if (!pages.has(slug)) pages.set(slug, pages.size + 1);
      pageKinds.set(pages.get(slug)!, page.page_kind ?? (page.type === 'code' ? 'code' : 'markdown'));
      return { revision, sourceIncarnation: revision, tags: [], withdrawals: [], page: {
        id: pages.get(slug), slug, source_id: opts?.sourceId ?? 'default', title: slug,
        knowledge_revision: revision, text_projection_revision: revision, ...page,
      } };
    },
    ...overrides,
  };
  const executeRaw = overrides.executeRaw;
  overrides.executeRaw = async (sql: string, params?: unknown[]) => sql.startsWith('SELECT page_kind FROM pages WHERE id=')
    ? [{ page_kind: pageKinds.get(Number(params?.[0])) ?? 'markdown' }]
    : sql === 'SELECT archived FROM sources WHERE id=$1' ? [{ archived: false }]
    : sql.includes('FROM persistence_brain') ? [{ enabled: false }]
    : executeRaw(sql, params);
  // The projection installs read the source's archived flag through the typed member; the mock answers it as the
  // statement above does: every source exists and is live.
  overrides.readSourceRow ??= async (sourceId: string) => ({ id: sourceId, local_path: null, config: {}, archived: false });
  // indexingContext reads the page's indexing state through the typed member; the mock answers it from the two
  // statements the member runs, so a test that models `SELECT chunker_version` keeps its answer.
  overrides.readPageIndexingState ??= async (pageId: number) => {
    const [projection] = await engine.executeRaw('SELECT chunker_version,corpus_generation FROM pages WHERE id=$1', [pageId]) ?? [];
    const [kind] = await engine.executeRaw('SELECT page_kind FROM pages WHERE id=$1', [pageId]) ?? [];
    if (!kind) return null;
    return { chunker_version: projection?.chunker_version ?? null, corpus_generation: projection?.corpus_generation ?? null, page_kind: kind.page_kind };
  };
  // The embed --stale reads and writes are typed members (engine-sql/embed-stale-work.ts, embedding-provenance.ts); the mock
  // answers each by running its statement through the mock's executeRaw, so a test that models that statement keeps its answer.
  const raw = ((sql: string, params?: unknown[]) => engine.executeRaw(sql, params)) as embedStaleWork.EngineRawRead;
  overrides.countArchivedEmbeddingWork ??= (opts: embedStaleWork.ArchivedEmbeddingWorkOpts) => embedStaleWork.countArchivedEmbeddingWork(raw, opts);
  overrides.countEmbedPendingProjections ??= (scope: embedStaleWork.PendingProjectionScope) => embedStaleWork.countEmbedPendingProjections(raw, scope);
  overrides.listEmbedPendingProjections ??= (scope: embedStaleWork.PendingProjectionScope, limit: number) => embedStaleWork.listEmbedPendingProjections(raw, scope, limit);
  overrides.listEmbedProjectionRepairPages ??= (scope: embedStaleWork.PendingProjectionScope, after: number, limit: number) => embedStaleWork.listEmbedProjectionRepairPages(raw, scope, after, limit);
  overrides.readPageIsSegmented ??= (pageId: number) => embedStaleWork.readPageIsSegmented(raw, pageId);
  overrides.hasEmbeddingSignatureDrift ??= (opts: embedStaleWork.SignatureDriftOpts) => embedStaleWork.hasEmbeddingSignatureDrift(raw, opts);
  overrides.listUnembeddedChunkIndexes ??= (slug: string, sourceId: string, column: string) => embedStaleWork.listUnembeddedChunkIndexes(raw, slug, sourceId, column);
  overrides.lockContentDriftState ??= (key: string, initial: string) => embedStaleWork.lockContentDriftState(raw, key, initial);
  overrides.invalidateContentDriftChunks ??= (window: embedStaleWork.ContentDriftChunkWindow) => embedStaleWork.invalidateContentDriftChunks(raw, window);
  overrides.readPageProvenanceComplete ??= (slug: string, sourceId: string, model: string, dims: number | null, column: string) =>
    readPageProvenanceComplete({ executeRaw: raw } as unknown as Pick<BrainEngine, 'executeRaw'>, slug, sourceId, model, dims, column);
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop] && typeof overrides[prop] !== 'function') return overrides[prop];
      return track(prop);
    },
  });
  return engine;
}

/**
 * Vector writes installPageEmbeddings issued, one entry per updated row. Each
 * `installChunkEmbeddings(pageId, column, batch)` call is one batch; each row is
 * expanded to the positional layout `[id, vector, image, model, page_id, chunk_text, input_hash]`.
 * Any other `UPDATE content_chunks SET` statement counts as itself.
 */
export function embeddingUpdates(engine: BrainEngine) {
  return (engine as any)._calls.filter((call: any) => call.method === 'installChunkEmbeddings'
    || (call.method === 'executeRaw' && /^UPDATE content_chunks SET/.test(call.args[0])))
    .flatMap((call: any) => call.method === 'executeRaw' ? [call]
      : (JSON.parse(call.args[2]) as any[]).map(row => ({ ...call,
        args: ['installChunkEmbeddings', [row.id, row.embedding, row.image, row.model, call.args[0], row.chunk_text, row.input_hash]] })));
}
