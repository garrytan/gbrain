/**
 * A failed phase must never be recorded as `complete`.
 *
 * `statusForVersion` implements a deliberate "complete wins" rule: a later
 * `partial` append cannot undo a completed migration. That safety rule turns
 * a false-green ledger row into a permanent one — `apply-migrations` buckets
 * the version as `applied` and only ever runs `[...partial, ...pending]`, so
 * the failed phase is unreachable by the documented repair
 * (`gbrain apply-migrations --yes`, advertised as idempotent and safe to
 * re-run). The failure then shows up only as a downstream symptom.
 *
 * Two layers are covered:
 *   - `deriveOverallStatus` — v0.11.0's own sweep (phases A-D early-return on
 *     failure, E and F do not).
 *   - `resolveRecordStatus` — the runner's class-level backstop, which holds
 *     for every registered orchestrator including ones that derive status
 *     without sweeping their phases.
 */

import { describe, test, expect } from 'bun:test';

import { __testing as v11 } from '../src/commands/migrations/v0_11_0.ts';
import { __testing as runner } from '../src/commands/apply-migrations.ts';
import { statusForVersion, indexCompletedEntries } from '../src/core/migration-ledger.ts';
import type { OrchestratorPhaseResult, OrchestratorResult } from '../src/commands/migrations/types.ts';

const { deriveOverallStatus } = v11;
const { resolveRecordStatus } = runner;

const ok = (name: string): OrchestratorPhaseResult => ({ name, status: 'complete' });
const failed = (name: string, detail = 'boom'): OrchestratorPhaseResult => ({ name, status: 'failed', detail });
const skipped = (name: string): OrchestratorPhaseResult => ({ name, status: 'skipped' });

function result(over: Partial<OrchestratorResult> = {}): OrchestratorResult {
  return { version: '0.11.0', status: 'complete', phases: [ok('schema')], ...over };
}

describe('deriveOverallStatus — v0.11.0 phase sweep', () => {
  test('clean run with no host work is complete', () => {
    expect(deriveOverallStatus([ok('schema'), ok('prefs'), ok('install')], 0)).toBe('complete');
  });

  test('skipped phases do not make a run partial', () => {
    // --no-autopilot-install and --dry-run both record `skipped`; neither is
    // a failure and neither should block the ledger from completing.
    expect(deriveOverallStatus([ok('schema'), skipped('install')], 0)).toBe('complete');
  });

  test('pending host work is partial (the original rule)', () => {
    expect(deriveOverallStatus([ok('schema'), ok('host')], 3)).toBe('partial');
  });

  test('a failed install phase is partial, NOT complete', () => {
    // The regression: Phase F failing while every other phase succeeded and
    // no host work remained used to yield `complete`.
    const phases = [ok('schema'), ok('smoke'), ok('mode'), ok('prefs'), ok('host'), failed('install')];
    expect(deriveOverallStatus(phases, 0)).toBe('partial');
  });

  test('a failed host phase is partial too', () => {
    expect(deriveOverallStatus([ok('schema'), failed('host')], 0)).toBe('partial');
  });
});

describe('resolveRecordStatus — runner backstop', () => {
  test('complete stays complete when no phase failed', () => {
    expect(resolveRecordStatus(result({ phases: [ok('a'), skipped('b')] }))).toBe('complete');
  });

  test('an orchestrator reporting complete over a failed phase is downgraded', () => {
    expect(resolveRecordStatus(result({ status: 'complete', phases: [ok('a'), failed('b')] }))).toBe('partial');
  });

  test('partial is preserved', () => {
    expect(resolveRecordStatus(result({ status: 'partial', phases: [ok('a')] }))).toBe('partial');
  });

  test('holds for any orchestrator version, not just v0.11.0', () => {
    const r = result({ version: '0.43.0', status: 'complete', phases: [failed('detect')] });
    expect(resolveRecordStatus(r)).toBe('partial');
  });
});

describe('why it matters — a false-green row is unretryable', () => {
  test('"complete wins" makes a complete-over-failure row permanent', () => {
    // This is the shape the bug wrote: status complete, install phase failed.
    const falseGreen = [
      { ts: '2026-01-01T00:00:00.000Z', version: '0.11.0', status: 'complete' as const,
        phases: [ok('schema'), failed('install')] },
    ];
    expect(statusForVersion('0.11.0', indexCompletedEntries(falseGreen))).toBe('complete');

    // Appending a later partial cannot rescue it — by design.
    const withPartial = [...falseGreen,
      { ts: '2026-01-02T00:00:00.000Z', version: '0.11.0', status: 'partial' as const, phases: [] }];
    expect(statusForVersion('0.11.0', indexCompletedEntries(withPartial))).toBe('complete');
  });

  test('recording partial instead keeps the migration retryable', () => {
    const honest = [
      { ts: '2026-01-01T00:00:00.000Z', version: '0.11.0', status: 'partial' as const,
        phases: [ok('schema'), failed('install')] },
    ];
    expect(statusForVersion('0.11.0', indexCompletedEntries(honest))).toBe('partial');
  });

  test('an existing false-green row is recoverable only via an explicit retry marker', () => {
    // Documented escape hatch for brains already carrying a bad row.
    const withRetry = [
      { ts: '2026-01-01T00:00:00.000Z', version: '0.11.0', status: 'complete' as const,
        phases: [failed('install')] },
      { ts: '2026-01-02T00:00:00.000Z', version: '0.11.0', status: 'retry' as const },
    ];
    expect(statusForVersion('0.11.0', indexCompletedEntries(withRetry as never))).toBe('pending');
  });
});
