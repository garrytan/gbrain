/**
 * BrainEngine parity — the store probes a page purge's receipt makes (src/core/facts/purge-verify.ts `boundedProbe`, built in
 * src/core/engine-sql/purge-verify.ts and served by `countPurgeProbe` and `listPurgeProbeItems`): the slug-keyed stores, the page-row
 * stores, the fact references, the trust proposals, the query cache, the journal's other requests, the segment texts and the queued
 * effects that could still hold a purged page.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each probe kind counts the rows of its store that still name the purged page (its slug, its page id, its fact ids or
 *    its text) within the page's source, and nothing of another page or another source; a count past the row bound is reported as
 *    past it; the effect probe names what it matches as `effect:<id> <kind> <state>`. Every probe answers the same on every engine arm
 *    (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) over one seeded page with rows around it
 *    (another page, another source). A store the engine does not keep answers 0.
 *  - Regression: an engine that counts a store differently reports a purged page as gone while a store still holds it (or the
 *    reverse), so the receipt's verdict is wrong; the Rust engine has no SQL, so each probe has to exist as a typed member it can
 *    serve, and a store it keeps must never answer 0 for rows it holds.
 *  - Why existing coverage misses it: the probes ran through `executeRaw`, which the parity cases cannot call (D18); the one parity
 *    case of the probes (purge-verify.test.ts) counts each kind once over a thin seed and stops on the Rust arm.
 *  - Seam: `boundedProbe` of facts/purge-verify.ts, called with the arm's engine (it opens its own transaction, as the receipt
 *    does). Every row is seeded through typed writers: putPage, insertFacts, insertTakeProposal, upsertOpenLoop, setPageAliases,
 *    updateSlug, logEvalCandidate, upsertFile, upsertWriteGateHold, addTakesBatch, addTimelineEntry, createVersion, upsertChunks,
 *    insertDecideProposal, insertDecideReviewProposal, applyDecideReviewQueue, insertTrustProposal, the write journal, the page-body
 *    fixtures and insertPublicationEffects. The stores with no typed writer (core_edit_notices, the retrieval tables, the volunteer
 *    and gazetteer stores, the query cache) hold nothing on every arm. Generated values are compared by shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PurgeProbe } from '../../src/core/engine-sql/facts-purge-plan.ts';
import type { PurgeStoreProbe } from '../../src/core/engine-sql/purge-verify.ts';
import { __setPurgeProbeLimitsForTests, boundedProbe } from '../../src/core/facts/purge-verify.ts';
import { hexOf, pageMeta, publishSegmentedPage, segmentText, stageGeneration, stagingInput } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';
const SLUG = 'notes/doomed';
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
const PURGE_REQUEST = 'a0000000-0000-4000-8000-0000000000a0';
const ROWS = 100;

const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter: {} });
const fold = (items: readonly string[]) => items.map(item => item.replace(/^([a-z_]+:)\d+/, '$1#'));

/** The count a probe finds, or the way it was left unverified (the receipt's own words). */
async function count(engine: BrainEngine, probe: PurgeProbe): Promise<number | string> {
  const result = await boundedProbe(engine, probe, performance.now() + 60_000);
  return 'unverified' in result ? result.unverified : result.count;
}

/** One journal row of the page: admitted, claimed and completed with `outcome` (null: left queued). */
async function journal(engine: BrainEngine, requestId: string, operation: string, slug: string, opts: { intent?: unknown; outcome?: unknown; sourceId?: string; state?: 'committed' | 'conflict' | 'failed' | 'cancelled' } = {}): Promise<string> {
  const sourceId = opts.sourceId ?? SRC;
  const source = await engine.readSourceMembership(sourceId);
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation, sourceId, sourceIncarnation: source!.incarnation, pageId: null, slug,
    worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: opts.intent ?? { kind: operation, slug }, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  if (opts.outcome !== undefined) {
    await engine.stampWriteClaim(row.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    await engine.completeWriteRow({
      id: row.id, state: opts.state ?? 'committed', outcome: opts.outcome, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null,
      resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500, terminalReservation: 4096, probePurges: false,
    });
  }
  return row.id;
}

/** Queue the given effects under the request `journalId`. */
async function queueEffects(engine: BrainEngine, journalId: string, sourceId: string, effects: Array<{ kind: string; data: Record<string, unknown> }>): Promise<void> {
  const incarnation = (await engine.readSourceMembership(sourceId))!.incarnation;
  await engine.transactionDirect(async tx => {
    await tx.declarePersistence();
    return tx.insertPublicationEffects({ requestId: journalId, revision: null, sourceId, sourceIncarnation: incarnation, worktreeId: null, effects: effects as never });
  });
}

const candidate = (query: string, slugs: string[], sources: string[]) => ({
  tool_name: 'query' as const, query, retrieved_slugs: slugs, retrieved_chunk_ids: [], source_ids: sources, expand_enabled: true, detail: 'medium' as const,
  detail_resolved: 'high' as const, vector_enabled: true, expansion_applied: false, latency_ms: 42, remote: false, job_id: null, subagent_id: null, embedding_column: 'embedding',
});

/** One page with a row in each store that names it, and a second page, another source and another page's rows around it. */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, OTHER);
  // A rename leaves a redirect from the old slug to the page's new one.
  await engine.putPage('notes/old-name', note('Old Name', 'Renamed later.'));
  await engine.updateSlug('notes/old-name', SLUG, { sourceId: SRC });
  const doomed = await engine.putPage(SLUG, note('Doomed', 'The harbor ledger starts here.'));
  const keeper = await engine.putPage('notes/keeper', note('Keeper', 'Keeper notes.'));
  await engine.putPage('notes/other-source', note('Other Source', 'Lives in another source.'), { sourceId: OTHER } as never);
  await engine.upsertChunks(SLUG, [{ chunk_index: 0, chunk_text: 'The harbor ledger starts here.', chunk_source: 'compiled_truth' }]);
  await engine.createVersion(SLUG);
  await engine.addTimelineEntry(SLUG, { date: '2026-01-02', summary: 'Ledger opened' });
  await engine.addTakesBatch([
    { page_id: doomed.id, row_num: 1, claim: 'The harbor will reopen in spring', kind: 'take', holder: 'people/bob', weight: 0.7 },
    { page_id: keeper.id, row_num: 1, claim: 'The keeper outlasts the harbor', kind: 'take', holder: 'people/alice', weight: 0.5 },
  ]);
  const facts = {
    filed: Number((await engine.insertFacts([{ fact: 'Doomed harbor ledger fact', entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: 1, source_markdown_slug: SLUG }] as never, { source_id: SRC })).ids[0]),
    keeper: Number((await engine.insertFacts([{ fact: 'Keeper harbor fact', entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: 2, source_markdown_slug: 'notes/keeper' }] as never, { source_id: SRC })).ids[0]),
    otherSource: Number((await engine.insertFacts([{ fact: 'Doomed harbor ledger fact', entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: 1, source_markdown_slug: SLUG }] as never, { source_id: OTHER })).ids[0]),
  };
  // Slug stores.
  const proposal = (sourceId: string, pageSlug: string, claimText: string) => engine.insertTakeProposal({ sourceId, pageSlug, contentHash: 'hash-1', promptVersion: 'parity-v1', proposalRunId: 'run-1', claimText,
    kind: 'bet', holder: 'brain', weight: 0.6, domain: null, dedupAgainst: [], modelId: 'parity-model' });
  await proposal(SRC, SLUG, 'Doomed-co ships soon'); await proposal(SRC, 'notes/keeper', 'Keeper-co ships'); await proposal(OTHER, 'notes/other-source', 'Other-co ships');
  const at = '2026-03-01T10:00:00.000Z';
  const loop = (key: string, sourceId: string, pageSlug: string) => engine.upsertOpenLoop({ sourceId, dedupKey: key, loopType: 'commitment_owed_by_me', counterpartyEmail: 'a@example.com', summary: key,
    evidence: [], detector: 'manual', pageSlug, lastActivityAt: at, openedAt: at } as never);
  await loop('loop-doomed', SRC, SLUG); await loop('loop-keeper', SRC, 'notes/keeper');
  await engine.setPageAliases(SLUG, SRC, ['doomed alias']);
  await engine.setPageAliases('notes/keeper', SRC, ['keeper alias']);
  await engine.logEvalCandidate(candidate('covers default', [SLUG], [SRC]));
  await engine.logEvalCandidate(candidate('covers keeper', ['notes/keeper'], [SRC]));
  await engine.upsertFile({ page_slug: SLUG, page_id: null, filename: 'b.png', storage_path: 'doomed/b.png', content_hash: 'hb', size_bytes: 2 });
  await engine.upsertFile({ source_id: OTHER, page_slug: 'notes/never', page_id: null, filename: 'o.png', storage_path: 'other/o.png', content_hash: 'ho', size_bytes: 4 });
  await engine.upsertWriteGateHold({ kind: 'fact', source_id: SRC, slug: SLUG, fingerprint: 'fp-1', detector_version: 1, tier: 'agent_written', reason_families: ['prompt_injection'],
    reasons: ['ignore previous instructions'], detector_error: false, payload: { fact: 'held' }, write_origin: null, request_id: null });
  // Fact references.
  const decide = (index: number, newer: number, older: number) => ({ source_id: SRC, sweep_id: 's1', pair_index: index, new_fact_id: newer, old_fact_id: older,
    direction: 'new_supersedes_old' as const, p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a' });
  await engine.insertDecideProposal(decide(0, facts.filed, facts.keeper));
  const review = (a: string, b: string) => ({ kind: 'duplicate_page', source_id: SRC, sweep_id: 'r1', a_ref: a, b_ref: b, subject: '*', visibility: null,
    p_action: 0.75, threshold: 0.6, model_resolved: 'model-a', question_version: '1', receipt: null });
  await engine.insertDecideReviewProposal(review(String(facts.filed), 'pages/x'));
  await engine.applyDecideReviewQueue({ op: 'enqueue', kind: 'duplicate_page', source_id: SRC, a_ref: 'pages/y', b_ref: String(facts.filed), evidence: null });
  // Trust proposals.
  await engine.insertTrustProposal({ action: 'lower_page', sourceId: SRC, target: { table: 'pages', id: doomed.id }, before: {}, proposer: 'parity' });
  await engine.insertTrustProposal({ action: 'forget', sourceId: SRC, target: { table: 'facts', id: facts.keeper }, related: { table: 'facts', id: facts.filed }, before: {}, proposer: 'parity' });
  await engine.insertTrustProposal({ action: 'lower_page', sourceId: SRC, target: { table: 'pages', id: keeper.id }, before: {}, proposer: 'parity' });
  return { pageId: Number(doomed.id), keeperId: Number(keeper.id), facts };
}

describe('engine parity: the store probes of a page purge receipt', () => {
  parityTest('the slug-keyed probes count the rows of each store that name the page in its source, and nothing of another page or source', {
    methods: ['putPage', 'upsertChunks', 'createVersion', 'addTimelineEntry', 'addTakesBatch', 'insertFacts', 'insertTakeProposal', 'upsertOpenLoop', 'setPageAliases', 'updateSlug',
      'logEvalCandidate', 'upsertFile', 'upsertWriteGateHold', 'insertDecideProposal', 'insertDecideReviewProposal', 'applyDecideReviewQueue', 'insertTrustProposal',
      'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine, backend) => {
    const { pageId, keeperId } = await seed(engine, backend);
    const stores = ['pages', 'facts', 'take_proposals', 'open_loops', 'core_edit_notices', 'page_aliases', 'slug_aliases', 'retrieval_event_pages', 'retrieval_event_links',
      'retrieval_feedback', 'retrieval_weights', 'eval_candidates.retrieved_slugs', 'context_volunteer_events', 'mention_gazetteer_entries', 'files', 'write_gate_holds'] as const;
    // A hold follows its page id (master #10200): the probe is told the id the slug has, as the purge verifier does.
    const ids: Record<string, number> = { [SLUG]: pageId, 'notes/keeper': keeperId };
    const probe = (store: typeof stores[number], sourceId: string, slug: string): PurgeStoreProbe => ({ kind: 'slug_key', store, sourceId, slug, ...(sourceId === SRC && ids[slug] !== undefined ? { pageId: ids[slug] } : {}) });
    const answers: Record<string, Record<string, number | string>> = {};
    for (const store of stores) {
      answers[store] = {
        doomed: await count(engine, probe(store, SRC, SLUG)),
        keeper: await count(engine, probe(store, SRC, 'notes/keeper')),
        nobody: await count(engine, probe(store, SRC, 'notes/never')),
        otherSource: await count(engine, probe(store, OTHER, SLUG)),
      };
    }
    expect(answers.pages).toEqual({ doomed: 1, keeper: 1, nobody: 0, otherSource: 0 });
    expect(answers.facts!.doomed).toBe(1);
    expect(answers.take_proposals!.doomed).toBe(1);
    expect(answers.open_loops!.doomed).toBe(1);
    expect(answers.page_aliases!.doomed).toBe(1);
    expect(answers.slug_aliases!.doomed).toBe(1);
    expect(answers.write_gate_holds!.doomed).toBe(1);
    expect(answers.core_edit_notices).toEqual({ doomed: 0, keeper: 0, nobody: 0, otherSource: 0 });
    return answers;
  });

  parityTest('the eval-candidate probe counts a slug only in a candidate that covers the source and no other covered source holds, the page probe counts a soft-deleted page, and a count past the row bound is reported as past it', {
    methods: ['putPage', 'logEvalCandidate', 'softDeletePage', 'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    await engine.putPage(SLUG, note('Doomed', 'The harbor ledger starts here.'));
    for (const slug of ['notes/shared', 'notes/pair']) {
      await engine.putPage(slug, note(slug, 'Held by both sources.'));
      await engine.putPage(slug, note(slug, 'Held by both sources.'), { sourceId: OTHER } as never);
    }
    await engine.logEvalCandidate(candidate('covers default', [SLUG, 'notes/shared'], [SRC]));
    await engine.logEvalCandidate(candidate('covers both', [SLUG, 'notes/pair'], [SRC, OTHER]));
    await engine.logEvalCandidate(candidate('covers none', [SLUG], []));
    const evalCount = (slug: string, sourceId = SRC) => count(engine, { kind: 'slug_key', store: 'eval_candidates.retrieved_slugs', sourceId, slug });
    const before = { doomed: await evalCount(SLUG), doomedOther: await evalCount(SLUG, OTHER), shared: await evalCount('notes/shared'), pair: await evalCount('notes/pair'), pairOther: await evalCount('notes/pair', OTHER) };
    const pages = () => count(engine, { kind: 'slug_key', store: 'pages', sourceId: SRC, slug: SLUG });
    await engine.softDeletePage(SLUG, { sourceId: SRC });
    const afterSoftDelete = { page: await pages(), doomed: await evalCount(SLUG) };
    __setPurgeProbeLimitsForTests({ rows: 0 });
    let bound: number | string;
    try { bound = await pages(); } finally { __setPurgeProbeLimitsForTests(null); }
    expect(before.doomed).toBe(2);
    expect(before.pair).toBe(0);
    expect(afterSoftDelete.page).toBe(1);
    expect(bound).toBe('row_bound');
    return { before, afterSoftDelete, bound };
  });

  parityTest('the page-row, fact-reference and trust probes count the rows that name the page id or the fact ids, within the source', {
    methods: ['putPage', 'upsertChunks', 'createVersion', 'addTimelineEntry', 'addTakesBatch', 'insertFacts', 'insertTakeProposal', 'upsertOpenLoop', 'setPageAliases', 'updateSlug',
      'logEvalCandidate', 'upsertFile', 'upsertWriteGateHold', 'insertDecideProposal', 'insertDecideReviewProposal', 'applyDecideReviewQueue', 'insertTrustProposal',
      'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine, backend) => {
    const { pageId, keeperId, facts } = await seed(engine, backend);
    const none = pageId + 100_000;
    const rows: Record<string, number | string> = {};
    for (const store of ['content_chunks', 'page_versions', 'takes', 'timeline_entries'] as const) {
      rows[`${store}:doomed`] = await count(engine, { kind: 'page_rows', store, pageId });
      rows[`${store}:keeper`] = await count(engine, { kind: 'page_rows', store, pageId: keeperId });
      rows[`${store}:none`] = await count(engine, { kind: 'page_rows', store, pageId: none });
    }
    const refs: Record<string, number | string> = {};
    for (const store of ['decide_review_queue', 'decide_review_proposals', 'decide_proposals'] as const) {
      refs[`${store}:filed`] = await count(engine, { kind: 'fact_refs', store, sourceId: SRC, factIds: [facts.filed] });
      refs[`${store}:both`] = await count(engine, { kind: 'fact_refs', store, sourceId: SRC, factIds: [facts.filed, facts.keeper] });
      refs[`${store}:none`] = await count(engine, { kind: 'fact_refs', store, sourceId: SRC, factIds: [] });
      refs[`${store}:otherSource`] = await count(engine, { kind: 'fact_refs', store, sourceId: OTHER, factIds: [facts.filed] });
    }
    const trust = {
      page: await count(engine, { kind: 'trust_proposals', sourceId: SRC, pageId, factIds: [] }),
      pageAndFact: await count(engine, { kind: 'trust_proposals', sourceId: SRC, pageId, factIds: [facts.filed] }),
      factOnly: await count(engine, { kind: 'trust_proposals', sourceId: SRC, pageId: none, factIds: [facts.keeper] }),
      related: await count(engine, { kind: 'trust_proposals', sourceId: SRC, pageId: none, factIds: [facts.filed] }),
      nothing: await count(engine, { kind: 'trust_proposals', sourceId: SRC, pageId: none, factIds: [] }),
      otherSource: await count(engine, { kind: 'trust_proposals', sourceId: OTHER, pageId, factIds: [facts.filed] }),
    };
    const cache = await count(engine, { kind: 'query_cache', sourceId: SRC });
    expect(rows['timeline_entries:doomed']).toBe(1);
    expect(rows['takes:doomed']).toBe(1);
    expect(trust.page).toBe(1);
    expect(trust.nothing).toBe(0);
    return { rows, refs, trust, cache };
  });

  parityTest('the journal probe counts the page\'s other finished requests and any request that carries the text, and not its own request or another source\'s', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow', 'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const probe = (over: Partial<Extract<PurgeStoreProbe, { kind: 'page_requests' }>> = {}): PurgeStoreProbe =>
      ({ kind: 'page_requests', sourceId: SRC, slug: SLUG, requestId: PURGE_REQUEST, needles: [], reasons: [], ...over });
    const empty = await count(engine, probe());
    await journal(engine, 'b0000000-0000-4000-8000-0000000000b1', 'put_page', SLUG, { outcome: { slug: SLUG }, intent: { kind: 'put_page', slug: SLUG, content: 'plain' } });
    const finished = await count(engine, probe());
    await journal(engine, 'b0000000-0000-4000-8000-0000000000b2', 'put_page', 'notes/keeper', { intent: { kind: 'put_page', slug: 'notes/keeper', content: 'The Harbor Ledger is quoted here' } });
    const carrying = await count(engine, probe({ needles: ['harbor ledger'] }));
    const escaped = await count(engine, probe({ needles: ['harbor ledger'], slug: 'notes/other' }));
    await journal(engine, 'b0000000-0000-4000-8000-0000000000b3', 'put_page', SLUG, { intent: { kind: 'put_page', slug: SLUG, reason: 'tidy the harbor' } });
    const reasons = await count(engine, probe({ reasons: ['tidy the harbor'], slug: SLUG, requestId: 'b0000000-0000-4000-8000-0000000000b1' }));
    const otherReason = await count(engine, probe({ reasons: ['tidy the harbor'], slug: 'notes/keeper' }));
    await journal(engine, 'b0000000-0000-4000-8000-0000000000b4', 'put_page', SLUG, { intent: { kind: 'put_page', slug: SLUG, content: 'x' }, sourceId: OTHER });
    const otherSource = await count(engine, probe({ sourceId: OTHER, slug: 'notes/never' }));
    const own = await count(engine, probe({ requestId: 'b0000000-0000-4000-8000-0000000000b1' }));
    expect(empty).toBe(0);
    expect(finished).toBe(1);
    return { empty, finished, carrying, escaped, reasons, otherReason, otherSource, own };
  });

  parityTest('the segment-text probes count the source\'s texts a page named or that hold the text, whether a manifest row still names them, and leave out a text a live staging recorded', {
    methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'setBodyStagingState', 'flipBodyGeneration',
      'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const named = segmentText('A text the doomed page names: Harbor Ledger\n');
    const clean = segmentText('Nothing of interest here\n');
    const orphan = segmentText('An orphan that says harbor ledger\n');
    const orphanClean = segmentText('An orphan that says nothing\n');
    const draft = segmentText('A draft a live staging recorded: harbor ledger\n');
    const elsewhere = segmentText('Another source: harbor ledger\n');
    const doomed = await publishSegmentedPage(engine, 'notes/seg', [named, clean]);
    await engine.stageSegmentTexts(SRC, [orphan, orphanClean]);
    await engine.stageSegmentTexts(OTHER, [elsewhere, orphan]);
    const shell = (await engine.createSegmentedPageShell('notes/drafting', pageMeta('Drafting'), { sourceId: SRC })).id;
    await stageGeneration(engine, { pageId: shell, slug: 'notes/drafting', genFrom: 1, texts: [draft] });
    // A create's staging with no page row: it recorded a text no manifest row names, and the text stays while the staging lives.
    const recorded = segmentText('A text only a live staging recorded: harbor ledger\n');
    const createId = 'c0000000-0000-4000-8000-0000000000c1';
    await engine.transaction(async tx => {
      await tx.openBodyStaging(stagingInput({ id: createId, slug: 'notes/created' }));
      await tx.stageSegmentTexts(SRC, [recorded], { stagingId: createId });
    });
    const own = (shas: string[], forms: string[], sourceId = SRC) => count(engine, { kind: 'page_segment_texts', sourceId, shas, forms });
    const texts = (needles: string[], referenced: boolean, sourceId = SRC) => count(engine, { kind: 'segment_texts', sourceId, needles, referenced });
    const out = {
      byShaWhileNamed: await own([hexOf(named.sha256)], []),
      byShaOrphan: await own([hexOf(orphan.sha256)], []),
      byFormOrphan: await own([], ['harbor ledger']),
      byFormNone: await own([], ['never stored']),
      noShaNoForm: await own([], []),
      byShaRecorded: await own([hexOf(recorded.sha256)], []),
      byShaOtherSource: await own([hexOf(orphan.sha256)], [], OTHER),
      unreferenced: await texts(['harbor ledger'], false),
      unreferencedBytes: await texts(['Harbor Ledger'], false),
      referenced: await texts(['harbor ledger'], true),
      referencedBytes: await texts(['Harbor Ledger'], true),
      none: await texts(['never stored'], false),
      noNeedle: await texts([], false),
      otherSource: await texts(['harbor ledger'], false, OTHER),
    };
    expect(doomed.pageId).toBeGreaterThan(0);
    expect(out.byShaWhileNamed).toBe(0);
    expect(out.byShaOrphan).toBe(1);
    expect(out.byShaRecorded).toBe(0);
    expect(out.unreferenced).toBeGreaterThan(out.byFormOrphan as number);
    return out;
  });

  parityTest('the effect probe counts and names the source\'s effects whose payload carries the text, and a page\'s own Git effects that carry a reason', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'transaction',
      'countPurgeProbe', 'listPurgeProbeItems', 'setPurgeProbeTimeout'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const first = await journal(engine, 'b0000000-0000-4000-8000-0000000000e1', 'put_page', SLUG);
    await queueEffects(engine, first, SRC, [
      { kind: 'git', data: { slug: SLUG, commit_line: 'Fix the Harbor Ledger claim', commit_trailers: ['gbrain-reason: tidy the harbor'] } },
      { kind: 'embedding', data: { slug: SLUG, commit_line: 'harbor ledger in a non-Git effect' } },
      { kind: 'git', data: { slug: 'notes/keeper', commit_line: 'unrelated', commit_trailers: ['gbrain-reason: tidy the harbor'] } },
    ]);
    const other = await journal(engine, 'b0000000-0000-4000-8000-0000000000e2', 'put_page', SLUG, { sourceId: OTHER });
    await queueEffects(engine, other, OTHER, [{ kind: 'git', data: { slug: SLUG, commit_line: 'harbor ledger elsewhere' } }]);
    const effects = (forms: string[], page?: { slug: string; reasonForms: string[] }) => ({ kind: 'effect_payload' as const, sourceId: SRC, forms, ...(page ? { page } : {}) });
    const probes = {
      carrying: effects(['harbor ledger']),
      none: effects(['never stored']),
      noForms: effects([]),
      ownReason: effects([], { slug: SLUG, reasonForms: ['tidy the harbor'] }),
      keeperReason: effects([], { slug: 'notes/keeper', reasonForms: ['tidy the harbor'] }),
      both: effects(['harbor ledger'], { slug: SLUG, reasonForms: ['tidy the harbor'] }),
      escaped: effects(['"harbor']),
    };
    const out: Record<string, { count: number | string; items: string[] }> = {};
    for (const [label, probe] of Object.entries(probes)) {
      out[label] = { count: await count(engine, probe), items: fold(await engine.listPurgeProbeItems(probe)) };
    }
    expect(out.carrying!.count).toBe(2);
    expect(out.none).toEqual({ count: 0, items: [] });
    return out;
  });

  parityTest('the effect probe lists the first 20 of more than 20 matches in byte order, whatever the database collation, so ids of different widths keep their place', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects', 'transaction',
      'countPurgeProbe', 'listPurgeProbeItems', 'setPurgeProbeTimeout'],
  }, async (engine, backend) => {
    // Effect ids 1..25 (two widths, `effect:1 ` against `effect:10`): a Postgres sequence a shared database already ran starts the ids
    // higher, so restart it. The Rust store numbers its effects from 1.
    if (backend !== 'rust') await engine.executeRaw("SELECT setval(pg_get_serial_sequence('persistence_effects', 'id'), 1, false)");
    // One Git effect per request.
    for (let n = 1; n <= 25; n++) {
      const request = `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      await queueEffects(engine, await journal(engine, request, 'put_page', SLUG), SRC, [{ kind: 'git', data: { slug: SLUG, commit_line: 'Fix the Harbor Ledger claim' } }]);
    }
    const probe = { kind: 'effect_payload' as const, sourceId: SRC, forms: ['harbor ledger'] };
    const items = await engine.listPurgeProbeItems(probe);
    // The contract: the 20 smallest items by byte order. A collation that ignores the space (en_US) puts `effect:10` before `effect:1 `.
    const expected = Array.from({ length: 25 }, (_, i) => `effect:${i + 1} git queued`).sort().slice(0, 20);
    expect(items).toEqual(expected);
    expect(await count(engine, probe)).toBe(25);
    expect(await engine.countPurgeProbe(probe, 5)).toBe(6);
    return { items };
  });
});
