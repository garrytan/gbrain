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
