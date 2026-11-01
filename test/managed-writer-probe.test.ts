/**
 * The managed-writer preflight probe (`probeWorktreeWriter`) waits up to
 * MANAGED_WRITER_PROBE_WAIT_MS for the worktree lock: this process's own
 * persistence consumer holds it while it finishes publishing the previous
 * write, after that receipt already reads committed. The facts preflight, the
 * atom-maintenance session and the connector-sync preflight all use it. A
 * holder that releases within the bound is waited out; one held past it is
 * still busy. Atom sessions use their maintenance wait budget so Git effects
 * lasting longer than a single probe do not interrupt drains or retirement.
 * Regression: restoring the one-second atom probe rejects the delayed-release
 * case below. Existing short-release coverage does not exercise that contention;
 * these tests use real native locks and require no new production test seam.
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

  test('a holder kept past the maintenance deadline still refuses with writer_lock_unavailable', () => run(async () => {
    const binding = await managedSource();
    const { released } = await hold(binding, MANAGED_WRITER_PROBE_WAIT_MS + 1500);
    const wait = new MaintenanceWriteWait(Date.now() + MANAGED_WRITER_PROBE_WAIT_MS);
    await expect(managedAtomSession(engine, sourceId, undefined, wait)).rejects.toMatchObject({ code: 'writer_lock_unavailable' });
    await released;
  }), 30_000);

  test('waits through Git-effect contention beyond the short probe', () => run(async () => {
    const binding = await managedSource();
    const { released } = await hold(binding, MANAGED_WRITER_PROBE_WAIT_MS + 1500);
    try {
      const session = await managedAtomSession(engine, sourceId);
      expect(session?.sourceId).toBe(sourceId);
      const lock = await acquireWorktree(binding, 0, undefined, engine);
      expect(lock).not.toBeNull();
      await lock?.release();
    } finally {
      await released;
    }
  }), 30_000);
});
