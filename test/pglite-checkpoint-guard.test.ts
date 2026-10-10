/**
 * #5449: the outermost PGLite write transaction checkpoints before BEGIN; savepoints never do.
 * An autocommit write statement (executeRaw outside engine.transaction()) takes the same guard:
 * the PGLite 20k scale tier wedged in its raw vector UPDATEs once WAL crossed the trigger.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CHECKPOINT_GUARD_MAX_BYTES, PgliteCheckpointGuard, checkpointGuardThreshold, writesWal } from '../src/core/pglite-engine/checkpoint-guard.ts';
import { GBrainError } from '../src/core/types.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

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

describe('autocommit write statements take the guard', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.executeRaw('CREATE TABLE autocommit_probe (id int PRIMARY KEY, v text)');
  });
  afterAll(async () => { await engine.disconnect(); });

  test('writes, DML in a WITH and DDL are guarded; reads and transaction control are not', () => {
    for (const sql of ['INSERT INTO t VALUES (1)', ' update t set v = 1', 'DELETE FROM t', 'WITH x AS (UPDATE t SET v = 1 RETURNING id) SELECT * FROM x',
      'CREATE INDEX i ON t (v)', 'ANALYZE t', 'VACUUM t']) expect(writesWal(sql)).toBe(true);
    for (const sql of ['SELECT 1', '  select * from t', 'WITH x AS (SELECT 1) SELECT * FROM x', 'EXPLAIN SELECT 1', 'SHOW max_wal_size',
      'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s', 'SET search_path = public', 'CHECKPOINT']) expect(writesWal(sql)).toBe(false);
  });

  test('an autocommit write past the threshold checkpoints before the next statement; a read never does', async () => {
    const spy = install(engine, { threshold: 0 });
    await engine.executeRaw("INSERT INTO autocommit_probe VALUES (1, 'guarded')");
    expect(spy.checkpoints()).toBe(1);
    await engine.executeRaw('SELECT * FROM autocommit_probe');
    expect(spy.checkpoints()).toBe(1);
  });

  test('statements keep their issue order: a read issued after an unawaited write sees it', async () => {
    install(engine, { threshold: 0 });
    const write = engine.executeRaw("UPDATE autocommit_probe SET v = 'ordered' WHERE id = 1");
    const read = engine.executeRaw<{ v: string }>('SELECT v FROM autocommit_probe WHERE id = 1');
    await write;
    expect((await read)[0]?.v).toBe('ordered');
  });

  test('about 200 MB of autocommit WAL past a 64 MB max_wal_size completes instead of wedging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-autocommit-wal-'));
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'pglite-autocommit-wal-worker.ts'), dir], { stdout: 'pipe', stderr: 'pipe' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      clearTimeout(timer);
      expect(code).toBe(0);
      expect(stdout).toContain('done 200');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  test('engine-sql autocommit writes (the extraction watermark stamp) past a 64 MB max_wal_size complete instead of wedging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-engine-sql-wal-'));
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'pglite-engine-sql-wal-worker.ts'), dir], { stdout: 'pipe', stderr: 'pipe' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      clearTimeout(timer);
      expect(code).toBe(0);
      expect(stdout).toMatch(/done \d+/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});

describe('engine-sql writes take the guard (GBRA-69 stamp wedge)', () => {
  let engine: PGLiteEngine;
  const refs = [{ slug: 'notes/a', source_id: 'default' }, { slug: 'notes/b', source_id: 'default' }];
  type Sql = { engineSql: { transaction<T>(fn: (tx: { executeRaw(sql: string): Promise<unknown> }) => Promise<T>): Promise<T> } };
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (const { slug } of refs) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body' });
  });
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); resetGateway(); });

  test('an autocommit engine-sql write past the threshold checkpoints', async () => {
    const spy = install(engine, { threshold: 0 });
    expect(await engine.markPagesExtractedBatch(refs, new Date().toISOString())).toBe(2);
    expect(spy.checkpoints()).toBe(1);
  });

  test('an engine-sql executor transaction checkpoints before BEGIN', async () => {
    const spy = install(engine, { threshold: 0 });
    await (engine as unknown as Sql).engineSql.transaction(tx => tx.executeRaw("UPDATE pages SET links_extracted_at = now() WHERE slug = 'notes/a'"));
    expect(spy.checkpoints()).toBe(1);
  });

  test('inside engine.transaction() only the outermost probe checkpoints', async () => {
    const spy = install(engine, { threshold: 0 });
    await engine.transaction(tx => tx.markPagesExtractedBatch(refs, new Date().toISOString()));
    expect(spy.checkpoints()).toBe(1);
  });

  test('below the threshold an engine-sql write never checkpoints', async () => {
    const spy = install(engine, { threshold: Number.MAX_SAFE_INTEGER });
    await engine.markPagesExtractedBatch(refs, new Date().toISOString());
    expect(spy.checkpoints()).toBe(0);
  });
});
