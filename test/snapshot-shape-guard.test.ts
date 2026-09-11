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

const schemaInputs = [
  'migrate.ts', 'pglite-schema.ts', 'fts-language.ts', 'vector-index.ts', 'ai/defaults.ts',
  'timeline-dedup-repair.ts', 'pages-upsert-arbiter.ts', 'link-extraction.ts',
  'grants/schema.ts', 'grants/migration.ts', 'grants/model.ts', 'grants/service.ts', 'grants/profiles.ts',
  'scope.ts', 'sql-query.ts', 'minions/tools/brain-allowlist.ts', 'facts/withdrawal-schema.ts',
];

test('D5.13: the coverage-immune hash includes schema entry modules and imported migration dependencies', () => {
  // The D5.13 property (editing a migration HANDLER stales the snapshot) is
  // structural now: inline handlers and imported helpers are hashed as raw
  // file bytes — any edit changes it. The file-bytes form exists because the old
  // in-memory form folded Function.prototype.toString, which coverage
  // instrumentation rewrites: every `bun test --coverage` CI shard computed a
  // different hash than the plain-`bun run` builder and silently cold-initted.
  // Pin the recipe against an independent computation so a drift in either
  // side (recipe or file resolution) fails HERE, not as a silent slow path.
  const expected = crypto.createHash('sha256');
  expected.update('files:v3\n');
  for (const file of schemaInputs) {
    expected.update(`${file}\n`);
    // test-reads-source-ok: independent raw-byte hash contract, including imported SQL/handlers.
    expected.update(readFileSync(`src/core/${file}`));
    expected.update('\n--\n');
  }
  expect(computeSnapshotSchemaHash(crypto, fsModule)).toBe(expected.digest('hex'));
  // Determinism: two computations agree.
  expect(computeSnapshotSchemaHash(crypto, fsModule)).toBe(computeSnapshotSchemaHash(crypto, fsModule));
});

test.each(schemaInputs)('editing imported snapshot input %s invalidates the cached schema', (file) => {
  const original = currentHash();
  const changedFs = {
    ...fsModule,
    readFileSync: (path: Parameters<typeof fsModule.readFileSync>[0]) => {
      // test-reads-source-ok: emulate a changed source without mutating shared checkout files.
      const bytes = fsModule.readFileSync(path);
      return String(path).endsWith(`/src/core/${file}`)
        ? Buffer.concat([bytes, Buffer.from('\n// schema dependency changed\n')]) : bytes;
    },
  } as typeof fsModule;
  expect(computeSnapshotSchemaHash(crypto, changedFs)).not.toBe(original);
});

test('an unreadable imported schema dependency disables snapshot reuse', () => {
  const missingFs = {
    ...fsModule,
    readFileSync: (path: Parameters<typeof fsModule.readFileSync>[0]) => {
      if (String(path).endsWith('/grants/schema.ts')) throw new Error('ENOENT');
      // test-reads-source-ok: raw-byte hash failure-path regression.
      return fsModule.readFileSync(path);
    },
  } as typeof fsModule;
  expect(computeSnapshotSchemaHash(crypto, missingFs)).toBeNull();
});
