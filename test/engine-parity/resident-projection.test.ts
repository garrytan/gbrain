/**
 * BrainEngine parity — the resident projection drain: the owner's projection pass
 * (persistence/consumer.ts `runResidentProjectionInvocation`) and the idle owner tick that starts it (`hasWork`, then
 * `tick`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a page write queues its text projection; one resident invocation rebuilds the queued page and leaves the
 *    queue empty, and an idle owner tick sees the queued projection, runs the pass and drains it. The page ends with the
 *    same chunks on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts).
 *  - Regression: on the Rust engine the owner's idle probe skipped the typed probe (probeIdleWork) and asked only
 *    whether a write was claimable, so an idle Rust owner never saw queued projection work and its pages stayed
 *    unsealed until the idle backoff reached its cap.
 *  - Why existing coverage misses it: owner-recovery-scans.test.ts probes an empty journal and a queued write only;
 *    projection-rebuild-steps.test.ts calls the rebuild loop directly, never through the owner.
 *  - Seam: none. The real consumer and typed members only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PersistenceConsumer, runResidentProjectionInvocation } from '../../src/core/persistence/consumer.ts';
import { hostIdFor, registerLocalWriter } from '../../src/core/persistence/identity.ts';

const { parityTest } = parityArms(testBackends());
const PAGE = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

/** The page's chunks as index and text, sealed only. */
async function chunks(engine: BrainEngine, slug: string) {
  return (await engine.getChunks(slug)).map(c => [c.chunk_index, c.chunk_text]);
}

/** The queued projection jobs' slugs. */
async function queued(engine: BrainEngine) {
  return (await engine.listQueuedPageProjections({ limit: 10 })).map(j => j.slug);
}

describe('engine parity: the resident projection drain', () => {
  parityTest('one resident invocation rebuilds a queued page and drains the queue', {
    methods: ['putPage', 'getChunks', 'listQueuedPageProjections', 'hasClaimableWrite', 'listPendingSegmentedProjections',
      'selectProjectionWindowJobs', 'probeProjectionWindowCandidates', 'deleteProjectionJob'],
    timeout: 60_000,
  }, async (engine) => {
    await engine.putPage('notes/resident', PAGE('Resident', 'a passage about otters.'));
    const before = await queued(engine);
    const rebuild = await runResidentProjectionInvocation(engine, hostIdFor(engine), []);
    const out = { before, rebuild, after: await queued(engine), end: await chunks(engine, 'notes/resident') };
    expect(out).toEqual({ before: ['notes/resident'], rebuild: { rebuilt: 1, superseded: 0 }, after: [],
      end: [[0, 'a passage about otters.']] });
    return out;
  });

  parityTest('an idle owner tick sees a queued projection and drains it', {
    methods: ['putPage', 'getChunks', 'listQueuedPageProjections', 'probeIdleWork', 'deleteProjectionJob'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    await engine.putPage('notes/idle-owner', PAGE('Idle owner', 'a passage about beavers.'));
    const consumer = new PersistenceConsumer(engine, { engine: engine.kind } as GBrainConfig,
      async () => { throw new Error('the projection drain prepares nothing'); }, { hostId: hostIdFor(engine) });
    const owner = consumer as unknown as { hasWork(): Promise<boolean>; projectionWorker?: Promise<unknown> };
    const work = await owner.hasWork();
    await consumer.tick();
    await owner.projectionWorker;
    await consumer.stop();
    const out = { work, after: await queued(engine), end: await chunks(engine, 'notes/idle-owner') };
    expect(out).toEqual({ work: true, after: [], end: [[0, 'a passage about beavers.']] });
    return out;
  });
});
