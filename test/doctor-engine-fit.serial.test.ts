/**
 * Engine-fit doctor checks — the doctor half of the db-availability loop.
 *
 *   - dbRepairRecurrenceCheck: reads the db-repair receipts JSONL, engine-free.
 *     Only `outcome:'applied'` rows with the SAME reason for the SAME brain_id
 *     within 7 days count toward the threshold of 3. Pins: silent when no
 *     receipts / zero applied rows, warn on 3x same-reason recurrence, ok on
 *     mixed reasons, cross-brain rows never sum, out-of-window rows ignored.
 *   - pgliteScaleCheck: postgres engines are skipped, >=1000 pages warns with
 *     the migrate guidance, small brains report ok, stats failure → null.
 *
 * GBRAIN_HOME points at a fresh temp dir per test so the receipts file is
 * hermetic; rows are written through the real writeReceipt seam.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dbRepairRecurrenceCheck, pgliteScaleCheck, PGLITE_SCALE_PAGE_THRESHOLD } from '../src/commands/doctor/checks/engine-fit.ts';
import { writeReceipt, type RepairReceipt } from '../src/core/db-repair-receipts.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-engine-fit-'));
  process.env.GBRAIN_HOME = home;
  mkdirSync(join(home, '.gbrain'), { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function seed(overrides: Partial<RepairReceipt>): void {
  writeReceipt({
    ts: NOW - DAY, // comfortably inside the 7-day window
    brain_id: 'host',
    reason: 'conn_refused',
    action: 'bounded_reconnect',
    outcome: 'applied',
    ...overrides,
  });
}

describe('dbRepairRecurrenceCheck', () => {
  test('no receipts file → null (say nothing)', () => {
    expect(dbRepairRecurrenceCheck(NOW)).toBeNull();
  });

  test('3 applied same-reason same-brain rows in 7 days → warn naming the reason', () => {
    seed({ ts: NOW - 1 * DAY });
    seed({ ts: NOW - 2 * DAY });
    seed({ ts: NOW - 3 * DAY });
    const check = dbRepairRecurrenceCheck(NOW);
    expect(check).not.toBeNull();
    expect(check!.name).toBe('db_repair_recurrence');
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('conn_refused');
    expect(check!.message).toContain('3x');
    expect(check!.details).toEqual({ reason: 'conn_refused', applied_count: 3, window_days: 7 });
  });

  test('3 applied rows with MIXED reasons → ok (normal life, not a genesis problem)', () => {
    seed({ reason: 'conn_refused' });
    seed({ reason: 'conn_dropped' });
    seed({ reason: 'network_unreachable' });
    const check = dbRepairRecurrenceCheck(NOW);
    expect(check).not.toBeNull();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('none recurring');
  });

  test('3 same-reason rows but outcomes diagnose/refused → null (zero applied rows in window)', () => {
    seed({ outcome: 'diagnose' });
    seed({ outcome: 'refused' });
    seed({ outcome: 'diagnose' });
    expect(dbRepairRecurrenceCheck(NOW)).toBeNull();
  });

  test('rows from two brains (2 + 2 same reason) never sum toward one threshold → ok', () => {
    seed({ brain_id: 'host' });
    seed({ brain_id: 'host' });
    seed({ brain_id: 'team-brain' });
    seed({ brain_id: 'team-brain' });
    const check = dbRepairRecurrenceCheck(NOW);
    expect(check).not.toBeNull();
    expect(check!.status).toBe('ok');
  });

  test('an 8-day-old applied row is outside the window and does not count', () => {
    seed({ ts: NOW - 8 * DAY });
    seed({ ts: NOW - 1 * DAY });
    seed({ ts: NOW - 2 * DAY });
    const check = dbRepairRecurrenceCheck(NOW);
    expect(check).not.toBeNull();
    expect(check!.status).toBe('ok'); // only 2 in-window rows — below threshold
  });

  test("'undo' rows are excluded even when applied", () => {
    seed({ reason: 'undo', action: 'undo_last_rewrite' });
    seed({ reason: 'undo', action: 'undo_last_rewrite' });
    seed({ reason: 'undo', action: 'undo_last_rewrite' });
    expect(dbRepairRecurrenceCheck(NOW)).toBeNull();
  });
});

describe('pgliteScaleCheck', () => {
  test('postgres engine → null (check does not apply)', async () => {
    const engine = { kind: 'postgres' } as unknown as BrainEngine;
    expect(await pgliteScaleCheck(engine)).toBeNull();
  });

  test('pglite at 1500 pages → warn mentioning migrate --to supabase', async () => {
    const engine = { kind: 'pglite', getStats: async () => ({ page_count: 1500 }) } as unknown as BrainEngine;
    const check = await pgliteScaleCheck(engine);
    expect(check).not.toBeNull();
    expect(check!.name).toBe('pglite_scale');
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('1500');
    expect(check!.message).toContain('migrate --to supabase');
    expect(check!.message).toContain(String(PGLITE_SCALE_PAGE_THRESHOLD));
  });

  test('pglite at 10 pages → ok, comfortable below the threshold', async () => {
    const engine = { kind: 'pglite', getStats: async () => ({ page_count: 10 }) } as unknown as BrainEngine;
    const check = await pgliteScaleCheck(engine);
    expect(check).not.toBeNull();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('10 pages');
  });

  test('getStats throwing → null (other checks own that failure)', async () => {
    const engine = {
      kind: 'pglite',
      getStats: async () => { throw new Error('stats unavailable'); },
    } as unknown as BrainEngine;
    expect(await pgliteScaleCheck(engine)).toBeNull();
  });
});
