/**
 * Local-only external DreamCycle finalization contract.
 *
 * The external scheduler may only call begin/finalize. These tests pin that
 * begin records source membership in minion_jobs, finalization needs receipts
 * newer than begin, drift/de-dup defer safely, and the worker can revalidate
 * the sealed batch without a new HTTP/MCP operation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  beginExternalDreamcycle,
  EXTERNAL_DREAMCYCLE_AUTHORITY,
  externalDreamcycleFinalizerBatchMatches,
  finalizeExternalDreamcycle,
  parseDreamcycleArgs,
} from '../src/commands/dreamcycle.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

const NOW = new Date('2026-07-19T01:00:00.000Z'); // JST 10:00, safely inside one day

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Keep the schema/version config that MinionQueue.ensureSchema() needs.
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks');
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
  await engine.setConfig('autopilot.global_maintenance.authority', EXTERNAL_DREAMCYCLE_AUTHORITY);
});

async function seedSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())`,
    [id, id, `/tmp/gbrain-dreamcycle-${id}`],
  );
}

async function markSourceComplete(id: string, at = new Date(NOW.getTime() + 1_000)): Promise<void> {
  await engine.updateSourceConfig(id, {
    last_source_cycle_at: at.toISOString(),
    last_full_cycle_at: at.toISOString(),
  });
}

describe('external DreamCycle begin/finalize', () => {
  test('requires the existing external_dreamcycle authority before recording anything', async () => {
    await seedSource('alpha');
    await engine.setConfig('autopilot.global_maintenance.authority', 'daily_finalizer');

    const result = await beginExternalDreamcycle(engine, queue, { now: NOW });
    expect(result).toEqual({ outcome: 'global_deferred', detail: 'external_dreamcycle_not_enabled' });
    const jobs = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs`,
    );
    expect(jobs[0]?.count).toBe('0');
  });

  test('authority config-read failures fail closed at every external entry point', async () => {
    const unavailable = {
      getConfig: async () => { throw new Error('configuration database unavailable'); },
    } as unknown as PGLiteEngine;

    expect(await beginExternalDreamcycle(unavailable, queue, { now: NOW }))
      .toEqual({ outcome: 'global_deferred', detail: 'external_dreamcycle_not_enabled' });
    expect(await finalizeExternalDreamcycle(unavailable, queue, { now: NOW }))
      .toEqual({ outcome: 'global_deferred', detail: 'external_dreamcycle_not_enabled' });
    expect(await externalDreamcycleFinalizerBatchMatches(unavailable, {}, { now: NOW })).toBe(false);
  });

  test('begin persists a source-id snapshot, then finalize seals one fixed protected global job', async () => {
    await seedSource('alpha');
    await seedSource('beta');

    const begun = await beginExternalDreamcycle(engine, queue, { now: NOW });
    expect(begun.outcome).toBe('begun');
    if (begun.outcome !== 'begun') throw new Error('expected begin receipt');

    const beginJob = await queue.getJob(begun.begin_job_id);
    expect(beginJob?.name).toBe('dreamcycle-begin');
    expect(beginJob?.idempotency_key).toBe('dreamcycle:external:begin:2026-07-19');
    expect(beginJob?.data.source_snapshot).toEqual([
      { source_id: 'alpha' },
      { source_id: 'beta' },
    ]);
    expect(beginJob?.data.source_snapshot_revision).toBe('["alpha","beta"]');

    await markSourceComplete('alpha');
    await markSourceComplete('beta');
    const sealed = await finalizeExternalDreamcycle(engine, queue, { now: NOW });
    expect(sealed.outcome).toBe('sealed');
    if (sealed.outcome !== 'sealed') throw new Error('expected sealed finalizer');

    const globalJob = await queue.getJob(sealed.global_job_id);
    expect(globalJob?.name).toBe('autopilot-global-maintenance');
    expect(globalJob?.idempotency_key).toBe('dreamcycle:global:2026-07-19');
    expect(globalJob?.data).toMatchObject({
      repoPath: null,
      phases: ['resolve_symbol_edges', 'embed', 'orphans'],
      execution_authority: 'dreamcycle_global',
      finalizer_origin: EXTERNAL_DREAMCYCLE_AUTHORITY,
      external_dreamcycle_begin_job_id: begun.begin_job_id,
      external_dreamcycle_begin_jst_day: '2026-07-19',
    });
    expect(globalJob?.data.source_snapshot).toEqual([
      { source_id: 'alpha', receipt_at: new Date(NOW.getTime() + 1_000).toISOString() },
      { source_id: 'beta', receipt_at: new Date(NOW.getTime() + 1_000).toISOString() },
    ]);

    // Duplicate calls never enqueue a second global pass, even after the
    // first job has left the waiting state in a real worker deployment.
    const duplicate = await finalizeExternalDreamcycle(engine, queue, { now: NOW });
    expect(duplicate).toEqual({ outcome: 'global_deferred', detail: 'duplicate_global_finalizer' });
    const globals = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE name = 'autopilot-global-maintenance'`,
    );
    expect(globals[0]?.count).toBe('1');
  });

  test('pre-begin or missing source receipts fail closed without a global job', async () => {
    await seedSource('alpha');
    await markSourceComplete('alpha', new Date(NOW.getTime() - 1_000));
    const begun = await beginExternalDreamcycle(engine, queue, { now: NOW });
    expect(begun.outcome).toBe('begun');

    const result = await finalizeExternalDreamcycle(engine, queue, { now: NOW });
    expect(result).toEqual({ outcome: 'global_deferred', detail: 'source_receipts_incomplete_or_pre_begin' });
    const globals = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE name = 'autopilot-global-maintenance'`,
    );
    expect(globals[0]?.count).toBe('0');
  });

  test('racing finalize calls seal one job and defer the duplicate caller', async () => {
    await seedSource('alpha');
    const begun = await beginExternalDreamcycle(engine, queue, { now: NOW });
    expect(begun.outcome).toBe('begun');
    await markSourceComplete('alpha');

    const results = await Promise.all([
      finalizeExternalDreamcycle(engine, queue, { now: NOW }),
      finalizeExternalDreamcycle(engine, queue, { now: NOW }),
    ]);
    expect(results.filter((result) => result.outcome === 'sealed')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'global_deferred')).toHaveLength(1);
    const globals = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs WHERE name = 'autopilot-global-maintenance'`,
    );
    expect(globals[0]?.count).toBe('1');
  });

  test('source membership drift or list failure defers with zero global enqueue', async () => {
    await seedSource('alpha');
    const begun = await beginExternalDreamcycle(engine, queue, { now: NOW });
    expect(begun.outcome).toBe('begun');
    await markSourceComplete('alpha');
    await seedSource('beta');

    const drifted = await finalizeExternalDreamcycle(engine, queue, { now: NOW });
    expect(drifted).toEqual({ outcome: 'global_deferred', detail: 'source_membership_drift' });

    const unavailable = await beginExternalDreamcycle(
      {
        getConfig: async () => EXTERNAL_DREAMCYCLE_AUTHORITY,
        listAllSources: async () => { throw new Error('database unavailable'); },
      } as unknown as PGLiteEngine,
      queue,
      { now: NOW },
    );
    expect(unavailable).toEqual({ outcome: 'global_deferred', detail: 'source_listing_unavailable' });
  });

  test('claim-time validation rechecks current config, membership, and newer receipts', async () => {
    await seedSource('alpha');
    const begun = await beginExternalDreamcycle(engine, queue, { now: NOW });
    expect(begun.outcome).toBe('begun');
    await markSourceComplete('alpha');
    const sealed = await finalizeExternalDreamcycle(engine, queue, { now: NOW });
    expect(sealed.outcome).toBe('sealed');
    if (sealed.outcome !== 'sealed') throw new Error('expected sealed finalizer');
    const job = await queue.getJob(sealed.global_job_id);
    expect(job).not.toBeNull();
    expect(await externalDreamcycleFinalizerBatchMatches(engine, job!.data, { now: NOW })).toBe(true);

    await engine.setConfig('autopilot.global_maintenance.authority', 'daily_finalizer');
    expect(await externalDreamcycleFinalizerBatchMatches(engine, job!.data, { now: NOW })).toBe(false);
  });

  test('sealed external batch remains valid across JST midnight only for its sealed day', async () => {
    const begunAt = new Date('2026-07-19T14:59:00.000Z'); // JST 2026-07-19 23:59
    const receiptAt = new Date('2026-07-19T14:59:30.000Z');
    const claimedAt = new Date('2026-07-19T15:01:00.000Z'); // JST 2026-07-20 00:01
    await seedSource('alpha');

    const begun = await beginExternalDreamcycle(engine, queue, { now: begunAt });
    expect(begun.outcome).toBe('begun');
    await markSourceComplete('alpha', receiptAt);
    const sealed = await finalizeExternalDreamcycle(engine, queue, { now: receiptAt });
    expect(sealed.outcome).toBe('sealed');
    if (sealed.outcome !== 'sealed') throw new Error('expected sealed finalizer');
    const job = await queue.getJob(sealed.global_job_id);
    expect(job).not.toBeNull();

    // The next-day worker clock must not select a new begin record or require
    // next-day source receipts. The sealed job owns its original JST day.
    expect(await externalDreamcycleFinalizerBatchMatches(engine, job!.data, { now: claimedAt })).toBe(true);

    // Both sealed day fields are independent integrity gates. A malformed or
    // mismatched day must never turn this into a cross-day replay.
    expect(await externalDreamcycleFinalizerBatchMatches(engine, {
      ...job!.data,
      source_snapshot_jst_day: '2026-07-20',
    }, { now: claimedAt })).toBe(false);
    expect(await externalDreamcycleFinalizerBatchMatches(engine, {
      ...job!.data,
      external_dreamcycle_begin_jst_day: 'not-a-jst-day',
    }, { now: claimedAt })).toBe(false);
  });

  test('CLI parser accepts no phase/source/authority/snapshot override', () => {
    expect(parseDreamcycleArgs(['begin', '--json'])).toEqual({ action: 'begin', json: true, help: false });
    expect(() => parseDreamcycleArgs(['finalize', '--phase', 'orphans']))
      .toThrow('accepts no phase/source/authority/snapshot overrides');
    expect(() => parseDreamcycleArgs(['finalize', '--source', 'alpha']))
      .toThrow('accepts no phase/source/authority/snapshot overrides');
    expect(() => parseDreamcycleArgs(['finalize', '--authority', 'dreamcycle_global']))
      .toThrow('accepts no phase/source/authority/snapshot overrides');
    expect(() => parseDreamcycleArgs(['finalize', '--snapshot', 'forged']))
      .toThrow('accepts no phase/source/authority/snapshot overrides');
  });
});
