/**
 * The Postgres hot-check golden's fence trend day (test/e2e/doctor-hot-checks-golden.test.ts)
 * against a recorded run shifted to another day, without a database: a golden
 * that pins the capture day (2026-10-10) fails on any other day; `stampSyncDay`
 * accepts the run only when every trend day is the day the sync stamped and
 * that day is one of the days read around the sync, and it touches no other field.
 * The soak counters' day gets the same treatment from `stampSoakDays`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOAK_DAY, stampSoakDays, stampSyncDay, SYNC_DAY } from './helpers/doctor-hot-checks-fixture.ts';

type Check = { name: string; message?: string; details?: { trend?: Array<{ by_day?: Array<{ day: string }> }> } };
type Report = { checks: Check[] };
const golden = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/goldens/doctor/hot-checks-postgres-json.json'), 'utf8')) as { golden: { first: { report: Report } } }).golden.first.report;

/** The recorded report with its fence trend day set to `day` (a run on that day). */
const runOn = (day: string): Report => JSON.parse(JSON.stringify(golden).replaceAll(`"day":"${SYNC_DAY}"`, `"day":"${day}"`)) as Report;
/** The recorded report with its soak counter day set to `day`. */
const soakOn = (day: string): Report => JSON.parse(JSON.stringify(golden).replaceAll(`"day":"${SOAK_DAY}"`, `"day":"${day}"`)) as Report;
const soakDays = (report: Report) => report.checks.filter(c => c.name === 'sync_soak_counters').flatMap(c => (c.details as { by_day?: Array<{ day: string }> } | undefined)?.by_day ?? []).map(d => d.day);
const trendDays = (report: Report) => report.checks.filter(c => c.name === 'fence_integrity').flatMap(c => c.details?.trend ?? []).flatMap(t => t.by_day ?? []).map(d => d.day);

describe('Postgres hot-check golden: the fence trend day', () => {
  test('the recorded run carries trend days to check', () => {
    expect(trendDays(golden)).toEqual([SYNC_DAY]);
  });

  test('a golden pinned to the capture day fails on another day; the sync-day check passes', () => {
    const pinned = runOn('2026-10-10');
    const later = runOn('2026-11-20');
    expect(later).not.toEqual(pinned);
    expect(stampSyncDay(later, '2026-11-20', ['2026-11-20', '2026-11-20'])).toEqual(golden);
  });

  test('a sync across midnight UTC accepts only the day it stamped, and only if it is one of the two', () => {
    expect(stampSyncDay(runOn('2026-11-21'), '2026-11-21', ['2026-11-20', '2026-11-21'])).toEqual(golden);
    expect(stampSyncDay(runOn('2026-11-20'), '2026-11-20', ['2026-11-20', '2026-11-21'])).toEqual(golden);
    expect(() => stampSyncDay(runOn('2026-11-22'), '2026-11-22', ['2026-11-20', '2026-11-21'])).toThrow('neither the day before');
  });

  test('a trend day other than the stamped one fails', () => {
    expect(() => stampSyncDay(runOn('2026-11-19'), '2026-11-20', ['2026-11-20', '2026-11-20'])).toThrow('not the day the fixture sync stamped');
  });

  test('only the trend day is replaced: other date-like drift still differs', () => {
    const drifted = runOn('2026-11-20');
    const other = drifted.checks.find(c => c.name !== 'fence_integrity' && typeof c.message === 'string')!;
    other.message = `${other.message} 2026-11-20`;
    expect(stampSyncDay(drifted, '2026-11-20', ['2026-11-20', '2026-11-20'])).not.toEqual(golden);
  });
});

describe('Postgres hot-check golden: the soak counter day', () => {
  test('the recorded run carries a soak day to check', () => {
    expect(soakDays(golden)).toEqual([SOAK_DAY]);
  });

  test('a run on any day passes when that day was recorded; an unrecorded day fails', () => {
    expect(soakOn('2026-10-16')).not.toEqual(soakOn('2026-10-17'));
    expect(stampSoakDays(soakOn('2026-10-17'), ['2026-10-17'])).toEqual(golden);
    expect(stampSoakDays(soakOn('2026-10-16'), ['2026-10-16', '2026-10-17'])).toEqual(golden);
    expect(() => stampSoakDays(soakOn('2026-10-17'), ['2026-10-16'])).toThrow('not a day the fixture recorded soak counters');
  });

  test('only the soak day is replaced: the fence trend day is left to its own check', () => {
    const both = JSON.parse(JSON.stringify(runOn('2026-11-20')).replaceAll(`"day":"${SOAK_DAY}"`, '"day":"2026-10-17"')) as Report;
    expect(stampSoakDays(both, ['2026-10-17'])).not.toEqual(golden);
    expect(stampSyncDay(stampSoakDays(both, ['2026-10-17']), '2026-11-20', ['2026-11-20', '2026-11-20'])).toEqual(golden);
  });
});
