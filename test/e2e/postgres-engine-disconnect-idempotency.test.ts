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

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  // eslint-disable-next-line no-console
  console.log('Skipping postgres-engine-disconnect-idempotency E2E (DATABASE_URL not set)');
}

const ok1 = (rows: unknown[]) => (rows[0] as { ok: number }).ok;

describe.skipIf(skip)('PostgresEngine.disconnect idempotency + module-singleton ownership (#1471)', () => {
  // Every test builds its own module-singleton scenario from a clean slate, so
  // order is irrelevant and the ownership cases don't leak state into each other.
  beforeEach(async () => {
    await db.disconnect();
  }, 30_000);

  afterAll(async () => {
    await db.disconnect();
  });

  test('instance-pool engine: second disconnect() does NOT clobber module singleton', async () => {
    // Establish a module-level baseline (the cycle's singleton).
    await db.connect({ database_url: DATABASE_URL! });

    const engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL!, poolSize: 2 });

    await engine.disconnect();
    expect(ok1(await db.getConnection().unsafe('SELECT 1 as ok'))).toBe(1);

    // Second disconnect — pre-fix this fell through to db.disconnect() and
    // cleared the module-level singleton. Post-fix it's a no-op (instance style).
    await engine.disconnect();
    expect(ok1(await db.getConnection().unsafe('SELECT 1 as ok'))).toBe(1);
  });

  test('owner-first / borrower-second: a borrower disconnect must NOT null the owner singleton', async () => {
    // The exact dream-cycle bug: the owner (cycle engine) creates the singleton,
    // a probe (lint/doctor config-lift) borrows it, the probe disconnects, and
    // pre-fix that nulled the singleton the owner was still using.
    const owner = new PostgresEngine();
    await owner.connect({ database_url: DATABASE_URL! }); // module branch → creates → owns
    const borrower = new PostgresEngine();
    await borrower.connect({ database_url: DATABASE_URL! }); // singleton exists → borrows

    await borrower.disconnect(); // pre-fix: db.disconnect() → singleton null

    // The owner must still be able to run DB work (this is sync/synthesize).
    expect(ok1(await owner.executeRaw('SELECT 1 as ok'))).toBe(1);
    expect(() => db.getConnection()).not.toThrow();

    // And the owner — the true creator — DOES tear it down.
    await owner.disconnect();
    expect(() => db.getConnection()).toThrow(/No database connection/);
  });

  test('ownership tracks CREATION, not role: a probe that creates the singleton owns it', async () => {
    // codex #2: ownership is not "the cycle engine" by name — it is whoever
    // atomically created the pool. If a probe creates first, it owns; a later
    // joiner is the borrower. (Safe in gbrain because the CLI engine is always
    // the first creator and last to disconnect — the dominance invariant.)
    const firstCreator = new PostgresEngine();
    await firstCreator.connect({ database_url: DATABASE_URL! }); // creates → owns
    const joiner = new PostgresEngine();
    await joiner.connect({ database_url: DATABASE_URL! }); // joins → borrows

    await joiner.disconnect(); // no-op on the singleton
    expect(() => db.getConnection()).not.toThrow();
    await firstCreator.disconnect(); // creator tears down
    expect(() => db.getConnection()).toThrow(/No database connection/);
  });

  test('symmetric CLI-exit: a sole owner connect+disconnect tears the singleton down (no hang regression)', async () => {
    const engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    await engine.disconnect();
    // Pool must be CLOSED so the CLI event loop drains and `gbrain init` /
    // op-dispatch exit cleanly (the failure mode refcount would risk).
    expect(() => db.getConnection()).toThrow(/No database connection/);
    // Idempotent second disconnect.
    await expect(engine.disconnect()).resolves.toBeUndefined();
  });

  test('owner reconnect with a live borrower: borrower resolves the rebuilt singleton', async () => {
    const owner = new PostgresEngine();
    await owner.connect({ database_url: DATABASE_URL! }); // owns
    const borrower = new PostgresEngine();
    await borrower.connect({ database_url: DATABASE_URL! }); // borrows

    // Owner reconnect (the batchRetry path): tears down the old singleton and
    // builds a fresh one, re-acquiring ownership via the atomic db.connect() token.
    await owner.reconnect();

    // The borrower's normal query path (this.sql → db.getConnection()) resolves
    // the NEW singleton. (codex #4: the borrower's cached connectionManager pool
    // is stale — that ddl()-only edge is a filed TODO, not this normal path.)
    expect(ok1(await borrower.sql.unsafe('SELECT 1 as ok'))).toBe(1);
    expect(ok1(await owner.executeRaw('SELECT 1 as ok'))).toBe(1);

    await owner.disconnect();
    expect(() => db.getConnection()).toThrow(/No database connection/);
  });
});
