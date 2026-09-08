import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

/**
 * Keyset pagination cursor precision (found 2026-08-28 on the email-facts run).
 *
 * `listPages` returns `updated_at` as a JS Date (millisecond precision) while
 * the column stores microseconds. A caller feeding that Date back as the
 * `updatedAfterKeyset` cursor hits `p.updated_at > cursor` for every row in
 * the cursor's millisecond (the last row of each batch re-selected; a batch
 * of same-millisecond rows never advances). `listPages` now also projects
 * `updated_at_iso` at column precision; a caller that resumes from it walks
 * the `(updated_at, slug)` order exactly, index-friendly, whatever the slug
 * order inside a millisecond.
 */
describe('listPages keyset walk with microsecond timestamps', () => {
  let engine: PGLiteEngine;
  const N = 25;
  // Six rows in ONE millisecond whose slug order is the REVERSE of their
  // microsecond order: rev-05 has the earliest microsecond, rev-00 the latest.
  const REV = 6;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (let i = 0; i < N; i++) {
      const slug = `ks/page-${String(i).padStart(2, '0')}`;
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, frontmatter: {} });
      // All 25 rows inside ONE millisecond, one microsecond apart.
      await engine.executeRaw(
        `UPDATE pages SET updated_at = ('2026-08-10T12:00:00.000100Z'::timestamptz + ($1::int * interval '1 microsecond')) WHERE slug = $2 AND source_id = 'default'`,
        [i, slug],
      );
    }
    for (let i = 0; i < REV; i++) {
      const slug = `ks/rev-${String(i).padStart(2, '0')}`;
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, frontmatter: {} });
      await engine.executeRaw(
        `UPDATE pages SET updated_at = ('2026-08-10T12:00:00.002100Z'::timestamptz + ($1::int * interval '1 microsecond')) WHERE slug = $2 AND source_id = 'default'`,
        [REV - 1 - i, slug],
      );
    }
    await engine.putPage('ks/later', { type: 'note', title: 'later', compiled_truth: 'later', frontmatter: {} });
    await engine.executeRaw(
      `UPDATE pages SET updated_at = '2026-08-10T12:00:00.001000Z'::timestamptz WHERE slug = 'ks/later' AND source_id = 'default'`,
    );
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  async function walk(limit: number): Promise<{ seen: string[]; batches: number }> {
    const seen: string[] = [];
    let keyset: { updatedAt: string; slug: string } | undefined;
    let batches = 0;
    while (batches < 40) {
      batches++;
      const batch = await engine.listPages({
        type: 'note' as never,
        sourceId: 'default',
        limit,
        sort: 'updated_asc',
        ...(keyset ? { updatedAfterKeyset: keyset } : {}),
      });
      if (batch.length === 0) break;
      for (const p of batch) seen.push(p.slug);
      const last = batch[batch.length - 1];
      expect(last.updated_at_iso).toMatch(/\.\d{6}Z$/);
      keyset = { updatedAt: last.updated_at_iso!, slug: last.slug };
      if (batch.length < limit) break;
    }
    return { seen, batches };
  }

  const TOTAL = N + 1 + REV;

  test('yields every row exactly once and terminates', async () => {
    const { seen, batches } = await walk(10);
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    expect(batches).toBeLessThanOrEqual(5);
    // Within the first millisecond, rows come back ordered by slug.
    const firstBucket = seen.slice(0, N);
    expect(firstBucket).toEqual([...firstBucket].sort());
  });

  test('rows in a later millisecond come after the whole bucket', async () => {
    const { seen } = await walk(10);
    expect(seen[N]).toBe('ks/later');
  });

  test('a batch boundary inside a bucket whose slug order runs against microsecond order skips nothing', async () => {
    // limit 4 puts boundaries inside the 6-row reversed cluster.
    const { seen } = await walk(4);
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    const rev = seen.filter((s) => s.startsWith('ks/rev-'));
    // The cluster comes back in microsecond order (the reverse of slug order).
    expect(rev).toEqual([...rev].sort().reverse());
    expect(rev).toHaveLength(REV);
  });

  test('a millisecond-rounded cursor is the documented failure: it re-selects the bucket', async () => {
    const first = await engine.listPages({ type: 'note' as never, sourceId: 'default', limit: 10, sort: 'updated_asc' });
    const last = first[first.length - 1];
    const again = await engine.listPages({
      type: 'note' as never, sourceId: 'default', limit: 10, sort: 'updated_asc',
      updatedAfterKeyset: { updatedAt: new Date(last.updated_at).toISOString(), slug: last.slug },
    });
    // Rows already returned come back: exactly what resuming from updated_at_iso avoids.
    expect(again.some((p) => first.some((q) => q.slug === p.slug))).toBe(true);
  });
});
