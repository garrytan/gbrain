import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getEmbeddingModel } from '../src/core/ai/gateway.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { installPageEmbeddings, installPageProjection, PageProjectionConflictError, preparePageProjection,
  readProjectionSnapshot, rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const databaseUrl = process.env.DATABASE_URL;
const backends = testBackends();
const sourceId = 'projection-vector-test';
const neighborId = 'projection-vector-neighbor';
const slug = 'same-page';
const body = 'Synthetic cedar memory. UTF-8: café, 雪.';
const timeline = '2026-01-02: Synthetic event with exact provenance.';
const vector = new Float32Array(1536); vector[0] = 0.125; vector[1] = -0.25;
const vectorText = `[${Array.from(vector).join(',')}]`;
const preserve = { seal: true, preserveEmbeddings: true };

interface StoredChunk {
  id: number;
  chunk_index: number;
  embedding: string | null;
  embedded_text_hash: string | null;
  embedded_at: string | null;
  model: string;
  embedding_projection_test?: string | null;
}

for (const kind of backends) {
  describe(`projection vector preservation ${kind}`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(databaseUrl!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
      }
    }, 120_000);
    beforeEach(async () => {
      for (const id of [sourceId, neighborId]) await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [id]);
    });
    afterEach(async () => {
      for (const id of [sourceId, neighborId]) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
    });
    afterAll(async () => {
      if (kind === 'pglite') await engine.disconnect();
      await closePostgres?.();
    });

    async function storedChunks(source = sourceId) {
      const rows = await engine.executeRaw<{ chunk: StoredChunk }>(`SELECT to_jsonb(cc) AS chunk
        FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
        WHERE p.source_id=$1 AND p.slug=$2 ORDER BY cc.chunk_index`, [source, slug]);
      return rows.map(row => row.chunk);
    }
    async function canonicalState(source = sourceId) {
      return {
        page: await engine.executeRaw(`SELECT to_jsonb(p)-'text_projection_revision'-'search_vector'-'chunker_version' AS page
          FROM pages p WHERE p.source_id=$1 AND p.slug=$2`, [source, slug]),
        versions: await engine.executeRaw(`SELECT v.* FROM page_versions v JOIN pages p ON p.id=v.page_id
          WHERE p.source_id=$1 AND p.slug=$2 ORDER BY v.id`, [source, slug]),
        tags: await engine.getTags(slug, { sourceId: source }),
      };
    }
    async function capture() {
      const prepared = await readProjectionSnapshot(engine, slug, sourceId);
      expect(prepared).not.toBeNull();
      return { prepared: prepared!, chunks: (await preparePageProjection(prepared!)).chunks };
    }
    async function seed(source = sourceId) {
      await engine.putPage(slug, { type: 'note', title: 'Synthetic vector fixture', compiled_truth: body, timeline,
        frontmatter: { fixture: 'projection-vector' }, source_path: 'notes/synthetic.md' }, { sourceId: source });
      await engine.addTag(slug, 'preserved-tag', { sourceId: source });
      await engine.createVersion(slug, { sourceId: source });
      const prepared = (await readProjectionSnapshot(engine, slug, source, { allowUnsealed: true }))!;
      expect(prepared.embeddingModel).toBeString();
      const { chunks } = await preparePageProjection(prepared);
      expect(chunks.map(c => [c.chunk_index, c.chunk_source, c.chunk_text])).toEqual([
        [0, 'compiled_truth', body], [1, 'timeline', timeline],
      ]);
      await installPageProjection(engine, prepared, chunks, { seal: true });
      await engine.executeRaw(`UPDATE content_chunks SET embedding=$2::vector,model=$3,embedded_text_hash=NULL,
        embedded_at='2025-01-02T03:04:05Z' WHERE page_id=$1`, [prepared.snapshot.page.id, vectorText, prepared.embeddingModel]);
      const stored = await storedChunks(source);
      expect(stored).toHaveLength(2);
      for (const chunk of stored) {
        expect(chunk.embedding).toBe(vectorText);
        expect(chunk.embedded_text_hash).toBeNull();
        expect(chunk.embedded_at).toStartWith('2025-01-02T03:04:05');
      }
      return prepared.snapshot;
    }

    test('migration 153 queues real rebuilds without erasing legacy vectors or canonical state', async () => {
      const original = await seed();
      const sibling = await seed(neighborId);
      const before = await storedChunks(), neighbor = await storedChunks(neighborId);
      const canonical = await canonicalState(), neighborCanonical = await canonicalState(neighborId);
      expect(canonical.page).toMatchObject([{ page: { compiled_truth: body, timeline, knowledge_revision: original.revision } }]);
      expect(canonical.versions).toHaveLength(1);
      expect(canonical.tags).toEqual(['preserved-tag']);
      const migration = MIGRATIONS.find(m => m.version === 153)!;
      expect(migration.name).toBe('verified_text_projection_activation');
      await engine.transaction(tx => tx.runMigration(migration.version, migration.sql!));
      const jobs = await engine.executeRaw(`SELECT s.id AS source_id,j.slug,j.reason,j.revision FROM page_projection_jobs j
        JOIN sources s ON s.incarnation=j.source_incarnation ORDER BY s.id`);
      expect(jobs).toEqual([
        { source_id: neighborId, slug, reason: 'protocol_activation', revision: sibling.revision },
        { source_id: sourceId, slug, reason: 'protocol_activation', revision: original.revision },
      ]);
      expect(await rebuildPendingPageProjections(engine, 100)).toEqual({ rebuilt: 2, superseded: 0 });
      expect(await storedChunks()).toEqual(before);
      expect(await storedChunks(neighborId)).toEqual(neighbor);
      expect(await canonicalState()).toEqual(canonical);
      expect(await canonicalState(neighborId)).toEqual(neighborCanonical);
      const current = (await engine.readPageSnapshot(slug, { sourceId }))!;
      expect(current.revision).toBe(original.revision);
      expect(current.page.text_projection_revision).toBe(original.revision);
      expect(await engine.executeRaw('SELECT * FROM page_projection_jobs')).toEqual([]);
    });

    test('invalidating one source cannot erase a same-slug neighbor vector', async () => {
      const page = await seed();
      await seed(neighborId);
      const neighbor = await storedChunks(neighborId), canonical = await canonicalState(neighborId);
      await engine.executeRaw("UPDATE content_chunks SET embedded_text_hash='stale' WHERE page_id=$1", [page.page.id]);
      const { prepared, chunks } = await capture();
      await installPageProjection(engine, prepared, chunks, preserve);
      expect((await storedChunks()).map(c => c.embedding)).toEqual([null, null]);
      expect(await storedChunks(neighborId)).toEqual(neighbor);
      expect(await canonicalState(neighborId)).toEqual(canonical);
    });

    for (const state of [
      { name: 'NULL hash', hash: null, model: 'current', context: null, keep: true },
      { name: 'current hash', hash: 'current', model: 'current', context: 'none', keep: true },
      { name: 'stale hash', hash: 'stale', model: 'current', context: null, keep: false },
      { name: 'empty hash', hash: '', model: 'current', context: null, keep: false },
      { name: 'malformed hash', hash: "'); DROP TABLE pages; --", model: 'current', context: null, keep: false },
      { name: 'wrong model', hash: null, model: 'openai:wrong', context: null, keep: false },
      { name: 'title context', hash: null, model: 'current', context: 'title', keep: false },
      { name: 'synopsis context', hash: null, model: 'current', context: 'per_chunk_synopsis', keep: false },
      { name: 'malformed context', hash: null, model: 'current', context: 'invalid', keep: false },
    ]) test(`only compatible rows retain vectors: ${state.name}`, async () => {
      const page = await seed();
      await engine.executeRaw(`UPDATE content_chunks SET model=$2,
        embedded_text_hash=CASE WHEN $3='current' THEN md5(chunk_text) ELSE $3 END WHERE page_id=$1`,
      [page.page.id, state.model === 'current' ? getEmbeddingModel() : state.model, state.hash]);
      await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=$2 WHERE id=$1', [page.page.id, state.context]);
      const before = await storedChunks();
      const { prepared, chunks } = await capture();
      await installPageProjection(engine, prepared, chunks, preserve);
      const after = await storedChunks();
      expect(after).toHaveLength(2);
      expect(after.map(c => c.id)).toEqual(before.map(c => c.id));
      if (state.keep) expect(after).toEqual(before);
      else for (const chunk of after) expect([chunk.embedding, chunk.embedded_text_hash, chunk.embedded_at]).toEqual([null, null, null]);
    });

    const metadataChanges: Partial<ChunkInput>[] = [
      { language: 'typescript' }, { symbol_name: 'changed' }, { symbol_type: 'function' },
      { start_line: 2 }, { end_line: 3 }, { parent_symbol_path: ['changed'] },
      { doc_comment: 'changed' }, { symbol_name_qualified: 'Changed.symbol' }, { modality: 'image' },
      { chunk_source: 'timeline' }, { chunk_text: 'Changed text' },
    ];
    for (const change of metadataChanges) test(`changed ${Object.keys(change)[0]} cannot inherit a legacy vector`, async () => {
      await seed();
      const { prepared, chunks } = await capture();
      const before = await storedChunks();
      await installPageProjection(engine, prepared, [{ ...chunks[0], ...change }, chunks[1]], preserve);
      const after = await storedChunks();
      expect(after).toHaveLength(2);
      expect(after[0].id).not.toBe(before[0].id);
      expect(after[0].embedding).toBeNull();
      expect(after[1]).toEqual(before[1]);
    });

    test('changed chunk_index cannot inherit a legacy vector', async () => {
      await seed();
      const { prepared, chunks } = await capture();
      const before = await storedChunks();
      await installPageProjection(engine, prepared, [{ ...chunks[0], chunk_index: 2 }, chunks[1]], preserve);
      const after = await storedChunks();
      expect(after).toHaveLength(2);
      expect(after.map(c => c.chunk_index)).toEqual([1, 2]);
      expect(after[0]).toEqual(before[1]);
      expect(before.map(c => c.id)).not.toContain(after[1].id);
      expect(after[1]).toMatchObject({ chunk_text: body, embedding: null, embedded_text_hash: null, embedded_at: null });
    });

    for (const type of ['vector', 'halfvec']) for (const mismatch of ['none', 'hash', 'model']) {
      test(`custom ${type} column retains only compatible vectors: ${mismatch}`, async () => {
        const page = await seed();
        await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN embedding_projection_test ${type}(3)`);
        try {
          await engine.setConfig('embedding_columns', JSON.stringify({
            embedding_projection_test: { provider: 'openai:fixture', dimensions: 3, type },
          }));
          await engine.setConfig('search_embedding_column', 'embedding_projection_test');
          await engine.executeRaw(`UPDATE content_chunks SET embedding_projection_test='[0.375,-0.25,0]'::${type}(3),
            embedded_text_hash=$2,model=$3 WHERE page_id=$1`,
          [page.page.id, mismatch === 'hash' ? 'stale' : null, mismatch === 'model' ? 'openai:wrong' : 'openai:fixture']);
          const before = await storedChunks();
          expect(before.map(c => c.embedding_projection_test)).toEqual(['[0.375,-0.25,0]', '[0.375,-0.25,0]']);
          const { prepared, chunks } = await capture();
          await installPageProjection(engine, prepared, chunks, preserve);
          const after = await storedChunks();
          expect(after).toHaveLength(2);
          expect(after.map(c => c.embedding)).toEqual(before.map(c => c.embedding));
          if (mismatch === 'none') expect(after).toEqual(before);
          else for (const chunk of after) expect([chunk.embedding_projection_test, chunk.embedded_at, chunk.embedded_text_hash]).toEqual([null, null, null]);
        } finally {
          await engine.unsetConfig('search_embedding_column');
          await engine.unsetConfig('embedding_columns');
          await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_projection_test');
        }
      });
    }

    test('a newer embedding completion rejects a stale rebuild without changing its rows', async () => {
      await seed();
      const { prepared, chunks } = await capture();
      const newer = new Float32Array(1536); newer[0] = 0.875;
      expect(await installPageEmbeddings(engine, prepared, chunks.map(c => ({ ...c, embedding: newer })))).toBe(true);
      const before = await storedChunks();
      expect(before.map(c => c.embedding)).toEqual([`[${Array.from(newer).join(',')}]`, `[${Array.from(newer).join(',')}]`]);
      await expect(installPageProjection(engine, prepared, chunks, preserve)).rejects.toBeInstanceOf(PageProjectionConflictError);
      expect(await storedChunks()).toEqual(before);
    });

    test('a newer vector-only update survives even when completion metadata is unchanged', async () => {
      const page = await seed();
      const { prepared, chunks } = await capture();
      const newer = new Float32Array(1536); newer[0] = 0.625;
      await engine.executeRaw('UPDATE content_chunks SET embedding=$2::vector WHERE page_id=$1', [page.page.id, `[${Array.from(newer).join(',')}]`]);
      const before = await storedChunks();
      await installPageProjection(engine, prepared, chunks, preserve);
      expect(await storedChunks()).toEqual(before);
    });

    for (const malformed of ['duplicate index', 'invalid dimensions', 'NULL text']) test(`malformed ${malformed} rolls back the entire replacement`, async () => {
      await seed();
      const { prepared, chunks } = await capture();
      if (malformed === 'duplicate index') chunks.push({ ...chunks[0] });
      if (malformed === 'invalid dimensions') chunks[0].embedding = new Float32Array(2);
      if (malformed === 'NULL text') chunks[0].chunk_text = null as unknown as string;
      const before = await storedChunks(), canonical = await canonicalState();
      await expect(installPageProjection(engine, prepared, chunks, preserve)).rejects.toThrow();
      expect(await storedChunks()).toEqual(before);
      expect(await canonicalState()).toEqual(canonical);
    });

    if (kind === 'postgres') test('a concurrent embedding transaction wins after the rebuild actually waits on its lock', async () => {
      await seed();
      const { prepared, chunks } = await capture();
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const newer = new Float32Array(1536); newer[0] = 0.9375;
      const writer = engine.transaction(async tx => {
        expect(await installPageEmbeddings(tx, prepared, chunks.map(c => ({ ...c, embedding: newer })))).toBe(true);
        entered();
        await held;
      });
      let rebuild: Promise<unknown> | undefined;
      try {
        await Promise.race([ready, writer]);
        rebuild = installPageProjection(engine, prepared, chunks, preserve).then(() => null, error => error);
        let blocked = 0;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          const [row] = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`);
          blocked = row.count;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(blocked).toBeGreaterThan(0);
        release();
        await writer;
        expect(await rebuild).toBeInstanceOf(PageProjectionConflictError);
        const after = await storedChunks();
        expect(after).toHaveLength(2);
        expect(after.map(c => c.embedding)).toEqual([`[${Array.from(newer).join(',')}]`, `[${Array.from(newer).join(',')}]`]);
      } finally {
        release();
        await writer;
        await rebuild;
      }
    });
  });
}
