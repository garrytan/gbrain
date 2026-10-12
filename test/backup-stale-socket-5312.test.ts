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
 * Linux-verified: the Windows AF_UNIX reparse-point branch (`removeStaleWindowsSocket`)
 * is exercised only on a native Windows runner.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateWrite } from '../src/core/agent-install/state.ts';
import { createPgliteBackup } from '../src/core/backup/snapshot.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resolveSocketPathForConfig } from '../src/core/context/resolve-ipc.ts';

const posix = process.platform !== 'win32';
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
  expect(lstatSync(path).isSocket()).toBe(true);
}

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

beforeAll(async () => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-5312-socket-')));
  root = join(temporary, 'brain');
  mkdirSync(join(root, '.gbrain'), { recursive: true, mode: 0o700 });
  dataDir = join(root, '.gbrain', 'brain.pglite');
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
