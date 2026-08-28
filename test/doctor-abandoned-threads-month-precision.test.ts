/**
 * #4041 regression: doctor's abandoned_threads check must not warn on legal
 * month-precision since_date values. The fence spec allows 'YYYY-MM' cells
 * (stored verbatim as TEXT), but a bare since_date::date cast throws
 * "invalid input syntax for type date" on them, turning the check's real
 * signal into a spurious driver-error warn. Real-engine test on purpose —
 * the hermetic mock suite (test/doctor-calibration-checks.test.ts) stubs
 * executeRaw and can never catch SQL-level defects.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkAbandonedThreads } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

// Relative dates keep the test deterministic forever: 24 months back is
// always past the check's 12-month threshold. Day pinned to the 1st (UTC)
// so month arithmetic can never roll over.
const now = new Date();
const past = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1));
const monthPrecisionSince = past.toISOString().slice(0, 7); // 'YYYY-MM'
const dayPrecisionSince = past.toISOString().slice(0, 10); // 'YYYY-MM-01'

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page = await engine.putPage('people/alice-example', {
    title: 'Alice Example',
    type: 'person' as const,
    compiled_truth: '## Takes\n\nAlice is a strong founder.\n',
  });
  await engine.addTakesBatch([
    {
      page_id: page.id,
      row_num: 1,
      claim: 'Will win her market',
      kind: 'take',
      holder: 'holder-a',
      weight: 0.85,
      since_date: monthPrecisionSince,
    },
    // Mixed formats in one table: the day-precision row must keep counting.
    {
      page_id: page.id,
      row_num: 2,
      claim: 'Strong technical team',
      kind: 'take',
      holder: 'holder-a',
      weight: 0.9,
      since_date: dayPrecisionSince,
    },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('checkAbandonedThreads month-precision since_date (#4041)', () => {
  test('counts month-precision takes instead of warning on the cast', async () => {
    const check = await checkAbandonedThreads(engine);
    // count > 0 is still 'ok' by design; 'warn' here means the query threw.
    expect(check.status).toBe('ok');
    expect(check.message).toContain('2 high-conviction take(s)');
    expect(check.message).toContain('gbrain calibration');
  });
});
