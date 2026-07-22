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

  test('CASE 1: a borrower disconnect leaves the shared singleton ALIVE — no reconnect needed (#1471 ownership fix)', async () => {
    // The dream-cycle scenario: caller A is mid-batch, caller B (a probe engine
    // that BORROWED the singleton) disconnects. Pre-#1471, B's disconnect
    // cascaded to db.disconnect() and nulled the singleton for A, so A's next
    // call threw "connect() has not been called" and only batchRetry's reconnect
    // could recover (and sync/synthesize, which never enter batchRetry, stayed
    // broken). Post-#1471, B is a borrower (it joined the singleton beforeAll
    // created) and its disconnect is a no-op — the singleton survives WITHOUT
    // any reconnect, which is what protects the non-batch phases.
    await db.connect({ database_url: DATABASE_URL! }); // already up from beforeAll → no-op

    const engineA = new PostgresEngine();
    await engineA.connect({ database_url: DATABASE_URL! }); // borrows
    const engineB = new PostgresEngine();
    await engineB.connect({ database_url: DATABASE_URL! }); // borrows

    // Sanity: both engines share the live singleton.
    expect((await engineA.sql`SELECT 1 as ok`)[0].ok).toBe(1);
    expect((await engineB.sql`SELECT 1 as ok`)[0].ok).toBe(1);

    // Engine B (a borrower) disconnects mid-operation. The bug fix: this MUST
    // NOT null the singleton engine A is still using.
    await engineB.disconnect();

    // Engine A's direct call now SUCCEEDS (pre-fix it threw). This is the
    // inverted assertion — the path that used to "prove the bug exists" now
    // proves the bug is gone. No reconnect, no retry: just works.
    const afterBorrowerDisconnect = await engineA.sql`SELECT 1 as ok`;
    expect(afterBorrowerDisconnect[0].ok).toBe(1);

    // Defense-in-depth: reconnect() still works on a borrower (re-borrows the
    // still-live singleton) — the genuine-transient-drop recovery path is intact.
    await engineA.reconnect();
    expect((await engineA.sql`SELECT 1 as ok`)[0].ok).toBe(1);

    await engineA.disconnect(); // borrower no-op; singleton torn down by afterAll
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
