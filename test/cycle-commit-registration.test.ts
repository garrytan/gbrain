/**
 * test/cycle-commit-registration.test.ts
 *
 * Structural pin: assert that 'commit' is present in ALL_PHASES as the last
 * element (after 'purge'), that PHASE_SCOPE.commit === 'global', and that
 * NEEDS_LOCK_PHASES includes 'commit'.
 *
 * Zero DB, zero filesystem, zero network.
 */

import { describe, test, expect } from 'bun:test';
import { ALL_PHASES, PHASE_SCOPE, NEEDS_LOCK_PHASES } from '../src/core/cycle.ts';

describe('commit phase registration', () => {
  test('ALL_PHASES includes commit', () => {
    expect(ALL_PHASES).toContain('commit');
  });

  test('commit is the LAST element in ALL_PHASES (after purge)', () => {
    const last = ALL_PHASES[ALL_PHASES.length - 1];
    expect(last).toBe('commit');

    const purgeIdx = ALL_PHASES.indexOf('purge');
    const commitIdx = ALL_PHASES.indexOf('commit');
    expect(purgeIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBe(purgeIdx + 1);
  });

  test('PHASE_SCOPE.commit === global', () => {
    expect(PHASE_SCOPE.commit).toBe('global');
  });

  test('NEEDS_LOCK_PHASES.has(commit) === true', () => {
    expect(NEEDS_LOCK_PHASES.has('commit')).toBe(true);
  });
});
