/**
 * #6366 (fix wave 15 P4.7): the autopilot sync hang is not reproducible on master, so the import drain now states the
 * pool (`max` / `checked_out` / `waiters`) once when its imports start and again in the stall watchdog's stop line, so
 * the next report carries the evidence. Golden of the line only: an engine that reports a pool gets it, one that does
 * not (PGLite) gets nothing appended.
 */
import { expect, test } from 'bun:test';
import { poolLine } from '../src/commands/sync/imports.ts';

test('poolLine renders the driver pool numbers for a Postgres engine and nothing for an engine without a pool', () => {
  const postgres = { getPoolDiagnostics: () => ({ pool: { checked_out: 3, max: 4, waiters: 2, inflight_oldest_ms: 0, completed: 10 } }) };
  expect(poolLine(postgres)).toBe(' · pool max=4 checked_out=3 waiters=2');
  expect(poolLine({})).toBe('');
  expect(poolLine({ getPoolDiagnostics: () => null })).toBe('');
  expect(poolLine({ getPoolDiagnostics: () => { throw new Error('no pool'); } })).toBe('');
});
