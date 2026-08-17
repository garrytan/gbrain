/**
 * `jobs get` timeout/deadline rendering (jobs fix wave, upstream issue #3).
 *
 * Pins:
 * 1. All three effective-budget states render, with the corrected wording:
 *    the 1x deadline (handleTimeouts) is the NORMAL kill and the 2x
 *    wall-clock sweep is the backstop — not the other way around.
 * 2. Defensive timeout_at rendering: a thin client pointed at an OLDER
 *    server receives timeout_at as an ISO string (the peer predates the
 *    rehydration list entry) — the formatter must print it, never crash on
 *    an unguarded .toISOString().
 */

import { describe, test, expect } from 'bun:test';
import { formatJobDetail } from '../src/commands/jobs.ts';
import type { MinionJob } from '../src/core/minions/types.ts';

function job(overrides: Partial<MinionJob> & Record<string, unknown>): MinionJob {
  return {
    id: 42,
    name: 'sync',
    queue: 'default',
    status: 'waiting',
    priority: 0,
    data: {},
    attempts_made: 0,
    attempts_started: 0,
    max_attempts: 3,
    stalled_counter: 0,
    max_stalled: 5,
    backoff_type: 'exponential',
    backoff_delay: 1000,
    backoff_jitter: 0,
    created_at: new Date('2026-08-14T00:00:00.000Z'),
    updated_at: new Date('2026-08-14T00:00:00.000Z'),
    started_at: null,
    finished_at: null,
    lock_token: null,
    lock_until: null,
    delay_until: null,
    timeout_ms: null,
    timeout_at: null,
    parent_job_id: null,
    on_child_fail: 'fail',
    error_text: null,
    stacktrace: [],
    progress: null,
    result: null,
    ...overrides,
  } as unknown as MinionJob;
}

describe('formatJobDetail timeout/deadline lines', () => {
  test('explicit budget: 1x-deadline wording + Deadline line from a Date', () => {
    const out = formatJobDetail(job({
      name: 'autopilot-cycle',
      timeout_ms: 1_800_000,
      timeout_at: new Date('2026-08-14T01:00:00.000Z'),
    }));
    expect(out).toContain('Timeout: 1800000ms (deadline kill at 1x when claimed; wall-clock backstop at 2x)');
    expect(out).toContain('Deadline: 2026-08-14T01:00:00.000Z');
  });

  test('defensive render: timeout_at arriving as an ISO STRING (older server) does not crash', () => {
    const out = formatJobDetail(job({
      name: 'subagent',
      timeout_ms: 1_800_000,
      // Deliberately a string — rehydrateJobDates on an older peer never
      // converted this field. An unguarded .toISOString() would throw here.
      timeout_at: '2026-08-14T01:00:00.000Z' as unknown as Date,
    }));
    expect(out).toContain('Deadline: 2026-08-14T01:00:00.000Z');
  });

  test('unset budget + mapped handler: names the claim-time default', () => {
    const out = formatJobDetail(job({ name: 'autopilot-cycle', timeout_ms: null }));
    expect(out).toContain('Timeout: (unset) — handler default 1800000ms stamps at claim');
  });

  test('unset budget + unmapped handler: names the null-default sweep', () => {
    const out = formatJobDetail(job({ name: 'sync', timeout_ms: null }));
    expect(out).toContain('null-default wall-clock sweep applies');
  });
});

describe('lock lease rendering (#4145)', () => {
  test('stamped row value renders with the cadence note', () => {
    const out = formatJobDetail(job({ lock_duration_ms: 120000 }));
    expect(out).toContain('Lock lease: 120000ms (renewed at min(lease/2, 60s) cadence)');
  });

  test('unset lease on a mapped handler renders the claim-time default', () => {
    const out = formatJobDetail(job({ name: 'subagent', lock_duration_ms: null }));
    expect(out).toContain('Lock lease: (unset) — handler default 300000ms stamps at claim');
  });

  test('unset lease on an unmapped handler renders no lease line (worker default applies)', () => {
    const out = formatJobDetail(job({ name: 'sync', lock_duration_ms: null }));
    expect(out).not.toContain('Lock lease:');
  });
});
