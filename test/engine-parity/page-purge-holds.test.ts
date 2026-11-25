/**
 * BrainEngine parity — the parks and owed-purge records a purge of a derived-origin page keeps
 * (src/core/repair/origin-carry.ts parkUncarriedInPurge; src/core/persistence/derived-origin-hold.ts parkDerivedOrigin,
 * recordOwedPurge, clearOwedPurges and clearDerivedOriginParks).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the in-purge recheck finds the pages among the ids that are privacy origins (an atom, or a page the privacy rules
 *    hide) and still hold a dependent, leaves out an origin that is already parked unless it is told to recheck parked ones, and
 *    parks each (its page, the blocking page, the code and reason, the owner's request when given); a park keeps the owner's
 *    request an earlier park of the page held when the new one names none, and replaces it when the new one does; an owed-purge
 *    record is written for a tombstone only, once per tombstone, and binds the park that holds the same request to that
 *    tombstone; clearing removes the records of the pages named: each answers the same, and leaves the same records, on every
 *    engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) over one seeded origin with
 *    pages around it (a dependent, a plain page, a live and a deleted origin).
 *  - Regression: an engine that parks a page its dependents no longer need, skips a parked origin the purge must recheck, drops the
 *    owner's request on a re-park, or binds a hold to the wrong tombstone lets a purge remove the only privacy of a page, or
 *    leaves an owner's purge unfinished with no record of it. The Rust engine has no SQL, so each statement has to exist as a typed
 *    member it can serve.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call (D18), so
 *    only the PGLite and Postgres suites (test/derived-origin-carry-*.test.ts, test/concept-purge-rebuild-9653.test.ts) exercised
 *    them.
 *  - Seam: the exported functions above, called with the arm's engine (a transaction handle where the purge calls them in one).
 *    Pages are seeded through putPage and softDeletePage; the records are read back through readOpCheckpointDoc. Generated values
 *    (park time, tombstone microseconds, the page id the case seeded) are replaced by a label.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { DERIVED_ORIGIN_PARK_OP, OWED_PURGE_OP, clearDerivedOriginParks, clearOwedPurges, parkDerivedOrigin, recordOwedPurge } from '../../src/core/persistence/derived-origin-hold.ts';
import { parkUncarriedInPurge } from '../../src/core/repair/origin-carry.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter });

/** The page's id in the source, by slug. */
async function idOf(engine: BrainEngine, slug: string, sourceId = SRC): Promise<number> {
  const id = await engine.readLivePageIdBySlug(slug, sourceId);
  if (id === null) throw new Error(`no page ${slug}`);
  return id;
}

/** The record an op keeps for a page, as the readers see it, with its generated values replaced by a label. */
async function record(engine: BrainEngine, op: string, id: number): Promise<unknown> {
  const doc = await engine.readOpCheckpointDoc(op, String(id)) as Record<string, unknown> | null;
  if (!doc) return null;
  const out: Record<string, unknown> = { ...doc };
  if (out.page_id === id) out.page_id = '<page_id>';
  for (const key of ['parked_at', 'deleted_us', 'held_deleted_us']) if (key in out) out[key] = typeof out[key] === 'string' && out[key] ? `<${key}>` : out[key];
  return out;
}

/** One private origin, a dependent that is private only through it, and a page that is neither. */
async function seedOrigin(engine: BrainEngine): Promise<{ origin: number; dependent: number; plain: number }> {
  await engine.putPage('o/origin', note('Origin', 'The private origin.', { visibility: 'private' }));
  await engine.putPage('o/dependent', note('Dependent', 'Derived from the origin.', { derived_from: ['o/origin'] }));
  await engine.putPage('o/plain', note('Plain', 'Plain.'));
  return { origin: await idOf(engine, 'o/origin'), dependent: await idOf(engine, 'o/dependent'), plain: await idOf(engine, 'o/plain') };
}

describe('engine parity: the parks and owed-purge records of a derived-origin purge', () => {
  parityTest('parkUncarriedInPurge parks an origin that still has a dependent, skips a parked one unless told to recheck, and passes over a plain page', {
    methods: ['putPage', 'readLivePageIdBySlug', 'readOpCheckpointDoc', 'transaction', 'listPurgeOrigins', 'upsertDerivedOriginPark'],
  }, async (engine) => {
    const { origin, dependent, plain } = await seedOrigin(engine);
    const strip = (parks: Array<{ parked_at: unknown; page_id: unknown; slug: string }>) => parks.map(({ parked_at: _parked, page_id, ...rest }) => ({ ...rest, page_id: page_id === origin ? '<origin>' : page_id }));
    const none = await engine.transaction(tx => parkUncarriedInPurge(tx, []));
    const plainOnly = await engine.transaction(tx => parkUncarriedInPurge(tx, [plain, dependent]));
    const parked = strip(await engine.transaction(tx => parkUncarriedInPurge(tx, [origin, plain], { heldRequestId: 'req-1' })) as never);
    const afterPark = await record(engine, DERIVED_ORIGIN_PARK_OP, origin);
    const skipped = await engine.transaction(tx => parkUncarriedInPurge(tx, [origin]));
    const rechecked = strip(await engine.transaction(tx => parkUncarriedInPurge(tx, [origin], { recheckParked: true })) as never);
    const afterRecheck = await record(engine, DERIVED_ORIGIN_PARK_OP, origin);
    expect(parked.map(p => p.slug)).toEqual(['o/origin']);
    expect(skipped).toEqual([]);
    return { none, plainOnly, parked, afterPark, skipped, rechecked, afterRecheck, dependent: await record(engine, DERIVED_ORIGIN_PARK_OP, dependent) };
  });

  parityTest('parkDerivedOrigin keeps the owner request an earlier park held when the new park names none, and replaces it when the new one does', {
    methods: ['putPage', 'readLivePageIdBySlug', 'readOpCheckpointDoc', 'upsertDerivedOriginPark', 'deleteOriginHoldRows'],
  }, async (engine) => {
    const { origin } = await seedOrigin(engine);
    const base = { source_id: SRC, slug: 'o/origin', page_id: origin, blocking_slug: 'o/dependent', code: 'revision_conflict', reason: 'changed' };
    await parkDerivedOrigin(engine, { ...base, held_request_id: 'req-1', held_deleted_us: '111' });
    const first = await record(engine, DERIVED_ORIGIN_PARK_OP, origin);
    await parkDerivedOrigin(engine, { ...base, reason: 'again' });
    const kept = await record(engine, DERIVED_ORIGIN_PARK_OP, origin);
    await parkDerivedOrigin(engine, { ...base, reason: 'owner', held_request_id: 'req-2' });
    const replaced = await record(engine, DERIVED_ORIGIN_PARK_OP, origin);
    await clearDerivedOriginParks(engine, [origin]);
    const cleared = await record(engine, DERIVED_ORIGIN_PARK_OP, origin);
    await parkDerivedOrigin(engine, { ...base, blocking_slug: null, code: null });
    const nulls = await record(engine, DERIVED_ORIGIN_PARK_OP, origin);
    expect(cleared).toBeNull();
    return { first, kept, replaced, cleared, nulls };
  });

  parityTest('recordOwedPurge writes one record per tombstone, binds the park that holds the request to it, and the clears remove the records named', {
    methods: ['putPage', 'softDeletePage', 'readLivePageIdBySlug', 'readOpCheckpointDoc', 'upsertDerivedOriginPark', 'recordOwedPurgeRows', 'deleteOriginHoldRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    await engine.putPage('o/live', note('Live', 'Still live.'));
    await engine.putPage('o/gone', note('Gone', 'Soft deleted.'));
    await engine.putPage('o/gone', note('Gone', 'Held by another source too.'), { sourceId: OTHER } as never);
    const live = await idOf(engine, 'o/live');
    const gone = await idOf(engine, 'o/gone');
    await engine.softDeletePage('o/gone');
    await recordOwedPurge(engine, live, 'req-live');
    const liveRecord = await record(engine, OWED_PURGE_OP, live);
    await recordOwedPurge(engine, gone, 'req-1');
    const owed = await record(engine, OWED_PURGE_OP, gone);
    await recordOwedPurge(engine, gone, 'req-2');
    const sameTombstone = await record(engine, OWED_PURGE_OP, gone);
    await parkDerivedOrigin(engine, { source_id: SRC, slug: 'o/gone', page_id: gone, blocking_slug: 'o/live', code: null, reason: 'held', held_request_id: 'req-1' });
    await recordOwedPurge(engine, gone, 'req-other');
    const unboundPark = await record(engine, DERIVED_ORIGIN_PARK_OP, gone);
    await recordOwedPurge(engine, gone, 'req-1');
    const boundPark = await record(engine, DERIVED_ORIGIN_PARK_OP, gone);
    await clearOwedPurges(engine, []);
    await clearOwedPurges(engine, [live, gone]);
    const cleared = await record(engine, OWED_PURGE_OP, gone);
    const parkKept = await record(engine, DERIVED_ORIGIN_PARK_OP, gone);
    expect(liveRecord).toBeNull();
    expect(cleared).toBeNull();
    return { liveRecord, owed, sameTombstone, unboundPark, boundPark, cleared, parkKept };
  });

  parityTest('the members report the origins listed, the rows written for an owed purge and the records removed', {
    methods: ['putPage', 'softDeletePage', 'readLivePageIdBySlug', 'listPurgeOrigins', 'upsertDerivedOriginPark', 'recordOwedPurgeRows', 'deleteOriginHoldRows'],
  }, async engine => {
    const { origin, dependent, plain } = await seedOrigin(engine);
    const slugs = async (ids: number[], recheck: boolean) => (await engine.listPurgeOrigins(ids, recheck)).map(row => row.slug);
    const listed = await slugs([plain, dependent, origin, origin], false);
    await engine.upsertDerivedOriginPark(origin, { source_id: SRC, slug: 'o/origin', page_id: origin, blocking_slug: null, code: null, reason: 'held', parked_at: '2026-01-01T00:00:00.000Z' });
    const parked = await slugs([origin], false);
    const rechecked = await slugs([origin], true);
    await engine.softDeletePage('o/origin');
    const owed = [await engine.recordOwedPurgeRows(plain, 'req-1'), await engine.recordOwedPurgeRows(origin, 'req-1'), await engine.recordOwedPurgeRows(origin, 'req-2'), await engine.recordOwedPurgeRows(origin, 'req-1')];
    const removed = [await engine.deleteOriginHoldRows(OWED_PURGE_OP, [plain, origin, origin]), await engine.deleteOriginHoldRows(DERIVED_ORIGIN_PARK_OP, [origin]), await engine.deleteOriginHoldRows(DERIVED_ORIGIN_PARK_OP, [origin])];
    expect(listed).toEqual(['o/origin', 'o/dependent']);
    return { listed, parked, rechecked, owed, removed };
  });
});
