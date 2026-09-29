import { describe, expect, test } from 'bun:test';
import { readSourceCycleTimestamps } from '../src/core/source-cycle-state.ts';
import type { SourceRow } from '../src/core/engine.ts';

function source(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 'repo',
    incarnation: '00000000-0000-4000-8000-000000000001',
    name: 'repo',
    local_path: '/repo',
    last_sync_at: null,
    config: { last_source_cycle_at: '2026-01-01T00:00:00.000Z', last_full_cycle_at: '2026-01-02T00:00:00.000Z' },
    ...overrides,
  };
}

describe('source-cycle-state freshness resolution', () => {
  test('falls back to legacy config only when no current-incarnation row exists', () => {
    const result = readSourceCycleTimestamps(source());
    expect(result.lastSourceCycleAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(result.lastFullCycleAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  test('current-incarnation state takes precedence over legacy config', () => {
    const result = readSourceCycleTimestamps(source({
      cycle_state_exists: true,
      last_source_cycle_at: new Date('2026-02-01T00:00:00.000Z'),
      last_full_cycle_at: new Date('2026-02-02T00:00:00.000Z'),
    }));
    expect(result.lastSourceCycleAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(result.lastFullCycleAt?.toISOString()).toBe('2026-02-02T00:00:00.000Z');
  });

  test('invalid legacy values resolve to null while future valid timestamps remain parseable', () => {
    const result = readSourceCycleTimestamps(source({
      config: {
        last_source_cycle_at: '2026-13-99T25:61:61.000Z',
        last_full_cycle_at: '2099-01-01T00:00:00.000Z',
      },
    }));
    expect(result.lastSourceCycleAt).toBeNull();
    expect(result.lastFullCycleAt?.toISOString()).toBe('2099-01-01T00:00:00.000Z');
  });

  test('an existing current-incarnation row with NULL timestamps does not resurrect legacy timestamps', () => {
    const result = readSourceCycleTimestamps(source({
      cycle_state_exists: true,
      last_source_cycle_at: null,
      last_full_cycle_at: null,
    }));
    expect(result).toEqual({ lastSourceCycleAt: null, lastFullCycleAt: null });
  });
});
