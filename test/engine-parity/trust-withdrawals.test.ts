/**
 * BrainEngine parity — trust family: the fact withdrawal ledger (`fact_withdrawals`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: recording a withdrawal, the covering check, the earliest-withdrawal dates of a fence's claims, the
 *    subject move of a rename, the per-subject check, the ledger key listing and the hot-memory cache watermark
 *    (`readFactCacheWatermark`, read by facts/meta-hook.ts on every MCP call), and the trust policy generation that
 *    keys the same cache (`readTrustGeneration`: decimal text, steady with no write, moved by a `trust.%` config
 *    write), and the per-source purge probe (`readSourcePurgeFlags`, read by facts/purge-overlay.ts) return the same
 *    observable result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine whose claim fingerprint drifts from `gbrain_fact_fingerprint` /
 *    `gbrain_fact_fingerprint_v1` (case, whitespace, punctuation and sentence-dot folding), that lets a withdrawal leak
 *    across sources, visibilities or subjects, that overwrites an earlier withdrawal time, or that orders the key
 *    listing differently: a forgotten claim would come back after `gbrain forget`, a rename or a reimport. A
 *    watermark that misses a new withdrawal would let hot memory serve a forgotten fact from its cache, and a
 *    generation that stays put across a trust change would let it serve content the change made wrong. The Rust arm
 *    answers its commit sequence, which also moves on writes the SQL triggers ignore; no case asserts that an
 *    ordinary write leaves the generation alone (test/trust-generation.test.ts pins that on the SQL engines).
 *  - Why existing coverage misses it: the withdrawal tests drive these statements through `executeRaw` on PGLite
 *    alone; no case compares engines.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-05T10:00:00.000Z';
const T3 = '2026-03-09T10:00:00.000Z';

describe('engine parity: fact withdrawal ledger', () => {
  parityTest(
    'insertFactWithdrawal records one row per fingerprint and keeps the first time; the keys list in key order',
    { methods: ['insertFactWithdrawal', 'listFactWithdrawalKeys'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const claims = ['Acme raised $5M.', 'acme   raised 5m', 'Node.js ships 3.5.', 'C++ and C#', '\u0130stanbul \u2014 \u201chome\u201d\u2026', 'Tab\there'];
      const inserted: boolean[] = [];
      for (const claim of claims) inserted.push(await engine.insertFactWithdrawal('default', 'private', claim, 'companies/acme', T1));
      inserted.push(await engine.insertFactWithdrawal('default', 'world', 'Acme raised $5M.', '*', T2));
      inserted.push(await engine.insertFactWithdrawal('work', 'private', 'Acme raised $5M.', 'companies/acme', null));
      // Two more subjects at one visibility, so the listing order tells fact_hash-first from subject-first.
      inserted.push(await engine.insertFactWithdrawal('default', 'private', 'Extra claim', 'a/first', T1));
      inserted.push(await engine.insertFactWithdrawal('default', 'private', 'Another claim', 'z/last', T1));
      expect(inserted).toEqual([true, false, true, true, true, true, true, true, true, true]);
      const keys = await engine.listFactWithdrawalKeys('default', 100);
      const limited = await engine.listFactWithdrawalKeys('default', 2);
      expect(limited).toEqual(keys.slice(0, 2));
      const work = await engine.listFactWithdrawalKeys('work', 100);
      expect(work.length).toBe(1);
      return { keys, work, none: await engine.listFactWithdrawalKeys('missing', 10) };
    },
  );

  parityTest(
    'hasCoveringFactWithdrawal matches the fingerprint or the v1 fingerprint, at the visibility, for the subject or *',
    { methods: ['insertFactWithdrawal', 'hasCoveringFactWithdrawal', 'listFactWithdrawalKeys'] },
    async (engine) => {
      await engine.insertFactWithdrawal('default', 'private', 'Acme raised 5M.', 'companies/acme', T1);
      await engine.insertFactWithdrawal('default', 'world', 'Wide claim', '*', T1);
      const [{ fact_hash: hash }] = (await engine.listFactWithdrawalKeys('default', 10)).filter(k => k.visibility === 'private');
      const cover = (visibility: string, factHash: string, claim: string, subject: string, sourceId = 'default') =>
        engine.hasCoveringFactWithdrawal(sourceId, visibility, factHash, claim, subject);
      return {
        byHash: await cover('private', hash, 'unrelated', 'companies/acme'),
        // v1 of '  ACME raised 5m' is the sha256 of 'acme raised 5m', which is also the fingerprint of the stored claim.
        byV1: await cover('private', 'nope', '  ACME raised 5m', 'companies/acme'),
        otherSubject: await cover('private', hash, 'unrelated', 'companies/other'),
        otherVisibility: await cover('world', hash, 'unrelated', 'companies/acme'),
        otherSource: await cover('private', hash, 'unrelated', 'companies/acme', 'missing'),
        wildcard: await cover('world', 'nope', 'wide claim', 'people/anyone'),
      };
    },
  );

  parityTest(
    'listFactWithdrawalDates returns the earliest matching withdrawal per claim row',
    { methods: ['insertFactWithdrawal', 'listFactWithdrawalDates'] },
    async (engine) => {
      await engine.insertFactWithdrawal('default', 'private', 'Claim A', '*', T2);
      await engine.insertFactWithdrawal('default', 'private', 'Claim A', 'people/x', T1);
      await engine.insertFactWithdrawal('default', 'private', 'Claim B', 'people/y', T3);
      const claims = [
        { row_num: 3, claim: 'claim a', visibility: 'world' },
        { row_num: 2, claim: 'CLAIM B!', visibility: 'private' },
        { row_num: 1, claim: 'claim  a.', visibility: 'private' },
      ];
      const dates = async (subject: string | null) => (await engine.listFactWithdrawalDates('default', claims, subject))
        .map(r => ({ row_num: r.row_num, withdrawn_at: r.withdrawn_at.toISOString() }))
        .sort((a, b) => a.row_num - b.row_num);
      const out = { any: await dates(null), x: await dates('people/x'), other: await dates('people/z'), empty: await engine.listFactWithdrawalDates('default', [], null) };
      expect(out.any).toEqual([{ row_num: 1, withdrawn_at: T1 }, { row_num: 2, withdrawn_at: T3 }]);
      expect(out.other).toEqual([{ row_num: 1, withdrawn_at: T2 }]);
      return out;
    },
  );

  parityTest(
    'moveFactWithdrawalSubject moves one source\'s rows to the new subject and keeps a row the new subject has',
    { methods: ['insertFactWithdrawal', 'moveFactWithdrawalSubject', 'hasFactWithdrawalForSubject', 'listFactWithdrawalDates', 'listFactWithdrawalKeys'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await engine.insertFactWithdrawal('default', 'private', 'one', 'people/old', T1);
      await engine.insertFactWithdrawal('default', 'world', 'two', 'people/old', T1);
      await engine.insertFactWithdrawal('default', 'world', 'two', 'people/new', T3);
      await engine.insertFactWithdrawal('work', 'private', 'one', 'people/old', T1);
      await engine.moveFactWithdrawalSubject('default', 'people/old', 'people/old');
      const kept = await engine.hasFactWithdrawalForSubject('default', 'people/old');
      await engine.moveFactWithdrawalSubject('default', 'people/old', 'people/new');
      const dates = (await engine.listFactWithdrawalDates('default', [{ row_num: 1, claim: 'two', visibility: 'world' }, { row_num: 2, claim: 'one', visibility: 'private' }], 'people/new'))
        .map(r => ({ row_num: r.row_num, withdrawn_at: r.withdrawn_at.toISOString() }))
        .sort((a, b) => a.row_num - b.row_num);
      expect(dates).toEqual([{ row_num: 1, withdrawn_at: T3 }, { row_num: 2, withdrawn_at: T1 }]);
      return {
        kept,
        oldGone: await engine.hasFactWithdrawalForSubject('default', 'people/old'),
        newHas: await engine.hasFactWithdrawalForSubject('default', 'people/new'),
        workKept: await engine.hasFactWithdrawalForSubject('work', 'people/old'),
        keys: (await engine.listFactWithdrawalKeys('default', 10)).map(k => [k.visibility, k.subject]),
        dates,
      };
    },
  );

  parityTest(
    'readFactCacheWatermark counts the source\'s withdrawals, names the newest in UTC with microseconds and digests the empty folder access tables',
    { methods: ['insertFactWithdrawal', 'readFactCacheWatermark'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const emptyDigest = 'd41d8cd98f00b204e9800998ecf8427e:d41d8cd98f00b204e9800998ecf8427e';
      const before = await engine.readFactCacheWatermark('default');
      expect(before).toEqual({ withdrawals: 0, latest_withdrawn_at: null, access_rules: emptyDigest });
      await engine.insertFactWithdrawal('default', 'private', 'claim one', 'people/x', T3);
      const one = await engine.readFactCacheWatermark('default');
      await engine.insertFactWithdrawal('default', 'world', 'claim two', '*', '2026-03-02T10:00:00.123Z');
      await engine.insertFactWithdrawal('default', 'world', 'claim two', '*', T2);
      const two = await engine.readFactCacheWatermark('default');
      await engine.insertFactWithdrawal('work', 'private', 'claim one', 'people/x', T1);
      const out = { before, one, two, after: await engine.readFactCacheWatermark('default'), work: await engine.readFactCacheWatermark('work'), missing: await engine.readFactCacheWatermark('missing') };
      expect(out.one).toEqual({ withdrawals: 1, latest_withdrawn_at: '2026-03-09T10:00:00.000000Z', access_rules: emptyDigest });
      expect(out.two).toEqual({ withdrawals: 2, latest_withdrawn_at: '2026-03-09T10:00:00.000000Z', access_rules: emptyDigest });
      expect(out.after).toEqual(out.two);
      expect(out.work).toEqual({ withdrawals: 1, latest_withdrawn_at: '2026-03-01T10:00:00.000000Z', access_rules: emptyDigest });
      return out;
    },
  );

  parityTest(
    'readTrustGeneration reads decimal text that holds with no write and moves after a trust config write',
    { methods: ['readTrustGeneration', 'setConfig'] },
    async (engine) => {
      const first = await engine.readTrustGeneration();
      const again = await engine.readTrustGeneration();
      await engine.setConfig('trust.parity_probe', 'on');
      const moved = await engine.readTrustGeneration();
      const out = {
        decimal: [first, again, moved].every(g => typeof g === 'string' && /^\d+$/.test(g)),
        steady: again === first,
        movedAfterTrustWrite: BigInt(moved) > BigInt(first),
      };
      expect(out).toEqual({ decimal: true, steady: true, movedAfterTrustWrite: true });
      return out;
    },
  );

  parityTest(
    'readSourcePurgeFlags reports a fact purge tombstone of the source and none elsewhere; no engine here holds a take purge',
    { methods: ['putPage', 'insertFacts', 'loadPurgeTarget', 'insertFactPurge', 'readSourcePurgeFlags'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const before = await engine.readSourcePurgeFlags('default');
      await engine.putPage('people/purge-flag-example', { type: 'person', title: 'Flag Example', compiled_truth: 'Flag Example.', timeline: '' });
      const ins = await engine.insertFacts([{ fact: 'Flag keeps bees', entity_slug: 'people/purge-flag-example', source_markdown_slug: 'people/purge-flag-example',
        row_num: 1, kind: 'fact', visibility: 'world', source: 'fence' }] as never, { source_id: 'default' }) as { ids: number[] };
      const target = await engine.loadPurgeTarget(ins.ids[0]!, 'default');
      await engine.insertFactPurge({ sourceId: 'default', visibility: 'world', subject: '*', factHash: target!.fact_hash,
        requestId: '6f9619ff-8b86-4d01-b42d-00cf4fc964fe', actor: 'owner:local', reason: 'parity' });
      const out = { before, after: await engine.readSourcePurgeFlags('default'), work: await engine.readSourcePurgeFlags('work'),
        missing: await engine.readSourcePurgeFlags('missing') };
      expect(out).toEqual({ before: { facts: false, takes: false }, after: { facts: true, takes: false },
        work: { facts: false, takes: false }, missing: { facts: false, takes: false } });
      return out;
    },
  );
  parityTest(
    'readPageSnapshot carries the source\'s whole-source (*) withdrawals and the page\'s own, one per claim at the earliest time',
    { methods: ['putPage', 'insertFactWithdrawal', 'readPageSnapshot'] },
    async (engine, backend) => {
      // The other cases insert `*` withdrawals but never read a snapshot (audit r2 mutant R11: a snapshot that drops
      // whole-source withdrawals stops striking a claim the owner forgot everywhere).
      await createSource(engine, backend, 'work');
      await engine.putPage('people/snap-example', { type: 'person', title: 'Snap Example', compiled_truth: 'Snap Example.', timeline: '' });
      await engine.putPage('people/snap-other', { type: 'person', title: 'Snap Other', compiled_truth: 'Snap Other.', timeline: '' });
      await engine.insertFactWithdrawal('default', 'world', 'Snap keeps bees', '*', T2);
      await engine.insertFactWithdrawal('default', 'world', 'Snap keeps bees', 'people/snap-example', T1);
      await engine.insertFactWithdrawal('default', 'private', 'Snap moved to Lisbon', '*', T3);
      await engine.insertFactWithdrawal('default', 'world', 'Snap plays chess', 'people/snap-other', T1);
      await engine.insertFactWithdrawal('work', 'world', 'Snap sings', '*', T1);
      const read = async (slug: string) => {
        const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
        return (snap?.withdrawals ?? []).map(w => ({ visibility: w.visibility, withdrawn_at: new Date(w.withdrawn_at as string).toISOString(),
          purged: (w as { purged?: boolean }).purged ?? false, hash: typeof w.fact_hash }));
      };
      const out = { example: await read('people/snap-example'), other: await read('people/snap-other') };
      expect(out.example).toEqual([
        { visibility: 'private', withdrawn_at: T3, purged: false, hash: 'string' },
        { visibility: 'world', withdrawn_at: T1, purged: false, hash: 'string' },
      ]);
      expect(out.other).toHaveLength(3);
      return out;
    },
  );
});
