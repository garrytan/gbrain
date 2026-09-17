import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { embedStaleForSource, embedStalePages } from '../src/core/embed-stale.ts';
import { reembedPageWithContextualRetrieval } from '../src/core/contextual-retrieval-service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const dimensions = 1536;
const signature = 'openai:text-embedding-3-large:1536';
let contextualRun = false;
let transactionDepth = 0;
let beforeEmbedReturn: (() => Promise<void>) | undefined;
let providerCalls = 0;
const vector = (value: number) => { const result = new Float32Array(dimensions); result[0] = value; return result; };

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dimensions,
    env: { OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
    providerCalls++;
    expect(transactionDepth).toBe(0);
    const value = contextualRun ? 0.75 : 0.25;
    const intervene = beforeEmbedReturn;
    beforeEmbedReturn = undefined;
    await intervene?.();
    return { embeddings: values.map(() => Array.from(vector(value))), usage: { tokens: 0 } } as never;
  });
  __setChatTransportForTests(async () => {
    providerCalls++;
    expect(transactionDepth).toBe(0);
    return { text: 'Fresh contextual synopsis for this example page.', blocks: [], stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-4.1-mini', providerId: 'openai' };
  });
  const lite = new PGLiteEngine();
  await lite.connect({});
  await lite.initSchema();
  engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  __setChatTransportForTests(null);
  resetGateway();
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

/** Run the competing real service only after the vector-writing transaction commits. */
function afterVectorCommit(engine: BrainEngine, intervene: () => Promise<void>): BrainEngine {
  let intervened = false;
  function observe(tx: BrainEngine, wrote: () => void): BrainEngine {
    return new Proxy(tx, {
      get(target, key) {
        if (key === 'transaction') return <T>(run: (inner: BrainEngine) => Promise<T>) =>
          target.transaction(inner => run(observe(inner, wrote)));
        if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          const result = await target.executeRaw(sql, params);
          if (sql.startsWith('UPDATE content_chunks SET')) wrote();
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  return new Proxy(engine, {
    get(target, key) {
      if (key === 'transaction') return async <T>(run: (tx: BrainEngine) => Promise<T>) => {
        let wrote = false;
        const result = await target.transaction(async tx => {
          transactionDepth++;
          try { return await run(observe(tx, () => { wrote = true; })); }
          finally { transactionDepth--; }
        });
        if (wrote && !intervened) {
          intervened = true;
          await intervene();
        }
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const paths = ['single-page', 'all-pages', 'stale-cli', 'explicit-pages', 'stale-source'] as const;
for (const path of paths) {
  test(`${path}: a later contextual service keeps its vectors, mode and generation together`, async () => {
    for (const engine of engines) {
      const sourceId = `completion-${path}`;
      const slug = 'example';
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      try {
        await engine.putPage(slug, { type: 'note', title: 'Example context', compiled_truth: 'Example searchable text.' }, { sourceId });
        await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: 'Example searchable text.', chunk_source: 'compiled_truth' }], { sourceId });
        await engine.updatePageContextualRetrievalState(slug, sourceId, 'per_chunk_synopsis', 'original-context');
        const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
        let newerGeneration: string | undefined;
        const raced = afterVectorCommit(engine, async () => {
          contextualRun = true;
          try {
            const result = await reembedPageWithContextualRetrieval({ engine, pageSlug: slug, sourceId,
              globalMode: 'per_chunk_synopsis', synopsisModel: 'openai:gpt-4.1-mini' });
            expect(result.kind).toBe('success');
            if (result.kind === 'success') {
              expect(result.mode_applied).toBe('per_chunk_synopsis');
              newerGeneration = result.corpus_generation;
            }
          } finally { contextualRun = false; }
        });

        if (path === 'explicit-pages') {
          expect((await embedStalePages(raced, [slug], sourceId, { embeddingSignature: signature })).embedded).toBe(1);
        } else if (path === 'stale-source') {
          expect((await embedStaleForSource(raced, sourceId, { embeddingSignature: signature, concurrency: 1 })).embedded).toBe(1);
        } else {
          const result = await runEmbedCore(raced, { sourceId, quiet: true,
            ...(path === 'single-page' ? { slugs: [slug] } : path === 'all-pages' ? { all: true } : { stale: true }) });
          expect(result.failures).toBe(0);
          expect(result.embedded).toBe(1);
        }

        expect(newerGeneration).toBeDefined();
        const after = (await engine.readPageSnapshot(slug, { sourceId }))!;
        expect(after.revision).toBe(before.revision);
        expect(after.page.contextual_retrieval_mode).toBe('per_chunk_synopsis');
        const [state] = await engine.executeRaw<{ corpus_generation: string }>('SELECT corpus_generation FROM pages WHERE id=$1', [after.page.id]);
        expect(state.corpus_generation).toBe(newerGeneration!);
        expect(after.page.text_projection_revision).toBe(after.revision);
        const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
        expect(chunks).toHaveLength(1);
        expect(chunks[0].embedding?.[0]).toBe(0.75);
        expect(chunks[0].model).toBe('openai:text-embedding-3-large');
        expect((await engine.searchKeyword('searchable', { sourceId })).map(row => row.slug)).toContain(slug);
      } finally {
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      }
    }
  }, 30_000);
}

async function withPage(sourceId: string, run: (engine: BrainEngine, slug: string) => Promise<void>) {
  for (const engine of engines) {
    const slug = 'example';
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    try {
      await engine.putPage(slug, { type: 'note', title: 'Example context', compiled_truth: 'Original searchable evidence. Further searchable evidence.' }, { sourceId });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: 'Original searchable evidence. Further searchable evidence.',
        chunk_source: 'compiled_truth', model: 'old:model' }], { sourceId });
      await engine.updatePageContextualRetrievalState(slug, sourceId, 'per_chunk_synopsis', 'original-context');
      await run(engine, slug);
    } finally {
      beforeEmbedReturn = undefined;
      contextualRun = false;
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    }
  }
}

async function contextState(engine: BrainEngine, slug: string, sourceId: string) {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const [state] = await engine.executeRaw<{ corpus_generation: string }>('SELECT corpus_generation FROM pages WHERE id=$1', [snapshot.page.id]);
  return { revision: snapshot.revision, seal: snapshot.page.text_projection_revision,
    mode: snapshot.page.contextual_retrieval_mode, generation: state.corpus_generation };
}

test('a newer same-mode contextual generation during the provider call supersedes an older plain embed', async () => {
  const sourceId = 'completion-provider-generation';
  await withPage(sourceId, async (engine, slug) => {
    const before = await contextState(engine, slug, sourceId);
    let newer: Awaited<ReturnType<typeof contextState>> | undefined;
    beforeEmbedReturn = async () => {
      contextualRun = true;
      try {
        const result = await reembedPageWithContextualRetrieval({ engine: afterVectorCommit(engine, async () => {}),
          pageSlug: slug, sourceId, globalMode: 'per_chunk_synopsis', synopsisModel: 'openai:gpt-4.1-mini' });
        expect(result.kind).toBe('success');
        newer = await contextState(engine, slug, sourceId);
        expect(newer.mode).toBe(before.mode);
        expect(newer.generation).not.toBe(before.generation);
        expect(newer.revision).toBe(before.revision);
      } finally { contextualRun = false; }
    };
    const result = await embedStalePages(afterVectorCommit(engine, async () => {}), [slug], sourceId, { embeddingSignature: signature });
    expect(result.embedded).toBe(0);
    expect(await contextState(engine, slug, sourceId)).toEqual(newer!);
    const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].embedding?.[0]).toBe(0.75);
    expect(chunks[0].model).toBe('openai:text-embedding-3-large');
    expect(newer!.seal).toBe(newer!.revision);
    expect((await engine.searchKeyword('searchable', { sourceId })).map(row => row.slug)).toContain(slug);
  });
}, 30_000);

for (const mutation of ['canonical-edit', 'same-revision-rechunk'] as const) {
  test(`contextual service refuses ${mutation} completed during its provider call`, async () => {
    const sourceId = `contextual-provider-${mutation}`;
    await withPage(sourceId, async (engine, slug) => {
      const before = await contextState(engine, slug, sourceId);
      let installed: Awaited<ReturnType<BrainEngine['getChunks']>> = [];
      let newer: Awaited<ReturnType<typeof contextState>> | undefined;
      beforeEmbedReturn = async () => {
        const texts = mutation === 'canonical-edit' ? ['New searchable canonical evidence.']
          : ['Original searchable evidence.', 'Further searchable evidence.'];
        if (mutation === 'canonical-edit') {
          await engine.putPage(slug, { type: 'note', title: 'New example context', compiled_truth: texts[0] },
            { sourceId, expectedRevision: before.revision });
        }
        await installFixtureChunks(engine, slug, texts.map((text, i) => ({ chunk_index: i, chunk_text: text,
          chunk_source: 'compiled_truth', embedding: vector(0.875), model: 'openai:text-embedding-3-large' })), { sourceId });
        installed = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
        newer = await contextState(engine, slug, sourceId);
        expect(newer.revision === before.revision).toBe(mutation === 'same-revision-rechunk');
        // Keep mode/generation fixed so the same-revision case specifically
        // proves the originating chunk-set guard, independently of context CAS.
        expect(newer.generation).toBe(before.generation);
      };
      const result = await reembedPageWithContextualRetrieval({ engine: afterVectorCommit(engine, async () => {}),
        pageSlug: slug, sourceId, globalMode: 'per_chunk_synopsis', synopsisModel: 'openai:gpt-4.1-mini' });
      expect(result).toMatchObject({ kind: 'transient_error', cause: 'db' });
      expect(await engine.getChunks(slug, { sourceId, includeEmbedding: true })).toEqual(installed);
      expect(await contextState(engine, slug, sourceId)).toEqual(newer!);
      expect(newer!.seal).toBe(newer!.revision);
      expect((await engine.searchKeyword('searchable', { sourceId })).map(row => row.slug)).toContain(slug);
    });
  }, 30_000);
}

test('a source contextual-policy change supersedes provider work without relabeling old vectors', async () => {
  const sourceId = 'contextual-provider-policy';
  await withPage(sourceId, async (engine, slug) => {
    const before = await contextState(engine, slug, sourceId);
    const chunks = await engine.getChunks(slug, { sourceId, includeEmbedding: true });
    beforeEmbedReturn = () => engine.executeRaw("UPDATE sources SET contextual_retrieval_mode='none' WHERE id=$1", [sourceId]).then(() => {});
    const result = await reembedPageWithContextualRetrieval({ engine: afterVectorCommit(engine, async () => {}),
      pageSlug: slug, sourceId, globalMode: 'per_chunk_synopsis', synopsisModel: 'openai:gpt-4.1-mini' });
    expect(result).toMatchObject({ kind: 'transient_error', cause: 'db' });
    expect(await engine.getChunks(slug, { sourceId, includeEmbedding: true })).toEqual(chunks);
    expect(await contextState(engine, slug, sourceId)).toEqual(before);
  });
}, 30_000);

test('unsealed nonempty chunks never reach contextual providers', async () => {
  const sourceId = 'contextual-unsealed';
  await withPage(sourceId, async (engine, slug) => {
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
    const before = await contextState(engine, slug, sourceId);
    beforeEmbedReturn = async () => { throw new Error('Unsealed chunks reached the embedding provider'); };
    const callsBefore = providerCalls;
    const result = await reembedPageWithContextualRetrieval({ engine: afterVectorCommit(engine, async () => {}),
      pageSlug: slug, sourceId, globalMode: 'per_chunk_synopsis', synopsisModel: 'openai:gpt-4.1-mini' });
    expect(result).toMatchObject({ kind: 'transient_error', cause: 'db' });
    expect(beforeEmbedReturn).toBeDefined();
    expect(providerCalls).toBe(callsBefore);
    expect(await contextState(engine, slug, sourceId)).toEqual(before);
  });
}, 30_000);

for (const mode of ['none', 'title'] as const) {
  test(`${mode}: metadata-only contextual completion cannot stamp a replaced empty snapshot`, async () => {
    const sourceId = `contextual-empty-${mode}`;
    await withPage(sourceId, async (engine, slug) => {
      await engine.deleteChunks(slug, { sourceId });
      const before = await contextState(engine, slug, sourceId);
      let intervened = false;
      let newer: Awaited<ReturnType<typeof contextState>> | undefined;
      const raced = new Proxy(engine, {
        get(target, key) {
          if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
            const result = await target.executeRaw(sql, params);
            if (!intervened && sql.includes('FROM sources WHERE id = $1')) {
              intervened = true;
              await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: 'Original searchable evidence. Further searchable evidence.',
                chunk_source: 'compiled_truth', embedding: vector(0.875) }], { sourceId });
              newer = await contextState(engine, slug, sourceId);
            }
            return result;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      beforeEmbedReturn = async () => { throw new Error('Metadata-only completion reached a provider'); };
      const callsBefore = providerCalls;
      expect(await reembedPageWithContextualRetrieval({ engine: raced, pageSlug: slug, sourceId, globalMode: mode }))
        .toMatchObject({ kind: 'transient_error', cause: 'db' });
      expect(intervened).toBe(true);
      expect(beforeEmbedReturn).toBeDefined();
      expect(providerCalls).toBe(callsBefore);
      expect(await contextState(engine, slug, sourceId)).toEqual(newer!);
      expect(newer!.revision).toBe(before.revision);
      expect((await engine.getChunks(slug, { sourceId, includeEmbedding: true }))[0].embedding?.[0]).toBe(0.875);
    });
  }, 30_000);
}
