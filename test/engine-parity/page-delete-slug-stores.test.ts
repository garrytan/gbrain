/**
 * BrainEngine parity: a page hard delete removes the take proposals and open loops filed under the page's slug.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `deletePages` and `purgeDeletedPages` delete, in the same transaction as the page, every take proposal and
 *    open loop of the page's source whose `page_slug` is the deleted slug (engine-sql/purge-slug-stores.ts
 *    SLUG_STORE_DELETES). Rows of another page, and rows of the same slug in another source, stay. Every engine does the
 *    same.
 *  - Regression: an engine that keeps them leaves proposals to re-promote and loops to nudge about a page that is gone,
 *    and a later page at the same slug inherits them.
 *  - Why existing coverage misses it: the page delete parity cases read pages, chunks and facts, and the slug-store scrub
 *    (deletePurgedSlugStoreRows) is checked as a member call, not through the deletes that run it.
 *  - Seam: none. Real engines, typed members only.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER_SRC = 'other';
const PAGE = 'people/deleted-example';
const KEPT = 'notes/kept-example';
const AT = '2026-03-01T10:00:00.000Z';

async function seed(engine: BrainEngine, backend: string): Promise<void> {
  await createSource(engine, backend as never, OTHER_SRC);
  for (const [source, slug] of [[SRC, PAGE], [SRC, KEPT], [OTHER_SRC, PAGE]] as const) {
    await engine.putPage(slug, { type: 'person' as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '' }, { sourceId: source });
    const id = await engine.insertTakeProposal({ sourceId: source, pageSlug: slug, contentHash: `hash-${slug}`, promptVersion: 'parity-v1',
      proposalRunId: 'run-1', claimText: `A claim about ${slug} in ${source}`, kind: 'bet', holder: 'brain', weight: 0.6, domain: null, dedupAgainst: [],
      modelId: 'parity-model' });
    expect(id).not.toBeNull();
    await engine.upsertOpenLoop({ sourceId: source, dedupKey: `loop-${source}-${slug}`, loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com',
      summary: `Follow up on ${slug}`, evidence: [], pageSlug: slug, detector: 'manual', lastActivityAt: AT, openedAt: AT });
  }
}

/** The proposals and loops of both sources, as `source:page_slug` keys in byte order. */
async function slugRows(engine: BrainEngine) {
  const proposals: string[] = [];
  for (const sourceId of [SRC, OTHER_SRC]) {
    for (const p of await engine.listPendingTakeProposals({ sourceId, limit: 100 })) {
      const row = p as unknown as { source_id: string; page_slug: string };
      proposals.push(`${row.source_id}:${row.page_slug}`);
    }
  }
  const loops = (await engine.listOpenLoops({ sourceIds: [SRC, OTHER_SRC] }))
    .map(l => `${(l as unknown as { source_id: string }).source_id}:${(l as unknown as { page_slug: string | null }).page_slug}`);
  const order = (rows: string[]) => [...rows].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { proposals: order(proposals), loops: order(loops) };
}

const ALL = ['default:notes/kept-example', 'default:people/deleted-example', 'other:people/deleted-example'];
const AFTER = ['default:notes/kept-example', 'other:people/deleted-example'];

parityTest('deletePages removes the take proposals and open loops filed under the deleted slug, and only those', {
  methods: ['putPage', 'insertTakeProposal', 'upsertOpenLoop', 'deletePages', 'listPendingTakeProposals', 'listOpenLoops'],
  timeout: 60_000,
}, async (engine, backend) => {
  await seed(engine, backend);
  const before = await slugRows(engine);
  expect(before).toEqual({ proposals: ALL, loops: ALL });
  expect(await engine.deletePages([PAGE], { sourceId: SRC })).toEqual([PAGE]);
  const after = await slugRows(engine);
  expect(after).toEqual({ proposals: AFTER, loops: AFTER });
  return { before, after };
});

parityTest('purgeDeletedPages removes the take proposals and open loops filed under a purged slug, and only those', {
  methods: ['putPage', 'insertTakeProposal', 'upsertOpenLoop', 'softDeletePage', 'purgeDeletedPages', 'listPendingTakeProposals', 'listOpenLoops'],
  timeout: 60_000,
}, async (engine, backend) => {
  await seed(engine, backend);
  expect(await engine.softDeletePage(PAGE, { sourceId: SRC })).toEqual({ slug: PAGE });
  const purged = await engine.purgeDeletedPages(0);
  expect(purged.slugs).toEqual([PAGE]);
  const after = await slugRows(engine);
  expect(after).toEqual({ proposals: AFTER, loops: AFTER });
  return { count: purged.count, after };
});
