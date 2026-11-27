/**
 * BrainEngine parity — the fence guard's read of held takes (engine-sql/trust-fence.ts `listHeldRows` on the `takes`
 * table, called by
 * trust/fence-guard.ts `heldRows` when a takes reconcile asks which stored takes it may not retire).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: of the ids asked about, listHeldRows returns the same takes of the page, in id order, with their stored tier, on
 *    every engine arm: takes more trusted than the writer (named, or the transaction's declared tier, `unknown` when
 *    undeclared; a name that is no tier ranks below every tier) and, when the caller asks, takes a pending `forget`
 *    proposal targets. A forget of another table's row with the same id holds no take.
 *  - Regression: an engine that answers this differently lets a lower-trust takes reconcile retire a more trusted take,
 *    or retires a take an open contest holds; the Rust engine has no SQL, so the read has to exist as a typed member,
 *    and before it did the Rust arm stopped on a typed refusal at the first takes reconcile that had candidates.
 *  - Why existing coverage misses it: the statement ran through `executeRaw` inside trust/fence-guard.ts, which the
 *    parity cases cannot call (D18); test/engine-parity/timeline-held-rows.test.ts covers only the timeline half.
 *  - Seam: the writer's tier is a transaction-local setting (`gbrain.write_trust_tier`); every arm sets it with
 *    `applyTransactionSettings` inside `transaction`. Take ids are replaced by the claim they were written with before
 *    the answer is compared, so no arm's ids leak into the comparison.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { TrustTier } from '../../src/core/trust/tier.ts';
import { heldRows } from '../../src/core/trust/fence-guard.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'people/held-take-example';
const ROWS = [['curated', 'operator_curated'], ['agent', 'agent_written'], ['plain', null], ['external', 'external_untrusted']] as const;

/** Fixture: run `fn` with the writer tier `tier` declared for one transaction (SET LOCAL ends with it). */
async function asWriter<T>(engine: BrainEngine, tier: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier'], [tier]);
    return fn(tx);
  });
}

/** One take per tier (`plain` undeclared), each in its own write; returns claim -> id. */
async function seed(engine: BrainEngine): Promise<{ ids: Map<string, number>; pageId: number }> {
  const page = await engine.putPage(SLUG, { type: 'person', title: 'Held Take Example', compiled_truth: 'A person.', timeline: '' });
  for (const [i, [claim, tier]] of ROWS.entries()) {
    const row = [{ page_id: Number(page.id), row_num: i + 1, claim, kind: 'take', holder: 'alice-example', weight: 0.5 }];
    if (tier) await asWriter(engine, tier, tx => tx.addTakesBatch(row));
    else await engine.addTakesBatch(row);
  }
  const takes = await engine.listTakes({ page_slug: SLUG });
  return { ids: new Map(takes.map(t => [t.claim, Number(t.id)])), pageId: Number(page.id) };
}

/** The held takes as `claim:tier`, so the answer compares across arms without raw ids. */
function labeller(ids: Map<string, number>) {
  const name = new Map([...ids].map(([claim, id]) => [id, claim]));
  return (rows: Array<{ id: number; trust_tier: string }>) => rows.map(r => `${name.get(Number(r.id)) ?? 'other'}:${r.trust_tier}`);
}

describe('engine parity: the fence guard read of held takes', () => {
  parityTest('takes above the writer are held in id order; the writer is the named tier, else the declared one, else unknown', {
    methods: ['putPage', 'transaction', 'applyTransactionSettings', 'addTakesBatch', 'listTakes', 'listHeldRows'],
  }, async (engine) => {
    const { ids, pageId } = await seed(engine);
    const label = labeller(ids);
    const all = ['external', 'plain', 'agent', 'curated'].map(s => ids.get(s)!);
    const read = (tx: BrainEngine, writer?: string) =>
      tx.listHeldRows({ table: 'takes', pageId, ids: all, ...(writer ? { writer: writer as TrustTier } : {}) }).then(label);
    const out = {
      undeclared: await read(engine),
      named_agent: await asWriter(engine, 'operator_curated', tx => read(tx, 'agent_written')),
      named_not_a_tier: await read(engine, 'not_a_tier'),
      declared_curated: await asWriter(engine, 'operator_curated', tx => read(tx)),
      declared_external: await asWriter(engine, 'external_untrusted', tx => read(tx)),
      // The declared tier ends with its transaction.
      after: await read(engine),
      missing_ids: label(await engine.listHeldRows({ table: 'takes', pageId, ids: [ids.get('agent')!, 999_999_999, -4] })),
      empty: await engine.listHeldRows({ table: 'takes', pageId, ids: [] }),
    };
    expect(out).toEqual({
      undeclared: ['curated:operator_curated', 'agent:agent_written'],
      named_agent: ['curated:operator_curated'],
      named_not_a_tier: ['curated:operator_curated', 'agent:agent_written', 'plain:unknown', 'external:external_untrusted'],
      declared_curated: [],
      declared_external: ['curated:operator_curated', 'agent:agent_written', 'plain:unknown'],
      after: ['curated:operator_curated', 'agent:agent_written'],
      missing_ids: ['agent:agent_written'],
      empty: [],
    });
    return out;
  });

  parityTest('the fence guard holds a take a pending forget targets only when asked, and stops holding it once decided', {
    methods: ['putPage', 'addTakesBatch', 'listTakes', 'insertTrustProposal', 'transitionTrustProposal', 'listHeldRows'],
  }, async (engine) => {
    const { ids, pageId } = await seed(engine);
    const name = new Map([...ids].map(([claim, id]) => [id, claim]));
    // `plain` is the target of a pending forget; `external` is only its related row. A forget that targets a timeline
    // row with `agent`'s id names another table, so it holds no take.
    const { id: tp } = await engine.insertTrustProposal({ action: 'forget', sourceId: 'default',
      target: { table: 'takes', id: ids.get('plain')! }, related: { table: 'takes', id: ids.get('external')! },
      before: {}, proposer: 'test' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: 'default',
      target: { table: 'timeline_entries', id: ids.get('agent')! }, related: { table: 'timeline_entries', id: ids.get('agent')! },
      before: {}, proposer: 'test' });
    const all = [...ids.values()];
    // The production caller: trust/fence-guard.ts heldRows, as the takes reconcile (cycle/extract-takes.ts) calls it.
    const guard = async (pending: boolean) => [...(await heldRows(engine, 'takes', pageId, all, { writer: 'user_confirmed', pending }))]
      .map(([id, tier]) => `${name.get(id) ?? 'other'}:${tier}`).sort();
    const out = {
      not_asked: await guard(false),
      asked: await guard(true),
      below_writer_and_asked: (await heldRows(engine, 'takes', pageId, all, { pending: true })).size,
      decided: await engine.transitionTrustProposal(tp, 'pending', 'rejected'),
      after_decision: await guard(true),
    };
    expect(out).toEqual({ not_asked: [], asked: ['plain:unknown'], below_writer_and_asked: 3, decided: true, after_decision: [] });
    return out;
  });
});
