/**
 * BrainEngine parity — the derivation sweep of a fact purge (src/core/page-body/segment-derive.ts `continueDerivationPurges`,
 * the raw-SQL walk that deletes the stored derivation results still holding a purged claim and then deletes the record).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a recorded sweep is walked in batches of `batchRows` rows of its source in (page, pipeline, occurrence) order.
 *    Each call deletes, from the rows its batch reads, those in the sweep's scope (a page the purge rewrote or deleted, or a row no
 *    live segment backs) that hold the claim (the output or the receipt, as whole words, normalized) and keeps the rest. The state
 *    stays `pending` while the walk goes on; a walk that reads fewer rows than a batch ends and a verify walk follows, repeated until
 *    one deletes nothing; then the record is deleted and the state reads null. The call returns the rows its first walk deleted
 *    (verify-walk deletions are not counted). A request named `first` is swept before the others, oldest first; another source's
 *    record is never walked. Every engine arm answers alike for the same rows: PGLite always, Postgres with DATABASE_URL, the Rust
 *    arm with GBRAIN_TEST_RUST_ARM=1. Where the arms differ is only what the Rust store has no equivalent of: a statement budget (a
 *    batch never times out, so no record stalls and none halves its batch), and a scope lock (no writer holds it, so no record waits
 *    on `scope_lock_busy`).
 *  - A page that enters the sweep's scope after the walk passed it (here: soft-deleted while the verify walk is past its row) is noted,
 *    and the end of the walk checks the noted pages again before the record is deleted: the row it still holds the claim in goes, and the
 *    record stays until that check passes.
 *    The same holds when the scope is entered by deleting a live published manifest row (a row published above the page's generation backs
 *    a derivation until `sweepSegments` removes it): the delete notes the page, whatever source the row names.
 *    While the noted pages are checked again the record shows them: the table probe finds the page ids of its `recheck` as `int[]` text.
 *  - Regression: the Rust store deleted the record at the end of a verify walk without that check, leaving a claim-holding row of a page
 *    deleted behind the walk and no write guard; before that, the sweep ran through raw SQL, so the Rust arm refused it and the record of a fact purge stayed `pending` for
 *    good, with the rows still holding the claim.
 *  - Why existing coverage misses it: the sweep's cases (test/helpers/derivation-purge-cases.ts) run on PGLite and Postgres only;
 *    the record parity cases (derivation-purge-record.test.ts) stop at recording it.
 *  - Seam: `continueDerivationPurges`, `recordDerivationPurge` and `derivationPurgeState` of page-body/segment-derive.ts, called with
 *    the arm's engine as the purge calls them, with the walk bounded to one batch per call (`totalMs` 0) of two rows. Derivation rows
 *    go through the typed `upsertSegmentDerivations`, read back through `readSegmentDerivations`; pages through the page-body fixtures.
 *    Generated page ids are named by label.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PurgeProbe } from '../../src/core/engine-sql/facts-purge-plan.ts';
import { boundedProbe } from '../../src/core/facts/purge-verify.ts';
import { __setDerivationSweepLimitsForTests, continueDerivationPurges, derivationPurgeState, recordDerivationPurge } from '../../src/core/page-body/segment-derive.ts';
import { manifestRow, publishSegmentedPage, segmentText, sha256 } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const OTHER = 'other';
const REQ = 'd0000000-0000-4000-8000-0000000000d1';
const REQ2 = 'd0000000-0000-4000-8000-0000000000d2';
const REQ3 = 'd0000000-0000-4000-8000-0000000000d3';
const CLAIM = 'Alice likes tea';
const OTHER_CLAIM = 'Bob owns a boat';

const TABLE = 'page_segment_derivation_purges';

/** The count the table probe finds in the sweep records (a needle in any text column of them), or the way it was left unverified. */
async function count(engine: BrainEngine, needles: readonly string[]): Promise<number | string> {
  const probe: PurgeProbe = { kind: 'table', table: TABLE, sourceId: SRC, needles };
  const result = await boundedProbe(engine, probe, performance.now() + 60_000);
  return 'unverified' in result ? result.unverified : result.count;
}

type Kind = 'links' | 'timeline';
const row = (pageId: number, kind: Kind, occurrenceId: number, segmentSha256: ReturnType<typeof sha256>, output: unknown, receipt: unknown = {}) =>
  ({ pageId, kind, occurrenceId, version: 1, segmentSha256, contextHash: sha256(`ctx:${kind}`), state: 'done' as const, output, receipt });

/** One sweep call per step, bounded to one batch of two rows: what it deleted and the state it left. */
async function sweep(engine: BrainEngine, sourceId: string, first: string, until: string[]): Promise<Array<{ deleted: number; states: Array<unknown> }>> {
  const steps: Array<{ deleted: number; states: Array<unknown> }> = [];
  __setDerivationSweepLimitsForTests({ batchRows: 2, totalMs: 0 });
  try {
    for (let call = 0; call < 40; call++) {
      const deleted = await continueDerivationPurges(engine, sourceId, { first });
      const states = [];
      for (const request of until) states.push(await derivationPurgeState(engine, request));
      steps.push({ deleted, states });
      if (states.every(state => state === null)) break;
    }
  } finally {
    __setDerivationSweepLimitsForTests(null);
  }
  return steps;
}

describe('engine parity: the derivation sweep of a fact purge', () => {
  parityTest('a sweep walks its batches, deletes the swept rows that hold the claim, keeps the others and ends with its record deleted', {
    methods: ['transaction', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'upsertSegmentDerivations', 'readSegmentDerivations', 'readDerivationPurgeState', 'recordDerivationPurgeRow', 'listDerivationClaimForms', 'continueDerivationSweep'],
    timeout: 120_000,
  }, async (engine) => {
    const a = [segmentText('# One\nfirst segment\n'), segmentText('## Two\nsecond segment\n'), segmentText('## Three\nthird segment\n')];
    const b = [segmentText('# Other\nanother page\n')];
    const pa = await publishSegmentedPage(engine, 'notes/sweep-a', a);
    const pb = await publishSegmentedPage(engine, 'notes/sweep-b', b);
    await engine.upsertSegmentDerivations([
      // Page a, which the purge rewrote: every row that holds the claim goes, in the output or the receipt; the harmless row stays.
      row(pa.pageId, 'links', pa.occurrences[0]!, a[0]!.sha256, { excerpt: 'Today ALICE likes   tea at noon' }),
      row(pa.pageId, 'links', pa.occurrences[1]!, a[1]!.sha256, { excerpt: 'unrelated' }),
      row(pa.pageId, 'timeline', pa.occurrences[0]!, a[0]!.sha256, {}, { found: 'Alice likes tea' }),
      row(pa.pageId, 'timeline', pa.occurrences[2]!, a[2]!.sha256, { 'alice likes tea': true }),
      // Page b, which the purge did not rewrite: a row its live segment backs is kept even holding the claim; one no live segment backs goes.
      row(pb.pageId, 'links', pb.occurrences[0]!, b[0]!.sha256, { excerpt: 'Alice likes tea' }),
      row(pb.pageId, 'timeline', pb.occurrences[0]!, sha256('b segment gone'), { excerpt: 'Alice likes tea' }),
    ]);
    await engine.transaction(tx => recordDerivationPurge(tx, REQ, SRC, [pa.pageId], [CLAIM]));
    const before = await derivationPurgeState(engine, REQ);
    const steps = await sweep(engine, SRC, REQ, [REQ]);
    const label = (pageId: number) => pageId === pa.pageId ? 'a' : 'b';
    const occurrences = [...pa.occurrences, ...pb.occurrences];
    const kept = [];
    for (const pageId of [pa.pageId, pb.pageId]) {
      for (const r of await engine.readSegmentDerivations(pageId)) kept.push(`${label(pageId)}:${r.kind}:${occurrences.indexOf(r.occurrenceId)}`);
    }
    // The member itself, with the call's bounds as the sweep gives it: nothing left to walk, nothing deleted.
    const idle = await engine.continueDerivationSweep(SRC, {}, { batchRows: 2, totalMs: 0, statementMs: 5_000, inlineMs: 5_000, finalizeWaitMs: 1_500 });
    expect(idle).toEqual({ deleted: 0, work: [] });
    expect(before).toEqual({ state: 'pending', reason: null });
    expect(steps.at(-1)!.states).toEqual([null]);
    expect(steps.slice(0, -1).every(step => (step.states[0] as { state: string }).state === 'pending')).toBe(true);
    expect(steps.reduce((n, step) => n + step.deleted, 0)).toBe(4);
    expect(kept.sort()).toEqual(['a:links:1', 'b:links:3']);
    return { before, steps, kept: kept.sort(), idle };
  });

  parityTest('the request named first is swept first, then the others oldest first, and a record of another source is never walked', {
    methods: ['transaction', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'upsertSegmentDerivations', 'readSegmentDerivations', 'readDerivationPurgeState', 'recordDerivationPurgeRow', 'listDerivationClaimForms', 'continueDerivationSweep'],
    timeout: 120_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, OTHER);
    const a = [segmentText('# One\nfirst segment\n')];
    const b = [segmentText('# Two\nsecond segment\n')];
    const c = [segmentText('# Three\nthird segment\n')];
    const pa = await publishSegmentedPage(engine, 'notes/order-a', a);
    const pb = await publishSegmentedPage(engine, 'notes/order-b', b);
    const pc = await publishSegmentedPage(engine, 'notes/order-c', c, { sourceId: OTHER });
    await engine.upsertSegmentDerivations([
      row(pa.pageId, 'links', pa.occurrences[0]!, a[0]!.sha256, { excerpt: 'Alice likes tea' }),
      row(pb.pageId, 'links', pb.occurrences[0]!, b[0]!.sha256, { excerpt: 'Bob owns a boat' }),
      row(pc.pageId, 'links', pc.occurrences[0]!, c[0]!.sha256, { excerpt: 'Alice likes tea' }),
    ]);
    await engine.transaction(tx => recordDerivationPurge(tx, REQ, SRC, [pa.pageId], [CLAIM]));
    await engine.transaction(tx => recordDerivationPurge(tx, REQ2, SRC, [pb.pageId], [OTHER_CLAIM]));
    await engine.transaction(tx => recordDerivationPurge(tx, REQ3, OTHER, [pc.pageId], [CLAIM]));
    // One batch per call; REQ2 is swept first although REQ is older.
    __setDerivationSweepLimitsForTests({ batchRows: 2, totalMs: 0 });
    const firstCall = await continueDerivationPurges(engine, SRC, { first: REQ2 }).finally(() => __setDerivationSweepLimitsForTests(null));
    const afterFirst = { deleted: firstCall, states: [await derivationPurgeState(engine, REQ), await derivationPurgeState(engine, REQ2), await derivationPurgeState(engine, REQ3)],
      a: (await engine.readSegmentDerivations(pa.pageId)).length, b: (await engine.readSegmentDerivations(pb.pageId)).length };
    const steps = await sweep(engine, SRC, REQ, [REQ, REQ2]);
    const end = { states: [await derivationPurgeState(engine, REQ), await derivationPurgeState(engine, REQ2), await derivationPurgeState(engine, REQ3)],
      a: (await engine.readSegmentDerivations(pa.pageId)).length, b: (await engine.readSegmentDerivations(pb.pageId)).length, c: (await engine.readSegmentDerivations(pc.pageId)).length };
    expect(end).toEqual({ states: [null, null, { state: 'pending', reason: null }], a: 0, b: 0, c: 1 });
    return { afterFirst, steps, end };
  });

  parityTest('a page soft-deleted behind the verify walk is checked again before the record is deleted: its claim-holding row goes first', {
    methods: ['transaction', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'upsertSegmentDerivations', 'readSegmentDerivations', 'readDerivationPurgeState', 'recordDerivationPurgeRow', 'listDerivationClaimForms',
      'softDeletePage', 'countPurgeProbe', 'setPurgeProbeTimeout'],
    timeout: 120_000,
  }, async (engine) => {
    const a = [segmentText('# One\nfirst segment\n')];
    const pa = await publishSegmentedPage(engine, 'notes/behind-a', a);
    // A row its live segment backs on a page the purge did not rewrite: out of scope, so the walk keeps it while it holds the claim.
    await engine.upsertSegmentDerivations([row(pa.pageId, 'links', pa.occurrences[0]!, a[0]!.sha256, { excerpt: 'Alice likes tea' })]);
    await engine.transaction(tx => recordDerivationPurge(tx, REQ, SRC, [], [CLAIM]));
    const steps: Array<{ call: number; deleted: number; state: unknown; rows: number }> = [];
    const probes: Record<string, number | string> = {};
    __setDerivationSweepLimitsForTests({ batchRows: 1, totalMs: 0 });
    try {
      for (let call = 1; call <= 12; call++) {
        // Calls 1 and 2 walk the first walk (the row, then the end); call 3 is the verify walk reading the row, which it keeps.
        // The page is deleted after it, so the row enters the scope behind the walk, whose next batch finds the end.
        if (call === 4) await engine.softDeletePage('notes/behind-a');
        const deleted = await continueDerivationPurges(engine, SRC, { first: REQ });
        const state = await derivationPurgeState(engine, REQ);
        steps.push({ call, deleted, state, rows: (await engine.readSegmentDerivations(pa.pageId)).length });
        // The noted page is being checked again: the record's `recheck` holds its id, as `int[]` prints it.
        if (call === 4) probes.during = await count(engine, [`{${pa.pageId}}`]);
        if (state === null) break;
      }
    } finally {
      __setDerivationSweepLimitsForTests(null);
    }
    probes.after = await count(engine, [`{${pa.pageId}}`]);
    expect(probes).toEqual({ during: 1, after: 0 });
    // The record ends only after the noted page was checked again, and by then the row is gone.
    expect(steps.at(-1)).toMatchObject({ state: null, rows: 0 });
    expect(steps.reduce((n, step) => n + step.deleted, 0)).toBe(0);
    expect(steps.slice(0, -1).every(step => (step.state as { state: string }).state === 'pending')).toBe(true);
    return { steps, probes };
  });

  parityTest('a live manifest row deleted behind the verify walk (sweepSegments) notes its page: the derivation it backed is checked again before the record is deleted', {
    methods: ['transaction', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts', 'stageManifestRows', 'flipBodyGeneration',
      'setBodyStagingState', 'upsertSegmentDerivations', 'readSegmentDerivations', 'readDerivationPurgeState', 'recordDerivationPurgeRow', 'listDerivationClaimForms',
      'sweepSegments', 'readManifest'],
    timeout: 120_000,
  }, async (engine) => {
    const a = [segmentText('# One\nfirst segment\n')];
    const future = segmentText('# Future\na row above the page generation\n');
    const pa = await publishSegmentedPage(engine, 'notes/future-a', a);
    // A published row (no staging) above the page's generation: no read of the page sees it, but the sweep's scope counts it as backing a
    // derivation of its occurrence, so the walk keeps a claim-holding row it backs. Sweeping the segments deletes it.
    const [occurrence] = await engine.allocateBodyOccurrenceIds(1);
    await engine.stageSegmentTexts(SRC, [future]);
    await engine.stageManifestRows([manifestRow({ pageId: pa.pageId, occurrenceId: occurrence!, genFrom: 7, seq: 40, text: future, byteStart: 500, stagingId: null })]);
    await engine.upsertSegmentDerivations([row(pa.pageId, 'links', occurrence!, future.sha256, { excerpt: 'Alice likes tea' })]);
    await engine.transaction(tx => recordDerivationPurge(tx, REQ, SRC, [], [CLAIM]));
    const steps: Array<{ call: number; deleted: number; state: unknown; rows: number; manifest: number }> = [];
    let swept: unknown = null;
    __setDerivationSweepLimitsForTests({ batchRows: 1, totalMs: 0 });
    try {
      for (let call = 1; call <= 12; call++) {
        // Calls 1 and 2 are the first walk (the row, then the end); call 3 is the verify walk reading the row, which the future row backs.
        // The future row is swept after it, so the row loses its backing behind the walk, whose next batch finds the end.
        if (call === 4) swept = await engine.sweepSegments({ sourceId: SRC, graceMs: 0 });
        const deleted = await continueDerivationPurges(engine, SRC, { first: REQ });
        const state = await derivationPurgeState(engine, REQ);
        steps.push({ call, deleted, state, rows: (await engine.readSegmentDerivations(pa.pageId)).length, manifest: (await engine.readManifest(pa.pageId, { generation: 7 })).length });
        if (state === null) break;
      }
    } finally {
      __setDerivationSweepLimitsForTests(null);
    }
    expect(steps.at(-1)).toMatchObject({ state: null, rows: 0 });
    expect(steps.slice(0, -1).every(step => (step.state as { state: string }).state === 'pending')).toBe(true);
    return { steps, swept };
  });
});
