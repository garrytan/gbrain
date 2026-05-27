/**
 * Tests for translatePositionalSubcommands() — the v0.41.x #1525 fix that
 * prevents `gbrain autopilot status` from silently starting the daemon.
 *
 * IRON RULE regression guard: the exact ticket repro (`gbrain autopilot
 * status`) MUST translate to `--status`, not fall through to the default
 * daemon launch. Verified by the "ticket-exact repro" case below.
 */

import { describe, test, expect } from 'bun:test';
import { translatePositionalSubcommands } from '../src/commands/autopilot.ts';

describe('translatePositionalSubcommands — known aliases', () => {
  test('IRON RULE — `autopilot status` translates to `--status` (ticket #1525 repro)', () => {
    const r = translatePositionalSubcommands(['status']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--status']);
  });

  test('`install` translates to `--install`', () => {
    const r = translatePositionalSubcommands(['install']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--install']);
  });

  test('`uninstall` translates to `--uninstall`', () => {
    const r = translatePositionalSubcommands(['uninstall']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--uninstall']);
  });

  test('`start` drops the positional (default daemon launch)', () => {
    const r = translatePositionalSubcommands(['start']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual([]);
  });

  test('`start --json` drops only the positional, keeps the flag', () => {
    const r = translatePositionalSubcommands(['start', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--json']);
  });
});

describe('translatePositionalSubcommands — flag/positional interleaving', () => {
  test('`status --json` preserves the trailing flag', () => {
    const r = translatePositionalSubcommands(['status', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--status', '--json']);
  });

  test('`--json status` preserves the leading flag', () => {
    const r = translatePositionalSubcommands(['--json', 'status']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--json', '--status']);
  });

  test('`--repo /foo status` does not mis-classify the path as positional', () => {
    const r = translatePositionalSubcommands(['--repo', '/foo', 'status']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--repo', '/foo', '--status']);
  });

  test('`--interval 300 install` does not mis-classify the number as positional', () => {
    const r = translatePositionalSubcommands(['--interval', '300', 'install']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--interval', '300', '--install']);
  });

  test('value-flag at end of argv with missing value passes through (so parseArg can report it)', () => {
    const r = translatePositionalSubcommands(['--repo']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--repo']);
  });

  test('value-flag whose value looks like an alias is NOT translated', () => {
    // `--repo status` means "use repo path 'status'", not "show status".
    // Translator must not destructure the value of --repo.
    const r = translatePositionalSubcommands(['--repo', 'status']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--repo', 'status']);
  });
});

describe('translatePositionalSubcommands — pass-through cases', () => {
  test('empty args returns empty args', () => {
    const r = translatePositionalSubcommands([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual([]);
  });

  test('flag-only invocation passes through unchanged', () => {
    const r = translatePositionalSubcommands(['--status', '--json']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['--status', '--json']);
  });

  test('short flag `-h` passes through unchanged', () => {
    const r = translatePositionalSubcommands(['-h']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(['-h']);
  });

  test('all known bare flags pass through unchanged', () => {
    const flags = ['--help', '--install', '--uninstall', '--status', '--json', '--inline', '--no-worker'];
    const r = translatePositionalSubcommands(flags);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual(flags);
  });
});

describe('translatePositionalSubcommands — rejection of unknown positionals', () => {
  test('unknown positional `foo` fails with reason=unknown_subcommand + structured message', () => {
    const r = translatePositionalSubcommands(['foo']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown_subcommand');
      expect(r.message).toContain('Unknown subcommand: `foo`');
      expect(r.message).toContain('status');
      expect(r.message).toContain('install');
      expect(r.message).toContain('uninstall');
      expect(r.message).toContain('--help');
    }
  });

  test('unknown positional `stop` fails with reason=unknown_subcommand (NOT silently aliased)', () => {
    // Stop is mentioned in the ticket but deliberately NOT aliased in this
    // PR — stopping a running daemon is a new behavior, not just an alias.
    // Until that feature lands separately, `stop` must fail loud rather
    // than starting the daemon (the bug we're fixing).
    const r = translatePositionalSubcommands(['stop']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown_subcommand');
      expect(r.message).toContain('Unknown subcommand: `stop`');
    }
  });

  test('unknown positional `status-detail` (close-but-not-matching) fails', () => {
    const r = translatePositionalSubcommands(['status-detail']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown_subcommand');
      expect(r.message).toContain('Unknown subcommand: `status-detail`');
    }
  });

  test('multiple positionals fail with reason=multiple_subcommands (`start install`)', () => {
    const r = translatePositionalSubcommands(['start', 'install']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('multiple_subcommands');
      expect(r.message).toContain('Multiple subcommands');
    }
  });

  test('multiple positionals fail even when both are known aliases (`status install`)', () => {
    const r = translatePositionalSubcommands(['status', 'install']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('multiple_subcommands');
      expect(r.message).toContain('Multiple subcommands');
    }
  });

  test('known-then-unknown rejects with multiple_subcommands (first-positional-wins)', () => {
    // First positional is known, second is not. Rejection comes from the
    // multiple-positional rule, which fires before the unknown check; the
    // intent is "only one subcommand allowed."
    const r = translatePositionalSubcommands(['status', 'garbage']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('multiple_subcommands');
  });

  test('unknown-then-known rejects on the unknown (unknown fires before second-positional check)', () => {
    const r = translatePositionalSubcommands(['garbage', 'status']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown_subcommand');
      expect(r.message).toContain('garbage');
    }
  });
});
