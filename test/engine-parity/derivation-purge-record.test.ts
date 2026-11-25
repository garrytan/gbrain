/**
 * BrainEngine parity — the record a fact purge keeps of its derivation sweep (src/core/page-body/segment-derive.ts
 * `recordDerivationPurge`, the INSERT INTO page_segment_derivation_purges that ran through `executeRaw`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: recording a sweep makes `derivationPurgeState` answer `pending` (null before), `relationExists` answer true for
 *    page_segment_derivation_purges, and the table probe count the record within its source (a needle in the claim forms, the source id)
 *    and nothing in another source; a second record of the same request is a no-op (its other claim is not kept); a claim that
 *    normalizes to nothing records nothing. While a sweep is recorded, a derivation write of its source that the sweep would
 *    delete (its page rewritten by the purge, or no live segment backing it) and that holds the claim is not stored (the write stores the others, then throws `derivation_purge_pending` with the count dropped), and the row already stored there is left as it was; a write that holds no claim, or that a live segment on a page
 *    the purge did not rewrite backs, is stored. Every engine arm answers alike (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm with GBRAIN_TEST_RUST_ARM=1). The request id is read as Postgres reads a uuid: compact, brace-wrapped, with a hyphen
 *    after any group of four digits and in capitals all name one request (record, state and conflict agree); other text refuses.
 *    The drop happens before the CHECK constraints and the conflict handling, so a batch whose first row of a key holds the
 *    claim stores its second row of that key, and a dropped row that would fail a CHECK is dropped, not refused.
 *  - Regression: an engine that cannot record the sweep stops the fact purge inside its transaction; one that records it but
 *    answers no state lets a purge report its derivation sweep complete; one that keeps no guard lets a derivation pipeline store
 *    the purged claim again after the sweep has passed its page.
 *  - Why existing coverage misses it: the record was a raw INSERT, so only the PGLite and Postgres derivation suites
 *    (test/helpers/derivation-purge-cases.ts) ran it; the receipt-read cases answer null for a request with no record.
 *  - Seam: `recordDerivationPurge` and `derivationPurgeState` of page-body/segment-derive.ts, called with the arm's engine
 *    inside `engine.transaction`, as the purge calls them. Derivation rows go through the typed `upsertSegmentDerivations`, read back
 *    through `readSegmentDerivations`; pages through the page-body fixtures. Generated page ids are named by label.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PurgeProbe } from '../../src/core/engine-sql/facts-purge-plan.ts';
import { boundedProbe } from '../../src/core/facts/purge-verify.ts';
import { derivationPurgeState, recordDerivationPurge } from '../../src/core/page-body/segment-derive.ts';
import { relationExists } from '../../src/core/persistence/rebuildable-cache.ts';
import { publishSegmentedPage, segmentText, sha256 } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';
const REQ = 'c0000000-0000-4000-8000-0000000000c1';
const REQ2 = 'c0000000-0000-4000-8000-0000000000c2';
const REQ3 = 'c0000000-0000-4000-8000-0000000000c3';
const REQ4 = 'c0000000-0000-4000-8000-0000000000c4';
const TABLE = 'page_segment_derivation_purges';
const CLAIM = 'Alice likes tea';

/** The count the table probe finds in the record store, or the way it was left unverified. */
async function count(engine: BrainEngine, needles: readonly string[], sourceId = SRC): Promise<number | string> {
  const probe: PurgeProbe = { kind: 'table', table: TABLE, sourceId, needles };
  const result = await boundedProbe(engine, probe, performance.now() + 60_000);
  return 'unverified' in result ? result.unverified : result.count;
}

const record = (engine: BrainEngine, requestId: string, pageIds: number[], claims: string[], sourceId = SRC) =>
  engine.transaction(tx => recordDerivationPurge(tx, requestId, sourceId, pageIds, claims));

describe('engine parity: the derivation sweep record of a fact purge', () => {
  parityTest('recording a sweep makes its state pending and its table countable; a second record of the request and an empty claim keep nothing', {
    methods: ['transaction', 'readDerivationPurgeState', 'relationExists', 'countPurgeProbe', 'setPurgeProbeTimeout', 'listDerivationClaimForms'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const before = {
      state: await derivationPurgeState(engine, REQ), present: await relationExists(engine, TABLE), probe: await count(engine, [SRC]),
    };
    await record(engine, REQ, [7, 3], [CLAIM, 'Alice "likes" tea']);
    const recorded = {
      state: await derivationPurgeState(engine, REQ), present: await relationExists(engine, TABLE), present_public: await relationExists(engine, `public.${TABLE}`),
      byNeedle: await count(engine, ['alice likes tea']), bySource: await count(engine, [SRC]), byOther: await count(engine, [SRC], OTHER),
      byPages: await count(engine, ['{7,3}']), none: await count(engine, ['never stated anywhere']),
    };
    // The same request again, with another claim: ON CONFLICT (request_id) DO NOTHING.
    await record(engine, REQ, [9], ['Zebra crossing']);
    const again = { state: await derivationPurgeState(engine, REQ), zebra: await count(engine, ['zebra crossing']), bySource: await count(engine, [SRC]) };
    // A claim that normalizes to nothing records nothing.
    await record(engine, REQ2, [1], ['', '   ']);
    await record(engine, REQ3, [], []);
    const empty = { state2: await derivationPurgeState(engine, REQ2), state3: await derivationPurgeState(engine, REQ3), bySource: await count(engine, [SRC]) };
    expect(before).toEqual({ state: null, present: true, probe: 0 });
    expect(recorded.state).toEqual({ state: 'pending', reason: null });
    expect(recorded.byNeedle).toBe(1);
    expect(recorded.byPages).toBe(1);
    expect(recorded.byOther).toBe(0);
    expect(again).toEqual({ state: { state: 'pending', reason: null }, zebra: 0, bySource: 1 });
    expect(empty).toEqual({ state2: null, state3: null, bySource: 1 });
    return { before, recorded, again, empty };
  });

  parityTest('while a sweep is recorded, a derivation write it would delete and that holds the claim is dropped (the write then throws derivation_purge_pending), and any other write is stored', {
    methods: ['transaction', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'upsertSegmentDerivations', 'readSegmentDerivations', 'readDerivationPurgeState', 'listDerivationClaimForms'],
    timeout: 120_000,
  }, async (engine) => {
    const a0 = segmentText('# One\nfirst segment\n');
    const a1 = segmentText('## Two\nsecond segment\n');
    const b0 = segmentText('# Other\nanother page\n');
    const a = await publishSegmentedPage(engine, 'notes/guard-a', [a0, a1]);
    const b = await publishSegmentedPage(engine, 'notes/guard-b', [b0]);
    const row = (pageId: number, kind: 'links' | 'timeline', occurrenceId: number, segmentSha256: ReturnType<typeof sha256>, output: unknown, receipt: unknown = {}) =>
      ({ pageId, kind, occurrenceId, version: 1, segmentSha256, contextHash: sha256(`ctx:${kind}`), state: 'done' as const, output, receipt });
    await engine.upsertSegmentDerivations([row(a.pageId, 'links', a.occurrences[0]!, a0.sha256, { excerpt: 'harmless' })]);
    await record(engine, REQ, [a.pageId], [CLAIM]);
    const state = await derivationPurgeState(engine, REQ);
    const refused = await engine.upsertSegmentDerivations([
      // The purge rewrote this page: the row holding the claim is dropped and the stored one stays.
      row(a.pageId, 'links', a.occurrences[0]!, a0.sha256, { excerpt: 'Today ALICE likes   tea at noon' }),
      // No claim: stored. The claim in the receipt alone, on the rewritten page: dropped.
      row(a.pageId, 'links', a.occurrences[1]!, a1.sha256, { excerpt: 'unrelated' }),
      row(a.pageId, 'timeline', a.occurrences[1]!, a1.sha256, {}, { found: 'Alice likes tea' }),
      // A page the purge did not rewrite, its live segment backing the row: kept. Without a live segment behind it: dropped.
      row(b.pageId, 'links', b.occurrences[0]!, b0.sha256, { excerpt: 'Alice likes tea' }),
      row(b.pageId, 'timeline', b.occurrences[0]!, sha256('b segment gone'), { 'alice likes tea': true }),
    ]).then(() => null, (error: { code?: unknown; refused?: unknown }) => ({ code: error.code, refused: error.refused }));
    const label = (pageId: number) => pageId === a.pageId ? 'a' : 'b';
    const occurrences = [...a.occurrences, ...b.occurrences];
    const stored = async (pageId: number) => (await engine.readSegmentDerivations(pageId))
      .map(r => ({ page: label(pageId), kind: r.kind, occurrence: occurrences.indexOf(r.occurrenceId), output: r.output }));
    const rows = [...await stored(a.pageId), ...await stored(b.pageId)];
    expect(state).toEqual({ state: 'pending', reason: null });
    // The write stores what it may and then throws DerivationWriteRefused for the rows the sweep dropped.
    expect(refused).toEqual({ code: 'derivation_purge_pending', refused: 3 });
    expect(rows.map(r => `${r.page}:${r.kind}:${r.occurrence}`)).toEqual(['a:links:0', 'a:links:1', 'b:links:2']);
    expect(rows[0]!.output).toEqual({ excerpt: 'harmless' });
    return { state, refused, rows };
  });
  parityTest('a request id is one request in every spelling Postgres reads as a uuid, and text that is none refuses', {
    methods: ['transaction', 'readDerivationPurgeState', 'countPurgeProbe', 'setPurgeProbeTimeout', 'listDerivationClaimForms'],
    timeout: 120_000,
  }, async (engine) => {
    const plain = REQ4.replaceAll('-', '');
    const spellings = {
      canonical: REQ4, upper: REQ4.toUpperCase(), compact: plain, compactUpper: plain.toUpperCase(), braces: `{${REQ4}}`, bracesCompact: `{${plain}}`,
      groupsOfEight: `${plain.slice(0, 8)}-${plain.slice(8, 16)}-${plain.slice(16, 24)}-${plain.slice(24)}`, groupsOfFour: plain.match(/.{4}/g)!.join('-'),
    };
    await record(engine, spellings.braces, [4], [CLAIM]);
    const states: Record<string, unknown> = {};
    for (const [name, spelling] of Object.entries(spellings)) states[name] = await derivationPurgeState(engine, spelling);
    // Every spelling is the same request: a second record under any of them is a no-op.
    for (const spelling of Object.values(spellings)) await record(engine, spelling, [5], ['Zebra crossing']);
    const kept = { alice: await count(engine, ['alice likes tea']), zebra: await count(engine, ['zebra crossing']), bySource: await count(engine, [SRC]) };
    const bad = ['', 'not-a-uuid', REQ4.slice(1), `${REQ4}0`, `{${REQ4}`, `${REQ4}}`, ` ${REQ4}`, REQ4.replace('c4', 'cg')];
    const refused: Record<string, boolean> = {};
    for (const spelling of bad) {
      refused[spelling] = await record(engine, spelling, [1], [CLAIM]).then(() => false, () => true)
        && await derivationPurgeState(engine, spelling).then(() => false, () => true);
    }
    expect(Object.values(states)).toEqual(Object.values(states).map(() => ({ state: 'pending', reason: null })));
    expect(kept).toEqual({ alice: 1, zebra: 0, bySource: 1 });
    expect(Object.values(refused).every(Boolean)).toBe(true);
    return { states, kept, refused };
  });

  parityTest('a derivation write the sweep drops is dropped before the CHECK constraints and the conflict handling', {
    methods: ['transaction', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'upsertSegmentDerivations', 'readSegmentDerivations', 'listDerivationClaimForms'],
    timeout: 120_000,
  }, async (engine) => {
    const a0 = segmentText('# One\nfirst segment\n');
    const a = await publishSegmentedPage(engine, 'notes/drop-first', [a0]);
    const row = (output: unknown, version = 1) =>
      ({ pageId: a.pageId, kind: 'links' as const, occurrenceId: a.occurrences[0]!, version, segmentSha256: a0.sha256, contextHash: sha256('ctx'), state: 'done' as const, output, receipt: {} });
    await record(engine, REQ, [a.pageId], [CLAIM]);
    const outcome = (error: { code?: unknown; refused?: unknown }) => ({ code: error.code, refused: error.refused });
    // Two rows of one key: the first holds the claim and is dropped, the second is stored (no repeated-key refusal).
    const twice = await engine.upsertSegmentDerivations([row({ excerpt: 'Alice likes tea' }), row({ excerpt: 'harmless' })]).then(() => null, outcome);
    const afterTwice = (await engine.readSegmentDerivations(a.pageId)).map(r => r.output);
    // The same with the harmless row first: both reach the conflict handling, so the batch is refused as a whole.
    const repeated = await engine.upsertSegmentDerivations([row({ excerpt: 'again' }), row({ excerpt: 'and again' })]).then(() => 'stored', (error: { code?: unknown }) => typeof error.code);
    // A dropped row that would fail a CHECK (a negative version) is dropped, not refused as a check violation.
    const negative = await engine.upsertSegmentDerivations([row({ excerpt: 'Alice likes tea' }, -1)]).then(() => null, outcome);
    const afterNegative = (await engine.readSegmentDerivations(a.pageId)).map(r => r.output);
    expect(twice).toEqual({ code: 'derivation_purge_pending', refused: 1 });
    expect(afterTwice).toEqual([{ excerpt: 'harmless' }]);
    expect(negative).toEqual({ code: 'derivation_purge_pending', refused: 1 });
    return { twice, afterTwice, repeated, negative, afterNegative };
  });

  // A source delete cascades to the sweep records of the source (`page_segment_derivation_purges.source_id ... ON DELETE
  // CASCADE`): the deleted source's record goes, another source's stays.
  parityTest('a source delete removes the sweep records of that source and keeps the others', {
    methods: ['transaction', 'readDerivationPurgeState', 'deleteSourceRecord'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, 'doomed', {});
    await createSource(engine, backend, OTHER, {});
    await record(engine, REQ3, [], [CLAIM], 'doomed');
    await record(engine, REQ4, [], [CLAIM], OTHER);
    const before = { doomed: await derivationPurgeState(engine, REQ3), other: await derivationPurgeState(engine, REQ4) };
    const deleted = await engine.deleteSourceRecord('doomed');
    const after = { doomed: await derivationPurgeState(engine, REQ3), other: await derivationPurgeState(engine, REQ4) };
    const out = { before: { doomed: before.doomed?.state ?? null, other: before.other?.state ?? null }, deleted: !!deleted,
      after: { doomed: after.doomed?.state ?? null, other: after.other?.state ?? null } };
    expect(out).toEqual({ before: { doomed: 'pending', other: 'pending' }, deleted: true, after: { doomed: null, other: 'pending' } });
    return out;
  });
});
