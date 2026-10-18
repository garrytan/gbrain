/**
 * #6573: on Windows a PGLite data-dir socket path over afunix's 108-byte `sun_path` (107 bytes plus NUL, measured as
 * the UTF-8 bytes Bun copies into it) moves to the per-user run dir, `%USERPROFILE%\.gbrain\run\<kind>-<hash12>.sock`,
 * the scheme Postgres brains use; a path still too long there is reported as `ipc_path_too_long` by the serve log and
 * doctor's `ipc_socket_path` check, with byte counts and the fix.
 *
 * Protects the selection rules (pure `windowsLocalIpcSocketPath`): short paths and named pipes stay; a long path and a
 * short-in-characters but long-in-bytes non-ASCII path move; the key is the canonical data dir, case-folded, per kind;
 * the turn_context secret stays in the data dir. Off Windows the end-to-end cases force `process.platform` to win32
 * (the platform is read per call); the native bind, round trip and stability probe live in
 * test/windows-ipc-long-path-6573.serial.test.ts on the windows-latest row. Fails on master: the win32 branch returned the
 * data-dir path unchanged, so every listen() on a long data dir failed and only GBRAIN_DEBUG said why.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { localIpcPathTooLong, localIpcSocketPath, windowsLocalIpcSocketPath, WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES } from '../src/core/context/ipc-path.ts';
import { ipcSecretPathForConfig, resolveSocketPathForConfig } from '../src/core/context/resolve-ipc.ts';
import { findIpcPathTooLong, ipcPathTooLongMessage } from '../src/core/context/ipc-path-too-long.ts';
import { ipcSocketPathEntry } from '../src/commands/doctor/checks/local-ipc.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { withEnv } from './helpers/with-env.ts';

const PROFILE = String.raw`C:\Users\alice-example`;
const identity = (path: string) => path;
const key = (dir: string) => createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 12);
const bytes = (path: string) => Buffer.byteLength(path, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function asWindows<T>(fn: () => Promise<T>): Promise<T> {
  if (process.platform === 'win32') return fn();
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', original); }
}

describe('windowsLocalIpcSocketPath (#6573)', () => {
  test('a data-dir socket that fits afunix stays where it is', () => {
    const path = String.raw`C:\gbrain\brain.pglite\.gbrain-resolve.sock`;
    expect(windowsLocalIpcSocketPath(path, PROFILE, identity)).toBe(path);
  });

  test('a long data-dir socket moves to the per-user run dir, keyed by kind and data dir', () => {
    const dir = 'C:\\Users\\alice-example\\Documents\\Projects\\' + 'nested-folder\\'.repeat(5) + 'brain.pglite';
    const resolve = `${dir}\\.gbrain-resolve.sock`, persistence = `${dir}\\.gbrain-persistence.sock`;
    expect(bytes(resolve)).toBeGreaterThan(WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES);
    expect(windowsLocalIpcSocketPath(resolve, PROFILE, identity)).toBe(`${PROFILE}\\.gbrain\\run\\resolve-${key(dir)}.sock`);
    expect(windowsLocalIpcSocketPath(persistence, PROFILE, identity)).toBe(`${PROFILE}\\.gbrain\\run\\persistence-${key(dir)}.sock`);
    // Windows paths are case-insensitive: one brain, one socket.
    expect(windowsLocalIpcSocketPath(resolve.toUpperCase().replace('.GBRAIN-RESOLVE.SOCK', '.gbrain-resolve.sock'), PROFILE, identity))
      .toBe(windowsLocalIpcSocketPath(resolve, PROFILE, identity));
    // The canonical (realpath) data dir is the key, not the spelling the config used.
    const longJunction = 'C:\\junction\\' + 'x'.repeat(100) + String.raw`\.gbrain-resolve.sock`;
    expect(windowsLocalIpcSocketPath(longJunction, PROFILE, () => resolve)).toBe(`${PROFILE}\\.gbrain\\run\\resolve-${key(dir)}.sock`);
  });

  test('the budget is UTF-8 bytes: a path short in characters but long in bytes moves', () => {
    const dir = 'C:\\Users\\' + 'é'.repeat(40) + String.raw`\brain.pglite`;
    const path = `${dir}\\.gbrain-resolve.sock`;
    expect(path.length).toBeLessThanOrEqual(WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES);
    expect(bytes(path)).toBeGreaterThan(WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES);
    expect(windowsLocalIpcSocketPath(path, PROFILE, identity)).toBe(`${PROFILE}\\.gbrain\\run\\resolve-${key(dir)}.sock`);
  });

  test('named pipes and already-keyed run-dir sockets are never rewritten', () => {
    const pipe = String.raw`\\.\pipe\gbrain-` + 'p'.repeat(120);
    expect(windowsLocalIpcSocketPath(pipe, PROFILE, identity)).toBe(pipe);
    const runDir = 'C:\\Users\\alice-example\\' + 'deep\\'.repeat(20) + String.raw`.gbrain\run\resolve-0123456789ab.sock`;
    expect(windowsLocalIpcSocketPath(runDir, PROFILE, identity)).toBe(runDir);
  });
});

describe('Windows long PGLite paths end to end, platform forced off Windows (#6573)', () => {
  function brain(depth: number): { home: string; profile: string; dataDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'gb-6573-'));
    dirs.push(root);
    const dataDir = join(root, 'd'.repeat(depth), 'brain.pglite');
    mkdirSync(dataDir, { recursive: true });
    const home = join(root, 'home');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir }));
    return { home, profile: join(root, 'pröfile'), dataDir };
  }

  test('server and client resolve the same run-dir socket; the secret stays in the data dir', async () => {
    const { profile, dataDir } = brain(90);
    await withEnv({ USERPROFILE: profile }, () => asWindows(async () => {
      const cfg = { engine: 'pglite' as const, database_path: dataDir };
      const legacy = join(dataDir, '.gbrain-resolve.sock');
      expect(bytes(legacy)).toBeGreaterThan(WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES);
      const resolved = resolveSocketPathForConfig(cfg)!;
      const runDir = win32.join(profile, '.gbrain', 'run');
      expect(resolved.startsWith(`${runDir}\\resolve-`)).toBe(true);
      expect(bytes(resolved)).toBeLessThanOrEqual(WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES);
      expect(localIpcSocketPath(legacy)).toBe(resolved);
      expect(localIpcSocketPath(resolved)).toBe(resolved);
      expect(resolveSocketPathForConfig(cfg, 'persistence')!.startsWith(`${runDir}\\persistence-`)).toBe(true);
      expect(ipcSecretPathForConfig(cfg)).toBe(join(dataDir, '.gbrain-ipc-secret'));
      expect(localIpcPathTooLong(legacy)).toBeNull();
    }));
  });

  test('a run-dir path that is still too long is reported, typed, with byte counts and the fix', async () => {
    const { home, dataDir } = brain(90);
    const profile = join(dirs[0]!, 'p'.repeat(90));
    await withEnv({ USERPROFILE: profile, GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, () => asWindows(async () => {
      const legacy = join(dataDir, '.gbrain-resolve.sock');
      const problem = findIpcPathTooLong([localIpcSocketPath(legacy)]);
      expect(problem).toMatchObject({ code: 'ipc_path_too_long', limit: WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES });
      expect(problem!.bytes).toBe(bytes(problem!.path));
      expect(problem!.bytes).toBeGreaterThan(WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES);
      expect(ipcPathTooLongMessage(problem!)).toContain(`${problem!.bytes} bytes`);

      const checks = await ipcSocketPathEntry.run({} as DoctorContext) as Array<{ name: string; status: string; details?: Record<string, unknown>; fix?: { argv?: string[]; verify?: { argv?: string[] }; actor?: string } }>;
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: 'ipc_socket_path', status: 'warn', details: { code: 'ipc_path_too_long', limit: WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES } });
      expect(checks[0]!.fix?.argv?.slice(0, 4)).toEqual(['gbrain', 'config', 'set', 'database_path']);
      expect(checks[0]!.fix?.actor).toBe('user');
      expect(checks[0]!.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'ipc_socket_path', '--json']);
    }));
  });

  test('doctor stays silent when every socket path fits', async () => {
    const { home, profile } = brain(10);
    await withEnv({ USERPROFILE: profile, GBRAIN_HOME: home, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, () => asWindows(async () => {
      expect(await ipcSocketPathEntry.run({} as DoctorContext)).toEqual([]);
    }));
  });
});
