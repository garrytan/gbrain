/**
 * BrainEngine parity — the decide proposal tables (engine-sql/decide-proposals.ts): the supersede proposals the conflict
 * sweep leaves for the owner (`insertDecideProposal`, `getDecideProposal`, `listDecideProposalIds`, `listDecideProposals`,
 * `transitionDecideProposal`, `listDecideProposedPairs`), the review lane's proposals (`insertDecideReviewProposal`,
 * `listDecideReviewProposals`, `getDecideReviewProposal`, `transitionDecideReviewProposal`, `listDecideReviewProposalIds`),
 * the doctor's `readProposalReviewRates`, the review queue (`listDueDecideReviewQueue`, `applyDecideReviewQueue`) and the
 * sweep's retry table (`listDueDecideSweepDeferred`, `applyDecideSweepDeferred`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the same calls return the same answers on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts). An insert that meets an existing slot (a sweep and pair index, a
 *    claim sweep's fact pair in either order, a review proposal's key) returns null and still uses up an id. A stored
 *    REAL reads back as its shortest decimal. A status change is a compare-and-set that keeps a stored before/after state
 *    when the new one is null and stamps the decision time. The listing joins the facts' text (a missing fact reads
 *    null; the entity comes from the new fact first) and filters by status or `all`. The rates count pending, accepted
 *    (and accepted-without-action) and rejected proposals per kind over both tables. The queue and retry tables take a
 *    row once, hand back only the due ones in order, and clear or defer a row that exists.
 *  - Regression: an engine that lets a conflicting insert through, forgets the claim-pair index, reads a REAL as its
 *    float expansion, overwrites a stored state with null, transitions from the wrong status, lists the wrong status or
 *    order, counts a status in the wrong rate, or hands out a deferred row before it is due — `gbrain decide proposals`
 *    listing the wrong rows, the doctor's review-rate check misreporting, and the sweep skipping or repeating a fact.
 *  - Why existing coverage misses it: test/decide/*.test.ts and test/claim-conflicts.test.ts run on PGLite only; a Rust
 *    engine has no raw SQL.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). Ids are compared relative to the case's first
 *    row (sequences keep counting across resets on Postgres), fact ids relative to its first fact. The 30-day windows,
 *    the retry back-off and the attempt limit need a clock the harness cannot move: cargo tests of the store
 *    (rust/crates/gbrain-store/tests/decide_proposals.rs) cover them with a fake clock. Generated timestamps are checked
 *    for their shape and never returned.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { NewProposal, NewReviewProposal } from '../../src/core/engine-sql/decide-proposals.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/** `timestamptz::text` in UTC: `2026-06-18 09:00:00+00`, a fraction of up to six digits when not zero. */
const PG_TEXT = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?\+00$/;

function proposal(sweep: string, index: number, extra: Partial<NewProposal> = {}): NewProposal {
  return {
    source_id: 'default', sweep_id: sweep, pair_index: index, new_fact_id: 100 + index, old_fact_id: 200 + index,
    direction: 'new_supersedes_old', p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a', ...extra,
  };
}

function review(sweep: string, a: string, extra: Partial<NewReviewProposal> = {}): NewReviewProposal {
  return {
    kind: 'duplicate_page', source_id: 'default', sweep_id: sweep, a_ref: a, b_ref: `${a}-twin`, subject: '*', visibility: null,
    p_action: 0.75, threshold: 0.6, model_resolved: 'model-a', question_version: '1', receipt: '{"call_site":"review_duplicate_page"}', ...extra,
  };
}

async function fact(engine: BrainEngine, text: string, entity?: string): Promise<number> {
  return (await engine.insertFact({ fact: text, source: 'chat', ...(entity ? { entity_slug: entity } : {}) }, { source_id: 'default' })).id;
}

/** A case's rows with their ids relative to `base`, and the generated timestamps checked and dropped. */
function relative<T extends { id: number; created_at: string; decided_at: string | null }>(rows: T[], base: number, shape: RegExp, decided: boolean) {
  return rows.map((r) => {
    expect(r.created_at).toMatch(shape);
    if (decided) expect(r.decided_at).toMatch(shape); else expect(r.decided_at).toBeNull();
    const { created_at: _c, decided_at: _d, ...rest } = r;
    return { ...rest, id: r.id - base, decided: decided };
  });
}

describe('engine parity: decide proposal tables', () => {
  parityTest('readProposalReviewRates counts pending, accepted and rejected proposals per kind over both tables',
    { methods: ['insertDecideProposal', 'insertDecideReviewProposal', 'transitionDecideProposal', 'transitionDecideReviewProposal', 'readProposalReviewRates'] }, async (engine) => {
      const empty = await engine.readProposalReviewRates();
      // Supersede: 2 pending, 2 accepted (one then undone), 1 rejected, 1 stale.
      const ids: number[] = [];
      for (let i = 0; i < 6; i++) ids.push((await engine.insertDecideProposal(proposal('s1', i)))!);
      expect(await engine.transitionDecideProposal(ids[2]!, 'pending', 'accepted')).toBe(true);
      expect(await engine.transitionDecideProposal(ids[3]!, 'pending', 'accepted')).toBe(true);
      expect(await engine.transitionDecideProposal(ids[3]!, 'accepted', 'undone')).toBe(true);
      expect(await engine.transitionDecideProposal(ids[4]!, 'pending', 'rejected')).toBe(true);
      expect(await engine.transitionDecideProposal(ids[5]!, 'pending', 'stale')).toBe(true);
      // Review: withdraw 3 pending; duplicate_page 1 accepted, 1 accepted_no_action, 1 rejected, 1 pending; duplicate_entity 1 stale.
      const rid = async (kind: string, a: string) => (await engine.insertDecideReviewProposal(review('r1', a, { kind })))!;
      await rid('withdraw', 'w1'); await rid('withdraw', 'w2'); await rid('withdraw', 'w3');
      const p1 = await rid('duplicate_page', 'p1');
      const p2 = await rid('duplicate_page', 'p2');
      const p3 = await rid('duplicate_page', 'p3');
      await rid('duplicate_page', 'p4');
      const e1 = await rid('duplicate_entity', 'e1');
      expect(await engine.transitionDecideReviewProposal(p1, 'pending', 'accepted')).toBe(true);
      expect(await engine.transitionDecideReviewProposal(p2, 'pending', 'accepted_no_action')).toBe(true);
      expect(await engine.transitionDecideReviewProposal(p3, 'pending', 'rejected')).toBe(true);
      expect(await engine.transitionDecideReviewProposal(e1, 'pending', 'stale')).toBe(true);
      const rates = await engine.readProposalReviewRates();
      // The age of a minutes-old pending proposal is a fraction of a day; only its sign and size are comparable.
      return {
        empty,
        rates: rates.map((r) => ({ ...r, oldest: r.oldest === null ? null : (r.oldest >= 0 && r.oldest < 1 ? 'young' : r.oldest) })),
      };
    });

  parityTest('insertDecideProposal returns null and uses up an id when a sweep slot or a claim sweep pair is taken',
    { methods: ['insertDecideProposal', 'getDecideProposal'] }, async (engine) => {
      const first = (await engine.insertDecideProposal(proposal('s1', 0, { p_supersede: 0.123456789, threshold: null, model_resolved: null })))!;
      const duplicate = await engine.insertDecideProposal(proposal('s1', 0, { new_fact_id: 7, old_fact_id: 8 }));
      const second = (await engine.insertDecideProposal(proposal('s1', 1)))!;
      // A claim sweep holds one proposal per unordered fact pair of a source, whichever sweep or direction.
      const claimA = (await engine.insertDecideProposal(proposal('claim_conflicts:a', 0, { new_fact_id: 5, old_fact_id: 6 })))!;
      const claimReversed = await engine.insertDecideProposal(proposal('claim_conflicts:b', 0, { new_fact_id: 6, old_fact_id: 5 }));
      const claimOtherSource = (await engine.insertDecideProposal(proposal('claim_conflicts:c', 0, { source_id: 'other', new_fact_id: 6, old_fact_id: 5 })))!;
      const claimOtherPair = (await engine.insertDecideProposal(proposal('claim_conflicts:d', 0, { new_fact_id: 5, old_fact_id: 7 })))!;
      // A sweep that is not a claim sweep may repeat a pair.
      const plainRepeat = (await engine.insertDecideProposal(proposal('s2', 0, { new_fact_id: 5, old_fact_id: 6 })))!;
      const plainRepeatAgain = (await engine.insertDecideProposal(proposal('s3', 0, { new_fact_id: 6, old_fact_id: 5 })))!;
      const row = await engine.getDecideProposal(first);
      const noRow = await engine.getDecideProposal(first + 1000);
      const locked = await engine.getDecideProposal(second, true);
      const read = [row, locked].map((r) => {
        expect(r!.created_at).toMatch(ISO);
        const { created_at: _c, ...rest } = r!;
        return { ...rest, id: r!.id - first };
      });
      return {
        offsets: { first: 0, duplicate, second: second - first, claimA: claimA - first, claimReversed, claimOtherSource: claimOtherSource - first,
          claimOtherPair: claimOtherPair - first, plainRepeat: plainRepeat - first, plainRepeatAgain: plainRepeatAgain - first },
        read, noRow,
      };
    });

  parityTest('listDecideProposalIds lists one sweep status by pair index, and listDecideProposedPairs the pairs naming a fact',
    { methods: ['insertDecideProposal', 'transitionDecideProposal', 'listDecideProposalIds', 'listDecideProposedPairs'] }, async (engine) => {
      const base = (await engine.insertDecideProposal(proposal('s1', 3, { new_fact_id: 9, old_fact_id: 4 })))!;
      const i1 = (await engine.insertDecideProposal(proposal('s1', 1, { new_fact_id: 4, old_fact_id: 11 })))!;
      const i2 = (await engine.insertDecideProposal(proposal('s1', 2, { new_fact_id: 4, old_fact_id: 4 + 100 })))!;
      const other = (await engine.insertDecideProposal(proposal('s2', 0, { new_fact_id: 4, old_fact_id: 12 })))!;
      const foreign = (await engine.insertDecideProposal(proposal('s3', 0, { source_id: 'other', new_fact_id: 4, old_fact_id: 13 })))!;
      expect(await engine.transitionDecideProposal(i2, 'pending', 'rejected')).toBe(true);
      const rel = (ids: number[]) => ids.map((id) => id - base);
      const pairs = async (source: string, fact: number) => (await engine.listDecideProposedPairs(source, fact)).sort((x, y) => x.a - y.a || x.b - y.b);
      return {
        pending: rel(await engine.listDecideProposalIds('s1', 'pending')),
        rejected: rel(await engine.listDecideProposalIds('s1', 'rejected')),
        accepted: rel(await engine.listDecideProposalIds('s1', 'accepted')),
        otherSweep: rel(await engine.listDecideProposalIds('s2', 'pending')),
        noSweep: await engine.listDecideProposalIds('nope', 'pending'),
        ids: { i1: i1 - base, i2: i2 - base, other: other - base, foreign: foreign - base },
        pairsOfFour: await pairs('default', 4),
        pairsOfNine: await pairs('default', 9),
        pairsOfOtherSource: await pairs('other', 4),
        pairsOfNobody: await pairs('default', 999),
      };
    });

  parityTest('transitionDecideProposal moves a proposal from one status once, keeps a state a null does not replace, and stamps the decision',
    { methods: ['insertDecideProposal', 'getDecideProposal', 'transitionDecideProposal'] }, async (engine) => {
      const id = (await engine.insertDecideProposal(proposal('s1', 0)))!;
      const before = await engine.getDecideProposal(id);
      const wrongFrom = await engine.transitionDecideProposal(id, 'accepted', 'rejected');
      const afterWrong = await engine.getDecideProposal(id);
      const accepted = await engine.transitionDecideProposal(id, 'pending', 'accepted', { before: '{"was":"active"}', after: '{"now":"expired"}' });
      const afterAccept = await engine.getDecideProposal(id);
      const again = await engine.transitionDecideProposal(id, 'pending', 'accepted');
      const undone = await engine.transitionDecideProposal(id, 'accepted', 'undone', { after: '{"now":"restored"}' });
      const afterUndo = await engine.getDecideProposal(id);
      const missing = await engine.transitionDecideProposal(id + 1000, 'pending', 'accepted');
      const view = (r: Awaited<ReturnType<typeof engine.getDecideProposal>>) => {
        expect(r!.created_at).toMatch(ISO);
        if (r!.decided_at !== null) expect(r!.decided_at).toMatch(ISO);
        return { status: r!.status, decided: r!.decided_at !== null, before: r!.before_state, after: r!.after_state };
      };
      return {
        before: view(before), wrongFrom, afterWrong: view(afterWrong), accepted, afterAccept: view(afterAccept), again, undone, afterUndo: view(afterUndo), missing,
      };
    });

  parityTest('listDecideProposals joins the facts text, filters by status or all, orders oldest first and limits',
    { methods: ['insertFact', 'insertDecideProposal', 'transitionDecideProposal', 'listDecideProposals'] }, async (engine) => {
      const f1 = await fact(engine, 'Ada lives in Paris', 'people/ada');
      const f2 = await fact(engine, 'Ada lives in Rome', 'people/ada');
      const f3 = await fact(engine, 'Bob likes tea');
      const f4 = await fact(engine, 'Bob likes coffee', 'people/bob');
      const pa = (await engine.insertDecideProposal(proposal('s1', 0, { new_fact_id: f2, old_fact_id: f1 })))!;
      await Bun.sleep(2);
      // New fact has no entity: the old fact's entity is used.
      const pb = (await engine.insertDecideProposal(proposal('s1', 1, { new_fact_id: f3, old_fact_id: f4 })))!;
      await Bun.sleep(2);
      // A fact the proposal names that does not exist reads null.
      const pc = (await engine.insertDecideProposal(proposal('s1', 2, { new_fact_id: f1 + 10_000, old_fact_id: f3 })))!;
      await Bun.sleep(2);
      const pd = (await engine.insertDecideProposal(proposal('s1', 3, { new_fact_id: f1 + 10_001, old_fact_id: f1 + 10_002 })))!;
      expect(await engine.transitionDecideProposal(pb, 'pending', 'accepted')).toBe(true);
      expect(await engine.transitionDecideProposal(pd, 'pending', 'rejected')).toBe(true);
      const view = async (opts?: Parameters<BrainEngine['listDecideProposals']>[0]) => (await engine.listDecideProposals(opts)).map((r) => {
        expect(r.created_at).toMatch(ISO);
        return { id: r.id - pa, status: r.status, new: r.new_fact, old: r.old_fact, entity: r.entity_slug, nf: r.new_fact_id - f1, of: r.old_fact_id - f1, idx: r.pair_index };
      });
      return {
        defaulted: await view(),
        pending: await view({ status: 'pending' }),
        accepted: await view({ status: 'accepted' }),
        all: await view({ status: 'all' }),
        limited: await view({ status: 'all', limit: 2 }),
        stale: await view({ status: 'stale' }),
        ids: [pa, pb, pc, pd].map((id) => id - pa),
      };
    });

  parityTest('review proposals are inserted once per key, listed by status, read and moved from one status once',
    { methods: ['insertDecideReviewProposal', 'listDecideReviewProposals', 'getDecideReviewProposal', 'transitionDecideReviewProposal', 'listDecideReviewProposalIds'] }, async (engine) => {
      const first = (await engine.insertDecideReviewProposal(review('r1', 'a', { p_action: 0.1, threshold: null, model_resolved: null, question_version: null, receipt: null, visibility: 'private' })))!;
      // The same key from another sweep conflicts and uses up an id; another subject is a new proposal.
      const duplicate = await engine.insertDecideReviewProposal(review('r2', 'a', { p_action: 0.9 }));
      const otherSubject = (await engine.insertDecideReviewProposal(review('r1', 'a', { subject: 'people/ada', p_action: 0.123456789 })))!;
      const withdraw = (await engine.insertDecideReviewProposal(review('r1', 'w', { kind: 'withdraw', visibility: 'world' })))!;
      const entity = (await engine.insertDecideReviewProposal(review('r9', 'e', { kind: 'duplicate_entity' })))!;
      expect(await engine.transitionDecideReviewProposal(otherSubject, 'pending', 'accepting')).toBe(true);
      const wrongFrom = await engine.transitionDecideReviewProposal(otherSubject, 'pending', 'rejected');
      expect(await engine.transitionDecideReviewProposal(otherSubject, 'accepting', 'accepted')).toBe(true);
      const missing = await engine.transitionDecideReviewProposal(first + 1000, 'pending', 'accepted');
      const view = (rows: Awaited<ReturnType<BrainEngine['listDecideReviewProposals']>>) => relative(rows, first, PG_TEXT, false)
        .map(({ decided: _d, ...rest }) => rest);
      const pending = await engine.listDecideReviewProposals('pending');
      const accepted = await engine.listDecideReviewProposals('accepted');
      expect(accepted[0]!.decided_at).toMatch(PG_TEXT);
      const all = await engine.listDecideReviewProposals('all');
      const one = (await engine.getDecideReviewProposal(first))!;
      const locked = (await engine.getDecideReviewProposal(withdraw, true))!;
      expect(one.created_at).toMatch(PG_TEXT);
      return {
        offsets: { first: 0, duplicate, otherSubject: otherSubject - first, withdraw: withdraw - first, entity: entity - first, wrongFrom, missing },
        pending: view(pending), allIds: all.map((r) => [r.id - first, r.status]),
        accepted: accepted.map((r) => ({ id: r.id - first, subject: r.subject, p_action: r.p_action, status: r.status })),
        one: { ...one, id: one.id - first, created_at: 'shape-ok' },
        locked: { ...locked, id: locked.id - first, created_at: 'shape-ok' },
        none: await engine.getDecideReviewProposal(first + 1000),
        noneListed: await engine.listDecideReviewProposals('stale'),
        sweep1: (await engine.listDecideReviewProposalIds('r1', true)).map((id) => id - first),
        sweep1NoWithdraw: (await engine.listDecideReviewProposalIds('r1', false)).map((id) => id - first),
        sweep9: (await engine.listDecideReviewProposalIds('r9', false)).map((id) => id - first),
        sweepNone: await engine.listDecideReviewProposalIds('nope', true),
      };
    });

  parityTest('the review queue takes a pair once, hands back the due rows of a kind and source oldest first, and clears or defers a row that exists',
    { methods: ['applyDecideReviewQueue', 'listDueDecideReviewQueue'] }, async (engine) => {
      const key = (kind: string, a: string, b = '*', source = 'default') => ({ kind, source_id: source, a_ref: a, b_ref: b });
      const queued = [
        await engine.applyDecideReviewQueue({ op: 'enqueue', ...key('duplicate_page', 'pages/z', 'pages/zz'), evidence: 'cosine 0.86' }),
        (await Bun.sleep(2), await engine.applyDecideReviewQueue({ op: 'enqueue', ...key('duplicate_page', 'pages/a', 'pages/b'), evidence: null })),
        (await Bun.sleep(2), await engine.applyDecideReviewQueue({ op: 'enqueue', ...key('duplicate_page', 'pages/m', 'pages/n'), evidence: null })),
        // The same pair again, and its evidence, change nothing.
        await engine.applyDecideReviewQueue({ op: 'enqueue', ...key('duplicate_page', 'pages/z', 'pages/zz'), evidence: 'other' }),
        await engine.applyDecideReviewQueue({ op: 'enqueue', ...key('withdraw', '41') }),
        await engine.applyDecideReviewQueue({ op: 'enqueue', ...key('duplicate_page', 'pages/a', 'pages/b', 'other') }),
        // The same anchor with another second ref is another row.
        await engine.applyDecideReviewQueue({ op: 'enqueue', ...key('duplicate_page', 'pages/z', 'pages/zy') }),
      ];
      const due = async (kind: string, source: string, limit = 10) => engine.listDueDecideReviewQueue(kind, source, limit);
      const pages = await due('duplicate_page', 'default');
      const limited = await due('duplicate_page', 'default', 2);
      const none = await due('duplicate_entity', 'default');
      const deferred = await engine.applyDecideReviewQueue({ op: 'defer', ...key('duplicate_page', 'pages/a', 'pages/b'), reason: 'no_embedding' });
      const deferMissing = await engine.applyDecideReviewQueue({ op: 'defer', ...key('duplicate_page', 'pages/nope', 'pages/b'), reason: 'x' });
      const afterDefer = await due('duplicate_page', 'default');
      const cleared = await engine.applyDecideReviewQueue({ op: 'clear', ...key('duplicate_page', 'pages/z', 'pages/zz') });
      const clearedAgain = await engine.applyDecideReviewQueue({ op: 'clear', ...key('duplicate_page', 'pages/z', 'pages/zz') });
      const afterClear = await due('duplicate_page', 'default');
      const requeued = await engine.applyDecideReviewQueue({ op: 'enqueue', ...key('duplicate_page', 'pages/z', 'pages/zz') });
      return {
        queued, pages, limited, none, deferred, deferMissing, afterDefer, cleared, clearedAgain, afterClear, requeued,
        other: await due('duplicate_page', 'other'), withdraw: await due('withdraw', 'default'),
      };
    });

  parityTest('the sweep retry table backs a fact off, takes relinked facts once and hands back the due ones by fact id',
    { methods: ['applyDecideSweepDeferred', 'listDueDecideSweepDeferred'] }, async (engine) => {
      const relinked = await engine.applyDecideSweepDeferred('default', { op: 'relinked', fact_ids: [30, 10, 20] });
      const relinkedAgain = await engine.applyDecideSweepDeferred('default', { op: 'relinked', fact_ids: [20, 40] });
      const relinkedNone = await engine.applyDecideSweepDeferred('default', { op: 'relinked', fact_ids: [] });
      await engine.applyDecideSweepDeferred('other', { op: 'relinked', fact_ids: [10, 50] });
      const due = (source: string, limit = 10) => engine.listDueDecideSweepDeferred(source, limit);
      const first = await due('default');
      const limited = await due('default', 2);
      // A back-off moves a due row out of the due list (30 minutes times its attempts); a new row is not due either.
      const deferredExisting = await engine.applyDecideSweepDeferred('default', { op: 'defer', fact_id: 20, reason: 'no_embedding' });
      const deferredNew = await engine.applyDecideSweepDeferred('default', { op: 'defer', fact_id: 99, reason: 'provider_error' });
      const afterDefer = await due('default');
      // A relink does not touch a row that is deferred, so it stays out of the due list.
      const relinkedDeferred = await engine.applyDecideSweepDeferred('default', { op: 'relinked', fact_ids: [20, 99] });
      const cleared = await engine.applyDecideSweepDeferred('default', { op: 'clear', fact_id: 10 });
      const clearedAgain = await engine.applyDecideSweepDeferred('default', { op: 'clear', fact_id: 10 });
      const clearedMissing = await engine.applyDecideSweepDeferred('default', { op: 'clear', fact_id: 12345 });
      const afterClear = await due('default');
      const requeued = await engine.applyDecideSweepDeferred('default', { op: 'relinked', fact_ids: [10] });
      return {
        relinked, relinkedAgain, relinkedNone, first, limited, deferredExisting, deferredNew, afterDefer, relinkedDeferred, cleared,
        clearedAgain, clearedMissing, afterClear, requeued, other: await due('other'), nobody: await due('nobody'),
        deferredCleared: await engine.applyDecideSweepDeferred('default', { op: 'clear', fact_id: 99 }),
      };
    });
});
