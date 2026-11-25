/**
 * BrainEngine parity — the sync reads that read an engine refusal as an empty answer (refusal-swallow triage,
 * docs/research/rust-refusal-swallow-triage.tsv on rust-engine/refusal-swallow-triage, owner lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each read answers the same on every engine arm: the job timing a sync job drains by
 *    (sync-job-drain.ts planJobDrain), the source a repo path names and whether a queued freshness sync is off
 *    (minions/handlers/sync.ts), the embed-backfill jobs still queued (sync-cost-gate.ts), the claimed sources
 *    that wait for activation (sync-policy.ts loadActivationPendingSourceIds), and the sources the serve-side
 *    deferred-embed drain reads (serve-sync-runner.ts maybeDrainDeferredEmbeds), and the live pages a sync reads
 *    before it deletes the page of a removed file (sync-git.ts resolveSlugsForRemovedPaths).
 *  - Regression: each read ran raw SQL inside a catch that returned an empty answer, so a Rust brain, which refuses
 *    raw SQL, drained a job on the unknown budget, fell back to the global sync anchor, ran a sync its source turned
 *    off, counted no queued backfills, marked no claimed source pending and logged only "embed-drain failed", with
 *    no error anywhere.
 *  - Why existing coverage misses it: the unit tests of these callers run on PGLite or Postgres only, where the raw
 *    statement answers; no test ran them on the Rust arm.
 *  - Seam: none. The rows are written through typed members (the job queue, the source, the writer claim store).
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { seedSource, seedSourceBinding, seedWorktree } from './persistence-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { planJobDrain } from '../../src/core/minions/handlers/sync-job-drain.ts';
import { queuedSyncDisabled, sourceIdForRepoPath } from '../../src/core/minions/handlers/sync.ts';
import { countQueuedBackfills } from '../../src/core/sync-cost-gate.ts';
import { loadActivationPendingSourceIds } from '../../src/core/sync-policy.ts';
import {
  __deferredEmbedsPendingForTests, __resetDelegatedSyncForTests, deferredEmbedDecisions, maybeDrainDeferredEmbeds, scheduleDeferredSyncEmbeds,
} from '../../src/core/serve-sync-runner.ts';
import { withEnv } from '../helpers/with-env.ts';
import { resolveSlugsForRemovedPaths } from '../../src/core/sync-git.ts';

const { parityTest } = parityArms(testBackends());

/** One waiting job row written through admitJob, with the queue's column defaults (the queue's own add refuses an embed-backfill job without a worker). */
async function admitWaiting(engine: BrainEngine, name: string, data: Record<string, unknown>): Promise<void> {
  const insert: JobInsertValues = {
    name, queue: 'default', status: 'waiting', priority: 0, data, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null,
  };
  await engine.admitJob({ maxSpawnDepth: 5, insert }, {
    decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY),
    parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
  });
}

describe('sync reads answer the same on every engine', () => {
  parityTest('planJobDrain reads the job row it drains by: queue, priority, timeout and the wall-clock budget', {
    methods: ['admitJob', 'getJob'],
  }, async (engine) => {
    const job = await new MinionQueue(engine).add('swap-drain-probe', { sourceId: 'default' }, { timeout_ms: 600_000, priority: 3 });
    const plan = await planJobDrain(engine, { id: job.id, data: {}, submission_authority: null } as never);
    const row = plan.row && { queue: plan.row.queue, priority: plan.row.priority, timeout_ms: plan.row.timeout_ms, wall_ms: plan.row.wall_ms, started_ms: plan.row.started_ms };
    // A waiting job has not started; its budget is twice its timeout.
    expect(row).toEqual({ queue: 'default', priority: 3, timeout_ms: 600_000, wall_ms: 1_200_000, started_ms: null });
    return row;
  });

  parityTest('a sync job finds the source registered at its repo path, and a queued freshness sync sees a source that turned sync off', {
    methods: ['listAllSources', 'getSource'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'swap-on', {}, '/var/tmp/gbrain-parity-swap/on');
    await createSource(engine, backend, 'swap-off', { syncEnabled: false }, '/var/tmp/gbrain-parity-swap/off');
    const answers = {
      at: await sourceIdForRepoPath(engine, '/var/tmp/gbrain-parity-swap/on'),
      nowhere: await sourceIdForRepoPath(engine, '/var/tmp/gbrain-parity-swap/missing') ?? null,
      off: await queuedSyncDisabled(engine, 'swap-off'),
      on: await queuedSyncDisabled(engine, 'swap-on'),
      unknown: await queuedSyncDisabled(engine, 'swap-missing'),
    };
    expect(answers).toEqual({ at: 'swap-on', nowhere: null, off: true, on: false, unknown: false });
    return answers;
  });

  parityTest('the sync cost gate counts the embed-backfill jobs still queued', {
    methods: ['admitJob', 'countJobsByStatus'],
  }, async (engine) => {
    await admitWaiting(engine, 'embed-backfill', { sourceId: 'a' });
    await admitWaiting(engine, 'embed-backfill', { sourceId: 'b' });
    await admitWaiting(engine, 'swap-other', {});
    const queued = await countQueuedBackfills(engine);
    expect(queued).toBe(2);
    return queued;
  });

  parityTest('autopilot marks a source claimed before activation as pending, from its typed binding', {
    methods: ['writerReleaseStore', 'worktreeClaimStore'],
  }, async (engine, backend) => {
    await (await engine.writerReleaseStore()).setBrainEnabled(false);
    for (const id of ['swap-bound-b', 'swap-bound-a']) {
      await seedSourceBinding(engine, id, await seedSource(engine, backend, id), await seedWorktree(engine));
    }
    const pending = [...await loadActivationPendingSourceIds(engine)].sort();
    expect(pending).toEqual(['swap-bound-a', 'swap-bound-b']);
    return pending;
  });

  parityTest('the deferred-embed drain reads the sources it would embed, and with no provider key keeps the backlog as keyless', {
    methods: ['listAllSources'],
  }, async (engine, backend) => withEnv({ OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, GBRAIN_EMBEDDING_MODEL: undefined }, async () => {
    __resetDelegatedSyncForTests();
    try {
      await createSource(engine, backend, 'swap-embed');
      scheduleDeferredSyncEmbeds(engine);
      await maybeDrainDeferredEmbeds(engine);
      const answers = { decisions: deferredEmbedDecisions.map(entry => entry.decision), pending: __deferredEmbedsPendingForTests(engine) };
      expect(answers).toEqual({ decisions: ['keyless'], pending: true });
      return answers;
    } finally { __resetDelegatedSyncForTests(); }
  }));

  parityTest('a removed file resolves to its page only on live-page evidence: a derived slug another file owns is refused', {
    methods: ['putPage', 'resolveSlugsByPaths', 'readFirstLiveSlugAtPath', 'listPathTwinSlugs', 'listLiveSlugOrigins'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'swap-git');
    const page = (slug: string, source_path: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '', source_path }, { sourceId: 'swap-git' });
    // Two live pages recording one file (the twin refusal) cannot be written through putPage, so the twin read runs and finds none.
    await page('notes/plain', 'notes/plain.md');
    await page('extracts/propose/x', 'extracts/propose/x.md');
    const scoped = await resolveSlugsForRemovedPaths(engine, ['notes/plain.md', 'extracts/propose-/x.md', 'gone/none.md'], 'swap-git');
    const unscoped = await resolveSlugsForRemovedPaths(engine, ['notes/plain.md'], undefined);
    const answers = {
      slugs: Object.fromEntries([...scoped.slugs].sort()),
      refused: scoped.refused.map(r => ({ path: r.path, slug: r.slug, claimants: r.claimants ?? null })),
      unscoped: Object.fromEntries(unscoped.slugs),
    };
    expect(answers.slugs).toEqual({ 'gone/none.md': 'gone/none', 'notes/plain.md': 'notes/plain' });
    expect(answers.refused).toEqual([{ path: 'extracts/propose-/x.md', slug: 'extracts/propose/x', claimants: null }]);
    expect(answers.unscoped).toEqual({ 'notes/plain.md': 'notes/plain' });
    return answers;
  });
});
