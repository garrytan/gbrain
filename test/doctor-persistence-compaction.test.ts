/**
 * #6696 (A10, A11): `persistence_counter_drift` compares the receipt-bytes
 * counters with what the receipts reserve in one statement;
 * `persistence_compaction` warns when a resident consumer has run past the
 * staleness window without recording a compaction pass. Both are ok on a
 * fresh brain. PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkPersistenceCompaction, checkPersistenceCounterDrift } from '../src/commands/doctor/checks/persistence-compaction.ts';
import { LAST_COMPACTION_KEY, readLastCompaction, runCompactionPass } from '../src/core/persistence/compaction-pass.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { editRequest, freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

describe('persistence counter drift and compaction health', () => {
  let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
  let scratch: string;
  beforeAll(async () => { scratch = mkdtempSync(join(tmpdir(), 'gbrain-doctor-compaction-')); factory = await freshBrainFactory('pglite'); }, 120_000);
  afterAll(async () => { await factory?.dispose(); rmSync(scratch, { recursive: true, force: true }); });
  const run = (fn: (engine: BrainEngine) => Promise<void>) => () => withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
    async () => fn(await factory.fresh()));

  test('both are categorized and ok on a fresh brain', run(async engine => {
    for (const name of ['persistence_compaction', 'persistence_counter_drift']) expect(categorizeCheck(name)).toBeTruthy();
    expect(await checkPersistenceCounterDrift(engine)).toMatchObject({ status: 'ok' });
    expect(await checkPersistenceCompaction(engine)).toMatchObject({ status: 'ok', details: { live_consumers: 0, last_compaction: null } });
  }), 60_000);

  test('counters that match the receipts are ok; a counter charged past them warns with the delta and the clamp count', run(async engine => {
    const requests = await requestFixture(engine);
    await requests.admit('one'); await requests.admit('two');
    expect(await checkPersistenceCounterDrift(engine)).toMatchObject({ status: 'ok', details: { drift: [] } });
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_counters SET terminal_bytes=terminal_bytes+5000 WHERE key='brain'");
    });
    await engine.setConfig('persistence.true_up.clamped', '2');
    const drift = await checkPersistenceCounterDrift(engine);
    expect(drift).toMatchObject({ status: 'warn', details: { drift: [{ scope: 'brain', delta: 5000 }], true_up_clamped: 2 } });
    expect(drift.message).toContain('(+5000)');
  }), 60_000);

  test('#6759: a positive delta is a bounded overcharge with a per-scope receipt breakdown; a negative one under-counts', run(async engine => {
    const requests = await requestFixture(engine);
    await requests.admit('one'); await requests.admit('two');
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_counters SET terminal_bytes=terminal_bytes+983040 WHERE key='brain'");
      await tx.executeRaw("UPDATE persistence_counters SET terminal_bytes=terminal_bytes-100 WHERE key LIKE 'principal:%'");
    });
    const drift = await checkPersistenceCounterDrift(engine);
    expect(drift.status).toBe('warn');
    const details = drift.details as { drift: Array<Record<string, unknown>>; incident: unknown };
    expect(details.incident).toEqual({ scope: 'current', since: null });
    const brain = details.drift.find(d => d.scope === 'brain')!;
    const principal = details.drift.find(d => String(d.scope).startsWith('principal:'))!;
    expect(brain).toMatchObject({ direction: 'overcharge', receipts_by_kind: { requests: { rows: 2 }, topology_changes: { rows: 0, bytes: 0 } } });
    expect((brain.receipts_by_kind as { requests: { bytes: number } }).requests.bytes).toBe(brain.receipts as number);
    expect(principal).toMatchObject({ direction: 'undercount', delta: -100, receipts_by_kind: { requests: { rows: 2 } } });
    expect(drift.message).toContain('bounded overcharge of 983040 bytes');
    expect(drift.message).toContain('no data is lost');
    expect(drift.message).toContain('under-counts by 100 bytes');
  }), 60_000);

  test('a consumer up past the window with no pass warns; a pass records what it freed and clears it; a stale record warns again', run(async engine => {
    const requests = await requestFixture(engine);
    const old = await requests.admit('old');
    await editRequest(engine, old.id, "state='committed',completed_at=now()-interval '60 days',published_at=now(),claim_expires_at=NULL");
    await engine.executeRaw('DELETE FROM persistence_effects WHERE request_id=$1::uuid', [old.id]);
    const host = randomUUID();
    await engine.executeRaw(`INSERT INTO persistence_consumers(host_id,pid,nonce,kind,mode,started_at,renewed_at,host_json_path,persistence_home,version)
      VALUES($1::uuid,1,'n','serve','full',now()-interval '30 hours',now(),'/tmp/example-host.json','/tmp/example-home','0.0.0')`, [host]);
    const overdue = await checkPersistenceCompaction(engine);
    expect(overdue).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'repair', 'receipt-compaction', '--json'] } });
    const record = await runCompactionPass(engine, { hostId: host });
    expect(record).toMatchObject({ compacted: 1, host_id: host });
    expect(record.freed_bytes).toBeGreaterThan(0);
    expect(await readLastCompaction(engine)).toMatchObject({ compacted: 1, freed_bytes: record.freed_bytes });
    expect(await checkPersistenceCompaction(engine)).toMatchObject({ status: 'ok' });
    expect(await checkPersistenceCounterDrift(engine)).toMatchObject({ status: 'ok' });
    await engine.setConfig(LAST_COMPACTION_KEY, JSON.stringify({ ...record, at: new Date(Date.now() - 30 * 3_600_000).toISOString() }));
    expect(await checkPersistenceCompaction(engine)).toMatchObject({ status: 'warn' });
    await engine.setConfig('persistence.maintenance.compaction_stale_hours', '48');
    expect(await checkPersistenceCompaction(engine)).toMatchObject({ status: 'ok', details: { stale_hours: 48 } });
  }), 60_000);
});
