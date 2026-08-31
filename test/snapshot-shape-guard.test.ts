/**
 * W0 ship-review coverage (GAP-2) — the snapshot loader's shape + hash guards.
 *
 * The fixture is default-on for every `bun run test`, so a wrong snapshot
 * poisons the whole suite (the 1280-vs-1536 incident: 115 failures from one
 * root cause). These tests pin the three refusal paths and the
 * handler-aware hash (D5.13).
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as crypto from 'node:crypto';
import * as fsModule from 'node:fs';
import {
  tryLoadSnapshot,
  computeSnapshotSchemaHash,
  __snapshotMemoStatsForTests,
  __resetSnapshotMemoForTests,
} from '../src/core/pglite-engine.ts';
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

const currentHash = () => computeSnapshotSchemaHash(crypto, fsModule)!;

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

test('D5.13 (file-bytes form): the hash is the exact recipe over migrate.ts + pglite-schema.ts bytes', () => {
  // The D5.13 property (editing a migration HANDLER stales the snapshot) is
  // structural now: handlers live in migrate.ts, and the hash is the raw file
  // bytes — any edit changes it. The file-bytes form exists because the old
  // in-memory form folded Function.prototype.toString, which coverage
  // instrumentation rewrites: every `bun test --coverage` CI shard computed a
  // different hash than the plain-`bun run` builder and silently cold-initted.
  // Pin the recipe against an independent computation so a drift in either
  // side (recipe or file resolution) fails HERE, not as a silent slow path.
  const expected = crypto.createHash('sha256');
  expected.update('files:v2\n');
  // test-reads-source-ok: the hash under test is DEFINED over these files'
  // raw bytes (coverage-immune by design) — an independent byte read is the
  // only way to pin the recipe without reusing the implementation.
  expected.update(readFileSync('src/core/migrate.ts'));
  expected.update('\n--\n');
  // test-reads-source-ok: same recipe pin — the hash is defined over these bytes.
  expected.update(readFileSync('src/core/pglite-schema.ts'));
  expect(computeSnapshotSchemaHash(crypto, fsModule)).toBe(expected.digest('hex'));
  // Determinism: two computations agree.
  expect(computeSnapshotSchemaHash(crypto, fsModule)).toBe(computeSnapshotSchemaHash(crypto, fsModule));
});
