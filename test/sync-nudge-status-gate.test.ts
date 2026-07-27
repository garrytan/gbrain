/**
 * v0.42.7 (#1696, D5) — the end-of-sync extraction-lag nudge status gate.
 *
 * Codex caught that the single-source nudge was gated `=== 'synced'`, which
 * skips `first_sync` (a fresh / --full import — the BIGGEST un-extracted
 * backlog, the exact 280K-page scenario #1696 exists for) and `up_to_date`.
 * `shouldNudgeAfterSync` is the pure predicate the call site now uses; this
 * pins its contract so the gate can't silently narrow back to `synced` only.
 *
 * Pure predicate test — no PGLite, no env mutation, no module stubbing (R1-R4 compliant).
 */

import { describe, test, expect } from 'bun:test';
import { shouldNudgeAfterSync } from '../src/commands/sync.ts';

describe('shouldNudgeAfterSync (D5 status gate)', () => {
  test('fires on first_sync — the biggest-backlog initial-import case', () => {
    expect(shouldNudgeAfterSync('first_sync')).toBe(true);
  });

  test('fires on synced (incremental)', () => {
    expect(shouldNudgeAfterSync('synced')).toBe(true);
  });

  test('fires on up_to_date (no-op sync over a pre-existing backlog)', () => {
    expect(shouldNudgeAfterSync('up_to_date')).toBe(true);
  });

  test('does NOT fire on dry_run (preview, no real sync)', () => {
    expect(shouldNudgeAfterSync('dry_run')).toBe(false);
  });

  test('does NOT fire on blocked_by_failures (inconsistent state)', () => {
    expect(shouldNudgeAfterSync('blocked_by_failures')).toBe(false);
  });

  test('does NOT fire on partial (inconsistent state)', () => {
    expect(shouldNudgeAfterSync('partial')).toBe(false);
  });
});
