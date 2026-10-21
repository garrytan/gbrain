/**
 * `replica_connection` doctor check: silent without a replica, ok for a
 * standby that answers, warn for a non-standby or an unreachable replica.
 */
import { describe, expect, test } from 'bun:test';
import { replicaConnectionEntry } from '../src/commands/doctor/checks/replica-connection.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { makeFakeSql, type Responder } from './helpers/fake-postgres-sql.ts';

function ctxWith(replica: Responder | null): DoctorContext {
  const pool = replica ? makeFakeSql(replica).sql : null;
  const connectionManager = {
    describeMode: () => (pool ? { replica_host: 'replica.example:5432' } : {}),
    replica: () => pool,
  };
  return { engine: { kind: 'postgres', connectionManager } } as unknown as DoctorContext;
}

describe('replica_connection', () => {
  test('no replica configured: no check', async () => {
    expect(await replicaConnectionEntry.run(ctxWith(null))).toEqual([]);
  });

  test('a standby that answers is ok and reports its replay age', async () => {
    const [check] = await replicaConnectionEntry.run(ctxWith(() => [{ in_recovery: true, replay_age_s: 0.4 }])) as any[];
    expect(check).toMatchObject({ name: 'replica_connection', status: 'ok', details: { host: 'replica.example:5432', in_recovery: true, replay_age_s: 0.4 } });
  });

  test('a database that is not a standby warns', async () => {
    const [check] = await replicaConnectionEntry.run(ctxWith(() => [{ in_recovery: false, replay_age_s: null }])) as any[];
    expect(check).toMatchObject({ name: 'replica_connection', status: 'warn', details: { in_recovery: false } });
  });

  test('an unreachable replica warns, since reads fall back to the primary', async () => {
    const [check] = await replicaConnectionEntry.run(ctxWith(() => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))) as any[];
    expect(check).toMatchObject({ name: 'replica_connection', status: 'warn', details: { reachable: false } });
  });
});
