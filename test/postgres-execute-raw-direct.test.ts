import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

/**
 * executeRawDirect routing decision (PR #1816 lock hot-path fix).
 *
 * The point of executeRawDirect is to send the Minion lock heartbeat
 * (claim/renewLock) to the DIRECT session-mode pool (port 5432) instead of the
 * transaction pooler (6543) that reaps connections mid-hold. That routing
 * branch only fires against a real Supabase dual-pool, which CI doesn't have —
 * so the decision itself (which connection gets the statement) went untested.
 *
 * This exercises the pure routing logic with a stubbed ConnectionManager and
 * fake Sql handles, covering all three shapes:
 *
 *   ┌─────────────────────────────┬──────────────┬───────────────┐
 *   │ engine shape                 │ dual-pool    │ conn chosen   │
 *   ├─────────────────────────────┼──────────────┼───────────────┤
 *   │ worker, not in tx           │ active        │ ddl() direct  │
 *   │ tx clone (_sql = tx conn)   │ active        │ this.sql (tx) │  ← atomicity
 *   │ worker, not in tx           │ inactive      │ this.sql read │
 *   └─────────────────────────────┴──────────────┴───────────────┘
 */

type FakeSql = { unsafe: (sql: string, params?: unknown[]) => Promise<unknown[]> };

/** A fake postgres.js handle whose unsafe() tags rows with its label. */
function fakeSql(label: string): FakeSql {
  return {
    unsafe: async () => [{ via: label }],
  };
}

/**
 * Build a PostgresEngine with its connection internals stubbed so
 * executeRawDirect can be driven without a live database.
 *
 * - readConn   → the read pool (what `this.sql` returns when _sql === readPool)
 * - directConn → what connectionManager.ddl() resolves to
 * - sqlOverride → forces the `get sql()` getter (used to model a tx clone whose
 *   `this.sql` is the tx connection, distinct from peekReadPool()).
 */
function makeEngine(opts: {
  dualPoolActive: boolean;
  readConn: FakeSql;
  directConn: FakeSql;
  // When set, models a tx clone: _sql is the tx conn (!== peekReadPool()).
  txConn?: FakeSql;
}): PostgresEngine {
  const engine = new PostgresEngine();
  const e = engine as unknown as Record<string, unknown>;

  // _sql: tx conn for a clone, otherwise the read pool itself (the worker case
  // where connect() does setReadPool(this._sql)).
  e._sql = opts.txConn ?? opts.readConn;

  // The `get sql()` getter on the prototype returns _sql when set, so we don't
  // need to override it — _sql already drives it. For a tx clone _sql is txConn,
  // so this.sql === txConn, exactly as Object.defineProperty does in transaction().

  e.connectionManager = {
    isDualPoolActive: () => opts.dualPoolActive,
    peekReadPool: () => opts.readConn,
    ddl: async () => opts.directConn,
  };

  return engine;
}

describe('PostgresEngine.executeRawDirect — routing decision (PR #1816)', () => {
  test('dual-pool active + not in tx → routes to direct (ddl) pool', async () => {
    const readConn = fakeSql('read');
    const directConn = fakeSql('direct');
    const engine = makeEngine({ dualPoolActive: true, readConn, directConn });

    const rows = await engine.executeRawDirect<{ via: string }>('UPDATE minion_jobs SET x=1');
    expect(rows[0].via).toBe('direct');
  });

  test('inside a transaction → honors the tx connection (never reroutes off it)', async () => {
    const readConn = fakeSql('read');
    const directConn = fakeSql('direct');
    const txConn = fakeSql('tx');
    // dual-pool is active, but _sql (tx) !== peekReadPool() (read) → inTransaction.
    const engine = makeEngine({ dualPoolActive: true, readConn, directConn, txConn });

    const rows = await engine.executeRawDirect<{ via: string }>('UPDATE minion_jobs SET x=1');
    expect(rows[0].via).toBe('tx');
  });

  test('dual-pool inactive → falls back to the read pool', async () => {
    const readConn = fakeSql('read');
    const directConn = fakeSql('direct');
    const engine = makeEngine({ dualPoolActive: false, readConn, directConn });

    const rows = await engine.executeRawDirect<{ via: string }>('UPDATE minion_jobs SET x=1');
    expect(rows[0].via).toBe('read');
  });

  test('already-aborted signal short-circuits with AbortError before routing the query', async () => {
    const readConn = fakeSql('read');
    const directConn = fakeSql('direct');
    const engine = makeEngine({ dualPoolActive: true, readConn, directConn });

    const ac = new AbortController();
    ac.abort();
    await expect(
      engine.executeRawDirect('UPDATE minion_jobs SET x=1', [], { signal: ac.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
