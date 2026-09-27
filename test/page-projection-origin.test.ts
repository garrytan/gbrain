import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { healOversizedPageChunks } from '../src/core/embed-oversize-heal.ts';
import { installPageEmbeddings, installPageProjection, PageProjectionConflictError,
  readProjectionSnapshot, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'projection-origin-test';
const body = Array.from({ length: 80 }, (_, i) => `Example sentence ${i} describes a repeatable indexing operation.`).join(' ');
const chunk = (text: string) => ({ chunk_index: 0, chunk_source: 'compiled_truth' as const, chunk_text: text });

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({});
  await lite.initSchema();
  engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    if (engine.kind === 'pglite') await engine.disconnect();
  }
  await closePostgres?.();
});

async function seed(engine: BrainEngine, slug: string, seal = true) {
  await engine.putPage(slug, { type: 'note', title: 'Example origin', compiled_truth: body }, { sourceId });
  if (seal) await installFixtureChunks(engine, slug, [chunk(body)], { sourceId });
}

async function embedCurrent(engine: BrainEngine, slug: string) {
  const prepared = (await readProjectionSnapshot(engine, slug, sourceId))!;
  const vector = new Float32Array(1536); vector[0] = 0.75;
  expect(await installPageEmbeddings(engine, prepared, prepared.chunks.map(c => ({
    chunk_index: c.chunk_index, chunk_source: c.chunk_source, chunk_text: c.chunk_text, embedding: vector,
  })))).toBe(true);
  return engine.getChunks(slug, { sourceId, includeEmbedding: true });
}

/** Intervene only after the actual capture transaction released its guard. */
function afterCapture(engine: BrainEngine, intervene: () => Promise<void>): BrainEngine {
  let first = true;
  return new Proxy(engine, {
    get(target, key) {
      if (key === 'transaction') return async <T>(run: (tx: BrainEngine) => Promise<T>) => {
        const result = await target.transaction(run);
        if (first) { first = false; await intervene(); }
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('a delayed unsealed projection cannot delete newer same-revision chunks and vectors', async () => {
  for (const engine of engines) {
    const slug = 'chunkless';
    await seed(engine, slug, false);
    expect(await readProjectionSnapshot(engine, slug, sourceId)).toBeNull();
    const origin = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
    expect(origin.chunks).toEqual([]);
    await installFixtureChunks(engine, slug, [chunk(body)], { sourceId });
    const current = await embedCurrent(engine, slug);
    await expect(installPageProjection(engine, origin, [chunk(body)], { seal: true })).rejects.toBeInstanceOf(PageProjectionConflictError);
    expect(await engine.getChunks(slug, { sourceId, includeEmbedding: true })).toEqual(current);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(origin.snapshot.revision);
  }
});

test('oversize healing rejects a newer chunk layout without counting it as healed', async () => {
  for (const engine of engines) {
    const slug = 'oversize-race';
    await seed(engine, slug);
    const revision = (await engine.readPageSnapshot(slug, { sourceId }))!.revision;
    let current: Awaited<ReturnType<BrainEngine['getChunks']>> = [];
    const raced = afterCapture(engine, async () => {
      expect((await healOversizedPageChunks(engine, slug, { sourceId, maxTokens: 80 })).changed).toBe(true);
      current = await embedCurrent(engine, slug);
    });
    let counted = 0;
    const result = await healOversizedPageChunks(raced, slug, { sourceId, maxTokens: 300, onSplit: n => { counted += n; } });
    expect(result.changed).toBe(false);
    expect(result.splitCount).toBe(0);
    expect(counted).toBe(0);
    expect(await engine.getChunks(slug, { sourceId, includeEmbedding: true })).toEqual(current);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(revision);
  }
});

test('oversize healing rejects an indexing-context change before changing any row', async () => {
  for (const engine of engines) {
    const slug = 'context-race';
    await seed(engine, slug);
    const before = await embedCurrent(engine, slug);
    const oldMode = await engine.getConfig('contextual_retrieval.mode');
    try {
      const raced = afterCapture(engine, () => engine.setConfig('contextual_retrieval.mode', oldMode === 'title' ? 'none' : 'title'));
      const result = await healOversizedPageChunks(raced, slug, { sourceId, maxTokens: 80 });
      expect(result.changed).toBe(false);
      expect(result.splitCount).toBe(0);
      expect(await engine.getChunks(slug, { sourceId, includeEmbedding: true })).toEqual(before);
      expect((await healOversizedPageChunks(engine, slug, { sourceId, maxTokens: 80 })).changed).toBe(true);
    } finally {
      if (oldMode !== null) await engine.setConfig('contextual_retrieval.mode', oldMode);
      else await engine.executeRaw("DELETE FROM config WHERE key='contextual_retrieval.mode'");
    }
  }
});

test('projection preparation freezes the effective chunk-token limit', async () => {
  for (const engine of engines) {
    const slug = 'token-limit';
    await seed(engine, slug, false);
    await withEnv({ GBRAIN_MAX_CHUNK_TOKENS: '300' }, async () => {
      const origin = (await readProjectionSnapshot(engine, slug, sourceId, { allowUnsealed: true }))!;
      expect(origin.maxChunkTokens).toBe(300);
      await withEnv({ GBRAIN_MAX_CHUNK_TOKENS: '80' }, async () => {
        await expect(installPageProjection(engine, origin, [chunk(body)], { seal: true })).rejects.toBeInstanceOf(PageProjectionConflictError);
        expect(await engine.getChunks(slug, { sourceId, includeUnsealed: true })).toEqual([]);
        expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.text_projection_revision).toBeNull();
      });
      await installPageProjection(engine, origin, [chunk(body)], { seal: true });
    });
  }
});

test('projection replacement preserves vector work completed after its capture', async () => {
  for (const engine of engines) {
    const slug = 'vector-completion';
    await seed(engine, slug);
    const origin = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const current = await embedCurrent(engine, slug);
    await expect(installPageProjection(engine, origin, [chunk(body)], { seal: true })).rejects.toBeInstanceOf(PageProjectionConflictError);
    expect(await engine.getChunks(slug, { sourceId, includeEmbedding: true })).toEqual(current);
  }
});

test('changing only the stored chunker version supersedes a prepared replacement', async () => {
  for (const engine of engines) {
    const slug = 'stored-chunker';
    await seed(engine, slug);
    const origin = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const before = await engine.getChunks(slug, { sourceId });
    await engine.executeRaw('UPDATE pages SET chunker_version=chunker_version+1 WHERE id=$1', [origin.snapshot.page.id]);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(origin.snapshot.revision);
    await expect(installPageProjection(engine, origin, [chunk(body)], { seal: true })).rejects.toBeInstanceOf(PageProjectionConflictError);
    expect(await engine.getChunks(slug, { sourceId })).toEqual(before);
  }
});

test('a column switch after context validation cannot redirect vectors into the new column', async () => {
  for (const engine of engines) {
    const oldColumn = await engine.getConfig('search_embedding_column');
    const oldRegistry = await engine.getConfig('embedding_columns');
    await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_origin_next vector(1536)');
    try {
      await engine.setConfig('embedding_columns', JSON.stringify({
        embedding_origin_next: { provider: 'openai:text-embedding-3-small', dimensions: 1536, type: 'vector' },
      }));
      for (const installation of ['embeddings', 'projection']) {
        await engine.setConfig('search_embedding_column', 'embedding');
        const slug = `column-${installation}`;
        await seed(engine, slug);
        const origin = (await readProjectionSnapshot(engine, slug, sourceId))!;
        let switched = false;
        const raced = new Proxy(engine, {
          get(target, key) {
            if (key === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => run(new Proxy(tx, {
              get(inner, prop) {
                if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => {
                  const result = await inner.executeRaw(sql, params);
                  // The validated config rows and descriptor have already been
                  // read; simulate a config writer before the first vector write.
                  if (!switched && sql === 'SELECT chunker_version,corpus_generation FROM pages WHERE id=$1') {
                    switched = true;
                    await inner.setConfig('search_embedding_column', 'embedding_origin_next');
                  }
                  return result;
                };
                const value = Reflect.get(inner, prop, inner);
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            })));
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const vector = new Float32Array(1536); vector[0] = 0.75;
        if (installation === 'embeddings') {
          expect(await installPageEmbeddings(raced, origin, [{ ...chunk(body), embedding: vector }])).toBe(true);
        } else {
          await installPageProjection(raced, origin, [{ ...chunk(body), embedding: vector }], { seal: true });
        }
        expect(switched).toBe(true);
        const [truth] = await engine.executeRaw<{ original_present: boolean; next_empty: boolean }>(`SELECT
          embedding IS NOT NULL AS original_present,embedding_origin_next IS NULL AS next_empty
          FROM content_chunks WHERE page_id=$1`, [origin.snapshot.page.id]);
        expect(truth).toEqual({ original_present: true, next_empty: true });
      }
    } finally {
      if (oldColumn === null) await engine.unsetConfig('search_embedding_column');
      else await engine.setConfig('search_embedding_column', oldColumn);
      if (oldRegistry === null) await engine.unsetConfig('embedding_columns');
      else await engine.setConfig('embedding_columns', oldRegistry);
      await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_origin_next');
    }
  }
});

test('a listed rebuild that another worker completed does not replace its projection again', async () => {
  for (const engine of engines) {
    const slug = 'completed-job';
    await seed(engine, slug, false);
    let intervened = false;
    let current: Awaited<ReturnType<BrainEngine['getChunks']>> = [];
    const raced = new Proxy(engine, {
      get(target, key) {
        if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          const result = await target.executeRaw(sql, params);
          if (!intervened && sql.startsWith('SELECT s.id AS source_id,j.source_incarnation')) {
            intervened = true;
            expect((await rebuildPendingPageProjections(engine, 100)).rebuilt).toBeGreaterThan(0);
            current = await embedCurrent(engine, slug);
          }
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await rebuildPendingPageProjections(raced, 100);
    expect(intervened).toBe(true);
    expect(result.rebuilt).toBe(0);
    expect(result.superseded).toBeGreaterThan(0);
    expect(await engine.getChunks(slug, { sourceId, includeEmbedding: true })).toEqual(current);
  }
});
