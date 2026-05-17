/**
 * v0.31.11: thin-client auto-upgrade prompt — unit tests.
 *
 * Covers safeCompare, driftLevel, state-file IO (round-trip + corrupt + atomic),
 * decideAction (every row of the decision matrix from the plan), the lockfile
 * contract (acquire / EEXIST / stale-reclaim), and the orchestrator (yes/no/
 * upgrade-advanced/not-advanced/threw paths).
 *
 * Pure-Bun, no DB, no real network. Uses the test injection seams
 * (`_setVerifierForTest`, `_setPromptReaderForTest`, `_setUpgradeRunnerForTest`)
 * so the orchestrator runs end-to-end without spawning subprocesses or
 * touching the user's PATH.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withEnv } from './helpers/with-env.ts';
import {
  safeCompare,
  driftLevel,
  loadPromptState,
  savePromptState,
  acquirePromptLock,
  decideAction,
  maybePromptForUpgrade,
  _setVerifierForTest,
  _setPromptReaderForTest,
  _setUpgradeRunnerForTest,
  type PromptState,
} from '../src/core/thin-client-upgrade-prompt.ts';
import type { CliOptions } from '../src/core/cli-options.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const DEFAULT_CLI_OPTS: CliOptions = {
  quiet: false,
  progressJson: false,
  progressInterval: 1000,
  timeoutMs: null,
};

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-prompt-'));
  // Reset injection seams between tests.
  _setVerifierForTest(null);
  _setPromptReaderForTest(null);
  _setUpgradeRunnerForTest(null);
});

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  _setVerifierForTest(null);
  _setPromptReaderForTest(null);
  _setUpgradeRunnerForTest(null);
});

// ============================================================================
// safeCompare
// ============================================================================

describe('safeCompare', () => {
  test('equal versions return 0', () => {
    expect(safeCompare('0.31.11', '0.31.11')).toBe(0);
  });
  test('local less than remote returns -1', () => {
    expect(safeCompare('0.31.4', '0.31.11')).toBe(-1);
    expect(safeCompare('0.31.4', '0.32.0')).toBe(-1);
    expect(safeCompare('0.31.4', '1.0.0')).toBe(-1);
  });
  test('local greater than remote returns 1', () => {
    expect(safeCompare('0.32.0', '0.31.11')).toBe(1);
    expect(safeCompare('1.0.0', '0.99.99')).toBe(1);
  });
  test('4-segment versions parse (4th segment ignored by underlying comparator)', () => {
    // Underlying compareVersions from src/commands/migrations/index.ts only
    // compares segments 0-2 — the 4th segment is intentionally ignored. This
    // matches gbrain's actual 3-segment release practice (VERSION file).
    expect(safeCompare('0.31.4.0', '0.31.4.0')).toBe(0);
    expect(safeCompare('0.31.4.1', '0.31.4.2')).toBe(0); // 4th segment ignored
    expect(safeCompare('0.31.4.0', '0.31.5.0')).toBe(-1); // segment 2 differs
  });
  test('empty / missing / non-numeric returns null', () => {
    expect(safeCompare('', '0.31.4')).toBe(null);
    expect(safeCompare('0.31.4', '')).toBe(null);
    expect(safeCompare('0.31', '0.31.4')).toBe(null); // 2-segment
    expect(safeCompare('0.31.4', '0.31')).toBe(null);
    expect(safeCompare('0.31.4-rc1', '0.31.4')).toBe(null); // suffix
    expect(safeCompare('0.31.x', '0.31.4')).toBe(null);
    expect(safeCompare('a.b.c', '0.31.4')).toBe(null);
    expect(safeCompare('0.31.4.5.6', '0.31.4')).toBe(null); // 5-segment
  });
});

// ============================================================================
// driftLevel
// ============================================================================

describe('driftLevel', () => {
  test('major bump', () => {
    expect(driftLevel('0.31.11', '1.0.0')).toBe('major');
  });
  test('minor bump (same major)', () => {
    expect(driftLevel('0.31.11', '0.32.0')).toBe('minor');
  });
  test('patch bump (same major+minor)', () => {
    expect(driftLevel('0.31.11', '0.31.12')).toBe('patch');
  });
  test('local equal to remote → none', () => {
    expect(driftLevel('0.31.11', '0.31.11')).toBe('none');
  });
  test('local ahead of remote → none', () => {
    expect(driftLevel('0.32.0', '0.31.11')).toBe('none');
  });
  test('malformed → none', () => {
    expect(driftLevel('garbage', '0.31.11')).toBe('none');
    expect(driftLevel('0.31.11', 'garbage')).toBe('none');
  });
});

// ============================================================================
// State file IO
// ============================================================================

describe('promptState IO', () => {
  test('missing file returns empty state', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const state = loadPromptState();
      expect(state).toEqual({ schema_version: 1, entries: {} });
    });
  });

  test('round-trip: save then load', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const state: PromptState = {
        schema_version: 1,
        entries: {
          'https://brain.example.com': {
            last_prompted_remote_version: '0.32.0',
            last_response: 'no',
            last_prompted_at_iso: '2026-05-10T12:00:00Z',
          },
        },
      };
      savePromptState(state);
      const loaded = loadPromptState();
      expect(loaded).toEqual(state);
    });
  });

  test('atomic write: tmp file written then renamed', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      savePromptState({ schema_version: 1, entries: {} });
      const finalPath = join(tmpHome, '.gbrain', 'upgrade-prompt-state.json');
      const tmpPath = `${finalPath}.tmp`;
      expect(existsSync(finalPath)).toBe(true);
      expect(existsSync(tmpPath)).toBe(false); // tmp gets renamed away
    });
  });

  test('corrupt JSON falls through to empty state', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      // Pre-create the gbrain dir + corrupt file
      const path = join(tmpHome, '.gbrain', 'upgrade-prompt-state.json');
      const dir = join(tmpHome, '.gbrain');
      try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      writeFileSync(path, '{not valid json');
      const state = loadPromptState();
      expect(state).toEqual({ schema_version: 1, entries: {} });
    });
  });

  test('truncated mid-write file falls through to empty state', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const path = join(tmpHome, '.gbrain', 'upgrade-prompt-state.json');
      const dir = join(tmpHome, '.gbrain');
      try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      writeFileSync(path, '{"schema_version":1,"entries":{"foo":{"last_'); // truncated
      const state = loadPromptState();
      expect(state).toEqual({ schema_version: 1, entries: {} });
    });
  });

  test('malformed entry (missing fields) is dropped, valid sibling preserved', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const path = join(tmpHome, '.gbrain', 'upgrade-prompt-state.json');
      const dir = join(tmpHome, '.gbrain');
      try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      writeFileSync(path, JSON.stringify({
        schema_version: 1,
        entries: {
          'https://good.example.com': {
            last_prompted_remote_version: '0.32.0',
            last_response: 'no',
            last_prompted_at_iso: '2026-05-10T12:00:00Z',
          },
          'https://malformed-1.example.com': { last_response: 'no' }, // missing version + iso
          'https://malformed-2.example.com': {
            last_prompted_remote_version: 42, // wrong type
            last_response: 'no',
            last_prompted_at_iso: '2026-05-10T12:00:00Z',
          },
          'https://malformed-3.example.com': {
            last_prompted_remote_version: '0.32.0',
            last_response: 'banana', // invalid enum
            last_prompted_at_iso: '2026-05-10T12:00:00Z',
          },
        },
      }));
      const state = loadPromptState();
      expect(Object.keys(state.entries)).toEqual(['https://good.example.com']);
      expect(state.entries['https://good.example.com'].last_response).toBe('no');
    });
  });

  test('empty-string entry key is dropped', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const path = join(tmpHome, '.gbrain', 'upgrade-prompt-state.json');
      const dir = join(tmpHome, '.gbrain');
      try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      writeFileSync(path, JSON.stringify({
        schema_version: 1,
        entries: {
          '': {
            last_prompted_remote_version: '0.32.0',
            last_response: 'no',
            last_prompted_at_iso: '2026-05-10T12:00:00Z',
          },
        },
      }));
      const state = loadPromptState();
      expect(Object.keys(state.entries)).toEqual([]);
    });
  });

  test('missing schema_version or wrong shape → empty state', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const path = join(tmpHome, '.gbrain', 'upgrade-prompt-state.json');
      const dir = join(tmpHome, '.gbrain');
      try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      writeFileSync(path, JSON.stringify({ entries: {} })); // missing schema_version
      expect(loadPromptState()).toEqual({ schema_version: 1, entries: {} });

      writeFileSync(path, JSON.stringify({ schema_version: 99, entries: {} })); // wrong version
      expect(loadPromptState()).toEqual({ schema_version: 1, entries: {} });
    });
  });

  test('multi-mcp-url entries are isolated', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const state: PromptState = {
        schema_version: 1,
        entries: {
          'https://work.example.com': {
            last_prompted_remote_version: '0.32.0',
            last_response: 'no',
            last_prompted_at_iso: '2026-05-10T12:00:00Z',
          },
          'https://home.example.com': {
            last_prompted_remote_version: '1.0.0',
            last_response: 'yes',
            last_prompted_at_iso: '2026-05-10T13:00:00Z',
          },
        },
      };
      savePromptState(state);
      const loaded = loadPromptState();
      expect(loaded.entries['https://work.example.com'].last_response).toBe('no');
      expect(loaded.entries['https://home.example.com'].last_response).toBe('yes');
    });
  });
});

// ============================================================================
// decideAction (pure decision matrix)
// ============================================================================

const EMPTY_STATE: PromptState = { schema_version: 1, entries: {} };

describe('decideAction', () => {
  const baseInput = {
    localVersion: '0.31.4',
    remoteVersion: '0.32.0',
    mcpUrl: 'https://brain.example.com',
    state: EMPTY_STATE,
    cliOpts: DEFAULT_CLI_OPTS,
    stdinIsTty: true,
    stdoutIsTty: true,
    bannerIsSuppressed: false,
  };

  test('drift detected, all gates pass → prompt', () => {
    expect(decideAction(baseInput)).toEqual({ kind: 'prompt', level: 'minor' });
  });

  test('local equals remote → noop', () => {
    expect(decideAction({ ...baseInput, localVersion: '0.32.0' })).toEqual({ kind: 'noop' });
  });

  test('local ahead of remote → noop', () => {
    expect(decideAction({ ...baseInput, localVersion: '1.0.0' })).toEqual({ kind: 'noop' });
  });

  test('safeCompare null (malformed local) → noop', () => {
    expect(decideAction({ ...baseInput, localVersion: 'garbage' })).toEqual({ kind: 'noop' });
  });

  test('D8: patch drift → noop', () => {
    expect(decideAction({ ...baseInput, localVersion: '0.32.0', remoteVersion: '0.32.1' })).toEqual({ kind: 'noop' });
  });

  test('D8: minor drift → prompt', () => {
    expect(decideAction({ ...baseInput, localVersion: '0.31.0', remoteVersion: '0.32.0' })).toEqual({ kind: 'prompt', level: 'minor' });
  });

  test('D8: major drift → prompt', () => {
    expect(decideAction({ ...baseInput, localVersion: '0.31.0', remoteVersion: '1.0.0' })).toEqual({ kind: 'prompt', level: 'major' });
  });

  test('D7: bannerIsSuppressed → noop', () => {
    expect(decideAction({ ...baseInput, bannerIsSuppressed: true })).toEqual({ kind: 'noop' });
  });

  test('D6: stdin not TTY → noop', () => {
    expect(decideAction({ ...baseInput, stdinIsTty: false })).toEqual({ kind: 'noop' });
  });

  test('D6: stdout not TTY → noop', () => {
    expect(decideAction({ ...baseInput, stdoutIsTty: false })).toEqual({ kind: 'noop' });
  });

  test('sticky decline (last_response=no, same remote version) → noop', () => {
    const state: PromptState = {
      schema_version: 1,
      entries: {
        'https://brain.example.com': {
          last_prompted_remote_version: '0.32.0',
          last_response: 'no',
          last_prompted_at_iso: '2026-05-10T12:00:00Z',
        },
      },
    };
    expect(decideAction({ ...baseInput, state })).toEqual({ kind: 'noop' });
  });

  test('sticky yes (last_response=yes, same remote version) → noop', () => {
    const state: PromptState = {
      schema_version: 1,
      entries: {
        'https://brain.example.com': {
          last_prompted_remote_version: '0.32.0',
          last_response: 'yes',
          last_prompted_at_iso: '2026-05-10T12:00:00Z',
        },
      },
    };
    expect(decideAction({ ...baseInput, state })).toEqual({ kind: 'noop' });
  });

  test('failed prior attempt → re-prompt fresh', () => {
    const state: PromptState = {
      schema_version: 1,
      entries: {
        'https://brain.example.com': {
          last_prompted_remote_version: '0.32.0',
          last_response: 'failed',
          last_prompted_at_iso: '2026-05-10T12:00:00Z',
        },
      },
    };
    expect(decideAction({ ...baseInput, state })).toEqual({ kind: 'prompt', level: 'minor' });
  });

  test('new bump after decline → re-prompt', () => {
    const state: PromptState = {
      schema_version: 1,
      entries: {
        'https://brain.example.com': {
          last_prompted_remote_version: '0.32.0',
          last_response: 'no',
          last_prompted_at_iso: '2026-05-10T12:00:00Z',
        },
      },
    };
    // Remote bumped from 0.32.0 to 0.33.0
    expect(decideAction({ ...baseInput, state, remoteVersion: '0.33.0' })).toEqual({ kind: 'prompt', level: 'minor' });
  });
});

// ============================================================================
// Lockfile (D2)
// ============================================================================

describe('acquirePromptLock', () => {
  test('acquire then release', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const lock = acquirePromptLock();
      expect(lock).not.toBeNull();
      const lockPath = join(tmpHome, '.gbrain', 'upgrade-prompt.lock');
      expect(existsSync(lockPath)).toBe(true);
      lock!.release();
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  test('concurrent acquire returns null (EEXIST)', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const lock1 = acquirePromptLock();
      expect(lock1).not.toBeNull();
      const lock2 = acquirePromptLock();
      expect(lock2).toBeNull();
      lock1!.release();
      // Now a fresh acquire should succeed
      const lock3 = acquirePromptLock();
      expect(lock3).not.toBeNull();
      lock3!.release();
    });
  });

  test('stale lock (>60s old mtime) reclaimed', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      // Manually create a stale lockfile
      const dir = join(tmpHome, '.gbrain');
      try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      const lockPath = join(dir, 'upgrade-prompt.lock');
      const fd = openSync(lockPath, 'wx+');
      closeSync(fd);
      // Backdate mtime to 2 minutes ago
      const past = new Date(Date.now() - 120_000);
      utimesSync(lockPath, past, past);
      // Acquire should reclaim
      const lock = acquirePromptLock();
      expect(lock).not.toBeNull();
      lock!.release();
    });
  });

  test('release is idempotent', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const lock = acquirePromptLock();
      expect(lock).not.toBeNull();
      lock!.release();
      // Second release must not throw
      expect(() => lock!.release()).not.toThrow();
    });
  });
});

// ============================================================================
// Orchestrator
// ============================================================================

describe('maybePromptForUpgrade orchestrator', () => {
  const cfg: GBrainConfig = {
    remote_mcp: {
      mcp_url: 'https://brain.example.com',
      issuer_url: 'https://brain.example.com',
      oauth_client_id: 'test-client',
    },
  } as GBrainConfig;

  const identity = { version: '0.32.0' };

  test('no remote_mcp → returns immediately', async () => {
    let called = false;
    _setPromptReaderForTest(async () => { called = true; return 'n'; });
    await maybePromptForUpgrade({} as GBrainConfig, identity, DEFAULT_CLI_OPTS, false, {
      localVersion: '0.31.4',
      exit: ((code: number) => { throw new Error(`unexpected exit ${code}`); }) as (code: number) => never,
      log: () => { /* swallow */ },
    });
    expect(called).toBe(false);
  });

  test('decideAction=noop (patch drift) → returns without prompting', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      let prompted = false;
      _setPromptReaderForTest(async () => { prompted = true; return 'n'; });
      await maybePromptForUpgrade(cfg, { version: '0.31.5' }, DEFAULT_CLI_OPTS, false, {
        localVersion: '0.31.4',
        exit: ((code: number) => { throw new Error(`unexpected exit ${code}`); }) as (code: number) => never,
        log: () => { /* swallow */ },
      });
      expect(prompted).toBe(false);
    });
  });

  test('prompt → "n" → state persisted, returns without exit', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      _setPromptReaderForTest(async () => 'n');
      let exited = false;
      await maybePromptForUpgrade(cfg, identity, DEFAULT_CLI_OPTS, false, {
        localVersion: '0.31.4',
        exit: ((code: number) => { exited = true; throw new Error(`unexpected exit ${code}`); }) as (code: number) => never,
        log: () => { /* swallow */ },
        stdinIsTty: true,
        stdoutIsTty: true,
      });
      expect(exited).toBe(false);
      const state = loadPromptState();
      expect(state.entries[cfg.remote_mcp!.mcp_url]).toBeDefined();
      expect(state.entries[cfg.remote_mcp!.mcp_url].last_response).toBe('no');
      expect(state.entries[cfg.remote_mcp!.mcp_url].last_prompted_remote_version).toBe('0.32.0');
    });
  });

  test('prompt → "y" → upgrade runs → advanced → state=yes, exit 0', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      _setPromptReaderForTest(async () => 'y');
      let upgradeRan = false;
      _setUpgradeRunnerForTest(() => { upgradeRan = true; });
      _setVerifierForTest(() => ({ advanced: true, newVersion: '0.32.0' }));

      let exitCode = -1;
      class ExitError extends Error { constructor(public code: number) { super(`exit ${code}`); } }
      try {
        await maybePromptForUpgrade(cfg, identity, DEFAULT_CLI_OPTS, false, {
          localVersion: '0.31.4',
          exit: ((code: number) => { exitCode = code; throw new ExitError(code); }) as (code: number) => never,
          log: () => { /* swallow */ },
          stdinIsTty: true,
          stdoutIsTty: true,
        });
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      }

      expect(upgradeRan).toBe(true);
      expect(exitCode).toBe(0);
      const state = loadPromptState();
      expect(state.entries[cfg.remote_mcp!.mcp_url].last_response).toBe('yes');
    });
  });

  test('prompt → "y" → upgrade runs → NOT advanced → state=failed, exit 1', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      _setPromptReaderForTest(async () => 'y');
      _setUpgradeRunnerForTest(() => { /* swallow, simulate exit 0 with no advance */ });
      _setVerifierForTest(() => ({ advanced: false, newVersion: '0.31.4' }));

      let exitCode = -1;
      class ExitError extends Error { constructor(public code: number) { super(`exit ${code}`); } }
      try {
        await maybePromptForUpgrade(cfg, identity, DEFAULT_CLI_OPTS, false, {
          localVersion: '0.31.4',
          exit: ((code: number) => { exitCode = code; throw new ExitError(code); }) as (code: number) => never,
          log: () => { /* swallow */ },
          stdinIsTty: true,
          stdoutIsTty: true,
        });
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      }

      expect(exitCode).toBe(1);
      const state = loadPromptState();
      expect(state.entries[cfg.remote_mcp!.mcp_url].last_response).toBe('failed');
    });
  });

  test('prompt → "y" → upgrade throws → state=failed, exit 1', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      _setPromptReaderForTest(async () => 'y');
      _setUpgradeRunnerForTest(() => { throw new Error('subprocess died'); });
      _setVerifierForTest(() => { throw new Error('verifier should not be called'); });

      let exitCode = -1;
      let logged = '';
      class ExitError extends Error { constructor(public code: number) { super(`exit ${code}`); } }
      try {
        await maybePromptForUpgrade(cfg, identity, DEFAULT_CLI_OPTS, false, {
          localVersion: '0.31.4',
          exit: ((code: number) => { exitCode = code; throw new ExitError(code); }) as (code: number) => never,
          log: (msg: string) => { logged += msg; },
          stdinIsTty: true,
          stdoutIsTty: true,
        });
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      }

      expect(exitCode).toBe(1);
      expect(logged).toContain('subprocess died');
      const state = loadPromptState();
      expect(state.entries[cfg.remote_mcp!.mcp_url].last_response).toBe('failed');
    });
  });

  test('empty answer (just enter) treated as yes', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      _setPromptReaderForTest(async () => '');
      let upgradeRan = false;
      _setUpgradeRunnerForTest(() => { upgradeRan = true; });
      _setVerifierForTest(() => ({ advanced: true, newVersion: '0.32.0' }));

      class ExitError extends Error { constructor(public code: number) { super(); } }
      try {
        await maybePromptForUpgrade(cfg, identity, DEFAULT_CLI_OPTS, false, {
          localVersion: '0.31.4',
          exit: ((code: number) => { throw new ExitError(code); }) as (code: number) => never,
          log: () => { /* swallow */ },
          stdinIsTty: true,
          stdoutIsTty: true,
        });
      } catch (e) {
        if (!(e instanceof ExitError)) throw e;
      }
      expect(upgradeRan).toBe(true);
    });
  });

  test('installs and removes prompt-scoped SIGINT handler around the prompt', async () => {
    // Regression guard: without the prompt-scoped handler, Ctrl-C during the
    // prompt is swallowed by runThinClientRouted's outer AbortController-only
    // handler. We verify by counting SIGINT listeners before, during (inside
    // the prompt-reader callback), and after.
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const before = process.listeners('SIGINT').length;
      let listenersDuringPrompt = -1;
      _setPromptReaderForTest(async () => {
        listenersDuringPrompt = process.listeners('SIGINT').length;
        return 'n';
      });
      await maybePromptForUpgrade(cfg, identity, DEFAULT_CLI_OPTS, false, {
        localVersion: '0.31.4',
        exit: ((code: number) => { throw new Error(`unexpected exit ${code}`); }) as (code: number) => never,
        log: () => { /* swallow */ },
        stdinIsTty: true,
        stdoutIsTty: true,
      });
      const after = process.listeners('SIGINT').length;
      expect(listenersDuringPrompt).toBe(before + 1);
      expect(after).toBe(before);
    });
  });

  test('SIGINT handler is removed even if the prompt reader throws', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      const before = process.listeners('SIGINT').length;
      _setPromptReaderForTest(async () => { throw new Error('stdin closed'); });
      await expect(
        maybePromptForUpgrade(cfg, identity, DEFAULT_CLI_OPTS, false, {
          localVersion: '0.31.4',
          exit: ((code: number) => { throw new Error(`unexpected exit ${code}`); }) as (code: number) => never,
          log: () => { /* swallow */ },
          stdinIsTty: true,
          stdoutIsTty: true,
        })
      ).rejects.toThrow('stdin closed');
      expect(process.listeners('SIGINT').length).toBe(before);
    });
  });

  test('prompt reader returns null (EOF) → no state write, no exit, caller continues', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      _setPromptReaderForTest(async () => null);
      let exited = false;
      await maybePromptForUpgrade(cfg, identity, DEFAULT_CLI_OPTS, false, {
        localVersion: '0.31.4',
        exit: ((code: number) => { exited = true; throw new Error(`unexpected exit ${code}`); }) as (code: number) => never,
        log: () => { /* swallow */ },
        stdinIsTty: true,
        stdoutIsTty: true,
      });
      expect(exited).toBe(false);
      // CRITICAL: must NOT persist 'no' to state — a transient EOF should not
      // poison the per-version sticky-decline gate.
      const state = loadPromptState();
      expect(state.entries[cfg.remote_mcp!.mcp_url]).toBeUndefined();
    });
  });

  test('lock contention (sibling holds lock) → no prompt fires', async () => {
    await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
      // Pre-acquire the lock
      const sibling = acquirePromptLock();
      expect(sibling).not.toBeNull();
      try {
        let prompted = false;
        _setPromptReaderForTest(async () => { prompted = true; return 'y'; });
        await maybePromptForUpgrade(cfg, identity, DEFAULT_CLI_OPTS, false, {
          localVersion: '0.31.4',
          exit: ((code: number) => { throw new Error(`unexpected exit ${code}`); }) as (code: number) => never,
          log: () => { /* swallow */ },
          stdinIsTty: true,
          stdoutIsTty: true,
        });
        expect(prompted).toBe(false);
      } finally {
        sibling!.release();
      }
    });
  });
});
