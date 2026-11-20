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
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
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
});
