import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { queryAgentClientSpend } from '../src/commands/serve-http.ts';

/**
 * v0.38 Slice 4 — `/admin/api/agents/spend` endpoint SQL.
 *
 * The endpoint is a 5-line Express handler over `queryAgentClientSpend`;
 * the SQL is the load-bearing surface. Tested directly via the shared
 * helper so endpoint + test stay locked to the same query.
 *
 * Pinned behaviors:
 *   - Includes clients with scope='agent' OR bound_tools set
 *   - Excludes soft-deleted (deleted_at IS NOT NULL) clients
 *   - Excludes clients with neither scope=agent nor bindings
 *   - Sums today's mcp_spend_log entries (UTC-day-aligned)
 *   - Sums pending mcp_spend_reservations (status='pending', non-expired)
 *   - Counts active subagent jobs by __owner_client_id JSONB field
 *   - Returns ORDER BY client_name ASC (deterministic)
 *   - Null cap_usd_per_day surfaces as null (not 0)
 *   - Multi-word scope strings handled via string_to_array(scope, ' ')
 */

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '85');
});

async function seedClient(opts: {
  id: string;
  name?: string;
  scope?: string;
  bound_tools?: string[] | null;
  budget_usd_per_day?: number | null;
  deleted?: boolean;
}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method,
        bound_tools, bound_max_concurrent, budget_usd_per_day,
        created_at, deleted_at)
     VALUES ($1, $2, '', $3, ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post',
             $4, 1, $5, now(), $6)`,
    [
      opts.id,
      opts.name ?? opts.id,
      opts.scope ?? 'read',
      opts.bound_tools ?? null,
      opts.budget_usd_per_day ?? null,
      opts.deleted ? new Date() : null,
    ],
  );
}

describe('queryAgentClientSpend (v0.38 Slice 4 — /admin/api/agents/spend SQL)', () => {
  it('returns empty when no clients exist', async () => {
    const rows = await queryAgentClientSpend(engine);
    expect(rows).toEqual([]);
  });

  it('returns empty when no clients have scope=agent OR bindings', async () => {
    await seedClient({ id: 'plain-reader', scope: 'read' });
    await seedClient({ id: 'plain-writer', scope: 'read write' });
    const rows = await queryAgentClientSpend(engine);
    expect(rows).toEqual([]);
  });

  it('includes a client with scope=agent (even without bindings)', async () => {
    await seedClient({ id: 'agent-only', scope: 'read agent' });
    const rows = await queryAgentClientSpend(engine);
    expect(rows.length).toBe(1);
    expect(rows[0].client_id).toBe('agent-only');
  });

  it('includes a client with bound_tools set (even without scope=agent)', async () => {
    // Partial migration state: bindings copied over but scope not yet updated.
    // Spend viewer should still surface this client.
    await seedClient({ id: 'bound-no-scope', scope: 'admin', bound_tools: ['search'] });
    const rows = await queryAgentClientSpend(engine);
    expect(rows.length).toBe(1);
    expect(rows[0].client_id).toBe('bound-no-scope');
  });

  it('excludes soft-deleted clients (deleted_at NOT NULL)', async () => {
    await seedClient({ id: 'live', scope: 'read agent' });
    await seedClient({ id: 'revoked', scope: 'read agent', deleted: true });
    const rows = await queryAgentClientSpend(engine);
    expect(rows.length).toBe(1);
    expect(rows[0].client_id).toBe('live');
  });

  it('returns null cap_usd_per_day when budget unset (not 0)', async () => {
    await seedClient({ id: 'no-cap', scope: 'read agent' });
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].cap_usd_per_day).toBe(null);
  });

  it('returns numeric cap_usd_per_day when budget set', async () => {
    await seedClient({ id: 'cap-5', scope: 'read agent', budget_usd_per_day: 5.00 });
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].cap_usd_per_day).toBe(5);
  });

  it('returns 0 for spent_cents_today when no spend rows exist', async () => {
    await seedClient({ id: 'fresh', scope: 'read agent' });
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].spent_cents_today).toBe(0);
  });

  it('sums today\'s mcp_spend_log for the client (UTC-day-aligned)', async () => {
    await seedClient({ id: 'spent-some', scope: 'read agent' });
    // Today's spend: 25 + 75 = 100 cents
    await engine.executeRaw(
      `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, created_at)
       VALUES ('spent-some', 'subagent_loop', 25, now()),
              ('spent-some', 'subagent_loop', 75, now())`,
    );
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].spent_cents_today).toBe(100);
  });

  it('does NOT include yesterday\'s mcp_spend_log in today\'s total', async () => {
    await seedClient({ id: 'mixed-days', scope: 'read agent' });
    // Yesterday's spend (2 days ago to be safe across UTC midnight)
    await engine.executeRaw(
      `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, created_at)
       VALUES ('mixed-days', 'subagent_loop', 999, now() - interval '2 days')`,
    );
    // Today's spend
    await engine.executeRaw(
      `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, created_at)
       VALUES ('mixed-days', 'subagent_loop', 50, now())`,
    );
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].spent_cents_today).toBe(50);
  });

  it('isolates spend by client_id (no cross-client leakage)', async () => {
    await seedClient({ id: 'alice', scope: 'read agent' });
    await seedClient({ id: 'bob', scope: 'read agent' });
    await engine.executeRaw(
      `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, created_at)
       VALUES ('alice', 'subagent_loop', 200, now()),
              ('bob', 'subagent_loop', 50, now())`,
    );
    const rows = await queryAgentClientSpend(engine);
    const alice = rows.find(r => r.client_id === 'alice')!;
    const bob = rows.find(r => r.client_id === 'bob')!;
    expect(alice.spent_cents_today).toBe(200);
    expect(bob.spent_cents_today).toBe(50);
  });

  it('sums pending mcp_spend_reservations (status=pending, non-expired)', async () => {
    await seedClient({ id: 'in-flight', scope: 'read agent' });
    const future = new Date(Date.now() + 10 * 60 * 1000); // 10min out
    await engine.executeRaw(
      `INSERT INTO mcp_spend_reservations
         (reservation_id, client_id, estimated_cents, model, provider, status, expires_at)
       VALUES ('00000000-0000-0000-0000-000000000001', 'in-flight', 30, 'm', 'p', 'pending', $1),
              ('00000000-0000-0000-0000-000000000002', 'in-flight', 40, 'm', 'p', 'pending', $1)`,
      [future],
    );
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].pending_cents).toBe(70);
  });

  it('excludes expired pending reservations from pending_cents', async () => {
    await seedClient({ id: 'expired-pending', scope: 'read agent' });
    const past = new Date(Date.now() - 60 * 1000);
    const future = new Date(Date.now() + 60 * 1000);
    await engine.executeRaw(
      `INSERT INTO mcp_spend_reservations
         (reservation_id, client_id, estimated_cents, model, provider, status, expires_at)
       VALUES ('00000000-0000-0000-0000-000000000003', 'expired-pending', 99, 'm', 'p', 'pending', $1),
              ('00000000-0000-0000-0000-000000000004', 'expired-pending', 11, 'm', 'p', 'pending', $2)`,
      [past, future],
    );
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].pending_cents).toBe(11); // only the non-expired one
  });

  it('excludes settled reservations from pending_cents', async () => {
    await seedClient({ id: 'settled-only', scope: 'read agent' });
    const future = new Date(Date.now() + 60 * 1000);
    await engine.executeRaw(
      `INSERT INTO mcp_spend_reservations
         (reservation_id, client_id, estimated_cents, actual_cents, model, provider, status, settled_at, expires_at)
       VALUES ('00000000-0000-0000-0000-000000000005', 'settled-only', 100, 95, 'm', 'p', 'settled', now(), $1)`,
      [future],
    );
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].pending_cents).toBe(0);
  });

  it('counts active+waiting subagent jobs as inflight_count', async () => {
    await seedClient({ id: 'busy-client', scope: 'read agent' });
    // 1 active + 1 waiting + 1 waiting-children + 1 completed (excluded)
    for (const status of ['active', 'waiting', 'waiting-children', 'completed']) {
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
         VALUES ('subagent', $1, $2::jsonb, 'default', 0, now())`,
        [status, JSON.stringify({ prompt: 'x', __owner_client_id: 'busy-client' })],
      );
    }
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].inflight_count).toBe(3); // active + waiting + waiting-children
  });

  it('only counts subagent jobs (not shell/other minion jobs)', async () => {
    await seedClient({ id: 'shell-too', scope: 'read agent' });
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('shell', 'active', $1::jsonb, 'default', 0, now())`,
      [JSON.stringify({ cmd: 'echo', __owner_client_id: 'shell-too' })],
    );
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0].inflight_count).toBe(0); // shell jobs don't count
  });

  it('orders results by client_name ASC (deterministic for UI rendering)', async () => {
    await seedClient({ id: 'z-client', name: 'Zulu', scope: 'read agent' });
    await seedClient({ id: 'a-client', name: 'Alpha', scope: 'read agent' });
    await seedClient({ id: 'm-client', name: 'Mike', scope: 'read agent' });
    const rows = await queryAgentClientSpend(engine);
    expect(rows.map(r => r.client_name)).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('multi-word scope handled by string_to_array (agent + others)', async () => {
    // Real-world clients have scopes like 'read write agent' (space-separated).
    await seedClient({ id: 'multi-scope', scope: 'read write agent' });
    const rows = await queryAgentClientSpend(engine);
    expect(rows.length).toBe(1);
  });

  it('end-to-end happy path: all fields populated together', async () => {
    await seedClient({ id: 'full-data', scope: 'read agent', budget_usd_per_day: 10.50 });
    const future = new Date(Date.now() + 60_000);
    await engine.executeRaw(
      `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, created_at)
       VALUES ('full-data', 'subagent_loop', 250, now())`,
    );
    await engine.executeRaw(
      `INSERT INTO mcp_spend_reservations
         (reservation_id, client_id, estimated_cents, model, provider, status, expires_at)
       VALUES ('00000000-0000-0000-0000-000000000006', 'full-data', 50, 'm', 'p', 'pending', $1)`,
      [future],
    );
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
      [JSON.stringify({ prompt: 'x', __owner_client_id: 'full-data' })],
    );
    const rows = await queryAgentClientSpend(engine);
    expect(rows[0]).toEqual({
      client_id: 'full-data',
      client_name: 'full-data',
      cap_usd_per_day: 10.5,
      spent_cents_today: 250,
      pending_cents: 50,
      inflight_count: 1,
    });
  });
});
