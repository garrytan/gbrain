/**
 * #1262 — registry-aware embedding writes.
 *
 * upsertChunks used to hardcode the legacy `embedding` column + `::vector`
 * cast, so a brain whose registry routes the active column elsewhere (e.g.
 * a 1024d Voyage column) failed EVERY write with "expected 1536 dimensions,
 * not 1024". The write side now resolves the active column through the same
 * registry the read side uses (`search_embedding_column` +
 * `embedding_columns` DB-plane rows via resolveWriteColumnFromConfigRows),
 * with an `opts.embeddingColumn` caller-boundary override.
 *
 * PGLite section always runs; the Postgres section is DATABASE_URL-gated
 * (parity shape — both engines execute the same scenario).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  resolveWriteColumnFromConfigRows,
  resolveActiveEmbeddingColumnFromEngine,
  vectorCastSuffix,
  EmbeddingColumnNotRegisteredError,
} from '../../src/core/search/embedding-column.ts';
import { invalidateStaleSignatureEmbeddingsGuarded } from '../../src/core/embedding-invalidation.ts';
import { embedStalePages } from '../../src/core/embed-stale.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ResolvedColumn } from '../../src/core/types.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const REGISTRY_JSON = JSON.stringify({
  embedding_test8: { provider: 'voyage:voyage-3-large', dimensions: 8, type: 'vector' },
  embedding_hv8: { provider: 'zeroentropyai:zembed-1', dimensions: 8, type: 'halfvec' },
});

const VEC8 = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
const VEC8_B = new Float32Array([8, 7, 6, 5, 4, 3, 2, 1]);

/** One row of write-side truth: which columns hold a vector for the slug. */
async function columnTruth(
  engine: BrainEngine,
  slug: string,
): Promise<{ legacy_null: boolean; test8_null: boolean; chunk_text: string }[]> {
  return await engine.executeRaw<{ legacy_null: boolean; test8_null: boolean; chunk_text: string }>(
    `SELECT (cc.embedding IS NULL) AS legacy_null,
            (cc.embedding_test8 IS NULL) AS test8_null,
            cc.chunk_text
     FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
     WHERE p.slug = '${slug}' ORDER BY cc.chunk_index`,
  );
}

// ---- Shared scenario, run against both engines (parity) -----------------

function registryWriteScenario(name: string, getEngine: () => BrainEngine) {
  test(`${name}: registry-routed write lands in the active column, not legacy embedding`, async () => {
    const engine = getEngine();
    await engine.setConfig('search_embedding_column', 'embedding_test8');
    await engine.setConfig('embedding_columns', REGISTRY_JSON);

    await engine.putPage('docs/registry-write', {
      type: 'concept',
      title: 'Registry write',
      compiled_truth: 'registry write target',
    });
    // Pre-fix this threw "expected <legacy dims> dimensions, not 8".
    await engine.upsertChunks('docs/registry-write', [
      {
        chunk_index: 0,
        chunk_text: 'registry chunk v1',
        chunk_source: 'compiled_truth',
        embedding: VEC8,
        model: 'voyage:voyage-3-large',
      },
    ]);

    const rows = await columnTruth(engine, 'docs/registry-write');
    expect(rows.length).toBe(1);
    expect(rows[0].test8_null).toBe(false);
    expect(rows[0].legacy_null).toBe(true);
  });

  test(`${name}: ON CONFLICT branch updates the active column on re-chunk and preserves it on metadata-only upsert`, async () => {
    const engine = getEngine();
    // Re-chunk (text changed) with a fresh vector → active column updated.
    await engine.upsertChunks('docs/registry-write', [
      {
        chunk_index: 0,
        chunk_text: 'registry chunk v2',
        chunk_source: 'compiled_truth',
        embedding: VEC8_B,
        model: 'voyage:voyage-3-large',
      },
    ]);
    let rows = await columnTruth(engine, 'docs/registry-write');
    expect(rows[0].chunk_text).toBe('registry chunk v2');
    expect(rows[0].test8_null).toBe(false);

    // Text-unchanged upsert with NO embedding → active column preserved.
    await engine.upsertChunks('docs/registry-write', [
      { chunk_index: 0, chunk_text: 'registry chunk v2', chunk_source: 'compiled_truth' },
    ]);
    rows = await columnTruth(engine, 'docs/registry-write');
    expect(rows[0].test8_null).toBe(false);

    // Re-chunk with NO embedding → active column resets to NULL (stale).
    await engine.upsertChunks('docs/registry-write', [
      { chunk_index: 0, chunk_text: 'registry chunk v3', chunk_source: 'compiled_truth' },
    ]);
    rows = await columnTruth(engine, 'docs/registry-write');
    expect(rows[0].test8_null).toBe(true);
  });

  test(`${name}: halfvec registry column accepts the ::halfvec(N) cast`, async () => {
    const engine = getEngine();
    await engine.setConfig('search_embedding_column', 'embedding_hv8');
    await engine.putPage('docs/registry-hv', {
      type: 'concept',
      title: 'Halfvec write',
      compiled_truth: 'halfvec write target',
    });
    await engine.upsertChunks('docs/registry-hv', [
      {
        chunk_index: 0,
        chunk_text: 'halfvec chunk',
        chunk_source: 'compiled_truth',
        embedding: VEC8,
        model: 'zeroentropyai:zembed-1',
      },
    ]);
    const rows = await engine.executeRaw<{ hv_null: boolean }>(
      `SELECT (cc.embedding_hv8 IS NULL) AS hv_null
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = 'docs/registry-hv'`,
    );
    expect(rows[0].hv_null).toBe(false);
  });

  test(`${name}: opts.embeddingColumn descriptor overrides the config rows`, async () => {
    const engine = getEngine();
    await engine.setConfig('search_embedding_column', 'embedding_hv8');
    const descriptor: ResolvedColumn = {
      name: 'embedding_test8',
      type: 'vector',
      dimensions: 8,
      embeddingModel: 'voyage:voyage-3-large',
    };
    await engine.putPage('docs/registry-override', {
      type: 'concept',
      title: 'Override write',
      compiled_truth: 'override write target',
    });
    await engine.upsertChunks(
      'docs/registry-override',
      [
        {
          chunk_index: 0,
          chunk_text: 'override chunk',
          chunk_source: 'compiled_truth',
          embedding: VEC8,
          model: 'voyage:voyage-3-large',
        },
      ],
      { embeddingColumn: descriptor },
    );
    const rows = await columnTruth(engine, 'docs/registry-override');
    expect(rows[0].test8_null).toBe(false);
  });

  test(`${name}: unregistered search_embedding_column throws the loud resolver error`, async () => {
    const engine = getEngine();
    await engine.setConfig('search_embedding_column', 'embedding_ghost');
    await engine.putPage('docs/registry-ghost', {
      type: 'concept',
      title: 'Ghost write',
      compiled_truth: 'ghost write target',
    });
    await expect(
      engine.upsertChunks('docs/registry-ghost', [
        { chunk_index: 0, chunk_text: 'ghost chunk', chunk_source: 'compiled_truth' },
      ]),
    ).rejects.toThrow(EmbeddingColumnNotRegisteredError);
  });

  test(`${name}: legacy default when config rows are cleared (pre-registry brains unchanged)`, async () => {
    const engine = getEngine();
    await engine.unsetConfig('search_embedding_column');
    await engine.unsetConfig('embedding_columns');
    await engine.putPage('docs/registry-legacy', {
      type: 'concept',
      title: 'Legacy write',
      compiled_truth: 'legacy write target',
    });
    await engine.upsertChunks('docs/registry-legacy', [
      { chunk_index: 0, chunk_text: 'legacy chunk', chunk_source: 'compiled_truth' },
    ]);
    const rows = await columnTruth(engine, 'docs/registry-legacy');
    expect(rows.length).toBe(1);
  });
}

// ---- Shared stale/invalidate/health scenario (S2 read/write unification) --
//
// #1262 routed WRITES through the registry, but the stale/invalidate/health
// plane still keyed on the literal legacy `cc.embedding` — on a registry-
// routed brain every embedded chunk read as permanently stale (re-embed loop)
// while coverage read 0%. These tests pin that every selector resolves the
// SAME active column the write side uses, on BOTH engines.

function registryStaleScenario(name: string, getEngine: () => BrainEngine) {
  const SLUG = 'docs/registry-stale';

  test(`${name}: embedded registry-column chunk is NOT stale; content flip re-stales it`, async () => {
    const engine = getEngine();
    await engine.setConfig('search_embedding_column', 'embedding_test8');
    await engine.setConfig('embedding_columns', REGISTRY_JSON);
    await engine.putPage(SLUG, {
      type: 'concept',
      title: 'Registry stale probe',
      compiled_truth: 'registry stale probe target',
    });

    const countBefore = await engine.countStaleChunks();
    await engine.upsertChunks(SLUG, [
      {
        chunk_index: 0,
        chunk_text: 'stale probe v1',
        chunk_source: 'compiled_truth',
        embedding: VEC8,
        model: 'voyage:voyage-3-large',
      },
    ]);

    // Pre-fix: the selectors read the legacy column (still NULL) and reported
    // this freshly embedded chunk as stale FOREVER.
    expect(await engine.countStaleChunks()).toBe(countBefore);
    const staleAfterEmbed = await engine.listStaleChunks({ batchSize: 100000 });
    expect(staleAfterEmbed.some((r) => r.slug === SLUG)).toBe(false);

    // getChunks' embedding_is_null reports the ACTIVE column's truth (the
    // per-page `gbrain embed <slug>` filter keys on it).
    const chunks = await engine.getChunks(SLUG);
    expect(chunks.length).toBe(1);
    expect(chunks[0].embedding_is_null).toBe(false);

    // Content flip without a fresh vector → the ACTIVE column resets to NULL
    // and every selector agrees it is stale again.
    await engine.upsertChunks(SLUG, [
      { chunk_index: 0, chunk_text: 'stale probe v2', chunk_source: 'compiled_truth' },
    ]);
    expect(await engine.countStaleChunks()).toBe(countBefore + 1);
    const staleAfterFlip = await engine.listStaleChunks({ batchSize: 100000 });
    const mine = staleAfterFlip.filter((r) => r.slug === SLUG);
    expect(mine.length).toBe(1);
    expect(mine[0].chunk_text).toBe('stale probe v2');
    expect(await engine.sumStaleChunkChars()).toBeGreaterThanOrEqual('stale probe v2'.length);
    expect((await engine.getChunks(SLUG))[0].embedding_is_null).toBe(true);
  });

  test(`${name}: getStats/getHealth coverage keys on the registry column`, async () => {
    const engine = getEngine();
    const statsBefore = await engine.getStats();
    const healthBefore = await engine.getHealth();
    await engine.upsertChunks(SLUG, [
      {
        chunk_index: 0,
        chunk_text: 'stale probe v2',
        chunk_source: 'compiled_truth',
        embedding: VEC8_B,
        model: 'voyage:voyage-3-large',
      },
    ]);
    // Pre-fix: embedded_count/missing_embeddings watched the legacy column,
    // so embedding a registry-routed chunk moved neither number.
    const statsAfter = await engine.getStats();
    expect(statsAfter.embedded_count).toBe(statsBefore.embedded_count + 1);
    const healthAfter = await engine.getHealth();
    expect(healthAfter.missing_embeddings).toBe(healthBefore.missing_embeddings - 1);
  });

  test(`${name}: signature invalidation NULLs the registry column (guarded + engine method)`, async () => {
    const engine = getEngine();
    // Guarded helper (the migration/embed entry point).
    await engine.setPageEmbeddingSignature(SLUG, { signature: 'sig-old' });
    const n = await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature: 'sig-new' });
    expect(n).toBeGreaterThanOrEqual(1);
    let rows = await columnTruth(engine, SLUG);
    expect(rows[0].test8_null).toBe(true);
    expect((await engine.listStaleChunks({ batchSize: 100000 })).some((r) => r.slug === SLUG)).toBe(true);

    // Engine method: re-embed, then invalidate against a different signature.
    await engine.upsertChunks(SLUG, [
      {
        chunk_index: 0,
        chunk_text: 'stale probe v2',
        chunk_source: 'compiled_truth',
        embedding: VEC8,
        model: 'voyage:voyage-3-large',
      },
    ]);
    await engine.setPageEmbeddingSignature(SLUG, { signature: 'sig-mid' });
    const n2 = await engine.invalidateStaleSignatureEmbeddings({ signature: 'sig-final' });
    expect(n2).toBeGreaterThanOrEqual(1);
    rows = await columnTruth(engine, SLUG);
    expect(rows[0].test8_null).toBe(true);
  });

  test(`${name}: content-drift invalidation NULLs the registry column (#4246 x S2)`, async () => {
    const engine = getEngine();
    // Stamp signature to the invalidation target so the drift path (not the
    // signature path) is what re-stales the chunk.
    await engine.upsertChunks(SLUG, [
      {
        chunk_index: 0,
        chunk_text: 'stale probe v3',
        chunk_source: 'compiled_truth',
        embedding: VEC8_B,
        model: 'voyage:voyage-3-large',
      },
    ]);
    let rows = await columnTruth(engine, SLUG);
    expect(rows[0].test8_null).toBe(false);
    // Simulate an external rewrite that kept the vector: embedded_text_hash
    // (stamped at embed time) no longer matches md5(chunk_text).
    await engine.executeRaw(
      `UPDATE content_chunks cc SET chunk_text = 'drifted text'
        FROM pages p WHERE cc.page_id = p.id AND p.slug = '${SLUG}'`,
    );
    const n = await engine.invalidateContentDriftEmbeddings();
    expect(n).toBeGreaterThanOrEqual(1);
    rows = await columnTruth(engine, SLUG);
    expect(rows[0].test8_null).toBe(true);
  });

  test(`${name}: embedStalePages targets the registry column (no re-embed loop)`, async () => {
    const engine = getEngine();
    // Chunk is currently stale (drift invalidation above) → one embed lands
    // in the ACTIVE column.
    let calls = 0;
    const embedFn = async (texts: string[]) => {
      calls += texts.length;
      return texts.map(() => VEC8);
    };
    const first = await embedStalePages(engine, [SLUG], 'default', { embedFn });
    expect(first.embedded).toBe(1);
    expect(calls).toBe(1);
    const rows = await columnTruth(engine, SLUG);
    expect(rows[0].test8_null).toBe(false);

    // Second pass: nothing stale in the ACTIVE column → zero embeds.
    // Pre-fix the selector keyed on the legacy column (always NULL) and
    // re-embedded every chunk on every phase end — paid spend, forever.
    const second = await embedStalePages(engine, [SLUG], 'default', { embedFn });
    expect(second.embedded).toBe(0);
    expect(calls).toBe(1);
  });
}

// ---- PGLite (always runs) ------------------------------------------------

describe('#1262 upsertChunks registry-aware writes (PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await (engine as any).db.exec(
      `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_test8 vector(8)`,
    );
    await (engine as any).db.exec(
      `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_hv8 halfvec(8)`,
    );
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  registryWriteScenario('pglite', () => engine);

  test('pglite: search_embedding_column=embedding_image falls back to the legacy text column (no duplicate INSERT column)', async () => {
    await engine.setConfig('search_embedding_column', 'embedding_image');
    await engine.putPage('docs/registry-image-guard', {
      type: 'concept',
      title: 'Image guard',
      compiled_truth: 'image guard target',
    });
    await engine.upsertChunks('docs/registry-image-guard', [
      { chunk_index: 0, chunk_text: 'image guard chunk', chunk_source: 'compiled_truth' },
    ]);
    const rows = await columnTruth(engine, 'docs/registry-image-guard');
    expect(rows.length).toBe(1);
    await engine.unsetConfig('search_embedding_column');
  });

  test('pglite: malformed embedding_columns JSON is ignored — default writes keep working', async () => {
    await engine.setConfig('embedding_columns', '{not json');
    await engine.putPage('docs/registry-badjson', {
      type: 'concept',
      title: 'Bad JSON',
      compiled_truth: 'bad json target',
    });
    await engine.upsertChunks('docs/registry-badjson', [
      { chunk_index: 0, chunk_text: 'bad json chunk', chunk_source: 'compiled_truth' },
    ]);
    const rows = await columnTruth(engine, 'docs/registry-badjson');
    expect(rows.length).toBe(1);
    await engine.unsetConfig('embedding_columns');
  });

  registryStaleScenario('pglite', () => engine);

  test('pglite: resolveActiveEmbeddingColumnFromEngine — throw vs fallbackToLegacy on a broken registry', async () => {
    await engine.setConfig('search_embedding_column', 'embedding_ghost');
    await expect(
      resolveActiveEmbeddingColumnFromEngine(engine),
    ).rejects.toThrow(EmbeddingColumnNotRegisteredError);
    const legacy = await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true });
    expect(legacy.name).toBe('embedding');
    await engine.setConfig('search_embedding_column', 'embedding_test8');
    const active = await resolveActiveEmbeddingColumnFromEngine(engine);
    expect(active.name).toBe('embedding_test8');
    expect(active.dimensions).toBe(8);
    await engine.unsetConfig('search_embedding_column');
    await engine.unsetConfig('embedding_columns');
  });
});

// ---- Helper units (pure) --------------------------------------------------

describe('#1262 resolveWriteColumnFromConfigRows / vectorCastSuffix', () => {
  test('no rows → legacy embedding::vector descriptor', () => {
    const r = resolveWriteColumnFromConfigRows({});
    expect(r.name).toBe('embedding');
    expect(r.type).toBe('vector');
    expect(vectorCastSuffix(r)).toBe('::vector');
  });

  test('registry-routed name resolves with declared type + dims', () => {
    const r = resolveWriteColumnFromConfigRows({
      searchEmbeddingColumn: 'embedding_hv8',
      embeddingColumnsJson: REGISTRY_JSON,
    });
    expect(r.name).toBe('embedding_hv8');
    expect(r.type).toBe('halfvec');
    expect(r.dimensions).toBe(8);
    expect(vectorCastSuffix(r)).toBe('::halfvec(8)');
  });

  test('registry override of the embedding builtin wins', () => {
    const r = resolveWriteColumnFromConfigRows({
      embeddingColumnsJson: JSON.stringify({
        embedding: { provider: 'zeroentropyai:zembed-1', dimensions: 2560, type: 'halfvec' },
      }),
    });
    expect(r.name).toBe('embedding');
    expect(r.type).toBe('halfvec');
    expect(r.dimensions).toBe(2560);
  });

  test('embedding_image routes back to the legacy text column', () => {
    const r = resolveWriteColumnFromConfigRows({ searchEmbeddingColumn: 'embedding_image' });
    expect(r.name).toBe('embedding');
  });

  test('malformed registry JSON with a default name is forgiven', () => {
    const r = resolveWriteColumnFromConfigRows({ embeddingColumnsJson: '{oops' });
    expect(r.name).toBe('embedding');
  });

  test('unregistered non-default name throws the paste-ready error', () => {
    expect(() =>
      resolveWriteColumnFromConfigRows({ searchEmbeddingColumn: 'embedding_ghost' }),
    ).toThrow(EmbeddingColumnNotRegisteredError);
  });
});

// ---- Postgres (DATABASE_URL-gated parity) ---------------------------------

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  describe.skip('#1262 upsertChunks registry-aware writes (postgres — skipped: DATABASE_URL unset)', () => {
    test('skipped', () => { expect(true).toBe(true); });
  });
} else {
  describe('#1262 upsertChunks registry-aware writes (postgres)', () => {
    let engine: PostgresEngine;

    beforeAll(async () => {
      engine = new PostgresEngine();
      assertSafeE2eDatabaseUrl(dbUrl!);
      await engine.connect({ database_url: dbUrl } as never);
      await engine.initSchema();
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'docs/registry-%'`);
      await engine.executeRaw(
        `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_test8 vector(8)`,
      );
      await engine.executeRaw(
        `ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_hv8 halfvec(8)`,
      );
    });

    afterAll(async () => {
      if (engine) {
        // Leave no registry routing behind for other suites sharing this DB.
        await engine.unsetConfig('search_embedding_column');
        await engine.unsetConfig('embedding_columns');
        await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'docs/registry-%'`);
        await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_test8`);
        await engine.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_hv8`);
        await engine.disconnect();
      }
    });

    registryWriteScenario('postgres', () => engine);
    registryStaleScenario('postgres', () => engine);
  });
}
