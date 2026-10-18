/**
 * #6573, native Windows only (its own step on the windows-latest security-regressions row): a PGLite brain whose data
 * directory is deep enough that `<data dir>\.gbrain-resolve.sock` passes afunix's 108-byte `sun_path` still serves
 * hooks, through the per-user run-dir socket `%USERPROFILE%\.gbrain\run\<kind>-<hash12>.sock`, under a profile path
 * with non-ASCII characters (afunix receives the UTF-8 bytes Bun copies).
 *
 * Protects: the resolve listener binds at the run-dir path and answers resolve and an authenticated turn_context (the
 * secret stays `.gbrain-ipc-secret` in the data dir); the persistence listener binds and answers capabilities; 20
 * bind / round-trip / close cycles stay stable. Servers and this file's own clients are closed from the test body,
 * after a macrotask turn, never inside a socket callback: Bun 1.4.x on Windows frees a socket closed during a nested
 * libuv tick while the outer dispatch still holds it (#6462, oven-sh/bun#40023). Off Windows every case is skipped;
 * the selection logic is covered on every OS by test/ipc-path-windows-fallback-6573.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net, { type Server } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES } from '../src/core/context/ipc-path.ts';
import {
  ensureIpcSecretForConfig,
  ipcSecretPathForConfig,
  IPC_UNAVAILABLE,
  readIpcSecretForConfig,
  requestTurnContext,
  resolveSocketPathForConfig,
  resolveViaIpc,
  startResolveIpcServer,
} from '../src/core/context/resolve-ipc.ts';
import { persistenceSocketPathForConfig, requestPersistenceCapabilities, startPersistenceIpcServer } from '../src/core/persistence/ipc.ts';

const NATIVE = process.platform === 'win32';
const BRAIN = '10000000-0000-4000-8000-000000000001';
let root = '';
let priorProfile: string | undefined;
let cfg: { engine: 'pglite'; database_path: string };

const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function closeServer(server: Server): Promise<void> {
  await turn();
  const closed = once(server, 'close');
  server.close();
  await closed;
  await turn();
}

/** One request line, one response line, with the client destroyed from a later macrotask. */
async function rawRoundTrip(path: string, line: string): Promise<unknown> {
  const socket = net.createConnection(path);
  try {
    await once(socket, 'connect');
    socket.write(`${line}\n`);
    let buffer = '';
    for await (const chunk of socket) {
      buffer += String(chunk);
      const nl = buffer.indexOf('\n');
      if (nl >= 0) return JSON.parse(buffer.slice(0, nl));
    }
    return null;
  } finally {
    await turn();
    socket.destroy();
    await turn();
  }
}

describe.skipIf(!NATIVE)('Windows long PGLite IPC paths use the per-user run dir (#6573)', () => {
  beforeAll(() => {
    root = mkdtempSync(join(realpathSync.native(tmpdir()), 'gb-6573-'));
    priorProfile = process.env.USERPROFILE;
    const profile = join(root, 'pø-é');
    mkdirSync(profile, { recursive: true });
    process.env.USERPROFILE = profile;
    const dataDir = join(root, 'b'.repeat(80), 'brain.pglite');
    mkdirSync(dataDir, { recursive: true });
    cfg = { engine: 'pglite', database_path: dataDir };
  });
  afterAll(() => {
    if (priorProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorProfile;
    rmSync(root, { recursive: true, force: true });
  });

  test('the data-dir path is over the afunix budget and the run-dir path fits it', () => {
    const legacy = join(cfg.database_path, '.gbrain-resolve.sock');
    expect(Buffer.byteLength(legacy, 'utf8')).toBeGreaterThan(WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES);
    const resolved = resolveSocketPathForConfig(cfg)!;
    expect(resolved.startsWith(join(process.env.USERPROFILE!, '.gbrain', 'run', 'resolve-'))).toBe(true);
    expect(Buffer.byteLength(resolved, 'utf8')).toBeLessThanOrEqual(WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES);
    expect(ipcSecretPathForConfig(cfg)).toBe(join(cfg.database_path, '.gbrain-ipc-secret'));
  });

  test('resolve and authenticated turn_context reach a listener bound at the run-dir path', async () => {
    const path = resolveSocketPathForConfig(cfg)!;
    const secret = ensureIpcSecretForConfig(cfg)!;
    const server = await startResolveIpcServer(path, {
      resolve: async () => null,
      turn_context: async () => ({ text: 'ok', pointers: [], volunteered: [] } as never),
    }, { secret, boundSourceId: 'default' });
    expect(server).not.toBeNull();
    try {
      expect(await resolveViaIpc(path, { candidates: [] })).toBeNull();
      const reply = await requestTurnContext(path, { secret: readIpcSecretForConfig(cfg)!, window: [{ role: 'user', text: 'hello' }] }, { timeoutMs: 5_000 });
      expect(reply).not.toBe(IPC_UNAVAILABLE);
      expect(reply).toMatchObject({ ok: true, protocol: 2 });
    } finally {
      await closeServer(server!);
    }
  });

  test('the persistence listener binds at its run-dir path and answers capabilities', async () => {
    const path = persistenceSocketPathForConfig(cfg)!;
    expect(path.startsWith(join(process.env.USERPROFILE!, '.gbrain', 'run', 'persistence-'))).toBe(true);
    expect(Buffer.byteLength(path, 'utf8')).toBeLessThanOrEqual(WINDOWS_UNIX_SOCKET_PATH_MAX_BYTES);
    const binding = await startPersistenceIpcServer(path, { brainId: BRAIN, dispatch: async () => ({}) });
    expect(binding).not.toBeNull();
    try {
      expect((await requestPersistenceCapabilities(path)).brain_id).toBe(BRAIN);
    } finally {
      await turn();
      const closed = once(binding!.server, 'close');
      binding!.close();
      await closed;
      await turn();
    }
  });

  test('20 bind / round-trip / close cycles at the run-dir path stay stable', async () => {
    const path = resolveSocketPathForConfig(cfg)!;
    for (let i = 0; i < 20; i++) {
      const server = await startResolveIpcServer(path, { resolve: async () => null }, { boundSourceId: 'default' });
      expect(server).not.toBeNull();
      try {
        expect(await rawRoundTrip(path, JSON.stringify({ kind: 'resolve', candidates: [] }))).toEqual({ ok: true, block: null });
      } finally {
        await closeServer(server!);
      }
    }
  }, 120_000);
});
