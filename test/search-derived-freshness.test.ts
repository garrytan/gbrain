import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

let pglite: PGLiteEngine;
let sqlite: SQLiteEngine;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();

  sqlite = new SQLiteEngine();
  await sqlite.connect({ engine: 'sqlite', database_path: ':memory:' });
  await sqlite.initSchema();
});

afterAll(async () => {
  await pglite.disconnect();
  await sqlite.disconnect();
});

async function clearEngine(engine: PGLiteEngine | SQLiteEngine): Promise<void> {
  if (engine instanceof PGLiteEngine) {
    await (engine as any).db.exec(`
      DELETE FROM derived_jobs;
      DELETE FROM derived_index_state;
      DELETE FROM content_chunks;
      DELETE FROM note_section_entries;
      DELETE FROM note_manifest_entries;
      DELETE FROM pages;
    `);
    return;
  }

  (engine as any).database.exec(`
    DELETE FROM derived_jobs;
    DELETE FROM derived_index_state;
    DELETE FROM content_chunks;
    DELETE FROM note_section_entries;
    DELETE FROM note_manifest_entries;
    DELETE FROM pages;
  `);
}

async function seedPendingDerivedPage(engine: PGLiteEngine | SQLiteEngine): Promise<void> {
  await importFromContent(engine, 'concepts/pending-search', [
    '---',
    'type: concept',
    'title: Pending Search',
    '---',
    '# Compiled Truth',
    'Quasar pending freshness should still be discoverable from the canonical page.',
    '',
    '---',
    '',
    '- **2026-05-14** | Quasar pending timeline evidence.',
  ].join('\n'), {
    path: 'concepts/pending-search.md',
    deferDerived: true,
  });
}

async function seedTypedPendingDerivedPage(
  engine: PGLiteEngine | SQLiteEngine,
  slug: string,
  type: 'concept' | 'person',
  title: string,
): Promise<void> {
  await importFromContent(engine, slug, [
    '---',
    `type: ${type}`,
    `title: ${title}`,
    '---',
    '# Compiled Truth',
    `${title} has pending page chunks.`,
  ].join('\n'), {
    path: `${slug}.md`,
    deferDerived: true,
  });
}

describe('search derived freshness semantics', () => {
  beforeEach(async () => {
    await clearEngine(pglite);
    await clearEngine(sqlite);
  });

  test('PGLite keyword search returns canonical page-level matches while page chunks are pending', async () => {
    await seedPendingDerivedPage(pglite);

    const results = await pglite.searchKeyword('Quasar pending freshness', { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: 'concepts/pending-search',
      chunk_source: 'compiled_truth',
      derived_artifact_kind: 'page_chunks',
      derived_status: 'pending',
    });
    expect(results[0]!.derived_warning).toContain('page_chunks derived index is pending');
  });

  test('SQLite keyword search reports the same pending derived freshness metadata', async () => {
    await seedPendingDerivedPage(sqlite);

    const results = await sqlite.searchKeyword('Quasar pending freshness', { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: 'concepts/pending-search',
      chunk_source: 'compiled_truth',
      derived_artifact_kind: 'page_chunks',
      derived_status: 'pending',
    });
    expect(results[0]!.derived_warning).toContain('page_chunks derived index is pending');
  });

  test('PGLite keyword fallback returns a bounded canonical snippet around the match', async () => {
    await importFromContent(pglite, 'concepts/pending-large-search', [
      '---',
      'type: concept',
      'title: Pending Large Search',
      '---',
      '# Compiled Truth',
      `${'background filler '.repeat(900)}QuasarNeedle pending canonical evidence.`,
    ].join('\n'), {
      path: 'concepts/pending-large-search.md',
      deferDerived: true,
    });

    const results = await pglite.searchKeyword('QuasarNeedle', { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]!.chunk_text.length).toBeLessThanOrEqual(360);
    expect(results[0]!.chunk_text).toContain('QuasarNeedle');
    expect(results[0]!.derived_status).toBe('pending');
  });

  test('PGLite vector search discloses pending page_chunks instead of returning empty', async () => {
    await seedPendingDerivedPage(pglite);

    const results = await pglite.searchVector(new Float32Array(768), { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: 'concepts/pending-search',
      chunk_source: 'compiled_truth',
      derived_artifact_kind: 'page_chunks',
      derived_status: 'pending',
    });
  });

  test('SQLite vector search discloses pending page_chunks instead of returning empty', async () => {
    await seedPendingDerivedPage(sqlite);

    const results = await sqlite.searchVector(new Float32Array(768), { limit: 5 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: 'concepts/pending-search',
      chunk_source: 'compiled_truth',
      derived_artifact_kind: 'page_chunks',
      derived_status: 'pending',
    });
  });

  test('SQLite vector fallback scans past filtered pending states to find eligible pages', async () => {
    await seedTypedPendingDerivedPage(sqlite, 'concepts/vector-filtered-pending', 'concept', 'Vector Filtered Pending');
    await seedTypedPendingDerivedPage(sqlite, 'people/vector-filtered-pending', 'person', 'Vector Filtered Person');
    (sqlite as any).database.prepare(`
      UPDATE derived_index_state
      SET updated_at = '2030-01-01T00:00:00.000Z'
      WHERE slug = 'people/vector-filtered-pending'
    `).run();

    const results = await sqlite.searchVector(new Float32Array(768), {
      limit: 1,
      type: 'concept',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      slug: 'concepts/vector-filtered-pending',
      type: 'concept',
      derived_artifact_kind: 'page_chunks',
      derived_status: 'pending',
    });
  });
});
