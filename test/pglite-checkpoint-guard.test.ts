/** #5449: the outermost PGLite write transaction checkpoints before BEGIN; savepoints never do. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CHECKPOINT_GUARD_MAX_BYTES, PgliteCheckpointGuard, checkpointGuardThreshold } from '../src/core/pglite-engine/checkpoint-guard.ts';
import { GBrainError } from '../src/core/types.ts';

const MB = 1024 * 1024;
type Guarded = { _checkpointGuard: PgliteCheckpointGuard | undefined; db: { query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> } };

function install(engine: PGLiteEngine, opts: { threshold?: number; fail?: RegExp; warnings?: string[] } = {}) {
  const calls: string[] = [];
  const inner = engine as unknown as Guarded;
  const guard = new PgliteCheckpointGuard(async sql => {
    calls.push(sql);
    if (opts.fail?.test(sql)) throw new Error('synthetic failure');
    return inner.db.query(sql);
  }, message => opts.warnings?.push(message));
  if (opts.threshold !== undefined) (guard as unknown as { threshold: number }).threshold = opts.threshold;
  inner._checkpointGuard = guard;
  return { checkpoints: () => calls.filter(sql => sql === 'CHECKPOINT').length, calls };
}

describe('checkpoint guard threshold', () => {
  test('default max_wal_size keeps the plan threshold of 256 MB', () => {
    expect(checkpointGuardThreshold(1024 * MB, 16 * MB, 0.9)).toBe(CHECKPOINT_GUARD_MAX_BYTES);
  });
  test('small max_wal_size stays below the automatic trigger distance', () => {
    // floor(160 / (16 * 1.9)) = 5 segments: the trigger fires >= 48 MB after redo.
    expect(checkpointGuardThreshold(160 * MB, 16 * MB, 0.9)).toBe(32 * MB);
    expect(checkpointGuardThreshold(32 * MB, 16 * MB, 0.9)).toBe(8 * MB);
  });
});

describe('PGLite outermost transaction guard', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.executeRaw('CREATE TABLE guard_probe (id int PRIMARY KEY, v text)');
  });
  afterAll(async () => { await engine.disconnect(); });

  test('a nested transaction composes as a savepoint and never checkpoints', async () => {
    const spy = install(engine, { threshold: 0 });
    await engine.transaction(async tx => {
      await tx.executeRaw("INSERT INTO guard_probe VALUES (1, 'outer')");
      await tx.transaction(async inner => { await inner.executeRaw("INSERT INTO guard_probe VALUES (2, 'inner')"); });
    });
    expect(spy.checkpoints()).toBe(1);
    expect((await engine.executeRaw('SELECT count(*)::int AS n FROM guard_probe'))[0]).toEqual({ n: 2 });
  });

  test('a rolled-back transaction leaves no rows and the next transaction still runs', async () => {
    install(engine, { threshold: 0 });
    await expect(engine.transaction(async tx => {
      await tx.executeRaw("INSERT INTO guard_probe VALUES (3, 'rolled back')");
      throw new Error('abort');
    })).rejects.toThrow('abort');
    await engine.transaction(async tx => { await tx.executeRaw("INSERT INTO guard_probe VALUES (4, 'after')"); });
    expect((await engine.executeRaw<{ id: number }>('SELECT id FROM guard_probe ORDER BY id')).map(row => row.id)).toEqual([1, 2, 4]);
  });

  test('concurrent outermost transactions each probe the WAL their predecessors wrote', async () => {
    await engine.executeRaw('CREATE TABLE IF NOT EXISTS guard_bulk (id int, v text)');
    await engine.executeRaw('CHECKPOINT');
    const spy = install(engine, { threshold: 64 * 1024 });
    await Promise.all([0, 1, 2].map(n => engine.transaction(async tx => {
      await tx.executeRaw("INSERT INTO guard_bulk SELECT g, repeat('x', 200) FROM generate_series(1, 2000) g");
      return n;
    })));
    // A shared stale probe would let all three pass unguarded after the manual checkpoint.
    expect(spy.checkpoints()).toBeGreaterThanOrEqual(2);
  });

  test('below the threshold no checkpoint runs', async () => {
    const spy = install(engine, { threshold: Number.MAX_SAFE_INTEGER });
    await engine.transaction(async tx => { await tx.executeRaw("UPDATE guard_probe SET v='x' WHERE id=4"); });
    expect(spy.checkpoints()).toBe(0);
  });

  test('a WAL probe failure warns once and proceeds unguarded', async () => {
    const warnings: string[] = [];
    const spy = install(engine, { fail: /pg_control_checkpoint|current_setting/, warnings });
    await engine.transaction(async tx => { await tx.executeRaw("INSERT INTO guard_probe VALUES (5, 'probe failed')"); });
    await engine.transaction(async tx => { await tx.executeRaw("INSERT INTO guard_probe VALUES (6, 'probe failed')"); });
    expect(warnings.length).toBe(1);
    expect(spy.checkpoints()).toBe(0);
    expect((await engine.executeRaw('SELECT count(*)::int AS n FROM guard_probe WHERE id IN (5,6)'))[0]).toEqual({ n: 2 });
  });

  test('a CHECKPOINT failure refuses before BEGIN with a typed error', async () => {
    install(engine, { threshold: 0, fail: /^CHECKPOINT$/ });
    let entered = false;
    const refused = await engine.transaction(async tx => {
      entered = true;
      await tx.executeRaw("INSERT INTO guard_probe VALUES (7, 'never')");
    }).catch(error => error);
    expect(refused).toBeInstanceOf(GBrainError);
    expect(String(refused.message)).toContain('gbrain pglite-repair');
    expect(entered).toBe(false);
    expect(await engine.executeRaw('SELECT id FROM guard_probe WHERE id=7')).toEqual([]);
  });
});

describe('guard checkpoint durability', () => {
  let dir: string;
  let reopened: PGLiteEngine;
  let checkpoints = 0;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-checkpoint-guard-'));
    const path = join(dir, 'brain.pglite');
    const first = new PGLiteEngine();
    await first.connect({ engine: 'pglite', database_path: path } as never);
    await first.executeRaw('CREATE TABLE guard_durable (id int PRIMARY KEY)');
    const spy = install(first, { threshold: 0 });
    for (let i = 0; i < 3; i++) await first.transaction(async tx => { await tx.executeRaw('INSERT INTO guard_durable VALUES ($1)', [i]); });
    checkpoints = spy.checkpoints();
    await first.disconnect();
    reopened = new PGLiteEngine();
    await reopened.connect({ engine: 'pglite', database_path: path } as never);
  }, 60_000);
  afterAll(async () => {
    await reopened.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes committed after a guard checkpoint survive a reopen', async () => {
    expect(checkpoints).toBe(3);
    expect((await reopened.executeRaw('SELECT count(*)::int AS n FROM guard_durable'))[0]).toEqual({ n: 3 });
  });
});

describe('guarded transactions and shutdown', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.executeRaw('CREATE TABLE guard_drain (id int PRIMARY KEY)');
  });
  afterAll(async () => { await engine.disconnect(); });

  test('a transaction queued behind another still completes when disconnect starts', async () => {
    install(engine, { threshold: 0 });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const first = engine.transaction(async tx => {
      await tx.executeRaw('INSERT INTO guard_drain VALUES (1)');
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const second = engine.transaction(async tx => { await tx.executeRaw('INSERT INTO guard_drain VALUES (2)'); return 'second'; });
    const closing = engine.disconnect();
    release.resolve();
    await first;
    expect(await second).toBe('second');
    await closing;
    await engine.connect({});
  });

  test('a reattached database gets a fresh guard that rereads WAL settings', async () => {
    const guarded = engine as unknown as Guarded;
    delete (guarded as { _checkpointGuard?: unknown })._checkpointGuard;
    await engine.transaction(async tx => { await tx.executeRaw('SELECT 1'); });
    const before = guarded._checkpointGuard;
    expect(before).toBeInstanceOf(PgliteCheckpointGuard);
    await engine.disconnect();
    await engine.connect({});
    expect(guarded._checkpointGuard).toBeUndefined();
    await engine.transaction(async tx => { await tx.executeRaw('SELECT 1'); });
    expect(guarded._checkpointGuard).not.toBe(before);
  });
});
