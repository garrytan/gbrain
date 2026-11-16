/**
 * The managed-writer preflight probe (`probeWorktreeWriter`) waits up to
 * MANAGED_WRITER_PROBE_WAIT_MS for the worktree lock: this process's own
 * persistence consumer holds it while it finishes publishing the previous
 * write, after that receipt already reads committed. The facts preflight, the
 * atom-maintenance session and the connector-sync preflight all use it. A
 * holder that releases within the bound is waited out; one held past it is
 * still busy. #7461: the atom session waits the longer of that bound and its
 * maintenance publish wait, because the previous batch's Git effects can hold
 * the lock past one second; past its deadline it refuses with
 * writer_lock_unavailable, and a job whose publish is already pending (wait
 * 0) still gets the one-second probe.
 *
 * Synthetic data only. PGLite.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { managedAtomSession } from '../src/core/persistence/atom-maintenance.ts';
import { MaintenanceWriteWait } from '../src/core/persistence/maintenance-wait.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding, MANAGED_WRITER_PROBE_WAIT_MS, probeWorktreeWriter, type WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
let sourceId: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-writer-probe-')); });
afterEach(async () => {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  rmSync(home, { recursive: true, force: true });
});

async function managedSource(): Promise<WorktreeBinding> {
  sourceId = `wp-${randomUUID().slice(0, 8)}`;
  const root = mkdtempSync(join(home, 'root-'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return (await getWorktreeBinding(engine, sourceId))!;
}

/** Takes the worktree lock now and releases it after `ms`; `released` settles after the release. */
async function hold(binding: WorktreeBinding, ms: number): Promise<{ released: Promise<void> }> {
  const lock = await acquireWorktree(binding, 0, undefined, engine);
  expect(lock).not.toBeNull();
  return { released: new Promise<void>(resolve => setTimeout(() => { void lock!.release().then(resolve); }, ms)) };
}

const run = (fn: () => Promise<void>) => withEnv({ GBRAIN_HOME: home }, fn);

describe('probeWorktreeWriter (connector-sync and facts preflights)', () => {
  test('a holder that releases at 200 ms is waited out', () => run(async () => {
    const binding = await managedSource();
    const { released } = await hold(binding, 200);
    expect(await probeWorktreeWriter(binding, engine)).toBe(true);
    await released;
  }), 30_000);

  test('a holder kept past the bound leaves the writer busy', () => run(async () => {
    const binding = await managedSource();
    const { released } = await hold(binding, MANAGED_WRITER_PROBE_WAIT_MS + 1500);
    const started = performance.now();
    expect(await probeWorktreeWriter(binding, engine)).toBe(false);
    expect(performance.now() - started).toBeGreaterThanOrEqual(MANAGED_WRITER_PROBE_WAIT_MS - 50);
    await released;
  }), 30_000);
});

describe('managedAtomSession preflight', () => {
  test('a holder that releases at 200 ms is waited out', () => run(async () => {
    const binding = await managedSource();
    const { released } = await hold(binding, 200);
    expect(await managedAtomSession(engine, sourceId)).not.toBeNull();
    await released;
  }), 30_000);

  test('a holder that outlasts a job near its deadline refuses with writer_lock_unavailable after the probe', () => run(async () => {
    const binding = await managedSource();
    const nearDeadline = new MaintenanceWriteWait(Date.now() + 200);
    const busy = await hold(binding, MANAGED_WRITER_PROBE_WAIT_MS + 2000);
    const started = performance.now();
    await expect(managedAtomSession(engine, sourceId, undefined, nearDeadline)).rejects.toMatchObject({ code: 'writer_lock_unavailable' });
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(MANAGED_WRITER_PROBE_WAIT_MS - 50);
    expect(waited).toBeLessThan(MANAGED_WRITER_PROBE_WAIT_MS + 1500);
    await busy.released;
  }), 30_000);

  test('a holder that releases after the one-second probe but within the publish wait is waited out', () => run(async () => {
    const binding = await managedSource();
    const busy = await hold(binding, MANAGED_WRITER_PROBE_WAIT_MS + 800);
    const started = performance.now();
    const session = await managedAtomSession(engine, sourceId);
    expect(session).toMatchObject({ sourceId });
    expect(performance.now() - started).toBeGreaterThanOrEqual(MANAGED_WRITER_PROBE_WAIT_MS + 700);
    await busy.released;
  }), 30_000);

  test('a job whose publish is pending (wait 0) still waits the one-second probe', () => run(async () => {
    const binding = await managedSource();
    const wait = new MaintenanceWriteWait();
    wait.observe({ state: 'queued' } as WriteRequest);
    expect(wait.ms()).toBe(0);
    const { released } = await hold(binding, 400);
    expect(await managedAtomSession(engine, sourceId, undefined, wait)).not.toBeNull();
    await released;
    const busy = await hold(binding, MANAGED_WRITER_PROBE_WAIT_MS + 1500);
    const started = performance.now();
    await expect(managedAtomSession(engine, sourceId, undefined, wait)).rejects.toMatchObject({ code: 'writer_lock_unavailable' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(MANAGED_WRITER_PROBE_WAIT_MS - 50);
    await busy.released;
  }), 30_000);

  test('an abort ends the wait before the publish budget', () => run(async () => {
    const binding = await managedSource();
    const { released } = await hold(binding, 4000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stopped')), 300);
    const started = performance.now();
    await expect(managedAtomSession(engine, sourceId, undefined, new MaintenanceWriteWait(), controller.signal)).rejects.toBeDefined();
    expect(performance.now() - started).toBeLessThan(MANAGED_WRITER_PROBE_WAIT_MS);
    await released;
  }), 30_000);
});
