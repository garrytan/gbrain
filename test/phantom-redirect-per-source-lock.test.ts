/**
 * v0.40 D16 regression test: phantom-redirect uses per-source lock.
 *
 * Pre-v0.40 phantom-redirect acquired the bare `gbrain-sync` lock, blocking
 * every concurrent sync brain-wide. After D16, phantom acquires
 * `gbrain-sync:<sourceId>` — same-source sync still serializes; cross-source
 * sync proceeds unblocked.
 *
 * Pure source-text regression guard. The full behavior is covered by
 * `test/e2e/phantom-redirect.test.ts` (DATABASE_URL-gated). This file pins
 * the lock-id construction so any future drift back to the bare constant
 * fails loudly in the fast unit loop.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { syncLockId } from '../src/core/db-lock.ts';

const SRC = readFileSync('src/core/cycle/phantom-redirect.ts', 'utf8');

describe('phantom-redirect lock contract', () => {
  test('IRON-RULE: import line uses syncLockId, not bare SYNC_LOCK_ID', () => {
    // syncLockId must be imported; SYNC_LOCK_ID must NOT be (per-source posture).
    const importLine = SRC.split('\n').find((l) =>
      l.includes("from '../db-lock.ts'") && l.includes('import'),
    );
    expect(importLine).toBeDefined();
    expect(importLine).toContain('syncLockId');
    expect(importLine).not.toMatch(/\bSYNC_LOCK_ID\b/);
  });

  test('IRON-RULE: acquireLockWithRetry call passes syncLockId(sourceId)', () => {
    // Banned: the bare `SYNC_LOCK_ID` constant slipped back in.
    // Required: the per-source helper threaded with the active sourceId.
    expect(SRC).toMatch(/acquireLockWithRetry\s*\(\s*engine\s*,\s*syncLockId\s*\(\s*sourceId\s*\)\s*\)/);
    expect(SRC).not.toMatch(/acquireLockWithRetry\s*\(\s*engine\s*,\s*SYNC_LOCK_ID\s*\)/);
  });

  test('helper sanity: syncLockId returns gbrain-sync:<source> shape', () => {
    expect(syncLockId('default')).toBe('gbrain-sync:default');
    expect(syncLockId('zion-brain')).toBe('gbrain-sync:zion-brain');
  });
});
