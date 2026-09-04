/**
 * Tests for src/core/embed-facts.ts (#4812: `gbrain embed --stale --facts`).
 *
 * Hermetic: an injected `embedFn` produces deterministic vectors so no
 * provider call lands. PGLite is used (not a mock) so the selector, the
 * jsonb_to_recordset writer, and the `facts_pending` predicate parity are
 * validated against real SQL.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { embedStaleFacts } from '../src/core/embed-facts.ts';

let engine: PGLiteEngine;
let dims = 1536;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dims = Number(await engine.getConfig('embedding_dimensions')) || 1536;
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Seed N active facts with NULL embedding; returns their ids in insert order. */
async function seedStaleFacts(count: number, opts: { sourceId?: string; slug?: string; prefix?: string } = {}): Promise<number[]> {
  const slug = opts.slug ?? 'people/alice-example';
  const res = await engine.insertFacts(
    Array.from({ length: count }, (_, i) => ({
      fact: `${opts.prefix ?? 'seeded fact'} ${i}`,
      kind: 'fact' as const,
      source: 'test',
      row_num: i + 1,
      source_markdown_slug: slug,
    })),
    { source_id: opts.sourceId ?? 'default' },
  );
  return res.ids;
}

/** Deterministic fake embedder: vectors whose first dim = text length. */
function fakeEmbedFn(texts: string[]): Promise<Float32Array[]> {
  return Promise.resolve(texts.map((t) => {
    const v = new Float32Array(dims);
    v[0] = t.length;
    v[1] = 1;
    return v;
  }));
}

async function embeddedIds(): Promise<number[]> {
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM facts WHERE embedding IS NOT NULL AND embedded_at IS NOT NULL ORDER BY id`,
  );
  return rows.map((r) => Number(r.id));
}

async function pendingCount(): Promise<number> {
  // The literal `facts_pending` predicate from embedding-migration.ts.
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts WHERE embedding IS NULL AND expired_at IS NULL`,
  );
  return Number(rows[0]?.n ?? 0);
}

const asc = (a: number, b: number): number => a - b;

describe('embedStaleFacts', () => {
  test('embeds every stale fact; a re-run reports total_stale 0', async () => {
    const ids = await seedStaleFacts(5);
    const first = await embedStaleFacts(engine, { embedFn: fakeEmbedFn, batchSize: 2 });
    expect(first).toEqual({
      total_stale: 5, embedded: 5, would_embed: 0, failures: 0, failure_samples: [], dryRun: false,
    });
    expect(await embeddedIds()).toEqual([...ids].sort(asc));
    expect(await pendingCount()).toBe(0);

    const second = await embedStaleFacts(engine, { embedFn: fakeEmbedFn });
    expect(second.total_stale).toBe(0);
    expect(second.embedded).toBe(0);
  });

  test('dry-run reports would_embed and writes nothing', async () => {
    await seedStaleFacts(3);
    let calls = 0;
    const result = await embedStaleFacts(engine, {
      dryRun: true,
      embedFn: async (texts) => { calls += 1; return fakeEmbedFn(texts); },
    });
    expect(result.would_embed).toBe(3);
    expect(result.total_stale).toBe(3);
    expect(result.embedded).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(calls).toBe(0);
    expect(await embeddedIds()).toEqual([]);
    expect(await pendingCount()).toBe(3);
  });

  test('an expired fact is not selected', async () => {
    const live = await seedStaleFacts(2);
    const expired = await engine.insertFacts(
      [{ fact: 'struck fact', kind: 'fact', source: 'test', row_num: 9, source_markdown_slug: 'people/bob-example', expired_at: new Date() }],
      { source_id: 'default' },
    );
    const stale = await engine.listFactsNeedingEmbedding({ limit: 100 });
    expect(stale.map((r) => r.fact_id).sort(asc)).toEqual([...live].sort(asc));
    expect(stale.map((r) => r.fact_id)).not.toContain(expired.ids[0]);

    const result = await embedStaleFacts(engine, { embedFn: fakeEmbedFn });
    expect(result.total_stale).toBe(2);
    expect(result.embedded).toBe(2);
    expect(await embeddedIds()).not.toContain(expired.ids[0]);
  });

  test('sourceId scopes both the count and the selector', async () => {
    // facts.source_id is an FK; resetPgliteState re-seeds only 'default'.
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'Other') ON CONFLICT (id) DO NOTHING`);
    await seedStaleFacts(2, { sourceId: 'default', slug: 'people/alice-example' });
    await seedStaleFacts(3, { sourceId: 'other', slug: 'people/carol-example' });
    const result = await embedStaleFacts(engine, { embedFn: fakeEmbedFn, sourceId: 'other' });
    expect(result.total_stale).toBe(3);
    expect(result.embedded).toBe(3);
    expect(await pendingCount()).toBe(2);
  });

  test('embedFn throwing on batch 2 of 3 fails that batch only; batches 1 and 3 land', async () => {
    const ids = await seedStaleFacts(6);
    let call = 0;
    const result = await embedStaleFacts(engine, {
      batchSize: 2,
      embedFn: async (texts) => {
        call += 1;
        if (call === 2) throw new Error('provider exploded on batch 2');
        return fakeEmbedFn(texts);
      },
    });
    expect(call).toBe(3);
    expect(result.total_stale).toBe(6);
    expect(result.embedded).toBe(4);
    expect(result.failures).toBe(2);
    expect(result.failure_samples).toEqual(['provider exploded on batch 2']);
    const sorted = [...ids].sort(asc);
    expect(await embeddedIds()).toEqual([sorted[0], sorted[1], sorted[4], sorted[5]]);
    const remaining = await engine.listFactsNeedingEmbedding({ limit: 100 });
    expect(remaining.map((r) => r.fact_id)).toEqual([sorted[2], sorted[3]]);
  });

  test('provider returning fewer vectors than inputs is a failure with no misaligned write', async () => {
    await seedStaleFacts(3);
    const result = await embedStaleFacts(engine, {
      embedFn: async (texts) => (await fakeEmbedFn(texts)).slice(0, texts.length - 1),
    });
    expect(result.embedded).toBe(0);
    expect(result.failures).toBe(3);
    expect(result.failure_samples[0]).toMatch(/returned 2 vectors for 3 facts/);
    expect(await embeddedIds()).toEqual([]);
    expect(await pendingCount()).toBe(3);
  });

  test('a fact over the per-input token limit is reported, not sent', async () => {
    const ids = await seedStaleFacts(2, { prefix: 'short' });
    const long = await engine.insertFacts(
      [{ fact: 'one two three four five six seven eight nine ten eleven twelve', kind: 'fact', source: 'test', row_num: 7, source_markdown_slug: 'people/dave-example' }],
      { source_id: 'default' },
    );
    const sent: string[] = [];
    const result = await embedStaleFacts(engine, {
      maxInputTokens: 4,
      embedFn: async (texts) => { sent.push(...texts); return fakeEmbedFn(texts); },
    });
    expect(result.embedded).toBe(2);
    expect(result.failures).toBe(1);
    expect(result.failure_samples[0]).toMatch(new RegExp(`fact_id=${long.ids[0]} exceeds`));
    expect(sent.some((t) => t.startsWith('one two three'))).toBe(false);
    expect(await embeddedIds()).toEqual([...ids].sort(asc));
  });

  test('updateFactEmbeddings ignores expired rows and rejects malformed input', async () => {
    const [id] = await seedStaleFacts(1);
    const expired = await engine.insertFacts(
      [{ fact: 'gone', kind: 'fact', source: 'test', row_num: 3, source_markdown_slug: 'people/erin-example', expired_at: new Date() }],
      { source_id: 'default' },
    );
    const vec = new Float32Array(dims).fill(0.25);
    expect(await engine.updateFactEmbeddings([
      { fact_id: id, embedding: vec },
      { fact_id: expired.ids[0], embedding: vec },
    ])).toBe(1);
    expect(await embeddedIds()).toEqual([id]);
    expect(await engine.updateFactEmbeddings([])).toBe(0);
    await expect(engine.updateFactEmbeddings([{ fact_id: 0, embedding: vec }])).rejects.toThrow(/invalid fact_id/);
    await expect(engine.updateFactEmbeddings([
      { fact_id: id, embedding: vec }, { fact_id: id, embedding: vec },
    ])).rejects.toThrow(/duplicate fact_id/);
    await expect(engine.updateFactEmbeddings([{ fact_id: id, embedding: new Float32Array(0) }])).rejects.toThrow(/invalid embedding/);
  });

  test('predicate parity: the literal facts_pending SQL matches listFactsNeedingEmbedding', async () => {
    await seedStaleFacts(4);
    await engine.insertFacts(
      [{ fact: 'expired one', kind: 'fact', source: 'test', row_num: 8, source_markdown_slug: 'people/frank-example', expired_at: new Date() }],
      { source_id: 'default' },
    );
    // Embed one so the fixture has all three states: pending, embedded, expired.
    const [first] = await engine.listFactsNeedingEmbedding({ limit: 1 });
    await engine.updateFactEmbeddings([{ fact_id: first.fact_id, embedding: new Float32Array(dims).fill(0.5) }]);

    const viaPredicate = await pendingCount();
    const viaSelector = (await engine.listFactsNeedingEmbedding({ limit: 1000 })).length;
    expect(viaPredicate).toBe(3);
    expect(viaSelector).toBe(viaPredicate);

    // Cursor semantics: afterId is exclusive and ordering is by id.
    const all = await engine.listFactsNeedingEmbedding({ limit: 1000 });
    const tail = await engine.listFactsNeedingEmbedding({ limit: 1000, afterId: all[0].fact_id });
    expect(tail.map((r) => r.fact_id)).toEqual(all.slice(1).map((r) => r.fact_id));
    for (const row of all) {
      expect(typeof row.fact_id).toBe('number');
      expect(typeof row.fact).toBe('string');
    }
  });
});
