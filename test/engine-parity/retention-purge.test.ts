/**
 * BrainEngine parity — the retention purge's bookkeeping (src/core/persistence/derived-origin-hold.ts releaseStaleHolds,
 * readOwedPurges, pruneOwedPurges and pruneDerivedOriginParks; src/core/persistence/purge-parks.ts prunePurgeParks,
 * recordPurgeFailure, clearPurgePark and notePurgeSourceWriter; the candidate reads of
 * src/core/persistence/purge-deleted.ts selectPurgeCandidates; the expiring-origin read of src/core/repair/origin-carry.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a park's owner hold is dropped once its page is live again or its tombstone is not the held one, and kept
 *    while it is; the owed-purge records list and survive only while their tombstone is the recorded one; a park survives
 *    only while its page is a tombstone; the expiring-origin read lists the expired atoms and pages the privacy rules hide,
 *    by id; the managed candidate read lists the expired tombstones of active sources that no identity-downgrade hold or
 *    origin park keeps (a released origin is listed in spite of its park, a held id is not), oldest first, and the
 *    released-origin read lists the released tombstones under the other holds; a failure record is written once and then
 *    counts each further failure, survives only while its tombstone is the recorded one, and a source's records are
 *    marked while its writer is not active and dropped (with their count) once it is: each answers the same, and leaves
 *    the same records, on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that keeps a stale hold leaves an owner's purge waiting on a tombstone that is gone; one that
 *    keeps or drops the wrong record purges a page a hold keeps, or purges nothing the owner asked for; one that lists
 *    a held or archived page as a candidate removes a page the rename recovery, an origin park or an archived source
 *    keeps. The Rust engine has no SQL, so each statement has to exist as a typed member it can serve.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so only the PGLite and Postgres suites (test/derived-origin-carry-*.test.ts, test/purge-parks*.test.ts)
 *    exercised them, and the retention purge on Rust stopped at the pre-write check before reaching them.
 *  - Seam: the exported caller functions above, and the candidate and expiring-origin members, called with the arm's
 *    engine. Pages are seeded through putPage, softDeletePage and restorePage; the records are read back through
 *    readOpCheckpointDoc. Generated values (park and failure times, tombstone microseconds, page ids, the cutoff) are
 *    replaced by labels.
 */
import { describe, expect } from 'bun:test';
import { archiveSource, createSource, parityArms, recordIdentityDowngrade } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  DERIVED_ORIGIN_PARK_OP, OWED_PURGE_OP, parkDerivedOrigin, pruneDerivedOriginParks, pruneOwedPurges, readOwedPurges, recordOwedPurge,
  releaseStaleHolds,
} from '../../src/core/persistence/derived-origin-hold.ts';
import { PURGE_PARK_OP, clearPurgePark, notePurgeSourceWriter, prunePurgeParks, purgeParkKey, recordPurgeFailure } from '../../src/core/persistence/purge-parks.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter });

/** Puts a page and answers its id. */
async function put(engine: BrainEngine, slug: string, frontmatter: Record<string, unknown> = {}, sourceId = SRC, type = 'note'): Promise<number> {
  await engine.putPage(slug, { ...note(slug, `Body of ${slug}.`, frontmatter), type } as never, { sourceId } as never);
  const id = await engine.readLivePageIdBySlug(slug, sourceId);
  if (id === null) throw new Error(`no page ${slug}`);
  return id;
}

/** A tombstone's `deleted_us`, read off the owed-purge record the engine writes for it (then removed again). */
async function deletedUs(engine: BrainEngine, id: number): Promise<string> {
  await recordOwedPurge(engine, id, 'probe');
  const doc = await engine.readOpCheckpointDoc(OWED_PURGE_OP, String(id)) as { deleted_us: string };
  await engine.deleteOriginHoldRows(OWED_PURGE_OP, [id]);
  return doc.deleted_us;
}

/** The record an op keeps under `fingerprint`, with its generated values replaced by a label. */
async function record(engine: BrainEngine, op: string, fingerprint: string, ids: Record<number, string> = {}): Promise<unknown> {
  const doc = await engine.readOpCheckpointDoc(op, fingerprint) as Record<string, unknown> | null;
  if (!doc) return null;
  const out: Record<string, unknown> = { ...doc };
  if (typeof out.page_id === 'number' && ids[out.page_id]) out.page_id = ids[out.page_id];
  for (const key of ['parked_at', 'deleted_us', 'held_deleted_us', 'failed_at']) if (typeof out[key] === 'string' && out[key]) out[key] = `<${key}>`;
  return out;
}

const park = (id: number, slug: string, held?: string) =>
  ({ source_id: SRC, slug, page_id: id, blocking_slug: 'r/dep', code: 'label_failed', reason: 'blocked', ...(held ? { held_request_id: held } : {}) });

describe('engine parity: the retention purge bookkeeping', () => {
  parityTest('releaseStaleHolds drops the owner hold of a park whose page is live again or deleted again, and keeps a current one', {
    methods: ['putPage', 'softDeletePage', 'restorePage', 'readLivePageIdBySlug', 'readOpCheckpointDoc', 'upsertDerivedOriginPark', 'recordOwedPurgeRows', 'releaseStaleOriginParkHolds'],
  }, async (engine) => {
    const ids: Record<number, string> = {};
    for (const slug of ['r/kept', 'r/restored', 'r/again', 'r/plain']) ids[await put(engine, slug)] = slug;
    const id = (slug: string) => Number(Object.keys(ids).find(k => ids[Number(k)] === slug));
    for (const slug of ['r/kept', 'r/restored', 'r/again', 'r/plain']) await engine.softDeletePage(slug);
    for (const slug of ['r/kept', 'r/restored', 'r/again']) {
      await parkDerivedOrigin(engine, park(id(slug), slug, `req-${slug}`));
      await recordOwedPurge(engine, id(slug), `req-${slug}`);
    }
    await parkDerivedOrigin(engine, park(id('r/plain'), 'r/plain'));
    await engine.restorePage('r/restored');
    await engine.restorePage('r/again');
    await engine.softDeletePage('r/again');
    await releaseStaleHolds(engine);
    const parks = Object.fromEntries(await Promise.all(['r/kept', 'r/restored', 'r/again', 'r/plain'].map(async slug => [slug, await record(engine, DERIVED_ORIGIN_PARK_OP, String(id(slug)), ids)])));
    expect((parks['r/kept'] as Record<string, unknown>).held_request_id).toBe('req-r/kept');
    expect((parks['r/again'] as Record<string, unknown>).held_request_id).toBeUndefined();
    return parks;
  });

  parityTest('readOwedPurges lists the records whose tombstone is the recorded one, and pruneOwedPurges removes the others', {
    methods: ['putPage', 'softDeletePage', 'restorePage', 'readLivePageIdBySlug', 'readOpCheckpointDoc', 'recordOwedPurgeRows', 'listOwedPurgeRecords', 'pruneOwedPurgeRecords'],
  }, async (engine) => {
    const owed = await put(engine, 'w/owed');
    const back = await put(engine, 'w/back');
    const again = await put(engine, 'w/again');
    const ids: Record<number, string> = { [owed]: '<owed>', [back]: '<back>', [again]: '<again>' };
    for (const slug of ['w/owed', 'w/back', 'w/again']) await engine.softDeletePage(slug);
    await recordOwedPurge(engine, owed, 'req-owed');
    await recordOwedPurge(engine, back, 'req-back');
    await recordOwedPurge(engine, again, 'req-again');
    const before = (await readOwedPurges(engine)).map(row => ({ ...row, page_id: ids[row.page_id], deleted_us: '<deleted_us>' }));
    await engine.restorePage('w/back');
    await engine.restorePage('w/again');
    await engine.softDeletePage('w/again');
    const listed = (await readOwedPurges(engine)).map(row => ({ ...row, page_id: ids[row.page_id], deleted_us: '<deleted_us>' }));
    await pruneOwedPurges(engine);
    const after = { owed: await record(engine, OWED_PURGE_OP, String(owed), ids), back: await record(engine, OWED_PURGE_OP, String(back), ids), again: await record(engine, OWED_PURGE_OP, String(again), ids) };
    expect(listed.map(row => row.page_id)).toEqual(['<owed>']);
    expect(after.back).toBeNull();
    return { before, listed, after };
  });

  parityTest('pruneDerivedOriginParks keeps the parks of tombstones and removes those of live and restored pages', {
    methods: ['putPage', 'softDeletePage', 'restorePage', 'readLivePageIdBySlug', 'readOpCheckpointDoc', 'upsertDerivedOriginPark', 'pruneOriginParkRecords'],
  }, async (engine) => {
    const gone = await put(engine, 'k/gone');
    const live = await put(engine, 'k/live');
    const back = await put(engine, 'k/back');
    await engine.softDeletePage('k/gone');
    await engine.softDeletePage('k/back');
    for (const [id, slug] of [[gone, 'k/gone'], [live, 'k/live'], [back, 'k/back']] as const) await parkDerivedOrigin(engine, park(id, slug));
    await engine.restorePage('k/back');
    await pruneDerivedOriginParks(engine);
    const ids = { [gone]: '<gone>', [live]: '<live>', [back]: '<back>' };
    const after = { gone: await record(engine, DERIVED_ORIGIN_PARK_OP, String(gone), ids), live: await record(engine, DERIVED_ORIGIN_PARK_OP, String(live), ids), back: await record(engine, DERIVED_ORIGIN_PARK_OP, String(back), ids) };
    expect(after.gone).not.toBeNull();
    expect(after.live).toBeNull();
    return after;
  });

  parityTest('listExpiringOriginPages lists the expired atoms and hidden pages by id, and nothing younger than the cutoff', {
    methods: ['putPage', 'softDeletePage', 'readLivePageIdBySlug', 'listExpiringOriginPages'],
  }, async (engine) => {
    const slugs = ['x/private', 'x/atom', 'x/plain', 'x/live-private'];
    await put(engine, 'x/private', { visibility: 'private' });
    await put(engine, 'x/atom', {}, SRC, 'atom');
    await put(engine, 'x/plain');
    await put(engine, 'x/live-private', { visibility: 'private' });
    for (const slug of slugs.slice(0, 3)) await engine.softDeletePage(slug);
    const expired = await engine.listExpiringOriginPages('0');
    const young = await engine.listExpiringOriginPages('1000');
    expect(expired.map(row => row.slug)).toEqual(['x/private', 'x/atom']);
    expect(expired.every(row => typeof row.id === 'number')).toBe(true);
    return { expired: expired.map(({ id: _id, ...row }) => row), young };
  });

  parityTest('the candidate reads leave out held, parked, archived and young tombstones, and a released origin passes its park', {
    methods: ['putPage', 'softDeletePage', 'readLivePageIdBySlug', 'upsertDerivedOriginPark', 'listManagedPurgeCandidates', 'listReleasedPurgeOrigins'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const ids: Record<string, number> = {};
    for (const slug of ['c/plain', 'c/parked', 'c/released', 'c/held', 'c/downgrade', 'c/live']) ids[slug] = await put(engine, slug);
    ids['c/archived'] = await put(engine, 'c/archived', {}, OTHER);
    for (const slug of ['c/plain', 'c/parked', 'c/released', 'c/held', 'c/downgrade']) await engine.softDeletePage(slug);
    await engine.softDeletePage('c/archived', { sourceId: OTHER });
    await archiveSource(engine, backend, OTHER);
    await recordIdentityDowngrade(engine, backend, SRC, 'c/downgrade', {});
    for (const slug of ['c/parked', 'c/released']) await parkDerivedOrigin(engine, park(ids[slug]!, slug));
    const label = <R extends { id?: unknown; slug: string }>(row: R) => ({ ...row, ...(row.id !== undefined ? { id: row.id === ids[row.slug] ? '<id>' : row.id } : {}) });
    const managed = (await engine.listManagedPurgeCandidates('0', [ids['c/released']!], [ids['c/held']!]))
      .map(row => label({ ...row, cutoff: typeof row.cutoff === 'string' && row.cutoff ? '<cutoff>' : row.cutoff, deleted_us: /^\d+$/.test(String(row.deleted_us)) ? '<deleted_us>' : row.deleted_us }));
    const young = await engine.listManagedPurgeCandidates('1000', [], []);
    const released = (await engine.listReleasedPurgeOrigins([ids['c/released']!, ids['c/parked']!, ids['c/downgrade']!, ids['c/plain']!, ids['c/live']!], [ids['c/plain']!], '0'))
      .map(row => ({ slug: row.slug, source_id: row.source_id, deleted_at: row.deleted_at instanceof Date ? '<Date>' : typeof row.deleted_at }))
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    expect(managed.map(row => row.slug)).toEqual(['c/plain', 'c/released']);
    expect(released.map(row => row.slug)).toEqual(['c/parked', 'c/released']);
    return { managed, young, released };
  });

  parityTest('prunePurgeParks keeps the failure records of current tombstones, and a repeat failure counts once more', {
    methods: ['putPage', 'softDeletePage', 'restorePage', 'readLivePageIdBySlug', 'readOpCheckpointDoc', 'recordOwedPurgeRows', 'deleteOriginHoldRows', 'recordPurgeFailureRecord', 'deletePurgeParkRecord', 'prunePurgeParkRecords'],
  }, async (engine) => {
    const live = await put(engine, 'f/live');
    const back = await put(engine, 'f/back');
    const cleared = await put(engine, 'f/cleared');
    for (const slug of ['f/live', 'f/back', 'f/cleared']) await engine.softDeletePage(slug);
    const keys = {
      live: purgeParkKey(SRC, 'f/live', await deletedUs(engine, live)),
      stale: purgeParkKey(SRC, 'f/live', '1'),
      back: purgeParkKey(SRC, 'f/back', await deletedUs(engine, back)),
      cleared: purgeParkKey(SRC, 'f/cleared', await deletedUs(engine, cleared)),
    };
    const fail = (slug: string, deleted_us: string, code: string | null, reason: string) => recordPurgeFailure(engine, { source_id: SRC, slug, deleted_us, code, reason });
    await fail('f/live', JSON.parse(keys.live)[2], 'write_failed', 'first');
    const first = await record(engine, PURGE_PARK_OP, keys.live);
    await fail('f/live', JSON.parse(keys.live)[2], null, 'second');
    const second = await record(engine, PURGE_PARK_OP, keys.live);
    await fail('f/live', '1', 'write_failed', 'stale');
    await fail('f/back', JSON.parse(keys.back)[2], 'write_failed', 'back');
    await fail('f/cleared', JSON.parse(keys.cleared)[2], 'write_failed', 'cleared');
    await clearPurgePark(engine, keys.cleared);
    await engine.restorePage('f/back');
    await prunePurgeParks(engine);
    const after = Object.fromEntries(await Promise.all(Object.entries(keys).map(async ([name, key]) => [name, await record(engine, PURGE_PARK_OP, key)])));
    expect((second as Record<string, unknown>).failures).toBe(2);
    expect(after.stale).toBeNull();
    return { first, second, after };
  });

  parityTest('notePurgeSourceWriter marks a source\'s failure records while its writer is not active and drops them, with their count, once it is', {
    methods: ['putPage', 'readLivePageIdBySlug', 'readOpCheckpointDoc', 'recordPurgeFailureRecord', 'markPurgeParksInactive', 'dropRearmedPurgeParks'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    await put(engine, 'n/a');
    await put(engine, 'n/b');
    await put(engine, 'n/c', {}, OTHER);
    const keys = { a: purgeParkKey(SRC, 'n/a', '10'), b: purgeParkKey(SRC, 'n/b', '20'), c: purgeParkKey(OTHER, 'n/c', '30') };
    await recordPurgeFailure(engine, { source_id: SRC, slug: 'n/a', deleted_us: '10', code: null, reason: 'a' });
    await recordPurgeFailure(engine, { source_id: SRC, slug: 'n/b', deleted_us: '20', code: null, reason: 'b' });
    await recordPurgeFailure(engine, { source_id: OTHER, slug: 'n/c', deleted_us: '30', code: null, reason: 'c' });
    const read = async () => Object.fromEntries(await Promise.all(Object.entries(keys).map(async ([name, key]) => [name, await record(engine, PURGE_PARK_OP, key)])));
    const noneMarked = await notePurgeSourceWriter(engine, SRC, true);
    const inactive = await notePurgeSourceWriter(engine, SRC, false);
    const marked = await read();
    await notePurgeSourceWriter(engine, SRC, false);
    const markedAgain = await read();
    const rearmed = await notePurgeSourceWriter(engine, SRC, true);
    const otherRearmed = await notePurgeSourceWriter(engine, OTHER, true);
    const after = await read();
    expect(rearmed).toBe(2);
    expect(after.a).toBeNull();
    expect(after.c).not.toBeNull();
    return { noneMarked, inactive, marked, markedAgain, rearmed, otherRearmed, after };
  });
});
