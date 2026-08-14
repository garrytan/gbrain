/**
 * Thin-client version-skew fixture (amendment 26 / ENG-20).
 *
 * A NEW thin-client `gbrain status` against an OLD brain server: the
 * schema_version-1 `get_status_snapshot` payload carries no workers/queue
 * keys. The client must degrade those sections to a graceful
 * "upgrade the remote" marker — never crash, never render the misleading
 * "local-only — N/A on remote brain" copy, never invent data.
 *
 * Hermetic: drives the exported payload→report mapper (`applyRemoteSnapshot`)
 * and the human renderer directly, with fixture payloads for both server
 * generations.
 */

import { describe, test, expect } from 'bun:test';
import {
  applyRemoteSnapshot,
  renderHuman,
  type RemoteSnapshotPayload,
  type StatusReport,
} from '../src/commands/status.ts';
import type { SyncStatusReport } from '../src/commands/sync.ts';

const syncFixture: SyncStatusReport = {
  schema_version: 1,
  generated_at: '2026-08-13T00:00:00.000Z',
  sources: [],
  unacknowledged_failures: 0,
  embedding_column: 'embedding',
};

const cycleFixture = { last_full: null, last_targeted: null };

function baseReport(): StatusReport {
  return {
    schema_version: 1,
    version: '0.99.0.0',
    generated_at: '2026-08-13T00:00:00.000Z',
    mode: 'thin-client',
  };
}

const wantAll = () => true;

describe('OLD server (schema_version 1 — no workers/queue keys)', () => {
  const v1Payload: RemoteSnapshotPayload = {
    schema_version: 1,
    version: '0.41.19.0',
    sync: syncFixture,
    cycle: cycleFixture,
  };

  test('v2-only sections degrade to the remote_unsupported marker', () => {
    const report = baseReport();
    applyRemoteSnapshot(report, v1Payload, wantAll);
    expect(report.sync).toBe(syncFixture);
    expect(report.cycle).toEqual(cycleFixture);
    expect(report.workers).toEqual({ remote_unsupported: true });
    expect(report.queue).toEqual({ remote_unsupported: true });
    expect(report.remote_version).toBe('0.41.19.0');
  });

  test('human render carries the graceful upgrade copy, not a crash or N/A lie', () => {
    const report = baseReport();
    applyRemoteSnapshot(report, v1Payload, wantAll);
    const out = renderHuman(report);
    expect(out).toContain('predates snapshot v2');
    expect(out).toContain('upgrade the remote gbrain');
    expect(out).not.toContain('N/A on remote brain');
  });
});

describe('NEW server (schema_version 2)', () => {
  const v2Payload: RemoteSnapshotPayload = {
    schema_version: 2,
    version: '0.99.0.0',
    sync: syncFixture,
    cycle: cycleFixture,
    workers: {
      supervisor_alive: true,
      detected_via: 'db_lock',
      live_lock_active: true,
      last_completed_at: '2026-08-13T00:30:00.000Z',
    },
    queue: {
      counts: { active: 1, waiting: 3, completed: 10, failed: 0, dead: 0 },
      by_queue: [{ queue: 'default', depth: 3, oldest_waiting_age_seconds: 120 }],
    },
  };

  test('sections map through verbatim', () => {
    const report = baseReport();
    applyRemoteSnapshot(report, v2Payload, wantAll);
    expect(report.workers).toEqual(v2Payload.workers as any);
    expect(report.queue).toEqual(v2Payload.queue as any);
  });

  test('human render shows the remote queue depth + worker liveness', () => {
    const report = baseReport();
    applyRemoteSnapshot(report, v2Payload, wantAll);
    const out = renderHuman(report);
    expect(out).toContain('supervisor: alive (via db_lock)');
    expect(out).toContain('[default] depth=3');
    expect(out).toContain('waiting=3');
  });

  test('a fail-soft section ({error: unavailable}) renders as unavailable, not a crash', () => {
    const report = baseReport();
    applyRemoteSnapshot(
      report,
      { ...v2Payload, queue: { error: 'unavailable' }, workers: { error: 'unavailable' } },
      wantAll,
    );
    const out = renderHuman(report);
    expect(out).toContain('unavailable (remote section failed to compute)');
  });

  test('--section filter is respected: unwanted sections stay unset', () => {
    const report = baseReport();
    applyRemoteSnapshot(report, v2Payload, (s) => s === 'sync');
    expect(report.sync).toBe(syncFixture);
    expect(report.cycle).toBeUndefined();
    expect(report.workers).toBeUndefined();
    expect(report.queue).toBeUndefined();
  });
});
