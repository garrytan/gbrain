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
import { ARCHIVE_ENABLED_KEY, ARCHIVE_TIMEZONE_KEY } from '../src/core/transcripts/archive.ts';
import { readArchiveMaintenance, runArchiveMaintenance } from '../src/core/transcripts/archive-maintenance.ts';
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
