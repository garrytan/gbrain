/**
 * C2 (test-gap wave 1) — minion spend attribution is WIRED, not dead code.
 * Pre-fix, recordMinionJobSpend/getJobClientId (src/core/minion-spend.ts) had
 * zero callers: the per-client daily spend cap enforced against an
 * mcp_spend_log table that generic handlers never wrote — the cap was off.
 * Post-fix, embed-backfill settles tracker spend into mcp_spend_log on every
 * exit path, attributed to job.data.client_id (NULL for local submissions).
 *
 * The injected runStale records PRICED usage on the ambient BudgetTracker via
 * getCurrentBudgetTracker() — the same ALS seam the real gateway uses — so
 * the test exercises the production settle path, not a shortcut.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { makeEmbedBackfillHandler } from '../../src/core/minions/handlers/embed-backfill.ts';
import { getCurrentBudgetTracker } from '../../src/core/ai/gateway.ts';
import { getJobClientId } from '../../src/core/minion-spend.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM mcp_spend_log');
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id LIKE 'gbrain-embed-backfill:%'`);
});

function fakeJob(data: Record<string, unknown>): MinionJobContext {
  const controller = new AbortController();
  return {
    id: 1,
    name: 'embed-backfill',
    data,
    attempts_made: 0,
    signal: controller.signal,
    deadlineAtMs: null,
    shutdownSignal: controller.signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  } as unknown as MinionJobContext;
}

/** Simulated drain: settles $0.13 of priced embedding usage on the ambient tracker. */
const spendingRunStale = (async () => {
  const tracker = getCurrentBudgetTracker();
  if (!tracker) throw new Error('test seam: no ambient BudgetTracker — ALS wiring broken');
  tracker.record({ modelId: 'openai:text-embedding-3-large', inputTokens: 1_000_000, kind: 'embed', label: 'test-drain' });
  return { embedded: 5, chunksProcessed: 5, pagesProcessed: 5, invalidated: 0, aborted: false };
}) as never;

async function spendRows(): Promise<Array<{ client_id: string | null; operation: string; spend_cents: number }>> {
  return engine.executeRaw(
    `SELECT client_id, operation, spend_cents FROM mcp_spend_log ORDER BY id`,
  ) as never;
}

describe('embed-backfill spend attribution', () => {
  test('MCP-submitted job (data.client_id) → mcp_spend_log row attributed to that client', async () => {
    const handler = makeEmbedBackfillHandler(engine, { runStale: spendingRunStale });
    const result = await handler(fakeJob({ sourceId: 'default', client_id: 'client-abc' }));
    expect(result.status).toBe('success');
    expect(result.spentUsd).toBeCloseTo(0.13, 5);
    const rows = await spendRows();
    expect(rows.length).toBe(1);
    expect(rows[0].client_id).toBe('client-abc');
    expect(rows[0].operation).toBe('embed-backfill');
    expect(Number(rows[0].spend_cents)).toBe(13);
  });

  test('local job (no client_id) → row lands with NULL attribution, never dropped', async () => {
    const handler = makeEmbedBackfillHandler(engine, { runStale: spendingRunStale });
    await handler(fakeJob({ sourceId: 'default' }));
    const rows = await spendRows();
    expect(rows.length).toBe(1);
    expect(rows[0].client_id).toBeNull();
  });

  test('zero-spend run writes no ledger row (no noise for keyless drains)', async () => {
    const handler = makeEmbedBackfillHandler(engine); // real drain, zero stale chunks
    const result = await handler(fakeJob({ sourceId: 'default', client_id: 'client-abc' }));
    expect(result.status).toBe('success');
    expect((await spendRows()).length).toBe(0);
  });

  test('spend settles even when the drain THROWS after spending (every exit path)', async () => {
    const throwingRunStale = (async () => {
      const tracker = getCurrentBudgetTracker()!;
      tracker.record({ modelId: 'openai:text-embedding-3-large', inputTokens: 1_000_000, kind: 'embed', label: 'test-drain' });
      throw new Error('drain exploded mid-run');
    }) as never;
    const handler = makeEmbedBackfillHandler(engine, { runStale: throwingRunStale });
    await expect(handler(fakeJob({ sourceId: 'default', client_id: 'client-abc' }))).rejects.toThrow('drain exploded');
    const rows = await spendRows();
    expect(rows.length).toBe(1);
    expect(rows[0].client_id).toBe('client-abc');
  });
});

describe('getJobClientId unit cases', () => {
  test('junk shapes never attribute', () => {
    expect(getJobClientId({ id: 1 })).toBeUndefined();
    expect(getJobClientId({ id: 1, data: null })).toBeUndefined();
    expect(getJobClientId({ id: 1, data: 'string' })).toBeUndefined();
    expect(getJobClientId({ id: 1, data: { client_id: 42 } })).toBeUndefined();
    expect(getJobClientId({ id: 1, data: { client_id: '' } })).toBeUndefined();
    expect(getJobClientId({ id: 1, data: { client_id: 'ok' } })).toBe('ok');
  });
});
