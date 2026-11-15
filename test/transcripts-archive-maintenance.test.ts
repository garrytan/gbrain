/**
 * GST-2768 PR 3: the conversation archive runs from the existing maintenance pass. Unattended upkeep (the serve's
 * idle tick, gbrain maintain --unattended, the schedule) runs the archive step when the archive resolves on, skips it
 * when it resolves off, and records an archive error without failing the pass; doctor reads the record. PGLite,
 * repo-less, synthetic sessions only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { CycleReport } from '../src/core/cycle.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_ENABLED_KEY, ARCHIVE_TIMEZONE_KEY, type ArchiveReader } from '../src/core/transcripts/archive.ts';
import { ARCHIVE_MAINTENANCE_BUDGET_MS, readArchiveMaintenance, runArchiveMaintenance } from '../src/core/transcripts/archive-maintenance.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runUnattendedMaintenance, type SafePhaseProviders } from '../src/core/maintenance/run.ts';
import { archivedPages, conversation, staticReader } from './helpers/transcript-archive.ts';

const KEYLESS: SafePhaseProviders = { embedding: false, decideConflict: false, fenceRepairModel: false, contentRepairModel: false };
const NOW = new Date('2026-11-10T09:00:00Z');
const cycle = (async () => ({ schema_version: '1', timestamp: NOW.toISOString(), brain_dir: null, status: 'ok', duration_ms: 0, phases: [], totals: {} }) as unknown as CycleReport) as never;
const readers = () => [staticReader('codex', [conversation('codex', 'codex-session-maint', [['user', '2026-11-10T08:00:00.000Z', 'maintenance hello']])])];

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

let schemaVersion: string | null = null;

beforeEach(async () => {
  schemaVersion ??= await engine.getConfig('version');
  await resetPgliteState(engine);
  if (schemaVersion) await engine.setConfig('version', schemaVersion);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
});

describe('the archive step of unattended upkeep', () => {
  test('runs the archive when it resolves on (a personal brain, switch unset)', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const outcome = await runUnattendedMaintenance(engine, {
      runner: 'test', now: () => NOW, providers: KEYLESS, cycle,
      archive: (e, o) => runArchiveMaintenance(e, { ...o, readers: readers() }),
    });
    expect(outcome.exit).toBe(0);
    expect(outcome.record!.steps.find(s => s.name === 'transcript_archive')).toMatchObject({ status: 'ok', scope: 'global' });
    expect((await archivedPages(engine)).some(p => p.slug.startsWith('conversations/codex/2026-11-10/'))).toBe(true);
    const record = await readArchiveMaintenance(engine);
    expect(record).toMatchObject({ runner: 'test', status: 'ok', written: 1 });
  }, 60_000);

  test('skips it when the archive resolves off, and writes nothing', async () => {
    await engine.setConfig('brain.audience', 'personal');
    await engine.setConfig(ARCHIVE_ENABLED_KEY, 'false');
    let called = 0;
    const outcome = await runUnattendedMaintenance(engine, {
      runner: 'test', now: () => NOW, providers: KEYLESS, cycle,
      archive: async (e, o) => { called++; return runArchiveMaintenance(e, { ...o, readers: readers() }); },
    });
    expect(outcome.exit).toBe(0);
    expect(called).toBe(0);
    expect(outcome.record!.steps.some(s => s.name === 'transcript_archive')).toBe(false);
    expect(await archivedPages(engine)).toEqual([]);
    expect(await readArchiveMaintenance(engine)).toBeNull();
  }, 60_000);

  test('a shared brain with the switch unset is never archived by the pass', async () => {
    await engine.setConfig('brain.audience', 'shared');
    const outcome = await runArchiveMaintenance(engine, { runner: 'test', now: NOW, readers: readers() });
    expect(outcome).toMatchObject({ status: 'skipped', code: 'archive_off' });
    expect(await archivedPages(engine)).toEqual([]);
  }, 60_000);

  test('an archive error is recorded and shown, and never fails the pass', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const outcome = await runUnattendedMaintenance(engine, {
      runner: 'test', now: () => NOW, providers: KEYLESS, cycle,
      archive: (e, o) => runArchiveMaintenance(e, { ...o, readers: readers(), run: async () => { throw Object.assign(new Error('synthetic archive failure'), { code: 'archive_reader_failed' }); } }),
    });
    expect(outcome.exit).toBe(0);
    expect(outcome.record!.status).toBe('ok');
    expect(outcome.record!.steps.find(s => s.name === 'transcript_archive')).toMatchObject({ status: 'warn', code: 'archive_reader_failed' });
    const record = await readArchiveMaintenance(engine);
    expect(record).toMatchObject({ status: 'failed', code: 'archive_reader_failed' });
    expect(record!.errors[0]!.message).toContain('synthetic archive failure');
  }, 60_000);

  test('a second pass inside transcripts.archive.maintenance_floor_min is not due', async () => {
    await engine.setConfig('brain.audience', 'personal');
    expect((await runArchiveMaintenance(engine, { runner: 'test', now: NOW, readers: readers() })).status).toBe('ran');
    expect((await runArchiveMaintenance(engine, { runner: 'test', now: new Date(NOW.getTime() + 60_000), readers: readers() })).status).toBe('not_due');
  }, 60_000);
});

describe('one pass is bounded by a count and a time limit', () => {
  test('a backfill run archives at most transcripts.archive.backfill_days_per_run older days', async () => {
    await engine.setConfig('brain.audience', 'personal');
    await engine.setConfig('transcripts.archive.backfill_days_per_run', '2');
    const old = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((day, i) => conversation('codex', 'codex-old-' + i, [['user', day + 'T08:00:00.000Z', 'old day ' + day]]));
    const outcome = await runArchiveMaintenance(engine, { runner: 'test', now: NOW, readers: [staticReader('codex', old)] });
    expect(outcome.record!.backfill).toMatchObject({ written: 2, deferred: 3, done: false });
  }, 60_000);

  test('a pass stops starting conversations at its time budget (ARCHIVE_MAINTENANCE_BUDGET_MS) and leaves the rest for the next pass', async () => {
    await engine.setConfig('brain.audience', 'personal');
    expect(ARCHIVE_MAINTENANCE_BUDGET_MS).toBe(120_000);
    const slow: ArchiveReader = {
      harness: 'codex', name: 'codex-slow',
      async *scan(opts) {
        for (let i = 0; i < 10; i++) {
          const conv = conversation('codex', 'codex-slow-' + i, [['user', '2026-11-10T08:0' + i + ':00.000Z', 'slow conversation ' + i]]);
          yield { harness: 'codex', conversationKey: conv.conversationKey, sessionId: conv.conversationKey, days: [opts.dayOf('2026-11-10T08:00:00.000Z')],
            load: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return conv; } };
        }
      },
    };
    const outcome = await runArchiveMaintenance(engine, { runner: 'test', now: NOW, readers: [slow], budgetMs: 150 });
    expect(outcome.record!.stopped_at_deadline).toBe(true);
    expect(outcome.record!.written).toBeGreaterThan(0);
    expect(outcome.record!.written).toBeLessThan(10);
    expect(outcome.record!.backfill).toBeUndefined();
  }, 60_000);
});

describe('run refusals are recorded, retryable skips that never fail the pass', () => {
  test('archive_run_busy: another run holds the source; the pass records a skip and the next pass archives', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const held = await tryAcquireDbLock(engine, 'transcripts-archive:conversations', 5);
    expect(held).not.toBeNull();
    let outcome;
    try { outcome = await runArchiveMaintenance(engine, { runner: 'test', now: NOW, readers: readers() }); } finally { await held!.release(); }
    expect(outcome).toMatchObject({ status: 'skipped', code: 'archive_run_busy' });
    expect(await readArchiveMaintenance(engine)).toMatchObject({ status: 'skipped', code: 'archive_run_busy' });
    const upkeep = await runUnattendedMaintenance(engine, { runner: 'test', now: () => NOW, providers: KEYLESS, cycle,
      archive: (e, o) => runArchiveMaintenance(e, { ...o, readers: readers() }) });
    expect(upkeep.exit).toBe(0);
    expect(upkeep.record!.steps.find(s => s.name === 'transcript_archive')).toMatchObject({ status: 'ok' });
    expect(await readArchiveMaintenance(engine)).toMatchObject({ status: 'ok', written: 1 });
  }, 60_000);

  test('archive_audience_unproven: the audience read failed; the pass records a skip, writes nothing and the upkeep step is not a failure', async () => {
    await engine.setConfig('brain.audience', 'personal');
    const failing = new Proxy(engine, { get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
      return (sql: string, params?: unknown[]) => /mcp_request_log/.test(sql) ? Promise.reject(new Error('synthetic usage read failure')) : target.executeRaw(sql, params);
    } }) as unknown as BrainEngine;
    await engine.executeRaw('DELETE FROM config WHERE key = $1', ['brain.audience']);
    const outcome = await runArchiveMaintenance(failing, { runner: 'test', now: NOW, readers: readers() });
    expect(outcome).toMatchObject({ status: 'skipped', code: 'archive_audience_unproven' });
    expect(await readArchiveMaintenance(engine)).toMatchObject({ status: 'skipped', code: 'archive_audience_unproven', written: 0 });
    expect(await archivedPages(engine)).toEqual([]);
  }, 60_000);
});
