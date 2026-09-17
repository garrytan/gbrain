import type { BrainEngine } from '../../src/core/engine.ts';

/** Minimal coherent read/transaction surface for provider orchestration tests. */
export function mockEmbedProjectionEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  // Raw SQL the stale drain issues (the page-provenance stamp check) reads an
  // empty result set unless a test models it — the Proxy's null default would
  // throw on indexing and count the page as a failed embed.
  const revision = '00000000-0000-4000-8000-000000000001';
  const pages = new Map<string, number>();
  overrides = {
    executeRaw: async () => [],
    getConfigKeys: async () => [],
    transaction: async (run: (tx: BrainEngine) => Promise<unknown>) => run(engine),
    readPageSnapshot: async (slug: string, opts?: { sourceId?: string }) => {
      const page = overrides.getPage ? await overrides.getPage(slug, opts) : { slug, compiled_truth: 'Fixture body', timeline: '' };
      if (!page) return null;
      if (!pages.has(slug)) pages.set(slug, pages.size + 1);
      return { revision, sourceIncarnation: revision, tags: [], withdrawals: [], page: {
        id: pages.get(slug), slug, source_id: opts?.sourceId ?? 'default', title: slug,
        knowledge_revision: revision, text_projection_revision: revision, ...page,
      } };
    },
    ...overrides,
  };
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

export function embeddingUpdates(engine: BrainEngine) {
  return (engine as any)._calls.filter((call: any) => call.method === 'executeRaw'
    && /^UPDATE content_chunks SET/.test(call.args[0]));
}
