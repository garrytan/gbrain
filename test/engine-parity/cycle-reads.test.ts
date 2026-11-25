/**
 * BrainEngine parity — the cycle, belief and segmented-write reads that ran through `executeRaw` and are typed members now
 * (src/core/engine-sql/cycle-reads.ts and segmented-writes.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    each member answers the same: the cycle's changed-page window (live pages after a cursor, by time then slug bytes), the
 *    belief ledger's orphan lifetimes, and a segmented page's write statements (the rewrite's page read and
 *    deleted_at restore and the live page) over an inline page that holds no segmented rows.
 *  - Regression: each of these was raw SQL, so a Rust brain refused the cycle window and the segmented fence rewrite.
 *  - Why existing coverage misses it: the cases of collate-belief-cycle-walks, tie-break-stale-orphan-edge-downgrade and
 *    forget-whole reach the members through their callers; none calls one directly or covers its edges (an unknown source,
 *    a NUL byte, an empty list).
 *  - Seam: none. Real engines, typed members only.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra }) as never;

/** Pages written in one transaction share one updated_at, so only the slug orders them. */
async function putTied(engine: BrainEngine, slugs: readonly string[]): Promise<void> {
  await engine.transaction(async tx => { for (const slug of slugs) await tx.putPage(slug, note(slug)); });
}

describe('engine parity: cycle and sync reads', () => {
  parityTest('the changed-page window lists live pages after a cursor by time then slug bytes', {
    methods: ['putPage', 'transaction', 'softDeletePage', 'readCycleListingInstant', 'listSourceChangedPagesAfter'],
  }, async (engine) => {
    await putTied(engine, ['ab', 'a0', 'a-z', 'gone']);
    await engine.softDeletePage('gone', { sourceId: 'default' });
    const all = await engine.listSourceChangedPagesAfter('default', null, '', 10);
    const cursor = all[0]!.updated_at;
    const after = await engine.listSourceChangedPagesAfter('default', cursor, 'a-z', 10);
    const instant = await engine.readCycleListingInstant();
    const answer = { slugs: all.map(r => r.slug), stampsAlike: new Set(all.map(r => r.updated_at)).size, micros: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor),
      after: after.map(r => r.slug), limited: (await engine.listSourceChangedPagesAfter('default', null, '', 2)).map(r => r.slug),
      otherSource: await engine.listSourceChangedPagesAfter('no-such-source', null, '', 10), instant: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(instant ?? '') };
    expect(answer).toEqual({ slugs: ['a-z', 'a0', 'ab'], stampsAlike: 1, micros: true, after: ['a0', 'ab'], limited: ['a-z', 'a0'], otherSource: [], instant: true });
    return answer;
  });

  parityTest('the orphan lifetimes read counts open lifetimes with no page and, deep, events naming a lifetime that does not exist', {
    methods: ['putPage', 'readLedgerSource', 'mintBeliefLifetime', 'insertBeliefEvents', 'softDeletePage', 'listOrphanLifetimes'],
  }, async (engine) => {
    const { incarnation } = (await engine.readLedgerSource('default'))!;
    const life = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    await engine.putPage('kept', note('kept'));
    await engine.putPage('soft', note('soft'));
    await engine.softDeletePage('soft', { sourceId: 'default' });
    for (const [n, slug] of [[1, 'kept'], [2, 'ab'], [3, 'a-z'], [4, 'soft']] as const) await engine.mintBeliefLifetime({ lifetime: life(n), sourceId: 'default', incarnation, slug, pageId: n });
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    const event = (key: string, ord: number, lifetime: string) => ({ event_key: key, source_id: 'default', source_incarnation: incarnation, page_lifetime: lifetime, slug: 'ab',
      subject_kind: 'page', subject_key: 'page', event_type: 'page.baseline', origin: 'live', trust_tier: 'unknown', writer_tier: null, tier_basis: 'unknown', visibility: 'world',
      publication_id: '00000000-0000-4000-8000-0000000000d2', ord, source_time: null, valid_from: null, valid_until: null, value: null, value_hash: null, prior_hash: null,
      state_hash: '', cause: '{}', claim_fp: null, purged: false, redacted_fields: null });
    await engine.insertBeliefEvents([event('a1', 0, ghost), event('a2', 1, ghost), event('a3', 2, life(2))]);
    const answer = { shallow: await engine.listOrphanLifetimes('default', 1, false), noDeep: (await engine.listOrphanLifetimes('default', 9, false)).count,
      deep: await engine.listOrphanLifetimes('default', 9, true), minimum: (await engine.listOrphanLifetimes('default', 0, true)).samples.length,
      unknown: (await engine.listOrphanLifetimes('no-such-source', 9, true)).count };
    expect(answer).toEqual({ shallow: { count: 2, samples: [{ slug: 'a-z', page_lifetime: life(3), reason: 'no_page' }] }, noDeep: 2,
      deep: { count: 3, samples: [{ slug: 'a-z', page_lifetime: life(3), reason: 'no_page' }, { slug: 'ab', page_lifetime: life(2), reason: 'no_page' }, { slug: 'ab', page_lifetime: ghost, reason: 'no_lifetime' }] },
      minimum: 1, unknown: 0 });
    return answer;
  });

  parityTest('a segmented page\'s write statements answer an inline page, a missing page and an empty list', {
    methods: ['putPage', 'addTag', 'readSegmentedRewritePage', 'restorePageDeletedAt', 'readSegmentedProjectionPage', 'listChunkedOccurrences', 'hasStaleSegmentChunks',
      'retireStaleSegmentChunks', 'readSegmentedLivePage', 'readRetiredChunkVectors'],
  }, async (engine) => {
    const id = (await engine.putPage('notes/x', note('x'))).id;
    for (const tag of ['b', 'a', 'B']) await engine.addTag('notes/x', tag);
    const read = await engine.readSegmentedRewritePage(id);
    const live = await engine.readSegmentedLivePage(id);
    await engine.restorePageDeletedAt(id, '2027-02-01T00:00:00.000Z');
    const deleted = await engine.readSegmentedRewritePage(id);
    const answer = { read: read && { slug: read.slug, storage: read.body_storage, generation: Number(read.body_generation), deleted: read.deleted_at, tags: read.tags },
      live: live && { storage: live.body_storage, generation: Number(live.body_generation), title: live.title, type: live.type },
      deleted: deleted?.deleted_at === null ? null : new Date(deleted!.deleted_at as string).toISOString(), missing: await engine.readSegmentedRewritePage(id + 999),
      missingLive: await engine.readSegmentedLivePage(id + 999), projection: await engine.readSegmentedProjectionPage('default', 'notes/x'),
      chunked: await engine.listChunkedOccurrences(id, [1, 2], 1), noChunked: await engine.listChunkedOccurrences(id, [], 1),
      stale: await engine.hasStaleSegmentChunks(id, 1, []), retired: await engine.retireStaleSegmentChunks(id, 1, [], 10),
      vectors: await engine.readRetiredChunkVectors(id, [1], 'embedding'), noVectors: await engine.readRetiredChunkVectors(id, [], 'embedding') };
    expect(answer).toEqual({ read: { slug: 'notes/x', storage: 'inline', generation: 0, deleted: null, tags: ['B', 'a', 'b'] }, live: { storage: 'inline', generation: 0, title: 'x', type: 'note' },
      deleted: '2027-02-01T00:00:00.000Z', missing: null, missingLive: null, projection: null, chunked: [], noChunked: [], stale: false, retired: 0, vectors: [], noVectors: [] });
    return answer;
  });
});
