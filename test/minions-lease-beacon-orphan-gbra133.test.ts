/**
 * GBRA-133: a drain-lease holder record outlived its holder. The cycle child holding a source's drain lease was killed
 * (SIGTERM) before its `finally` deleted the record, so the row stayed `active` in the beacon queue with an expired
 * lock. The sweeps skip that queue (#7261) and only the next lease on the same source replaces the row, so on a source
 * whose sync was then switched off it stayed for good, shown as a stalled sync job. The stall sweep now deletes a
 * record whose lease lock is gone or expired, and still leaves a live holder's record alone.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LEASE_BEACON_QUEUE, withDrainLease } from '../src/core/persistence/sync-lease.ts';
import type { SyncResult } from '../src/commands/sync.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});
afterAll(async () => { await engine.disconnect(); });

const records = async () => (await engine.executeRaw<{ sourceId: string }>(
  "SELECT data->>'sourceId' AS \"sourceId\" FROM minion_jobs WHERE queue = $1 ORDER BY id", [LEASE_BEACON_QUEUE])).map(row => row.sourceId);

test("the stall sweep deletes a dead holder's record and keeps a live holder's", async () => {
  // A holder killed mid-lease: its record stays, its lock row is gone (released by TTL) or expired.
  for (const [sourceId, lock] of [['source-gone', null], ['source-expired', "now() - interval '1 minute'"]] as const) {
    const token = randomUUID();
    await engine.executeRaw(`INSERT INTO minion_jobs(name,queue,status,submission_authority,data,max_attempts,max_stalled,lock_token,lock_until,started_at,remove_on_complete,remove_on_fail)
      VALUES ('sync',$1,'active','{"version":1,"kind":"application"}'::jsonb,$2::text::jsonb,1,0,$3,now() - interval '1 hour',now() - interval '2 hours',true,true)`,
    [LEASE_BEACON_QUEUE, JSON.stringify({ sourceId, drain_lease_beacon: { kind: 'cycle', id: null, version: 'test' } }), token]);
    if (lock) await engine.executeRaw(`INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
      VALUES ($1, 1, 'host-a', now() - interval '2 hours', ${lock}, now() - interval '2 hours', $2::uuid)`, [`gbrain-sync:${sourceId}`, token]);
  }
  expect(await records()).toEqual(['source-gone', 'source-expired']);
  await withDrainLease(engine, 'source-live', { holder: { kind: 'cli' } }, async () => {
    await engine.executeRaw('UPDATE minion_jobs SET lock_until = now() - interval \'1 hour\' WHERE queue = $1', [LEASE_BEACON_QUEUE]);
    await queue.handleStalled(0);
    expect(await records()).toEqual(['source-live']);
    return { status: 'up_to_date' } as unknown as SyncResult;
  });
  expect(await records()).toEqual([]);
});
