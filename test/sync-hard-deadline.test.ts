/**
 * #1633 wiring: resolveSyncHardDeadline precedence + composeAbortSignals.
 * Pure (no engine, no env mutation — env is injected per-call).
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveSyncHardDeadline,
  composeAbortSignals,
  HARD_DEADLINE_GRACE_SEC,
} from '../src/commands/sync.ts';

const GRACE_MS = HARD_DEADLINE_GRACE_SEC * 1000;

describe('resolveSyncHardDeadline', () => {
  test('--no-hard-deadline disables everything (even with --timeout)', () => {
    const r = resolveSyncHardDeadline(['--source', 'x', '--timeout', '60', '--no-hard-deadline'], { isTty: false });
    expect(r).toBeNull();
  });

  test('--hard-deadline wins and sets the deadline (with grace)', () => {
    const r = resolveSyncHardDeadline(['--hard-deadline', '120'], { isTty: true });
    expect(r).toEqual({ deadlineMs: 120_000, graceMs: GRACE_MS, reason: 'flag:--hard-deadline' });
  });

  test('--hard-deadline accepts s/m/h suffix', () => {
    expect(resolveSyncHardDeadline(['--hard-deadline', '2m'], { isTty: true })?.deadlineMs).toBe(120_000);
  });

  test('--hard-deadline with a bad value throws (same posture as --timeout)', () => {
    expect(() => resolveSyncHardDeadline(['--hard-deadline', 'nope'], { isTty: true })).toThrow();
    expect(() => resolveSyncHardDeadline(['--hard-deadline', '0'], { isTty: true })).toThrow();
  });

  test('--timeout (single-source) auto-arms the hard backstop', () => {
    const r = resolveSyncHardDeadline(['--source', 'briefings', '--timeout', '480'], { isTty: false });
    expect(r).toEqual({ deadlineMs: 480_000, graceMs: GRACE_MS, reason: 'flag:--timeout' });
  });

  test('--timeout + --all does NOT auto-arm (per-source budgets); falls through', () => {
    // Non-TTY → falls to the default; TTY → null.
    const nonTty = resolveSyncHardDeadline(['--all', '--timeout', '60'], { isTty: false });
    expect(nonTty?.reason).toBe('default:non-tty');
    const tty = resolveSyncHardDeadline(['--all', '--timeout', '60'], { isTty: true });
    expect(tty).toBeNull();
  });

  test('env GBRAIN_SYNC_MAX_RUNTIME_SECONDS sets the deadline', () => {
    const r = resolveSyncHardDeadline([], { isTty: true, env: { GBRAIN_SYNC_MAX_RUNTIME_SECONDS: '900' } });
    expect(r).toEqual({ deadlineMs: 900_000, graceMs: GRACE_MS, reason: 'env:GBRAIN_SYNC_MAX_RUNTIME_SECONDS' });
  });

  test('env 0 disables (overrides the non-TTY default)', () => {
    const r = resolveSyncHardDeadline([], { isTty: false, env: { GBRAIN_SYNC_MAX_RUNTIME_SECONDS: '0' } });
    expect(r).toBeNull();
  });

  test('non-TTY default is 3600s', () => {
    const r = resolveSyncHardDeadline([], { isTty: false });
    expect(r).toEqual({ deadlineMs: 3_600_000, graceMs: GRACE_MS, reason: 'default:non-tty' });
  });

  test('TTY interactive with no flag/env arms nothing', () => {
    expect(resolveSyncHardDeadline([], { isTty: true })).toBeNull();
  });

  test('defaultNonTtySec override is honored', () => {
    const r = resolveSyncHardDeadline([], { isTty: false, defaultNonTtySec: 60 });
    expect(r?.deadlineMs).toBe(60_000);
  });
});

describe('composeAbortSignals', () => {
  test('all-undefined returns undefined', () => {
    expect(composeAbortSignals(undefined, undefined)).toBeUndefined();
  });

  test('single signal is returned directly (no wrapper)', () => {
    const c = new AbortController();
    expect(composeAbortSignals(c.signal, undefined)).toBe(c.signal);
  });

  test('composite aborts when ANY input aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const sig = composeAbortSignals(a.signal, b.signal)!;
    expect(sig.aborted).toBe(false);
    b.abort(new Error('boom'));
    expect(sig.aborted).toBe(true);
  });
});
