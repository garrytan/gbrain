/**
 * #4517 — ~/.gbrain/upgrade-errors.jsonl is APPEND-ONLY, and doctor
 * unconditionally warned from its LAST line on every run, forever — even
 * years after the failed upgrade was retried and completed. The check now
 * re-verifies: when the running binary is at/past the failed record's
 * to_version AND the schema ledger is current, the warn downgrades to ok.
 *
 * `upgradeErrorResolved` is the pure decision fn (exported for tests).
 */

import { describe, test, expect } from 'bun:test';
import { upgradeErrorResolved } from '../src/commands/doctor.ts';

describe('upgradeErrorResolved (#4517)', () => {
  test('resolved: binary moved past the failed target and schema is current', () => {
    expect(upgradeErrorResolved('0.46.10.0', '0.46.28.0', true)).toBe(true);
  });

  test('resolved: binary is exactly the failed target (retry landed it)', () => {
    expect(upgradeErrorResolved('0.46.28.0', '0.46.28.0', true)).toBe(true);
  });

  test('NOT resolved: binary is still older than the failed target', () => {
    expect(upgradeErrorResolved('0.46.28.0', '0.46.10.0', true)).toBe(false);
  });

  test('NOT resolved: pending migrations keep the warning even on a newer binary', () => {
    expect(upgradeErrorResolved('0.46.10.0', '0.46.28.0', false)).toBe(false);
  });

  test('4th (MICRO) segment is compared — 0.31.4.0 binary does not resolve a 0.31.4.1 failure', () => {
    expect(upgradeErrorResolved('0.31.4.1', '0.31.4.0', true)).toBe(false);
    expect(upgradeErrorResolved('0.31.4.0', '0.31.4.1', true)).toBe(true);
  });

  test('leading v is tolerated', () => {
    expect(upgradeErrorResolved('v0.46.10.0', '0.46.28.0', true)).toBe(true);
  });

  test('fails closed on malformed versions (keeps warning)', () => {
    expect(upgradeErrorResolved('garbage', '0.46.28.0', true)).toBe(false);
    expect(upgradeErrorResolved('0.46.10.0', 'garbage', true)).toBe(false);
    expect(upgradeErrorResolved(undefined as unknown as string, '0.46.28.0', true)).toBe(false);
  });
});
