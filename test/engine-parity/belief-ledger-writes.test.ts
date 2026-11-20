/**
 * BrainEngine parity — the belief ledger's write path (engine-sql/collate-belief-writes.ts): the event insert
 * (`insertBeliefEvents`), the coverage reads `enableBeliefLedger` makes (`readBeliefCoverage`, `hasBaselineEvent`,
 * `countBaselinedSlugs`, `listPendingBaselineSlugs`), the purge tombstone probe (`listPurgedFingerprints`), the redaction
 * register (`readBeliefRedactions`, `insertBeliefRedaction`, `releaseBeliefRedactions`) and the commit marks
 * (`recordBeliefCommitMarks`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    `insertBeliefEvents` inserts the rows in `ord` order and skips a row whose event key exists, returning how many it
 *    inserted; `readBeliefCoverage` answers the newest coverage event of the source's current incarnation other than
 *    `coverage.restored`; `listPendingBaselineSlugs` lists the slugs after the cursor, outside the skip list and not yet
 *    baselined by the run, in byte order and at most the limit, pages first and page-less fact subjects with them;
 *    `hasBaselineEvent` and `countBaselinedSlugs` count a run's baseline events by slug; the register read matches a
 *    subject key or a field hash and shows the release; the tombstone probe names the fact fingerprints a purge covers.
 *  - Regression: all of these ran through `executeRaw`, which the Rust engine refuses, so a Rust brain could not
 *    open a belief batch or append a belief event at all.
 *  - Why existing coverage misses it: test/belief-ledger-coverage.test.ts and the purge suites run the SQL engines only.
 *  - Seam: pages and fact purges are written through typed engine members. The commit marks have no typed read, so the
 *    SQL arms read them back with harness-only SQL; the Rust store's own test (rust/crates/gbrain-store/tests/
 *    collate_belief_writes.rs) reads them there.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BeliefEventRow } from '../../src/core/engine-sql/collate-belief-writes.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { BYTE_SLUGS, MIXED_SLUGS } from '../helpers/byte-order.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const PUBLICATION = '6f9619ff-8b86-4d01-b42d-00cf4fc964f1';
const REQUEST = '6F9619FF-8B86-4D01-B42D-00CF4FC964FF';
const STALE_INCARNATION = '11111111-2222-4333-8444-555555555555';
let counter = 0;

async function incarnation(engine: BrainEngine): Promise<string> {
  return (await engine.readLedgerSource(SRC))!.incarnation;
}

/** A ledger row; `event_key` is unique per call unless the caller sets it. */
function event(inc: string, over: Partial<BeliefEventRow>): BeliefEventRow {
  return {
    event_key: (++counter).toString(16).padStart(8, '0'), source_id: SRC, source_incarnation: inc, page_lifetime: null, slug: '', subject_kind: 'coverage',
    subject_key: '["coverage"]', event_type: 'coverage.started', origin: 'live', trust_tier: 'unknown', writer_tier: null, tier_basis: 'unknown', visibility: 'private',
    publication_id: PUBLICATION, ord: 0, source_time: null, valid_from: null, valid_until: null, value: null, value_hash: null, prior_hash: null,
    state_hash: 'state', cause: '{}', claim_fp: null, purged: false, redacted_fields: null, ...over,
  };
}

const coverage = async (engine: BrainEngine) => {
  const row = await engine.readBeliefCoverage(SRC, '["coverage"]');
  return row && { type: row.event_type, run: row.run, at: Number.isNaN(new Date(row.recorded_at).getTime()) ? 'invalid' : 'date', id: typeof Number(row.id) };
};

const baseline = (inc: string, slug: string, run: string, ord = 0) =>
  event(inc, { slug, subject_kind: 'page', subject_key: JSON.stringify(['page', slug]), event_type: 'baseline', origin: 'baseline', cause: JSON.stringify({ run }), ord });

describe('engine parity: the belief ledger write path', () => {
  parityTest('insertBeliefEvents inserts in ord order, skips a known key, and readBeliefCoverage answers the newest event', {
    methods: ['insertBeliefEvents', 'readBeliefCoverage', 'readLedgerSource'],
  }, async (engine) => {
    const inc = await incarnation(engine);
    const none = await coverage(engine);
    // Given in reverse of their ord: the lower ord is inserted first, so the newest coverage event is the completion.
    const done = event(inc, { event_type: 'coverage.complete', cause: JSON.stringify({ run: 'r1', certified: true }), ord: 1 });
    const started = event(inc, { event_type: 'coverage.started', cause: JSON.stringify({ run: 'r1' }), ord: 0 });
    const inserted = await engine.insertBeliefEvents([done, started]);
    const afterBoth = await coverage(engine);
    const again = await engine.insertBeliefEvents([done, started]);
    // A restore never starts or stops recording, and an event of another incarnation is not this source's.
    const restored = await engine.insertBeliefEvents([event(inc, { event_type: 'coverage.restored', cause: JSON.stringify({ run: 'r9' }) })]);
    const stale = await engine.insertBeliefEvents([event(STALE_INCARNATION, { event_type: 'coverage.stopped', cause: JSON.stringify({ run: 'r8' }) })]);
    const afterIgnored = await coverage(engine);
    const stopped = await engine.insertBeliefEvents([event(inc, { event_type: 'coverage.stopped', cause: JSON.stringify({ run: 'r1' }) })]);
    const afterStop = await coverage(engine);
    const sameKeyTwice = await engine.insertBeliefEvents([event(inc, { event_key: 'abcd', event_type: 'coverage.started' }), event(inc, { event_key: 'abcd', event_type: 'coverage.started', ord: 1 })]);
    expect(none).toBeNull();
    expect(afterBoth?.type).toBe('coverage.complete');
    expect(afterIgnored).toEqual(afterBoth);
    expect(afterStop?.type).toBe('coverage.stopped');
    expect(await engine.readBeliefCoverage('missing-source', '["coverage"]')).toBeNull();
    return { none, inserted, afterBoth, again, restored, stale, afterIgnored, stopped, afterStop, sameKeyTwice };
  });

  parityTest('insertBeliefEvents refuses a row that violates a column check and saves nothing', { methods: ['insertBeliefEvents', 'readBeliefCoverage', 'readLedgerSource'] }, async (engine) => {
    const inc = await incarnation(engine);
    const refused = await engine.insertBeliefEvents([event(inc, { event_type: 'coverage.started' }), event(inc, { origin: 'nonsense' })]).then(() => 'saved', () => 'refused');
    expect(refused).toBe('refused');
    expect(await engine.readBeliefCoverage(SRC, '["coverage"]')).toBeNull();
    return refused;
  });

  parityTest('listPendingBaselineSlugs lists the unbaselined slugs after the cursor by byte, with the skip list and limit', {
    methods: ['putPage', 'insertBeliefEvents', 'listPendingBaselineSlugs', 'hasBaselineEvent', 'countBaselinedSlugs', 'readLedgerSource'],
  }, async (engine) => {
    for (const slug of MIXED_SLUGS) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' });
    const inc = await incarnation(engine);
    const all = await engine.listPendingBaselineSlugs(SRC, 'r1', '', [], 10);
    expect(all).toEqual([...BYTE_SLUGS]);
    await engine.insertBeliefEvents([baseline(inc, 'a/z', 'r1'), baseline(inc, 'a/z', 'r1', 1), baseline(inc, 'ab', 'r0')]);
    const out = {
      all,
      done: await engine.listPendingBaselineSlugs(SRC, 'r1', '', [], 10),
      after: await engine.listPendingBaselineSlugs(SRC, 'r2', 'a-z', [], 10),
      skipped: await engine.listPendingBaselineSlugs(SRC, 'r2', '', ['a/z'], 10),
      limited: await engine.listPendingBaselineSlugs(SRC, 'r2', '', [], 1),
      floor: await engine.listPendingBaselineSlugs(SRC, 'r2', '', [], 0),
      past: await engine.listPendingBaselineSlugs(SRC, 'r2', 'ab', [], 10),
      has: [await engine.hasBaselineEvent(SRC, 'a/z', 'r1'), await engine.hasBaselineEvent(SRC, 'a-z', 'r1'), await engine.hasBaselineEvent(SRC, 'a/z', 'r2'), await engine.hasBaselineEvent(SRC, 'ab', 'r0')],
      counts: [await engine.countBaselinedSlugs(SRC, 'r1'), await engine.countBaselinedSlugs(SRC, 'r0'), await engine.countBaselinedSlugs(SRC, 'r2')],
    };
    expect(out.done).toEqual(['a-z', 'ab']);
    expect(out.after).toEqual(['a/z', 'ab']);
    expect(out.skipped).toEqual(['a-z', 'ab']);
    expect(out.limited).toEqual(['a-z']);
    expect(out.floor).toEqual(['a-z']);
    expect(out.past).toEqual([]);
    expect(out.has).toEqual([true, false, false, true]);
    expect(out.counts).toEqual([1, 1, 0]);
    return out;
  });

  parityTest('listPendingBaselineSlugs includes the subjects of page-less facts', { methods: ['putPage', 'insertFacts', 'listPendingBaselineSlugs'] }, async (engine) => {
    await engine.putPage('b-page', { type: 'note', title: 'b', compiled_truth: 'b body', timeline: '' });
    await engine.insertFacts([{ fact: 'Zed keeps bees', entity_slug: 'a/ghost', kind: 'fact', visibility: 'world', source: 'mcp:remember' }] as never, { source_id: SRC });
    const slugs = await engine.listPendingBaselineSlugs(SRC, 'r1', '', [], 10);
    expect(slugs).toEqual(['a/ghost', 'b-page']);
    return slugs;
  });

  parityTest('the redaction register stores, matches by subject key or field hash, and shows a release', {
    methods: ['insertBeliefRedaction', 'readBeliefRedactions', 'releaseBeliefRedactions'],
  }, async (engine) => {
    const first = await engine.insertBeliefRedaction(SRC, 'key-1', 'title', REQUEST, 'hash-1');
    const second = await engine.insertBeliefRedaction(SRC, 'key-2', 'body', REQUEST, 'hash-2');
    const strip = (rows: Awaited<ReturnType<BrainEngine['readBeliefRedactions']>>) =>
      rows.map(r => ({ ...r, id: r.id === first ? 'first' : r.id === second ? 'second' : 'other' }));
    const byKey = strip(await engine.readBeliefRedactions(SRC, ['key-1'], []));
    const byHash = strip(await engine.readBeliefRedactions(SRC, [], ['hash-2']));
    const either = strip(await engine.readBeliefRedactions(SRC, ['key-1'], ['hash-2'])).sort((a, b) => a.id.localeCompare(b.id));
    const nothing = await engine.readBeliefRedactions(SRC, [], []);
    const elsewhere = await engine.readBeliefRedactions('other-source', ['key-1'], ['hash-2']);
    await engine.releaseBeliefRedactions([first], PUBLICATION, 'released-hash');
    await engine.releaseBeliefRedactions([], PUBLICATION, 'unused');
    const released = strip(await engine.readBeliefRedactions(SRC, ['key-1', 'key-2'], [])).sort((a, b) => a.id.localeCompare(b.id));
    expect(second).toBeGreaterThan(first);
    expect(byKey.map(r => r.id)).toEqual(['first']);
    expect(byHash.map(r => r.id)).toEqual(['second']);
    expect(nothing).toEqual([]);
    expect(elsewhere).toEqual([]);
    expect(byKey[0]!.purge_request).toBe(REQUEST.toLowerCase());
    expect(released.map(r => r.released_hash)).toEqual(['released-hash', null]);
    return { byKey, byHash, either, nothing, elsewhere, released };
  });

  parityTest('listPurgedFingerprints names the fact fingerprints a purge tombstone covers', { methods: ['insertFactPurge', 'listPurgedFingerprints'] }, async (engine) => {
    const purge = (visibility: string, subject: string, factHash: string) =>
      engine.insertFactPurge({ sourceId: SRC, visibility, subject, factHash, requestId: REQUEST.toLowerCase(), actor: 'owner:local', reason: 'parity' });
    await purge('world', '*', 'fp-one');
    await purge('private', 'people/ana-example', 'fp-two');
    const sorted = async (fact: string[], take: string[] = [], source = SRC) => (await engine.listPurgedFingerprints(source, fact, take)).sort();
    const out = {
      one: await sorted(['fp-one', 'fp-none']),
      both: await sorted(['fp-two', 'fp-one']),
      none: await sorted(['fp-none']),
      empty: await sorted([]),
      take: await sorted([], ['fp-one']),
      elsewhere: await sorted(['fp-one'], [], 'other-source'),
    };
    expect(out.one).toEqual(['fp-one']);
    expect(out.both).toEqual(['fp-one', 'fp-two']);
    expect(out.none).toEqual([]);
    expect(out.elsewhere).toEqual([]);
    return out;
  });

  parityTest('recordBeliefCommitMarks marks a publication that has events, once, and ignores the rest', {
    methods: ['insertBeliefEvents', 'recordBeliefCommitMarks', 'readLedgerSource'],
  }, async (engine, backend) => {
    const inc = await incarnation(engine);
    await engine.recordBeliefCommitMarks([]);
    await engine.recordBeliefCommitMarks([PUBLICATION]);
    await engine.insertBeliefEvents([event(inc, {})]);
    await engine.recordBeliefCommitMarks([PUBLICATION, '6f9619ff-8b86-4d01-b42d-00cf4fc964f2']);
    await engine.recordBeliefCommitMarks([PUBLICATION]);
    const refused = await engine.recordBeliefCommitMarks(['not-a-uuid']).then(() => 'saved', () => 'refused');
    if (backend !== 'rust') {
      const marks = await engine.executeRaw<{ publication_id: string }>('SELECT publication_id::text AS publication_id FROM belief_commit_marks ORDER BY 1');
      expect(marks.map(m => m.publication_id)).toEqual([PUBLICATION]);
    }
    expect(refused).toBe('refused');
    return refused;
  });
});
