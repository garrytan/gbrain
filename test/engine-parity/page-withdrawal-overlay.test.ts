/**
 * BrainEngine parity — the read-time withdrawal overlay of a page (fact_withdrawals over a facts fence).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a page read lists the page's withdrawals (subject '*' and the page's own slug, the earliest time per
 *    visibility and fingerprint) and shows each withdrawn fence row struck: an inline page in readPageSnapshot,
 *    getPage and readPageSnapshotsBatch, a segmented page segment by segment in the body range read and the chunks a
 *    restage builds (page-body/segment-ledger.ts overlaySegmentText). The same observable result on every engine arm.
 *  - Regression: an engine whose snapshot reports no withdrawals shows a forgotten claim again on every read, and in
 *    the chunks search serves; an overlay that reads its fence normalization through executeRaw stops the segmented
 *    read and the restage on an engine without raw SQL.
 *  - Why existing coverage misses it: the withdrawal parity file compares the ledger members only; the page parity
 *    cases read pages with an empty ledger, so the Rust store's empty `withdrawals` matched PGLite.
 *  - Seam: none. Real engines; the withdrawals are recorded with insertFactWithdrawal, the pages written with putPage
 *    and the segmented staging (as test/engine-parity/segmented-rewrite.test.ts does), fence rows private.
 */
import { describe, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { normalizeLoweredClaim } from '../../src/core/facts/withdrawal-schema.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { overlaySegmentText, readBodyLedger } from '../../src/core/page-body/segment-ledger.ts';
import { overlaidBoundedRows } from '../../src/core/page-window/bounded-lead.ts';
import { openSegmentedBody, readBodyRange } from '../../src/core/page-body/read-range.ts';
import { sealSegmentedPage, stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-05T10:00:00.250Z';

const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const row = (n: number, claim: string) => `| ${n} | ${claim} | preference | 1.0 | private | medium | 2026-01-01 |  | chat |  |`;
const FENCE = fence([row(1, 'Prefers the aisle seat'), row(2, 'Walks  to WORK'), row(3, 'Drinks green tea')]);

/** Withdraw row 2 for the page and row 3 for every subject, row 2 twice (the earliest time is kept per fingerprint). */
async function withdraw(engine: BrainEngine, slug: string) {
  await engine.insertFactWithdrawal('default', 'private', 'walks to work', slug, T2);
  await engine.insertFactWithdrawal('default', 'private', 'Walks to work.', '*', T1);
  await engine.insertFactWithdrawal('default', 'private', 'Drinks green tea', '*', T2);
  // Another page's subject and the other visibility never reach this page's fence rows.
  await engine.insertFactWithdrawal('default', 'private', 'Prefers the aisle seat', 'notes/other', T1);
  await engine.insertFactWithdrawal('default', 'world', 'Prefers the aisle seat', slug, T1);
}

/** A conversation page with the facts fence between two long halves, so the fence sits in one segment of many. */
const fencedBody = (seed: number) => `${conversationBody(640 * 1024, { seed })}\n\n## Facts\n\n${FENCE}\n\n` + conversationBody(640 * 1024, { seed: seed + 1 });

/** Stage `truth` as the segmented body of `slug` (segmented-rewrite.test.ts fencedPage). */
async function stageSegmented(engine: BrainEngine, slug: string, truth: string) {
  const existing = await engine.getPage(slug);
  const meta = { title: slug, type: 'note' as const, frontmatter: {}, page_kind: 'markdown' as const };
  const staged = await stageSegmentedImport(engine, { slug, sourceId: 'default', existing, policy: await readPageBodyPolicy(engine), baseRevision: null,
    page: { title: slug, type: 'note', compiled_truth: truth, timeline: '', frontmatter: {}, tags: [] }, chunking: { quarantined: false, corpusGeneration: null, tier: 'none' } });
  await engine.transaction(async tx => {
    if (existing) await tx.createVersion(slug, { sourceId: 'default' });
    const applied = await staged.apply(tx, meta, { mode: 'none', corpusGeneration: null });
    if (applied.complete) await sealSegmentedPage(tx, applied.pageId);
  });
  expect(await staged.afterCommit(engine)).toBe(true);
}

/** The fence lines of `text` (the overlay touches only them). */
const fenceLines = (text: string) => text.split('\n').filter(line => line.startsWith('| ') && /^\| \d+ \|/.test(line));

describe('engine parity: page withdrawal overlay', () => {
  parityTest('an inline page read lists its withdrawals and strikes the withdrawn fence rows in the snapshot, getPage and the batch read',
    { methods: ['insertFactWithdrawal', 'putPage', 'readPageSnapshot', 'getPage', 'readPageSnapshotsBatch'] },
    async (engine) => {
      const truth = `# Travel\n\nNotes.\n\n${FENCE}\n`;
      await engine.putPage('notes/inline', { type: 'note', title: 'Inline', compiled_truth: truth, timeline: `- 2026-01-02 met\n\n${fence([row(1, 'Drinks green tea')])}` });
      const before = await engine.readPageSnapshot('notes/inline', { sourceId: 'default' });
      await withdraw(engine, 'notes/inline');
      const snap = (await engine.readPageSnapshot('notes/inline', { sourceId: 'default' }))!;
      const page = (await engine.getPage('notes/inline'))!;
      const batch = await engine.readPageSnapshotsBatch([{ slug: 'notes/inline', sourceId: 'default' }]);
      const batched = batch.snapshots.get('default\u0000notes/inline')!;
      // The PGLite reference strikes rows 2 and 3 and leaves row 1: a read that overlays nothing fails here on every arm.
      expect(fenceLines(snap.page.compiled_truth)).not.toEqual(fenceLines(truth));
      return {
        before: before!.withdrawals,
        withdrawals: snap.withdrawals, globalPurges: snap.globalPurges ?? null,
        truth: fenceLines(snap.page.compiled_truth), timeline: fenceLines(snap.page.timeline),
        getPage: { truth: sha(page.compiled_truth), timeline: sha(page.timeline), same: page.compiled_truth === snap.page.compiled_truth },
        batch: { withdrawals: batched.withdrawals, truth: batched.page.compiled_truth === snap.page.compiled_truth, timeline: batched.page.timeline === snap.page.timeline },
      };
    });

  parityTest('a segmented page lists its withdrawals; the trusted body read strikes the withdrawn rows segment by segment and a restage of the page does not refuse',
    { methods: ['setConfig', 'insertFactWithdrawal', 'readPageSnapshot', 'getPage', 'getChunks', 'transaction', 'readSegmentedPageHead', 'readManifest', 'readSegmentTexts'],
      timeout: 600_000 },
    async (engine) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      await stageSegmented(engine, 'notes/segmented', fencedBody(21));
      await withdraw(engine, 'notes/segmented');
      const snap = (await engine.readPageSnapshot('notes/segmented', { sourceId: 'default' }))!;
      const page = (await engine.getPage('notes/segmented'))!;
      const body = await openSegmentedBody(engine, { pageId: page.id });
      const parts: Buffer[] = [];
      for await (const piece of readBodyRange(engine, { pageId: page.id, space: 'stored', start: 0, end: Infinity, audience: 'trusted', body })) parts.push(piece.bytes);
      const stored = Buffer.concat(parts).toString('utf8');
      // A restage reads the ledger of the stored page and overlays each segment before it chunks it.
      await stageSegmented(engine, 'notes/segmented', fencedBody(21) + '\n\nOne more line.\n');
      const chunks = await engine.getChunks('notes/segmented');
      expect(fenceLines(stored)).not.toEqual(fenceLines(FENCE));
      return {
        withdrawals: snap.withdrawals, globalPurges: snap.globalPurges ?? null, ledger: body.ledger,
        stored: { lines: fenceLines(stored), bytes: Buffer.byteLength(stored), sha: sha(stored) },
        chunks: { count: chunks.length, texts: sha(chunks.map(c => `${c.chunk_source}\0${c.chunk_text}`).join('\n')) },
      };
    });

  parityTest('the fence fold is the fact whitespace list on every read: a claim with U+0085 is struck, one that differs from a withdrawn claim only by U+1680 or U+00A0 is not',
    { methods: ['insertFactWithdrawal', 'putPage', 'readPageSnapshot', 'getPage', 'readPageSnapshotsBatch'] },
    async (engine) => {
      // FACT_SPACE_CLASS takes U+0085 (JavaScript's \s does not) and leaves U+1680 and U+00A0 (JavaScript's \s takes both).
      const truth = `# Habits\n\n${fence([row(1, 'Walks\u0085to work'), row(2, 'Drinks\u1680green tea'), row(3, 'Drinks\u00a0green tea'), row(4, 'Prefers the aisle seat')])}\n`;
      await engine.putPage('notes/fold', { type: 'note', title: 'Fold', compiled_truth: truth, timeline: '' });
      await engine.insertFactWithdrawal('default', 'private', 'Walks to work', 'notes/fold', T1);
      await engine.insertFactWithdrawal('default', 'private', 'Drinks green tea', 'notes/fold', T1);
      const snap = (await engine.readPageSnapshot('notes/fold', { sourceId: 'default' }))!;
      const page = (await engine.getPage('notes/fold'))!;
      const batched = (await engine.readPageSnapshotsBatch([{ slug: 'notes/fold', sourceId: 'default' }])).snapshots.get('default\u0000notes/fold')!;
      const forgotten = (text: string) => fenceLines(text).map(line => line.includes('forgotten:'));
      // Row 1 folds to the withdrawn claim and is struck; rows 2 and 3 are different claims and stay live.
      expect(forgotten(snap.page.compiled_truth)).toEqual([true, false, false, false]);
      expect(forgotten(page.compiled_truth)).toEqual([true, false, false, false]);
      expect(forgotten(batched.page.compiled_truth)).toEqual([true, false, false, false]);
      return { withdrawals: snap.withdrawals, truth: fenceLines(snap.page.compiled_truth), getPage: page.compiled_truth === snap.page.compiled_truth,
        batch: batched.page.compiled_truth === snap.page.compiled_truth };
    });

  parityTest('the fence fold lower-cases as the engine does: a withdrawn claim with U+0130 or a Greek capital sigma is struck in getPage, the snapshot and the batch read',
    { methods: ['insertFactWithdrawal', 'putPage', 'readPageSnapshot', 'getPage', 'readPageSnapshotsBatch'] },
    async (engine) => {
      // JavaScript's toLowerCase maps U+0130 to "i" + U+0307 and a final capital sigma to a final small sigma; the engines' own lower() decide the hash.
      const claims = ['\u0130stanbul trip', '\u039f\u03a3 Odysseus sails', 'Plain claim'];
      const truth = `# Names\n\n${fence(claims.map((claim, i) => row(i + 1, claim)))}\n`;
      await engine.putPage('notes/lower', { type: 'note', title: 'Lower', compiled_truth: truth, timeline: '' });
      await engine.insertFactWithdrawal('default', 'private', claims[0]!, 'notes/lower', T1);
      await engine.insertFactWithdrawal('default', 'private', claims[1]!, 'notes/lower', T1);
      const snap = (await engine.readPageSnapshot('notes/lower', { sourceId: 'default' }))!;
      const page = (await engine.getPage('notes/lower'))!;
      const batched = (await engine.readPageSnapshotsBatch([{ slug: 'notes/lower', sourceId: 'default' }])).snapshots.get('default\u0000notes/lower')!;
      const forgotten = (text: string) => fenceLines(text).map(line => line.includes('forgotten:'));
      expect(forgotten(snap.page.compiled_truth)).toEqual([true, true, false]);
      expect(forgotten(page.compiled_truth)).toEqual([true, true, false]);
      expect(forgotten(batched.page.compiled_truth)).toEqual([true, true, false]);
      return { withdrawals: snap.withdrawals, truth: fenceLines(snap.page.compiled_truth), getPage: page.compiled_truth === snap.page.compiled_truth,
        batch: batched.page.compiled_truth === snap.page.compiled_truth };
    });

  const PURGE_LEAD = `Intro prose.\n\n${fence([row(1, 'Drinks green tea'), row(2, 'Prefers the aisle seat'), row(3, 'Walks\u0085to work')])}\n\nClosing prose.`;
  const purgeHash = (claim: string) => sha(normalizeLoweredClaim(claim.toLowerCase()));

  parityTest('a source with a subject-* purge tombstone: a segmented page lead drops the purged claim and keeps the other, in the bounded lead and the segment overlay',
    { methods: ['insertFactPurge', 'insertFactWithdrawal', 'createSegmentedPageShell', 'readPageSnapshot', 'readPageSnapshotsBatch', 'normalizeFenceLines'] },
    async (engine) => {
      await engine.createSegmentedPageShell('notes/purged-lead', { type: 'note', title: 'Purged lead', frontmatter: {} }, { sourceId: 'default' });
      // The source purges one claim for every page (subject '*'); a second claim is withdrawn through the ledger, so both ledger forms are read.
      await engine.insertFactPurge({ sourceId: 'default', visibility: 'private', subject: '*', factHash: purgeHash('Drinks green tea'), requestId: null, actor: null, reason: null });
      await engine.insertFactWithdrawal('default', 'private', 'Walks to work', 'notes/purged-lead', T1);
      const snap = (await engine.readPageSnapshot('notes/purged-lead', { sourceId: 'default' }))!;
      expect(snap.globalPurges?.count).toBe(1);
      const [bounded] = await overlaidBoundedRows(engine, [{ slug: 'notes/purged-lead', source_id: 'default', compiled_truth: PURGE_LEAD }]);
      const ledger = await readBodyLedger(engine, 'default', 'notes/purged-lead');
      const segment = await overlaySegmentText(engine, ledger, { sourceId: 'default', byteStart: 0, entryState: null }, PURGE_LEAD, 'trusted');
      const lines = (text: string) => fenceLines(text).map(line => [line.includes('Drinks green tea'), line.includes('Prefers the aisle seat'), line.includes('forgotten:')]);
      // The purged row is gone; the unrelated row stays live; the withdrawn U+0085 row stays but struck.
      expect(lines(bounded!.compiled_truth)).toEqual([[false, true, false], [false, false, true]]);
      expect(segment).toBe(bounded!.compiled_truth);
      // The marker's `latest` is the purge's wall-clock time; the count and filter are what the read reports.
      return { withdrawals: snap.withdrawals, globalPurges: { count: snap.globalPurges!.count, world_only: snap.globalPurges!.world_only }, bounded: fenceLines(bounded!.compiled_truth), segment: sha(segment) };
    });
});
