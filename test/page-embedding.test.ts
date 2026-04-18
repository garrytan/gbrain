import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { buildPageCentroid } from '../src/core/services/page-embedding.ts';

function makeVector(...values: number[]): Float32Array {
  const vector = new Float32Array(768);
  values.forEach((value, index) => {
    vector[index] = value;
  });
  return vector;
}

describe('buildPageCentroid', () => {
  test('averages chunk embeddings and ignores nulls', () => {
    const centroid = buildPageCentroid([
      new Float32Array([1, 0]),
      null,
      new Float32Array([0, 1]),
    ]);

    expect(Array.from(centroid!)).toEqual([0.5, 0.5]);
  });

  test('returns null when no vectors are usable', () => {
    expect(buildPageCentroid([null, null])).toBeNull();
  });
});

describe('SQLiteEngine page embeddings', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-page-embedding-sqlite-'));
  const databasePath = join(tempDir, 'brain.db');
  const engine = new SQLiteEngine();

  afterAll(async () => {
    await engine.disconnect();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('stores, filters, and clears page embeddings', async () => {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.putPage('people/alice.md', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Alice page',
    });
    await engine.putPage('companies/acme.md', {
      type: 'company',
      title: 'Acme',
      compiled_truth: 'Acme page',
    });

    await engine.updatePageEmbedding('people/alice.md', new Float32Array([0.25, 0.75]));
    await engine.updatePageEmbedding('companies/acme.md', null);

    expect(await engine.getPageEmbeddings('person')).toEqual([
      {
        page_id: expect.any(Number),
        slug: 'people/alice.md',
        embedding: new Float32Array([0.25, 0.75]),
      },
    ]);

    await engine.updatePageEmbedding('people/alice.md', null);

    expect(await engine.getPageEmbeddings()).toEqual([
      {
        page_id: expect.any(Number),
        slug: 'companies/acme.md',
        embedding: null,
      },
      {
        page_id: expect.any(Number),
        slug: 'people/alice.md',
        embedding: null,
      },
    ]);
  });

  test('recomputes page embeddings from persisted chunk state and clears them on delete', async () => {
    await engine.putPage('people/persisted-centroid.md', {
      type: 'person',
      title: 'Persisted Centroid',
      compiled_truth: 'Persisted centroid page',
    });

    await engine.upsertChunks('people/persisted-centroid.md', [
      {
        chunk_index: 0,
        chunk_text: 'kept chunk',
        chunk_source: 'compiled_truth',
        embedding: makeVector(1, 0),
      },
      {
        chunk_index: 1,
        chunk_text: 'deleted chunk',
        chunk_source: 'compiled_truth',
        embedding: makeVector(0, 1),
      },
    ]);

    expect(await engine.getPageEmbeddings('person')).toContainEqual({
      page_id: expect.any(Number),
      slug: 'people/persisted-centroid.md',
      embedding: makeVector(0.5, 0.5),
    });

    await engine.upsertChunks('people/persisted-centroid.md', [
      {
        chunk_index: 0,
        chunk_text: 'kept chunk',
        chunk_source: 'compiled_truth',
      },
    ]);

    expect(await engine.getPageEmbeddings('person')).toContainEqual({
      page_id: expect.any(Number),
      slug: 'people/persisted-centroid.md',
      embedding: makeVector(1, 0),
    });

    await engine.deleteChunks('people/persisted-centroid.md');

    expect(await engine.getPageEmbeddings('person')).toContainEqual({
      page_id: expect.any(Number),
      slug: 'people/persisted-centroid.md',
      embedding: null,
    });
  });
});

describe('PGLiteEngine page embeddings', () => {
  const engine = new PGLiteEngine();

  beforeAll(async () => {
    await engine.connect({});
    await engine.initSchema();
  });

  afterEach(async () => {
    for (const table of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
      await (engine as any).db.exec(`DELETE FROM ${table}`);
    }
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('stores and reads page embeddings', async () => {
    await engine.putPage('projects/apollo.md', {
      type: 'project',
      title: 'Apollo',
      compiled_truth: 'Apollo page',
    });

    const vector = makeVector(1, 2, 3);
    await engine.updatePageEmbedding('projects/apollo.md', vector);

    expect(await engine.getPageEmbeddings()).toEqual([
      {
        page_id: expect.any(Number),
        slug: 'projects/apollo.md',
        embedding: vector,
      },
    ]);
  });

  test('recomputes page embeddings from persisted chunk state and clears them on delete', async () => {
    await engine.putPage('projects/persisted-centroid.md', {
      type: 'project',
      title: 'Persisted Centroid',
      compiled_truth: 'Persisted centroid page',
    });

    await engine.upsertChunks('projects/persisted-centroid.md', [
      {
        chunk_index: 0,
        chunk_text: 'kept chunk',
        chunk_source: 'compiled_truth',
        embedding: makeVector(1, 0),
      },
      {
        chunk_index: 1,
        chunk_text: 'deleted chunk',
        chunk_source: 'compiled_truth',
        embedding: makeVector(0, 1),
      },
    ]);

    expect(await engine.getPageEmbeddings()).toEqual([
      {
        page_id: expect.any(Number),
        slug: 'projects/persisted-centroid.md',
        embedding: makeVector(0.5, 0.5),
      },
    ]);

    await engine.upsertChunks('projects/persisted-centroid.md', [
      {
        chunk_index: 0,
        chunk_text: 'kept chunk',
        chunk_source: 'compiled_truth',
      },
    ]);

    expect(await engine.getPageEmbeddings()).toEqual([
      {
        page_id: expect.any(Number),
        slug: 'projects/persisted-centroid.md',
        embedding: makeVector(1, 0),
      },
    ]);

    await engine.deleteChunks('projects/persisted-centroid.md');

    expect(await engine.getPageEmbeddings()).toEqual([
      {
        page_id: expect.any(Number),
        slug: 'projects/persisted-centroid.md',
        embedding: null,
      },
    ]);
  });
});

describe('PostgresEngine page embeddings', () => {
  test('serializes writes and maps reads through the backend-native vector shape', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const expectedLiteral = `[${Array.from(new Float32Array([0.1, 0.2, 0.3])).join(',')}]`;
    const sql: any = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = Array.from(strings).join('<??>');
      calls.push({ text, values });

      if (text.includes('UPDATE pages')) {
        return [{ id: 7 }];
      }

      if (text.includes('SELECT p.id AS page_id')) {
        return [{
          page_id: 7,
          slug: 'systems/compiler.md',
          embedding: expectedLiteral,
        }];
      }

      return [];
    };

    const engine = new PostgresEngine() as any;
    engine._sql = sql;

    await engine.updatePageEmbedding('systems/compiler.md', new Float32Array([0.1, 0.2, 0.3]));
    const embeddings = await engine.getPageEmbeddings('system');

    expect(embeddings).toEqual([
      {
        page_id: 7,
        slug: 'systems/compiler.md',
        embedding: new Float32Array([0.1, 0.2, 0.3]),
      },
    ]);
    expect(calls[0]?.text).toContain('UPDATE pages');
    expect(calls[0]?.text).toContain('SET page_embedding =');
    expect(calls[0]?.values).toEqual([expectedLiteral, 'systems/compiler.md']);
    expect(calls[1]?.text).toContain('SELECT p.id AS page_id');
    expect(calls[1]?.text).toContain('WHERE p.type =');
    expect(calls[1]?.values).toEqual(['system']);
  });
});
