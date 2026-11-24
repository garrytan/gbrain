/**
 * The sync change-reason scan's purge-epoch read is answered once per screen call, as the raw statement it replaced was.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: through the dry-run screen's shared-read view (`preparationReads` with the screen's stable reads, which
 *    name the purge-epoch statement), every drift path's reason scan reads the source's purge epoch, and the view sends
 *    that statement to the engine once for the whole screen call.
 *  - Regression: the epoch read moved from caller raw SQL to the typed `readSourcePurgeEpoch`; the view memoised only
 *    `executeRaw`, so the typed read went to the engine once per drift path.
 *  - Why existing coverage misses it: the reason-scan tests run on the engine itself, never through the screen's view.
 *  - Seam: none; real PGLite in memory, a count of the statements the engine is sent.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { preparationReads } from '../src/core/persistence/group-publish.ts';
import { cachedSyncReasonScan, clearReasonScanCache } from '../src/core/reason-trailers.ts';
import { SOURCE_PURGE_EPOCH_SQL } from '../src/core/engine-sql/sync-reason-reads.ts';

let engine: PGLiteEngine;
let root: string;

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  root = mkdtempSync(join(process.env.TMPDIR ?? '/var/tmp', 'reason-scan-shared-'));
  await engine.executeRaw(`INSERT INTO sources(id, name, local_path, config) VALUES ('rs-shared', 'rs-shared', $1, '{}')`, [root]);
}, 120_000);
afterAll(async () => { await engine?.disconnect(); if (root) rmSync(root, { recursive: true, force: true }); });

test('a screen call reads the purge epoch once for all its drift paths', async () => {
  clearReasonScanCache();
  const sent: string[] = [];
  const raw = engine.executeRaw.bind(engine);
  engine.executeRaw = ((sql: string, params?: unknown[], opts?: unknown) => { sent.push(sql); return raw(sql, params, opts as never); }) as typeof engine.executeRaw;
  try {
    // The screen's view: sync-convergence.ts SCREEN_STABLE_READS names the purge-epoch statement.
    const view = preparationReads(engine, undefined, [SOURCE_PURGE_EPOCH_SQL]);
    for (const to of ['a1', 'b2', 'c3']) await cachedSyncReasonScan(view, { sourceId: 'rs-shared', sourceRoot: root, from: null, to });
  } finally { engine.executeRaw = raw; }
  expect(sent.filter(sql => sql === SOURCE_PURGE_EPOCH_SQL)).toHaveLength(1);
}, 120_000);
