/**
 * BrainEngine parity — trust family: the fact withdrawal ledger (`fact_withdrawals`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: recording a withdrawal, the covering check, the earliest-withdrawal dates of a fence's claims, the
 *    subject move of a rename, the per-subject check and the ledger key listing return the same observable result on
 *    every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine whose claim fingerprint drifts from `gbrain_fact_fingerprint` /
 *    `gbrain_fact_fingerprint_v1` (case, whitespace, punctuation and sentence-dot folding), that lets a withdrawal leak
 *    across sources, visibilities or subjects, that overwrites an earlier withdrawal time, or that orders the key
 *    listing differently: a forgotten claim would come back after `gbrain forget`, a rename or a reimport.
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
});
