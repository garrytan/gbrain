/**
 * E2E test pinning the PostgresEngine.disconnect() idempotency invariant.
 *
 * Background: when commit 671ef099 added engine.disconnect() to
 * MinionWorker.start()'s finally block, every test that calls worker.start()
 * AND then engine.disconnect() in its own finally was double-disconnecting
 * the same engine instance. Pre-fix, the second disconnect found _sql=null
 * and fell through to the `else` branch which calls db.disconnect() — but
 * db.disconnect() clears the GLOBAL module-level connection, breaking
 * unrelated downstream tests (their getConn() throws "no database
 * connection" on the next beforeEach).
 *
 * The fix: PostgresEngine tracks `_connectionStyle` ('instance' | 'module')
 * and only calls db.disconnect() when it actually owns the module-level
 * connection. Second disconnect on an instance-pool engine is a no-op.
 *
 * This test pins the contract so future refactors of disconnect() can't
 * silently regress (it's exactly the bug class that took an hour of E2E
 * debugging to find). Two cases:
 *   1. instance-pool engine: connect → disconnect → disconnect must NOT
 *      affect the module-level connection.
 *   2. module-singleton engine: connect → disconnect → disconnect is safe
 *      (second call no-ops).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  // eslint-disable-next-line no-console
  console.log('Skipping postgres-engine-disconnect-idempotency E2E (DATABASE_URL not set)');
}

describe.skipIf(skip)('PostgresEngine.disconnect idempotency', () => {
  beforeAll(async () => {
    // Establish the module-level connection so we can verify it survives
    // the instance-pool engine's double-disconnect.
    await db.disconnect();
    await db.connect({ database_url: DATABASE_URL! });
  }, 30_000);

  afterAll(async () => {
    await db.disconnect();
  });

  test('instance-pool engine: second disconnect() does NOT clobber module singleton', async () => {
    const engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL!, poolSize: 2 });

    // First disconnect — closes the engine's own pool.
    await engine.disconnect();

    // Sanity: module-level connection still alive (this is what
    // helpers.ts's getConn() returns).
    const before = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((before[0] as unknown as { ok: number }).ok).toBe(1);

    // Second disconnect — pre-fix, this fell through to db.disconnect()
    // and cleared the module-level singleton. Post-fix, it's a no-op.
    await engine.disconnect();

    // Module-level connection MUST still be alive.
    const after = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((after[0] as unknown as { ok: number }).ok).toBe(1);
  });

  test('module-singleton engine: second disconnect() is a no-op', async () => {
    // Re-establish module-level connection (idempotent; no-op if still
    // connected from beforeAll).
    await db.connect({ database_url: DATABASE_URL! });

    const engine = new PostgresEngine();
    // No poolSize → uses the module-level singleton.
    await engine.connect({ database_url: DATABASE_URL! });

    // First disconnect closes module-level singleton (this engine owned it).
    await engine.disconnect();

    // Second disconnect must NOT throw — should be a no-op since
    // _connectionStyle was reset to null.
    await expect(engine.disconnect()).resolves.toBeUndefined();
  });

  test('v0.41+ lint-phase fix: module-style engine disconnect() does NOT tear down singleton (FIRST call)', async () => {
    // Background: a fresh engine created mid-cycle by resolveLintContentSanity
    // (lint.ts:319) shares the module-level singleton via engine.connect({})
    // with no explicit URL. Pre-fix, its finally block called engine.disconnect()
    // which fell through to db.disconnect(), killing the singleton the cycle
    // was using. Every subsequent phase then ran against a dead pool.
    //
    // Post-fix: db.disconnect() is refcounted. The lint engine's disconnect
    // decrements the refcount from 2 to 1 (the CLI top-level still holds a
    // reference), so the singleton stays alive.
    //
    // This is the regression test for the lint-phase disconnect bug class.

    // Re-establish module-level connection (the cycle's singleton).
    await db.connect({ database_url: DATABASE_URL! });

    // Sanity: singleton is alive before we create the lint engine.
    const sanity = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((sanity[0] as unknown as { ok: number }).ok).toBe(1);

    // A FRESH engine that shares the module singleton (no poolSize → 'module').
    // This mimics resolveLintContentSanity creating its own engine to probe DB
    // config mid-cycle, then disconnecting in finally.
    const lintEngine = new PostgresEngine();
    await lintEngine.connect({ database_url: DATABASE_URL! });

    // The act: lint-engine disconnects on phase completion.
    // Pre-fix this killed the singleton; post-refcount-fix it just decrements.
    await lintEngine.disconnect();

    // CRITICAL: module-level singleton is STILL alive after lint engine's
    // disconnect. The cycle's downstream phases (extract, embed,
    // conversation_facts_backfill) must still be able to use db.getConnection().
    //
    // Pre-fix this throws: "No database connection: connect() has not been called."
    const after = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((after[0] as unknown as { ok: number }).ok).toBe(1);
  });

  test('CLI lifecycle: single-engine disconnect MUST close the module singleton', async () => {
    // This is the symmetric test to the lint-phase case above. The v1 patch
    // (PR #1546 first commit) removed db.disconnect() from the module branch
    // entirely. That fixed the lint case but broke the CLI top-level exit
    // path: `gbrain init` and every op-dispatch command hung past their
    // natural exit because the postgres.js pool's keep-alive socket kept
    // Bun's event loop alive. CI Tier 1 caught this — 4 Setup Journey tests
    // hit exit 143 (SIGTERM at the test's 15s timeout).
    //
    // Post-refcount-fix: the SOLE engine's disconnect IS the last
    // reference release, so it actually closes the pool. CLI exits cleanly.

    // Hard reset to simulate a fresh CLI process start.
    await db._resetForTest();
    expect(db._getRefCountForTest()).toBe(0);

    // CLI's connectEngine() creates one PostgresEngine with no poolSize.
    const cliEngine = new PostgresEngine();
    await cliEngine.connect({ database_url: DATABASE_URL! });
    expect(db._getRefCountForTest()).toBe(1);

    // Sanity: singleton is alive.
    const sanity = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((sanity[0] as unknown as { ok: number }).ok).toBe(1);

    // Act: CLI top-level disconnect (the only engine on the process).
    await cliEngine.disconnect();

    // CRITICAL: refcount went to 0, so the pool was actually closed.
    // db.getConnection() now throws because sql=null. This is what
    // makes `gbrain init` exit cleanly instead of hanging until SIGTERM.
    expect(db._getRefCountForTest()).toBe(0);
    expect(() => db.getConnection()).toThrow();

    // Re-establish for the afterAll cleanup contract.
    await db.connect({ database_url: DATABASE_URL! });
  });

  test('refcount: lint-piggyback then CLI top-level disconnect both close cleanly', async () => {
    // End-to-end refcount lifecycle: simulate the full production sequence
    // (CLI startup → lint mid-cycle → CLI exit) in one test.

    await db._resetForTest();

    // 1. CLI startup: one engine, refCount goes 0 → 1.
    const cliEngine = new PostgresEngine();
    await cliEngine.connect({ database_url: DATABASE_URL! });
    expect(db._getRefCountForTest()).toBe(1);

    // 2. Mid-cycle lint phase creates a fresh engine: refCount 1 → 2.
    const lintEngine = new PostgresEngine();
    await lintEngine.connect({ database_url: DATABASE_URL! });
    expect(db._getRefCountForTest()).toBe(2);

    // 3. Lint phase disconnects: refCount 2 → 1, singleton stays alive.
    await lintEngine.disconnect();
    expect(db._getRefCountForTest()).toBe(1);
    const stillAlive = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((stillAlive[0] as unknown as { ok: number }).ok).toBe(1);

    // 4. CLI's final disconnect: refCount 1 → 0, sql.end() fires, pool closes.
    await cliEngine.disconnect();
    expect(db._getRefCountForTest()).toBe(0);
    expect(() => db.getConnection()).toThrow();

    // Re-establish for the afterAll cleanup contract.
    await db.connect({ database_url: DATABASE_URL! });
  });
});
