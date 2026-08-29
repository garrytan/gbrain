/**
 * Serve-delegated sync — CLI ladder pins (commands/sync-delegate.ts).
 *
 * The load-bearing property is DEFAULT-DENY: any sync argv token outside the
 * explicit allowlist refuses by name. A silently-dropped `--exclude` or
 * `--src-subpath` would perform the WRONG sync (whole repo instead of the
 * scoped subset) — refusing is the only safe default, and it means every
 * FUTURE sync flag is delegation-safe until someone classifies it.
 *
 * Parallel-safe: pure functions + hermetic tmpdir lock fixtures; no env
 * mutation (deriveDelegatedTimeoutSeconds takes injected env/tty). The
 * brain/source gate tests swap the cli-options singleton and console.error
 * (serr's fallthrough) via try/finally restore — still no env mutation.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IGNORED_FLAGS,
  VALUE_FLAGS,
  WIRE_BOOL_FLAGS,
  deriveDelegatedTimeoutSeconds,
  maybeDelegateSyncToServe,
  parseDelegatedSyncArgs,
} from '../src/commands/sync-delegate.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { getCliOptions, setCliOptions } from '../src/core/cli-options.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';

/** Lock dir whose holder is a provably-alive serve (the PID is us). */
function dirWithLiveServeLock(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sdl-'));
  mkdirSync(join(dir, '.gbrain-lock'), { recursive: true });
  writeFileSync(
    join(dir, '.gbrain-lock', 'lock'),
    JSON.stringify({
      pid: process.pid, // provably alive: it is us
      acquired_at: new Date().toISOString(),
      refreshed_at: new Date().toISOString(),
      command: '/x/gbrain/src/cli.ts serve',
      subcommand: 'serve',
    }),
  );
  return dir;
}

/** Run fn with the cli-options singleton's brain overridden, then restore. */
async function withBrainOption<T>(brain: string, fn: () => Promise<T>): Promise<T> {
  const prev = getCliOptions();
  setCliOptions({ ...prev, brain });
  try {
    return await fn();
  } finally {
    setCliOptions(prev);
  }
}

/** Collect console.error lines (serr's no-prefix fallthrough), restorable. */
function captureConsoleError(): { lines: string[]; restore: () => void } {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.error = orig; } };
}

describe('parseDelegatedSyncArgs (default-deny)', () => {
  test('bare sync → empty options, no explicit source', () => {
    expect(parseDelegatedSyncArgs([])).toEqual({ ok: true, options: {}, explicitSource: null });
  });

  test('the full wire-forwardable set maps field-for-field', () => {
    const r = parseDelegatedSyncArgs([
      '--full', '--dry-run', '--no-pull', '--no-embed', '--no-extract',
      '--no-schema-pack', '--skip-failed', '--retry-failed', '--include-gitignored',
      '--source', 'notes',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.options).toEqual({
      full: true, dryRun: true, noPull: true, noEmbed: true, noExtract: true,
      noSchemaPack: true, skipFailed: true, retryFailed: true, includeGitignored: true,
    });
    expect(r.explicitSource).toBe('notes');
  });

  test('deadline/prompt flags are consumed or ignored, never refused', () => {
    expect(parseDelegatedSyncArgs(['--timeout', '60', '--yes', '--no-hard-deadline', '--no-delegate']).ok).toBe(true);
    expect(parseDelegatedSyncArgs(['--hard-deadline', '2h']).ok).toBe(true);
  });

  test.each([
    ['--repo'], ['--watch'], ['--all'], ['--workers'], ['--concurrency'],
    ['--json'], ['--exclude'], ['--src-subpath'], ['--break-lock'],
    ['--force-break-lock'], ['--max-age'], ['--missing-path'], ['--parallel'],
    ['--interval'], ['--serial'], ['--strategy'], ['trigger'],
    ['--some-flag-added-in-2027'],
  ])('refuses %s by name (default-deny)', (tok) => {
    expect(parseDelegatedSyncArgs([tok])).toEqual({ ok: false, refused: tok });
  });

  test('a value flag with a missing/flag-shaped value refuses loudly', () => {
    expect(parseDelegatedSyncArgs(['--source'])).toEqual({ ok: false, refused: '--source (missing value)' });
    expect(parseDelegatedSyncArgs(['--source', '--full'])).toEqual({ ok: false, refused: '--source (missing value)' });
  });

  test('every allowlisted flag exists in the generated sync flag registry', () => {
    // Drift pin (eng-review F5): the pre-dispatch validator rejects flags the
    // registry doesn't know — an allowlist entry missing from the registry
    // would be dead on arrival. (The reverse direction is covered by
    // default-deny: unclassified registry flags refuse at runtime.)
    const registry = new Set(CLI_FLAG_REGISTRY['sync']);
    for (const flag of [...Object.keys(WIRE_BOOL_FLAGS), ...VALUE_FLAGS, ...IGNORED_FLAGS]) {
      expect(registry.has(flag)).toBe(true);
    }
  });
});

describe('deriveDelegatedTimeoutSeconds', () => {
  const noEnv = {};
  test('--no-hard-deadline is the ONLY unbounded encoding (0 = no server timer)', async () => {
    expect(await deriveDelegatedTimeoutSeconds(['--no-hard-deadline'], { isTty: true, env: noEnv })).toBe(0);
  });
  test('interactive TTY default maps to the same 3600s the non-TTY default uses', async () => {
    expect(await deriveDelegatedTimeoutSeconds([], { isTty: true, env: noEnv })).toBe(3600);
    expect(await deriveDelegatedTimeoutSeconds([], { isTty: false, env: noEnv })).toBe(3600);
  });
  test('explicit flags win: --hard-deadline then --timeout', async () => {
    expect(await deriveDelegatedTimeoutSeconds(['--hard-deadline', '120'], { isTty: true, env: noEnv })).toBe(120);
    expect(await deriveDelegatedTimeoutSeconds(['--timeout', '60'], { isTty: true, env: noEnv })).toBe(60);
  });
  test('env knob applies when set', async () => {
    expect(
      await deriveDelegatedTimeoutSeconds([], { isTty: true, env: { GBRAIN_SYNC_MAX_RUNTIME_SECONDS: '900' } }),
    ).toBe(900);
  });
});

describe('maybeDelegateSyncToServe short-circuits (no socket I/O)', () => {
  test('no holder → false (normal connect path, REGRESSION pin)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdl-empty-'));
    expect(await maybeDelegateSyncToServe(dir, [])).toBe(false);
  });

  test('--no-delegate opts out even under a live serve', async () => {
    const dir = dirWithLiveServeLock();
    expect(await maybeDelegateSyncToServe(dir, ['--no-delegate'])).toBe(false);
  });

  test('live NON-serve holder → false (existing bounded-wait behavior)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdl-cli-'));
    mkdirSync(join(dir, '.gbrain-lock'), { recursive: true });
    writeFileSync(
      join(dir, '.gbrain-lock', 'lock'),
      JSON.stringify({ pid: process.pid, subcommand: 'embed', command: 'cli.ts embed' }),
    );
    expect(await maybeDelegateSyncToServe(dir, [])).toBe(false);
  });

  test('live serve + unsupported flag → handled (named refusal, no socket needed)', async () => {
    const dir = dirWithLiveServeLock();
    const savedExitCode = process.exitCode;
    try {
      expect(await maybeDelegateSyncToServe(dir, ['--repo', '/tmp/x'])).toBe(true);
    } finally {
      _resetCliExitVerdictForTests();
      // setCliExitVerdict mirrors into process.exitCode — undo, or this FILE
      // exits 1 with 0 fails. `?? 0`: Bun ignores an undefined assignment.
      process.exitCode = savedExitCode ?? 0;
    }
  });

  test('live serve + no IPC socket → handled (polite refusal)', async () => {
    const dir = dirWithLiveServeLock();
    const savedExitCode = process.exitCode;
    try {
      expect(await maybeDelegateSyncToServe(dir, [])).toBe(true);
    } finally {
      _resetCliExitVerdictForTests();
      // setCliExitVerdict mirrors into process.exitCode — undo, or this FILE
      // exits 1 with 0 fails. `?? 0`: Bun ignores an undefined assignment.
      process.exitCode = savedExitCode ?? 0;
    }
  });
});

describe('maybeDelegateSyncToServe brain + source gates (F3)', () => {
  test('non-host brain → false even under a live serve (mounts take the direct path)', async () => {
    // Ladder step 1: delegation targets the HOST data dir (socket/secret/lock
    // all belong to it), so a mounted brain must fall through to the normal
    // connect path — no refusal, no verdict, despite the live serve holder.
    const savedExitCode = process.exitCode;
    _resetCliExitVerdictForTests();
    try {
      const dir = dirWithLiveServeLock();
      expect(await withBrainOption('teambrain', () => maybeDelegateSyncToServe(dir, []))).toBe(false);
      expect(currentExitCode()).toBe(0); // fall-through, not a handled refusal
    } finally {
      _resetCliExitVerdictForTests();
      // setCliExitVerdict mirrors into process.exitCode — undo, or this FILE
      // exits 1 with 0 fails. `?? 0`: Bun ignores an undefined assignment.
      process.exitCode = savedExitCode ?? 0;
    }
  });

  test('brain resolver throw + no holder → false, never an error (fail open)', async () => {
    // An id that fails validateMountId (only reachable via singleton state —
    // parse-time validation normally rejects it) makes resolveBrainId THROW.
    // The ladder swallows it and proceeds; with no holder that lands on the
    // normal direct-connect path.
    const dir = mkdtempSync(join(tmpdir(), 'sdl-badbrain-'));
    expect(await withBrainOption('Not-A-Valid-Id!', () => maybeDelegateSyncToServe(dir, []))).toBe(false);
  });

  test('brain resolver throw + live serve → the ladder CONTINUES as if host (fail open to old behavior)', async () => {
    // REALITY pin: the catch does NOT return false — it falls through to the
    // holder probe, so under a live serve the resolver throw still yields the
    // handled no-socket refusal (true), exactly the pre-mounts behavior.
    const savedExitCode = process.exitCode;
    _resetCliExitVerdictForTests();
    const cap = captureConsoleError();
    try {
      const dir = dirWithLiveServeLock();
      expect(await withBrainOption('Not-A-Valid-Id!', () => maybeDelegateSyncToServe(dir, []))).toBe(true);
      expect(cap.lines.join('\n')).toContain('exposes no sync IPC');
      expect(currentExitCode()).toBe(1);
    } finally {
      cap.restore();
      _resetCliExitVerdictForTests();
      // setCliExitVerdict mirrors into process.exitCode — undo, or this FILE
      // exits 1 with 0 fails. `?? 0`: Bun ignores an undefined assignment.
      process.exitCode = savedExitCode ?? 0;
    }
  });

  test('--source __all__ under a live serve → handled, verdict 1, one-source-at-a-time remediation', async () => {
    const savedExitCode = process.exitCode;
    _resetCliExitVerdictForTests();
    const cap = captureConsoleError();
    try {
      const dir = dirWithLiveServeLock();
      expect(await maybeDelegateSyncToServe(dir, ['--source', '__all__'])).toBe(true);
      const text = cap.lines.join('\n');
      expect(text).toContain("--source __all__ isn't supported through serve-delegated sync");
      expect(text).toContain('no engine to enumerate sources');
      expect(text).toContain('Sync one source at a time (--source <id>).');
      // remediation(): flag-independent ways out are always named.
      expect(text).toContain('stop the serve (PID');
      expect(text).toContain('--no-delegate');
      expect(currentExitCode()).toBe(1);
    } finally {
      cap.restore();
      _resetCliExitVerdictForTests();
      // setCliExitVerdict mirrors into process.exitCode — undo, or this FILE
      // exits 1 with 0 fails. `?? 0`: Bun ignores an undefined assignment.
      process.exitCode = savedExitCode ?? 0;
    }
  });

  test('resolveSourceIdEngineFree throw (invalid --source) → handled, verdict 1, the error message verbatim', async () => {
    const savedExitCode = process.exitCode;
    _resetCliExitVerdictForTests();
    const cap = captureConsoleError();
    try {
      const dir = dirWithLiveServeLock();
      // 'NOT-VALID' passes the argv gate (not flag-shaped) but fails
      // SOURCE_ID_RE inside resolveSourceIdEngineFree, which THROWS; the
      // ladder catches, prints `[sync] <message>`, and handles (true).
      expect(await maybeDelegateSyncToServe(dir, ['--source', 'NOT-VALID'])).toBe(true);
      expect(cap.lines.join('\n')).toContain('[sync] Invalid --source value "NOT-VALID"');
      expect(currentExitCode()).toBe(1);
    } finally {
      cap.restore();
      _resetCliExitVerdictForTests();
      // setCliExitVerdict mirrors into process.exitCode — undo, or this FILE
      // exits 1 with 0 fails. `?? 0`: Bun ignores an undefined assignment.
      process.exitCode = savedExitCode ?? 0;
    }
  });
});
