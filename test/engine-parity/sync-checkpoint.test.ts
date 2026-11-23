/**
 * BrainEngine parity: the managed sync checkpoint (`advanceSyncCheckpoint`, engine-sql/sources.ts), the statement
 * src/core/persistence/sync-prepare.ts sends when a managed Git sync publishes (applyPassCheckpoint's pass stamp and a
 * run's final checkpoint).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the checkpoint advances only the source of the run's incarnation whose `last_commit` is still the
 *    run's `from` (or already the target, when the run accepts that); it sets `last_commit`, `last_sync_at`,
 *    `newest_content_at` (the newest `updated_at` of the source's live pages, or null) and `config.slug_root_mode`.
 *    A source that pins another slug mode refuses unless the run keeps the pinned mode (an empty scope), and then
 *    the pinned mode stays. A refused checkpoint changes nothing and reports the pinned mode that refused it.
 *  - Regression: the checkpoint ran as raw SQL, so a managed Git sync on a Rust brain stopped at it; an engine that
 *    advances a moved checkpoint or another incarnation, counts a soft-deleted page, or overwrites a pinned slug mode
 *    corrupts the sync anchor.
 *  - Why existing coverage misses it: the sync-prepare tests run on PGLite only, through raw SQL.
 *  - Seam: none. Real engines; the source row is made through the harness fixture; times are compared to the
 *    engine's own page times, never to a clock value.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string) => ({ type: 'note', title, compiled_truth: `${title} body.`, timeline: '', frontmatter: {} }) as Parameters<BrainEngine['putPage']>[1];

async function view(engine: BrainEngine, sourceId: string) {
  const source = await engine.getSource(sourceId);
  const record = (await engine.listSourceRecords()).find(r => r.id === sourceId);
  const newest = record?.newest_content_at;
  return {
    lastCommit: source?.last_commit ?? null,
    synced: source?.last_sync_at instanceof Date,
    mode: (source?.config as Record<string, unknown> | undefined)?.slug_root_mode ?? null,
    newestMs: newest === null || newest === undefined ? null : new Date(newest).getTime(),
  };
}

describe('engine parity: the managed sync checkpoint', () => {
  parityTest('advanceSyncCheckpoint moves only a checkpoint still at the run\'s from, sets the anchor fields, and keeps or refuses a pinned slug mode',
    { methods: ['advanceSyncCheckpoint', 'getSource', 'listSourceRecords', 'readSourceMembership', 'putPage', 'getPage', 'softDeletePage', 'updateSourceConfig'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo-a', {}, '/srv/brain/repo-a');
      const incarnation = (await engine.readSourceMembership('repo-a'))!.incarnation;
      await engine.putPage('notes/one', page('One'), { sourceId: 'repo-a' });
      await engine.putPage('notes/two', page('Two'), { sourceId: 'repo-a' });
      await engine.softDeletePage('notes/two', { sourceId: 'repo-a' });
      const liveMs = (await engine.getPage('notes/one', { sourceId: 'repo-a' } as never))!.updated_at.getTime();
      const run = (over: Partial<Parameters<BrainEngine['advanceSyncCheckpoint']>[0]>) => engine.advanceSyncCheckpoint({
        sourceId: 'repo-a', incarnation, commit: 'c1', from: null, acceptAtCommit: true, slugMode: 'git-root', keepPinnedSlugMode: false, ...over,
      });
      const steps: Record<string, unknown> = {};
      // The first checkpoint of a fresh source: from is null.
      steps.first = await run({});
      steps.afterFirst = await view(engine, 'repo-a');
      // A run that started from another commit finds the checkpoint moved, and changes nothing.
      steps.moved = await run({ commit: 'c2', from: 'c0', acceptAtCommit: false });
      // An overtaken run accepts a checkpoint already at its target, only when it says so.
      steps.atTargetRefused = await run({ commit: 'c1', from: 'c0', acceptAtCommit: false });
      steps.atTargetAccepted = await run({ commit: 'c1', from: 'c0', acceptAtCommit: true });
      // Another incarnation changes nothing.
      steps.otherIncarnation = await run({ incarnation: 'f0000000-0000-4000-8000-000000000000', commit: 'c3', from: 'c1' });
      steps.afterRefusals = await view(engine, 'repo-a');
      // A source that pins another slug mode refuses a run under a different mode, and reports the pinned mode.
      await engine.updateSourceConfig('repo-a', { slug_root_mode: 'source-root' });
      steps.pinnedRefused = await run({ commit: 'c4', from: 'c1' });
      // An empty scope keeps the pinned mode and advances.
      steps.pinnedKept = await run({ commit: 'c4', from: 'c1', keepPinnedSlugMode: true });
      steps.afterPinned = await view(engine, 'repo-a');
      const out: Record<string, unknown> = { ...steps, liveIsNewest: (steps.afterFirst as { newestMs: number | null }).newestMs === liveMs };
      expect(out).toEqual({
        first: { advanced: true, pinnedSlugMode: null },
        afterFirst: { lastCommit: 'c1', synced: true, mode: 'git-root', newestMs: liveMs },
        moved: { advanced: false, pinnedSlugMode: null },
        atTargetRefused: { advanced: false, pinnedSlugMode: null },
        atTargetAccepted: { advanced: true, pinnedSlugMode: null },
        otherIncarnation: { advanced: false, pinnedSlugMode: null },
        afterRefusals: { lastCommit: 'c1', synced: true, mode: 'git-root', newestMs: liveMs },
        pinnedRefused: { advanced: false, pinnedSlugMode: 'source-root' },
        pinnedKept: { advanced: true, pinnedSlugMode: null },
        afterPinned: { lastCommit: 'c4', synced: true, mode: 'source-root', newestMs: liveMs },
        liveIsNewest: true,
      });
      return { ...out, afterFirst: { ...steps.afterFirst as object, newestMs: 'live page' }, afterRefusals: 'same', afterPinned: { lastCommit: 'c4', mode: 'source-root' } };
    });

  parityTest('advanceSyncCheckpoint on a source with no live page clears newest_content_at, and a malformed incarnation is refused',
    { methods: ['advanceSyncCheckpoint', 'getSource', 'listSourceRecords', 'readSourceMembership'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'repo-b', {}, '/srv/brain/repo-b');
      const incarnation = (await engine.readSourceMembership('repo-b'))!.incarnation;
      const base = { sourceId: 'repo-b', incarnation, commit: 'c1', from: null, acceptAtCommit: false, slugMode: 'source-root', keepPinnedSlugMode: false };
      const advanced = await engine.advanceSyncCheckpoint(base);
      const after = await view(engine, 'repo-b');
      const malformed = await engine.advanceSyncCheckpoint({ ...base, incarnation: 'not-a-uuid' }).then(() => 'answered', (e: { code?: string }) =>
        e?.code === 'invalid_argument' || e?.code === '22P02' ? 'refused' : `other: ${String(e)}`);
      const unknown = await engine.advanceSyncCheckpoint({ ...base, sourceId: 'no-such-source' });
      const out = { advanced, after, malformed, unknown };
      expect(out).toEqual({
        advanced: { advanced: true, pinnedSlugMode: null },
        after: { lastCommit: 'c1', synced: true, mode: 'source-root', newestMs: null },
        malformed: 'refused',
        unknown: { advanced: false, pinnedSlugMode: null },
      });
      return out;
    });
});
