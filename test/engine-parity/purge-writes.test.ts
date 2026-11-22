/**
 * BrainEngine parity: the writes a fact purge runs in its transaction (engine-sql/facts-purge.ts), seeded and read
 * through typed members only, so the Rust arm runs them end to end.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: deletePurgedTakes, deletePurgeReviewQueue, deletePurgeReviewProposals, deletePurgeDecideProposals,
 *    deletePurgeTrustProposals, deletePurgeOpenLoops, deletePurgeWriteGateHolds, deletePurgeWriteGateReceipts,
 *    blankPurgeCoreEditNotices, deletePurgedFacts, deletePurgedChunks, listPagesForPurgeRewrite and
 *    updatePageBodyForPurge, and rewritePageBodies (facts/purge.ts) over an inline page, return the same observable
 *    result on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently deletes other rows than a purge on Postgres would, or
 *    leaves the purged claim in a page body.
 *  - Why existing coverage misses it: test/engine-parity/fact-purge-sites.test.ts compares these members beside
 *    statements the Rust store does not serve (raw fixtures, segmented stagings), so on the Rust arm those cases stop on
 *    a typed refusal before they reach these members.
 *  - Seam: none; every row is written and read through typed members. Generated values (ids, revisions) are compared by
 *    relation or label, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { renderFactsTable, type ParsedFact } from '../../src/core/facts-fence.ts';
import { rewritePageBodies } from '../../src/core/facts/purge.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';

const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

/** One fact through the typed `insertFact`; returns its id as a number. */
async function fact(engine: BrainEngine, text: string, sourceId = SRC): Promise<number> {
  const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'private', source: 'parity', embedding: null } as NewFact,
    { source_id: sourceId });
  expect(out.status).toBe('inserted');
  return Number(out.id);
}

/** The facts of a source by text, and whether each is still stored. */
async function factTexts(engine: BrainEngine, sourceId = SRC): Promise<string[]> {
  const all = await engine.listFactsSince(sourceId, new Date(0), { activeOnly: false, limit: 1000 } as never);
  return all.map(f => String(f.fact)).sort();
}

const row = (rowNum: number, claim: string): ParsedFact => ({
  rowNum, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', validFrom: '2024-01-01', source: 'user', active: true,
});

describe('engine parity: the writes of a fact purge', () => {
  parityTest('the purge deletes and the notice blank answer zero or nothing on an engine with none of those rows', {
    methods: ['transaction', 'deletePurgedTakes', 'deletePurgeReviewQueue', 'deletePurgeReviewProposals', 'deletePurgeDecideProposals',
      'deletePurgeTrustProposals', 'deletePurgeOpenLoops', 'deletePurgeWriteGateHolds', 'deletePurgeWriteGateReceipts',
      'blankPurgeCoreEditNotices', 'deletePurgedFacts', 'deletePurgedChunks', 'listPagesForPurgeRewrite'],
  }, async (engine) => engine.transaction(async tx => ({
    takes: await tx.deletePurgedTakes([1, 2]),
    takesNone: await tx.deletePurgedTakes([]),
    reviewQueue: await tx.deletePurgeReviewQueue(SRC, ['1', '2']),
    reviewProposals: await tx.deletePurgeReviewProposals(SRC, ['1']),
    decideProposals: await tx.deletePurgeDecideProposals(SRC, [1, 2]),
    trustProposals: await tx.deletePurgeTrustProposals(SRC, [1, 2], [5]),
    openLoops: await tx.deletePurgeOpenLoops(SRC, [1, 2]),
    holds: await tx.deletePurgeWriteGateHolds(SRC, 'hash-a'),
    receipts: await tx.deletePurgeWriteGateReceipts(['1', '2'], ['5'], ['h1']),
    notices: await tx.blankPurgeCoreEditNotices(SRC, 'alice likes tea'),
    facts: await tx.deletePurgedFacts([1, 2], SRC),
    chunks: await tx.deletePurgedChunks([1, 2]),
    pages: await tx.listPagesForPurgeRewrite(SRC, [1, 2]),
  })));

  parityTest('deletePurgedFacts deletes the source\'s facts with these ids and no other', {
    methods: ['insertFact', 'listFactsSince', 'transaction', 'deletePurgedFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const tea = await fact(engine, 'Alice likes tea');
    await fact(engine, 'Alice likes coffee');
    const elsewhere = await fact(engine, 'Alice likes tea', 'other');
    const before = await factTexts(engine);
    const deleted = await engine.transaction(async tx => ({
      first: await tx.deletePurgedFacts([tea, elsewhere, 999999], SRC),
      again: await tx.deletePurgedFacts([tea], SRC),
    }));
    return { before, deleted, after: await factTexts(engine), other: await factTexts(engine, 'other') };
  });

  parityTest('deletePurgedChunks deletes the chunks of the pages and counts the rows', {
    methods: ['putPage', 'upsertChunks', 'getChunks', 'transaction', 'deletePurgedChunks'],
  }, async (engine) => {
    const a = await engine.putPage('notes/a', note('A', 'body a'));
    const b = await engine.putPage('notes/b', note('B', 'body b'));
    const c = await engine.putPage('notes/c', note('C', 'body c'));
    await engine.upsertChunks('notes/a', [{ chunk_index: 0, chunk_text: 'a one', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'a two', chunk_source: 'compiled_truth' }]);
    await engine.upsertChunks('notes/c', [{ chunk_index: 0, chunk_text: 'c one', chunk_source: 'compiled_truth' }]);
    const deleted = await engine.transaction(async tx => ({
      first: await tx.deletePurgedChunks([Number(a.id), Number(b.id)]),
      again: await tx.deletePurgedChunks([Number(a.id)]),
    }));
    const count = async (slug: string) => (await engine.getChunks(slug)).length;
    return { deleted, a: await count('notes/a'), b: await count('notes/b'), c: await count('notes/c'), cId: typeof c.id };
  });

  parityTest('listPagesForPurgeRewrite and updatePageBodyForPurge read a page with its tags and store a purged body', {
    methods: ['putPage', 'addTag', 'getPage', 'transaction', 'listPagesForPurgeRewrite', 'updatePageBodyForPurge'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const a = await engine.putPage('notes/a', note('A', 'Tea and milk'));
    const elsewhere = await engine.putPage('notes/c', note('C', 'in another source'), { sourceId: 'other' } as never);
    await engine.addTag('notes/a', 'zeta');
    await engine.addTag('notes/a', 'alpha');
    const rows = await engine.listPagesForPurgeRewrite(SRC, [Number(a.id), Number(elsewhere.id)]);
    const before = await engine.getPage('notes/a');
    await engine.transaction(async tx => {
      await tx.updatePageBodyForPurge(SRC, Number(a.id), 'Milk only', 'a timeline', 'hash-after');
      await tx.updatePageBodyForPurge(SRC, Number(elsewhere.id), 'not this one', '', 'hash-other');
    });
    const after = await engine.getPage('notes/a');
    const other = await engine.getPage('notes/c', { sourceId: 'other' } as never);
    return {
      rows: rows.map(r => ({ slug: r.slug, compiled: r.compiled_truth, storage: r.body_storage, tags: r.purge_tags, idMatches: Number(r.id) === Number(a.id) })),
      after: { compiled: after?.compiled_truth, timeline: after?.timeline, hash: after?.content_hash, revisionMoved: after?.knowledge_revision !== before?.knowledge_revision },
      other: other?.compiled_truth,
    };
  });

  parityTest('rewritePageBodies drops a purged fence row from an inline page and leaves the rest', {
    methods: ['putPage', 'insertFacts', 'loadPurgeTarget', 'insertFactPurge', 'getPage', 'transaction', 'listPagesForPurgeRewrite', 'updatePageBodyForPurge'],
  }, async (engine) => {
    const slug = 'people/ana-example';
    const body = `Ana Example.\n\n## Facts\n\n${renderFactsTable([row(1, 'Ana lives in Lima'), row(2, 'Ana keeps bees')])}\n`;
    const page = await engine.putPage(slug, { type: 'person', title: 'Ana Example', compiled_truth: body, timeline: '' });
    const out = await engine.insertFacts([{ fact: 'Ana keeps bees', entity_slug: slug, source_markdown_slug: slug, row_num: 2, kind: 'fact',
      visibility: 'world', source: 'fence' }] as never, { source_id: SRC }) as { ids: number[] };
    const hash = (await engine.loadPurgeTarget(out.ids[0]!, SRC))!.fact_hash;
    await engine.insertFactPurge({ sourceId: SRC, visibility: 'world', subject: '*', factHash: hash, requestId: null, actor: 'owner:local', reason: 'parity' });
    const before = await engine.getPage(slug);
    const result = await engine.transaction(tx => rewritePageBodies(tx, SRC, [{ slug, page_id: Number(page.id), revision: String(before!.knowledge_revision) }]));
    const after = await engine.getPage(slug);
    return {
      rewritten: result.rewritten, segmented: result.segmented,
      keeps: after?.compiled_truth.includes('Ana lives in Lima'), drops: !after?.compiled_truth.includes('Ana keeps bees'),
      revisionMoved: after?.knowledge_revision !== before?.knowledge_revision,
    };
  });
});
