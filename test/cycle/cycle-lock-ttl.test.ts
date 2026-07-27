// v0.41.19.0 — T2 of ops-fix-wave.
//
// Regression pin: the cycle DB lock TTL was dropped from 30 min to 5 min
// in v0.41.19.0 (T2). Combined with active in-phase refresh via
// buildYieldDuringPhase (T3) this makes crash recovery 6× faster
// (≤5min vs ≤30min before).
//
// This test pins the constant via the migration query observable. If
// the TTL ever climbs back above 5 min, the ops pain comes back.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('cycle lock TTL (T2 regression pin)', () => {
  test('LOCK_TTL_MINUTES === 5 in src/core/cycle.ts', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'core', 'cycle.ts'),
      'utf-8',
    );
    // Pin the literal constant value. Two patterns guarded:
    //   - LOCK_TTL_MINUTES = 5
    //   - LOCK_TTL_MS = 5 * 60 * 1000
    expect(src).toMatch(/LOCK_TTL_MINUTES\s*=\s*5\b/);
    expect(src).toMatch(/LOCK_TTL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
    // And explicitly disallow the prior 30-minute value re-creeping back.
    expect(src).not.toMatch(/LOCK_TTL_MINUTES\s*=\s*30\b/);
  });
});
