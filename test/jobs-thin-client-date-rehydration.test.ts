/**
 * #3026: thin-client `jobs list`/`get` receive MinionJob rows as parsed JSON
 * off the MCP wire — every timestamp an ISO string — while formatJob /
 * formatJobDetail and the stalled-detection comparison hold a Date contract
 * (locally hydrated by MinionQueue.rowToJob). Before the fix, `jobs get <id>`
 * on a thin client crashed with "job.started_at.toISOString is not a
 * function" the moment the remote routing actually worked (unmasked by
 * #2951's scratch-engine fix).
 *
 * Pins rehydrateJobDates (the unpack-boundary coercion) plus, audit-style,
 * that both thin-client unpack sites route through it.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rehydrateJobDates } from '../src/commands/jobs.ts';

describe('rehydrateJobDates', () => {
  test('coerces wire-format ISO strings to Dates on all timestamp fields', () => {
    const wire = {
      id: 1192,
      name: 'autopilot-cycle',
      status: 'completed',
      created_at: '2026-07-21T04:02:11.512Z',
      updated_at: '2026-07-21T04:02:14.930Z',
      started_at: '2026-07-21T04:02:12.001Z',
      finished_at: '2026-07-21T04:02:14.900Z',
      lock_until: '2026-07-21T04:03:12.001Z',
      delay_until: null,
    };
    const job = rehydrateJobDates(wire);
    expect(job.created_at).toBeInstanceOf(Date);
    expect(job.updated_at).toBeInstanceOf(Date);
    expect(job.started_at).toBeInstanceOf(Date);
    expect(job.finished_at).toBeInstanceOf(Date);
    expect(job.lock_until).toBeInstanceOf(Date);
    expect((job.started_at as unknown as Date).toISOString()).toBe('2026-07-21T04:02:12.001Z');
    // Date math used by formatJob's duration column works post-rehydration.
    expect((job.finished_at as unknown as Date).getTime() - (job.started_at as unknown as Date).getTime())
      .toBeCloseTo(2899, 0);
  });

  test('leaves Dates, nulls, and non-timestamp fields untouched', () => {
    const started = new Date('2026-07-21T04:02:12.001Z');
    const job = rehydrateJobDates({
      id: 7,
      name: 'sync',
      status: 'active',
      created_at: started,
      started_at: started,
      finished_at: null,
      delay_until: undefined,
    });
    expect(job.created_at).toBe(started);
    expect(job.finished_at).toBeNull();
    expect(job.delay_until).toBeUndefined();
    expect(job.name).toBe('sync');
  });

  test('does not fabricate Dates from malformed strings; passes null through', () => {
    const job = rehydrateJobDates({ id: 8, started_at: 'not-a-date' });
    expect(job.started_at).toBe('not-a-date');
    expect(rehydrateJobDates(null)).toBeNull();
  });
});

describe('thin-client unpack sites route through rehydrateJobDates (source audit)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'jobs.ts'), 'utf8');

  test('list branch rehydrates', () => {
    expect(src).toContain('unpackToolResult<MinionJob[]>(raw).map((j) => rehydrateJobDates(j))');
  });

  test('get branch rehydrates', () => {
    expect(src).toContain('rehydrateJobDates(unpackToolResult<MinionJob | null>(raw))');
  });
});
