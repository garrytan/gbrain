/**
 * #1633 wiring: resolveSyncHardDeadline precedence + composeAbortSignals.
 * Pure (no engine, no env mutation — env is injected per-call).
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveSyncHardDeadline,
  composeAbortSignals,
  resolveStallAbortSeconds,
  DEFAULT_SYNC_STALL_ABORT_SEC,
  HARD_DEADLINE_GRACE_SEC,
} from '../src/commands/sync.ts';
import { syncDeadlineStopNotice } from '../src/core/sync-reconcile.ts';

const GRACE_MS = HARD_DEADLINE_GRACE_SEC * 1000;

describe('resolveStallAbortSeconds (#1950)', () => {
  test('defaults to 900s when the env var is unset or empty', () => {
    expect(resolveStallAbortSeconds({})).toBe(DEFAULT_SYNC_STALL_ABORT_SEC);
    expect(resolveStallAbortSeconds({ GBRAIN_SYNC_STALL_ABORT_SECONDS: '' })).toBe(900);
  });

  test('honors a positive override', () => {
    expect(resolveStallAbortSeconds({ GBRAIN_SYNC_STALL_ABORT_SECONDS: '120' })).toBe(120);
  });

  test('<=0 disables the watchdog (returned verbatim)', () => {
    expect(resolveStallAbortSeconds({ GBRAIN_SYNC_STALL_ABORT_SECONDS: '0' })).toBe(0);
    expect(resolveStallAbortSeconds({ GBRAIN_SYNC_STALL_ABORT_SECONDS: '-1' })).toBe(-1);
  });

  test('falls back to the default on a non-numeric value', () => {
    expect(resolveStallAbortSeconds({ GBRAIN_SYNC_STALL_ABORT_SECONDS: 'nope' })).toBe(900);
  });
});

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

  test('--timeout (single-source) auto-arms the hard backstop one grace window after the timeout', () => {
    // The in-band --timeout stop (partial, exit 0) must land before the
    // watchdog's SIGTERM (exit 143), so the backstop sits past the timeout.
    const r = resolveSyncHardDeadline(['--source', 'briefings', '--timeout', '480'], { isTty: false });
    expect(r).toEqual({ deadlineMs: 480_000 + GRACE_MS, graceMs: GRACE_MS, reason: 'flag:--timeout' });
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
    expect(r).toEqual({ deadlineMs: 900_000, graceMs: GRACE_MS, reason: 'env:GBRAIN_SYNC_MAX_RUNTIME_SECONDS', progressWindowMs: 900_000 });
  });

  test('env 0 disables (overrides the non-TTY default)', () => {
    const r = resolveSyncHardDeadline([], { isTty: false, env: { GBRAIN_SYNC_MAX_RUNTIME_SECONDS: '0' } });
    expect(r).toBeNull();
  });

  test('non-TTY default is 3600s', () => {
    const r = resolveSyncHardDeadline([], { isTty: false });
    expect(r).toEqual({ deadlineMs: 3_600_000, graceMs: GRACE_MS, reason: 'default:non-tty', progressWindowMs: 900_000 });
  });

  test('TTY interactive with no flag/env arms nothing', () => {
    expect(resolveSyncHardDeadline([], { isTty: true })).toBeNull();
  });

  test('defaultNonTtySec override is honored', () => {
    const r = resolveSyncHardDeadline([], { isTty: false, defaultNonTtySec: 60 });
    expect(r?.deadlineMs).toBe(60_000);
  });
});

// F4d: the default and env deadlines must never stop a sync that is still
// importing; the explicit flags stay strict wall-clock caps.
describe('progress-aware sync deadline (large-brain ceiling)', () => {
  test('default and env deadlines carry the stall window as their progress window', () => {
    expect(resolveSyncHardDeadline([], { isTty: false, env: { GBRAIN_SYNC_STALL_ABORT_SECONDS: '120' } })?.progressWindowMs).toBe(120_000);
    expect(resolveSyncHardDeadline([], { isTty: true, env: { GBRAIN_SYNC_MAX_RUNTIME_SECONDS: '60', GBRAIN_SYNC_STALL_ABORT_SECONDS: '30' } })?.progressWindowMs).toBe(30_000);
  });

  test('a disabled stall watchdog still leaves a default progress window, never a hair trigger', () => {
    expect(resolveSyncHardDeadline([], { isTty: false, env: { GBRAIN_SYNC_STALL_ABORT_SECONDS: '0' } })?.progressWindowMs)
      .toBe(DEFAULT_SYNC_STALL_ABORT_SEC * 1000);
  });

  test('--hard-deadline and --timeout stay strict (no progress window)', () => {
    expect(resolveSyncHardDeadline(['--hard-deadline', '120'], { isTty: false })?.progressWindowMs).toBeUndefined();
    expect(resolveSyncHardDeadline(['--source', 'x', '--timeout', '60'], { isTty: false })?.progressWindowMs).toBeUndefined();
  });

  test('the stop notice names the cause, the code and the exact resume command', () => {
    const res = resolveSyncHardDeadline([], { isTty: false })!;
    const line = syncDeadlineStopNotice(['--source', 'notes', '--no-pull'], res);
    expect(line).toContain('code=sync_deadline_stop');
    expect(line).toContain('the 3600s sync deadline (default:non-tty) passed and the run made no progress for 900s');
    expect(line).toContain('Resume with: gbrain sync --source notes --no-pull.');
  });

  test('under --json the stop notice is one parseable object', () => {
    const res = resolveSyncHardDeadline(['--hard-deadline', '60'], { isTty: false })!;
    const notice = JSON.parse(syncDeadlineStopNotice(['--hard-deadline', '60', '--json'], res));
    expect(notice).toMatchObject({ status: 'stopped', code: 'sync_deadline_stop', deadline_seconds: 60, progress_window_seconds: null,
      resume_command: 'gbrain sync --hard-deadline 60 --json' });
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
