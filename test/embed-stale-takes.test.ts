/**
 * #2089: takes.embedding write path. Before this fix nothing ever wrote
 * takes.embedding, so the vector takes arm (searchTakesVector / think
 * takes_vec) was structurally dead on every install. Covers:
 *   - embedStaleTakes backfills stale claims (injected embedFn, no gateway)
 *   - dry-run counts without writing
 *   - searchTakesVector actually returns hits once embeddings exist
 *   - migration v125 retypes the hardcoded vector(1536) column to the
 *     configured embedder dims when the column is empty
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { embedStaleTakes, type EmbedResult } from '../src/commands/embed.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';

let engine: PGLiteEngine;
let pageId: number;

const DIMS = 1536;

/** Deterministic fake embedder: unit vector rotated by first char code. */
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  v[text.charCodeAt(0) % DIMS] = 1;
  return v;
}
const embedFn = async (texts: string[]) => texts.map(fakeEmbed);

function freshResult(dryRun = false): EmbedResult {
  return { embedded: 0, skipped: 0, would_embed: 0, total_chunks: 0, pages_processed: 0, dryRun };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page = await engine.putPage('people/alice-example', {
    title: 'Alice Example',
    type: 'person' as const,
    compiled_truth: '## Takes\n\nAlice is a strong founder.\n',
  });
  pageId = page.id;
  await engine.addTakesBatch([
    { page_id: pageId, row_num: 1, claim: 'Alice is a strong technical founder', kind: 'take', holder: 'garry', weight: 0.9 },
    { page_id: pageId, row_num: 2, claim: 'Zebra stripes are cosmetic', kind: 'hunch', holder: 'garry', weight: 0.4 },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('embedStaleTakes (#2089)', () => {
  test('dry-run counts stale takes into would_embed without writing', async () => {
    const result = freshResult(true);
    await embedStaleTakes(engine, true, result, undefined, embedFn);
    expect(result.would_embed).toBe(2);
    expect(await engine.countStaleTakes()).toBe(2);
  });

  test('backfills stale take embeddings and makes searchTakesVector live', async () => {
    expect(await engine.countStaleTakes()).toBe(2);

    const result = freshResult();
    await embedStaleTakes(engine, false, result, undefined, embedFn);

    expect(result.takes_embedded).toBe(2);
    expect(await engine.countStaleTakes()).toBe(0);

    // The read side that was structurally dead: query with the same fake
    // embedding as the 'Alice...' claim → that take ranks first.
    const hits = await engine.searchTakesVector(fakeEmbed('Alice is a strong technical founder'), { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].claim).toBe('Alice is a strong technical founder');
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  test('second run is a no-op (embedding IS NULL predicate)', async () => {
    const result = freshResult();
    await embedStaleTakes(engine, false, result, undefined, async (texts) => {
      throw new Error(`should not be called, got ${texts.length} texts`);
    });
    expect(result.takes_embedded).toBeUndefined();
  });
});

describe('migration v125: takes.embedding dim align (#2089)', () => {
  test('retypes an all-NULL 1536 column to the configured dims', async () => {
    // Fresh engine so the column is untouched (all NULL).
    const e2 = new PGLiteEngine();
    await e2.connect({});
    await e2.initSchema();
    try {
      await e2.executeRaw(`UPDATE config SET value = '8' WHERE key = 'embedding_dimensions'`);
      const v125 = MIGRATIONS.find((m) => m.version === 125);
      expect(v125?.handler).toBeDefined();
      await v125!.handler!(e2);

      const rows = await e2.executeRaw<{ formatted: string }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'takes'
            AND a.attname = 'embedding' AND NOT a.attisdropped`,
      );
      expect(rows[0].formatted).toBe('vector(8)');

      // And the write path works at the new dims.
      const page = await e2.putPage('companies/acme-example', {
        title: 'Acme', type: 'company' as const, compiled_truth: 'Acme.\n',
      });
      await e2.addTakesBatch([
        { page_id: page.id, row_num: 1, claim: 'B2B SaaS', kind: 'fact', holder: 'world', weight: 1 },
      ]);
      const updated = await e2.updateTakeEmbeddings([
        { take_id: (await e2.listStaleTakes())[0].take_id, embedding: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]) },
      ]);
      expect(updated).toBe(1);
      expect(await e2.countStaleTakes()).toBe(0);
    } finally {
      await e2.disconnect();
    }
  });

  test('no-op when column dims already match config', async () => {
    // The main engine is vector(1536) with config 1536: handler returns
    // without touching the (now populated) column.
    const v125 = MIGRATIONS.find((m) => m.version === 125);
    await v125!.handler!(engine);
    expect(await engine.countStaleTakes()).toBe(0); // embeddings survived
  });
});
