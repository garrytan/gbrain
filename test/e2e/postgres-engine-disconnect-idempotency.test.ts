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
 * plus module-singleton ownership. Only the engine that created the module-level
 * connection calls db.disconnect(); borrowers leave the shared pool alive.
 * Second disconnect on an instance-pool engine is a no-op.
 *
 * This test pins the contract so future refactors of disconnect() can't
 * silently regress (it's exactly the bug class that took an hour of E2E
 * debugging to find). Four cases:
 *   1. instance-pool engine: connect → disconnect → disconnect must NOT
 *      affect the module-level connection.
 *   2. module-singleton borrower: connect → disconnect must NOT affect the
 *      owning module-level connection.
 *   3. lint's DB-config probe must leave the owner alive.
 *   4. module-singleton owner: connect → disconnect → disconnect is safe
 *      (first call closes the singleton; second call no-ops).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';
import { runLintCore } from '../../src/commands/lint.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  // eslint-disable-next-line no-console
  console.log('Skipping postgres-engine-disconnect-idempotency E2E (DATABASE_URL not set)');
}

describe.skipIf(skip)('PostgresEngine.disconnect idempotency', () => {
  beforeEach(async () => {
    await db.disconnect();
  }, 30_000);

  afterEach(async () => {
    await db.disconnect();
  });

  test('instance-pool engine: second disconnect() does NOT clobber module singleton', async () => {
    // Establish the module-level connection so we can verify it survives
    // the instance-pool engine's double-disconnect.
    await db.connect({ database_url: DATABASE_URL! });

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

  test('module-singleton borrower: disconnect() does NOT clobber owner singleton', async () => {
    const owner = new PostgresEngine();
    await owner.connect({ database_url: DATABASE_URL! });

    const borrower = new PostgresEngine();
    // No poolSize → uses the already-open module-level singleton as a borrower.
    await borrower.connect({ database_url: DATABASE_URL! });

    // Pre-fix, this called db.disconnect() and killed the owner's singleton.
    await borrower.disconnect();

    const afterBorrowerDisconnect = await db.getConnection().unsafe('SELECT 1 as ok');
    expect((afterBorrowerDisconnect[0] as unknown as { ok: number }).ok).toBe(1);

    // The owner still tears down the singleton it created.
    await owner.disconnect();
    expect(() => db.getConnection()).toThrow('No database connection');
  });

  test('lint DB-config probe: borrower disconnect() does NOT clobber owner singleton', async () => {
    const owner = new PostgresEngine();
    await owner.connect({ database_url: DATABASE_URL! });

    // This smoke test covers runLintCore's current DB-plane config probe. The
    // direct borrower test above pins the engine-level lifecycle contract.
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-lint-probe-'));
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;

    try {
      writeFileSync(join(dir, 'note.md'), '# Note\n\nClean content.\n');
      process.env.DATABASE_URL = DATABASE_URL!;
      delete process.env.GBRAIN_DATABASE_URL;

      await runLintCore({ target: dir, dryRun: true });

      const afterLintProbe = await db.getConnection().unsafe('SELECT 1 as ok');
      expect((afterLintProbe[0] as unknown as { ok: number }).ok).toBe(1);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousGbrainDatabaseUrl === undefined) delete process.env.GBRAIN_DATABASE_URL;
      else process.env.GBRAIN_DATABASE_URL = previousGbrainDatabaseUrl;
      rmSync(dir, { recursive: true, force: true });
      await owner.disconnect().catch(() => { /* already closed by a failing assertion path */ });
    }
  });

  test('module-singleton owner: second disconnect() is a no-op', async () => {
    const engine = new PostgresEngine();
    // No poolSize and no pre-existing singleton → this engine owns it.
    await engine.connect({ database_url: DATABASE_URL! });

    // First disconnect closes the module-level singleton.
    await engine.disconnect();
    expect(() => db.getConnection()).toThrow('No database connection');

    // Second disconnect must NOT throw — should be a no-op since
    // _connectionStyle was reset to null.
    await expect(engine.disconnect()).resolves.toBeUndefined();
  });
});
