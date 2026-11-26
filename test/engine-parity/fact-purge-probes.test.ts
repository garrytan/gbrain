/**
 * BrainEngine parity — the store probes a fact purge's receipt makes (src/core/facts/purge-verify.ts `verifyFactPurge`, built in
 * src/core/engine-sql/purge-verify.ts `fingerprintSelect` and `claimTextSelect` and served by `countPurgeProbe`): does any fact, take,
 * take proposal, page, chunk, page version or journal request still carry the purged claim?
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the `fingerprint` probe counts the rows of its store (facts, takes, take proposals) of the source whose claim has the
 *    purged fact's fingerprint (facts: also its visibility and subject, and never a purge's own outcome marker; takes: also the page's
 *    subject); the `claim_text` probe counts the rows of its store (pages, content chunks, page versions, journal requests, core edit
 *    notices) of the source that state the lowered claim, its JSON-escaped form or the reason form. Another source's rows never count;
 *    a count past the row bound is reported as past it. Every probe answers the same on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that counts a store differently reports a purged claim as gone while a store still holds it (or the
 *    reverse), so the fact purge receipt's store report is wrong. The Rust engine refused both probe kinds by name, so a fact purge on
 *    a Rust brain printed no receipt. The two probe cases now run equal on the Rust arm. The whole-receipt case still stops there, on the
 *    first read of the receipt's ledger report: `listBeliefEventsForPurgeProbe`, owned by lane 3 (rust-belief-purge e211982aba), and
 *    behind it `listFactContextsForPurgeProbe`, owned by lane 4 (rust-5a 90e7bea933). With that report set aside, the rest of the receipt
 *    (the derivation probe, every swept store, the file and fingerprint reads) answers the same on Rust as on PGLite, which
 *    fact-purge-inventory-probes.test.ts pins store by store.
 *  - Why existing coverage misses it: the one parity case that counted these probes (purge-verify.test.ts) seeds one row per store and
 *    stopped on the first fingerprint probe on the Rust arm (before this file); no case seeded the near misses (another subject, visibility or source, a
 *    segmented page, a JSON-escaped claim, an outcome marker).
 *  - Seam: `boundedProbe` of facts/purge-verify.ts, called with the arm's engine (it opens its own transaction, as the receipt does),
 *    and `verifyFactPurge` for the whole receipt. Every row is seeded through typed writers: putPage, insertFacts, addTakesBatch,
 *    insertTakeProposal, upsertChunks, createVersion, the write journal and the page-body fixtures. The core edit notices have no
 *    typed writer and hold nothing on every arm. A typed refusal that stops the receipt is returned as a value, so an arm that stops
 *    is counted as stopped, not as equal. Generated values are compared by shape, never by value.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PurgeProbe } from '../../src/core/engine-sql/facts-purge-plan.ts';
import { TERMINAL_AUDIT_SOURCE } from '../../src/core/facts/audit-sources.ts';
import { planFactPurge } from '../../src/core/facts/purge.ts';
import { __setPurgeProbeLimitsForTests, boundedProbe, claimNeedles, reasonNeedle, verifyFactPurge } from '../../src/core/facts/purge-verify.ts';
import { flipInput, publishSegmentedPage, segmentText, stageGeneration } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';
const CLAIM = 'Acme "raised" a Seed \\ round';
const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';

const note = (title: string, body: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter });

/** The count a probe finds, or the way it was left unverified (the receipt's own words). */
async function count(engine: BrainEngine, probe: PurgeProbe): Promise<number | string> {
  const result = await boundedProbe(engine, probe, performance.now() + 60_000);
  return 'unverified' in result ? result.unverified : result.count;
}

/** The fingerprint of `claim` as the engine computes it: the hash a fact of that text carries in the receipt. */
async function hashOf(engine: BrainEngine, claim: string): Promise<string> {
  // A fact in a source no probe of the case reads (the hash is the claim's, whatever its source).
  const row = await engine.insertFact({ fact: claim, entity_slug: null, source: 'chat' }, { source_id: 'hasher' });
  const target = await engine.loadPurgeTarget(row.id, 'hasher');
  return target!.fact_hash;
}

/** One journal row, admitted, claimed and completed (outcome null: left queued). */
async function journal(engine: BrainEngine, requestId: string, sourceId: string, opts: { intent: unknown; outcome?: unknown }): Promise<void> {
  const source = await engine.readSourceMembership(sourceId);
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: 'put_page', sourceId, sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/journal',
    worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: opts.intent, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  if (opts.outcome !== undefined) {
    await engine.stampWriteClaim(row.id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
    await engine.completeWriteRow({
      id: row.id, state: 'committed', outcome: opts.outcome, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null,
      resultBytes: 1200, counterKeys: KEYS, intentBytes: 100, retainedBytes: 1500, terminalReservation: 4096, probePurges: false,
    });
  }
}

const proposal = (engine: BrainEngine, sourceId: string, pageSlug: string, claimText: string) => engine.insertTakeProposal({ sourceId, pageSlug, contentHash: 'hash-1',
  promptVersion: 'parity-v1', proposalRunId: 'run-1', claimText, kind: 'bet', holder: 'brain', weight: 0.6, domain: null, dedupAgainst: [], modelId: 'parity-model' });

describe('engine parity: the store probes of a fact purge receipt', () => {
  parityTest('the fingerprint probe counts the facts, takes and take proposals of the source that carry the claim, within the visibility and subject, and not a purge outcome marker', {
    methods: ['putPage', 'insertFact', 'insertFacts', 'loadPurgeTarget', 'addTakesBatch', 'insertTakeProposal', 'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    await createSource(engine, backend, 'hasher');
    const hash = await hashOf(engine, 'The harbor will reopen in spring');
    const markerHash = await hashOf(engine, 'EXTRACTION_COMPLETE');
    const doomed = await engine.putPage('notes/doomed', note('Doomed', 'Doomed body.'));
    const keeper = await engine.putPage('notes/keeper', note('Keeper', 'Keeper body.'));
    const elsewhere = await engine.putPage('notes/doomed', note('Doomed', 'Doomed body.'), { sourceId: OTHER } as never);
    const fact = (text: string, over: Record<string, unknown> = {}) => ({ fact: text, entity_slug: null, kind: 'fact', visibility: 'world', source: 'chat', ...over });
    await engine.insertFacts([
      fact('The harbor will reopen in spring'),
      fact('The harbor will reopen in spring', { entity_slug: 'notes/keeper' }),
      fact('The harbor will reopen in spring', { visibility: 'private' }),
      fact('The Harbor will reopen in SPRING '),
      fact('A different claim entirely'),
      fact('EXTRACTION_COMPLETE', { source: TERMINAL_AUDIT_SOURCE }),
      fact('EXTRACTION_COMPLETE', { source: 'chat' }),
    ] as never, { source_id: SRC });
    await engine.insertFacts([fact('The harbor will reopen in spring')] as never, { source_id: OTHER });
    await engine.addTakesBatch([
      { page_id: doomed.id, row_num: 1, claim: 'The harbor will reopen in spring', kind: 'take', holder: 'people/bob', weight: 0.7 },
      { page_id: keeper.id, row_num: 1, claim: 'The harbor will reopen in spring', kind: 'take', holder: 'people/alice', weight: 0.5 },
      { page_id: keeper.id, row_num: 2, claim: 'A different take', kind: 'take', holder: 'people/alice', weight: 0.5 },
      { page_id: elsewhere.id, row_num: 1, claim: 'The harbor will reopen in spring', kind: 'take', holder: 'people/bob', weight: 0.7 },
    ]);
    await proposal(engine, SRC, 'notes/doomed', 'The harbor will reopen in spring');
    await proposal(engine, SRC, 'notes/keeper', 'The  harbor will reopen in   spring');
    await proposal(engine, SRC, 'notes/keeper', 'Something else');
    await proposal(engine, OTHER, 'notes/doomed', 'The harbor will reopen in spring');
    const probe = (store: 'facts' | 'takes' | 'take_proposals', over: Partial<Extract<PurgeProbe, { kind: 'fingerprint' }>> = {}): PurgeProbe =>
      ({ kind: 'fingerprint', store, sourceId: SRC, factHash: hash, visibility: 'world', subject: '*', ...over });
    const out: Record<string, number | string> = {};
    for (const store of ['facts', 'takes', 'take_proposals'] as const) {
      out[`${store}:all`] = await count(engine, probe(store));
      out[`${store}:keeperSubject`] = await count(engine, probe(store, { subject: 'notes/keeper' }));
      out[`${store}:doomedSubject`] = await count(engine, probe(store, { subject: 'notes/doomed' }));
      out[`${store}:noSubject`] = await count(engine, probe(store, { subject: 'notes/never' }));
      out[`${store}:private`] = await count(engine, probe(store, { visibility: 'private' }));
      out[`${store}:otherSource`] = await count(engine, probe(store, { sourceId: OTHER }));
      out[`${store}:noSource`] = await count(engine, probe(store, { sourceId: 'hasher', factHash: 'f'.repeat(32) }));
      out[`${store}:otherClaim`] = await count(engine, probe(store, { factHash: await hashOf(engine, 'Never stated anywhere') }));
    }
    out['facts:marker'] = await count(engine, probe('facts', { factHash: markerHash }));
    __setPurgeProbeLimitsForTests({ rows: 1 });
    try { out['facts:bound'] = await count(engine, probe('facts')); out['facts:atBound'] = await count(engine, probe('facts', { subject: 'notes/keeper' })); } finally { __setPurgeProbeLimitsForTests(null); }
    __setPurgeProbeLimitsForTests({ rows: 0 });
    try { out['takes:bound'] = await count(engine, probe('takes')); } finally { __setPurgeProbeLimitsForTests(null); }
    expect(out['facts:otherSource']).toBe(1);
    expect(out['facts:marker']).toBe(1);
    expect(out['facts:bound']).toBe('row_bound');
    return out;
  });

  parityTest('the claim-text probe counts the pages, chunks, page versions and journal requests of the source that state the claim, its JSON form or the reason, and not another source\'s or a segmented body\'s', {
    methods: ['putPage', 'upsertChunks', 'createVersion', 'softDeletePage', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow',
      'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'setBodyStagingState', 'flipBodyGeneration',
      'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const [needle, json] = claimNeedles(CLAIM);
    const reason = 'tidy the quarterly ledger';
    const probe = (store: Extract<PurgeProbe, { kind: 'claim_text' }>['store'], over: Partial<Extract<PurgeProbe, { kind: 'claim_text' }>> = {}): PurgeProbe =>
      ({ kind: 'claim_text', store, sourceId: SRC, claim: needle, json, reason, reasonJson: reason, ...over });
    const stores = ['pages', 'content_chunks', 'page_versions', 'persistence_requests', 'core_edit_notices'] as const;
    const all = async (over: Partial<Extract<PurgeProbe, { kind: 'claim_text' }>> = {}) => {
      const out: Record<string, number | string> = {};
      for (const store of stores) out[store] = await count(engine, probe(store, over));
      return out;
    };
    const empty = await all();
    // Pages: the claim in the body, the timeline, the title, the frontmatter (as JSON text) and nowhere.
    await engine.putPage('notes/body', note('Body', `Notes: ${CLAIM.toUpperCase()}`));
    await engine.putPage('notes/timeline', { ...note('Timeline', 'Nothing.'), timeline: `- **2026-01-02** | ${CLAIM}` });
    await engine.putPage('notes/title', note(CLAIM, 'Nothing.'));
    await engine.putPage('notes/frontmatter', note('Frontmatter', 'Nothing.', { note: CLAIM }));
    await engine.putPage('notes/clean', note('Clean', 'Nothing about the claim here.'));
    await engine.putPage('notes/other-source', note('Other', CLAIM), { sourceId: OTHER } as never);
    const afterPages = await all();
    // A soft-deleted page no longer counts as a page, and its chunks still count.
    await engine.putPage('notes/gone', note('Gone', CLAIM));
    await engine.upsertChunks('notes/gone', [{ chunk_index: 0, chunk_text: `A chunk that says ${CLAIM}`, chunk_source: 'compiled_truth' }]);
    await engine.upsertChunks('notes/clean', [{ chunk_index: 0, chunk_text: 'A chunk that says nothing', chunk_source: 'compiled_truth' }]);
    await engine.upsertChunks('notes/other-source', [{ chunk_index: 0, chunk_text: CLAIM, chunk_source: 'compiled_truth' }], { sourceId: OTHER });
    const withChunks = await all();
    await engine.softDeletePage('notes/gone', { sourceId: SRC });
    const afterSoftDelete = await all();
    // Page versions: a snapshot keeps the claim after the page is edited, and a snapshot's change reason can state the claim or the reason.
    await engine.createVersion('notes/body');
    await engine.putPage('notes/body', note('Body', 'Edited, the claim is gone.'));
    await engine.createVersion('notes/clean', { reason: `quoted ${CLAIM}` });
    await engine.createVersion('notes/title', { reason: reason.toUpperCase() });
    const afterVersions = await all();
    // Journal: the claim in an intent (JSON-escaped), in an outcome, and the reason form; another source's request.
    await journal(engine, 'b0000000-0000-4000-8000-0000000000b1', SRC, { intent: { kind: 'put_page', content: CLAIM } });
    const afterIntent = await all();
    await journal(engine, 'b0000000-0000-4000-8000-0000000000b2', SRC, { intent: { kind: 'put_page' }, outcome: { echoed: CLAIM.toUpperCase() } });
    await journal(engine, 'b0000000-0000-4000-8000-0000000000b3', OTHER, { intent: { kind: 'put_page', content: 'The claim lives in another source: Acme' } });
    const afterOutcome = await all();
    const reasonRequest = await count(engine, probe('persistence_requests', { claim: 'never stated', json: 'never stated', reason: 'never stated', reasonJson: reason }));
    const otherSource = await all({ sourceId: OTHER });
    const noClaim = await all({ claim: 'never stated', json: 'never stated', reason: 'never stated', reasonJson: 'never stated' });
    // A segmented page: its body columns are NULL, so no inline probe finds the claim in its text.
    const segmented = await publishSegmentedPage(engine, 'notes/seg', [segmentText(`Segmented prose: ${CLAIM}\n`)]);
    const afterSegmented = await all();
    __setPurgeProbeLimitsForTests({ rows: 0 });
    let bound: Record<string, number | string>;
    try { bound = await all(); } finally { __setPurgeProbeLimitsForTests(null); }
    expect(segmented.pageId).toBeGreaterThan(0);
    expect(empty).toEqual({ pages: 0, content_chunks: 0, page_versions: 0, persistence_requests: 0, core_edit_notices: 0 });
    expect(afterPages.pages).toBe(4);
    expect(afterSoftDelete.pages).toBe(4);
    expect(afterSoftDelete.core_edit_notices).toBe(0);
    expect(bound.pages).toBe('row_bound');
    return { empty, afterPages, withChunks, afterSoftDelete, afterVersions, afterIntent, afterOutcome, reasonRequest, otherSource, noClaim, afterSegmented, bound };
  });

  parityTest('the content_chunks claim-text probe counts the live, staged and retained older-generation chunks of a segmented page alike, and a page of another source not at all', {
    methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'stageSegmentChunks', 'setBodyStagingState',
      'flipBodyGeneration', 'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const [needle, json] = claimNeedles(CLAIM);
    const chunks = async (sourceId = SRC) => count(engine, { kind: 'claim_text', store: 'content_chunks', sourceId, claim: needle, json, reason: 'never stated', reasonJson: 'never stated' });
    const claimed = segmentText(`First generation: ${CLAIM}\n`);
    const empty = await chunks();
    // Generation 1, published with a chunk that states the claim.
    const one = await publishSegmentedPage(engine, 'notes/gens', [claimed], { chunkTexts: true });
    const live = await chunks();
    // Generation 2, staged with its own claim-stating chunk and not published: the staged chunk counts.
    const next = segmentText(`Second generation: ${CLAIM}\n`);
    const two = await stageGeneration(engine, { pageId: one.pageId, slug: 'notes/gens', genFrom: 2, texts: [next], chunkTexts: true });
    const staged = await chunks();
    // Published, with generation 1's occurrence closed and its chunk's retire deferred (retireMaxRows 0): the older
    // generation's chunk row stays stored, and the probe still counts it beside generation 2's.
    const flip = await engine.transaction(async tx => {
      const result = await tx.flipBodyGeneration(flipInput(one.pageId, 1, two.stagingId, [next],
        { closeOccurrences: [one.occurrences[0]!], retireChunkOccurrences: [one.occurrences[0]!], retireMaxRows: 0 }));
      await tx.setBodyStagingState(two.stagingId, 'committed');
      return result;
    });
    const retired = await chunks();
    // Another source's page with the claim in a chunk is no chunk of this source.
    await publishSegmentedPage(engine, 'notes/away', [segmentText(`Elsewhere: ${CLAIM}\n`)], { sourceId: OTHER, chunkTexts: true });
    const out = { empty, live, staged, retireDeferred: flip.retireDeferred, retired, otherSource: await chunks(OTHER), source: await chunks() };
    expect(out).toMatchObject({ empty: 0, live: 1, staged: 2, retireDeferred: true, retired: 2 });
    expect(out.otherSource).toBe(1);
    return out;
  });

  parityTest('a fact purge receipt reports the same stores on every engine', {
    methods: ['putPage', 'insertFact', 'loadPurgeTarget', 'addTakesBatch', 'insertTakeProposal', 'upsertChunks', 'createVersion', 'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout',
      'countLegacyDerivedPages', 'countFactFingerprintLeftovers', 'listBeliefEventsForPurgeProbe'],
    timeout: 120_000,
  }, async (engine) => {
    const page = await engine.putPage('notes/doomed', note('Doomed', `The page says ${CLAIM}.`));
    await engine.upsertChunks('notes/doomed', [{ chunk_index: 0, chunk_text: `The page says ${CLAIM}.`, chunk_source: 'compiled_truth' }]);
    await engine.createVersion('notes/doomed');
    await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: CLAIM, kind: 'take', holder: 'people/bob', weight: 0.7 }]);
    await proposal(engine, SRC, 'notes/doomed', CLAIM);
    const row = await engine.insertFact({ fact: CLAIM, entity_slug: null, source: 'chat' }, { source_id: SRC });
    const target = (await engine.loadPurgeTarget(row.id, SRC))!;
    const plan = await planFactPurge(engine, target, false);
    expect(reasonNeedle(CLAIM).length).toBeGreaterThan(0);
    const { tell_user_to_run: _engineAdvice, ...receipt } = await verifyFactPurge(engine, { target, plan, dryRun: false }) as
      Awaited<ReturnType<typeof verifyFactPurge>> & { tell_user_to_run?: unknown };
    // The physical-copy residual and the operator's VACUUM advice name the engine's own storage; every other line is engine-independent.
    const residuals = receipt.residuals.map(r => (r.store === 'database_physical' ? { ...r, detail: '<engine vacuum advice>' } : r));
    expect(receipt.fact_id).toBe(row.id);
    return { ...receipt, fact_id: '<fact>', residuals };
  });
});
