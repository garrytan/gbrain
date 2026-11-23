/**
 * BrainEngine parity — the trust decision queue (engine-sql/trust-proposals.ts): insertTrustProposal, getTrustProposal,
 * listTrustProposals, pendingTrustProposalsFor, updatePendingTrustProposalAfter and transitionTrustProposal; and the
 * contradiction list `trust review` reads beside it (listPendingContradictions).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) keeps one pending proposal per (action, target, related), uses up an id on a refused
 *    second insert as BIGSERIAL does, lists and filters in the same order, and moves a proposal through its statuses with
 *    the same compare-and-set answers and the same stored decider.
 *  - Regression: an engine that files a second pending proposal for one decision, re-opens a decided proposal over a
 *    pending one, or loses the decider, shows the owner a doubled or wrong review queue (gbrain trust review) and lets
 *    the fence guard's held arm read the wrong state.
 *  - Why existing coverage misses it: the statements ran through `executeRaw` inside trust/proposals.ts, which the
 *    parity cases cannot call (D18).
 *  - The contradiction cases: decide proposals are written by the decide sweep's own writer (ai/decide/proposals-store.ts,
 *    the decide proposal members the Rust store serves). All three arms list the pending pair of two active facts and
 *    leave out a stale or decided pair; `trust review` answers the same on each.
 *  - Seam: the queue is read and written through the six typed members only. Times are masked to "set" or null: each
 *    engine stamps its own clock. Ids are compared as offsets from the first id, since each arm starts its own sequence.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { TrustProposalRow } from '../../src/core/engine-sql/trust-proposals.ts';
import { parityArms } from './harness.ts';
import { insertProposal, transitionProposal } from '../../src/core/ai/decide/proposals-store.ts';
import { buildTrustReview } from '../../src/core/trust/review.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';

/** A proposal row with its times masked and its id an offset from `base`, so answers compare across arms. */
const masked = (base: number) => (row: TrustProposalRow | null) => row && ({
  ...row, id: row.id - base,
  created_at: row.created_at ? 'set' : null, updated_at: row.updated_at ? 'set' : null, decided_at: row.decided_at ? 'set' : null,
});

const SLUG = 'people/proposal-example';
const facts = async (engine: BrainEngine, n: number) => {
  const { ids } = await engine.insertFacts(Array.from({ length: n }, (_, i) => ({
    row_num: i + 1, source_markdown_slug: SLUG, fact: `Claim ${i + 1}`, entity_slug: SLUG, source: 'fence', kind: 'fact' as const,
    visibility: 'world' as const, valid_from: new Date(`2026-02-0${i + 1}T01:02:03.250Z`),
  })) as never, { source_id: SRC });
  expect((ids as unknown[]).every((id) => typeof id === 'number')).toBe(true);
  return ids as number[];
};

describe('engine parity: the trust decision queue', () => {
  parityTest('a second pending proposal for the same decision returns the first, still takes an id, and lists and filters the same', {
    methods: ['insertFacts', 'insertTrustProposal', 'getTrustProposal', 'listTrustProposals', 'pendingTrustProposalsFor'],
  }, async (engine) => {
    const [a, b, c] = await facts(engine, 3);
    const supersede = { action: 'supersede_fact' as const, sourceId: SRC, target: { table: 'facts' as const, id: a! },
      related: { table: 'facts' as const, id: b! }, before: { trust_tier: 'operator_curated', visibility: 'world' }, after: { fact: 'Claim 1 changed' },
      proposer: 'fence_projection' };
    const first = await engine.insertTrustProposal(supersede);
    const again = await engine.insertTrustProposal({ ...supersede, before: { other: true } });
    const forget = await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'facts', id: c! }, before: {}, proposer: 'remote_forget' });
    // The same target without a related row is a different decision.
    const unrelated = await engine.insertTrustProposal({ ...supersede, related: null });
    const base = first.id;
    const mask = masked(base);
    const ids = { first: { ...first, id: 0 }, again: { ...again, id: again.id - base }, forget: { ...forget, id: forget.id - base },
      unrelated: { ...unrelated, id: unrelated.id - base } };
    // The refused insert used up id 1, as BIGSERIAL's ON CONFLICT DO NOTHING does.
    expect(ids).toEqual({ first: { id: 0, created: true }, again: { id: 0, created: false }, forget: { id: 2, created: true },
      unrelated: { id: 3, created: true } });
    const got = mask(await engine.getTrustProposal(first.id));
    const missing = await engine.getTrustProposal(first.id + 1000);
    const pending = (await engine.listTrustProposals()).map(mask);
    const byAction = (await engine.listTrustProposals({ action: 'forget' })).map(mask);
    const all = (await engine.listTrustProposals({ status: 'all', sourceId: SRC, limit: 2 })).map(mask);
    const otherSource = await engine.listTrustProposals({ status: 'all', sourceId: 'parity-missing' });
    const future = await engine.listTrustProposals({ since: new Date(Date.now() + 86_400_000) });
    const forA = (await engine.pendingTrustProposalsFor('facts', a!)).map(mask);
    const forB = (await engine.pendingTrustProposalsFor('facts', b!)).map(mask);
    const forTake = await engine.pendingTrustProposalsFor('takes', a!);
    expect(got).toMatchObject({ id: 0, action: 'supersede_fact', target_id: a, related_table: 'facts', related_id: b, status: 'pending',
      before_state: supersede.before, after_state: supersede.after, proposer: 'fence_projection', decided_at: null, created_at: 'set' });
    expect(missing).toBeNull();
    expect(pending.map((r) => r!.id)).toEqual([0, 2, 3]);
    expect(byAction.map((r) => r!.id)).toEqual([2]);
    expect(all.map((r) => r!.id)).toEqual([0, 2]);
    expect({ otherSource, future, forTake }).toEqual({ otherSource: [], future: [], forTake: [] });
    expect(forA.map((r) => r!.id)).toEqual([0, 3]);
    expect(forB.map((r) => r!.id)).toEqual([0]);
    const label = (row: ReturnType<typeof mask>) => row && ({ ...row, target_id: row.target_id === a ? 'a' : row.target_id === c ? 'c' : row.target_id,
      related_id: row.related_id === b ? 'b' : row.related_id });
    return { ids, got: label(got), pending: pending.map(label), all: all.map(label), forA: forA.map(label) };
  });

  parityTest('a status change is a compare-and-set that keeps one pending proposal per decision and records the decider', {
    methods: ['insertFacts', 'insertTrustProposal', 'getTrustProposal', 'updatePendingTrustProposalAfter', 'transitionTrustProposal',
      'pendingTrustProposalsFor'],
  }, async (engine) => {
    const [a] = await facts(engine, 1);
    const confirm = { action: 'confirm' as const, sourceId: SRC, target: { table: 'facts' as const, id: a! },
      related: { table: 'facts' as const, id: a! }, before: { visibility: 'private' }, proposer: 'agent_page_edit' };
    const first = await engine.insertTrustProposal(confirm);
    const mask = masked(first.id);
    await engine.updatePendingTrustProposalAfter(first.id, { fact: 'folded later write' });
    const folded = mask(await engine.getTrustProposal(first.id));
    const wrongFrom = await engine.transitionTrustProposal(first.id, 'accepted', 'undone');
    const rejected = await engine.transitionTrustProposal(first.id, 'pending', 'rejected', { decidedBy: { kind: 'operator', id: 'cli' } });
    // A decided proposal keeps its after state: a refresh only touches a pending one.
    await engine.updatePendingTrustProposalAfter(first.id, { fact: 'ignored' });
    const afterReject = mask(await engine.getTrustProposal(first.id));
    // With the decision rejected, the same decision may be filed again as a new pending proposal.
    const refiled = await engine.insertTrustProposal(confirm);
    // Re-opening the rejected proposal would make two pending proposals for one decision: every engine refuses it.
    let reopen: string;
    try { reopen = String(await engine.transitionTrustProposal(first.id, 'rejected', 'pending')); }
    catch { reopen = 'refused'; }
    const accepted = await engine.transitionTrustProposal(refiled.id, 'pending', 'accepted', { after: { applied: true } });
    const afterAccept = mask(await engine.getTrustProposal(refiled.id));
    const reopened = await engine.transitionTrustProposal(first.id, 'rejected', 'pending');
    const pendingNow = (await engine.pendingTrustProposalsFor('facts', a!)).map((r) => r.id - first.id);
    const missing = await engine.transitionTrustProposal(first.id + 1000, 'pending', 'accepted');
    const answer = {
      folded: folded && { after_state: folded.after_state, status: folded.status, decided_at: folded.decided_at },
      wrongFrom, rejected, afterReject: afterReject && {
        status: afterReject.status, after_state: afterReject.after_state, decided_at: afterReject.decided_at,
        decided_principal_kind: afterReject.decided_principal_kind, decided_principal_id: afterReject.decided_principal_id },
      refiled: { ...refiled, id: refiled.id - first.id }, reopen, accepted,
      afterAccept: afterAccept && { status: afterAccept.status, after_state: afterAccept.after_state, decided_at: afterAccept.decided_at,
        decided_principal_kind: afterAccept.decided_principal_kind },
      reopened, pendingNow, missing,
    };
    expect(answer).toEqual({
      folded: { after_state: { fact: 'folded later write' }, status: 'pending', decided_at: null },
      wrongFrom: false, rejected: true,
      afterReject: { status: 'rejected', after_state: { fact: 'folded later write' }, decided_at: 'set', decided_principal_kind: 'operator', decided_principal_id: 'cli' },
      refiled: { id: 1, created: true }, reopen: 'refused', accepted: true,
      afterAccept: { status: 'accepted', after_state: { applied: true }, decided_at: 'set', decided_principal_kind: null },
      reopened: true, pendingNow: [0], missing: false,
    });
    return answer;
  });

  parityTest('a proposal naming an unknown source is refused and files nothing', {
    methods: ['insertTrustProposal', 'listTrustProposals'],
  }, async (engine) => {
    let refused = false;
    try {
      await engine.insertTrustProposal({ action: 'forget', sourceId: 'parity-missing', target: { table: 'facts', id: 1 }, before: {}, proposer: 'test' });
    } catch { refused = true; }
    const all = await engine.listTrustProposals({ status: 'all' });
    expect({ refused, all }).toEqual({ refused: true, all: [] });
    return { refused, all };
  });

  parityTest('trust review lists no contradiction on a brain with active facts and no decide proposal', { methods: ['insertFacts', 'listPendingContradictions'] }, async (engine) => {
    await facts(engine, 2);
    const review = await buildTrustReview(engine, {});
    expect(review.counts.contradiction).toBe(0);
    return review;
  });

  parityTest('listPendingContradictions lists a pending pair of two active facts, not a stale or decided pair', {
    methods: ['insertFacts', 'listPendingContradictions'],
  }, async (engine) => {
    const { ids } = await engine.insertFacts(Array.from({ length: 6 }, (_, i) => ({
      row_num: i + 1, source_markdown_slug: SLUG, fact: `Claim ${i + 1}`, entity_slug: SLUG, source: 'fence', kind: 'fact' as const,
      visibility: 'world' as const, valid_from: new Date(`2026-02-0${i + 1}T01:02:03.250Z`),
      // Claim 4 ended: a pair that names it is stale.
      ...(i === 3 ? { valid_until: new Date('2026-02-05T00:00:00Z') } : {}),
    })) as never, { source_id: SRC });
    const f = ids as number[];
    const name = new Map(f.map((id, i) => [id, `Claim ${i + 1}`]));
    const pair = (i: number, newer: number, older: number) => ({ source_id: SRC, sweep_id: 'sweep-parity', pair_index: i, new_fact_id: f[newer]!, old_fact_id: f[older]!,
      direction: 'new_supersedes_old', p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: null });
    const write = await insertProposal(engine, pair(0, 1, 0)).then(() => null, (e: unknown) => e);
    expect(write).toBeNull();
    await insertProposal(engine, pair(1, 3, 2));
    const decided = await insertProposal(engine, pair(2, 5, 4));
    expect(await transitionProposal(engine, decided!, 'pending', 'rejected')).toBe(true);
    const view = async (filter: Parameters<BrainEngine['listPendingContradictions']>[0]) => (await engine.listPendingContradictions(filter)).map((r) => ({
      ...r, id: 'id', created_at: r.created_at ? 'set' : null, new_fact_id: name.get(Number(r.new_fact_id)), old_fact_id: name.get(Number(r.old_fact_id)),
    }));
    const out = { all: await view({}), source: await view({ sourceId: SRC }), otherSource: await view({ sourceId: 'other' }),
      since: await view({ since: new Date('2999-01-01T00:00:00Z') }) };
    expect(out.all).toEqual([{ id: 'id', source_id: SRC, sweep_id: 'sweep-parity', created_at: 'set', new_fact_id: 'Claim 2', old_fact_id: 'Claim 1',
      new_fact: 'Claim 2', old_fact: 'Claim 1', trust_tier: 'unknown', entity_slug: SLUG, slug: SLUG, claim_metric: null, claim_unit: null,
      claim_period: null, new_value: null, old_value: null }]);
    expect(out).toEqual({ all: out.all, source: out.all, otherSource: [], since: [] });
    const review = await buildTrustReview(engine, { kind: 'contradiction' });
    return { ...out, listed: review.items.map((i) => ({ kind: i.kind, detail: i.detail, page: i.page, tier: i.tier, label: i.label })) };
  });
});

