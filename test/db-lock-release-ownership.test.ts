/**
 * Regression: a stale handle from an expired lock must not delete a newer
 * same-process takeover of the same lock row.
 *
 * The old release predicate matched only (id, holder_pid). In a Minion worker
 * process, multiple jobs can run in the same PID; if an old handle's finally ran
 * after a same-PID takeover, it could delete the new live lock and leave doctor
 * seeing inconsistent/stale cycle-lock state. The lock row must be owned by the
 * specific acquisition, not just by PID.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
}, 30_000);

describe('tryAcquireDbLock release ownership', () => {
  test('old same-pid handle release does not delete newer expired-lock takeover', async () => {
    const lockId = 'test-lock-release-same-pid-takeover';
    const first = await tryAcquireDbLock(engine, lockId, 1);
    expect(first).not.toBeNull();

    // Simulate an expired holder without waiting a minute.
    await engine.executeRaw(
      `UPDATE gbrain_cycle_locks
          SET ttl_expires_at = NOW() - INTERVAL '1 second',
              last_refreshed_at = NOW() - INTERVAL '1 second'
        WHERE id = $1`,
      [lockId],
    );

    const second = await tryAcquireDbLock(engine, lockId, 1);
    expect(second).not.toBeNull();

    // The stale first handle has the same process.pid. Its release must not
    // delete the second handle's newer ownership row.
    await first!.release();

    const third = await tryAcquireDbLock(engine, lockId, 1);
    expect(third).toBeNull();

    await second!.release();
  }, 60_000);
});
