/**
 * GBRA-75 wave 10: the managed import's batched reads answer exactly what the
 * single reads answer. Postgres arm: test/e2e/import-reads.test.ts.
 */
import { afterAll, beforeAll, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { findDuplicatePagesMatchesSingle, importGroupReadsCoalesce, importSnapshotsDropPurgedIncomingRows, importSnapshotsMatchSingleReads } from './helpers/import-reads-cases.ts';

let engine: BrainEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); });

test('batched import snapshots equal the includeDeleted single reads, deleted, missing and purged pages included', () => importSnapshotsMatchSingleReads(engine));
test('an incoming file drops page-subject and \'*\' purged rows through the batched snapshot as through the single read', () => importSnapshotsDropPurgedIncomingRows(engine));
test('findDuplicatePages answers each input as findDuplicatePage does', () => findDuplicatePagesMatchesSingle(engine));
test('an import group coalesces its members\' reads and falls back to single reads when a batch fails', () => importGroupReadsCoalesce(engine));
