/**
 * #5312 (defect 2): gbrain's IPC sockets live inside the PGLite data dir and
 * `dumpDataDir` cannot read a non-regular file, so a socket left behind by a
 * killed `gbrain serve` wedged every later `backup create` (WASI errno 28 on
 * Linux, errno 2 on Windows) until a human deleted it by hand.
 *
 * `createPgliteBackup` now sweeps the data dir under its writer lock before
 * the dump and removes ONLY gbrain's own `.gbrain-<kind>.sock` endpoints, ONLY
 * when nothing holds their bind claim or answers a probe connect. Everything
 * else at the top level (a live gbrain socket, a foreign socket or FIFO, a
 * symlink) stays, and the refusal is the typed `backup_dump_failed` naming it.
 *
 * #5312 Windows half: Bun's `lstat` fails with EACCES on a stale AF_UNIX reparse point, so the sweep's
 * classification threw before the probe/claim/remove sequence ran and the backup stayed wedged. An `unreadable`
 * owned entry now skips the lstat classification and goes to the probe and the bind claim; removal happens only
 * through the native tag-verifying remover (`binding.removeStaleWindowsSocket`), and without one (POSIX) the entry is
 * `kept: unreadable`, never unlinked. The Linux cases below inject the EACCES through a spy on `fs.lstatSync`: they
 * prove the classification path and the fail-closed kept reason, not the native claim. The cases that `lstat` a
 * socket keep their POSIX gate; the Windows-only cases run on the `windows-latest` row of test.yml (a `native_only`
 * dispatch) and assert through the probe connect and the dump, never through `lstat`.
 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateWrite } from '../src/core/agent-install/state.ts';
import { createPgliteBackup } from '../src/core/backup/snapshot.ts';
import { sweepStaleRuntimeArtefacts } from '../src/core/backup/runtime-artefacts.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveSocketPathForConfig } from '../src/core/context/resolve-ipc.ts';
import { UNIX_SOCKET_PATH_MAX_BYTES } from '../src/core/context/ipc-path.ts';

const posix = process.platform !== 'win32';
const windows = process.platform === 'win32';
let temporary: string;
let root: string;
let dataDir: string;
let outputs = 0;

/** A child that listens on `path` and is SIGKILLed: the socket file outlives it, exactly like a crashed serve. */
async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, ['-e', `const net = require('node:net'); const s = net.createServer(); s.listen(${JSON.stringify(path)}, () => console.log('listening')); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => { if (String(chunk).includes('listening')) resolve(); });
    child.on('exit', code => reject(new Error(`listener exited early (${code})`)));
  });
  const exited = new Promise(resolve => child.on('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  // On Windows the stale AF_UNIX reparse point is exactly what lstat cannot read (#5312); the probe below is the witness there.
  if (posix) expect(lstatSync(path).isSocket()).toBe(true);
}

/** True when something accepts a connection on `path` (the Windows-safe witness for "the endpoint is still there"). */
function accepts(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const c = net.connect(path, () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
  });
}

/**
 * The sweep's `fs.lstatSync(path)` throws `code` (what Bun reports for a stale Windows AF_UNIX reparse point); every
 * other caller and path is real. Call-site scoped on purpose: on Windows the probe (`probeSocketOwner`) is a plain
 * connect and never lstat's, while on POSIX `unixSocketProbeState` lstat's the same path and would read a blanket
 * failure as "unknown owner" (kept as `live_listener`), which is the POSIX contract but not the Windows path under test.
 */
function withUnreadable(path: string, code: string, fn: () => Promise<void>): Promise<void> {
  const original = fs.lstatSync;
  const probe = spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, opts?: unknown) => {
    // The nearest production frame decides: the sweep's own entryStat, not ipc-path's probe state further down the chain.
    const caller = (new Error().stack ?? '').split('\n').find(line => line.includes('/src/core/')) ?? '';
    if (String(p) === path && caller.includes('runtime-artefacts.ts')) {
      throw Object.assign(new Error(`${code}: permission denied, lstat '${path}'`), { code, syscall: 'lstat', path });
    }
    return original(p, opts as never);
  }) as typeof fs.lstatSync);
  return fn().finally(() => probe.mockRestore());
}

afterEach(() => { for (const name of readdirSync(dataDir)) if (name === '.operator-tap.fifo' || name === '.gbrain-persistence.sock' || name === '.gbrain-resolve.sock') { try { unlinkSync(join(dataDir, name)); } catch { /* already gone */ } } });

/** Byte-level fingerprint of the regular files in the data dir top level plus the entry names: the "source intact" witness. */
function dataDirFingerprint(): string {
  const hash = createHash('sha256');
  for (const name of readdirSync(dataDir).sort()) {
    const stat = lstatSync(join(dataDir, name));
    hash.update(`${name}:${stat.isSocket() ? 'socket' : stat.isFIFO() ? 'fifo' : stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file'}\n`);
    if (stat.isFile()) hash.update(readFileSync(join(dataDir, name)));
  }
  return hash.digest('hex');
}

function nextOutput(): string { return join(temporary, `out-${++outputs}.gbrain-backup`); }

async function backupFailure(): Promise<{ code: string; message: string }> {
  try { await createPgliteBackup({ output: nextOutput(), root }); }
  catch (error) { return error as { code: string; message: string }; }
  throw new Error('backup unexpectedly succeeded');
}

// On Windows the socket is bound at the data-dir path itself (no shortened fallback) and afunix.sys's sun_path is 108
// bytes; the runner's TEMP (`C:\Users\RUNNER~1\AppData\Local\Temp`) plus the old 19-character prefix put
// `<dataDir>\.gbrain-persistence.sock` at 114 bytes, so every listen failed before the sweep ran. On POSIX gbrain keeps
// the data-dir socket only up to UNIX_SOCKET_PATH_MAX_BYTES and otherwise binds a shortened /tmp path the sweep never
// sees (#6573: macOS's TMPDIR always crossed it, so the planted sockets sat where nothing looked). So the POSIX fixture
// root is under /tmp (realpath'd: /private/tmp on macOS), and the fixture refuses up front when the path would not fit.
const SOCKET_PATH_LIMIT = windows ? 107 : UNIX_SOCKET_PATH_MAX_BYTES;

beforeAll(async () => {
  temporary = realpathSync(mkdtempSync(join(windows ? tmpdir() : '/tmp', 'g5312-')));
  root = join(temporary, 'brain');
  mkdirSync(join(root, '.gbrain'), { recursive: true, mode: 0o700 });
  dataDir = join(root, '.gbrain', 'brain.pglite');
  const longest = join(dataDir, '.gbrain-persistence.sock');
  if (Buffer.byteLength(longest) > SOCKET_PATH_LIMIT) throw new Error(`fixture socket path is ${Buffer.byteLength(longest)} bytes, over the ${SOCKET_PATH_LIMIT}-byte data-dir socket limit: ${longest}`);
  privateWrite(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dataDir, embedding_disabled: true }));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dataDir });
  try {
    await engine.initSchema();
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Survives the backup.' });
  } finally { await engine.disconnect(); }
});

afterAll(() => { rmSync(temporary, { recursive: true, force: true }); });

test.if(posix)('a stale gbrain socket from a SIGKILLed holder is removed, the dump succeeds and omitted names the removal', async () => {
  const socket = resolveSocketPathForConfig({ engine: 'pglite', database_path: dataDir }, 'persistence')!;
  expect(socket).toBe(join(dataDir, '.gbrain-persistence.sock'));
  await leaveStaleSocket(socket);
  const output = nextOutput();
  const { manifest } = await createPgliteBackup({ output, root });
  expect(existsSync(socket)).toBe(false);
  expect(statSync(output).size).toBeGreaterThan(0);
  expect(manifest.entries.map(e => e.path)).toContain('database.tar');
  const omitted = (manifest as unknown as { omitted: string[] }).omitted;
  expect(omitted).toContain(`Removed stale runtime socket left by an exited gbrain process: ${socket}`);
});

test.if(posix)('a live listener on a gbrain socket without a PGLite owner is kept and the dump refuses with backup_dump_failed', async () => {
  const socket = join(dataDir, '.gbrain-resolve.sock');
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(socket, () => resolve()));
  try {
    const before = dataDirFingerprint();
    const failure = await backupFailure();
    expect(failure.code).toBe('backup_dump_failed');
    expect(failure.message).toContain(socket);
    expect(failure.message).toContain('still listening');
    expect(lstatSync(socket).isSocket()).toBe(true);
    // The listener is untouched: it still accepts a connection.
    await new Promise<void>((resolve, reject) => { const c = net.connect(socket, () => { c.destroy(); resolve(); }); c.on('error', reject); });
    expect(dataDirFingerprint()).toBe(before);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test.if(posix)('a FIFO gbrain does not own is left in place and named', async () => {
  const fifo = join(dataDir, '.operator-tap.fifo');
  execFileSync('mkfifo', [fifo]);
  try {
    const before = dataDirFingerprint();
    const failure = await backupFailure();
    expect(failure.code).toBe('backup_dump_failed');
    expect(failure.message).toContain(fifo);
    expect(failure.message).toContain('FIFO gbrain does not own');
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    expect(dataDirFingerprint()).toBe(before);
  } finally { unlinkSync(fifo); }
});

test.if(posix)('a symlink in place of the gbrain socket is not followed: the link and its target stay', async () => {
  const elsewhere = join(temporary, 'elsewhere.sock');
  await leaveStaleSocket(elsewhere);
  const link = join(dataDir, '.gbrain-persistence.sock');
  symlinkSync(elsewhere, link);
  try {
    const failure = await backupFailure();
    expect(failure.code).toBe('backup_dump_failed');
    expect(failure.message).toContain(link);
    expect(failure.message).toContain('symbolic link');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(lstatSync(elsewhere).isSocket()).toBe(true);
  } finally { unlinkSync(link); unlinkSync(elsewhere); }
});

test.if(posix)('a dump failure leaves the data dir intact and the next backup of the same brain succeeds', async () => {
  const fifo = join(dataDir, '.operator-tap.fifo');
  execFileSync('mkfifo', [fifo]);
  const before = dataDirFingerprint();
  try {
    expect((await backupFailure()).code).toBe('backup_dump_failed');
    expect(dataDirFingerprint()).toBe(before);
  } finally { unlinkSync(fifo); }
  // Nothing of the failed attempt is left behind, the writer lock is free again and the brain dumps.
  expect(readdirSync(temporary).filter(name => name.startsWith('.gbrain-backup-'))).toEqual([]);
  const output = nextOutput();
  const { manifest } = await createPgliteBackup({ output, root });
  expect(manifest.entries.map(e => e.path)).toContain('database.tar');
  expect(statSync(output).size).toBeGreaterThan(0);
});

// ---- #5312 Windows half, Linux-injected classification path (the native claim is the windows-latest row) ----

test.if(posix)('an owned socket the runtime cannot lstat is probed, claimed and, with no native remover, kept as unreadable (never unlinked); the dump refusal names it', async () => {
  const socket = join(dataDir, '.gbrain-persistence.sock');
  await leaveStaleSocket(socket);
  const before = dataDirFingerprint();
  await withUnreadable(socket, 'EACCES', async () => {
    const sweep = await sweepStaleRuntimeArtefacts(dataDir);
    expect(sweep.removed).toEqual([]);
    expect(sweep.kept).toEqual([{ path: socket, reason: 'unreadable' }]);
    const failure = await backupFailure();
    expect(failure.code).toBe('backup_dump_failed');
    expect(failure.message).toContain(socket);
    expect(failure.message).toContain('cannot inspect');
  });
  // The entry is untouched: still a socket, nothing else in the data dir changed.
  expect(lstatSync(socket).isSocket()).toBe(true);
  expect(dataDirFingerprint()).toBe(before);
  unlinkSync(socket);
});

test.if(posix)('an owned socket the runtime cannot lstat but something listens on is kept as live_listener and stays connectable', async () => {
  const socket = join(dataDir, '.gbrain-resolve.sock');
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(socket, () => resolve()));
  try {
    await withUnreadable(socket, 'EACCES', async () => {
      const sweep = await sweepStaleRuntimeArtefacts(dataDir);
      expect(sweep.removed).toEqual([]);
      expect(sweep.kept).toEqual([{ path: socket, reason: 'live_listener' }]);
    });
    expect(await accepts(socket)).toBe(true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test.if(posix)('a foreign entry the runtime cannot lstat is kept as unreadable instead of failing the sweep', async () => {
  const fifo = join(dataDir, '.operator-tap.fifo');
  execFileSync('mkfifo', [fifo]);
  try {
    await withUnreadable(fifo, 'EPERM', async () => {
      const sweep = await sweepStaleRuntimeArtefacts(dataDir);
      expect(sweep.removed).toEqual([]);
      expect(sweep.kept).toEqual([{ path: fifo, reason: 'unreadable' }]);
    });
    expect(lstatSync(fifo).isFIFO()).toBe(true);
  } finally { unlinkSync(fifo); }
});

test.if(posix)('an lstat failure that is not an access or reparse-point class still fails the sweep (EIO is a real I/O fault)', async () => {
  const socket = join(dataDir, '.gbrain-persistence.sock');
  await leaveStaleSocket(socket);
  try {
    await withUnreadable(socket, 'EIO', async () => {
      await expect(sweepStaleRuntimeArtefacts(dataDir)).rejects.toMatchObject({ code: 'EIO' });
    });
  } finally { unlinkSync(socket); }
});

test('a regular file where a gbrain socket is expected is kept as not_a_socket and never removed (every platform)', async () => {
  const path = join(dataDir, '.gbrain-persistence.sock');
  writeFileSync(path, 'not a socket\n');
  try {
    const sweep = await sweepStaleRuntimeArtefacts(dataDir);
    expect(sweep.removed).toEqual([]);
    expect(sweep.kept).toEqual([{ path, reason: 'not_a_socket' }]);
    expect(readFileSync(path, 'utf8')).toBe('not a socket\n');
  } finally { unlinkSync(path); }
});

// ---- native Windows row (test.yml windows-latest, `native_only` dispatch): the stale AF_UNIX reparse point itself ----

test.if(windows)('Windows: a stale gbrain socket from a killed child is removed through the native tag check, omitted names it and the dump succeeds', async () => {
  const socket = resolveSocketPathForConfig({ engine: 'pglite', database_path: dataDir }, 'persistence')!;
  await leaveStaleSocket(socket);
  expect(await accepts(socket)).toBe(false); // dead holder: the probe connect is refused
  const output = nextOutput();
  const { manifest } = await createPgliteBackup({ output, root });
  expect(statSync(output).size).toBeGreaterThan(0);
  expect(manifest.entries.map(e => e.path)).toContain('database.tar');
  expect((manifest as unknown as { omitted: string[] }).omitted).toContain(`Removed stale runtime socket left by an exited gbrain process: ${socket}`);
  // Removed: a fresh listener can bind the same path again.
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.on('error', reject); server.listen(socket, () => resolve()); });
  await new Promise(resolve => server.close(resolve));
});

test.if(windows)('Windows: a live listener on a gbrain socket is kept, still accepts a connection and the dump refuses naming it', async () => {
  const socket = join(dataDir, '.gbrain-resolve.sock');
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(socket, () => resolve()));
  try {
    const sweep = await sweepStaleRuntimeArtefacts(dataDir);
    expect(sweep.removed).toEqual([]);
    expect(sweep.kept).toEqual([{ path: socket, reason: 'live_listener' }]);
    const failure = await backupFailure();
    expect(failure.code).toBe('backup_dump_failed');
    expect(failure.message).toContain(socket);
    expect(await accepts(socket)).toBe(true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test.if(windows)('Windows: a directory junction where a gbrain socket is expected is not an AF_UNIX socket: kept, never removed, its target intact', async () => {
  const target = join(temporary, 'junction-target');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'keep.txt'), 'keep');
  const link = join(dataDir, '.gbrain-persistence.sock');
  symlinkSync(target, link, 'junction');
  try {
    const sweep = await sweepStaleRuntimeArtefacts(dataDir);
    expect(sweep.removed).toEqual([]);
    expect(sweep.kept.map(k => k.path)).toEqual([link]);
    expect(['symlink', 'unreadable']).toContain(sweep.kept[0]!.reason);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(link)).toBe(true);
  } finally { rmSync(link, { recursive: false, force: true }); }
});
