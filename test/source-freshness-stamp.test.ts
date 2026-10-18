import { describe, test, expect } from 'bun:test';
import { decideSourceStamp } from '../src/core/cycle/source-freshness.ts';
import type { CycleStatus, PhaseResult } from '../src/core/cycle.ts';
const phase = (name: PhaseResult['phase'], status: PhaseResult['status']): PhaseResult =>
  ({ phase: name, status, duration_ms: 1, summary: '', details: {} });
const base = { sourceId: 'synthetic', phaseCount: 2, hasEngine: true, dryRun: false, aborted: false };
describe('source freshness stamp truthfulness', () => {
  test('hard-failed freshness work remains due beside a passing phase', () => {
    expect(decideSourceStamp({ ...base, status: 'partial', phaseResults: [phase('sync', 'fail'), phase('lint', 'ok')] }))
      .toEqual({ stamp: false, withheldFor: ['sync'] });
  });
  test('warn-only partial retains successful source progress', () => {
    expect(decideSourceStamp({ ...base, status: 'partial', phaseResults: [phase('sync', 'ok'), phase('lint', 'warn')] }))
      .toEqual({ stamp: true });
  });
  test('non-freshness failure cannot hold the source stamp hostage', () => {
    expect(decideSourceStamp({ ...base, status: 'partial', phaseResults: [phase('sync', 'ok'), phase('embed', 'fail')] }))
      .toEqual({ stamp: true });
  });
  test('ineligible cycles never stamp or report a withheld eligible stamp', () => {
    for (const extra of [{ dryRun: true }, { aborted: true }, { hasEngine: false }, { phaseCount: 0 }, { sourceId: undefined },
      { status: 'failed' as CycleStatus }, { status: 'skipped' as CycleStatus }]) {
      expect(decideSourceStamp({ ...base, status: 'partial', phaseResults: [phase('sync', 'fail')], ...extra })).toEqual({ stamp: false });
    }
  });
});
