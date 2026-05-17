/**
 * Unit tests for the shared crash classifier used by `gbrain doctor` and
 * `gbrain jobs supervisor status`. Both surfaces import `isCrashExit` +
 * `summarizeCrashes` from `src/core/minions/handlers/supervisor-audit.ts`;
 * pinning them here keeps the two CLI surfaces from drifting.
 *
 * Why this file exists: pre-fix the doctor counted every `worker_exited`
 * event as a crash, regardless of `likely_cause`. Clean SIGTERM shutdowns
 * and RSS-watchdog drains (code=0) inflated `crashes_24h` to 120+/day on
 * Garry's brain. The classifier upstream in child-worker-supervisor.ts
 * already stamped `likely_cause` correctly; the read sites just ignored it.
 * These tests pin every branch of the new shared classifier so the bug
 * cannot silently recur.
 */

import { describe, test, expect } from 'bun:test';
import {
  isCrashExit,
  summarizeCrashes,
  type CrashSummary,
} from '../src/core/minions/handlers/supervisor-audit.ts';
import type { SupervisorEmission } from '../src/core/minions/supervisor.ts';

// Helper: build a SupervisorEmission of the given event with arbitrary extra
// fields. `ts` is required by the type but irrelevant to the classifier; we
// stamp a constant so failures show predictable fixtures.
function evt(
  event: SupervisorEmission['event'],
  extra: Record<string, unknown> = {},
): SupervisorEmission {
  return { event, ts: '2026-05-16T00:00:00Z', ...extra };
}

describe('isCrashExit — branch matrix', () => {
  // Case 1: explicit clean exit (worker returned code=0 voluntarily,
  // e.g. RSS watchdog drain). The most common cause of the original
  // bug — every drain was being counted as a crash.
  test('clean_exit is not a crash', () => {
    expect(isCrashExit(evt('worker_exited', { likely_cause: 'clean_exit', code: 0 }))).toBe(false);
  });

  // Case 2: SIGTERM-driven shutdown (operator stop, OS-initiated graceful
  // termination). Also not a crash.
  test('graceful_shutdown is not a crash', () => {
    expect(isCrashExit(evt('worker_exited', { likely_cause: 'graceful_shutdown', signal: 'SIGTERM' }))).toBe(false);
  });

  // Case 3: code=1 from the worker process — a real runtime error.
  test('runtime_error is a crash', () => {
    expect(isCrashExit(evt('worker_exited', { likely_cause: 'runtime_error', code: 1 }))).toBe(true);
  });

  // Case 4: SIGKILL (kernel OOM kill, external `kill -9`). Real crash.
  test('oom_or_external_kill is a crash', () => {
    expect(isCrashExit(evt('worker_exited', { likely_cause: 'oom_or_external_kill', signal: 'SIGKILL' }))).toBe(true);
  });

  // Case 5: catch-all bucket from the upstream classifier (unusual code or
  // signal combination). Real crash.
  test('unknown is a crash', () => {
    expect(isCrashExit(evt('worker_exited', { likely_cause: 'unknown', code: 137 }))).toBe(true);
  });

  // Case 6: denylist regression guard. If a future maintainer adds a NEW
  // `likely_cause` value upstream (e.g. `lock_lost`, `panic`,
  // `db_connection_lost`), the doctor MUST surface it by default. Allowlist
  // semantics would have silently misclassified this as clean — the exact
  // bug class this fix exists to close.
  test('unrecognized future likely_cause is a crash (denylist regression guard)', () => {
    expect(isCrashExit(evt('worker_exited', { likely_cause: 'future_value_not_known' }))).toBe(true);
  });

  // Case 7: legacy fallback path — pre-v0.34 audit lines lacking
  // `likely_cause`. Use `code` to classify: code=0 is clean.
  test('legacy (no likely_cause) with code=0 is not a crash', () => {
    expect(isCrashExit(evt('worker_exited', { code: 0 }))).toBe(false);
  });

  // Case 8: legacy fallback path — pre-v0.34 entry with code=1 (real crash).
  test('legacy (no likely_cause) with code=1 is a crash', () => {
    expect(isCrashExit(evt('worker_exited', { code: 1 }))).toBe(true);
  });

  // Case 9: defensive — non-exit lifecycle events MUST never be counted as
  // crashes regardless of their other fields. Catches a future caller that
  // forgets the upstream `event === 'worker_exited'` filter.
  test('non-exit event is never a crash', () => {
    expect(isCrashExit(evt('started'))).toBe(false);
    expect(isCrashExit(evt('worker_spawned', { code: 1 }))).toBe(false);
    expect(isCrashExit(evt('max_crashes_exceeded', { likely_cause: 'runtime_error' }))).toBe(false);
  });
});

describe('summarizeCrashes — aggregation', () => {
  // Feed a representative mixed stream and assert every bucket. The mix
  // exercises every classifier branch so the message-format consumers
  // (doctor.ts and jobs.ts) get a stable shape.
  test('aggregates a mixed stream into per-cause buckets and clean_exits', () => {
    const events: SupervisorEmission[] = [
      evt('worker_exited', { likely_cause: 'runtime_error', code: 1 }),
      evt('worker_exited', { likely_cause: 'runtime_error', code: 1 }),
      evt('worker_exited', { likely_cause: 'oom_or_external_kill', signal: 'SIGKILL' }),
      evt('worker_exited', { likely_cause: 'unknown', code: 137 }),
      evt('worker_exited', { code: 1 }), // legacy (no likely_cause)
      evt('worker_exited', { likely_cause: 'clean_exit', code: 0 }),
      evt('worker_exited', { likely_cause: 'clean_exit', code: 0 }),
      evt('worker_exited', { likely_cause: 'clean_exit', code: 0 }),
      evt('worker_exited', { likely_cause: 'graceful_shutdown', signal: 'SIGTERM' }),
      // Non-exit events MUST be ignored (no double-counting against either bucket).
      evt('started'),
      evt('worker_spawned'),
      evt('health_warn'),
    ];

    const summary: CrashSummary = summarizeCrashes(events);

    expect(summary.total).toBe(5);
    expect(summary.by_cause.runtime_error).toBe(2);
    expect(summary.by_cause.oom_or_external_kill).toBe(1);
    expect(summary.by_cause.unknown).toBe(1);
    expect(summary.by_cause.legacy).toBe(1);
    expect(summary.clean_exits).toBe(4);
    // total + clean_exits should equal the count of worker_exited events,
    // proving non-exit lifecycle events were excluded from both buckets.
    const exitCount = events.filter((e) => e.event === 'worker_exited').length;
    expect(summary.total + summary.clean_exits).toBe(exitCount);
  });

  test('empty input returns zero summary', () => {
    const summary = summarizeCrashes([]);
    expect(summary).toEqual({
      total: 0,
      by_cause: { runtime_error: 0, oom_or_external_kill: 0, unknown: 0, legacy: 0 },
      clean_exits: 0,
    });
  });

  test('only non-exit events returns zero summary', () => {
    const summary = summarizeCrashes([evt('started'), evt('worker_spawned'), evt('stopped')]);
    expect(summary.total).toBe(0);
    expect(summary.clean_exits).toBe(0);
  });

  // Denylist regression guard at the AGGREGATOR level. isCrashExit Case 6
  // proves an unrecognized future `likely_cause` is counted as a crash; this
  // pins which BUCKET it lands in. The `else` branch in summarizeCrashes
  // routes any crash-classified event whose cause doesn't match the three
  // explicit buckets into `legacy`. Operators watching `legacy=N` rise know
  // the upstream classifier added a value the doctor doesn't yet name —
  // that's the intended signal.
  test('unrecognized future likely_cause routes to legacy bucket', () => {
    const summary = summarizeCrashes([
      evt('worker_exited', { likely_cause: 'lock_lost' }),
      evt('worker_exited', { likely_cause: 'panic' }),
    ]);
    expect(summary.total).toBe(2);
    expect(summary.by_cause.legacy).toBe(2);
    expect(summary.by_cause.runtime_error).toBe(0);
    expect(summary.by_cause.oom_or_external_kill).toBe(0);
    expect(summary.by_cause.unknown).toBe(0);
  });

  // Truly malformed legacy line — `likely_cause` missing AND `code` null
  // (or undefined). The classifier comment explicitly says "fail-loud, the
  // user can investigate the audit file directly", which means count it.
  // null !== 0 is true so isCrashExit returns true; summarizeCrashes then
  // lands it in legacy. Pinning this prevents a regression where a future
  // refactor adds `code != null` and silently drops malformed entries.
  test('legacy entry with null code counts as crash in legacy bucket', () => {
    const summary = summarizeCrashes([
      evt('worker_exited', { code: null }),
    ]);
    expect(summary.total).toBe(1);
    expect(summary.by_cause.legacy).toBe(1);
    expect(summary.clean_exits).toBe(0);
  });
});
