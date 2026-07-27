/**
 * Real-Postgres proof for the OAuth/MCP spend reservation critical section.
 *
 * PGLite serializes one embedded connection and cannot prove the
 * pg_advisory_xact_lock behavior. This test deliberately issues competing
 * native reservation calls through a PostgresEngine pool and verifies that only
 * cap-fitting reservations commit.
 *
 * Run:
 *   DATABASE_URL=postgresql://... bun test test/e2e/mcp-budget-reservation-postgres.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { PostgresEngine } from 'gbrain';
import { BudgetExceededError, reserve } from '../../src/core/minions/budget-meter.ts';

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('MCP spend reservation — Postgres concurrency', () => {
  let engine: PostgresEngine;
  let clientId = '';

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: databaseUrl!, poolSize: 16 });
    await engine.initSchema();
  });

  afterEach(async () => {
    if (!clientId) return;
    await engine.executeRaw(
      `DELETE FROM mcp_spend_reservations WHERE client_id = $1`,
      [clientId],
    );
    await engine.executeRaw(
      `DELETE FROM mcp_spend_log WHERE client_id = $1`,
      [clientId],
    );
  });

  afterAll(async () => {
    await engine?.disconnect();
  });

  test('same-client competitors cannot reserve beyond the daily cap', async () => {
    clientId = `mcp-budget-e2e-${randomUUIDv7()}`;
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserve(engine, {
        clientId,
        estimatedCents: 10,
        capCents: 100,
        provider: 'test-provider',
        model: 'test-provider:test-model',
      })),
    );

    const fulfilled = attempts.filter(result => result.status === 'fulfilled');
    const rejected = attempts.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);
    }

    const rows = await engine.executeRaw<{ pending_cents: string }>(
      `SELECT COALESCE(SUM(estimated_cents), 0)::text AS pending_cents
         FROM mcp_spend_reservations
        WHERE client_id = $1 AND status = 'pending'`,
      [clientId],
    );
    expect(Number(rows[0]?.pending_cents)).toBe(100);
  });
});
