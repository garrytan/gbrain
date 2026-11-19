/**
 * BrainEngine parity: the fact purge's plan, transaction and segment-storage statements that ran through `executeRaw` in
 * src/core/facts/purge.ts (engine-sql/facts-purge.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listStagingPartEdges, listStagingsHoldingClaim, purgeSubjectPageLive, listPurgePagesById,
 *    countPurgeVersionsCarryingClaim, countPurgeReviewRows, listPurgeStreamSlugs, findPurgeBlockedPublication,
 *    listPagesForPurgeRewrite, updatePageBodyForPurge, setPurgeVersionBody, redactVersionChangeReasons,
 *    listSegmentedVersionsForPurge, abortPurgedStagings, deletePurgedStagingParts, deletePageViewDigests,
 *    deleteUnreferencedPurgedTexts, listPurgeMatchCandidates, lockPurgeSource, insertHoldingPagePurges, insertTakePurge,
 *    deletePurgedTakes, deletePurgeReviewQueue, deletePurgeReviewProposals, deletePurgeDecideProposals,
 *    deletePurgeTrustProposals, deletePurgeOpenLoops, deletePurgeWriteGateHolds, deletePurgeWriteGateReceipts,
 *    deletePurgeTakeProposals, blankPurgeCoreEditNotices, deletePurgedFacts, deletePurgedChunks, listPurgedPageRevisions
 *    and insertPurgeEffects return the same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that answers one of these differently changes which pages, versions, facts, chunks and
 *    review rows a fact purge finds and deletes, what its receipt counts, and whether a pending write blocks it; the Rust
 *    engine has no SQL, so each statement has to exist as a typed method it can implement or refuse.
 *  - Why existing coverage misses it: these statements ran through `executeRaw`, which the parity cases cannot call
 *    (D18), so no case compared them across engines.
 *  - Seam: none in the cases. Typed members only (no executeRaw: D18); the transaction members run inside
 *    `engine.transaction`. Not seeded, because no typed writer or harness fixture exists: page body stagings and their
 *    parts and texts, takes, take proposals, review queue and proposal rows, decide and trust proposals, open loops, write
 *    gate holds and receipts, core edit notices, page view digests and segmented versions. Those members are compared on
 *    empty tables (they answer zero or nothing on every arm), so they pin the statement's shape and the answer for no
 *    rows, not a deletion. insertHoldingPagePurges and insertTakePurge return nothing and have no typed reader, so they
 *    are compared by running without error. Generated values (page ids, revisions, version ids) are compared by relation
 *    or shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const LANE = 'hook:agent-session';
const HOLDING = 'memory/unattributed';
const REQ = 'b0000000-0000-4000-8000-0000000000b1';
const REQ2 = 'b0000000-0000-4000-8000-0000000000b2';
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}, type = 'note', extra: Record<string, unknown> = {}) =>
  ({ type: type as 'note', title, compiled_truth: body, frontmatter, ...extra });

/** The next fence row number of each engine, so every arm numbers its rows alike. */
const rows = new WeakMap<BrainEngine, number>();
function nextRow(engine: BrainEngine): number {
  const n = (rows.get(engine) ?? 0) + 1;
  rows.set(engine, n);
  return n;
}

/** One fact through the typed `insertFact`; `extra` overrides the defaults. Returns the id as a number. */
async function fact(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const out = await engine.insertFact({ fact: text, entity_slug: null, visibility: 'private', source: LANE, embedding: null, ...extra } as NewFact, { source_id: sourceId });
  expect(out.status).toBe('inserted');
  return Number(out.id);
}

/** A fact held by a page's fence: `insertFacts` keeps `row_num` and `source_markdown_slug`. */
async function fenced(engine: BrainEngine, text: string, extra: Record<string, unknown> = {}, sourceId = SRC): Promise<number> {
  const res = await engine.insertFacts([{ fact: text, entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: nextRow(engine), ...extra }] as never, { source_id: sourceId });
  return Number(res.ids[0]);
}

/** What each fact says and whether it is still live, by its text. */
async function liveness(engine: BrainEngine, sourceId = SRC): Promise<Record<string, boolean>> {
  const all = await engine.listFactsSince(sourceId, new Date(0), { activeOnly: false, limit: 1000 } as never);
  return Object.fromEntries(all.map(f => [f.fact, f.expired_at == null]).sort(([a], [b]) => String(a).localeCompare(String(b))));
}

/** One queued write request of the default source; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string, over: { operation?: string; slug?: string | null; intent?: unknown } = {}): Promise<string> {
  const source = await engine.readSourceMembership(SRC);
  await engine.lockPersistenceCounters(KEYS);
  const slug = over.slug === undefined ? 'notes/a' : over.slug;
  return (await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: over.operation ?? 'put_page', sourceId: SRC,
    sourceIncarnation: source!.incarnation, pageId: null, slug, worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: over.intent ?? { kind: 'put_page', slug }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  })).id;
}

const NO_STAGING = 'a0000000-0000-4000-8000-0000000000a1';
const NUMERIC = /^\d+$/;

describe('engine parity: fact purge plan, transaction and segment-storage statements of the facts store', () => {
  parityTest('purgeSubjectPageLive, listPurgePagesById, listPurgedPageRevisions and listPagesForPurgeRewrite read the source\'s pages by name and id', {
    methods: ['putPage', 'addTag', 'softDeletePage', 'purgeSubjectPageLive', 'listPurgePagesById', 'listPurgedPageRevisions', 'listPagesForPurgeRewrite'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const a = await engine.putPage('notes/a', note('A', 'Tea and milk'));
    const b = await engine.putPage('notes/b', note('B', 'nothing here'));
    await engine.putPage('notes/gone', note('Gone', 'deleted'));
    await engine.softDeletePage('notes/gone');
    const elsewhere = await engine.putPage('notes/c', note('C', 'in another source'), { sourceId: 'other' } as never);
    await engine.addTag('notes/a', 'zeta');
    await engine.addTag('notes/a', 'alpha');
    const slugOf = new Map([[a.id, 'notes/a'], [b.id, 'notes/b'], [elsewhere.id, 'notes/c']]);
    const ids = [a.id, b.id, elsewhere.id];
    const refs = await engine.listPurgePagesById(SRC, ids);
    const revisions = await engine.listPurgedPageRevisions(SRC, ids);
    const rewrite = await engine.listPagesForPurgeRewrite(SRC, ids);
    const answers = {
      live: [await engine.purgeSubjectPageLive(SRC, 'notes/a'), await engine.purgeSubjectPageLive(SRC, 'notes/gone'), await engine.purgeSubjectPageLive(SRC, 'notes/none'), await engine.purgeSubjectPageLive('other', 'notes/a')],
      refs: refs.map(r => ({ slug: r.slug, idMatches: slugOf.get(r.page_id) === r.slug, revisionIsNumeric: NUMERIC.test(r.revision) })).sort((x, y) => x.slug.localeCompare(y.slug)),
      revisions: revisions.map(r => ({ slug: r.slug, idMatches: slugOf.get(r.id) === r.slug, revisionIsNumeric: NUMERIC.test(r.knowledge_revision) })),
      rewrite: rewrite.map(r => ({ slug: r.slug, compiled: r.compiled_truth, tags: r.purge_tags })),
      none: [await engine.listPurgePagesById(SRC, []), await engine.listPurgedPageRevisions(SRC, [elsewhere.id]), await engine.listPagesForPurgeRewrite(SRC, [elsewhere.id])],
    };
    expect(answers.live).toEqual([true, false, false, false]);
    expect(answers.refs.map(r => r.slug)).toEqual(['notes/a', 'notes/b']);
    expect(answers.revisions.map(r => r.slug)).toEqual(['notes/a', 'notes/b']);
    expect(answers.rewrite).toEqual([{ slug: 'notes/a', compiled: 'Tea and milk', tags: ['alpha', 'zeta'] }, { slug: 'notes/b', compiled: 'nothing here', tags: [] }]);
    expect(answers.none).toEqual([[], [], []]);
    return answers;
  });

  parityTest('countPurgeVersionsCarryingClaim counts the saved versions that carry a claim in their text or change reason, and listSegmentedVersionsForPurge finds no segmented version of an inline page', {
    methods: ['putPage', 'createVersion', 'countPurgeVersionsCarryingClaim', 'listSegmentedVersionsForPurge'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const a = await engine.putPage('notes/a', note('A', 'Alice likes tea'));
    await engine.createVersion('notes/a', { sourceId: SRC });
    await engine.putPage('notes/a', note('A', 'rewritten clean'));
    await engine.createVersion('notes/a', { sourceId: SRC, reason: 'dropped Alice likes tea' });
    await engine.createVersion('notes/a', { sourceId: SRC, reason: 'plain edit' });
    await engine.putPage('notes/c', note('C', 'Alice likes tea'), { sourceId: 'other' } as never);
    await engine.createVersion('notes/c', { sourceId: 'other' });
    const count = (source: string, needle: string, reason = needle) => engine.countPurgeVersionsCarryingClaim(source, needle, needle, reason);
    const answers = {
      inText: await count(SRC, 'alice likes tea', 'zzz'), none: await count(SRC, 'no such claim'), other: await count('other', 'alice likes tea', 'zzz'),
      segmented: await engine.listSegmentedVersionsForPurge(SRC, 'alice likes tea', [a.id], 0),
    };
    expect(answers.inText).toBeGreaterThanOrEqual(2);
    expect(answers.none).toBe(0);
    expect(answers.other).toBe(1);
    expect(answers.segmented).toEqual([]);
    return answers;
  });

  parityTest('updatePageBodyForPurge, setPurgeVersionBody and redactVersionChangeReasons rewrite a page\'s body, a version\'s body and the change reasons that quote a claim', {
    methods: ['putPage', 'getPage', 'createVersion', 'getVersions', 'listPageChangeReasons', 'transaction', 'updatePageBodyForPurge', 'setPurgeVersionBody', 'redactVersionChangeReasons'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/a', note('A', 'Alice likes tea'));
    await engine.createVersion('notes/a', { sourceId: SRC, reason: 'noted Alice likes tea' });
    await engine.createVersion('notes/a', { sourceId: SRC, reason: 'plain edit' });
    await engine.putPage('notes/c', note('C', 'Alice likes tea'), { sourceId: 'other' } as never);
    await engine.createVersion('notes/c', { sourceId: 'other', reason: 'noted Alice likes tea' });
    const page = (await engine.getPage('notes/a'))!;
    const before = await engine.getVersions('notes/a', { sourceId: SRC });
    const target = before.reduce((newest, v) => (v.id > newest.id ? v : newest));
    const reasons = async (slug: string, sourceId: string, pageId: number) => (await engine.listPageChangeReasons(sourceId, slug, pageId)).map(r => r.reason).sort((x, y) => String(x).localeCompare(String(y)));
    const reasonsBefore = await reasons('notes/a', SRC, page.id);
    const redacted = await engine.transaction(async tx => {
      await tx.updatePageBodyForPurge(SRC, page.id, 'rewritten', 'a timeline', 'hash-after');
      await tx.setPurgeVersionBody(target.id, 'version rewritten', null);
      return tx.redactVersionChangeReasons(SRC, 'alice likes tea', 'no such reason');
    });
    const none = await engine.transaction(tx => tx.redactVersionChangeReasons(SRC, 'no such claim', 'no such reason'));
    const after = await engine.getPage('notes/a');
    const versions = await engine.getVersions('notes/a', { sourceId: SRC });
    const other = (await engine.getPage('notes/c', { sourceId: 'other' } as never))!;
    const answers = {
      redacted: redacted.length, none: none.length,
      page: after && { compiled: after.compiled_truth, timeline: after.timeline, hash: after.content_hash },
      reasonsBefore, reasons: await reasons('notes/a', SRC, page.id), bodies: versions.map(v => v.compiled_truth).sort(),
      elsewhere: await reasons('notes/c', 'other', other.id),
    };
    expect(answers.redacted).toBe(1);
    expect(answers.none).toBe(0);
    expect(answers.page?.compiled).toBe('rewritten');
    expect(answers.reasonsBefore).toEqual(['noted Alice likes tea', 'plain edit']);
    expect(answers.reasons).toEqual(['[purged]', 'plain edit']);
    expect(answers.bodies).toEqual(['Alice likes tea', 'version rewritten']);
    expect(answers.elsewhere).toEqual(['noted Alice likes tea']);
    return answers;
  });

  parityTest('listPurgeStreamSlugs, listPurgeMatchCandidates and deletePurgedFacts find and delete the facts of a purge', {
    methods: ['insertFact', 'insertFacts', 'listFactsSince', 'transaction', 'listPurgeStreamSlugs', 'listPurgeMatchCandidates', 'deletePurgedFacts'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const held = await fenced(engine, 'Alice likes tea', { source_markdown_slug: 'people/alice', entity_slug: 'people/alice', visibility: 'private' });
    const aboutBob = await fact(engine, 'Bob likes TEA a lot', { entity_slug: 'people/bob' });
    const unnamed = await fact(engine, 'tea with no subject');
    const expired = await fact(engine, 'old tea habit', { entity_slug: 'people/alice' });
    await engine.expireFact(expired);
    await fact(engine, 'Alice likes tea', { entity_slug: 'people/alice' }, 'other');
    await fact(engine, 'x'.repeat(200) + ' tea');
    const slugs = await engine.transaction(tx => tx.listPurgeStreamSlugs([held, aboutBob, unnamed, expired]));
    const noSlugs = await engine.transaction(tx => tx.listPurgeStreamSlugs([unnamed]));
    const candidates = (await engine.listPurgeMatchCandidates(SRC, 'Tea')).map(c => ({ entity: c.entity_slug, visibility: c.visibility, expired: c.expired, fact: c.fact }));
    const none = await engine.listPurgeMatchCandidates(SRC, 'no such text');
    const deleted = await engine.transaction(tx => tx.deletePurgedFacts([held, aboutBob, expired], SRC));
    const wrongSource = await engine.transaction(tx => tx.deletePurgedFacts([unnamed], 'other'));
    const answers = { slugs: [...slugs].sort(), noSlugs, candidates, none, deleted, wrongSource, left: await liveness(engine) };
    expect(answers.slugs).toEqual(['people/alice', 'people/bob']);
    expect(answers.noSlugs).toEqual([]);
    expect(answers.candidates).toHaveLength(5);
    expect(answers.candidates[4]?.fact).toHaveLength(160);
    expect(answers.deleted).toBe(3);
    expect(answers.wrongSource).toBe(0);
    expect(Object.keys(answers.left)).toHaveLength(2);
    return answers;
  });

  parityTest('findPurgeBlockedPublication finds an unfinished write on a page that is not the purge\'s own request, and lockPurgeSource locks the source row', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transaction', 'findPurgeBlockedPublication', 'lockPurgeSource'],
  }, async (engine) => {
    const journal = await admit(engine, REQ, { slug: 'notes/a' });
    const own = await admit(engine, REQ2, { slug: 'notes/b', operation: 'purge_fact' });
    const answers = await engine.transaction(async tx => ({
      blocked: await tx.findPurgeBlockedPublication(SRC, ['notes/a', 'notes/b'], own),
      ownOnly: await tx.findPurgeBlockedPublication(SRC, ['notes/b'], own),
      otherPage: await tx.findPurgeBlockedPublication(SRC, ['notes/none'], own),
      otherSource: await tx.findPurgeBlockedPublication('other', ['notes/a'], own),
      lock: await tx.lockPurgeSource(SRC),
      noSource: await tx.lockPurgeSource('no-such-source'),
    }));
    expect(journal).not.toBe(own);
    expect(answers.blocked).toEqual({ request_id: REQ, slug: 'notes/a', state: 'queued' });
    expect(answers.ownOnly).toBeNull();
    expect(answers.otherPage).toBeNull();
    expect(answers.otherSource).toBeNull();
    expect(answers.lock?.archived).toBe(false);
    expect(answers.noSource).toBeNull();
    return { ...answers, lock: answers.lock && { archived: answers.lock.archived, incarnationIsText: typeof answers.lock.incarnation === 'string' } };
  });

  parityTest('insertPurgeEffects queues a purge request\'s three effects once, and deletePurgedChunks removes a page\'s chunks', {
    methods: ['putPage', 'upsertChunks', 'getChunks', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transaction', 'listPurgeEffects', 'insertPurgeEffects', 'deletePurgedChunks'],
  }, async (engine) => {
    const journal = await admit(engine, REQ, { operation: 'purge_fact' });
    const a = await engine.putPage('notes/a', note('A', 'body'));
    const b = await engine.putPage('notes/b', note('B', 'body'));
    await engine.upsertChunks('notes/a', [{ chunk_index: 0, chunk_text: 'a chunk', chunk_source: 'compiled_truth' }]);
    const effects = async () => (await engine.listPurgeEffects(journal)).map(e => [e.kind, e.state]);
    const before = await effects();
    await engine.transaction(tx => tx.insertPurgeEffects(journal, SRC, { version: 2, mode: 'purge' }));
    await engine.transaction(tx => tx.insertPurgeEffects(journal, SRC, { version: 2, mode: 'purge' }));
    const queued = await effects();
    const unknownSource = await engine.transaction(async tx => { await tx.insertPurgeEffects(journal, 'no-such-source', {}); return (await tx.listPurgeEffects(journal)).length; });
    const chunks = await engine.transaction(async tx => ({ withChunks: await tx.deletePurgedChunks([a.id, b.id]), again: await tx.deletePurgedChunks([a.id]), none: await tx.deletePurgedChunks([]) }));
    const left = await engine.getChunks('notes/a', { includeUnsealed: true });
    const answers = { before, queued, unknownSource, chunks, left: left.length };
    expect(answers.before).toEqual([]);
    expect(answers.queued).toEqual([['embedding', 'queued'], ['git', 'queued'], ['withdrawal-mirror', 'queued']]);
    expect(answers.unknownSource).toBe(3);
    expect(answers.chunks).toEqual({ withChunks: 1, again: 0, none: 0 });
    expect(answers.left).toBe(0);
    return answers;
  });

  parityTest('insertHoldingPagePurges and insertTakePurge store their tombstones without error, none twice', {
    methods: ['insertFacts', 'transaction', 'insertHoldingPagePurges', 'insertTakePurge'],
  }, async (engine) => {
    const held = await fenced(engine, 'Alice likes tea', { source_markdown_slug: HOLDING, entity_slug: 'people/alice', visibility: 'private' });
    const answers = await engine.transaction(async tx => {
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-a', REQ, 'local_cli:me', 'because', [held]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-a', REQ, 'local_cli:me', null, [held]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-a', REQ, 'local_cli:me', 'because', []);
      await tx.insertTakePurge(SRC, '*', 'hash-a', REQ);
      await tx.insertTakePurge(SRC, '*', 'hash-a', REQ);
      return 'stored';
    });
    expect(answers).toBe('stored');
    return answers;
  });

  parityTest('the review, proposal, gate, take and staging statements of a purge answer zero or nothing on an engine with none of those rows', {
    methods: [
      'transaction', 'listStagingPartEdges', 'listStagingsHoldingClaim', 'countPurgeReviewRows', 'abortPurgedStagings', 'deletePurgedStagingParts',
      'deletePageViewDigests', 'deleteUnreferencedPurgedTexts', 'deletePurgedTakes', 'deletePurgeReviewQueue', 'deletePurgeReviewProposals',
      'deletePurgeDecideProposals', 'deletePurgeTrustProposals', 'deletePurgeOpenLoops', 'deletePurgeWriteGateHolds', 'deletePurgeWriteGateReceipts',
      'deletePurgeTakeProposals', 'blankPurgeCoreEditNotices',
    ],
  }, async (engine) => {
    const answers = {
      edges: await engine.listStagingPartEdges(SRC, 8, { id: NO_STAGING, part: 0 }),
      holding: await engine.listStagingsHoldingClaim(SRC, 'Alice likes tea'),
      review: await engine.countPurgeReviewRows(SRC, ['1', '2'], [1, 2]),
      reviewNone: await engine.countPurgeReviewRows(SRC, [], []),
      ...(await engine.transaction(async tx => ({
        aborted: await tx.abortPurgedStagings([NO_STAGING]),
        parts: await tx.deletePurgedStagingParts([NO_STAGING]),
        texts: await tx.deleteUnreferencedPurgedTexts(SRC, [new Uint8Array([1, 171])], 'Alice | tea'),
        takes: await tx.deletePurgedTakes([1, 2]),
        reviewQueue: await tx.deletePurgeReviewQueue(SRC, ['1', '2']),
        reviewProposals: await tx.deletePurgeReviewProposals(SRC, ['1', '2']),
        decideProposals: await tx.deletePurgeDecideProposals(SRC, [1, 2]),
        trustProposals: await tx.deletePurgeTrustProposals(SRC, [1, 2], [5]),
        openLoops: await tx.deletePurgeOpenLoops(SRC, [1, 2]),
        holds: await tx.deletePurgeWriteGateHolds(SRC, 'hash-a'),
        receipts: await tx.deletePurgeWriteGateReceipts(['1', '2'], ['5'], ['h1']),
        takeProposals: await tx.deletePurgeTakeProposals(SRC, 'hash-a'),
        notices: await tx.blankPurgeCoreEditNotices(SRC, 'alice likes tea'),
        digests: await tx.deletePageViewDigests([1, 2]),
      }))),
    };
    expect(answers).toEqual({
      edges: [], holding: [], review: { decide_review_queue: 0, decide_review_proposals: 0, decide_proposals: 0 },
      reviewNone: { decide_review_queue: 0, decide_review_proposals: 0, decide_proposals: 0 }, aborted: [], parts: 0, texts: 0, takes: 0,
      reviewQueue: 0, reviewProposals: 0, decideProposals: 0, trustProposals: 0, openLoops: 0, holds: [], receipts: 0, takeProposals: 0,
      notices: 0, digests: undefined,
    });
    return answers;
  });
});
