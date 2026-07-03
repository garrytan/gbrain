/**
 * Local-daemon CLI fallback — detection + token-resolution contract.
 *
 * Pins the pure seams of src/core/local-daemon.ts so the cli.ts routing
 * guard can't silently regress: which lock holders count as a routable
 * daemon (live `serve --http` only), how the port is parsed out of the
 * lock file's argv string, and the bearer-token precedence
 * (GBRAIN_REMOTE_TOKEN env > <gbrain home>/agents.token file).
 * The HTTP surfaces (health probe, raw-bearer tool call) follow the
 * connect-probe.ts pattern and are exercised by the live-daemon e2e path.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseServeHttpPort,
  detectLocalDaemon,
  readLocalDaemonToken,
} from '../src/core/local-daemon.ts';

describe('parseServeHttpPort', () => {
  test('serve --http --port N → N', () => {
    expect(parseServeHttpPort('/Users/x/gbrain/src/cli.ts serve --http --port 3131')).toBe(3131);
  });

  test('serve --http without --port → default 3131', () => {
    expect(parseServeHttpPort('/Users/x/gbrain/src/cli.ts serve --http')).toBe(3131);
  });

  test('stdio serve (no --http) → null: nothing to route to', () => {
    expect(parseServeHttpPort('/Users/x/gbrain/src/cli.ts serve')).toBeNull();
  });

  test('non-serve holders (embed, import) → null', () => {
    expect(parseServeHttpPort('/Users/x/gbrain/src/cli.ts embed')).toBeNull();
    expect(parseServeHttpPort('/Users/x/gbrain/src/cli.ts import ~/notes')).toBeNull();
  });

  test('garbage port values → null', () => {
    expect(parseServeHttpPort('cli.ts serve --http --port nope')).toBeNull();
    expect(parseServeHttpPort('cli.ts serve --http --port 0')).toBeNull();
    expect(parseServeHttpPort('cli.ts serve --http --port 99999')).toBeNull();
  });

  test('non-string command (corrupt lock) → null', () => {
    expect(parseServeHttpPort(undefined)).toBeNull();
    expect(parseServeHttpPort(42)).toBeNull();
  });
});

describe('detectLocalDaemon', () => {
  const lockJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      pid: 4242,
      acquired_at: 1,
      refreshed_at: 2,
      command: 'cli.ts serve --http --port 3131',
      ...over,
    });

  test('live serve --http holder → pid + port', () => {
    expect(
      detectLocalDaemon('/data', { isProcessAlive: () => true, readFile: () => lockJson() }),
    ).toEqual({ pid: 4242, port: 3131 });
  });

  test('dead holder → null (acquireLock will reap it)', () => {
    expect(
      detectLocalDaemon('/data', { isProcessAlive: () => false, readFile: () => lockJson() }),
    ).toBeNull();
  });

  test('live non-HTTP holder (embed) → null', () => {
    expect(
      detectLocalDaemon('/data', {
        isProcessAlive: () => true,
        readFile: () => lockJson({ command: 'cli.ts embed' }),
      }),
    ).toBeNull();
  });

  test('missing lock file → null', () => {
    expect(
      detectLocalDaemon('/data', {
        isProcessAlive: () => true,
        readFile: () => { throw new Error('ENOENT'); },
      }),
    ).toBeNull();
  });

  test('corrupt lock JSON → null', () => {
    expect(
      detectLocalDaemon('/data', { isProcessAlive: () => true, readFile: () => '{nope' }),
    ).toBeNull();
  });

  test('in-memory (no dataDir) → null', () => {
    expect(
      detectLocalDaemon(undefined, { isProcessAlive: () => true, readFile: () => lockJson() }),
    ).toBeNull();
  });
});

describe('readLocalDaemonToken', () => {
  const savedHome = process.env.GBRAIN_HOME;
  let tmp: string | null = null;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = savedHome;
    if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
  });

  const makeHome = (tokenFile?: string): void => {
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-local-daemon-'));
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    if (tokenFile !== undefined) {
      writeFileSync(join(tmp, '.gbrain', 'agents.token'), tokenFile, { mode: 0o600 });
    }
    process.env.GBRAIN_HOME = tmp;
  };

  test('GBRAIN_REMOTE_TOKEN env wins over the file', () => {
    makeHome('gbrain_filetoken');
    expect(readLocalDaemonToken({ GBRAIN_REMOTE_TOKEN: ' gbrain_envtoken ' } as NodeJS.ProcessEnv))
      .toBe('gbrain_envtoken');
  });

  test('falls back to agents.token (trimmed)', () => {
    makeHome('gbrain_filetoken\n');
    expect(readLocalDaemonToken({} as NodeJS.ProcessEnv)).toBe('gbrain_filetoken');
  });

  test('empty file → null', () => {
    makeHome('\n');
    expect(readLocalDaemonToken({} as NodeJS.ProcessEnv)).toBeNull();
  });

  test('no env, no file → null', () => {
    makeHome(undefined);
    expect(readLocalDaemonToken({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
