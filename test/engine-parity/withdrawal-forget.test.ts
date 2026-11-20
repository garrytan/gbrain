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
import { renderFactsTable } from '../../src/core/facts-fence.ts';
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

const PAGE = 'people/bob-example';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fenced = (claims: string[]) => renderFactsTable(claims.map((claim, i) =>
  ({ rowNum: i + 1, claim, visibility: 'world' as const, kind: 'fact' as const, confidence: 1, notability: 'medium' as const, active: true })));

/** Inserts the world facts a page's fence holds, on that page and its entity, under the operator tier; returns their ids. */
async function pageFacts(engine: BrainEngine, claims: string[]): Promise<number[]> {
  let ids: number[] = [];
  await engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'operator_curated' })]);
    const out = await tx.insertFacts(claims.map((fact, i) => ({
      fact, entity_slug: PAGE, source_markdown_slug: PAGE, row_num: i + 1, kind: 'fact',
      visibility: 'world', source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1)),
    })) as never, { source_id: 'default' });
    ids = out.ids.map(Number);
  });
  return ids;
}

/** The page's knowledge revision and how many chunks it holds. */
async function pageState(engine: BrainEngine, pageId: number) {
  const [row] = await engine.readWithdrawalDiscovery({ kind: 'target_pages', sourceId: 'default', ids: [pageId] });
  return { revision: row!.revision, chunks: (await engine.getChunks(PAGE, { includeUnsealed: true })).length };
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

  parityTest('invalidates the page that carries the claim with the withdrawal, and a throw after it leaves the page as it was',
    { methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transaction', 'applyTransactionSettings', 'insertFacts',
      'putPage', 'upsertChunks', 'getChunks', 'readWithdrawalDiscovery', 'lockSourceRow', 'readFactWithdrawalClaim', 'hasCoveringFactWithdrawal',
      'listWithdrawalSlugs', 'lockPageKeys', 'insertFactWithdrawal', 'expireFactsByWithdrawal', 'listSegmentedPages', 'invalidateWithdrawnPages',
      'deleteChunksForPages', 'insertWithdrawalEffects', 'readRequestEffects'] },
    async (engine) => {
      const kept = 'Bob keeps bees on the roof';
      const dropped = 'Bob keeps a boat in the bay';
      const page = await engine.putPage(PAGE, { type: 'person', title: 'Bob', compiled_truth: `Bob.\n\n${fenced([kept, dropped])}`, timeline: '', frontmatter: {} });
      await engine.upsertChunks(PAGE, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Bob keeps bees.' }]);
      const [keptId, droppedId] = await pageFacts(engine, [kept, dropped]);
      const keptReq = await admit(engine, 'b0000000-0000-4000-8000-0000000000c1');
      const droppedReq = await admit(engine, 'b0000000-0000-4000-8000-0000000000c2');
      const before = await pageState(engine, page.id);

      let refused = '';
      try {
        await engine.transaction(async (tx) => {
          await recordFactWithdrawal(tx, droppedId!, 'default', false, { requestId: droppedReq, semanticReview: false });
          throw new Error('the caller refused after the withdrawal');
        });
      } catch (e) { refused = (e as Error).message; }
      const afterThrow = await pageState(engine, page.id);
      const droppedEffects = await engine.readRequestEffects(droppedReq);

      const result = await engine.transaction(tx => recordFactWithdrawal(tx, keptId!, 'default', false, { requestId: keptReq, semanticReview: false }));
      const after = await pageState(engine, page.id);

      const out = {
        refused,
        afterThrow: { revision: afterThrow.revision === before.revision, chunks: afterThrow.chunks, effects: droppedEffects },
        result: { withdrawn: result.withdrawn, pages: result.pages.map(p => ({ sourceId: p.sourceId, slug: p.slug, revision: UUID.test(p.revision) })) },
        after: { revisionChanged: after.revision !== before.revision, committed: result.pages[0]?.revision === after.revision, chunks: after.chunks },
        effects: await engine.readRequestEffects(keptReq),
      };
      expect(out).toEqual({
        refused: 'the caller refused after the withdrawal',
        afterThrow: { revision: true, chunks: 1, effects: [] },
        result: { withdrawn: true, pages: [{ sourceId: 'default', slug: PAGE, revision: true }] },
        after: { revisionChanged: true, committed: true, chunks: 0 },
        effects: [queued('embedding'), queued('git'), queued('withdrawal-mirror')],
      });
      return out;
    });
});
