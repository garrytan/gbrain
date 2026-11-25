/**
 * BrainEngine parity — the pending stamp of a segment chunk written without a vector (engine-sql/page-body.ts, the
 * `stageSegmentChunks` insert: `embedding_pending_since = CASE WHEN embedding IS NULL THEN now() ELSE NULL END`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after a segmented write, every chunk with no vector is pending with a pending-since stamp:
 *    `readEmbeddingStateCounts` reports the chunks as `pending` and none as `unstamped_pending`, so the doctor backlog
 *    age (schema-health `readBacklogAge`) and `gbrain sync` pending (`readEmbedBacklog`) can age the backlog.
 *  - Regression: the Rust store wrote a segment chunk with no vector and no stamp, so on a Rust brain every new
 *    segment chunk counted as `unstamped_pending` (written by an old binary), while PGLite and Postgres stamped it.
 *  - Why existing coverage misses it: test/engine-parity/chunks.test.ts reads the counts after `upsertChunks`, which
 *    stamps on every arm; no case reads them after a segmented write.
 *  - Seam: the page is written through the string import's staging, as in segmented-embedding.test.ts. The two
 *    backlog readers run raw SQL, so that case runs on the SQL arms and stops on the Rust arm's typed raw_sql refusal.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { sealSegmentedPage, stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { readEmbedBacklog } from '../../src/core/sync-pending.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

/** Write `truth` as the segmented body of `slug` through the string import's staging (see segmented-rewrite.test.ts). */
async function stagedPage(engine: BrainEngine, slug: string, truth: string) {
  const existing = await engine.getPage(slug);
  const meta = { title: slug, type: 'note' as const, frontmatter: {}, page_kind: 'markdown' as const };
  const staged = await stageSegmentedImport(engine, { slug, sourceId: 'default', existing, policy: await readPageBodyPolicy(engine), baseRevision: null,
    page: { title: slug, type: 'note', compiled_truth: truth, timeline: '', frontmatter: {}, tags: [] }, chunking: { quarantined: false, corpusGeneration: null, tier: 'none' } });
  await engine.transaction(async tx => {
    const applied = await staged.apply(tx, meta, { mode: 'none', corpusGeneration: null });
    if (applied.complete) await sealSegmentedPage(tx, applied.pageId);
  });
  expect(await staged.afterCommit(engine)).toBe(true);
}

describe('engine parity: the pending stamp of a segment chunk', () => {
  parityTest('a segment chunk written without a vector is pending with a stamp, never unstamped',
    { methods: ['setConfig', 'getPage', 'transaction', 'stageSegmentChunks', 'readEmbeddingStateCounts', 'listEmbeddingStateRows'], timeout: 600_000 },
    async (engine) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      await stagedPage(engine, 'notes/pending-stamp', conversationBody(1300 * 1024, { seed: 61 }));
      const full = await engine.readEmbeddingStateCounts({ mode: 'full', purgeWindowHours: 72 });
      const pending = full.counts.pending ?? 0;
      expect(pending).toBeGreaterThan(1);
      expect({ unstamped_pending: full.unstamped_pending, unstamped_created_at_min: full.unstamped_created_at_min })
        .toEqual({ unstamped_pending: 0, unstamped_created_at_min: null });
      const rows = await engine.listEmbeddingStateRows({ states: ['pending'], limit: 10, purgeWindowHours: 72 });
      expect(rows.map((r) => `${r.slug}:${r.state}:${r.chunks}`)).toEqual([`notes/pending-stamp:pending:${pending}`]);
      return { pending, unstamped_pending: full.unstamped_pending, rows: rows.map((r) => `${r.slug}:${r.state}:${r.chunks}`) };
    });

  parityTest('the sync and doctor backlog readers age a segmented page\'s pending chunks',
    { methods: ['setConfig', 'getPage', 'transaction', 'stageSegmentChunks', 'executeRaw'], requires: 'raw_sql', timeout: 600_000 },
    async (engine) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      await stagedPage(engine, 'notes/pending-age', conversationBody(1300 * 1024, { seed: 62 }));
      const backlog = (await readEmbedBacklog(engine, ['default'])).get('default')!;
      expect(backlog.state).toBe('behind');
      expect(backlog.oldest_pending_since).not.toBeNull();
      const [row] = await engine.executeRaw<{ unaged: number }>(
        `SELECT count(*) FILTER (WHERE embedding_pending_since IS NULL)::int AS unaged FROM content_chunks WHERE embedding IS NULL`);
      expect(Number(row!.unaged)).toBe(0);
      return { state: backlog.state, pending: backlog.pending_chunks > 1, aged: backlog.age_seconds !== null, unaged: Number(row!.unaged) };
    });
});
