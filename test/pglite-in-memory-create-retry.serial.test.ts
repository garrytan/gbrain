import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PGliteOptions } from '@electric-sql/pglite';
import type { EngineConfig } from '../src/core/types.ts';

const WASM_TRAP = "access to a null reference (evaluating 'getWasmTableEntry(e)(t, r, a)')";
const SNAPSHOT = resolve(import.meta.dir, 'fixtures/pglite-snapshot.tar');
const IN_MEMORY: EngineConfig = { engine: 'pglite' };
const realPglite = await import('@electric-sql/pglite');
const RealPGlite = realPglite.PGlite;
type Database = InstanceType<typeof RealPGlite>;

let failures: unknown[] = [];
let calls: (PGliteOptions | undefined)[] = [];
let beforeCreate: ((attempt: number) => Promise<void>) | undefined;
let failTimezone = false;
let failClose = false;
const opened: { db: Database; close: () => Promise<void>; closes: number }[] = [];

class FlakyPGlite extends RealPGlite {
  static async create(...args: Parameters<typeof RealPGlite.create>) {
    const attempt = calls.push(typeof args[0] === 'string' ? args[1] : args[0]);
    await beforeCreate?.(attempt);
    if (failures.length > 0) throw failures.shift();
    const db = await RealPGlite.create(...args);
    const record = { db, close: db.close.bind(db), closes: 0 };
    opened.push(record);
    const query = db.query.bind(db);
    db.query = ((...args: Parameters<typeof db.query>) => {
      if (failTimezone && args[0].includes("set_config('TimeZone'")) {
        return Promise.reject(new Error('injected timezone setup failure'));
      }
      return query(...args);
    }) as typeof db.query;
    db.close = async () => {
      record.closes++;
      if (failClose) throw new Error('injected close failure');
      await record.close();
    };
    return db;
  }
}

mock.module('@electric-sql/pglite', () => ({ ...realPglite, PGlite: FlakyPGlite }));
const { PGLiteEngine, classifyPgliteInitError } = await import('../src/core/pglite-engine.ts');
const { PgliteClosingError } = await import('../src/core/pglite-lifecycle.ts');

const engines: InstanceType<typeof PGLiteEngine>[] = [];
const roots: string[] = [];
const warnings: string[] = [];
let previousSnapshot: string | undefined;
let previousWarn: typeof console.warn;
let previousExitCode: typeof process.exitCode;

function engine() {
  const result = new PGLiteEngine();
  engines.push(result);
  return result;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeAll(() => {
  const result = Bun.spawnSync(['bun', 'run', 'build:pglite-snapshot'], {
    cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe',
    timeout: 300_000, killSignal: 'SIGKILL',
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}, 320_000);

beforeEach(() => {
  failures = [];
  calls = [];
  beforeCreate = undefined;
  failTimezone = false;
  failClose = false;
  warnings.length = 0;
  previousSnapshot = process.env.GBRAIN_PGLITE_SNAPSHOT;
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;
  previousExitCode = process.exitCode;
  process.exitCode = 0;
  previousWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
});

afterEach(async () => {
  failTimezone = false;
  failClose = false;
  try {
    for (const db of engines.splice(0)) {
      try { await db.disconnect(); } catch (error) {
        if (!(error instanceof PgliteClosingError)) throw error;
      }
    }
    for (const record of opened.splice(0)) {
      if (!record.db.closed) await record.close();
    }
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    if (previousSnapshot === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT;
    else process.env.GBRAIN_PGLITE_SNAPSHOT = previousSnapshot;
    console.warn = previousWarn;
    process.exitCode = previousExitCode ?? 0;
  }
});

describe('in-memory PGLite create retry', () => {
  test('the observed create trap classifies as unknown', () => {
    expect(classifyPgliteInitError(WASM_TRAP)).toBe('unknown');
  });

  for (const snapshot of [false, true]) {
    test(`a single create trap recovers cold with snapshot=${snapshot}`, async () => {
      if (snapshot) process.env.GBRAIN_PGLITE_SNAPSHOT = SNAPSHOT;
      failures = [new Error(WASM_TRAP)];
      const db = engine();
      await db.connect(IN_MEMORY);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.loadDataDir instanceof Blob).toBe(snapshot);
      expect(calls[1]?.loadDataDir).toBeUndefined();
      expect(calls[1]?.dataDir).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('retried cold');
      expect(warnings[0]).toContain(WASM_TRAP);
      const before = await db.db.query<{ pages: string | null }>("SELECT to_regclass('public.pages')::text AS pages");
      expect(before.rows[0].pages).toBeNull();
      await db.initSchema();
      await db.putPage('retry-example', { title: 'Retry example', compiled_truth: 'Recovered content', type: 'note' });
      expect((await db.getPage('retry-example', { sourceId: 'default' }))?.compiled_truth).toBe('Recovered content');
      await db.disconnect();
      expect(opened).toHaveLength(1);
      expect(opened[0].db.closed).toBe(true);
      expect(opened[0].closes).toBe(1);
    }, 120_000);

    test(`a healthy create is never retried with snapshot=${snapshot}`, async () => {
      if (snapshot) process.env.GBRAIN_PGLITE_SNAPSHOT = SNAPSHOT;
      const db = engine();
      await db.connect(IN_MEMORY);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.loadDataDir instanceof Blob).toBe(snapshot);
      expect(warnings).toHaveLength(0);
      if (snapshot) {
        const rows = await db.db.query<{ pages: string | null }>("SELECT to_regclass('public.pages')::text AS pages");
        expect(rows.rows[0].pages).toBe('pages');
      }
    }, 120_000);
  }

  test('two create failures retain both causes, stop at two attempts, and allow a fresh connect', async () => {
    failures = [new Error(WASM_TRAP), { name: 'ErrnoError', errno: 20 }];
    const db = engine();
    const error = await db.connect(IN_MEMORY).then(() => null, error => error as Error);
    expect(error?.message).toContain('PGLite failed to initialize its WASM runtime.');
    expect(error?.message).toContain(`Original error: ${WASM_TRAP}`);
    expect(error?.message).toContain('Cold retry error: ErrnoError (errno 20)');
    expect(calls).toHaveLength(2);
    expect(warnings).toHaveLength(0);
    expect(() => db.db).toThrow('PGLite not connected');
    await db.connect(IN_MEMORY);
    expect(calls).toHaveLength(3);
    expect(opened).toHaveLength(1);
  }, 120_000);

  test('an empty directory and non-Error rejection use the same bounded retry', async () => {
    failures = [WASM_TRAP];
    await engine().connect({ engine: 'pglite', database_path: '' });
    expect(calls).toHaveLength(2);
    expect(warnings[0]).toContain(WASM_TRAP);
  }, 120_000);

  for (const closeFails of [false, true]) {
    test(`timezone setup failure never retries an open database with closeFails=${closeFails}`, async () => {
      process.env.GBRAIN_PGLITE_SNAPSHOT = SNAPSHOT;
      failTimezone = true;
      failClose = closeFails;
      const db = engine();
      await expect(db.connect(IN_MEMORY)).rejects.toThrow(closeFails ? 'initialization cleanup failed' : 'injected timezone setup failure');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.loadDataDir).toBeInstanceOf(Blob);
      expect(opened).toHaveLength(1);
      expect(opened[0].closes).toBe(1);
      expect(opened[0].db.closed).toBe(!closeFails);
      expect(warnings.filter(message => message.includes('retried cold'))).toHaveLength(0);
      if (closeFails) {
        await expect(db.connect(IN_MEMORY)).rejects.toBeInstanceOf(PgliteClosingError);
        await expect(db.disconnect()).rejects.toBeInstanceOf(PgliteClosingError);
        expect(calls).toHaveLength(1);
      }
    }, 120_000);
  }

  test('an unknown persistent create failure never receives the in-memory retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-retry-persistent-'));
    roots.push(root);
    failures = [new Error(WASM_TRAP)];
    const db = engine();
    const config: EngineConfig = { engine: 'pglite', database_path: join(root, 'store') };
    await expect(db.connect(config)).rejects.toThrow(WASM_TRAP);
    expect(calls).toHaveLength(1);
    expect(warnings).toHaveLength(0);
    await db.connect(config);
    expect(calls).toHaveLength(2);
    expect(db.walRepairReceipt).toBeNull();
  }, 120_000);

  for (const retryFails of [false, true]) {
    test(`concurrent connects share one recovery and shutdown waits with retryFails=${retryFails}`, async () => {
      const entered = deferred(), release = deferred();
      beforeCreate = async attempt => {
        if (attempt === 2) { entered.resolve(); await release.promise; }
      };
      failures = retryFails ? [new Error(WASM_TRAP), new Error('retry rejected')] : [new Error(WASM_TRAP)];
      const db = engine();
      const first = db.connect(IN_MEMORY);
      const firstResult = first.then(() => null, error => error);
      let shutdown: Promise<void> | undefined;
      try {
        await Promise.race([entered.promise, first]);
        const second = db.connect(IN_MEMORY);
        const secondResult = second.then(() => null, error => error);
        let closed = false;
        shutdown = db.disconnect().then(() => { closed = true; });
        await Promise.resolve();
        expect(closed).toBe(false);
        await expect(db.connect(IN_MEMORY)).rejects.toBeInstanceOf(PgliteClosingError);
        expect(calls).toHaveLength(2);
        release.resolve();
        const [firstError, secondError] = await Promise.all([firstResult, secondResult]);
        expect(secondError).toBe(firstError);
        if (retryFails) expect(firstError?.message).toContain('retry rejected');
        else expect(firstError).toBeNull();
        await shutdown;
        expect(closed).toBe(true);
        expect(calls).toHaveLength(2);
        expect(() => db.db).toThrow('PGLite not connected');
        expect(opened).toHaveLength(retryFails ? 0 : 1);
        if (!retryFails) {
          expect(opened[0].db.closed).toBe(true);
          expect(opened[0].closes).toBe(1);
        }
      } finally {
        release.resolve();
        await firstResult;
        await shutdown;
      }
    }, 120_000);
  }

  for (const retryFails of [false, true]) {
    test(`both create attempts preserve the incoming process exit code with retryFails=${retryFails}`, async () => {
      process.exitCode = 7;
      beforeCreate = async () => { process.exitCode = 99; };
      failures = retryFails ? [new Error(WASM_TRAP), new Error('retry rejected')] : [new Error(WASM_TRAP)];
      const result = await engine().connect(IN_MEMORY).then(() => null, error => error);
      expect(Boolean(result)).toBe(retryFails);
      expect(calls).toHaveLength(2);
      expect(process.exitCode).toBe(7);
    }, 120_000);
  }
});
