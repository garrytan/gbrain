/**
 * The brain_ref sidecar (src/commands/serve-brain-ref.ts) leaves the PGLite lock and the serve path as they were.
 *
 * Pins:
 *   - the lock's acquire, release and stale-holder functions are byte-for-byte master's (source digests), and their
 *     observable results are unchanged: the lock file keeps master's fields, release removes it, a dead holder is
 *     reported as not held and is taken over;
 *   - the sidecar write is best-effort and off the critical path: a write that fails, an identity read that fails or
 *     stalls in the database, never fails a serve start, a reconnect or a lock release, and a reconnect sends no statement to
 *     the database; no failure line carries the persistence identity.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireLock, inspectLockHolder, liveHolderToken, PGLITE_LOCK_PROTOCOL, readMetadata, releaseLock } from '../src/core/pglite-lock.ts';
import { brainRefSidecarPath, readServeBrainRef, recordServeBrainRefAtStart } from '../src/commands/serve-brain-ref.ts';
import { brainRefFor } from '../src/core/brain-ref.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
let home: string;

beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-brain-ref-safety-')); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** The text of the function that starts with `signature`, through its closing brace. */
function functionText(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`missing ${signature}`);
  let depth = 0;
  for (let i = source.indexOf('{\n', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${signature}`);
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

describe('the PGLite lock is unchanged', () => {
  test('acquire, release and holder inspection are byte-for-byte master\'s (master 1597b77ac8 digests)', () => {
    // test-reads-source-ok[structural]: Minder's ask is that the lock's acquire/release/holder code is byte-for-byte master's; a digest of each function's source is that proof
    const lock = readFileSync(join(ROOT, 'src/core/pglite-lock.ts'), 'utf8');
    const lifecycle = readFileSync(join(ROOT, 'src/core/pglite-lifecycle.ts'), 'utf8');
    expect({
      acquireLock: digest(functionText(lock, 'export async function acquireLock(')),
      acquireKernelLockOnly: digest(functionText(lock, 'export async function acquireKernelLockOnly(')),
      releaseLock: digest(functionText(lock, 'export async function releaseLock(')),
      inspectHolderMetadata: digest(functionText(lock, 'function inspectHolderMetadata(')),
      inspectLockHolder: digest(functionText(lock, 'export function inspectLockHolder(')),
      peekLock: digest(functionText(lock, 'export function peekLock(')),
      registerPgliteReopen: digest(functionText(lifecycle, 'export function registerPgliteReopen(')),
      notifyPgliteOpened: digest(functionText(lifecycle, 'export function notifyPgliteOpened(')),
    }).toEqual({
      // acquireLock changed on purpose: it runs doctor's create guard once it holds the kernel lock, before it creates the folder (the doctor missing-brain follow-up). The other digests stay master's.
      acquireLock: '2fbeaa680d9bc10a',
      acquireKernelLockOnly: '032f1bcef451a37c',
      releaseLock: 'ba777d1371424ba4',
      inspectHolderMetadata: 'e90a1e489ce338f7',
      inspectLockHolder: 'ad79eda60c28558f',
      peekLock: 'c394ab2cf16269db',
      registerPgliteReopen: 'b44dfcd149a2ed2d',
      notifyPgliteOpened: '3fe9bc89fa16496a',
    });
  });

  test('a held lock keeps master\'s lock-file fields; release removes it; the new token reader follows the holder', async () => {
    const dataDir = join(home, 'lock-held.pglite');
    mkdirSync(dataDir, { recursive: true });
    const lock = await acquireLock(dataDir, { timeoutMs: 5_000 });
    try {
      expect(inspectLockHolder(dataDir)).toMatchObject({ held: true, pid: process.pid });
      const metadata = readMetadata(join(dataDir, '.gbrain-lock'))!;
      expect(Object.keys(metadata).sort()).toEqual(
        ['acquired_at', 'argv', 'boot_id', 'command', 'owner_token', 'pid', 'pid_ns', 'protocol', 'refreshed_at', 'subcommand'].filter(k => k in metadata).sort());
      expect(Object.keys(metadata).some(k => k.includes('brain'))).toBe(false);
      expect(liveHolderToken(dataDir)).toBe(metadata.owner_token!);
    } finally {
      await releaseLock(lock);
    }
    expect(inspectLockHolder(dataDir)).toEqual({ held: false });
    expect(existsSync(join(dataDir, '.gbrain-lock'))).toBe(false);
    expect(liveHolderToken(dataDir)).toBeNull();
  });

  test('a dead holder reads as not held, its token is never trusted, and the next acquire takes the lock', async () => {
    const dataDir = join(home, 'lock-stale.pglite');
    mkdirSync(join(dataDir, '.gbrain-lock'), { recursive: true });
    const dead = 2 ** 22 + 12_345;
    // A holder of this protocol that died without releasing: its lock dir and the protocol marker stay behind.
    writeFileSync(`${dataDir}.gbrain-owner.json`, JSON.stringify({ protocol: PGLITE_LOCK_PROTOCOL }));
    writeFileSync(join(dataDir, '.gbrain-lock', 'lock'), JSON.stringify({ pid: dead, acquired_at: 1, owner_token: 'old-holder', protocol: PGLITE_LOCK_PROTOCOL }));
    expect(inspectLockHolder(dataDir)).toEqual({ held: false, pid: dead });
    expect(liveHolderToken(dataDir)).toBeNull();
    const lock = await acquireLock(dataDir, { timeoutMs: 5_000 });
    try {
      expect(inspectLockHolder(dataDir)).toMatchObject({ held: true, pid: process.pid });
    } finally {
      await releaseLock(lock);
    }
  });
});

describe('the brain_ref write is best-effort and off the critical path', () => {
  let engine: PGLiteEngine;
  let dataDir: string;
  let brainId: string;

  beforeAll(async () => {
    dataDir = join(home, 'served.pglite');
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dataDir });
    await engine.initSchema();
    brainId = (await engine.readPersistenceBrainId())!;
  }, 120_000);

  afterAll(async () => { await engine?.disconnect(); });

  const noIdentity = (text: string) => {
    for (const s of [brainId, brainId.replace(/-/g, '')]) expect(text.toLowerCase().includes(s)).toBe(false);
  };

  test('a reconnect rewrites the file under the new token without reading the identity from the database again', async () => {
    const original = engine.readPersistenceBrainId.bind(engine);
    let reads = 0;
    const counted = Object.assign(engine, { readPersistenceBrainId: async () => { reads++; return original(); } });
    try {
      await recordServeBrainRefAtStart(counted, () => {});
      expect(reads).toBe(1);
      await engine.reconnect();
      const deadline = Date.now() + 10_000;
      while (readServeBrainRef(dataDir).brain_ref === null && Date.now() < deadline) await Bun.sleep(20);
      expect(readServeBrainRef(dataDir)).toEqual({ brain_ref: brainRefFor(brainId) });
      expect(reads).toBe(1);
    } finally {
      delete (engine as unknown as Record<string, unknown>).readPersistenceBrainId;
    }
  }, 60_000);

  test('a write that fails costs one log line with no identity; reconnect and lock release still succeed', async () => {
    const path = brainRefSidecarPath(dataDir);
    rmSync(path, { force: true });
    mkdirSync(path); // rename onto a directory fails
    const lines: string[] = [];
    try {
      await recordServeBrainRefAtStart(engine, line => lines.push(line));
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/^\[gbrain serve\] brain_ref not recorded for engine status \([A-Z]+\)$/);
      noIdentity(lines.join('\n'));
      await engine.reconnect();
      expect(await engine.readPersistenceBrainId()).toBe(brainId);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  }, 60_000);

  test('an identity read that fails, its message holding the identity, is logged by code only', async () => {
    const lines: string[] = [];
    let calls = 0;
    Object.assign(engine, { readPersistenceBrainId: async () => { calls++; throw Object.assign(new Error(`read failed for ${brainId}`), { code: 'EFAKE' }); } });
    try {
      await recordServeBrainRefAtStart(engine, line => lines.push(line));
    } finally {
      delete (engine as unknown as Record<string, unknown>).readPersistenceBrainId;
    }
    expect(calls).toBe(1);
    expect(lines).toEqual(['[gbrain serve] brain_ref not recorded for engine status (EFAKE)']);
    noIdentity(lines.join('\n'));
  });

  test('after a failed first write, a reconnect admits no identity query, so a stalled one cannot delay reconnect or release', async () => {
    const path = brainRefSidecarPath(dataDir);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path); // the first write fails
    const lines: string[] = [];
    await recordServeBrainRefAtStart(engine, line => lines.push(line));
    expect(lines.length).toBe(1);
    rmSync(path, { recursive: true, force: true });
    let reads = 0;
    // A read that reaches the database and stalls there: close drains admitted statements before it releases the lock.
    Object.assign(engine, { readPersistenceBrainId: async () => {
      reads++;
      await engine.executeRaw('SELECT pg_sleep(3)');
      return brainId;
    } });
    try {
      let started = performance.now();
      await engine.reconnect();
      await new Promise(resolve => setImmediate(resolve));
      await Bun.sleep(50);
      expect(performance.now() - started).toBeLessThan(2_500);
      started = performance.now();
      await engine.disconnect();
      expect(performance.now() - started).toBeLessThan(2_500);
      expect(inspectLockHolder(dataDir)).toEqual({ held: false });
      expect(reads).toBe(0);
      expect(readServeBrainRef(dataDir).brain_ref).toBeNull();
    } finally {
      delete (engine as unknown as Record<string, unknown>).readPersistenceBrainId;
      await engine.connect({ engine: 'pglite', database_path: dataDir });
    }
  }, 60_000);
});

describe('a serve whose brain_ref write fails still starts and serves', () => {
  let serve: ChildProcess | null = null;
  let serveErr = '';
  let serveHome: string;
  let dataDir: string;

  const env = () => keylessBrainEnv(process.env, serveHome, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_BRAIN_ID: undefined, GBRAIN_SOURCE: undefined,
    GBRAIN_NON_INTERACTIVE: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_BANNER: '1', NO_COLOR: '1',
  });
  const gbrain = async (args: string[]) => {
    const proc = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], { cwd: serveHome, env: env(), stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, status };
  };

  beforeAll(async () => {
    serveHome = mkdtempSync(join(tmpdir(), 'gbrain-brain-ref-serve-fail-'));
    const init = await gbrain(['init', '--pglite', '--no-embedding', '--json']);
    if (init.status !== 0) throw new Error(`init failed:\n${init.stdout}\n${init.stderr}`);
    dataDir = JSON.parse(readFileSync(join(serveHome, '.gbrain', 'config.json'), 'utf8')).database_path;
    mkdirSync(brainRefSidecarPath(dataDir)); // every write fails
    serve = spawn(process.execPath, ['--no-env-file', CLI, 'serve'], { cwd: serveHome, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    serve.stderr?.on('data', (d: Buffer) => { serveErr += d.toString(); });
    const deadline = Date.now() + 90_000;
    while (!serveErr.includes('brain_ref not recorded') && Date.now() < deadline) await Bun.sleep(200);
  }, 180_000);

  afterAll(async () => {
    if (serve) {
      const exited = new Promise(resolve => serve!.once('exit', resolve));
      serve.stdin?.end();
      serve.kill('SIGTERM');
      await Promise.race([exited, Bun.sleep(15_000)]);
      try { serve.kill('SIGKILL'); } catch { /* gone */ }
    }
    rmSync(serveHome, { recursive: true, force: true });
  });

  test('serve logs one line, keeps running and holding the brain; the probe reports no reference', async () => {
    expect(serveErr).toContain('[gbrain serve] brain_ref not recorded for engine status');
    expect(serve!.exitCode).toBeNull();
    const r = await gbrain(['engine', 'status', '--json', '--probe']);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(report.probe.note).toBe('locked_by_serve');
    expect(report.probe.brain_ref).toBeNull();
    expect(report.probe.brain_ref_note).toBe('serve_brain_ref_missing');
  }, 120_000);
});
