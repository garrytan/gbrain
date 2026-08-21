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
 * mutation (deriveDelegatedTimeoutSeconds takes injected env/tty).
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
    expect(await maybeDelegateSyncToServe(dir, ['--repo', '/tmp/x'])).toBe(true);
  });

  test('live serve + no IPC socket → handled (polite refusal)', async () => {
    const dir = dirWithLiveServeLock();
    expect(await maybeDelegateSyncToServe(dir, [])).toBe(true);
  });
});
