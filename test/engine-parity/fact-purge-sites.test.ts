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
 *  - Seam: none in the cases that seed through typed members (no executeRaw: D18); the transaction members run inside
 *    `engine.transaction`. Seeded with real rows through typed writers: facts, takes and their pages, decide, review and trust
 *    proposals, the review queue, open loops, write gate holds and receipts, segmented pages, body stagings with their texts and
 *    manifest rows, and saved versions of segmented pages. Seeded with a local raw fixture, because no typed writer exists: upload
 *    parts (page_body_staging_parts), read-view digests (page_view_digests), and take proposals (take_proposals); core edit
 *    notices go in and out through the typed insertCoreEditNotice and readOldestPendingCoreEditNotice; the same cases read the
 *    tombstone tables (fact_purges, take_purges) and those three back with a raw SELECT, because no typed reader exists. The Rust arm refuses those raw statements as typed refusals and stops there. The
 *    last case compares the statements on empty tables, so it pins their shape and the answer for no rows. Generated values (page
 *    ids, staging ids, version ids, revisions) are compared by relation or label, never by value, and a hash that only one
 *    engine's collation would order differently is sorted in the test.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { hexOf, pageMeta, publishSegmentedPage, segmentText, sha256, stageGeneration, stagingInput } from '../helpers/page-body-fixtures.ts';

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
      const first = await tx.insertTakePurge({ sourceId: SRC, subject: '*', claimHash: 'hash-a', requestId: REQ });
      const again = await tx.insertTakePurge({ sourceId: SRC, subject: '*', claimHash: 'hash-a', requestId: REQ });
      return { first, again };
    });
    expect(answers).toEqual({ first: true, again: false });
    return answers;
  });

  parityTest('the take, review, proposal, loop and gate deletes remove the rows that name the purged facts and takes, and leave the rest', {
    methods: ['insertFact', 'putPage', 'addTakesBatch', 'listTakes', 'loadPurgeTarget', 'insertDecideProposal', 'insertDecideReviewProposal', 'applyDecideReviewQueue',
      'insertTrustProposal', 'upsertOpenLoop', 'upsertWriteGateHold', 'upsertWriteGateReceipt', 'countPurgeReviewRows', 'listDecideProposals',
      'listDecideReviewProposals', 'listDueDecideReviewQueue', 'listTrustProposals', 'listOpenLoops', 'listWriteGateHoldRows', 'listWriteGateReceiptsFor',
      'transaction', 'deletePurgedTakes', 'deletePurgeReviewQueue', 'deletePurgeReviewProposals', 'deletePurgeDecideProposals', 'deletePurgeTrustProposals',
      'deletePurgeOpenLoops', 'deletePurgeWriteGateHolds', 'deletePurgeWriteGateReceipts'],
  }, async (engine) => {
    const purged = await fact(engine, 'Alice likes tea', { entity_slug: 'people/a' });
    const coffee = await fact(engine, 'Alice likes coffee', { entity_slug: 'people/a' });
    const other = await fact(engine, 'Bob likes jam', { entity_slug: 'people/b' });
    const page = Number((await engine.putPage('people/a', note('A', 'a person'))).id);
    const take = (row_num: number, claim: string) => ({ page_id: page, row_num, claim, kind: 'take', holder: 'self', weight: 0.5, since_date: '2026-01-01', source: 'parity' }) as never;
    await engine.addTakesBatch([take(1, 'Alice likes tea'), take(2, 'Alice likes coffee')]);
    const takes = await engine.listTakes({ page_id: page } as never);
    const tea = takes.find(t => t.claim === 'Alice likes tea')!.id;
    const keep = takes.find(t => t.claim === 'Alice likes coffee')!.id;
    const hash = (await engine.loadPurgeTarget(purged, SRC))!.fact_hash;
    const factName = new Map([[purged, 'purged'], [coffee, 'coffee'], [other, 'other']]);
    const takeName = new Map([[tea, 'tea'], [keep, 'keep']]);
    const fname = (id: number | string) => factName.get(Number(id)) ?? `unknown:${id}`;
    const tname = (id: number | string) => takeName.get(Number(id)) ?? `unknown:${id}`;
    const refName = (ref: string) => factName.get(Number(ref)) ?? ref;

    // Decide proposals, review proposals and the review queue name facts by id (a ref is the id as text).
    const proposal = (index: number, newer: number, older: number) => ({ source_id: SRC, sweep_id: 's1', pair_index: index, new_fact_id: newer, old_fact_id: older,
      direction: 'new_supersedes_old' as const, p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a' });
    await engine.insertDecideProposal(proposal(0, purged, other));
    await engine.insertDecideProposal(proposal(1, other, purged));
    await engine.insertDecideProposal(proposal(2, coffee, other));
    const review = (a: string, b: string) => ({ kind: 'duplicate_page', source_id: SRC, sweep_id: 'r1', a_ref: a, b_ref: b, subject: '*', visibility: null,
      p_action: 0.75, threshold: 0.6, model_resolved: 'model-a', question_version: '1', receipt: null });
    await engine.insertDecideReviewProposal(review(String(purged), 'pages/x'));
    await engine.insertDecideReviewProposal(review('pages/y', String(purged)));
    await engine.insertDecideReviewProposal(review(String(coffee), 'pages/x'));
    const queue = (a: string, b: string) => engine.applyDecideReviewQueue({ op: 'enqueue', kind: 'duplicate_page', source_id: SRC, a_ref: a, b_ref: b, evidence: null });
    await queue(String(purged), 'pages/x'); await queue('pages/y', String(purged)); await queue(String(coffee), 'pages/x'); await queue('pages/z', 'pages/x');
    // Trust proposals name facts and takes as target or related row.
    await engine.insertTrustProposal({ action: 'supersede_fact', sourceId: SRC, target: { table: 'facts', id: purged }, related: { table: 'facts', id: other }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'confirm', sourceId: SRC, target: { table: 'facts', id: other }, related: { table: 'facts', id: purged }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: tea }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: keep }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'facts', id: coffee }, before: {}, proposer: 'parity' });
    // Open loops, held writes (by the fingerprint of their fact or claim text) and gate receipts.
    const at = '2026-03-01T10:00:00.000Z';
    for (const [key, id] of [['loop-purged', purged], ['loop-coffee', coffee]] as const) {
      await engine.upsertOpenLoop({ sourceId: SRC, dedupKey: key, loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com', summary: key, evidence: [],
        detector: 'manual', factId: id, lastActivityAt: at, openedAt: at });
    }
    const hold = (fingerprint: string, payload: Record<string, unknown>, kind: 'fact' | 'take' = 'fact') => engine.upsertWriteGateHold({ kind, source_id: SRC, slug: 'people/a',
      fingerprint, detector_version: 1, tier: 'agent_written', reason_families: ['prompt_injection'], reasons: ['ignore previous instructions'], detector_error: false,
      payload, write_origin: null, request_id: null });
    const heldFact = await hold('fp-fact', { fact: 'alice  LIKES tea' });
    const heldClaim = await hold('fp-claim', { claim: 'Alice likes tea' }, 'take');
    const heldOther = await hold('fp-other', { fact: 'Alice likes coffee' });
    const holdName = new Map([[heldFact, 'heldFact'], [heldClaim, 'heldClaim'], [heldOther, 'heldOther']]);
    const receipt = (table: 'facts' | 'takes' | 'write_gate_holds', id: number) => engine.upsertWriteGateReceipt({ target_table: table, target_id: String(id), source_id: SRC,
      content_hash: `h-${table}-${id}`, tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['standing_instruction'], reasons: ['r'], detector_error: false, request_id: null });
    for (const id of [purged, coffee]) await receipt('facts', id);
    for (const id of [tea, keep]) await receipt('takes', id);
    for (const id of [heldFact, heldClaim, heldOther]) await receipt('write_gate_holds', id);

    const state = async () => {
      const receiptCount = async (table: string, id: number, name: (id: number) => string) => [`${table}:${name(id)}`, (await engine.listWriteGateReceiptsFor(table, String(id), 10)).length];
      return {
        counts: { purged: await engine.countPurgeReviewRows(SRC, [String(purged)], [purged]), coffee: await engine.countPurgeReviewRows(SRC, [String(coffee)], [coffee]) },
        decide: (await engine.listDecideProposals({ status: 'all' })).map(r => [fname(r.new_fact_id), fname(r.old_fact_id)]).sort(),
        reviewProposals: (await engine.listDecideReviewProposals('all')).map(r => [refName(r.a_ref), refName(r.b_ref)]).sort(),
        queue: (await engine.listDueDecideReviewQueue('duplicate_page', SRC, 100)).map(r => [refName(r.a_ref), refName(r.b_ref)]).sort(),
        trust: (await engine.listTrustProposals({ status: 'all' })).map(r => [r.action, r.target_table, r.target_table === 'facts' ? fname(r.target_id) : tname(r.target_id),
          r.related_table, r.related_id === null ? null : fname(r.related_id)]).sort(),
        loops: (await engine.listOpenLoops({ sourceIds: [SRC] })).map(l => String(l.dedup_key)).sort(),
        holds: (await engine.listWriteGateHoldRows({ status: 'all', limit: 100 })).map(h => holdName.get(h.id) ?? `unknown:${h.id}`).sort(),
        receipts: [
          ...await Promise.all([purged, coffee].map(id => receiptCount('facts', id, fname))), ...await Promise.all([tea, keep].map(id => receiptCount('takes', id, tname))),
          ...await Promise.all([heldFact, heldClaim, heldOther].map(id => receiptCount('write_gate_holds', id, id2 => holdName.get(id2)!))),
        ],
        takes: (await engine.listTakes({ page_id: page } as never)).map(t => t.claim).sort(),
      };
    };
    const before = await state();
    const deleted = await engine.transaction(async tx => {
      const takesGone = await tx.deletePurgedTakes([tea]);
      const holds = await tx.deletePurgeWriteGateHolds(SRC, hash);
      return {
        takes: takesGone, reviewQueue: await tx.deletePurgeReviewQueue(SRC, [String(purged)]), reviewProposals: await tx.deletePurgeReviewProposals(SRC, [String(purged)]),
        decideProposals: await tx.deletePurgeDecideProposals(SRC, [purged]), trustProposals: await tx.deletePurgeTrustProposals(SRC, [purged], [tea]),
        openLoops: await tx.deletePurgeOpenLoops(SRC, [purged]), holds: holds.map(id => holdName.get(Number(id)) ?? `unknown:${id}`).sort(),
        receipts: await tx.deletePurgeWriteGateReceipts([String(purged)], [String(tea)], holds),
      };
    });
    const after = await state();
    expect(before.counts.purged).toEqual({ decide_review_queue: 2, decide_review_proposals: 2, decide_proposals: 2 });
    expect(deleted).toEqual({ takes: 1, reviewQueue: 2, reviewProposals: 2, decideProposals: 2, trustProposals: 3, openLoops: 1, holds: ['heldClaim', 'heldFact'], receipts: 4 });
    expect(after.counts.purged).toEqual({ decide_review_queue: 0, decide_review_proposals: 0, decide_proposals: 0 });
    expect(after.counts.coffee).toEqual(before.counts.coffee);
    expect(after.loops).toEqual(['loop-coffee']);
    expect(after.holds).toEqual(['heldOther']);
    expect(after.takes).toEqual(['Alice likes coffee']);
    return { before, deleted, after };
  });

  parityTest('listStagingsHoldingClaim, abortPurgedStagings and deleteUnreferencedPurgedTexts find, abort and delete the staged texts that hold a claim', {
    methods: [
      'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'setBodyStagingState',
      'flipBodyGeneration', 'readSegmentTexts', 'readManifest', 'transaction', 'listStagingsHoldingClaim', 'abortPurgedStagings', 'deleteUnreferencedPurgedTexts',
    ],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const claim = segmentText('Today Alice likes tea at noon\n');
    const shouting = segmentText('ALICE LIKES TEA, shouted\n');
    const fenced = segmentText('| a row | Alice \\| tea |\n');
    const orphanFence = segmentText('An orphan row: Alice \\| tea\n');
    const clean = segmentText('Nothing about her here\n');
    const orphanClaim = segmentText('An orphan that says alice likes tea\n');
    const orphanClean = segmentText('An orphan that says nothing\n');
    const orphanReplaced = segmentText('An orphan that was replaced\n');
    const stagedClaim = segmentText('A staged text with Alice likes tea in it\n');
    const published = await publishSegmentedPage(engine, 'notes/published', [claim, clean]);
    const shellOf = async (slug: string, sourceId = SRC) => (await engine.createSegmentedPageShell(slug, pageMeta(slug), { sourceId })).id;
    const holdsClaim = await shellOf('notes/holds-claim');
    const holdsShout = await shellOf('notes/holds-shout');
    const holdsNothing = await shellOf('notes/holds-nothing');
    const elsewhere = await shellOf('notes/elsewhere', 'other');
    const s1 = await stageGeneration(engine, { pageId: holdsClaim, slug: 'notes/holds-claim', genFrom: 1, texts: [claim, clean] });
    const s2 = await stageGeneration(engine, { pageId: holdsShout, slug: 'notes/holds-shout', genFrom: 1, texts: [shouting] });
    const s3 = await stageGeneration(engine, { pageId: holdsNothing, slug: 'notes/holds-nothing', genFrom: 1, texts: [clean] });
    const s4 = await stageGeneration(engine, { pageId: elsewhere, slug: 'notes/elsewhere', genFrom: 1, texts: [claim], sourceId: 'other' });
    // A staging that holds a text only through its record of texts, with no manifest row, open and then committed.
    const recorded = async (id: string, state: 'open' | 'committed', text = stagedClaim) => {
      await engine.transaction(async tx => {
        await tx.openBodyStaging(stagingInput({ id, slug: 'notes/recorded' }));
        await tx.stageSegmentTexts(SRC, [text], { stagingId: id });
        if (state === 'committed') await tx.setBodyStagingState(id, 'committed');
      });
      return id;
    };
    const s5 = await recorded('c0000000-0000-4000-8000-0000000000c5', 'open');
    const s6 = await recorded('c0000000-0000-4000-8000-0000000000c6', 'committed');
    const s7 = await recorded('c0000000-0000-4000-8000-0000000000c7', 'open', fenced);
    await engine.setBodyStagingState(s3.stagingId, 'sealed');
    await engine.stageSegmentTexts(SRC, [orphanClaim, orphanClean, orphanReplaced, orphanFence]);
    await engine.stageSegmentTexts('other', [orphanClaim]);

    const names = new Map<string, string>([
      [published.stagingId, 'published'], [s1.stagingId, 'holdsClaim'], [s2.stagingId, 'holdsShout'], [s3.stagingId, 'holdsNothing'],
      [s4.stagingId, 'elsewhere'], [s7, 'recordedFence'], [s5, 'recorded'], [s6, 'recordedCommitted'], [NO_STAGING, 'none'],
    ]);
    const nameOf = (id: string) => names.get(id) ?? `unknown:${id}`;
    const pages = new Map<number, string>([[published.pageId, 'published'], [holdsClaim, 'holdsClaim'], [holdsShout, 'holdsShout'], [holdsNothing, 'holdsNothing'], [elsewhere, 'elsewhere']]);
    const texts = new Map<string, string>(([[claim, 'claim'], [shouting, 'shouting'], [clean, 'clean'], [orphanClaim, 'orphanClaim'], [orphanClean, 'orphanClean'],
      [orphanReplaced, 'orphanReplaced'], [stagedClaim, 'stagedClaim'], [fenced, 'fenced'], [orphanFence, 'orphanFence']] as const).map(([t, n]) => [hexOf(t.sha256), n]));
    const stored = async (sourceId: string) => {
      const found = await engine.readSegmentTexts(sourceId, [...texts.keys()].map(h => Uint8Array.from(Buffer.from(h, 'hex'))));
      return [...found.keys()].map(h => texts.get(h) ?? `unknown:${h}`).sort();
    };
    const holding = async (claimText: string) => (await engine.listStagingsHoldingClaim(SRC, claimText)).map(nameOf).sort();
    const manifestRows = async (pageId: number, stagingId: string) => (await engine.readManifest(pageId, { stagingId })).length;

    const out = {
      holdingBefore: await holding('Alice likes tea'),
      holdingLowered: await holding('alice likes tea'),
      holdingFence: await holding('Alice | tea'),
      holdingShouted: await holding('Alice likes tea, shouted'),
      holdingNone: await holding('a claim nobody staged'),
      holdingOther: (await engine.listStagingsHoldingClaim('other', 'Alice likes tea')).map(nameOf),
      textsBefore: await stored(SRC),
      textsBeforeOther: await stored('other'),
      ...(await engine.transaction(async tx => ({
        aborted: (await tx.abortPurgedStagings([s1.stagingId, s2.stagingId, s3.stagingId, s7, s5, s6, published.stagingId, NO_STAGING])).map(id => pages.get(id) ?? `unknown:${id}`).sort(),
        abortedAgain: (await tx.abortPurgedStagings([s1.stagingId])).map(id => pages.get(id) ?? `unknown:${id}`),
        abortedNothing: await tx.abortPurgedStagings([]),
        deletedTexts: await tx.deleteUnreferencedPurgedTexts(SRC, [orphanReplaced.sha256], 'Alice likes tea'),
        deletedAgain: await tx.deleteUnreferencedPurgedTexts(SRC, [orphanReplaced.sha256], 'Alice likes tea'),
        deletedNothing: await tx.deleteUnreferencedPurgedTexts(SRC, [], 'a claim nobody staged'),
        deletedFence: await tx.deleteUnreferencedPurgedTexts(SRC, [], 'Alice | tea'),
      }))),
      holdingAfter: await holding('Alice likes tea'),
      holdingFenceAfter: await holding('Alice | tea'),
      holdingAfterElsewhere: (await engine.listStagingsHoldingClaim('other', 'Alice likes tea')).map(nameOf),
      textsAfter: await stored(SRC),
      textsAfterOther: await stored('other'),
      manifestKept: await manifestRows(holdsClaim, s1.stagingId),
    };
    expect(out).toEqual({
      holdingBefore: ['holdsClaim', 'holdsShout', 'recorded'], holdingLowered: ['holdsClaim', 'holdsShout', 'recorded'], holdingFence: ['recordedFence'],
      holdingShouted: ['holdsShout'], holdingNone: [], holdingOther: ['elsewhere'],
      textsBefore: ['claim', 'clean', 'fenced', 'orphanClaim', 'orphanClean', 'orphanFence', 'orphanReplaced', 'shouting', 'stagedClaim'], textsBeforeOther: ['claim', 'orphanClaim'],
      aborted: ['holdsClaim', 'holdsNothing', 'holdsShout'], abortedAgain: ['holdsClaim'], abortedNothing: [],
      deletedTexts: 3, deletedAgain: 0, deletedNothing: 0, deletedFence: 2,
      holdingAfter: [], holdingFenceAfter: [], holdingAfterElsewhere: ['elsewhere'],
      textsAfter: ['claim', 'clean', 'orphanClean', 'shouting'], textsAfterOther: ['claim', 'orphanClaim'], manifestKept: 2,
    });
    return out;
  });

  parityTest('listStagingPartEdges, deletePurgedStagingParts and deletePageViewDigests read and delete the upload parts and read-view digests, which have no typed writer', {
    methods: ['createSegmentedPageShell', 'openBodyStaging', 'transaction', 'listStagingPartEdges', 'listStagingsHoldingClaim', 'deletePurgedStagingParts', 'deletePageViewDigests', 'executeRaw'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const staging = async (id: string, state: 'open' | 'sealed' | 'committed', sourceId = SRC) => {
      await engine.transaction(async tx => {
        await tx.openBodyStaging(stagingInput({ id, slug: `notes/${id.slice(-2)}`, sourceId }));
        if (state !== 'open') await tx.setBodyStagingState(id, state);
      });
      return id;
    };
    const SPLIT = 'd0000000-0000-4000-8000-0000000000d1';
    const WHOLE = 'd0000000-0000-4000-8000-0000000000d2';
    const SEALED = 'd0000000-0000-4000-8000-0000000000d3';
    const DONE = 'd0000000-0000-4000-8000-0000000000d4';
    const ELSEWHERE = 'd0000000-0000-4000-8000-0000000000d5';
    const NOTHING = 'd0000000-0000-4000-8000-0000000000d6';
    await staging(SPLIT, 'open'); await staging(WHOLE, 'open'); await staging(SEALED, 'sealed'); await staging(DONE, 'committed');
    await staging(ELSEWHERE, 'open', 'other'); await staging(NOTHING, 'open');
    // The parts of an upload are stored by the upload code with a raw statement; no typed member writes them.
    const part = async (stagingId: string, partNo: number, byteStart: number, text: string) => {
      const bytes = Buffer.from(text);
      await engine.executeRaw(`INSERT INTO page_body_staging_parts (staging_id, part_no, byte_start, byte_len, sha256, body) VALUES ($1::uuid, $2, $3::bigint, $4, decode($5, 'hex'), $6::bytea)`,
        [stagingId, partNo, byteStart, bytes.byteLength, hexOf(sha256(bytes)), bytes]);
    };
    await part(SPLIT, 0, 0, 'xx Alice li'); await part(SPLIT, 1, 11, 'kes tea yy');
    await part(WHOLE, 0, 0, 'plain Alice likes tea whole'); await part(WHOLE, 1, 27, 'ok');
    await part(SEALED, 0, 0, 'sealed and clean');
    await part(DONE, 0, 0, 'committed with Alice likes tea');
    await part(ELSEWHERE, 0, 0, 'other source Alice likes tea');
    await part(NOTHING, 0, 0, 'abc');
    const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
    const edges = async (keep: number, after: { id: string; part: number }) =>
      (await engine.listStagingPartEdges(SRC, keep, after)).map(e => ({ id: e.id.slice(-2), part: Number(e.part_no), head: text(e.head), tail: text(e.tail) }));
    const START = { id: '00000000-0000-0000-0000-000000000000', part: -1 };
    const holding = async () => (await engine.listStagingsHoldingClaim(SRC, 'Alice likes tea')).map(id => id.slice(-2));

    // Read-view digests are a cache written with a raw statement by the page window.
    const pageA = (await engine.createSegmentedPageShell('notes/digest-a', pageMeta('A'), { sourceId: SRC })).id;
    const pageB = (await engine.createSegmentedPageShell('notes/digest-b', pageMeta('B'), { sourceId: SRC })).id;
    const digest = (pageId: number, revision: string, view: string) => engine.executeRaw(
      `INSERT INTO page_view_digests (page_id, revision, view, audience, total_bytes, total_lines, sha256) VALUES ($1, $2, $3, 'trusted', 10, 2, 'abc')`, [pageId, revision, view]);
    await digest(pageA, 'r1', 'read'); await digest(pageA, 'r1', 'markdown'); await digest(pageB, 'r1', 'read');
    const digestCount = async (pageId: number) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_view_digests WHERE page_id = $1', [pageId]))[0]!.n);

    const out = {
      all: await edges(4, START),
      wide: await edges(100, START),
      afterSplitFirst: await edges(4, { id: SPLIT, part: 0 }),
      afterLast: await edges(4, { id: ELSEWHERE, part: 5 }),
      otherSource: (await engine.listStagingPartEdges('other', 4, START)).map(e => ({ id: e.id.slice(-2), head: text(e.head) })),
      holdingBefore: await holding(),
      digestsBefore: [await digestCount(pageA), await digestCount(pageB)],
      ...(await engine.transaction(async tx => ({
        deleted: await tx.deletePurgedStagingParts([SPLIT, DONE, NO_STAGING]),
        deletedAgain: await tx.deletePurgedStagingParts([SPLIT, DONE]),
        deletedNothing: await tx.deletePurgedStagingParts([]),
        digestDelete: await tx.deletePageViewDigests([pageA, 999999]),
        digestDeleteNothing: await tx.deletePageViewDigests([]),
      }))),
      afterDelete: await edges(4, START),
      holdingAfter: await holding(),
      digestsAfter: [await digestCount(pageA), await digestCount(pageB)],
    };
    const e = (id: string, part: number, head: string, tail: string) => ({ id, part, head, tail });
    const live = [e('d1', 0, 'xx A', 'e li'), e('d1', 1, 'kes ', 'a yy'), e('d2', 0, 'plai', 'hole'), e('d2', 1, 'ok', 'ok'), e('d3', 0, 'seal', 'lean'), e('d6', 0, 'abc', 'abc')];
    expect(out).toEqual({
      all: live,
      wide: [e('d1', 0, 'xx Alice li', 'xx Alice li'), e('d1', 1, 'kes tea yy', 'kes tea yy'), e('d2', 0, 'plain Alice likes tea whole', 'plain Alice likes tea whole'),
        e('d2', 1, 'ok', 'ok'), e('d3', 0, 'sealed and clean', 'sealed and clean'), e('d6', 0, 'abc', 'abc')],
      afterSplitFirst: live.slice(1), afterLast: [e('d6', 0, 'abc', 'abc')], otherSource: [{ id: 'd5', head: 'othe' }],
      holdingBefore: ['d2'], digestsBefore: [2, 1],
      deleted: 3, deletedAgain: 0, deletedNothing: 0, digestDelete: undefined, digestDeleteNothing: undefined,
      afterDelete: live.slice(2), holdingAfter: ['d2'], digestsAfter: [0, 1],
    });
    return out;
  });

  parityTest('deletePurgeTakeProposals and blankPurgeCoreEditNotices delete and blank the rows that quote a purged claim; the take proposals have no typed writer', {
    methods: ['insertFact', 'loadPurgeTarget', 'transaction', 'deletePurgeTakeProposals', 'blankPurgeCoreEditNotices', 'executeRaw', 'insertCoreEditNotice', 'readOldestPendingCoreEditNotice'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const target = await fact(engine, 'Alice likes tea', { entity_slug: 'people/a' });
    const hash = (await engine.loadPurgeTarget(target, SRC))!.fact_hash;
    // Take proposals are written by the take proposer with a raw statement; no typed member writes them.
    const propose = (sourceId: string, slug: string, claim: string, status = 'pending') => engine.executeRaw(
      `INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, model_id, status)
       VALUES ($1, $2, 'h', 'v1', 'run', $3, 'take', 'self', 0.5, 'm', $4)`, [sourceId, slug, claim, status]);
    await propose(SRC, 'people/a', 'Alice likes tea'); await propose(SRC, 'people/a', 'alice  LIKES tea', 'rejected'); await propose(SRC, 'people/b', 'Alice likes tea', 'accepted');
    await propose(SRC, 'people/a', 'Alice likes coffee'); await propose('other', 'people/a', 'Alice likes tea');
    const proposals = async () => (await engine.executeRaw<{ source_id: string; page_slug: string; claim_text: string }>(
      'SELECT source_id, page_slug, claim_text FROM take_proposals ORDER BY source_id, page_slug, claim_text')).map(r => `${r.source_id}:${r.page_slug}:${r.claim_text}`).sort();
    // Core edit notices are written by the core page guard through the typed insert.
    const notice = (sourceId: string, slug: string, baseText: string | null) => engine.insertCoreEditNotice(
      { sourceId, slug, pageId: null, revision: null, baseRevision: null, baseText, actor: 'remote:agent' });
    await notice(SRC, 'core/a', 'Intro. Today Alice Likes Tea at noon.'); await notice(SRC, 'core/b', 'Nothing here'); await notice(SRC, 'core/c', null);
    await notice(SRC, 'core/d', 'alice likes tea'); await notice('other', 'core/a', 'Intro. Today Alice likes tea at noon.');
    const notices = async () => Promise.all([[SRC, 'core/a'], [SRC, 'core/b'], [SRC, 'core/c'], [SRC, 'core/d'], ['other', 'core/a']].map(async ([sourceId, slug]) =>
      `${sourceId}:${slug}:${(await engine.readOldestPendingCoreEditNotice(sourceId!, slug!))!.base_text === null ? 'blank' : 'kept'}`)).then(rows => rows.sort());

    const out = {
      proposalsBefore: await proposals(), noticesBefore: await notices(),
      ...(await engine.transaction(async tx => ({
        deletedProposals: await tx.deletePurgeTakeProposals(SRC, hash),
        deletedProposalsAgain: await tx.deletePurgeTakeProposals(SRC, hash),
        deletedProposalsOtherHash: await tx.deletePurgeTakeProposals(SRC, 'not-a-hash'),
        blanked: await tx.blankPurgeCoreEditNotices(SRC, 'alice likes tea'),
        blankedAgain: await tx.blankPurgeCoreEditNotices(SRC, 'alice likes tea'),
        blankedNothing: await tx.blankPurgeCoreEditNotices(SRC, 'a claim nobody quoted'),
      }))),
      proposalsAfter: await proposals(), noticesAfter: await notices(),
    };
    expect(out).toEqual({
      proposalsBefore: ['default:people/a:Alice likes coffee', 'default:people/a:Alice likes tea', 'default:people/a:alice  LIKES tea', 'default:people/b:Alice likes tea', 'other:people/a:Alice likes tea'],
      noticesBefore: ['default:core/a:kept', 'default:core/b:kept', 'default:core/c:blank', 'default:core/d:kept', 'other:core/a:kept'],
      deletedProposals: 3, deletedProposalsAgain: 0, deletedProposalsOtherHash: 0, blanked: 2, blankedAgain: 0, blankedNothing: 0,
      proposalsAfter: ['default:people/a:Alice likes coffee', 'other:people/a:Alice likes tea'],
      noticesAfter: ['default:core/a:blank', 'default:core/b:kept', 'default:core/c:blank', 'default:core/d:blank', 'other:core/a:kept'],
    });
    return out;
  });

  parityTest('listSegmentedVersionsForPurge finds the saved versions of segmented pages that are named or hold a claim, in id order after a cursor', {
    methods: ['putPage', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'transaction', 'createVersion', 'listSegmentedVersionsForPurge'],
  }, async (engine) => {
    const claim = segmentText('Today Alice likes tea at noon\n');
    const clean = segmentText('Nothing about her here\n');
    const holds = await publishSegmentedPage(engine, 'notes/holds', [claim]);
    const named = await publishSegmentedPage(engine, 'notes/named', [clean]);
    const innocent = await publishSegmentedPage(engine, 'notes/innocent', [clean]);
    await engine.putPage('notes/inline', note('Inline', 'Alice likes tea, inline'));
    const v1 = (await engine.createVersion('notes/holds')).id;
    const v2 = (await engine.createVersion('notes/named')).id;
    const v3 = (await engine.createVersion('notes/innocent')).id;
    const v4 = (await engine.createVersion('notes/inline')).id;
    const v5 = (await engine.createVersion('notes/holds')).id;
    const labels = new Map<number, string>([[Number(v1), 'holds-1'], [Number(v2), 'named'], [Number(v3), 'innocent'], [Number(v4), 'inline'], [Number(v5), 'holds-2']]);
    const pages = new Map<number, string>([[holds.pageId, 'holds'], [named.pageId, 'named'], [innocent.pageId, 'innocent']]);
    const found = async (needle: string, pageIds: number[], after = 0) => (await engine.listSegmentedVersionsForPurge(SRC, needle, pageIds, after)).map(v => ({
      id: labels.get(Number(v.id)) ?? `unknown:${v.id}`, page: pages.get(Number(v.page_id)) ?? `unknown:${v.page_id}`, generation: Number(v.generation), slug: v.slug,
      title: v.title, type: v.type, frontmatter: v.frontmatter, tags: v.tags,
    }));
    const out = {
      byClaim: await found('alice likes tea', []),
      byName: await found('a claim nobody stored', [named.pageId]),
      both: await found('alice likes tea', [named.pageId]),
      afterFirst: await found('alice likes tea', [named.pageId], Number(v1)),
      afterAll: await found('alice likes tea', [named.pageId], Number(v5)),
      nothing: await found('a claim nobody stored', []),
      otherSource: (await engine.listSegmentedVersionsForPurge('other', 'alice likes tea', [named.pageId], 0)).length,
    };
    const seen = (id: string, page: string) => ({ id, page, generation: 1, slug: `notes/${page}`, title: 'Segmented probe', type: 'note', frontmatter: { status: 'probe', nested: { a: 1 } }, tags: [] });
    const holds1 = seen('holds-1', 'holds'), holds2 = seen('holds-2', 'holds'), namedSeen = seen('named', 'named');
    expect(out).toEqual({
      // The inline page's version and the innocent page's version are never listed; a page holds the claim by its live generation, even when not named.
      byClaim: [holds1, holds2], byName: [namedSeen], both: [holds1, namedSeen, holds2], afterFirst: [namedSeen, holds2], afterAll: [], nothing: [], otherSource: 0,
    });
    return out;
  });

  parityTest('insertHoldingPagePurges and insertTakePurge store tombstones, one per holding page and claim, none twice, for the facts that hang off a holding page', {
    methods: ['putPage', 'insertFacts', 'insertFact', 'loadPurgeTarget', 'transaction', 'insertHoldingPagePurges', 'insertTakePurge', 'listPurgeTombstoneMatches', 'executeRaw'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage(HOLDING, note('Unattributed', 'a holding page'));
    await engine.putPage('notes/ordinary', note('Ordinary', 'an ordinary page'));
    const target = await fact(engine, 'Alice likes tea', { entity_slug: 'people/alice' });
    const hash = (await engine.loadPurgeTarget(target, SRC))!.fact_hash;
    const alice = await fenced(engine, 'Alice likes tea', { source_markdown_slug: HOLDING, entity_slug: 'people/alice', visibility: 'private' });
    const bob = await fenced(engine, 'Bob likes tea', { source_markdown_slug: HOLDING, entity_slug: 'people/bob', visibility: 'private' });
    const aboutHolding = await fenced(engine, 'The holding page itself', { source_markdown_slug: HOLDING, entity_slug: HOLDING, visibility: 'private' });
    const ordinary = await fenced(engine, 'Ordinary fact', { source_markdown_slug: 'notes/ordinary', entity_slug: 'people/alice', visibility: 'private' });
    // The tombstones have no typed reader, so a local raw read lists them.
    const tombstones = async () => ({
      facts: (await engine.executeRaw<{ subject: string; visibility: string; fact_hash: string; request_id: string; actor: string; reason: string | null }>(
        'SELECT subject, visibility, fact_hash, request_id::text AS request_id, actor, reason FROM fact_purges WHERE source_id = $1 ORDER BY visibility, subject, fact_hash', [SRC]))
        .map(r => ({ ...r, fact_hash: r.fact_hash === hash ? 'target' : r.fact_hash }))
        .sort((x, y) => `${x.visibility}/${x.subject}/${x.fact_hash}`.localeCompare(`${y.visibility}/${y.subject}/${y.fact_hash}`)),
      takes: (await engine.executeRaw<{ subject: string; claim_hash: string; request_id: string }>(
        'SELECT subject, claim_hash, request_id::text AS request_id FROM take_purges WHERE source_id = $1 ORDER BY subject, claim_hash', [SRC]))
        .map(r => ({ ...r, claim_hash: r.claim_hash === hash ? 'target' : r.claim_hash }))
        .sort((x, y) => `${x.subject}/${x.claim_hash}`.localeCompare(`${y.subject}/${y.claim_hash}`)),
      elsewhere: Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM fact_purges WHERE source_id = 'other'`))[0]!.n),
    });
    const before = await tombstones();
    const stored = await engine.transaction(async tx => {
      await tx.insertHoldingPagePurges(SRC, 'private', hash, REQ, 'local_cli:me', 'because', [alice, bob, aboutHolding, ordinary]);
      await tx.insertHoldingPagePurges(SRC, 'private', hash, REQ2, 'local_cli:you', null, [alice]);
      await tx.insertHoldingPagePurges(SRC, 'world', hash, REQ, 'local_cli:me', null, [alice]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-b', REQ, 'local_cli:me', 'again', [bob, bob]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-c', REQ, 'local_cli:me', 'none', [ordinary]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-e', REQ, 'local_cli:me', 'subject', [aboutHolding]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-d', REQ, 'local_cli:me', 'none', []);
      await tx.insertTakePurge({ sourceId: SRC, subject: '*', claimHash: hash, requestId: REQ });
      await tx.insertTakePurge({ sourceId: SRC, subject: '*', claimHash: hash, requestId: REQ2 });
      await tx.insertTakePurge({ sourceId: SRC, subject: 'people/alice', claimHash: hash, requestId: REQ });
      await tx.insertTakePurge({ sourceId: SRC, subject: '*', claimHash: 'hash-b', requestId: REQ });
      return 'stored';
    });
    const matches = async (fact: string, visibility: string, entity: string | null) =>
      (await engine.listPurgeTombstoneMatches(SRC, { facts: [fact], visibilities: [visibility], entitySlugs: [entity], sources: ['fence'] })).map(r => Number(r.ord));
    const out = {
      before, stored, after: await tombstones(),
      matchHolding: await matches('Alice likes tea', 'private', HOLDING), matchWorld: await matches('Alice likes tea', 'world', HOLDING),
      matchPerson: await matches('Alice likes tea', 'private', 'people/alice'), matchOther: await matches('Bob likes tea', 'private', HOLDING),
    };
    const tomb = (visibility: string, fact_hash: string, request_id: string, actor: string, reason: string | null) => ({ subject: HOLDING, visibility, fact_hash, request_id, actor, reason });
    expect(out).toEqual({
      before: { facts: [], takes: [], elsewhere: 0 }, stored: 'stored',
      after: {
        // The first write of a holding page's claim stays: the second call under the same key, with another request and actor, changed nothing.
        // A fact of an ordinary page (hash-c) and an empty list (hash-d) store nothing.
        facts: [tomb('private', 'hash-b', REQ, 'local_cli:me', 'again'), tomb('private', 'hash-e', REQ, 'local_cli:me', 'subject'),
          tomb('private', 'target', REQ, 'local_cli:me', 'because'), tomb('world', 'target', REQ, 'local_cli:me', null)],
        takes: [{ subject: '*', claim_hash: 'hash-b', request_id: REQ }, { subject: '*', claim_hash: 'target', request_id: REQ }, { subject: 'people/alice', claim_hash: 'target', request_id: REQ }],
        elsewhere: 0,
      },
      matchHolding: [1], matchWorld: [1], matchPerson: [], matchOther: [],
    });
    return out;
  });

  parityTest('the take, review, proposal, loop and gate deletes remove the rows that name the purged facts and takes, and leave the rest', {
    methods: ['insertFact', 'putPage', 'addTakesBatch', 'listTakes', 'loadPurgeTarget', 'insertDecideProposal', 'insertDecideReviewProposal', 'applyDecideReviewQueue',
      'insertTrustProposal', 'upsertOpenLoop', 'upsertWriteGateHold', 'upsertWriteGateReceipt', 'countPurgeReviewRows', 'listDecideProposals',
      'listDecideReviewProposals', 'listDueDecideReviewQueue', 'listTrustProposals', 'listOpenLoops', 'listWriteGateHoldRows', 'listWriteGateReceiptsFor',
      'transaction', 'deletePurgedTakes', 'deletePurgeReviewQueue', 'deletePurgeReviewProposals', 'deletePurgeDecideProposals', 'deletePurgeTrustProposals',
      'deletePurgeOpenLoops', 'deletePurgeWriteGateHolds', 'deletePurgeWriteGateReceipts'],
  }, async (engine) => {
    const purged = await fact(engine, 'Alice likes tea', { entity_slug: 'people/a' });
    const coffee = await fact(engine, 'Alice likes coffee', { entity_slug: 'people/a' });
    const other = await fact(engine, 'Bob likes jam', { entity_slug: 'people/b' });
    const page = Number((await engine.putPage('people/a', note('A', 'a person'))).id);
    const take = (row_num: number, claim: string) => ({ page_id: page, row_num, claim, kind: 'take', holder: 'self', weight: 0.5, since_date: '2026-01-01', source: 'parity' }) as never;
    await engine.addTakesBatch([take(1, 'Alice likes tea'), take(2, 'Alice likes coffee')]);
    const takes = await engine.listTakes({ page_id: page } as never);
    const tea = takes.find(t => t.claim === 'Alice likes tea')!.id;
    const keep = takes.find(t => t.claim === 'Alice likes coffee')!.id;
    const hash = (await engine.loadPurgeTarget(purged, SRC))!.fact_hash;
    const factName = new Map([[purged, 'purged'], [coffee, 'coffee'], [other, 'other']]);
    const takeName = new Map([[tea, 'tea'], [keep, 'keep']]);
    const fname = (id: number | string) => factName.get(Number(id)) ?? `unknown:${id}`;
    const tname = (id: number | string) => takeName.get(Number(id)) ?? `unknown:${id}`;
    const refName = (ref: string) => factName.get(Number(ref)) ?? ref;

    // Decide proposals, review proposals and the review queue name facts by id (a ref is the id as text).
    const proposal = (index: number, newer: number, older: number) => ({ source_id: SRC, sweep_id: 's1', pair_index: index, new_fact_id: newer, old_fact_id: older,
      direction: 'new_supersedes_old' as const, p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a' });
    await engine.insertDecideProposal(proposal(0, purged, other));
    await engine.insertDecideProposal(proposal(1, other, purged));
    await engine.insertDecideProposal(proposal(2, coffee, other));
    const review = (a: string, b: string) => ({ kind: 'duplicate_page', source_id: SRC, sweep_id: 'r1', a_ref: a, b_ref: b, subject: '*', visibility: null,
      p_action: 0.75, threshold: 0.6, model_resolved: 'model-a', question_version: '1', receipt: null });
    await engine.insertDecideReviewProposal(review(String(purged), 'pages/x'));
    await engine.insertDecideReviewProposal(review('pages/y', String(purged)));
    await engine.insertDecideReviewProposal(review(String(coffee), 'pages/x'));
    const queue = (a: string, b: string) => engine.applyDecideReviewQueue({ op: 'enqueue', kind: 'duplicate_page', source_id: SRC, a_ref: a, b_ref: b, evidence: null });
    await queue(String(purged), 'pages/x'); await queue('pages/y', String(purged)); await queue(String(coffee), 'pages/x'); await queue('pages/z', 'pages/x');
    // Trust proposals name facts and takes as target or related row.
    await engine.insertTrustProposal({ action: 'supersede_fact', sourceId: SRC, target: { table: 'facts', id: purged }, related: { table: 'facts', id: other }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'confirm', sourceId: SRC, target: { table: 'facts', id: other }, related: { table: 'facts', id: purged }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: tea }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'takes', id: keep }, before: {}, proposer: 'parity' });
    await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'facts', id: coffee }, before: {}, proposer: 'parity' });
    // Open loops, held writes (by the fingerprint of their fact or claim text) and gate receipts.
    const at = '2026-03-01T10:00:00.000Z';
    for (const [key, id] of [['loop-purged', purged], ['loop-coffee', coffee]] as const) {
      await engine.upsertOpenLoop({ sourceId: SRC, dedupKey: key, loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com', summary: key, evidence: [],
        detector: 'manual', factId: id, lastActivityAt: at, openedAt: at });
    }
    const hold = (fingerprint: string, payload: Record<string, unknown>, kind: 'fact' | 'take' = 'fact') => engine.upsertWriteGateHold({ kind, source_id: SRC, slug: 'people/a',
      fingerprint, detector_version: 1, tier: 'agent_written', reason_families: ['prompt_injection'], reasons: ['ignore previous instructions'], detector_error: false,
      payload, write_origin: null, request_id: null });
    const heldFact = await hold('fp-fact', { fact: 'alice  LIKES tea' });
    const heldClaim = await hold('fp-claim', { claim: 'Alice likes tea' }, 'take');
    const heldOther = await hold('fp-other', { fact: 'Alice likes coffee' });
    const holdName = new Map([[heldFact, 'heldFact'], [heldClaim, 'heldClaim'], [heldOther, 'heldOther']]);
    const receipt = (table: 'facts' | 'takes' | 'write_gate_holds', id: number) => engine.upsertWriteGateReceipt({ target_table: table, target_id: String(id), source_id: SRC,
      content_hash: `h-${table}-${id}`, tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['standing_instruction'], reasons: ['r'], detector_error: false, request_id: null });
    for (const id of [purged, coffee]) await receipt('facts', id);
    for (const id of [tea, keep]) await receipt('takes', id);
    for (const id of [heldFact, heldClaim, heldOther]) await receipt('write_gate_holds', id);

    const state = async () => {
      const receiptCount = async (table: string, id: number, name: (id: number) => string) => [`${table}:${name(id)}`, (await engine.listWriteGateReceiptsFor(table, String(id), 10)).length];
      return {
        counts: { purged: await engine.countPurgeReviewRows(SRC, [String(purged)], [purged]), coffee: await engine.countPurgeReviewRows(SRC, [String(coffee)], [coffee]) },
        decide: (await engine.listDecideProposals({ status: 'all' })).map(r => [fname(r.new_fact_id), fname(r.old_fact_id)]).sort(),
        reviewProposals: (await engine.listDecideReviewProposals('all')).map(r => [refName(r.a_ref), refName(r.b_ref)]).sort(),
        queue: (await engine.listDueDecideReviewQueue('duplicate_page', SRC, 100)).map(r => [refName(r.a_ref), refName(r.b_ref)]).sort(),
        trust: (await engine.listTrustProposals({ status: 'all' })).map(r => [r.action, r.target_table, r.target_table === 'facts' ? fname(r.target_id) : tname(r.target_id),
          r.related_table, r.related_id === null ? null : fname(r.related_id)]).sort(),
        loops: (await engine.listOpenLoops({ sourceIds: [SRC] })).map(l => String(l.dedup_key)).sort(),
        holds: (await engine.listWriteGateHoldRows({ status: 'all', limit: 100 })).map(h => holdName.get(h.id) ?? `unknown:${h.id}`).sort(),
        receipts: [
          ...await Promise.all([purged, coffee].map(id => receiptCount('facts', id, fname))), ...await Promise.all([tea, keep].map(id => receiptCount('takes', id, tname))),
          ...await Promise.all([heldFact, heldClaim, heldOther].map(id => receiptCount('write_gate_holds', id, id2 => holdName.get(id2)!))),
        ],
        takes: (await engine.listTakes({ page_id: page } as never)).map(t => t.claim).sort(),
      };
    };
    const before = await state();
    const deleted = await engine.transaction(async tx => {
      const takesGone = await tx.deletePurgedTakes([tea]);
      const holds = await tx.deletePurgeWriteGateHolds(SRC, hash);
      return {
        takes: takesGone, reviewQueue: await tx.deletePurgeReviewQueue(SRC, [String(purged)]), reviewProposals: await tx.deletePurgeReviewProposals(SRC, [String(purged)]),
        decideProposals: await tx.deletePurgeDecideProposals(SRC, [purged]), trustProposals: await tx.deletePurgeTrustProposals(SRC, [purged], [tea]),
        openLoops: await tx.deletePurgeOpenLoops(SRC, [purged]), holds: holds.map(id => holdName.get(Number(id)) ?? `unknown:${id}`).sort(),
        receipts: await tx.deletePurgeWriteGateReceipts([String(purged)], [String(tea)], holds),
      };
    });
    const after = await state();
    expect(before.counts.purged).toEqual({ decide_review_queue: 2, decide_review_proposals: 2, decide_proposals: 2 });
    expect(deleted).toEqual({ takes: 1, reviewQueue: 2, reviewProposals: 2, decideProposals: 2, trustProposals: 3, openLoops: 1, holds: ['heldClaim', 'heldFact'], receipts: 4 });
    expect(after.counts.purged).toEqual({ decide_review_queue: 0, decide_review_proposals: 0, decide_proposals: 0 });
    expect(after.counts.coffee).toEqual(before.counts.coffee);
    expect(after.loops).toEqual(['loop-coffee']);
    expect(after.holds).toEqual(['heldOther']);
    expect(after.takes).toEqual(['Alice likes coffee']);
    return { before, deleted, after };
  });

  parityTest('listStagingsHoldingClaim, abortPurgedStagings and deleteUnreferencedPurgedTexts find, abort and delete the staged texts that hold a claim', {
    methods: [
      'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'setBodyStagingState',
      'flipBodyGeneration', 'readSegmentTexts', 'readManifest', 'transaction', 'listStagingsHoldingClaim', 'abortPurgedStagings', 'deleteUnreferencedPurgedTexts',
    ],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const claim = segmentText('Today Alice likes tea at noon\n');
    const shouting = segmentText('ALICE LIKES TEA, shouted\n');
    const fenced = segmentText('| a row | Alice \\| tea |\n');
    const orphanFence = segmentText('An orphan row: Alice \\| tea\n');
    const clean = segmentText('Nothing about her here\n');
    const orphanClaim = segmentText('An orphan that says alice likes tea\n');
    const orphanClean = segmentText('An orphan that says nothing\n');
    const orphanReplaced = segmentText('An orphan that was replaced\n');
    const stagedClaim = segmentText('A staged text with Alice likes tea in it\n');
    const published = await publishSegmentedPage(engine, 'notes/published', [claim, clean]);
    const shellOf = async (slug: string, sourceId = SRC) => (await engine.createSegmentedPageShell(slug, pageMeta(slug), { sourceId })).id;
    const holdsClaim = await shellOf('notes/holds-claim');
    const holdsShout = await shellOf('notes/holds-shout');
    const holdsNothing = await shellOf('notes/holds-nothing');
    const elsewhere = await shellOf('notes/elsewhere', 'other');
    const s1 = await stageGeneration(engine, { pageId: holdsClaim, slug: 'notes/holds-claim', genFrom: 1, texts: [claim, clean] });
    const s2 = await stageGeneration(engine, { pageId: holdsShout, slug: 'notes/holds-shout', genFrom: 1, texts: [shouting] });
    const s3 = await stageGeneration(engine, { pageId: holdsNothing, slug: 'notes/holds-nothing', genFrom: 1, texts: [clean] });
    const s4 = await stageGeneration(engine, { pageId: elsewhere, slug: 'notes/elsewhere', genFrom: 1, texts: [claim], sourceId: 'other' });
    // A staging that holds a text only through its record of texts, with no manifest row, open and then committed.
    const recorded = async (id: string, state: 'open' | 'committed', text = stagedClaim) => {
      await engine.transaction(async tx => {
        await tx.openBodyStaging(stagingInput({ id, slug: 'notes/recorded' }));
        await tx.stageSegmentTexts(SRC, [text], { stagingId: id });
        if (state === 'committed') await tx.setBodyStagingState(id, 'committed');
      });
      return id;
    };
    const s5 = await recorded('c0000000-0000-4000-8000-0000000000c5', 'open');
    const s6 = await recorded('c0000000-0000-4000-8000-0000000000c6', 'committed');
    const s7 = await recorded('c0000000-0000-4000-8000-0000000000c7', 'open', fenced);
    await engine.setBodyStagingState(s3.stagingId, 'sealed');
    await engine.stageSegmentTexts(SRC, [orphanClaim, orphanClean, orphanReplaced, orphanFence]);
    await engine.stageSegmentTexts('other', [orphanClaim]);

    const names = new Map<string, string>([
      [published.stagingId, 'published'], [s1.stagingId, 'holdsClaim'], [s2.stagingId, 'holdsShout'], [s3.stagingId, 'holdsNothing'],
      [s4.stagingId, 'elsewhere'], [s7, 'recordedFence'], [s5, 'recorded'], [s6, 'recordedCommitted'], [NO_STAGING, 'none'],
    ]);
    const nameOf = (id: string) => names.get(id) ?? `unknown:${id}`;
    const pages = new Map<number, string>([[published.pageId, 'published'], [holdsClaim, 'holdsClaim'], [holdsShout, 'holdsShout'], [holdsNothing, 'holdsNothing'], [elsewhere, 'elsewhere']]);
    const texts = new Map<string, string>(([[claim, 'claim'], [shouting, 'shouting'], [clean, 'clean'], [orphanClaim, 'orphanClaim'], [orphanClean, 'orphanClean'],
      [orphanReplaced, 'orphanReplaced'], [stagedClaim, 'stagedClaim'], [fenced, 'fenced'], [orphanFence, 'orphanFence']] as const).map(([t, n]) => [hexOf(t.sha256), n]));
    const stored = async (sourceId: string) => {
      const found = await engine.readSegmentTexts(sourceId, [...texts.keys()].map(h => Uint8Array.from(Buffer.from(h, 'hex'))));
      return [...found.keys()].map(h => texts.get(h) ?? `unknown:${h}`).sort();
    };
    const holding = async (claimText: string) => (await engine.listStagingsHoldingClaim(SRC, claimText)).map(nameOf).sort();
    const manifestRows = async (pageId: number, stagingId: string) => (await engine.readManifest(pageId, { stagingId })).length;

    const out = {
      holdingBefore: await holding('Alice likes tea'),
      holdingLowered: await holding('alice likes tea'),
      holdingFence: await holding('Alice | tea'),
      holdingShouted: await holding('Alice likes tea, shouted'),
      holdingNone: await holding('a claim nobody staged'),
      holdingOther: (await engine.listStagingsHoldingClaim('other', 'Alice likes tea')).map(nameOf),
      textsBefore: await stored(SRC),
      textsBeforeOther: await stored('other'),
      ...(await engine.transaction(async tx => ({
        aborted: (await tx.abortPurgedStagings([s1.stagingId, s2.stagingId, s3.stagingId, s7, s5, s6, published.stagingId, NO_STAGING])).map(id => pages.get(id) ?? `unknown:${id}`).sort(),
        abortedAgain: (await tx.abortPurgedStagings([s1.stagingId])).map(id => pages.get(id) ?? `unknown:${id}`),
        abortedNothing: await tx.abortPurgedStagings([]),
        deletedTexts: await tx.deleteUnreferencedPurgedTexts(SRC, [orphanReplaced.sha256], 'Alice likes tea'),
        deletedAgain: await tx.deleteUnreferencedPurgedTexts(SRC, [orphanReplaced.sha256], 'Alice likes tea'),
        deletedNothing: await tx.deleteUnreferencedPurgedTexts(SRC, [], 'a claim nobody staged'),
        deletedFence: await tx.deleteUnreferencedPurgedTexts(SRC, [], 'Alice | tea'),
      }))),
      holdingAfter: await holding('Alice likes tea'),
      holdingFenceAfter: await holding('Alice | tea'),
      holdingAfterElsewhere: (await engine.listStagingsHoldingClaim('other', 'Alice likes tea')).map(nameOf),
      textsAfter: await stored(SRC),
      textsAfterOther: await stored('other'),
      manifestKept: await manifestRows(holdsClaim, s1.stagingId),
    };
    expect(out).toEqual({
      holdingBefore: ['holdsClaim', 'holdsShout', 'recorded'], holdingLowered: ['holdsClaim', 'holdsShout', 'recorded'], holdingFence: ['recordedFence'],
      holdingShouted: ['holdsShout'], holdingNone: [], holdingOther: ['elsewhere'],
      textsBefore: ['claim', 'clean', 'fenced', 'orphanClaim', 'orphanClean', 'orphanFence', 'orphanReplaced', 'shouting', 'stagedClaim'], textsBeforeOther: ['claim', 'orphanClaim'],
      aborted: ['holdsClaim', 'holdsNothing', 'holdsShout'], abortedAgain: ['holdsClaim'], abortedNothing: [],
      deletedTexts: 3, deletedAgain: 0, deletedNothing: 0, deletedFence: 2,
      holdingAfter: [], holdingFenceAfter: [], holdingAfterElsewhere: ['elsewhere'],
      textsAfter: ['claim', 'clean', 'orphanClean', 'shouting'], textsAfterOther: ['claim', 'orphanClaim'], manifestKept: 2,
    });
    return out;
  });

  parityTest('listStagingPartEdges, deletePurgedStagingParts and deletePageViewDigests read and delete the upload parts and read-view digests, which have no typed writer', {
    methods: ['createSegmentedPageShell', 'openBodyStaging', 'transaction', 'listStagingPartEdges', 'listStagingsHoldingClaim', 'deletePurgedStagingParts', 'deletePageViewDigests', 'executeRaw'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const staging = async (id: string, state: 'open' | 'sealed' | 'committed', sourceId = SRC) => {
      await engine.transaction(async tx => {
        await tx.openBodyStaging(stagingInput({ id, slug: `notes/${id.slice(-2)}`, sourceId }));
        if (state !== 'open') await tx.setBodyStagingState(id, state);
      });
      return id;
    };
    const SPLIT = 'd0000000-0000-4000-8000-0000000000d1';
    const WHOLE = 'd0000000-0000-4000-8000-0000000000d2';
    const SEALED = 'd0000000-0000-4000-8000-0000000000d3';
    const DONE = 'd0000000-0000-4000-8000-0000000000d4';
    const ELSEWHERE = 'd0000000-0000-4000-8000-0000000000d5';
    const NOTHING = 'd0000000-0000-4000-8000-0000000000d6';
    await staging(SPLIT, 'open'); await staging(WHOLE, 'open'); await staging(SEALED, 'sealed'); await staging(DONE, 'committed');
    await staging(ELSEWHERE, 'open', 'other'); await staging(NOTHING, 'open');
    // The parts of an upload are stored by the upload code with a raw statement; no typed member writes them.
    const part = async (stagingId: string, partNo: number, byteStart: number, text: string) => {
      const bytes = Buffer.from(text);
      await engine.executeRaw(`INSERT INTO page_body_staging_parts (staging_id, part_no, byte_start, byte_len, sha256, body) VALUES ($1::uuid, $2, $3::bigint, $4, decode($5, 'hex'), $6::bytea)`,
        [stagingId, partNo, byteStart, bytes.byteLength, hexOf(sha256(bytes)), bytes]);
    };
    await part(SPLIT, 0, 0, 'xx Alice li'); await part(SPLIT, 1, 11, 'kes tea yy');
    await part(WHOLE, 0, 0, 'plain Alice likes tea whole'); await part(WHOLE, 1, 27, 'ok');
    await part(SEALED, 0, 0, 'sealed and clean');
    await part(DONE, 0, 0, 'committed with Alice likes tea');
    await part(ELSEWHERE, 0, 0, 'other source Alice likes tea');
    await part(NOTHING, 0, 0, 'abc');
    const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
    const edges = async (keep: number, after: { id: string; part: number }) =>
      (await engine.listStagingPartEdges(SRC, keep, after)).map(e => ({ id: e.id.slice(-2), part: Number(e.part_no), head: text(e.head), tail: text(e.tail) }));
    const START = { id: '00000000-0000-0000-0000-000000000000', part: -1 };
    const holding = async () => (await engine.listStagingsHoldingClaim(SRC, 'Alice likes tea')).map(id => id.slice(-2));

    // Read-view digests are a cache written with a raw statement by the page window.
    const pageA = (await engine.createSegmentedPageShell('notes/digest-a', pageMeta('A'), { sourceId: SRC })).id;
    const pageB = (await engine.createSegmentedPageShell('notes/digest-b', pageMeta('B'), { sourceId: SRC })).id;
    const digest = (pageId: number, revision: string, view: string) => engine.executeRaw(
      `INSERT INTO page_view_digests (page_id, revision, view, audience, total_bytes, total_lines, sha256) VALUES ($1, $2, $3, 'trusted', 10, 2, 'abc')`, [pageId, revision, view]);
    await digest(pageA, 'r1', 'read'); await digest(pageA, 'r1', 'markdown'); await digest(pageB, 'r1', 'read');
    const digestCount = async (pageId: number) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_view_digests WHERE page_id = $1', [pageId]))[0]!.n);

    const out = {
      all: await edges(4, START),
      wide: await edges(100, START),
      afterSplitFirst: await edges(4, { id: SPLIT, part: 0 }),
      afterLast: await edges(4, { id: ELSEWHERE, part: 5 }),
      otherSource: (await engine.listStagingPartEdges('other', 4, START)).map(e => ({ id: e.id.slice(-2), head: text(e.head) })),
      holdingBefore: await holding(),
      digestsBefore: [await digestCount(pageA), await digestCount(pageB)],
      ...(await engine.transaction(async tx => ({
        deleted: await tx.deletePurgedStagingParts([SPLIT, DONE, NO_STAGING]),
        deletedAgain: await tx.deletePurgedStagingParts([SPLIT, DONE]),
        deletedNothing: await tx.deletePurgedStagingParts([]),
        digestDelete: await tx.deletePageViewDigests([pageA, 999999]),
        digestDeleteNothing: await tx.deletePageViewDigests([]),
      }))),
      afterDelete: await edges(4, START),
      holdingAfter: await holding(),
      digestsAfter: [await digestCount(pageA), await digestCount(pageB)],
    };
    const e = (id: string, part: number, head: string, tail: string) => ({ id, part, head, tail });
    const live = [e('d1', 0, 'xx A', 'e li'), e('d1', 1, 'kes ', 'a yy'), e('d2', 0, 'plai', 'hole'), e('d2', 1, 'ok', 'ok'), e('d3', 0, 'seal', 'lean'), e('d6', 0, 'abc', 'abc')];
    expect(out).toEqual({
      all: live,
      wide: [e('d1', 0, 'xx Alice li', 'xx Alice li'), e('d1', 1, 'kes tea yy', 'kes tea yy'), e('d2', 0, 'plain Alice likes tea whole', 'plain Alice likes tea whole'),
        e('d2', 1, 'ok', 'ok'), e('d3', 0, 'sealed and clean', 'sealed and clean'), e('d6', 0, 'abc', 'abc')],
      afterSplitFirst: live.slice(1), afterLast: [e('d6', 0, 'abc', 'abc')], otherSource: [{ id: 'd5', head: 'othe' }],
      holdingBefore: ['d2'], digestsBefore: [2, 1],
      deleted: 3, deletedAgain: 0, deletedNothing: 0, digestDelete: undefined, digestDeleteNothing: undefined,
      afterDelete: live.slice(2), holdingAfter: ['d2'], digestsAfter: [0, 1],
    });
    return out;
  });

  parityTest('deletePurgeTakeProposals and blankPurgeCoreEditNotices delete and blank the rows that quote a purged claim; the take proposals have no typed writer', {
    methods: ['insertFact', 'loadPurgeTarget', 'transaction', 'deletePurgeTakeProposals', 'blankPurgeCoreEditNotices', 'executeRaw', 'insertCoreEditNotice', 'readOldestPendingCoreEditNotice'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    const target = await fact(engine, 'Alice likes tea', { entity_slug: 'people/a' });
    const hash = (await engine.loadPurgeTarget(target, SRC))!.fact_hash;
    // Take proposals are written by the take proposer with a raw statement; no typed member writes them.
    const propose = (sourceId: string, slug: string, claim: string, status = 'pending') => engine.executeRaw(
      `INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, model_id, status)
       VALUES ($1, $2, 'h', 'v1', 'run', $3, 'take', 'self', 0.5, 'm', $4)`, [sourceId, slug, claim, status]);
    await propose(SRC, 'people/a', 'Alice likes tea'); await propose(SRC, 'people/a', 'alice  LIKES tea', 'rejected'); await propose(SRC, 'people/b', 'Alice likes tea', 'accepted');
    await propose(SRC, 'people/a', 'Alice likes coffee'); await propose('other', 'people/a', 'Alice likes tea');
    const proposals = async () => (await engine.executeRaw<{ source_id: string; page_slug: string; claim_text: string }>(
      'SELECT source_id, page_slug, claim_text FROM take_proposals ORDER BY source_id, page_slug, claim_text')).map(r => `${r.source_id}:${r.page_slug}:${r.claim_text}`).sort();
    // Core edit notices are written by the core page guard through the typed insert.
    const notice = (sourceId: string, slug: string, baseText: string | null) => engine.insertCoreEditNotice(
      { sourceId, slug, pageId: null, revision: null, baseRevision: null, baseText, actor: 'remote:agent' });
    await notice(SRC, 'core/a', 'Intro. Today Alice Likes Tea at noon.'); await notice(SRC, 'core/b', 'Nothing here'); await notice(SRC, 'core/c', null);
    await notice(SRC, 'core/d', 'alice likes tea'); await notice('other', 'core/a', 'Intro. Today Alice likes tea at noon.');
    const notices = async () => Promise.all([[SRC, 'core/a'], [SRC, 'core/b'], [SRC, 'core/c'], [SRC, 'core/d'], ['other', 'core/a']].map(async ([sourceId, slug]) =>
      `${sourceId}:${slug}:${(await engine.readOldestPendingCoreEditNotice(sourceId!, slug!))!.base_text === null ? 'blank' : 'kept'}`)).then(rows => rows.sort());

    const out = {
      proposalsBefore: await proposals(), noticesBefore: await notices(),
      ...(await engine.transaction(async tx => ({
        deletedProposals: await tx.deletePurgeTakeProposals(SRC, hash),
        deletedProposalsAgain: await tx.deletePurgeTakeProposals(SRC, hash),
        deletedProposalsOtherHash: await tx.deletePurgeTakeProposals(SRC, 'not-a-hash'),
        blanked: await tx.blankPurgeCoreEditNotices(SRC, 'alice likes tea'),
        blankedAgain: await tx.blankPurgeCoreEditNotices(SRC, 'alice likes tea'),
        blankedNothing: await tx.blankPurgeCoreEditNotices(SRC, 'a claim nobody quoted'),
      }))),
      proposalsAfter: await proposals(), noticesAfter: await notices(),
    };
    expect(out).toEqual({
      proposalsBefore: ['default:people/a:Alice likes coffee', 'default:people/a:Alice likes tea', 'default:people/a:alice  LIKES tea', 'default:people/b:Alice likes tea', 'other:people/a:Alice likes tea'],
      noticesBefore: ['default:core/a:kept', 'default:core/b:kept', 'default:core/c:blank', 'default:core/d:kept', 'other:core/a:kept'],
      deletedProposals: 3, deletedProposalsAgain: 0, deletedProposalsOtherHash: 0, blanked: 2, blankedAgain: 0, blankedNothing: 0,
      proposalsAfter: ['default:people/a:Alice likes coffee', 'other:people/a:Alice likes tea'],
      noticesAfter: ['default:core/a:blank', 'default:core/b:kept', 'default:core/c:blank', 'default:core/d:blank', 'other:core/a:kept'],
    });
    return out;
  });

  parityTest('listSegmentedVersionsForPurge finds the saved versions of segmented pages that are named or hold a claim, in id order after a cursor', {
    methods: ['putPage', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'transaction', 'createVersion', 'listSegmentedVersionsForPurge'],
  }, async (engine) => {
    const claim = segmentText('Today Alice likes tea at noon\n');
    const clean = segmentText('Nothing about her here\n');
    const holds = await publishSegmentedPage(engine, 'notes/holds', [claim]);
    const named = await publishSegmentedPage(engine, 'notes/named', [clean]);
    const innocent = await publishSegmentedPage(engine, 'notes/innocent', [clean]);
    await engine.putPage('notes/inline', note('Inline', 'Alice likes tea, inline'));
    const v1 = (await engine.createVersion('notes/holds')).id;
    const v2 = (await engine.createVersion('notes/named')).id;
    const v3 = (await engine.createVersion('notes/innocent')).id;
    const v4 = (await engine.createVersion('notes/inline')).id;
    const v5 = (await engine.createVersion('notes/holds')).id;
    const labels = new Map<number, string>([[Number(v1), 'holds-1'], [Number(v2), 'named'], [Number(v3), 'innocent'], [Number(v4), 'inline'], [Number(v5), 'holds-2']]);
    const pages = new Map<number, string>([[holds.pageId, 'holds'], [named.pageId, 'named'], [innocent.pageId, 'innocent']]);
    const found = async (needle: string, pageIds: number[], after = 0) => (await engine.listSegmentedVersionsForPurge(SRC, needle, pageIds, after)).map(v => ({
      id: labels.get(Number(v.id)) ?? `unknown:${v.id}`, page: pages.get(Number(v.page_id)) ?? `unknown:${v.page_id}`, generation: Number(v.generation), slug: v.slug,
      title: v.title, type: v.type, frontmatter: v.frontmatter, tags: v.tags,
    }));
    const out = {
      byClaim: await found('alice likes tea', []),
      byName: await found('a claim nobody stored', [named.pageId]),
      both: await found('alice likes tea', [named.pageId]),
      afterFirst: await found('alice likes tea', [named.pageId], Number(v1)),
      afterAll: await found('alice likes tea', [named.pageId], Number(v5)),
      nothing: await found('a claim nobody stored', []),
      otherSource: (await engine.listSegmentedVersionsForPurge('other', 'alice likes tea', [named.pageId], 0)).length,
    };
    const seen = (id: string, page: string) => ({ id, page, generation: 1, slug: `notes/${page}`, title: 'Segmented probe', type: 'note', frontmatter: { status: 'probe', nested: { a: 1 } }, tags: [] });
    const holds1 = seen('holds-1', 'holds'), holds2 = seen('holds-2', 'holds'), namedSeen = seen('named', 'named');
    expect(out).toEqual({
      // The inline page's version and the innocent page's version are never listed; a page holds the claim by its live generation, even when not named.
      byClaim: [holds1, holds2], byName: [namedSeen], both: [holds1, namedSeen, holds2], afterFirst: [namedSeen, holds2], afterAll: [], nothing: [], otherSource: 0,
    });
    return out;
  });

  parityTest('insertHoldingPagePurges and insertTakePurge store tombstones, one per holding page and claim, none twice, for the facts that hang off a holding page', {
    methods: ['putPage', 'insertFacts', 'insertFact', 'loadPurgeTarget', 'transaction', 'insertHoldingPagePurges', 'insertTakePurge', 'listPurgeTombstoneMatches', 'executeRaw'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'other');
    await engine.putPage(HOLDING, note('Unattributed', 'a holding page'));
    await engine.putPage('notes/ordinary', note('Ordinary', 'an ordinary page'));
    const target = await fact(engine, 'Alice likes tea', { entity_slug: 'people/alice' });
    const hash = (await engine.loadPurgeTarget(target, SRC))!.fact_hash;
    const alice = await fenced(engine, 'Alice likes tea', { source_markdown_slug: HOLDING, entity_slug: 'people/alice', visibility: 'private' });
    const bob = await fenced(engine, 'Bob likes tea', { source_markdown_slug: HOLDING, entity_slug: 'people/bob', visibility: 'private' });
    const aboutHolding = await fenced(engine, 'The holding page itself', { source_markdown_slug: HOLDING, entity_slug: HOLDING, visibility: 'private' });
    const ordinary = await fenced(engine, 'Ordinary fact', { source_markdown_slug: 'notes/ordinary', entity_slug: 'people/alice', visibility: 'private' });
    // The tombstones have no typed reader, so a local raw read lists them.
    const tombstones = async () => ({
      facts: (await engine.executeRaw<{ subject: string; visibility: string; fact_hash: string; request_id: string; actor: string; reason: string | null }>(
        'SELECT subject, visibility, fact_hash, request_id::text AS request_id, actor, reason FROM fact_purges WHERE source_id = $1 ORDER BY visibility, subject, fact_hash', [SRC]))
        .map(r => ({ ...r, fact_hash: r.fact_hash === hash ? 'target' : r.fact_hash }))
        .sort((x, y) => `${x.visibility}/${x.subject}/${x.fact_hash}`.localeCompare(`${y.visibility}/${y.subject}/${y.fact_hash}`)),
      takes: (await engine.executeRaw<{ subject: string; claim_hash: string; request_id: string }>(
        'SELECT subject, claim_hash, request_id::text AS request_id FROM take_purges WHERE source_id = $1 ORDER BY subject, claim_hash', [SRC]))
        .map(r => ({ ...r, claim_hash: r.claim_hash === hash ? 'target' : r.claim_hash }))
        .sort((x, y) => `${x.subject}/${x.claim_hash}`.localeCompare(`${y.subject}/${y.claim_hash}`)),
      elsewhere: Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM fact_purges WHERE source_id = 'other'`))[0]!.n),
    });
    const before = await tombstones();
    const stored = await engine.transaction(async tx => {
      await tx.insertHoldingPagePurges(SRC, 'private', hash, REQ, 'local_cli:me', 'because', [alice, bob, aboutHolding, ordinary]);
      await tx.insertHoldingPagePurges(SRC, 'private', hash, REQ2, 'local_cli:you', null, [alice]);
      await tx.insertHoldingPagePurges(SRC, 'world', hash, REQ, 'local_cli:me', null, [alice]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-b', REQ, 'local_cli:me', 'again', [bob, bob]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-c', REQ, 'local_cli:me', 'none', [ordinary]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-e', REQ, 'local_cli:me', 'subject', [aboutHolding]);
      await tx.insertHoldingPagePurges(SRC, 'private', 'hash-d', REQ, 'local_cli:me', 'none', []);
      await tx.insertTakePurge({ sourceId: SRC, subject: '*', claimHash: hash, requestId: REQ });
      await tx.insertTakePurge({ sourceId: SRC, subject: '*', claimHash: hash, requestId: REQ2 });
      await tx.insertTakePurge({ sourceId: SRC, subject: 'people/alice', claimHash: hash, requestId: REQ });
      await tx.insertTakePurge({ sourceId: SRC, subject: '*', claimHash: 'hash-b', requestId: REQ });
      return 'stored';
    });
    const matches = async (fact: string, visibility: string, entity: string | null) =>
      (await engine.listPurgeTombstoneMatches(SRC, { facts: [fact], visibilities: [visibility], entitySlugs: [entity], sources: ['fence'] })).map(r => Number(r.ord));
    const out = {
      before, stored, after: await tombstones(),
      matchHolding: await matches('Alice likes tea', 'private', HOLDING), matchWorld: await matches('Alice likes tea', 'world', HOLDING),
      matchPerson: await matches('Alice likes tea', 'private', 'people/alice'), matchOther: await matches('Bob likes tea', 'private', HOLDING),
    };
    const tomb = (visibility: string, fact_hash: string, request_id: string, actor: string, reason: string | null) => ({ subject: HOLDING, visibility, fact_hash, request_id, actor, reason });
    expect(out).toEqual({
      before: { facts: [], takes: [], elsewhere: 0 }, stored: 'stored',
      after: {
        // The first write of a holding page's claim stays: the second call under the same key, with another request and actor, changed nothing.
        // A fact of an ordinary page (hash-c) and an empty list (hash-d) store nothing.
        facts: [tomb('private', 'hash-b', REQ, 'local_cli:me', 'again'), tomb('private', 'hash-e', REQ, 'local_cli:me', 'subject'),
          tomb('private', 'target', REQ, 'local_cli:me', 'because'), tomb('world', 'target', REQ, 'local_cli:me', null)],
        takes: [{ subject: '*', claim_hash: 'hash-b', request_id: REQ }, { subject: '*', claim_hash: 'target', request_id: REQ }, { subject: 'people/alice', claim_hash: 'target', request_id: REQ }],
        elsewhere: 0,
      },
      matchHolding: [1], matchWorld: [1], matchPerson: [], matchOther: [],
    });
    return out;
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
