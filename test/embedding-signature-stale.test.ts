/**
 * v0.41.31 — real stale semantics via pages.embedding_signature (PGLite).
 *
 * Pins the commit-3 contract:
 *   - R-4 (grandfather, CRITICAL): a page embedded under a NULL signature is
 *     NEVER stale. After the v108 migration every existing page has NULL, so
 *     the next embed --stale must NOT re-embed the whole corpus.
 *   - signature mismatch (model/dims swap) → counted as stale.
 *   - matching signature → not stale.
 *   - invalidateStaleSignatureEmbeddings NULLs only mismatched (grandfathered
 *     NULL + matching untouched) and returns the count.
 *   - setPageEmbeddingSignature stamps.
 *
 * Canonical PGLite block (CLAUDE.md R3+R4).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { hasSignatureDrift, invalidateStaleSignatureEmbeddingsGuarded } from '../src/core/embedding-invalidation.ts';
import { sealPageTextProjection } from '../src/core/page-state/projections.ts';
import { stampIfPageProvenanceComplete } from '../src/core/embed-stale.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

let engine: PGLiteEngine;
let colDim: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  const rows = await engine.executeRaw<{ dim: number }>(
    `SELECT atttypmod AS dim FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`,
  );
  colDim = Number(rows[0]?.dim);
});

/**
 * Seed a page with one EMBEDDED chunk (non-null vector) and a given
 * embedding_signature (null → grandfathered legacy state).
 */
async function seedEmbedded(slug: string, text: string, signature: string | null, opts: { sourceId?: string; currentProjection?: boolean } = {}): Promise<void> {
  const { sourceId } = opts;
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` }, sourceId ? { sourceId } : undefined);
  const chunks: ChunkInput[] = [
    { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined },
  ];
  if (opts.currentProjection) await installFixtureChunks(engine, slug, chunks, { sourceId });
  else await engine.upsertChunks(slug, chunks, sourceId ? { sourceId } : undefined);
  // Flip the chunk to a non-null vector sized to the actual column dim.
  await engine.executeRaw(
    `UPDATE content_chunks
        SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[$1::int]), ',') || ']')::vector
      WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = $3)`,
    [colDim, slug, sourceId ?? 'default'],
  );
  if (signature !== null) {
    await engine.setPageEmbeddingSignature(slug, { sourceId, signature });
  }
}

describe('embedding_signature stale semantics', () => {
  for (const guarded of [false, true]) {
    for (const includeNullSignature of [false, true]) {
      test(`preserves only proven current chunks (guarded=${guarded}, null=${includeNullSignature}) (#5051)`, async () => {
        const model = 'ollama:example-model:latest';
        const signature = `${model}:${colDim}`;
        const slug = 'mixed-provenance';
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: '# mixed' });
        await installFixtureChunks(engine, slug, Array.from({ length: 5 }, (_, i) => ({
          chunk_index: i, chunk_text: `chunk ${i}`, chunk_source: 'compiled_truth',
          embedding: new Float32Array(colDim).fill(0.1), model,
        })));
        if (!includeNullSignature) await engine.setPageEmbeddingSignature(slug, { signature: 'old:model:1' });
        await engine.executeRaw(`UPDATE content_chunks SET
          model = CASE WHEN chunk_index = 1 THEN 'foreign:model' WHEN chunk_index = 2 THEN 'example-model:latest' ELSE model END,
          embedded_text_hash = CASE WHEN chunk_index = 3 THEN NULL WHEN chunk_index = 4 THEN 'changed' ELSE embedded_text_hash END
          WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')`, [slug]);
        const opts = { signature, sourceId: 'default', includeNullSignature };
        const invalidated = guarded
          ? await invalidateStaleSignatureEmbeddingsGuarded(engine, opts)
          : await engine.invalidateStaleSignatureEmbeddings(opts);
        expect(invalidated).toBe(3);
        const rows = await engine.executeRaw<{ chunk_index: number }>(
          `SELECT chunk_index FROM content_chunks WHERE embedding IS NOT NULL ORDER BY chunk_index`,
        );
        // A pre-prefix label retains the same model tail, including its version tag.
        expect(rows.map((row) => row.chunk_index)).toEqual([0, 2]);
      });
    }
  }

  test('matching model and text cannot preserve vectors of the wrong width (#5051)', async () => {
    await seedEmbedded('wrong-width', 'text', 'old:model:1', { currentProjection: true });
    await engine.executeRaw(`UPDATE content_chunks SET model = 'target:model', embedded_text_hash = md5(chunk_text)`);
    expect(await invalidateStaleSignatureEmbeddingsGuarded(engine, {
      signature: `target:model:${colDim + 1}`,
    })).toBe(1);
  });

  test('interrupted-drain completion stamps require a current text projection', async () => {
    const slug = 'unsealed-completion';
    const signature = `target:model:${colDim}`;
    await seedEmbedded(slug, 'text', 'old:model:1');
    await engine.executeRaw(`UPDATE content_chunks SET model = 'target:model', embedded_text_hash = md5(chunk_text)`);
    expect(await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature })).toBe(0);
    const readSignature = async () => (await engine.executeRaw<{ embedding_signature: string }>(
      'SELECT embedding_signature FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug]))[0].embedding_signature;
    expect(await readSignature()).toBe('old:model:1');
    expect(await stampIfPageProvenanceComplete(engine, slug, 'default', { signature, column: 'embedding' })).toBe(false);
    await sealPageTextProjection(engine, slug, 'default');
    expect(await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature })).toBe(0);
    expect(await readSignature()).toBe(signature);
    expect(await stampIfPageProvenanceComplete(engine, slug, 'default', { signature, column: 'embedding' })).toBe(true);
  });

  test('completion stamps require matching vector width (#5051)', async () => {
    await seedEmbedded('wrong-width-stamp', 'text', 'old:model:1');
    await sealPageTextProjection(engine, 'wrong-width-stamp', 'default');
    await engine.executeRaw(`UPDATE content_chunks SET model = 'target:model', embedded_text_hash = md5(chunk_text)`);
    expect(await stampIfPageProvenanceComplete(engine, 'wrong-width-stamp', 'default', {
      signature: `target:model:${colDim + 1}`, column: 'embedding',
    })).toBe(false);
  });

  test('unparseable signatures never claim provenance or preserve unknown widths (#5051)', async () => {
    await seedEmbedded('unknown-width', 'text', 'old:model:1', { currentProjection: true });
    await engine.executeRaw(`UPDATE content_chunks SET model = 'target:model', embedded_text_hash = md5(chunk_text)`);
    expect(await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature: 'target:model' })).toBe(1);
  });

  test('R-4 GRANDFATHER: NULL signature is never stale', async () => {
    await seedEmbedded('legacy', 'abcde', null); // embedded, NULL signature
    // No NULL embeddings, NULL signature → not stale under any signature.
    expect(await engine.countStaleChunks({ signature: 'openai:m:1536' })).toBe(0);
    expect(await engine.sumStaleChunkChars({ signature: 'openai:m:1536' })).toBe(0);
  });

  test('signature MISMATCH (model swap) is counted as stale', async () => {
    await seedEmbedded('drifted', 'abcde', 'openai:old:1536'); // 5 chars
    expect(await engine.countStaleChunks({ signature: 'voyage:new:1024' })).toBe(1);
    expect(await engine.sumStaleChunkChars({ signature: 'voyage:new:1024' })).toBe(5);
    // Without the signature opt, the legacy NULL-only predicate ignores it.
    expect(await engine.countStaleChunks()).toBe(0);
  });

  test('MATCHING signature is not stale', async () => {
    await seedEmbedded('fresh', 'abcde', 'voyage:new:1024');
    expect(await engine.countStaleChunks({ signature: 'voyage:new:1024' })).toBe(0);
    expect(await engine.sumStaleChunkChars({ signature: 'voyage:new:1024' })).toBe(0);
  });

  test('invalidateStaleSignatureEmbeddings NULLs only mismatched; grandfathered + matching untouched', async () => {
    await seedEmbedded('old', 'abcde', 'openai:old:1536'); // mismatched → invalidate
    await seedEmbedded('legacy', 'fghij', null); // grandfathered → keep
    await seedEmbedded('new', 'klmno', 'voyage:new:1024'); // matching → keep

    const invalidated = await engine.invalidateStaleSignatureEmbeddings({ signature: 'voyage:new:1024' });
    expect(invalidated).toBe(1); // only 'old'

    // Now exactly the 'old' page's chunk is NULL → legacy stale count = 1.
    expect(await engine.countStaleChunks()).toBe(1);
    // Re-running is idempotent (nothing left to invalidate).
    expect(await engine.invalidateStaleSignatureEmbeddings({ signature: 'voyage:new:1024' })).toBe(0);
  });

  test('invalidate is sourceId-scoped', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    await seedEmbedded('a', 'abcde', 'openai:old:1536'); // default
    await seedEmbedded('b', 'fghij', 'openai:old:1536', { sourceId: 'other' }); // other
    const n = await engine.invalidateStaleSignatureEmbeddings({ signature: 'voyage:new:1024', sourceId: 'default' });
    expect(n).toBe(1);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
    expect(await engine.countStaleChunks({ sourceId: 'other' })).toBe(0); // untouched
  });

  test('setPageEmbeddingSignature stamps the page', async () => {
    await engine.putPage('p', { type: 'note', title: 'p', compiled_truth: '# p' });
    await engine.setPageEmbeddingSignature('p', { signature: 'openai:m:1536' });
    const rows = await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'p' AND source_id = 'default'`,
    );
    expect(rows[0]?.embedding_signature).toBe('openai:m:1536');
  });
});

describe('windowed stale-signature invalidation (#7148)', () => {
  const model = 'ollama:example-model:latest';

  /** A mixed corpus: drifted, current-under-an-old-stamp, matching, grandfathered, embed_skip, other-source and archived-source pages. */
  async function seedCorpus(): Promise<string> {
    const signature = model + ':' + colDim;
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb), ('shelf', 'shelf', '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
    const page = async (slug: string, stamp: string | null, chunkModel: string, sourceId = 'default') => {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: '# ' + slug }, { sourceId });
      await installFixtureChunks(engine, slug, Array.from({ length: 3 }, (_, i) => ({
        chunk_index: i, chunk_text: slug + ' chunk ' + i, chunk_source: 'compiled_truth' as const,
        embedding: new Float32Array(colDim).fill(0.1), model: chunkModel,
      })), { sourceId });
      await engine.executeRaw('UPDATE pages SET embedding_signature = $1 WHERE slug = $2 AND source_id = $3', [stamp, slug, sourceId]);
    };
    for (let i = 0; i < 7; i++) await page('drift-' + i, 'old:model:1', 'old:model');
    await page('current-old-stamp', 'old:model:1', model);
    await page('matching', signature, model);
    await page('legacy-old', null, 'old:model');
    await page('legacy-current', null, model);
    await page('skipped', 'old:model:1', 'old:model');
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"embed_skip\": true}'::jsonb WHERE slug = 'skipped'");
    await page('elsewhere', 'old:model:1', 'old:model', 'other');
    await page('shelved', 'old:model:1', 'old:model', 'shelf');
    await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'shelf'");
    for (let i = 7; i < 10; i++) await page('drift-' + i, 'old:model:1', 'old:model');
    return signature;
  }

  async function snapshot(): Promise<string[]> {
    const rows = await engine.executeRaw<{ row: string }>(
      "SELECT p.source_id || '/' || p.slug || ' ' || COALESCE(p.embedding_signature, '-') || ' ' || string_agg(CASE WHEN cc.embedding IS NULL THEN '0' ELSE '1' END, '' ORDER BY cc.chunk_index) AS row FROM pages p JOIN content_chunks cc ON cc.page_id = p.id GROUP BY p.id ORDER BY p.source_id, p.slug");
    return rows.map(r => r.row);
  }

  for (const includeNullSignature of [false, true]) {
    for (const sourceId of [undefined, 'default']) {
      test('every page window gives the one-statement result (null=' + includeNullSignature + ', source=' + (sourceId ?? 'all') + ')', async () => {
        const results: Array<{ invalidated: number; rows: string[] }> = [];
        for (const pageBatch of [undefined, 1, 2, 5]) {
          await resetPgliteState(engine);
          const signature = await seedCorpus();
          const invalidated = await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature, includeNullSignature, ...(sourceId && { sourceId }), ...(pageBatch && { pageBatch }) });
          results.push({ invalidated, rows: await snapshot() });
        }
        const expected = (includeNullSignature ? 33 : 30) + (sourceId ? 0 : 3);
        expect(results[0]!.invalidated).toBe(expected);
        for (const r of results.slice(1)) expect(r).toEqual(results[0]!);
        const rows = results[0]!.rows;
        expect(rows).toContain('default/current-old-stamp ' + model + ':' + colDim + ' 111');
        expect(rows).toContain('default/drift-3 old:model:1 000');
        expect(rows).toContain('default/skipped old:model:1 111');
        expect(rows).toContain('shelf/shelved old:model:1 111');
        expect(rows).toContain('default/legacy-current ' + (includeNullSignature ? model + ':' + colDim : '-') + ' 111');
        expect(rows).toContain('default/legacy-old - ' + (includeNullSignature ? '000' : '111'));
        expect(rows).toContain('other/elsewhere old:model:1 ' + (sourceId ? '111' : '000'));
      });
    }
  }

  test('rejects a page window below one', async () => {
    await expect(invalidateStaleSignatureEmbeddingsGuarded(engine, { signature: 'm:1', pageBatch: 0 })).rejects.toThrow(/page batch/);
  });

  test('hasSignatureDrift answers what the two-count pre-checks answered', async () => {
    const signature = model + ':' + colDim;
    const cases: Array<[string, (s: string) => Promise<void>]> = [
      ['empty', async () => {}],
      ['drifted', async s => { await seedEmbedded(s, 'x', 'old:model:1'); }],
      ['matching', async s => { await seedEmbedded(s, 'x', signature); }],
      ['legacy', async s => { await seedEmbedded(s, 'x', null); }],
      ['unembedded-drifted', async s => {
        await seedEmbedded(s, 'x', 'old:model:1');
        await engine.executeRaw('UPDATE content_chunks SET embedding = NULL');
      }],
      ['skipped', async s => {
        await seedEmbedded(s, 'x', 'old:model:1');
        await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"embed_skip\": true}'::jsonb");
      }],
      ['deleted', async s => {
        await seedEmbedded(s, 'x', 'old:model:1');
        await engine.softDeletePage(s, { sourceId: 'default' });
      }],
    ];
    const seen: Record<string, boolean[]> = {};
    for (const [name, seed] of cases) {
      await resetPgliteState(engine);
      await seed('case-' + name);
      const wide = await engine.countStaleChunks({ signature });
      const wideNull = await engine.countStaleChunks({ signature, includeNullSignature: true });
      const nullOnly = await engine.countStaleChunks();
      const answers = [
        await hasSignatureDrift(engine, { signature }),
        await hasSignatureDrift(engine, { signature, includeNullSignature: true }),
        await hasSignatureDrift(engine, { signature, nullSignatureOnly: true }),
        await hasSignatureDrift(engine, { signature, sourceId: 'default' }),
        await hasSignatureDrift(engine, { signature, sourceId: 'other' }),
      ];
      expect(answers).toEqual([wide - nullOnly > 0, wideNull - nullOnly > 0, wideNull - wide > 0, wide - nullOnly > 0, false]);
      seen[name] = answers;
    }
    expect(seen.drifted).toEqual([true, true, false, true, false]);
    expect(seen.legacy).toEqual([false, true, true, false, false]);
  });
});
