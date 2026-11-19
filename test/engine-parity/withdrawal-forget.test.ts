/**
 * BrainEngine parity — a whole forget under a write request: recordFactWithdrawal (src/core/facts/withdrawal.ts) with a
 * `requestId` writes the withdrawal row, expires the fact, queues the overnight review and queues the request's three
 * effects (`withdrawal-mirror`, `git`, `embedding`) in one transaction, on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after the forget commits, a withdrawal covers the claim, the fact is expired, the review queue holds
 *    the fact and the request holds its three queued effects. When the caller's transaction throws after the forget,
 *    none of these stay: no withdrawal, a live fact, no review row and no effects.
 *  - Regression: the withdrawal locked its source, locked the fact row and queued the review through `executeRaw`,
 *    which the Rust engine refuses, so a managed forget on a Rust brain could not run at all.
 *  - Why existing coverage misses it: test/rust-withdrawal-effects.test.ts drives only the effects insert on Rust
 *    (its header says the whole withdrawal is not driven), and test/engine-parity/persistence.test.ts covers the
 *    member's rows, not the withdrawal that writes them.
 *  - Seam: none. Facts come from typed members and the request from the typed journal insert. The fact names an
 *    entity with no page, so the withdrawal changes no page and its effects carry no targets.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const KEYS = ['principal:local_cli:forget-writer', 'brain'];

/** Admits one queued forget request under `requestId`; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string): Promise<string> {
  const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  await engine.lockPersistenceCounters(KEYS);
  return (await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'forget-writer', requestId, operation: 'forget_fact', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug: 'people/alice-example', worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: { kind: 'forget_fact' }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'test', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  })).id;
}

/** Inserts one world fact about an entity with no page, under the operator tier; returns its id. */
async function fact(engine: BrainEngine, claim: string): Promise<number> {
  let id = 0;
  await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'operator_curated' })]);
    const out = await tx.insertFacts([{
      fact: claim, entity_slug: 'people/alice-example', source_markdown_slug: null as never, row_num: 1, kind: 'fact',
      visibility: 'world', source: 'test conversation', valid_from: new Date(Date.UTC(2026, 6, 1)),
    }] as never, { source_id: 'default' });
    id = Number(out.ids[0]);
  });
  return id;
}

/** What a forget of `id` left behind: the covering withdrawal, the fact's expiry, the review row and the effects. */
async function left(engine: BrainEngine, id: number, requestId: string, claim: { fact: string; fact_hash: string; subject: string }) {
  const after = await engine.readFactWithdrawalClaim({ id, sourceId: 'default', worldOnly: false, memberPage: null, remoteFloor: false });
  const review = await engine.listDueDecideReviewQueue('withdraw', 'default', 10);
  return {
    withdrawn: await engine.hasCoveringFactWithdrawal('default', 'world', claim.fact_hash, claim.fact, claim.subject),
    expired: after?.expired ?? null,
    review: review.filter(r => r.a_ref === String(id)).map(r => ({ kind: r.kind, b_ref: r.b_ref })),
    effects: await engine.readRequestEffects(requestId),
  };
}

const queued = (kind: string) => ({ kind, state: 'queued', error_code: null, outcome: null, recovering: false });

describe('engine parity: a forget under a write request', () => {
  parityTest('commits its withdrawal, review row and three effects together, and a throw after it leaves none of them',
    { methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transaction', 'applyTransactionSettings', 'insertFacts',
      'lockSourceRow', 'readFactWithdrawalClaim', 'hasCoveringFactWithdrawal', 'listWithdrawalSlugs', 'lockPageKeys', 'insertFactWithdrawal',
      'expireFactsByWithdrawal', 'applyDecideReviewQueue', 'insertWithdrawalEffects', 'listDueDecideReviewQueue', 'readRequestEffects'] },
    async (engine) => {
      const keptId = await fact(engine, 'Alice keeps bees on the roof');
      const droppedId = await fact(engine, 'Alice keeps a boat in the bay');
      const kept = await admit(engine, 'b0000000-0000-4000-8000-0000000000b1');
      const dropped = await admit(engine, 'b0000000-0000-4000-8000-0000000000b2');
      const claim = async (id: number) =>
        (await engine.readFactWithdrawalClaim({ id, sourceId: 'default', worldOnly: false, memberPage: null, remoteFloor: false }))!;
      const keptClaim = await claim(keptId);
      const droppedClaim = await claim(droppedId);

      const result = await engine.transaction(tx => recordFactWithdrawal(tx, keptId, 'default', false, { requestId: kept }));
      let refused = '';
      try {
        await engine.transaction(async (tx) => {
          await recordFactWithdrawal(tx, droppedId, 'default', false, { requestId: dropped });
          throw new Error('the caller refused after the withdrawal');
        });
      } catch (e) { refused = (e as Error).message; }

      const out = {
        result,
        refused,
        kept: await left(engine, keptId, kept, keptClaim),
        dropped: await left(engine, droppedId, dropped, droppedClaim),
      };
      expect(out).toEqual({
        result: { withdrawn: true, pages: [] },
        refused: 'the caller refused after the withdrawal',
        kept: { withdrawn: true, expired: true, review: [{ kind: 'withdraw', b_ref: '*' }],
          effects: [queued('embedding'), queued('git'), queued('withdrawal-mirror')] },
        dropped: { withdrawn: false, expired: false, review: [], effects: [] },
      });
      return out;
    });
});
