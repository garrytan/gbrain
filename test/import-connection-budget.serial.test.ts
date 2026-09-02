/**
 * PR #4619 — direct Postgres directory imports honor GBRAIN_MAX_CONNECTIONS.
 *
 * sync.ts has clamped its worker fan-out under the shared opt-in connection
 * budget since v0.46.1.0 (clampWorkersForConnectionBudget), but a parallel
 * `gbrain import --workers N` still fanned out N child PostgresEngine pools
 * unclamped — on a constrained pooler (Supabase port 6543) that saturates the
 * session budget the operator explicitly configured. This suite pins the
 * import-side clamp: requested fan-out clamps against the configured parent
 * pool plus the actual two-connection child pools, a budget with no child
 * capacity reuses the already-connected parent engine serially, an unset
 * budget preserves legacy fan-out, and PGLite bypasses the Postgres clamp.
 *
 * Serial (`.serial.test.ts`): owns process-level pool env vars and a
 * top-level mock.module for the child-engine connections.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';

let workerConnects = 0;
let workerPoolSizes: number[] = [];

mock.module('../src/core/postgres-engine.ts', () => ({
  PostgresEngine: class {
    readonly kind = 'postgres';
    async connect(opts?: { poolSize?: number }): Promise<void> {
      workerConnects += 1;
      workerPoolSizes.push(opts?.poolSize ?? -1);
    }
    async disconnect(): Promise<void> {}
  },
}));

let runImport: typeof import('../src/commands/import.ts').runImport;
let root: string;
let importDir: string;
let previousGbrainHome: string | undefined;
let previousMaxConnections: string | undefined;
let previousPoolSize: string | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-import-budget-'));
  importDir = join(root, 'empty-import');
  mkdirSync(importDir);
  mkdirSync(join(root, '.gbrain'));
  writeFileSync(
    join(root, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'postgres', database_url: 'postgresql://example.invalid/gbrain' }),
  );
  previousGbrainHome = process.env.GBRAIN_HOME;
  previousMaxConnections = process.env.GBRAIN_MAX_CONNECTIONS;
  previousPoolSize = process.env.GBRAIN_POOL_SIZE;
  process.env.GBRAIN_HOME = root;
  process.env.GBRAIN_MAX_CONNECTIONS = '10';
  delete process.env.GBRAIN_POOL_SIZE;
  ({ runImport } = await import('../src/commands/import.ts'));
});

afterAll(() => {
  if (previousGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = previousGbrainHome;
  if (previousMaxConnections === undefined) delete process.env.GBRAIN_MAX_CONNECTIONS;
  else process.env.GBRAIN_MAX_CONNECTIONS = previousMaxConnections;
  if (previousPoolSize === undefined) delete process.env.GBRAIN_POOL_SIZE;
  else process.env.GBRAIN_POOL_SIZE = previousPoolSize;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  workerConnects = 0;
  workerPoolSizes = [];
  delete process.env.GBRAIN_POOL_SIZE;
});

function fakeEngine(kind: 'postgres' | 'pglite'): BrainEngine {
  return {
    kind,
    executeRaw: async () => [],
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

test('import clamps child pools to the configured session budget', async () => {
  process.env.GBRAIN_MAX_CONNECTIONS = '15';
  const engine = fakeEngine('postgres');

  const errors: string[] = [];
  const errorSpy = spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.map(String).join(' '));
  });
  try {
    await runImport(engine, ['--no-embed', '--workers', '12', importDir]);
  } finally {
    errorSpy.mockRestore();
  }

  // Default parent pool 10 plus 2 workers x 2 connections = 14 <= 15.
  expect(workerConnects).toBe(2);
  expect(workerPoolSizes).toEqual([2, 2]);
  expect(errors.some(line => line.includes('clamped workers 12 -> 2'))).toBe(true);
  expect(errors.some(line => line.includes('parent 10 + 2x2 per-worker'))).toBe(true);
});

test('import falls back to the parent engine when the connection budget cannot fit a worker', async () => {
  process.env.GBRAIN_MAX_CONNECTIONS = '10';
  const engine = fakeEngine('postgres');

  const errors: string[] = [];
  const errorSpy = spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.map(String).join(' '));
  });
  try {
    await runImport(engine, ['--no-embed', '--workers', '12', importDir]);
  } finally {
    errorSpy.mockRestore();
  }

  expect(workerConnects).toBe(0);
  expect(workerPoolSizes).toEqual([]);
  expect(errors.some(line => line.includes('clamped workers 12 -> 1'))).toBe(true);
  expect(errors.some(line => line.includes('serial parent engine; parent pool 10'))).toBe(true);
});

test('import preserves requested workers when the configured budget already fits', async () => {
  process.env.GBRAIN_MAX_CONNECTIONS = '40';
  const engine = fakeEngine('postgres');

  await runImport(engine, ['--no-embed', '--workers', '3', importDir]);

  expect(workerConnects).toBe(3);
  expect(workerPoolSizes).toEqual([2, 2, 2]);
});

test('import budgets against the configured parent and actual worker pool sizes', async () => {
  process.env.GBRAIN_MAX_CONNECTIONS = '5';
  process.env.GBRAIN_POOL_SIZE = '1';
  const engine = fakeEngine('postgres');

  await runImport(engine, ['--no-embed', '--workers', '12', importDir]);

  // GBRAIN_POOL_SIZE lowers the parent pool to 1. The explicit child default
  // stays 2, so parent 1 plus 2 workers x 2 connections consumes budget 5.
  expect(workerConnects).toBe(2);
  expect(workerPoolSizes).toEqual([2, 2]);
});

test('import preserves legacy fan-out when the connection budget is unset', async () => {
  delete process.env.GBRAIN_MAX_CONNECTIONS;
  const engine = fakeEngine('postgres');

  await runImport(engine, ['--no-embed', '--workers', '3', importDir]);

  expect(workerConnects).toBe(3);
  expect(workerPoolSizes).toEqual([2, 2, 2]);
});

// Ship-review gap (#4619): resolveMaxConnections treats anything that is not
// a positive integer as UNSET — the clamp is strictly opt-in, so a typo'd or
// zeroed budget must preserve the legacy fan-out and print no clamp line
// (a "clamped workers" line with a bogus budget would tell the operator a
// clamp happened that never did).
for (const [label, raw] of [
  ['non-numeric', 'abc'],
  ['zero', '0'],
  ['negative', '-5'],
  ['fractional', '2.5'],
  ['empty string', ''],
] as const) {
  test(`GBRAIN_MAX_CONNECTIONS=${JSON.stringify(raw)} (${label}) preserves legacy fan-out with no clamp line`, async () => {
    process.env.GBRAIN_MAX_CONNECTIONS = raw;
    const engine = fakeEngine('postgres');

    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      await runImport(engine, ['--no-embed', '--workers', '3', importDir]);
    } finally {
      errorSpy.mockRestore();
    }

    expect(workerConnects).toBe(3);
    expect(workerPoolSizes).toEqual([2, 2, 2]);
    expect(errors.some(line => line.includes('clamped workers'))).toBe(false);
    expect(errors.some(line => line.includes('GBRAIN_MAX_CONNECTIONS'))).toBe(false);
  });
}

test('PGLite bypasses the Postgres connection budget clamp', async () => {
  process.env.GBRAIN_MAX_CONNECTIONS = '1';
  const engine = fakeEngine('pglite');
  const logs: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(args.map(String).join(' '));
  });

  try {
    await runImport(engine, ['--no-embed', '--workers', '3', importDir]);
  } finally {
    logSpy.mockRestore();
  }

  expect(workerConnects).toBe(0);
  expect(logs.some(line => line.includes('Using 3 parallel workers'))).toBe(true);
});
