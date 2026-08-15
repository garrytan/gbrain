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
import { tryLoadSnapshot, computeSnapshotSchemaHash } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { getEmbeddingDimensions, getEmbeddingModel } from '../src/core/ai/gateway.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-snap-guard-'));
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
