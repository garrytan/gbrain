/**
 * `gbrain dream` on a Postgres brain with no job worker (overtonxyz/gbrain#2772).
 * Postgres brains run facts-absorb jobs on the job worker, so the facts_drain
 * phase skips there. With no worker running, the jobs waited for weeks while
 * the phase printed a skip every night and the cycle looked healthy. The
 * phase now warns and names the command that starts a worker, reading the
 * queue itself so a worker on another host counts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhaseFactsDrain } from '../../src/core/cycle/facts-drain.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

async function onPostgres(fn: (db: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-dream-no-worker-'));
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_QUEUE_NO_WORKER_WARN_HOURS: undefined }, async () => {
      const { engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      try { await fn(engine); } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function queued(db: BrainEngine, name: string, n: number, age: string): Promise<number[]> {
  const queue = new MinionQueue(db);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push((await queue.add(name, { slug: `notes/no-worker-${name}-${age.replace(/\W/g, '')}-${i}`, sourceId: 'default' }, { queue: 'default' })).id);
  await db.executeRaw(`UPDATE minion_jobs SET created_at = now() - $2::text::interval, updated_at = now() - $2::text::interval WHERE id = ANY($1::int[])`, [ids, age]);
  return ids;
}

describe('dream facts_drain on Postgres with queued facts-absorb jobs', () => {
  test('jobs nothing has taken for days turn the phase into a warning that names the fix', () => onPostgres(async db => {
    await queued(db, 'facts-absorb', 3, '22 days');
    const pass = await runPhaseFactsDrain(db, { dryRun: false });
    expect(pass.status).toBe('warn');
    expect(pass.summary).toContain('3 facts-absorb job(s)');
    expect(pass.summary).toContain('22d');
    expect(pass.summary).toContain('gbrain jobs supervisor start');
    expect(pass.details).toMatchObject({ reason: 'no_worker', no_worker: { queue: 'default', waiting: 3, fix: { argv: ['gbrain', 'jobs', 'supervisor', 'start'] } } });
  }), 120_000);

  test('the warning shows on a dry run too, since it only reads the queue', () => onPostgres(async db => {
    await queued(db, 'facts-absorb', 1, '3 hours');
    expect((await runPhaseFactsDrain(db, { dryRun: true })).details).toMatchObject({ reason: 'no_worker' });
  }), 120_000);

  test('a worker that started a job within the hour keeps the phase quiet', () => onPostgres(async db => {
    await queued(db, 'facts-absorb', 2, '2 hours');
    const [taken] = await queued(db, 'embed-backfill', 1, '2 hours');
    await db.executeRaw(`UPDATE minion_jobs SET status = 'completed', started_at = now() - interval '5 minutes', finished_at = now() WHERE id = $1`, [taken]);
    const pass = await runPhaseFactsDrain(db, { dryRun: false });
    expect(pass.status).toBe('skipped');
    expect(pass.details).toMatchObject({ reason: 'not_applicable' });
  }), 120_000);

  test('a worker busy with one long job is not mistaken for no worker', () => onPostgres(async db => {
    await queued(db, 'facts-absorb', 2, '3 hours');
    await queued(db, 'embed-backfill', 1, '3 hours');
    const busy = await new MinionQueue(db).claim('worker-elsewhere', 300_000, 'default', ['embed-backfill']);
    await db.executeRaw(`UPDATE minion_jobs SET started_at = now() - interval '2 hours' WHERE id = $1`, [busy!.id]);
    expect((await runPhaseFactsDrain(db, { dryRun: false })).status).toBe('skipped');
  }), 120_000);

  test('a job left active by a worker that died does not hide the warning', () => onPostgres(async db => {
    await queued(db, 'facts-absorb', 2, '3 hours');
    await queued(db, 'embed-backfill', 1, '3 hours');
    const stalled = await new MinionQueue(db).claim('worker-gone', 300_000, 'default', ['embed-backfill']);
    await db.executeRaw(`UPDATE minion_jobs SET started_at = now() - interval '2 hours', lock_until = now() - interval '90 minutes' WHERE id = $1`, [stalled!.id]);
    expect((await runPhaseFactsDrain(db, { dryRun: false })).details).toMatchObject({ reason: 'no_worker' });
  }), 120_000);

  test('an old job re-queued just now, as the dead-job retry does, is not a stuck queue yet', () => onPostgres(async db => {
    const [job] = await queued(db, 'facts-absorb', 1, '22 days');
    await db.executeRaw(`UPDATE minion_jobs SET updated_at = now() WHERE id = $1`, [job]);
    expect((await runPhaseFactsDrain(db, { dryRun: false })).status).toBe('skipped');
  }), 120_000);

  test('a queue on another name gets the fix that names it, and an age in hours', () => onPostgres(async db => {
    const job = await new MinionQueue(db).add('facts-absorb', { slug: 'notes/no-worker-other', sourceId: 'default' }, { queue: 'other' });
    await db.executeRaw(`UPDATE minion_jobs SET created_at = now() - interval '3 hours', updated_at = now() - interval '3 hours' WHERE id = $1`, [job.id]);
    const pass = await runPhaseFactsDrain(db, { dryRun: false });
    expect(pass.summary).toContain('3h');
    expect(pass.details).toMatchObject({ no_worker: { queue: 'other', fix: { argv: ['gbrain', 'jobs', 'supervisor', 'start', '--queue', 'other'] } } });
  }), 120_000);

  test('jobs queued minutes ago are not a stuck queue yet', () => onPostgres(async db => {
    await queued(db, 'facts-absorb', 2, '10 minutes');
    expect((await runPhaseFactsDrain(db, { dryRun: false })).status).toBe('skipped');
  }), 120_000);

  test('GBRAIN_QUEUE_NO_WORKER_WARN_HOURS sets the threshold', () => onPostgres(async db => {
    await queued(db, 'facts-absorb', 1, '3 hours');
    await withEnv({ GBRAIN_QUEUE_NO_WORKER_WARN_HOURS: '6' }, async () => {
      expect((await runPhaseFactsDrain(db, { dryRun: false })).status).toBe('skipped');
    });
  }), 120_000);
});
