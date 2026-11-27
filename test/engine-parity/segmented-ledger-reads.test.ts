/**
 * BrainEngine parity — the page reads of a segmented page whose source holds a fact withdrawal or a source-wide purge.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: getPage, readPageSnapshot and readPageSnapshotsBatch answer a segmented page whose source has a withdrawal
 *    (subject the page) or a source-wide fact purge (subject '*') the same way they answer one with no ledger rows: the
 *    page and its ledger rows, never a refusal. The withdrawal overlay strikes fence rows of a whole body only, so a
 *    segmented page (no whole body) is returned as stored. The seal paths behave as on a page with no ledger rows:
 *    sealChunks refuses a segmented page (its projection comes from its segments) and sealSegmentedPage seals it.
 *  - Regression: the Rust overlay (rust-engine/snapshot-overlay.ts) fingerprinted `page.compiled_truth` before it checked
 *    the page was segmented. A segmented page's body getters throw `page_body_segmented`, so on a Rust brain every read
 *    of such a page refused as soon as its source held one withdrawal or one '*' purge. PGLite and Postgres fingerprint
 *    the stored columns in SQL and never touch the guarded getter.
 *  - Why existing coverage misses it: segmented-body.test.ts and chunk-page-segmented.test.ts read segmented pages with
 *    an empty ledger, and the withdrawal and purge parity files read inline pages only. rust-engine-withdrawn-lead.test.ts
 *    crosses the Rust snapshot but runs on Rust alone.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Page } from '../../src/core/types.ts';
import type { PageSnapshot } from '../../src/core/page-state/types.ts';
import { pageSnapshotKey } from '../../src/core/page-snapshot-batch.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { publishSegmentedPage, segmentText } from '../helpers/page-body-fixtures.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const TEXTS = [segmentText('# Intro\nfirst segment of the page\n'), segmentText('## End\nsecond segment of the page\n')];

/**
 * Two segmented pages, each in its own source so each ledger row stands alone: `notes/withdrawn` in `default` with a
 * withdrawal under its slug, and `notes/purged` in `other`, whose source has a world fact purge under subject '*'.
 */
const PAGES = [
  { slug: 'notes/withdrawn', sourceId: 'default' },
  { slug: 'notes/purged', sourceId: 'other' },
] as const;

async function segmentedPagesWithLedger(engine: BrainEngine, backend: ParityBackend): Promise<number[]> {
  await createSource(engine, backend, 'other');
  const ids: number[] = [];
  for (const { slug, sourceId } of PAGES) ids.push((await publishSegmentedPage(engine, slug, TEXTS, { sourceId })).pageId);
  expect(await engine.insertFactWithdrawal('default', 'world', 'Withdrawn world claim about the page', 'notes/withdrawn', null)).toBe(true);
  expect(await engine.insertFactPurge({ sourceId: 'other', visibility: 'world', subject: '*', factHash: 'ffff',
    requestId: null, actor: null, reason: null })).toBe(true);
  return ids;
}

/** The page fields every arm answers alike; a segmented page's body getters are never read. */
function pageView(page: Page | null) {
  return page === null ? null : { slug: page.slug, source_id: page.source_id, body_storage: page.body_storage ?? null,
    body_bytes: Number(page.body_bytes ?? 0), title: page.title };
}

function snapshotView(snapshot: PageSnapshot | null | undefined) {
  if (!snapshot) return null;
  return {
    page: pageView(snapshot.page),
    withdrawals: snapshot.withdrawals.map((w) => ({ visibility: w.visibility, fact_hash: w.fact_hash, purged: w.purged === true })),
    globalPurges: snapshot.globalPurges?.count ?? 0,
  };
}

const segmented = (views: ReadonlyArray<{ body_storage: string | null } | null | undefined>) => views.map((v) => v?.body_storage ?? null);

describe('engine parity: reads of a segmented page whose source holds a withdrawal or a source-wide purge', () => {
  parityTest('getPage returns a segmented page whose source holds a withdrawal or a source-wide purge',
    { methods: ['getPage', 'insertFactWithdrawal', 'insertFactPurge'] }, async (engine, backend) => {
      await segmentedPagesWithLedger(engine, backend);
      const pages = [];
      for (const { slug, sourceId } of PAGES) pages.push(pageView(await engine.getPage(slug, { sourceId })));
      expect(segmented(pages)).toEqual(['segmented', 'segmented']);
      return pages;
    });

  parityTest('readPageSnapshot returns a segmented page and its ledger rows when its source holds a withdrawal or a source-wide purge',
    { methods: ['readPageSnapshot', 'insertFactWithdrawal', 'insertFactPurge'] }, async (engine, backend) => {
      await segmentedPagesWithLedger(engine, backend);
      const snapshots = [];
      for (const { slug, sourceId } of PAGES) snapshots.push(snapshotView(await engine.readPageSnapshot(slug, { sourceId })));
      expect(segmented(snapshots.map((s) => s?.page))).toEqual(['segmented', 'segmented']);
      expect(snapshots[0]!.withdrawals.map((w) => w.visibility)).toEqual(['world']);
      expect(snapshots[1]!.globalPurges).toBe(1);
      return snapshots;
    });

  parityTest('readPageSnapshotsBatch returns a segmented page and its ledger rows when its source holds a withdrawal or a source-wide purge',
    { methods: ['readPageSnapshotsBatch', 'insertFactWithdrawal', 'insertFactPurge'] }, async (engine, backend) => {
      await segmentedPagesWithLedger(engine, backend);
      const batch = await engine.readPageSnapshotsBatch(PAGES.map(({ slug, sourceId }) => ({ slug, sourceId })));
      const snapshots = PAGES.map(({ slug, sourceId }) => snapshotView(batch.snapshots.get(pageSnapshotKey(sourceId, slug))));
      expect(segmented(snapshots.map((s) => s?.page))).toEqual(['segmented', 'segmented']);
      return { covered: batch.covered, snapshots };
    });

  parityTest('sealChunks refuses a segmented page whose source holds a withdrawal or a source-wide purge, as it does with none',
    { methods: ['sealChunks', 'insertFactWithdrawal', 'insertFactPurge'] }, async (engine, backend) => {
      await segmentedPagesWithLedger(engine, backend);
      const refusals = [];
      for (const { slug, sourceId } of PAGES) {
        const error = await engine.sealChunks(slug, [], { sourceId }).then(() => null, (e: unknown) => e);
        const message = error instanceof Error ? error.message : String(error);
        refusals.push({ refused: error !== null, segmented: /sealChunks refuses segmented page/.test(message) });
      }
      expect(refusals).toEqual([{ refused: true, segmented: true }, { refused: true, segmented: true }]);
      return refusals;
    });

  parityTest('sealSegmentedPage seals a segmented page whose source holds a withdrawal or a source-wide purge',
    { methods: ['sealSegmentedPage', 'getPage', 'insertFactWithdrawal', 'insertFactPurge'] }, async (engine, backend) => {
      const ids = await segmentedPagesWithLedger(engine, backend);
      for (const id of ids) await engine.sealSegmentedPage(id);
      const pages = [];
      for (const { slug, sourceId } of PAGES) pages.push(pageView(await engine.getPage(slug, { sourceId })));
      expect(segmented(pages)).toEqual(['segmented', 'segmented']);
      return pages;
    });
});
