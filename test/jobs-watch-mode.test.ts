/**
 * v0.42.15.0 (#1784) — jobs-watch format × loop matrix.
 *
 * Pins resolveWatchMode so the TTY-gating contract can't regress. The bug this
 * guards: TTY + --json used to loop forever (follow defaulted to isTTY); the
 * documented matrix says --json one-shots unless --follow. Caught by codex in
 * the pre-landing review; the e2e missed it (non-TTY only).
 */
import { describe, test, expect } from 'bun:test';
import { resolveWatchMode } from '../src/commands/jobs-watch.ts';

describe('resolveWatchMode — format × loop matrix', () => {
  test('TTY, no flags → live dashboard (json off, follow on, ansi on)', () => {
    expect(resolveWatchMode({}, true)).toEqual({ json: false, follow: true, useAnsiDashboard: true });
  });

  test('non-TTY, no flags → one human snapshot (the bug fix: not JSON, one-shot)', () => {
    expect(resolveWatchMode({}, false)).toEqual({ json: false, follow: false, useAnsiDashboard: false });
  });

  test('TTY + --json → ONE JSON snapshot, NOT a forever loop (codex finding)', () => {
    expect(resolveWatchMode({ json: true }, true)).toEqual({ json: true, follow: false, useAnsiDashboard: false });
  });

  test('non-TTY + --json → one JSON snapshot', () => {
    expect(resolveWatchMode({ json: true }, false)).toEqual({ json: true, follow: false, useAnsiDashboard: false });
  });

  test('TTY + --follow → live dashboard loops', () => {
    expect(resolveWatchMode({ follow: true }, true)).toEqual({ json: false, follow: true, useAnsiDashboard: true });
  });

  test('non-TTY + --follow → plain human stream (loops, no ansi)', () => {
    expect(resolveWatchMode({ follow: true }, false)).toEqual({ json: false, follow: true, useAnsiDashboard: false });
  });

  test('--json --follow → JSONL stream, never the ansi dashboard', () => {
    expect(resolveWatchMode({ json: true, follow: true }, true)).toEqual({ json: true, follow: true, useAnsiDashboard: false });
  });

  test('explicit --follow false on a TTY → one-shot (override wins)', () => {
    expect(resolveWatchMode({ follow: false }, true)).toEqual({ json: false, follow: false, useAnsiDashboard: false });
  });
});
