/**
 * BrainEngine parity — the fence guard's read of held timeline rows (engine-sql/trust-fence.ts `listHeldRows` on the
 * `timeline_entries` table, called by trust/fence-guard.ts `heldRows` for timeline reconcile and the fence projection).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: of the ids asked about, listHeldRows returns the same timeline rows of the page, in id order, with their stored
 *    tier, on every engine arm: rows more trusted than the writer (named, or the transaction's declared tier, `unknown`
 *    when undeclared; a name that is no tier ranks below every tier) and, when the caller asks, rows a pending `forget`
 *    proposal targets.
 *  - Regression: an engine that answers this differently lets a lower-trust reconcile delete or rewrite a more trusted
 *    timeline row, or deletes a row an open contest holds; the Rust engine has no SQL, so the read has to exist as a
 *    typed member, and before it did the Rust arm stopped on a typed refusal at the first timeline reconcile.
 *  - Why existing coverage misses it: the statement ran through `executeRaw` inside trust/fence-guard.ts, which the
 *    parity cases cannot call (D18).
 *  - Seam: the writer's tier is a transaction-local setting (`gbrain.write_trust_tier`); every arm sets it with
 *    `applyTransactionSettings` inside `transaction`. Row ids are replaced by the summary they were written with before
 *    the answer is compared, so no arm's ids leak into the comparison.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { TrustTier } from '../../src/core/trust/tier.ts';
import { heldRows } from '../../src/core/trust/fence-guard.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'people/held-example';
const ROWS = [['curated', 'operator_curated'], ['agent', 'agent_written'], ['plain', null], ['external', 'external_untrusted']] as const;

/** Fixture: run `fn` with the writer tier `tier` declared for one transaction (SET LOCAL ends with it). */
async function asWriter<T>(engine: BrainEngine, tier: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier'], [tier]);
    return fn(tx);
  });
}

/** One timeline row per tier (`plain` undeclared), each in its own write; returns summary -> id. */
async function seed(engine: BrainEngine): Promise<{ ids: Map<string, number>; pageId: number }> {
  const page = await engine.putPage(SLUG, { type: 'person', title: 'Held Example', compiled_truth: 'A person.', timeline: '' });
  for (const [i, [summary, tier]] of ROWS.entries()) {
    const entry = { date: `2026-01-0${i + 1}`, summary };
    if (tier) await asWriter(engine, tier, tx => tx.addTimelineEntry(SLUG, entry));
    else await engine.addTimelineEntry(SLUG, entry);
  }
  const rows = await engine.getTimeline(SLUG);
  return { ids: new Map(rows.map(r => [r.summary, Number(r.id)])), pageId: Number(page.id) };
}

/** The held rows as `summary:tier`, so the answer compares across arms without raw ids. */
function labeller(ids: Map<string, number>) {
  const name = new Map([...ids].map(([summary, id]) => [id, summary]));
  return (rows: Array<{ id: number; trust_tier: string }>) => rows.map(r => `${name.get(Number(r.id)) ?? 'other'}:${r.trust_tier}`);
}

describe('engine parity: the fence guard read of held timeline rows', () => {
  parityTest('rows above the writer are held in id order; the writer is the named tier, else the declared one, else unknown', {
    methods: ['putPage', 'transaction', 'applyTransactionSettings', 'addTimelineEntry', 'getTimeline', 'listHeldRows'],
  }, async (engine) => {
    const { ids, pageId } = await seed(engine);
    const label = labeller(ids);
    const all = ['external', 'plain', 'agent', 'curated'].map(s => ids.get(s)!);
    const read = (tx: BrainEngine, writer?: string) =>
      tx.listHeldRows({ table: 'timeline_entries', pageId, ids: all, ...(writer ? { writer: writer as TrustTier } : {}) }).then(label);
    const out = {
      undeclared: await read(engine),
      named_agent: await asWriter(engine, 'operator_curated', tx => read(tx, 'agent_written')),
      named_not_a_tier: await read(engine, 'not_a_tier'),
      declared_curated: await asWriter(engine, 'operator_curated', tx => read(tx)),
      declared_external: await asWriter(engine, 'external_untrusted', tx => read(tx)),
      // The declared tier ends with its transaction.
      after: await read(engine),
      missing_ids: label(await engine.listHeldRows({ table: 'timeline_entries', pageId, ids: [ids.get('agent')!, 999_999_999, -4] })),
      empty: await engine.listHeldRows({ table: 'timeline_entries', pageId, ids: [] }),
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

  parityTest('the fence guard holds a row a pending forget targets only when asked, and stops holding it once decided', {
    methods: ['putPage', 'addTimelineEntry', 'getTimeline', 'insertTrustProposal', 'transitionTrustProposal', 'listHeldRows'],
  }, async (engine) => {
    const { ids, pageId } = await seed(engine);
    const name = new Map([...ids].map(([summary, id]) => [id, summary]));
    // `plain` is the target of a pending forget; `external` is only its related row.
    const { id: tp } = await engine.insertTrustProposal({ action: 'forget', sourceId: 'default',
      target: { table: 'timeline_entries', id: ids.get('plain')! }, related: { table: 'timeline_entries', id: ids.get('external')! },
      before: {}, proposer: 'test' });
    const all = [...ids.values()];
    // The production caller: trust/fence-guard.ts heldRows, as timeline reconcile calls it.
    const guard = async (pending: boolean) => [...(await heldRows(engine, 'timeline_entries', pageId, all, { writer: 'user_confirmed', pending }))]
      .map(([id, tier]) => `${name.get(id) ?? 'other'}:${tier}`).sort();
    const out = {
      not_asked: await guard(false),
      asked: await guard(true),
      below_writer_and_asked: (await heldRows(engine, 'timeline_entries', pageId, all, { pending: true })).size,
      decided: await engine.transitionTrustProposal(tp, 'pending', 'rejected'),
      after_decision: await guard(true),
    };
    expect(out).toEqual({ not_asked: [], asked: ['plain:unknown'], below_writer_and_asked: 3, decided: true, after_decision: [] });
    return out;
  });
});
