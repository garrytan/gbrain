/**
 * BrainEngine parity — a sync request records its wanted marker: readSourceSyncShape (engine-sql/notifier.ts;
 * notifier/nudge.ts sourceSyncShape), read through the real callers `gbrain sync trigger` (runSyncTrigger), the GitHub
 * push webhook (submitGitHubPush) and a sync that finds the lock busy (recordBusyMarker). Three arms: PGLite always,
 * Postgres with DATABASE_URL, Rust through test/engine-parity/harness.ts.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a classic source that exists and is not archived answers its shape (not bound, its local path as the
 *    root); a missing or archived source answers null and records nothing. A trigger records a pull marker and queues
 *    one sync job that the marker names; a push records a pull marker with the pushed sha and answers 202 with the job;
 *    a busy sync records a freshness marker from `lock_busy`. The raw shape read answers the same row on every engine.
 *  - Regression: the shape read ran raw SQL that the Rust engine refuses, so on a Rust brain `gbrain sync trigger`
 *    failed, the push webhook answered 500 and a busy sync logged a failure, and none of them recorded a marker.
 *  - Why existing coverage misses it: the trigger, webhook and handoff tests run PGLite or Postgres only, and
 *    test/engine-parity/wanted-markers.test.ts calls the marker members directly, past the shape read.
 *  - Seam: none. Real engines, the real callers and the real minion queue. The source's local path is not a git
 *    checkout, so no head is read from disk. Job ids are compared as "set and named by the marker", never by value.
 */
import { describe, expect } from 'bun:test';
import type { WantedMarker } from '../../src/core/engine-sql/notifier.ts';
import { readMarkers } from '../../src/core/notifier/store.ts';
import { recordTriggerMarker, sourceSyncShape } from '../../src/core/notifier/nudge.ts';
import { recordBusyMarker } from '../../src/core/notifier/handoff.ts';
import { submitGitHubPush } from '../../src/commands/serve-http-webhooks.ts';
import { runSyncTrigger } from '../../src/commands/sync/trigger.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const PUSHED = 'a'.repeat(40);
const shape = (m: WantedMarker) => [m.source_id, m.intent, m.wanted_head, m.generation, m.requested_by];

/** Runs `fn` with console.log captured; console.error passes through so a failure stays visible. */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); } finally { console.log = original; }
  return lines;
}

describe('engine parity: a sync request records its wanted marker', () => {
  parityTest('the source shape read answers a classic source, and null for a missing or archived one', {
    methods: ['readSourceSyncShape'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'gone', {}, '/srv/brain/gone');
    await archiveSource(engine, backend, 'gone');
    const observed = {
      alpha: await engine.readSourceSyncShape('alpha'),
      gone: await engine.readSourceSyncShape('gone'),
      missing: await engine.readSourceSyncShape('missing'),
      shapes: [await sourceSyncShape(engine, 'alpha'), await sourceSyncShape(engine, 'gone'), await sourceSyncShape(engine, 'missing')],
      recordedMissing: await recordTriggerMarker(engine, { sourceId: 'missing', requestedBy: 'sync_trigger' }),
      recordedGone: await recordTriggerMarker(engine, { sourceId: 'gone', requestedBy: 'sync_trigger' }),
      markers: (await readMarkers(engine)).map(shape),
    };
    expect(observed).toEqual({
      alpha: { local_path: '/srv/brain/alpha', root: null, bound: false },
      gone: null,
      missing: null,
      shapes: [
        { exists: true, managed: false, root: '/srv/brain/alpha' },
        { exists: false, managed: false, root: null },
        { exists: false, managed: false, root: null },
      ],
      recordedMissing: null,
      recordedGone: null,
      markers: [],
    });
  });

  parityTest('gbrain sync trigger records a pull marker and queues the sync job the marker names', {
    methods: ['readSourceSyncShape', 'upsertWantedMarker', 'attachWantedMarkerJob'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    const lines = await captureLog(() => runSyncTrigger(engine, ['--source', 'alpha', '--json']));
    const printed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    const [marker] = await readMarkers(engine);
    expect({
      printed: [printed.action, printed.source_id, printed.intent, printed.wanted_head, printed.marker_generation],
      jobSet: typeof printed.job_id === 'number',
      marker: marker && shape(marker),
      named: marker?.job_id === printed.job_id,
    }).toEqual({
      printed: ['queued', 'alpha', 'pull', null, 1],
      jobSet: true,
      marker: ['alpha', 'pull', null, 1, 'sync_trigger'],
      named: true,
    });
  });

  parityTest('a push records the pushed sha and answers 202; a busy sync records a freshness marker', {
    methods: ['readSourceSyncShape', 'upsertWantedMarker', 'attachWantedMarkerJob'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'alpha', {}, '/srv/brain/alpha');
    await createSource(engine, backend, 'beta', {}, '/srv/brain/beta');
    let status = 0;
    let body: Record<string, unknown> = {};
    await submitGitHubPush(engine, 'alpha', PUSHED, { status: (code: number) => { status = code; return { json: (b: unknown) => { body = b as Record<string, unknown>; } }; } });
    let unknownStatus = 0;
    await submitGitHubPush(engine, 'missing', PUSHED, { status: (code: number) => { unknownStatus = code; return { json: () => undefined }; } });
    await recordBusyMarker(engine, 'beta', { pull: false });
    const markers = await readMarkers(engine);
    const alpha = markers.find(m => m.source_id === 'alpha');
    expect({
      status, unknownStatus,
      answer: [body.action, body.source_id, body.wanted_head, body.marker_generation],
      jobSet: typeof body.job_id === 'number',
      named: alpha?.job_id === body.job_id,
      markers: markers.map(shape).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    }).toEqual({
      status: 202, unknownStatus: 404,
      answer: ['queued', 'alpha', PUSHED, 1],
      jobSet: true,
      named: true,
      markers: [['alpha', 'pull', PUSHED, 1, 'webhook'], ['beta', 'freshness', null, 1, 'lock_busy']],
    });
  });
});
