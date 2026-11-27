/**
 * Parity for the managed sync checkpoint as its two publications send it (persistence/sync-prepare.ts
 * `advanceManagedCheckpoint`: the pass stamp, `publishPassStamp`, and a run's final checkpoint, `applyManagedSyncCheckpoint`),
 * inside the coordinated-write transaction those publications run in.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the step advances the checkpoint of the run's incarnation only while `last_commit` is still the run's `from` (or
 *    already the target when the run accepts that: every pass stamp, and an overtaken run), answers whether it advanced,
 *    and names a pinned slug mode that refused it (not read when the run keeps the pinned mode). A slice short of its
 *    target re-stamps the checkpoint at `from`, a first sync's included (from and commit null).
 *  - Regression: both publications sent the checkpoint as raw SQL, which the Rust engine refuses, so a managed sync's
 *    checkpoint failed on a Rust brain. The step now calls `advanceSyncCheckpoint` (engine-sql/sources.ts).
 *  - Why existing coverage misses it: sync-checkpoint.test.ts covers the member alone; the managed sync suites run PGLite
 *    and Postgres only, and a Rust brain's managed sync refuses by name before it reaches the checkpoint (capability
 *    managed_persistence, B2; the whole managed sync case in sync-stamp.test.ts pins that stop).
 *  - Seam: the case calls the step the publications call, in the same coordinated-write transaction shape, rather than a
 *    whole managed sync. Times are compared as present or absent, never to a clock value.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { principalAttribution } from '../../src/core/persistence/attribution.ts';
import { advanceManagedCheckpoint } from '../../src/core/persistence/sync-prepare.ts';

const { parityTest } = parityArms(testBackends());

type Step = Parameters<typeof advanceManagedCheckpoint>[1];

/** The step in a coordinated write of `sourceId`, as a publication runs it; its answer, or the refusal's code. */
async function step(engine: BrainEngine, input: Step): Promise<unknown> {
  return engine.transaction(tx => withCoordinatedWrite(tx, [input.sourceId], () => advanceManagedCheckpoint(tx, input),
    principalAttribution({ kind: 'local_cli', id: 'sync-checkpoint' })))
    .then(r => r, (e: { code?: string; message?: string }) => ({ refused: e.code ?? e.message ?? String(e) }));
}

async function anchor(engine: BrainEngine, sourceId: string) {
  const source = await engine.getSource(sourceId);
  return { lastCommit: source?.last_commit ?? null, synced: source?.last_sync_at instanceof Date,
    mode: (source?.config as Record<string, unknown> | undefined)?.slug_root_mode ?? null };
}

describe('engine parity: the managed sync checkpoint as the publications send it', () => {
  parityTest('the pass stamp and the run checkpoint advance only from the run\'s from, and name a pinned mode that refuses them', {
    methods: ['getSource', 'readSourceMembership', 'updateSourceConfig'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'repo-a', {}, '/srv/brain/repo-a');
    await createSource(engine, backend, 'repo-b', {}, '/srv/brain/repo-b');
    const incarnation = (await engine.readSourceMembership('repo-a'))!.incarnation;
    const inc2 = (await engine.readSourceMembership('repo-b'))!.incarnation;
    const base: Step = { sourceId: 'repo-a', incarnation, commit: 'c1', from: null, acceptAtCommit: true, slugMode: 'git-root', keepPinnedSlugMode: false };
    const out: Record<string, unknown> = {};
    // A slice of a first sync short of its target: the checkpoint stays at from (null), stamped.
    out.firstSlice = await step(engine, { ...base, commit: null, acceptAtCommit: false, sourceId: 'repo-b', incarnation: inc2 });
    out.afterFirstSlice = await anchor(engine, 'repo-b');
    // The pass stamp of a first sync.
    out.pass = await step(engine, base);
    out.afterPass = await anchor(engine, 'repo-a');
    // A run checkpoint that started elsewhere finds the checkpoint moved; an overtaken one accepts it at its target.
    out.moved = await step(engine, { ...base, commit: 'c2', from: 'c0', acceptAtCommit: false });
    out.overtaken = await step(engine, { ...base, from: 'c0', acceptAtCommit: true });
    out.run = await step(engine, { ...base, commit: 'c2', from: 'c1', acceptAtCommit: false });
    out.afterRun = await anchor(engine, 'repo-a');
    // A pinned slug mode refuses another mode (and names it), unless the run keeps the pinned mode (an empty scope).
    await engine.updateSourceConfig('repo-a', { slug_root_mode: 'source-root' });
    out.pinned = await step(engine, { ...base, commit: 'c3', from: 'c2', acceptAtCommit: false });
    out.kept = await step(engine, { ...base, commit: 'c3', from: 'c2', acceptAtCommit: false, keepPinnedSlugMode: true });
    out.afterKept = await anchor(engine, 'repo-a');
    // Another incarnation changes nothing.
    out.otherIncarnation = await step(engine, { ...base, incarnation: 'f0000000-0000-4000-8000-000000000000', commit: 'c4', from: 'c3', acceptAtCommit: false });
    expect(out).toEqual({
      firstSlice: { advanced: true, pinnedSlugMode: null }, afterFirstSlice: { lastCommit: null, synced: true, mode: 'git-root' },
      pass: { advanced: true, pinnedSlugMode: null }, afterPass: { lastCommit: 'c1', synced: true, mode: 'git-root' },
      moved: { advanced: false, pinnedSlugMode: null }, overtaken: { advanced: true, pinnedSlugMode: null },
      run: { advanced: true, pinnedSlugMode: null }, afterRun: { lastCommit: 'c2', synced: true, mode: 'git-root' },
      pinned: { advanced: false, pinnedSlugMode: 'source-root' }, kept: { advanced: true, pinnedSlugMode: null },
      afterKept: { lastCommit: 'c3', synced: true, mode: 'source-root' },
      otherIncarnation: { advanced: false, pinnedSlugMode: null },
    });
    return out;
  });
});
