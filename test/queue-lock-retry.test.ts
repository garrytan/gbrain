/**
 * issue #1678 — Minion hot-path lock recovery contract.
 *
 *  - promoteDelayed (idempotent) self-heals: a reaped-socket CONNECTION_ENDED
 *    triggers a reconnect + retry against a fresh pool.
 *  - claim does NOT retry inline (Codex #1): blind-retrying a claim whose
 *    UPDATE...RETURNING may have committed could double-claim a job. The error
 *    propagates; the worker poll loop reconnects + re-claims on the next tick.
 *
 * Hermetic: a fake BrainEngine whose executeRaw is scripted; no real DB.
 */

import { describe, it, expect } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { withEnv } from './helpers/with-env.ts';

function connEndedError(): Error & { code: string } {
  const e = new Error('write CONNECTION_ENDED localhost:6543') as Error & { code: string };
  e.code = 'CONNECTION_ENDED';
  return e;
}

const AUDIT_DIR = join(tmpdir(), `gbrain-queue-lock-retry-${process.pid}-${Date.now()}`);
// Fast retry + isolated audit dir so the test doesn't sleep ~1s or pollute ~/.gbrain.
const FAST_ENV = {
  GBRAIN_BULK_RETRY_BASE_MS: '1',
  GBRAIN_BULK_RETRY_MAX_MS: '2',
  GBRAIN_AUDIT_DIR: AUDIT_DIR,
};

describe('MinionQueue lock-path recovery (issue #1678)', () => {
  it('promoteDelayed reconnects + retries on a reaped-socket error', async () => {
    await withEnv(FAST_ENV, async () => {
      let calls = 0;
      let reconnects = 0;
      const engine = {
        kind: 'postgres',
        executeRaw: async () => {
          calls++;
          if (calls === 1) throw connEndedError();
          return [];
        },
        reconnect: async () => { reconnects++; },
      } as unknown as ConstructorParameters<typeof MinionQueue>[0];

      const q = new MinionQueue(engine);
      const out = await q.promoteDelayed();
      expect(out).toEqual([]);
      expect(calls).toBe(2); // first attempt threw, retry succeeded
      expect(reconnects).toBe(1); // reconnect fired between attempts
    });
  });

  it('claim does NOT retry inline on a reaped-socket error (Codex #1 double-claim guard)', async () => {
    await withEnv(FAST_ENV, async () => {
      let calls = 0;
      const engine = {
        kind: 'postgres',
        // claim() routes through executeRawDirect (direct session pool) as of
        // the lock-hot-path fix; executeRaw is kept as a throwing guard to
        // prove claim never falls back to it.
        executeRawDirect: async () => { calls++; throw connEndedError(); },
        executeRaw: async () => { throw new Error('claim must not use executeRaw'); },
        reconnect: async () => {},
      } as unknown as ConstructorParameters<typeof MinionQueue>[0];

      const q = new MinionQueue(engine);
      await expect(q.claim('tok', 1000, 'default', ['sync'])).rejects.toThrow('CONNECTION_ENDED');
      expect(calls).toBe(1); // exactly one attempt — no inline retry
    });
  });
});
