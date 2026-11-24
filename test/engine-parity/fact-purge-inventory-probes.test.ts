/**
 * BrainEngine parity — the table probes of a fact purge receipt's swept inventory stores, and the claim forms its derivation probe
 * searches for (src/core/facts/purge-verify.ts `sweptInventoryReports` and `derivationNeedles`; probe shapes in
 * src/core/facts/purge-plan-statements.ts `purgeProbeShape`, served by `countPurgeProbe`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a `table` probe counts the rows of an inventory table whose probed columns hold a needle (exact, case-insensitive; a
 *    JSON column also in its escaped form; a bytea column byte for byte), within the source for a table that has one and brain-wide
 *    for one that has none; it stops one row past the row bound. A table the engine keeps no rows of finds nothing. The claim forms
 *    the derivation probe takes (`derivationNeedles`) are the claims' normalized, case- and locale-folded texts, distinct, sorted, and
 *    without a claim that normalizes to nothing. Every probe answers the same on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that counts one of these stores differently reports a purged claim as gone while the store still holds it
 *    (or the reverse); an engine that folds a claim differently searches the derivation results for another text than PGLite does.
 *    The Rust engine refused every table probe below by name (and the claim forms by raw SQL), so a fact purge receipt stopped at its
 *    first swept store.
 *  - Why existing coverage misses it: test/engine-parity/purge-verify.test.ts and fact-purge-probes.test.ts probe the stores a receipt
 *    names itself, and facts-purge-sites.test.ts reads the derivation probe's batches; none seeds the swept inventory stores (files,
 *    open loops, aliases, held writes, trust proposals, the segmented-body stores) with a match, a near miss and another source's row.
 *  - Seam: `boundedProbe` of facts/purge-verify.ts, called with the arm's engine (it opens its own transaction, as the receipt does),
 *    and `derivationNeedles` of page-body/segment-derive.ts. Every row is seeded through typed writers: putPage, upsertFile,
 *    upsertOpenLoop, setPageAliases, upsertWriteGateHold, insertTrustProposal, the page-body fixtures, upsertSegmentDerivations and the
 *    belief ledger's production baseline. The derived generation ledger, the effect queue and the stores the Rust engine keeps no rows of
 *    have no typed writer here and hold nothing on every arm (the Rust store's own tests seed those). Counts are compared as returned, never by generated value. The belief ledger's table probe is a plain count of
 *    the events each engine keeps (a baseline the production path writes when coverage is enabled); the receipt's ledger report reads their
 *    values through another member, pinned by fact-purge-probes.test.ts.
 */
import { describe, expect } from 'bun:test';
import { createSource, enableBeliefCoverage, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PurgeProbe } from '../../src/core/engine-sql/facts-purge-plan.ts';
import { __setPurgeProbeLimitsForTests, boundedProbe } from '../../src/core/facts/purge-verify.ts';
import { derivationNeedles } from '../../src/core/page-body/segment-derive.ts';
import { hexOf, publishSegmentedPage, segmentText, sha256, stagingInput } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';
const NEEDLE = 'harbor will reopen';
const CLAIM = 'Acme "raised" a Seed \\ round';

const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter: {} });

/** The count a table probe finds, or the way it was left unverified (the receipt's own words). */
async function count(engine: BrainEngine, table: string, needles: readonly string[], sourceId = SRC): Promise<number | string> {
  const probe: PurgeProbe = { kind: 'table', table, sourceId, needles };
  const result = await boundedProbe(engine, probe, performance.now() + 60_000);
  return 'unverified' in result ? result.unverified : result.count;
}

describe('engine parity: the table probes of a fact purge receipt', () => {
  parityTest('the files, open loops, page aliases, held writes and trust proposals that carry a needle are counted within their source, JSON-escaped text included', {
    methods: ['putPage', 'insertFact', 'upsertFile', 'upsertOpenLoop', 'setPageAliases', 'upsertWriteGateHold', 'insertTrustProposal', 'transaction', 'countPurgeProbe',
      'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const doomed = await engine.putPage('notes/doomed', note('Doomed', 'Doomed body.'));
    await engine.putPage('notes/doomed', note('Doomed', 'Doomed body.'), { sourceId: OTHER } as never);
    const fact = await engine.insertFact({ fact: 'A fact', entity_slug: null, source: 'chat' }, { source_id: SRC });
    const empty = {
      files: await count(engine, 'files', [NEEDLE]), open_loops: await count(engine, 'open_loops', [NEEDLE]),
      page_aliases: await count(engine, 'page_aliases', [NEEDLE]), write_gate_holds: await count(engine, 'write_gate_holds', [NEEDLE]),
      trust_proposals: await count(engine, 'trust_proposals', [NEEDLE]),
    };

    // Files: the needle in a file name, in the metadata as JSON text (escaped), and a file of another source.
    await engine.upsertFile({ source_id: SRC, page_slug: 'notes/doomed', page_id: doomed.id, filename: `The Harbor Will Reopen.png`, storage_path: 'doomed/a.png', content_hash: 'ha', size_bytes: 1, mime_type: 'image/png' });
    await engine.upsertFile({ source_id: SRC, page_slug: 'notes/doomed', page_id: doomed.id, filename: 'b.png', storage_path: 'doomed/b.png', content_hash: 'hb', size_bytes: 2, metadata: { caption: CLAIM } });
    await engine.upsertFile({ source_id: SRC, page_slug: null, page_id: null, filename: 'c.png', storage_path: 'doomed/c.png', content_hash: 'hc', size_bytes: 3 });
    await engine.upsertFile({ source_id: OTHER, page_slug: null, page_id: null, filename: 'the harbor will reopen.png', storage_path: 'other/d.png', content_hash: 'hd', size_bytes: 4 });
    // Open loops: the needle in the summary and in the counterparty's address; another source's loop.
    const at = '2026-03-01T10:00:00.000Z';
    const loop = (sourceId: string, dedupKey: string, summary: string, counterpartyEmail = 'a@example.com') => engine.upsertOpenLoop({ sourceId, dedupKey, loopType: 'commitment_owed_by_me',
      counterpartyEmail, summary, evidence: [], detector: 'manual', lastActivityAt: at, openedAt: at });
    await loop(SRC, 'loop-summary', 'The harbor will reopen in spring');
    await loop(SRC, 'loop-email', 'Unrelated', 'harbor.will.reopen@example.com');
    await loop(SRC, 'loop-clean', 'Unrelated');
    await loop(OTHER, 'loop-other', 'The harbor will reopen in spring');
    // Page aliases: the needle in an alias, and another source's alias.
    await engine.setPageAliases('notes/doomed', SRC, ['the harbor will reopen', 'the quay']);
    await engine.setPageAliases('notes/doomed', OTHER, ['the harbor will reopen']);
    // Held writes: the needle in the payload (JSON text), in a reason (a text array), and another source's hold.
    const hold = (sourceId: string, fingerprint: string, payload: Record<string, unknown>, reasons = ['ignore previous instructions']) => engine.upsertWriteGateHold({ kind: 'fact', source_id: sourceId,
      slug: 'people/a', fingerprint, detector_version: 1, tier: 'agent_written', reason_families: ['prompt_injection'], reasons, detector_error: false, payload, write_origin: null, request_id: null });
    await hold(SRC, 'fp-payload', { fact: 'The harbor will reopen' });
    await hold(SRC, 'fp-reason', { fact: 'Nothing' }, ['the harbor will reopen']);
    await hold(SRC, 'fp-clean', { fact: 'Nothing' });
    await hold(OTHER, 'fp-other', { fact: 'The harbor will reopen' });
    // Trust proposals: the needle in the before state (JSON text, so the escaped form of a quoted claim), in the proposer, and another source's proposal.
    // A pending proposal is unique by its action, target and related row, so each one names another related row.
    let related = fact.id + 1000;
    const proposal = (sourceId: string, before: Record<string, unknown>, proposer = 'parity') => engine.insertTrustProposal({ action: 'supersede_fact', sourceId,
      target: { table: 'facts', id: fact.id }, related: { table: 'facts', id: related++ }, before, proposer });
    await proposal(SRC, { note: CLAIM });
    await proposal(SRC, { note: 'nothing' }, 'harbor will reopen guard');
    await proposal(SRC, { note: 'nothing' }, 'clean');
    await proposal(OTHER, { note: 'the harbor will reopen' });

    const found = {
      files: await count(engine, 'files', [NEEDLE]), filesJson: await count(engine, 'files', [CLAIM]), filesOther: await count(engine, 'files', [NEEDLE], OTHER),
      open_loops: await count(engine, 'open_loops', [NEEDLE]), open_loopsEmail: await count(engine, 'open_loops', ['harbor.will.reopen']),
      open_loopsOther: await count(engine, 'open_loops', [NEEDLE], OTHER),
      page_aliases: await count(engine, 'page_aliases', [NEEDLE]), page_aliasesOther: await count(engine, 'page_aliases', [NEEDLE], OTHER),
      page_aliasesSource: await count(engine, 'page_aliases', [SRC]),
      write_gate_holds: await count(engine, 'write_gate_holds', [NEEDLE]), write_gate_holdsOther: await count(engine, 'write_gate_holds', [NEEDLE], OTHER),
      write_gate_holdsKind: await count(engine, 'write_gate_holds', ['prompt_injection']),
      trust_proposals: await count(engine, 'trust_proposals', [CLAIM]), trust_proposalsProposer: await count(engine, 'trust_proposals', [NEEDLE]),
      trust_proposalsOther: await count(engine, 'trust_proposals', [NEEDLE], OTHER),
    };
    const miss = {
      files: await count(engine, 'files', ['never stated anywhere']), open_loops: await count(engine, 'open_loops', ['never stated anywhere']),
      page_aliases: await count(engine, 'page_aliases', ['never stated anywhere']), write_gate_holds: await count(engine, 'write_gate_holds', ['never stated anywhere']),
      trust_proposals: await count(engine, 'trust_proposals', ['never stated anywhere']), noSource: await count(engine, 'files', [NEEDLE], 'nobody'),
    };
    __setPurgeProbeLimitsForTests({ rows: 1 });
    const bound: Record<string, number | string> = {};
    try {
      // The source's own id is a probed column of each, so every row of the source matches.
      for (const table of ['files', 'open_loops', 'write_gate_holds', 'trust_proposals']) bound[table] = await count(engine, table, [SRC]);
    } finally { __setPurgeProbeLimitsForTests(null); }
    expect(empty).toEqual({ files: 0, open_loops: 0, page_aliases: 0, write_gate_holds: 0, trust_proposals: 0 });
    expect(found.files).toBe(1);
    expect(found.filesJson).toBe(1);
    expect(found.filesOther).toBe(1);
    expect(found.open_loops).toBe(1);
    expect(found.open_loopsEmail).toBe(1);
    expect(found.page_aliases).toBe(1);
    expect(found.write_gate_holds).toBe(2);
    expect(found.trust_proposals).toBe(1);
    expect(found.trust_proposalsProposer).toBe(1);
    expect(Object.values(miss).every(n => n === 0)).toBe(true);
    expect(Object.values(bound)).toEqual(['row_bound', 'row_bound', 'row_bound', 'row_bound']);
    return { empty, found, miss, bound };
  });

  parityTest('the segmented-body stores are counted by their text, JSON, hex and bytes: manifests, stagings, staged texts, stored segment texts and derivation results', {
    methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'setBodyStagingState', 'flipBodyGeneration',
      'upsertSegmentDerivations', 'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const own = segmentText('# Intro\nThe harbor will reopen in spring\n');
    const elsewhere = segmentText('# Elsewhere\nA page of another source\n');
    const page = await publishSegmentedPage(engine, 'notes/seg', [own]);
    const away = await publishSegmentedPage(engine, 'notes/seg-away', [elsewhere], { sourceId: OTHER });
    const staging = stagingInput({ slug: 'notes/staged', declaredSha256: sha256('declared') });
    await engine.openBodyStaging(staging);
    const staged = segmentText('A staged text about the Quay\n');
    await engine.stageSegmentTexts(SRC, [staged], { stagingId: staging.id });
    const derivation = (pageId: number, occurrenceId: number, segmentSha256: Uint8Array, output: unknown, receipt: unknown = {}) =>
      ({ pageId, kind: 'links' as const, occurrenceId, version: 1, segmentSha256, contextHash: sha256('ctx'), state: 'done' as const, output, receipt });
    await engine.upsertSegmentDerivations([
      derivation(page.pageId, page.occurrences[0]!, own.sha256, { excerpt: 'Today the Harbor will reopen' }),
      derivation(away.pageId, away.occurrences[0]!, elsewhere.sha256, {}, { found: CLAIM }),
    ]);
    const found = {
      manifestRegion: await count(engine, 'page_body_manifest', ['truth']), manifestJson: await count(engine, 'page_body_manifest', ['intro']),
      manifestSha: await count(engine, 'page_body_manifest', [hexOf(own.sha256)]), manifestOther: await count(engine, 'page_body_manifest', ['truth'], OTHER),
      manifestCut: await count(engine, 'page_body_manifest', ['heading']),
      stagingSlug: await count(engine, 'page_body_stagings', ['notes/staged']), stagingKind: await count(engine, 'page_body_stagings', ['put']),
      stagingSha: await count(engine, 'page_body_stagings', [hexOf(sha256('declared'))]), stagingOther: await count(engine, 'page_body_stagings', ['notes/staged'], OTHER),
      stagedText: await count(engine, 'page_body_staging_texts', [hexOf(staged.sha256)]), stagedSource: await count(engine, 'page_body_staging_texts', [SRC]),
      stagedOther: await count(engine, 'page_body_staging_texts', [hexOf(staged.sha256)], OTHER),
      textBody: await count(engine, 'page_segment_texts', [NEEDLE]), textCase: await count(engine, 'page_segment_texts', [NEEDLE.toUpperCase()]),
      textOther: await count(engine, 'page_segment_texts', ['another source'], OTHER), textElsewhere: await count(engine, 'page_segment_texts', ['another source']),
      derivationOutput: await count(engine, 'page_segment_derivations', ['harbor will reopen']), derivationReceiptJson: await count(engine, 'page_segment_derivations', [CLAIM]),
      derivationBrainWide: await count(engine, 'page_segment_derivations', [CLAIM], 'nobody'),
    };
    const absent = {
      parts: await count(engine, 'page_body_staging_parts', [NEEDLE]), purges: await count(engine, 'page_segment_derivation_purges', [SRC]),
      retrievalPages: await count(engine, 'retrieval_event_pages', [SRC]), retrievalLinks: await count(engine, 'retrieval_event_links', [SRC]),
      retrievalFeedback: await count(engine, 'retrieval_feedback', [SRC]), retrievalWeights: await count(engine, 'retrieval_weights', [SRC]),
      generations: await count(engine, 'derived_generations', [SRC]), generationItems: await count(engine, 'derived_generation_items', [NEEDLE]),
      effects: await count(engine, 'persistence_effects', [SRC]),
    };
    expect(found.manifestRegion).toBe(1);
    expect(found.manifestOther).toBe(1);
    expect(found.stagingSlug).toBe(1);
    expect(found.textBody).toBe(1);
    expect(found.textCase).toBe(0);
    expect(found.derivationOutput).toBe(1);
    expect(found.derivationBrainWide).toBe(1);
    expect(Object.values(absent).every(n => n === 0)).toBe(true);
    return { found, absent };
  });

  parityTest('a derivation result with no output or receipt is SQL NULL and matches no needle, where a nested JSON null reads as the text null, on both probe paths', {
    methods: ['createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState',
      'upsertSegmentDerivations', 'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout', 'probePurgeDerivations'],
    timeout: 120_000,
  }, async (engine) => {
    const first = segmentText('# One\nfirst segment\n');
    const second = segmentText('## Two\nsecond segment\n');
    const third = segmentText('## Three\nthird segment\n');
    const page = await publishSegmentedPage(engine, 'notes/empty', [first, second, third]);
    const derivation = (occurrence: number, segment: Uint8Array, over: { output: unknown; receipt: unknown }) =>
      ({ pageId: page.pageId, kind: 'links' as const, occurrenceId: page.occurrences[occurrence]!, version: 1, segmentSha256: segment, contextHash: sha256('ctx'), state: 'done' as const, ...over });
    await engine.upsertSegmentDerivations([
      // Neither column is written (the input leaves them undefined): both are SQL NULL.
      derivation(0, first.sha256, { output: undefined, receipt: undefined }),
      // A top-level JSON null is SQL NULL too.
      derivation(1, second.sha256, { output: null, receipt: null }),
      // A JSON null inside a document is the text null.
      derivation(2, third.sha256, { output: { note: null }, receipt: {} }),
    ]);
    const batch = (needle: string, rows: number) => engine.transaction(async tx => {
      await tx.setPurgeProbeTimeout(5000);
      const r = await tx.probePurgeDerivations(SRC, [` ${needle} `], [], [`%${needle}%`], null, rows);
      return { scanned: Number(r.scanned), normalized: Number(r.normalized), swept: Number(r.swept), kept: Number(r.kept) };
    });
    const out = {
      tableNull: await count(engine, 'page_segment_derivations', ['null']), tableNote: await count(engine, 'page_segment_derivations', ['note']),
      tableBraces: await count(engine, 'page_segment_derivations', ['{}']), batchNull: await batch('null', 100), batchNote: await batch('note', 100), batchFirst: await batch('null', 1),
    };
    expect(out.tableNull).toBe(1);
    expect(out.batchNull).toMatchObject({ scanned: 3, normalized: 1 });
    return out;
  });

  parityTest('the belief ledger events that carry a needle are counted within their source, whatever the recorded value or subject', {
    methods: ['putPage', 'insertFact', 'transaction', 'countPurgeProbe', 'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const before = await count(engine, 'belief_events', [NEEDLE]);
    await engine.putPage('notes/belief', note('Belief page', 'A page the ledger records.'));
    await engine.putPage('notes/belief-away', note('Away', 'Another source.'), { sourceId: OTHER } as never);
    await engine.insertFact({ fact: 'The harbor will reopen', entity_slug: 'notes/belief', source: 'chat' }, { source_id: SRC });
    // Enabling the ledger writes a baseline event for each page and fact the source already holds.
    await enableBeliefCoverage(engine, backend, SRC);
    await enableBeliefCoverage(engine, backend, OTHER);
    const found = {
      before, slug: await count(engine, 'belief_events', ['notes/belief']), slugOther: await count(engine, 'belief_events', ['notes/belief-away'], OTHER),
      slugAway: await count(engine, 'belief_events', ['notes/belief-away']), value: await count(engine, 'belief_events', [NEEDLE]),
      valueOther: await count(engine, 'belief_events', [NEEDLE], OTHER),
      page: await count(engine, 'belief_events', ['page']), miss: await count(engine, 'belief_events', ['never stated anywhere']),
    };
    expect(found.before).toBe(0);
    expect(found.slug).toBeGreaterThan(0);
    expect(found.slugAway).toBe(0);
    expect(found.value).toBeGreaterThan(0);
    expect(found.valueOther).toBe(0);
    expect(found.miss).toBe(0);
    return found;
  });

  parityTest('the claim forms of the derivation probe are the claims normalized and folded, distinct, sorted and never empty', {
    methods: ['listDerivationClaimForms'],
  }, async (engine) => {
    const plain = await derivationNeedles(engine, ['Alice  likes TEA.', 'alice likes tea', 'Hello, World! (v2.0)']);
    const none = await derivationNeedles(engine, []);
    const blank = await derivationNeedles(engine, ['', '...', '  ']);
    // The locale-dependent lowercasings: a final sigma and a dotted capital I.
    const folded = await derivationNeedles(engine, ['ΚΩΣΤΑΣ', 'İstanbul calling', 'Straße 42']);
    expect(none).toEqual({ needles: [], patterns: [] });
    expect(blank).toEqual({ needles: [], patterns: [] });
    expect(plain.needles).toContain(' alice likes tea ');
    return { plain, none, blank, folded };
  });
});
