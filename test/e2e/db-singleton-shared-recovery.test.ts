/**
 * v0.41.25.0 (#1570) — focused regression test for the dream-cycle
 * row-loss bug class. Each case pins a real production failure mode
 * codex recommended pinning (codex finding 4: instrument + targeted
 * regression test, not architectural refactor).
 *
 * Skipped when DATABASE_URL is unset — mirrors every other test/e2e/
 * file's posture. Caller is expected to bring up gbrain-test-pg via
 * the canonical lifecycle described in CLAUDE.md.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';
import { withEnv } from '../helpers/with-env.ts';
import {
  readRecentDbDisconnects,
  logDbDisconnect,
} from '../../src/core/audit/db-disconnect-audit.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  // eslint-disable-next-line no-console
  console.log('Skipping db-singleton-shared-recovery E2E (DATABASE_URL not set)');
}

describe.skipIf(skip)('v0.41.25.0 db-singleton shared-recovery regressions (#1570)', () => {
  let tmpAuditDir: string;

  beforeAll(async () => {
    // Fresh module-level connection so each test starts from a known state.
    await db.disconnect();
    await db.connect({ database_url: DATABASE_URL! });
  }, 30_000);

  afterAll(async () => {
    await db.disconnect();
    if (tmpAuditDir) {
      try { fs.rmSync(tmpAuditDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  beforeEach(() => {
    tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-1570-e2e-'));
  });

  test('CASE 1: shared singleton survives mid-operation disconnect via retry reconnect', async () => {
    // Reproduce the dream-cycle scenario: caller A is mid-batch, caller B
    // disconnects the module singleton, caller A's NEXT attempt enters
    // retry and the reconnect callback rebuilds the singleton before the
    // retry's fn fires. This is the symptom-fix contract we ship.
    await db.connect({ database_url: DATABASE_URL! });

    const engineA = new PostgresEngine();
    await engineA.connect({ database_url: DATABASE_URL! });
    const engineB = new PostgresEngine();
    await engineB.connect({ database_url: DATABASE_URL! });

    // Sanity: both engines share the live singleton.
    expect((await engineA.sql`SELECT 1 as ok`)[0].ok).toBe(1);
    expect((await engineB.sql`SELECT 1 as ok`)[0].ok).toBe(1);

    // Engine B disconnects mid-operation (the "offending caller" scenario).
    // This nulls the module singleton for engine A too.
    await engineB.disconnect();

    // Engine A's direct unsafe call will throw — proving the bug class
    // exists at the engine.sql layer.
    let directThrew = false;
    try {
      await engineA.sql`SELECT 1`;
    } catch {
      directThrew = true;
    }
    expect(directThrew).toBe(true);

    // The retry layer's reconnect callback recovers. We exercise it via
    // engine.reconnect() directly (which is what batchRetry's injected
    // reconnect callback calls). After reconnect, engine A's next call
    // succeeds.
    await engineA.reconnect();
    const afterRecovery = await engineA.sql`SELECT 1 as ok`;
    expect(afterRecovery[0].ok).toBe(1);

    // Cleanup
    await engineA.disconnect();
  });

  test('CASE 2: diagnostic audit records every mid-process disconnect call', async () => {
    // Per codex finding 4: instrument first. Production data tells us
    // which caller is firing the mid-process disconnect. This case pins
    // that the instrumentation is wired correctly: a disconnect call
    // emits an audit JSONL line containing connection_style + caller_stack.
    await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
      await db.connect({ database_url: DATABASE_URL! });
      const engine = new PostgresEngine();
      await engine.connect({ database_url: DATABASE_URL! });
      // module-style engine.disconnect() should log an audit line.
      await engine.disconnect();

      // Read it back. doctor uses the same readRecentDbDisconnects path.
      const result = readRecentDbDisconnects(24);
      expect(result.count).toBeGreaterThanOrEqual(1);
      const last = result.events[0];
      expect(last.engine_kind).toBe('postgres');
      expect(['module', 'unknown']).toContain(last.connection_style);
      expect(last.caller_stack.length).toBeGreaterThan(0);
      expect(last.pid).toBe(process.pid);
    });
  });

  test('CASE 3: instance-pool disconnect leaves shared singleton ALIVE for other callers', async () => {
    // Codex finding 5/6: BrainEngine contract is asymmetric across engines.
    // Instance-pool engines (workerPoolSize set) should NEVER touch the
    // module singleton on disconnect. This case pins that contract —
    // existing v0.28.1 idempotency test covers the same shape but here
    // we explicitly verify the "two callers, one in instance mode" case
    // matters for #1570.
    await db.connect({ database_url: DATABASE_URL! });
    const moduleEngine = new PostgresEngine();
    await moduleEngine.connect({ database_url: DATABASE_URL! }); // module mode

    const workerEngine = new PostgresEngine();
    await workerEngine.connect({ database_url: DATABASE_URL!, poolSize: 2 }); // instance mode

    // Worker disconnect: should ONLY tear down its own _sql, not touch module.
    await workerEngine.disconnect();

    // Module engine still works.
    const result = await moduleEngine.sql`SELECT 1 as ok`;
    expect(result[0].ok).toBe(1);

    await moduleEngine.disconnect();
  });
});
