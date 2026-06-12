import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearSyncWatchFailure,
  readSyncWatchFailure,
  recordSyncWatchFailure,
  syncWatchFailurePath,
} from '../src/core/health-beacon.ts';
import { runSync } from '../src/commands/sync.ts';

let tempDir = '';
const originalConfigDir = process.env.MBRAIN_CONFIG_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mbrain-health-beacon-'));
  process.env.MBRAIN_CONFIG_DIR = join(tempDir, '.mbrain');
});

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.MBRAIN_CONFIG_DIR;
  } else {
    process.env.MBRAIN_CONFIG_DIR = originalConfigDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

test('records and reads a sync watch failure marker', () => {
  recordSyncWatchFailure({
    stopped_at: '2026-06-11T01:00:00.000Z',
    reason: 'connection refused',
    consecutive_failures: 5,
  });

  const failure = readSyncWatchFailure();
  expect(failure).toEqual({
    stopped_at: '2026-06-11T01:00:00.000Z',
    reason: 'connection refused',
    consecutive_failures: 5,
  });
});

test('returns null when no marker exists', () => {
  expect(readSyncWatchFailure()).toBeNull();
});

test('clearSyncWatchFailure removes the marker', () => {
  recordSyncWatchFailure({
    stopped_at: '2026-06-11T01:00:00.000Z',
    reason: 'boom',
    consecutive_failures: 5,
  });
  clearSyncWatchFailure();
  expect(readSyncWatchFailure()).toBeNull();
});

test('clearSyncWatchFailure is a no-op when no marker exists', () => {
  expect(() => clearSyncWatchFailure()).not.toThrow();
});

test('malformed or incomplete marker files read as null', () => {
  recordSyncWatchFailure({
    stopped_at: '2026-06-11T01:00:00.000Z',
    reason: 'boom',
    consecutive_failures: 5,
  });
  writeFileSync(syncWatchFailurePath(), 'not json');
  expect(readSyncWatchFailure()).toBeNull();

  writeFileSync(syncWatchFailurePath(), JSON.stringify({ reason: 'missing stopped_at' }));
  expect(readSyncWatchFailure()).toBeNull();
});

test('mbrain sync --clear-failure clears the marker without touching the engine (B-13)', async () => {
  recordSyncWatchFailure({
    stopped_at: '2026-06-11T01:00:00.000Z',
    reason: 'connection refused',
    consecutive_failures: 5,
  });

  const engine = new Proxy({}, {
    get() {
      throw new Error('--clear-failure must not perform a sync');
    },
  }) as never;

  await runSync(engine, ['--clear-failure']);
  expect(readSyncWatchFailure()).toBeNull();
});

test('mbrain sync --clear-failure is a safe no-op without a marker (B-13)', async () => {
  const engine = new Proxy({}, {
    get() {
      throw new Error('--clear-failure must not perform a sync');
    },
  }) as never;

  await runSync(engine, ['--clear-failure']);
  expect(readSyncWatchFailure()).toBeNull();
});

test('CLI dispatch: mbrain sync --clear-failure clears the marker without a database (B-13)', () => {
  recordSyncWatchFailure({
    stopped_at: '2026-06-11T01:00:00.000Z',
    reason: 'connection refused',
    consecutive_failures: 5,
  });

  const env: Record<string, string | undefined> = {
    ...process.env,
    MBRAIN_CONFIG_DIR: process.env.MBRAIN_CONFIG_DIR,
    MBRAIN_CONFIG_PATH: '',
  };
  delete env.DATABASE_URL;
  delete env.MBRAIN_DATABASE_URL;

  const result = Bun.spawnSync({
    cmd: ['bun', 'run', 'src/cli.ts', 'sync', '--clear-failure'],
    cwd: join(import.meta.dir, '..'),
    env,
    timeout: 20_000,
  });
  const stdout = new TextDecoder().decode(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(stdout).toContain('cleared');
  expect(readSyncWatchFailure()).toBeNull();
}, 30_000);

test('CLI dispatch: --clear-failure combined with --watch is rejected (B-13)', () => {
  recordSyncWatchFailure({
    stopped_at: '2026-06-11T01:00:00.000Z',
    reason: 'connection refused',
    consecutive_failures: 5,
  });

  const env: Record<string, string | undefined> = {
    ...process.env,
    MBRAIN_CONFIG_DIR: process.env.MBRAIN_CONFIG_DIR,
    MBRAIN_CONFIG_PATH: '',
  };
  delete env.DATABASE_URL;
  delete env.MBRAIN_DATABASE_URL;

  const result = Bun.spawnSync({
    cmd: ['bun', 'run', 'src/cli.ts', 'sync', '--clear-failure', '--watch'],
    cwd: join(import.meta.dir, '..'),
    env,
    timeout: 20_000,
  });

  expect(result.exitCode).not.toBe(0);
  expect(readSyncWatchFailure()).not.toBeNull();
}, 30_000);
