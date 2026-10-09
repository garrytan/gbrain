/**
 * GBRA-69: readPageSnapshotsBatch returns, for exact (slug, source) refs, the
 * snapshot readPageSnapshot returns for each (tags, revision, incarnation,
 * withdrawals and the withdrawal overlay), and covers the longest prefix of
 * refs whose bodies fit the byte budget. Postgres arm: test/e2e/page-snapshot-batch.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pageSnapshotBatchMatchesPerPageReads, pageSnapshotBatchRespectsByteBudget } from './helpers/page-snapshot-batch-cases.ts';

let engine: BrainEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine?.disconnect(); });

test('batched snapshots equal the per-page reads, missing and deleted refs included', () => pageSnapshotBatchMatchesPerPageReads(engine));
test('a batch covers the longest prefix that fits the byte budget, never less than one ref', () => pageSnapshotBatchRespectsByteBudget(engine));
