/**
 * W0 ship-review coverage (GAP-2) — the snapshot loader's shape + hash guards.
 *
 * The fixture is default-on for every `bun run test`, so a wrong snapshot
 * poisons the whole suite (the 1280-vs-1536 incident: 115 failures from one
 * root cause). These tests pin the three refusal paths and the
 * handler-aware hash (D5.13).
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as crypto from 'node:crypto';
import {
  tryLoadSnapshot,
  computeSnapshotSchemaHash,
  __snapshotMemoStatsForTests,
  __resetSnapshotMemoForTests,
} from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { getEmbeddingDimensions, getEmbeddingModel } from '../src/core/ai/gateway.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-snap-guard-'));
  __resetSnapshotMemoForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFixture(versionContent: string): string {
  const tarPath = join(dir, 'snap.tar');
  writeFileSync(tarPath, 'not-a-real-tar-but-existence-is-what-matters');
  writeFileSync(join(dir, 'snap.version'), versionContent);
  return tarPath;
}

const currentHash = () => computeSnapshotSchemaHash(MIGRATIONS, PGLITE_SCHEMA_SQL, crypto);

test('pre-W0 hash-only version file (no shape lines) is refused', () => {
  const tar = writeFixture(`${currentHash()}\n`);
  expect(tryLoadSnapshot(tar)).toBeNull();
});

test('dims mismatch is refused even with a matching hash', () => {
  const tar = writeFixture(`${currentHash()}\ndims=99999\nmodel=${getEmbeddingModel()}\n`);
  expect(tryLoadSnapshot(tar)).toBeNull();
});

test('model mismatch is refused even with a matching hash', () => {
  const tar = writeFixture(`${currentHash()}\ndims=${getEmbeddingDimensions()}\nmodel=other:model\n`);
  expect(tryLoadSnapshot(tar)).toBeNull();
});

test('stale schema hash is refused even with a matching shape', () => {
  const tar = writeFixture(`deadbeef\ndims=${getEmbeddingDimensions()}\nmodel=${getEmbeddingModel()}\n`);
  expect(tryLoadSnapshot(tar)).toBeNull();
});

test('matching hash + shape loads the blob', () => {
  const tar = writeFixture(`${currentHash()}\ndims=${getEmbeddingDimensions()}\nmodel=${getEmbeddingModel()}\n`);
  const blob = tryLoadSnapshot(tar);
  expect(blob).not.toBeNull();
  expect(blob!.size).toBeGreaterThan(0);
});

test('memo: same path is read once per process, blob identical across calls', () => {
  const tar = writeFixture(`${currentHash()}\ndims=${getEmbeddingDimensions()}\nmodel=${getEmbeddingModel()}\n`);
  const b1 = tryLoadSnapshot(tar);
  const afterFirst = __snapshotMemoStatsForTests().tarReads;
  const b2 = tryLoadSnapshot(tar);
  const afterSecond = __snapshotMemoStatsForTests().tarReads;
  expect(b1).not.toBeNull();
  expect(b2).toBe(b1); // same Blob instance — the tar was not re-read
  expect(afterFirst).toBe(1);
  expect(afterSecond).toBe(1);
});

test('memo: shape refusal is per-call, never cached as terminal — and costs zero tar reads', () => {
  // Hash matches but dims mismatch: the version entry is memoized yet every
  // call re-runs the shape gate against the CURRENT gateway config — an
  // engine with a matching config later in the same process could still
  // load this snapshot (the zembed/1280 poisoning guard staying hot behind
  // the memo). The 42MB tar read is deferred until a shape-MATCHING caller,
  // so a process that only ever refuses never reads it at all.
  const tar = writeFixture(`${currentHash()}\ndims=99999\nmodel=${getEmbeddingModel()}\n`);
  expect(tryLoadSnapshot(tar)).toBeNull();
  expect(__snapshotMemoStatsForTests().tarReads).toBe(0);
  expect(__snapshotMemoStatsForTests().memoEntries).toBe(1); // entry exists — not terminal
  expect(tryLoadSnapshot(tar)).toBeNull();
  expect(__snapshotMemoStatsForTests().tarReads).toBe(0);
});

test('memo: stale hash is terminal — tar never read, repeat calls short-circuit', () => {
  const tar = writeFixture(`deadbeef\ndims=${getEmbeddingDimensions()}\nmodel=${getEmbeddingModel()}\n`);
  expect(tryLoadSnapshot(tar)).toBeNull();
  expect(__snapshotMemoStatsForTests().tarReads).toBe(0);
  expect(tryLoadSnapshot(tar)).toBeNull();
  expect(__snapshotMemoStatsForTests().tarReads).toBe(0);
});

test('D5.13: a migration handler edit changes the hash (sql-only hashing missed 19 handler migrations)', () => {
  const base = [
    { version: 1, name: 'a', sql: 'CREATE TABLE t(x int)' },
    { version: 2, name: 'b', sql: '', handler: async () => 'original' },
  ];
  const edited = [
    { version: 1, name: 'a', sql: 'CREATE TABLE t(x int)' },
    { version: 2, name: 'b', sql: '', handler: async () => 'EDITED BODY' },
  ];
  const h1 = computeSnapshotSchemaHash(base, 'schema', crypto);
  const h2 = computeSnapshotSchemaHash(edited, 'schema', crypto);
  expect(h1).not.toBe(h2);
  // And identical handlers hash identically (determinism).
  const h3 = computeSnapshotSchemaHash(base, 'schema', crypto);
  expect(h1).toBe(h3);
});
