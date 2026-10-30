/**
 * The drain lease's fence (assertDrainLease) holds the lock row FOR KEY SHARE for the life of its transaction, so a takeover,
 * which must UPDATE or DELETE the row, waits until the transaction ends: a pass that passed its fence cannot have its
 * lease taken from under it before it commits. spec/tla/drain-lease (mutant fence-without-share-lock) depends on it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { SyncResult } from '../../src/commands/sync.ts';
import { syncLockId } from '../../src/core/db-lock.ts';
import { assertDrainLease, withDrainLease } from '../../src/core/persistence/sync-lease.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const run = process.env.DATABASE_URL ? test : test.skip;
let engine: PostgresEngine;
let url: string;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
  engine = isolated.engine; url = isolated.databaseUrl; close = isolated.close;
}, 60_000);
afterAll(async () => { await close?.(); });

run('the fence holds the lease row FOR KEY SHARE, so it blocks a takeover until its transaction ends', async () => {
  const other = postgres(url, { max: 1, prepare: false });
  // A takeover as --break-lock writes it (a DELETE, which conflicts with every row lock a fence can take, FOR KEY SHARE
  // included), from another connection, giving up after 1 s.
  const takeover = () => other.begin(async tx => {
    await tx.unsafe("SET LOCAL lock_timeout = '1s'");
    return tx.unsafe('DELETE FROM gbrain_cycle_locks WHERE id = $1 RETURNING id', [syncLockId('default')]);
  });
  try {
    let duringFence: unknown;
    let afterCommit: unknown;
    await withDrainLease(engine, 'default', { holder: { kind: 'cli' } }, async () => {
      await engine.transaction(async tx => {
        await assertDrainLease(tx, 'default');
        duringFence = await takeover().then(rows => rows.length, error => (error as { code?: string }).code);
      });
      afterCommit = await takeover().then(rows => rows.length, error => (error as { code?: string }).code);
      return { status: 'up_to_date' } as SyncResult;
    }).catch(() => undefined);
    expect(duringFence).toBe('55P03');
    expect(afterCommit).toBe(1);
  } finally {
    await other.end();
  }
}, 60_000);
