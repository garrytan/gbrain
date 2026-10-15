/**
 * Engine graduation filesystem custody: intent marker, tombstone, lock-free
 * path inspection, lock-retaining close, held-lock move-aside and the PGLite
 * open-path refusals.
 *
 * Protects: the kernel lock never gaps between close, rename and tombstone
 * (no opener acquires it and none creates a data dir); the tombstone is
 * exclusive and 0600; a tombstoned path refuses with engine_graduated and is
 * never re-initialised; a live marker refuses opens before the lock while a
 * dead pre-cutover marker lets the source open; a dead marker past cutover is
 * graduation_interrupted with the lock released. Regressions that fail it: a
 * close that releases the lock, a tombstone write that overwrites, an opener
 * that mkdirs over the tombstone, a liveness check fooled by PID reuse.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPgliteGraduationOpenable, currentProcessIdentity, graduatedPath, graduationHandOffRequested, inspectGraduationPath,
  intentMarkerPath, moveAsideHeld, processStartTime, readIntentMarker, readTombstone, registerGraduationRunInProcess, removeTombstone,
  TombstonePathOccupiedError, writeIntentMarker, writeTombstone,
} from '../src/core/persistence/graduation-custody.ts';
import type { IntentMarker, ManifestState, Tombstone } from '../src/core/persistence/engine-graduation.types.ts';
import { acquireKernelLockOnly, acquireLock, PgliteBusyError, releaseLock, type LockHandle } from '../src/core/pglite-lock.ts';
import { moveHeldPglite } from '../src/core/persistence/maintenance.ts';
import { newPgliteEngine, openPglite } from './helpers/graduation-harness.ts';

const target = { id: 'target-id', host: 'db.example.test', port: 5432, database: 'brain', user: 'alice-example' };
function marker(runId: string, state: ManifestState, identity: Partial<IntentMarker> = {}): IntentMarker {
  return { runId, state, ...currentProcessIdentity(), target, updatedAt: new Date().toISOString(), ...identity };
}
function tombstone(runId: string, movedTo: string): Tombstone {
  return { kind: 'gbrain-engine-graduated', runId, brainId: 'brain', movedTo, target, targetDisplayUrl: 'postgres://alice-example@db.example.test:5432/brain',
    graduatedAt: new Date().toISOString(), fixArgv: ['gbrain', 'config', 'set', 'database_url', '<GBRAIN_TARGET_URL>'] };
}
function codeOf(error: unknown): string | undefined { return (error as { code?: string })?.code; }
function deadPid(): number {
  const child = Bun.spawnSync(['sh', '-c', 'echo $$']);
  return Number(child.stdout.toString().trim());
}

let root: string;
beforeAll(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-custody-'))); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('intent marker and tombstone files', () => {
  test('the marker is replaced atomically with mode 0600; an unreadable one is never read as "no graduation"', () => {
    const dir = join(root, 'marker.pglite');
    mkdirSync(dir);
    expect(readIntentMarker(dir)).toBeNull();
    writeIntentMarker(dir, marker('run-a', 'planned'));
    writeIntentMarker(dir, marker('run-a', 'quiesced'));
    expect(readIntentMarker(dir)?.state).toBe('quiesced');
    expect(statSync(intentMarkerPath(dir)).mode & 0o777).toBe(0o600);
    writeFileSync(intentMarkerPath(dir), '{not json');
    expect(() => readIntentMarker(dir)).toThrow();
    expect(inspectGraduationPath(dir).state).toBe('interrupted');
  });

  test('the tombstone is created exclusively, 0600, and only its own run removes it', () => {
    const path = join(root, 'tomb.pglite');
    writeTombstone(path, tombstone('run-t', `${path}.graduated-run-t`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeTombstone(path, tombstone('run-u', 'x'))).toThrow(TombstonePathOccupiedError);
    expect(readTombstone(path)?.runId).toBe('run-t');
    expect(() => removeTombstone(path, 'run-u')).toThrow(/belongs to graduation run run-t/);
    removeTombstone(path, 'run-t');
    expect(existsSync(path)).toBe(false);
    mkdirSync(path);
    expect(() => writeTombstone(path, tombstone('run-t', 'x'))).toThrow(TombstonePathOccupiedError);
    expect(readTombstone(path)).toBeNull();
  });
});

describe('inspectGraduationPath and marker liveness', () => {
  test('a missing boot or namespace probe cannot establish the recorded identity', () => {
    // Keep module mocks in a child so other lock suites retain the real probes.
    for (const missing of ['boot', 'namespace']) {
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'helpers/graduation-probe-child.ts'), missing],
        { stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
    }
  }, 45_000);

  test('none, in_progress, interrupted, graduated and split_brain', () => {
    const dir = join(root, 'inspect.pglite');
    mkdirSync(dir);
    expect(inspectGraduationPath(dir).state).toBe('none');
    const unregister = registerGraduationRunInProcess('run-live');
    writeIntentMarker(dir, marker('run-live', 'copying'));
    expect(inspectGraduationPath(dir)).toMatchObject({ state: 'in_progress', liveness: 'alive' });
    unregister();
    expect(inspectGraduationPath(dir)).toMatchObject({ state: 'interrupted', liveness: 'dead' });
    writeIntentMarker(dir, marker('run-dead', 'copying', { pid: deadPid(), processStart: null }));
    expect(inspectGraduationPath(dir)).toMatchObject({ state: 'interrupted', liveness: 'dead' });
    writeIntentMarker(dir, marker('run-reused', 'copying', { pid: process.ppid, processStart: '1' }));
    if (processStartTime(process.ppid)) expect(inspectGraduationPath(dir).liveness).toBe('dead');
    writeIntentMarker(dir, marker('run-other-host', 'copying', { pid: process.ppid, bootId: 'another-boot' }));
    expect(inspectGraduationPath(dir).liveness).toBe('unknown');
    writeIntentMarker(dir, marker('run-other-namespace', 'copying', { pid: process.ppid, pidNs: 'another-namespace' }));
    expect(inspectGraduationPath(dir).liveness).toBe('unknown');
    writeIntentMarker(dir, marker('run-split', 'tombstoned', { pid: deadPid() }));
    mkdirSync(graduatedPath(dir, 'run-split'));
    expect(inspectGraduationPath(dir)).toMatchObject({ state: 'split_brain', movedTo: graduatedPath(dir, 'run-split') });
    writeIntentMarker(dir, marker('run-split', 'rolled_back'));
    expect(inspectGraduationPath(dir).state).toBe('none');
    const tombPath = join(root, 'inspect-tomb.pglite');
    writeTombstone(tombPath, tombstone('run-g', `${tombPath}.graduated-run-g`));
    expect(inspectGraduationPath(tombPath)).toMatchObject({ state: 'graduated', tombstone: { runId: 'run-g' } });
  });

  test('a serve hands off only to a live requester on another process', () => {
    const dir = join(root, 'handoff.pglite');
    mkdirSync(dir);
    writeIntentMarker(dir, marker('run-self', 'planned'));
    expect(graduationHandOffRequested(dir)).toBeNull();
    writeIntentMarker(dir, marker('run-dead', 'planned', { pid: deadPid(), processStart: null }));
    expect(graduationHandOffRequested(dir)).toBeNull();
    writeIntentMarker(dir, marker('run-parent', 'planned', { pid: process.ppid, processStart: processStartTime(process.ppid) }));
    expect(graduationHandOffRequested(dir)?.runId).toBe('run-parent');
  });
});

describe('lock-retaining close and held-lock move-aside', () => {
  test('the kernel lock never gaps from close through rename and tombstone; the tombstone then refuses every opener', async () => {
    const dataDir = join(root, 'custody.pglite');
    const engine = await openPglite(dataDir);
    let lock: LockHandle | null = null;
    const attempts: string[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        try { const stolen = await acquireLock(dataDir, { timeoutMs: 0 }); attempts.push('acquired'); await releaseLock(stolen); }
        catch (error) { attempts.push(error instanceof PgliteBusyError ? 'busy' : codeOf(error) ?? (error as Error).message); }
        await Bun.sleep(5);
      }
    })();
    try {
      await engine.executeRaw('CREATE TABLE kept (id int primary key)');
      await engine.executeRaw('INSERT INTO kept VALUES (1)');
      lock = await engine.closeRetainingLock();
      await engine.disconnect();
      expect(lock.acquired).toBe(true);
      await Bun.sleep(30);
      const movedTo = await moveAsideHeld(dataDir, lock, 'run-c');
      expect(lock.lockDir).toBe(join(movedTo, '.gbrain-lock'));
      expect(existsSync(dataDir)).toBe(false);
      await Bun.sleep(30);
      writeTombstone(dataDir, tombstone('run-c', movedTo));
      await Bun.sleep(30);
    } finally {
      polling = false;
      await poller;
      if (lock) await releaseLock(lock);
    }
    expect(attempts.length).toBeGreaterThan(3);
    expect(attempts).not.toContain('acquired');
    expect(lstatSync(dataDir).isFile()).toBe(true);
    await expect(acquireLock(dataDir, { timeoutMs: 0 })).rejects.toThrow(/EEXIST|ENOTDIR|not a directory|file already exists/i);
    expect(lstatSync(dataDir).isFile()).toBe(true);
    expect(codeOf(await openPglite(dataDir).catch(e => e))).toBe('engine_graduated');
    const retained = await openPglite(graduatedPath(dataDir, 'run-c'));
    try { expect(await retained.executeRaw('SELECT id FROM kept')).toEqual([{ id: 1 }]); } finally { await retained.disconnect(); }
  }, 30_000);

  test('a held lock moves only its own datastore, and a held-lock open adopts it without a gap', async () => {
    const dataDir = join(root, 'adopt.pglite');
    const other = join(root, 'adopt-other.pglite');
    mkdirSync(other);
    const engine = await openPglite(dataDir);
    const lock = await engine.closeRetainingLock();
    await engine.disconnect();
    expect(() => moveHeldPglite(other, `${other}.moved`, lock)).toThrow(/does not belong/);
    const moved = `${dataDir}.graduated-run-adopt`;
    moveHeldPglite(dataDir, moved, lock);
    moveHeldPglite(moved, dataDir, lock);
    await expect(acquireLock(dataDir, { timeoutMs: 0 })).rejects.toBeInstanceOf(PgliteBusyError);
    const adopted = newPgliteEngine();
    await adopted.connectWithHeldLock({ engine: 'pglite', database_path: dataDir }, lock);
    try { expect(await adopted.executeRaw('SELECT 1 AS one')).toEqual([{ one: 1 }]); } finally { await adopted.disconnect(); }
    const after = await openPglite(dataDir);
    await after.disconnect();
  }, 30_000);

  test('a kernel-only lock on a tombstoned path creates nothing and excludes openers', async () => {
    const path = join(root, 'kernel-only.pglite');
    writeTombstone(path, tombstone('run-k', `${path}.graduated-run-k`));
    const lock = await acquireKernelLockOnly(path, { lockDir: join(`${path}.graduated-run-k`, '.gbrain-lock'), timeoutMs: 0 });
    try {
      await expect(acquireKernelLockOnly(path, { lockDir: 'x', timeoutMs: 0 })).rejects.toBeInstanceOf(PgliteBusyError);
      expect(lstatSync(path).isFile()).toBe(true);
    } finally { await releaseLock(lock); }
  }, 30_000);
});

describe('PGLite open-path refusals', () => {
  test('a dead run before cutover lets the source open; past cutover it is interrupted and the lock is released', async () => {
    const dataDir = join(root, 'open.pglite');
    const first = await openPglite(dataDir);
    await first.disconnect();
    writeIntentMarker(dataDir, marker('run-o', 'verified', { pid: deadPid(), processStart: null }));
    const opened = await openPglite(dataDir);
    await opened.disconnect();
    writeIntentMarker(dataDir, marker('run-o', 'cutover', { pid: deadPid(), processStart: null }));
    const refused = await openPglite(dataDir).catch(e => e);
    expect(codeOf(refused)).toBe('graduation_interrupted');
    expect(refused.fix?.argv).toEqual(['gbrain', 'migrate', '--resume']);
    const lock = await acquireLock(dataDir, { timeoutMs: 0 });
    await releaseLock(lock);
  }, 30_000);

  test('a live run on another process refuses before the lock, and the refusal names the status command', () => {
    const dataDir = join(root, 'live.pglite');
    mkdirSync(dataDir);
    writeIntentMarker(dataDir, marker('run-p', 'copying', { pid: process.ppid, processStart: processStartTime(process.ppid) }));
    let error: unknown;
    try { assertPgliteGraduationOpenable(dataDir, 'pre_lock'); } catch (e) { error = e; }
    expect(codeOf(error)).toBe('graduation_in_progress');
    expect((error as { fix?: { argv?: string[]; actor?: string } }).fix).toMatchObject({ argv: ['gbrain', 'migrate', '--status', '--json'], actor: 'provider' });
    expect(readFileSync(intentMarkerPath(dataDir), 'utf8')).toContain('run-p');
  });
});
