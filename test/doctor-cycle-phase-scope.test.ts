/**
 * v0.38 — doctor cycle_phase_scope check unit test.
 *
 * Pure function — no engine required. Asserts the check renders the
 * taxonomy correctly and surfaces phase_scope_map in `details` for
 * JSON consumers.
 */
import { describe, test, expect } from 'bun:test';
import { checkCyclePhaseScope } from '../src/commands/doctor.ts';
import { ALL_PHASES, PHASE_SCOPE } from '../src/core/cycle.ts';

describe('doctor checkCyclePhaseScope', () => {
  test('status is always ok (informational check)', () => {
    const result = checkCyclePhaseScope();
    expect(result.status).toBe('ok');
    expect(result.name).toBe('cycle_phase_scope');
  });

  test('message includes per-scope counts', () => {
    const result = checkCyclePhaseScope();
    // Should describe the source/global/mixed split
    expect(result.message).toMatch(/source-scoped/);
    expect(result.message).toMatch(/brain-global/);
    expect(result.message).toMatch(/mixed/);
  });

  test('message lists each phase under its scope bucket', () => {
    const result = checkCyclePhaseScope();
    // Pick a few known anchors per scope
    expect(result.message).toMatch(/sync/);   // source
    expect(result.message).toMatch(/embed/);  // global
    expect(result.message).toMatch(/patterns/); // mixed
  });

  test('details.phase_scope_map mirrors PHASE_SCOPE record', () => {
    const result = checkCyclePhaseScope();
    expect(result.details).toBeDefined();
    const map = result.details?.phase_scope_map as Record<string, string>;
    expect(map).toBeDefined();
    // Every phase in ALL_PHASES present in the map
    for (const phase of ALL_PHASES) {
      expect(map[phase]).toBe(PHASE_SCOPE[phase]);
    }
  });

  test('details.counts sums to ALL_PHASES.length', () => {
    const result = checkCyclePhaseScope();
    const counts = result.details?.counts as Record<string, number>;
    expect(counts).toBeDefined();
    expect(counts.source + counts.global + counts.mixed).toBe(ALL_PHASES.length);
  });
});
