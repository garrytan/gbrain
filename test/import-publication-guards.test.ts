import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, type ImportEmbeddingResult } from '../src/core/import-file.ts';
import { contentHashLegacy } from '../src/core/utils.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'default';
const content = (body: string, tag = 'original') => `---\ntitle: Import example\ntype: note\ntags: [${tag}]\n---\n\n${body}`;

beforeAll(async () => {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  engines.push(engine);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines.filter(candidate => candidate.kind === 'pglite')) await engine.disconnect();
  await closePostgres?.();
});
afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

async function state(engine: BrainEngine, slug: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  return {
    snapshot,
    chunks: await engine.getChunks(slug, { sourceId, includeUnsealed: true }),
    versions: await engine.executeRaw('SELECT * FROM page_versions WHERE page_id=$1 ORDER BY id', [snapshot!.page.id]),
  };
}

test('beforeCommit rejection rolls back page revision, tags, chunks and version', async () => {
  for (const engine of engines) {
    const slug = 'merge-import/rollback';
    await importFromContent(engine, slug, content('Original content.'), { noEmbed: true, sourceId });
    const before = await state(engine, slug);
    let observedNewRevision = false;
    await expect(importFromContent(engine, slug, content('Replacement content.', 'replacement'), {
      noEmbed: true, sourceId,
      beforeCommit: async tx => {
        const current = (await tx.readPageSnapshot(slug, { sourceId }))!;
        observedNewRevision = current.revision !== before.snapshot!.revision;
        expect(current.page.compiled_truth).toBe('Replacement content.');
        expect(current.tags).toContain('replacement');
        throw new Error('fixture publication rejected');
      },
    })).rejects.toThrow('fixture publication rejected');
    expect(observedNewRevision).toBe(true);
    expect(await state(engine, slug)).toEqual(before);
  }
});

for (const legacy of [false, true]) {
  test(`unchanged path repair and callback are atomic (legacy hash=${legacy})`, async () => {
    for (const engine of engines) {
      const slug = `merge-import/path-${legacy}`;
      const body = content('Unchanged content.');
      await importFromContent(engine, slug, body, { noEmbed: true, sourceId, sourcePath: 'old.md' });
      if (legacy) {
        const page = (await engine.getPage(slug, { sourceId }))!;
        await engine.executeRaw('UPDATE pages SET content_hash=$1 WHERE id=$2', [contentHashLegacy(page), page.id]);
      }
      const before = await state(engine, slug);
      await expect(importFromContent(engine, slug, body, {
        noEmbed: true, sourceId, sourcePath: 'current.md',
        beforeCommit: async tx => {
          expect((await tx.getPage(slug, { sourceId }))!.source_path).toBe('current.md');
          throw new Error('fixture path publication rejected');
        },
      })).rejects.toThrow('fixture path publication rejected');
      expect(await state(engine, slug)).toEqual(before);
      expect((await importFromContent(engine, slug, body, { noEmbed: true, sourceId, sourcePath: 'current.md' })).status).toBe('skipped');
      const after = await state(engine, slug);
      expect(after.snapshot!.page.source_path).toBe('current.md');
      expect(after.snapshot!.revision).toBe(before.snapshot!.revision);
      expect(after.chunks).toEqual(before.chunks);
      expect(after.versions).toEqual(before.versions);
    }
  });
}

test('optional legacy path repair rolls back its SQL error without aborting publication', async () => {
  for (const engine of engines) {
    const slug = 'merge-import/repair-savepoint';
    const body = content('A legacy path can be repaired later.');
    await importFromContent(engine, slug, body, { noEmbed: true, sourceId, sourcePath: 'old.md' });
    const before = await state(engine, slug);
    const executeRaw = engine.executeRaw;
    let rejected = false;
    let callbackRan = false;
    engine.executeRaw = function<T>(sql: string, params?: unknown[]): Promise<T[]> {
      if (sql.startsWith('UPDATE pages SET source_path = $1')) {
        rejected = true;
        return executeRaw.call(this, 'SELECT missing_fixture_column FROM pages') as Promise<T[]>;
      }
      return executeRaw.call(this, sql, params) as Promise<T[]>;
    };
    try {
      const result = await importFromContent(engine, slug, body, {
        noEmbed: true, sourceId, sourcePath: 'current.md',
        beforeCommit: async tx => {
          expect((await tx.getPage(slug, { sourceId }))!.source_path).toBe('old.md');
          callbackRan = true;
        },
      });
      expect(result.status).toBe('skipped');
      expect(rejected).toBe(true);
      expect(callbackRan).toBe(true);
      expect(await state(engine, slug)).toEqual(before);
    } finally {
      engine.executeRaw = executeRaw;
    }
  }
});

for (const intervening of ['none', 'page', 'chunks', 'indexing-context'] as const) {
  test(`postcommit embedding uses the complete captured projection (intervening=${intervening})`, async () => {
    for (const engine of engines) {
      const slug = `merge-import/embed-${intervening}`;
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
      let complete: (() => Promise<ImportEmbeddingResult>) | undefined;
      let providerCalls = 0;
      __setEmbedTransportForTests(async ({ values }) => {
        providerCalls++;
        return { values, warnings: [], embeddings: values.map(() => new Array(1536).fill(0.1)), usage: { tokens: 1 } };
      });
      const imported = await importFromContent(engine, slug, content('A complete captured projection.'), {
        sourceId, onPostCommitEmbedding: callback => { complete = callback; },
      });
      expect(imported.status).toBe('imported');
      expect(complete).toBeDefined();
      expect(providerCalls).toBe(0);
      const before = await state(engine, slug);
      expect(before.chunks.every(chunk => chunk.embedding_is_null)).toBe(true);
      const previousMode = await engine.getConfig('contextual_retrieval.mode');
      try {
        if (intervening === 'page') {
          await importFromContent(engine, slug, content('Newer canonical content.'), { noEmbed: true, sourceId });
        } else if (intervening === 'chunks') {
          // Preserve the old minimum chunk ID and page revision while changing
          // projection membership. The upstream MIN(id) check misses this race.
          await engine.transaction(async tx => {
            await tx.lockPageKeys([{ sourceId, slug }]);
            await tx.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text,chunk_source)
              VALUES ($1,100,'A later derived fragment.','compiled_truth')`, [before.snapshot!.page.id]);
          });
        } else if (intervening === 'indexing-context') {
          await engine.setConfig('contextual_retrieval.mode', previousMode === 'title' ? 'none' : 'title');
        }
        const expected = await state(engine, slug);
        expect(await complete!()).toEqual({ status: intervening === 'none' ? 'embedded' : 'superseded' });
        expect(providerCalls).toBe(1);
        const after = await state(engine, slug);
        expect(after.snapshot!.revision).toBe(expected.snapshot!.revision);
        expect(after.snapshot!.page.compiled_truth).toBe(expected.snapshot!.page.compiled_truth);
        expect(after.chunks.map(chunk => [chunk.id, chunk.chunk_index, chunk.chunk_text])).toEqual(
          expected.chunks.map(chunk => [chunk.id, chunk.chunk_index, chunk.chunk_text]));
        expect(after.chunks.every(chunk => chunk.embedding_is_null)).toBe(intervening !== 'none');
      } finally {
        if (previousMode === null) await engine.executeRaw("DELETE FROM config WHERE key='contextual_retrieval.mode'");
        else await engine.setConfig('contextual_retrieval.mode', previousMode);
      }
    }
  });
}
