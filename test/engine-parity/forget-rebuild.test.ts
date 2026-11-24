/**
 * BrainEngine parity — the chunk rebuild a forget runs after it commits (forget-prepare.ts `afterCommit`,
 * rebuildPendingPageProjections in src/core/page-state/projections.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a forget's withdrawal removes the chunks of the page that carries the claim and queues its projection.
 *    The rebuild of that page (`pages` of one source, as the forget calls it) answers `{ rebuilt: 1, superseded: 0 }`,
 *    gives the page its chunks back at the new revision, and leaves nothing queued: a second rebuild answers
 *    `{ rebuilt: 0, superseded: 0 }`. The answers are equal on every engine arm.
 *  - Regression: the rebuild listed and consumed its queue rows, planned which chunks to keep and stamped the page
 *    through `executeRaw`, which the Rust engine refuses. The forget swallows a failed rebuild, so on a Rust brain the
 *    withdrawn page kept no chunks and its projection stayed queued while PGLite and Postgres rebuilt it.
 *  - Why existing coverage misses it: test/engine-parity/withdrawal-forget.test.ts stops at the commit (chunks 0),
 *    and the projection tests run on PGLite and Postgres only.
 *  - Seam: the forget is its commit (recordFactWithdrawal under a write request, as in withdrawal-forget.test.ts);
 *    the rebuild runs whole. Revisions differ between arms, so they are compared only as changed or equal.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { rebuildPendingPageProjections } from '../../src/core/page-state/projections.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const KEYS = ['principal:local_cli:forget-writer', 'brain'];
const PAGE = 'people/bob-example';

/** Admits one queued forget request under `requestId`; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string): Promise<string> {
  const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  await engine.lockPersistenceCounters(KEYS);
  return (await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'forget-writer', requestId, operation: 'forget_fact', sourceId: 'default',
    sourceIncarnation: incarnation, pageId: null, slug: PAGE, worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: { kind: 'forget_fact' }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'test', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  })).id;
}

const fenced = (claims: string[]) => renderFactsTable(claims.map((claim, i) =>
  ({ rowNum: i + 1, claim, visibility: 'world' as const, kind: 'fact' as const, confidence: 1, notability: 'medium' as const, active: true })));

/** Inserts the world facts the page's fence holds, under the operator tier; returns their ids. */
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

/** The page's knowledge revision and the text of the chunks it holds. */
async function pageState(engine: BrainEngine, pageId: number) {
  const [row] = await engine.readWithdrawalDiscovery({ kind: 'target_pages', sourceId: 'default', ids: [pageId] });
  const chunks = await engine.getChunks(PAGE, { includeUnsealed: true });
  return { revision: row!.revision, chunks: chunks.map(c => ({ index: c.chunk_index, source: c.chunk_source, text: c.chunk_text })) };
}

describe('engine parity: the chunk rebuild after a forget', () => {
  parityTest('rebuilds the withdrawn page once, gives it its chunks back and leaves nothing queued',
    { methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transaction', 'applyTransactionSettings', 'insertFacts',
      'putPage', 'upsertChunks', 'getChunks', 'readWithdrawalDiscovery', 'lockSourceRow', 'readFactWithdrawalClaim', 'hasCoveringFactWithdrawal',
      'listWithdrawalSlugs', 'lockPageKeys', 'insertFactWithdrawal', 'expireFactsByWithdrawal', 'listSegmentedPages', 'invalidateWithdrawnPages',
      'deleteChunksForPages', 'insertWithdrawalEffects', 'getConfigValues', 'readPageSnapshot', 'listQueuedPageProjections',
      'readProjectionJobReason', 'readChunkKeepState', 'clearUnkeptChunkVectors', 'setProjectionChunkerVersion', 'deleteProjectionJob'] },
    async (engine) => {
      const forgotten = 'Bob keeps bees on the roof';
      const kept = 'Bob keeps a boat in the bay';
      const page = await engine.putPage(PAGE, { type: 'person', title: 'Bob', compiled_truth: `Bob sails on weekends.\n\n${fenced([forgotten, kept])}`, timeline: '', frontmatter: {} });
      await engine.upsertChunks(PAGE, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Bob sails on weekends.' }]);
      const [forgottenId] = await pageFacts(engine, [forgotten, kept]);
      const request = await admit(engine, 'b0000000-0000-4000-8000-0000000000d1');
      const before = await pageState(engine, page.id);

      const result = await engine.transaction(tx => recordFactWithdrawal(tx, forgottenId!, 'default', false, { requestId: request, semanticReview: false }));
      const forgottenState = await pageState(engine, page.id);
      const pages = { sourceId: 'default', slugs: result.pages.map(p => p.slug) };
      const first = await rebuildPendingPageProjections(engine, 100, { pages });
      const rebuiltState = await pageState(engine, page.id);
      const second = await rebuildPendingPageProjections(engine, 100, { pages });

      const out = {
        withdrawnPages: pages.slugs,
        forgotten: { revisionChanged: forgottenState.revision !== before.revision, chunks: forgottenState.chunks.length },
        first,
        rebuilt: { sameRevision: rebuiltState.revision === forgottenState.revision, chunks: rebuiltState.chunks },
        second,
      };
      expect(out.withdrawnPages).toEqual([PAGE]);
      expect(out.forgotten).toEqual({ revisionChanged: true, chunks: 0 });
      expect(out.first).toEqual({ rebuilt: 1, superseded: 0 });
      expect(out.rebuilt.sameRevision).toBe(true);
      expect(out.rebuilt.chunks.length).toBeGreaterThan(0);
      expect(out.rebuilt.chunks.some(c => c.text.includes('Bob sails on weekends.'))).toBe(true);
      expect(out.second).toEqual({ rebuilt: 0, superseded: 0 });
      return out;
    });
});
