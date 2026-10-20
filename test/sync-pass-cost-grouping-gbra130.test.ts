/**
 * GBRA-130 (#6712 PR 4b sweep, managed-sync-row-parity): a pass reserves its priced embedding spend per admitted group
 * (`reservePassCost`, one `sync-pass-cost` row per group). It priced the group's summed characters, and
 * `estimateCostFromChars` rounds tokens up once per call, so the same pages reserved a different total depending on how
 * they were grouped: lanes and --no-lanes reserved different totals for one corpus.
 *
 * Protects (red before: the grouped total is below the per-page total): the same corpus grouped two ways reserves the
 * same total, the sum of each page's own estimate. Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { estimateCostFromChars } from '../src/core/embedding-pricing.ts';
import { readReservedUsd, registerPassCost, reservePassCost, unregisterPassCost } from '../src/core/persistence/sync-pass-episode.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const PRICE = 0.13;
const SOURCE = `cost-grouping-${randomUUID().slice(0, 8)}`;
/** Lengths that are not multiples of 3.5, so each page's own token count rounds up. */
const corpus = [101, 202, 303, 404, 505, 606, 707, 808].map((n, i) => ({ path: `notes/n${i}.md`, level: `oid-${i}`, content: 'x'.repeat(n) }));

for (const backend of testBackends()) describe(`[${backend}] GBRA-130: pass cost reservations`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    if (backend === 'postgres') { const pg = new PostgresEngine(); await pg.connect({ database_url: requirePostgresTestDatabase() } as never); engine = pg; }
    else { const lite = new PGLiteEngine(); await lite.connect({}); engine = lite; }
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='sync-pass-cost' AND starts_with(fingerprint, $1)", [`${SOURCE}:`]);
    await engine.disconnect();
  });

  test('the same corpus grouped two ways reserves the same total: the sum of each page\'s own estimate', async () => {
    const incarnation = randomUUID();
    const reserve = async (groups: number[][]) => {
      const passId = randomUUID();
      registerPassCost(passId, { sourceId: SOURCE, incarnation, scope: passId, pricePerMTok: PRICE });
      try {
        for (const group of groups) await engine.transaction(tx => reservePassCost(tx, group.map(i => ({ passId, kind: 'managed_sync_import', ...corpus[i]!, processingOptions: { noEmbed: false } }))));
      } finally { unregisterPassCost(passId); }
      return readReservedUsd(engine, SOURCE, incarnation, passId);
    };
    const single = await reserve(corpus.map((_, i) => [i]));
    const grouped = await reserve([[0, 1, 2], [3, 4, 5, 6], [7]]);
    const perPage = corpus.reduce((sum, page) => sum + estimateCostFromChars(page.content.length, PRICE), 0);
    expect(single.rows).toBe(8);
    expect(grouped.rows).toBe(3);
    expect(single.usd).toBeCloseTo(perPage, 12);
    expect(grouped.usd).toBeCloseTo(single.usd, 12);
  });
});
