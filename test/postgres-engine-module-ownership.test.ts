// Regression for the shared-singleton ownership bug.
//
// Pre-fix repro (cycle on direct Postgres):
//   1. Cycle's main engine connects without poolSize → module path,
//      initializes the db.ts singleton, _ownsModuleSingleton=true.
//   2. Lint phase (`resolveLintContentSanity`) creates a temp engine to
//      read 4 config keys, calls engine.connect({}) → module path again.
//      db.connect() no-ops (sql is alive). Temp engine sets
//      _connectionStyle='module' but DID NOT initialize the singleton.
//   3. Temp engine's `finally { disconnect() }` falls through and calls
//      db.disconnect() — nulling the singleton for the cycle.
//   4. Sync/synthesize/embed phases that run AFTER lint flunk with
//      "No database connection: connect() has not been called."
//
// Fix: track `_ownsModuleSingleton` per engine instance; only the
// initializer is allowed to tear it down. Joiners no-op on disconnect.
//
// Hermetic: stubs the postgres driver via mocking `db.ts` exports —
// no real DB required.

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import * as db from '../src/core/db.ts';

describe('PostgresEngine module-singleton ownership (joiner does not tear down shared pool)', () => {
  let dbConnectCalls = 0;
  let dbDisconnectCalls = 0;
  let singletonAlive = false;

  beforeEach(() => {
    dbConnectCalls = 0;
    dbDisconnectCalls = 0;
    singletonAlive = false;

    mock.module('../src/core/db.ts', () => ({
      ...db,
      connect: async () => {
        dbConnectCalls++;
        singletonAlive = true; // first call wins; subsequent are no-ops
      },
      disconnect: async () => {
        dbDisconnectCalls++;
        singletonAlive = false;
      },
      isConnected: () => singletonAlive,
      getConnection: () => {
        if (!singletonAlive) {
          throw new Error('No database connection: connect() has not been called');
        }
        // Real getConnection returns a postgres tag-template; our tests
        // never call SQL through it, so a stub is sufficient.
        return (() => { throw new Error('SQL not used in this test'); }) as unknown as ReturnType<typeof postgres>;
      },
    }));
  });

  test('first engine initializes; second engine joins and does NOT disconnect on cleanup', async () => {
    const config = { database_url: 'postgres://test/test' };

    const primary = new PostgresEngine();
    await primary.connect(config);
    expect(dbConnectCalls).toBe(1);
    expect(singletonAlive).toBe(true);

    // Lint-content-sanity pattern: temp engine joins the shared pool.
    const joiner = new PostgresEngine();
    await joiner.connect(config);
    expect(dbConnectCalls).toBe(2); // call fired but no-op'd
    expect(singletonAlive).toBe(true); // still alive

    // Temp engine cleans up — must NOT clobber the shared pool.
    await joiner.disconnect();
    expect(dbDisconnectCalls).toBe(0); // joiner did not call db.disconnect
    expect(singletonAlive).toBe(true); // singleton still alive for primary

    // Primary engine owns teardown — disconnect actually fires.
    await primary.disconnect();
    expect(dbDisconnectCalls).toBe(1);
    expect(singletonAlive).toBe(false);
  });

  test('joiner.disconnect() called BEFORE primary.disconnect() leaves singleton usable', async () => {
    // This is the exact lint-phase repro: primary runs the cycle, lint
    // spawns a joiner mid-cycle, lint's finally disconnects joiner,
    // cycle's NEXT phase still expects the singleton.
    const config = { database_url: 'postgres://test/test' };

    const primary = new PostgresEngine();
    await primary.connect(config);

    const joiner = new PostgresEngine();
    await joiner.connect(config);
    await joiner.disconnect(); // pre-fix: this nulled the singleton

    // Pre-fix: this throw fired here. Post-fix: singleton is still alive.
    expect(() => db.isConnected() && true).not.toThrow();
    expect(singletonAlive).toBe(true);
  });

  test('joiner.disconnect() is idempotent (second call is a no-op)', async () => {
    const config = { database_url: 'postgres://test/test' };

    const primary = new PostgresEngine();
    await primary.connect(config);

    const joiner = new PostgresEngine();
    await joiner.connect(config);
    await joiner.disconnect();
    await joiner.disconnect(); // second call — must not throw, must not clobber

    expect(dbDisconnectCalls).toBe(0);
    expect(singletonAlive).toBe(true);
  });

  test('solo engine (no other engines) initializes and tears down correctly', async () => {
    const config = { database_url: 'postgres://test/test' };

    const solo = new PostgresEngine();
    await solo.connect(config);
    expect(dbConnectCalls).toBe(1);
    expect(singletonAlive).toBe(true);

    await solo.disconnect();
    expect(dbDisconnectCalls).toBe(1);
    expect(singletonAlive).toBe(false);
  });
});
