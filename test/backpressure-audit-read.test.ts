/**
 * readRecentCoalesceCounts — the `jobs stats` Backpressure line's data source.
 *
 * Pins the three spec points from the review (Codex F5):
 * 1. The 24h window reads the CURRENT and PREVIOUS ISO-week files — on the
 *    first day of an ISO week a one-file read silently under-counts.
 * 2. Counts are filtered to the requested queue.
 * 3. Best-effort: missing files and malformed lines are skipped, never thrown.
 *
 * Env discipline: GBRAIN_AUDIT_DIR is applied via withEnv() per test (rule
 * R1 — no bare process.env mutation in parallel test files).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { computeAuditFilename, readRecentCoalesceCounts } from '../src/core/minions/backpressure-audit.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-bp-audit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEvents(filename: string, events: Array<Record<string, unknown>>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

describe('readRecentCoalesceCounts', () => {
  test('counts per name within the window, filtered by queue; both event field shapes', async () => {
    const now = new Date('2026-08-14T12:00:00.000Z');
    const recent = (offsetMin: number) => new Date(now.getTime() - offsetMin * 60_000).toISOString();
    writeEvents(computeAuditFilename(now), [
      { ts: recent(10), queue: 'default', name: 'autopilot-cycle', pending_count: 1, max_pending: 1, decision: 'coalesced', returned_job_id: 1 },
      { ts: recent(20), queue: 'default', name: 'autopilot-cycle', pending_count: 1, max_pending: 1, decision: 'coalesced', returned_job_id: 1 },
      { ts: recent(30), queue: 'default', name: 'sync', waiting_count: 1, max_waiting: 1, decision: 'coalesced', returned_job_id: 2 },
      { ts: recent(40), queue: 'shell', name: 'autopilot-cycle', pending_count: 1, max_pending: 1, decision: 'coalesced', returned_job_id: 3 },
      { ts: recent(25 * 60), queue: 'default', name: 'autopilot-cycle', pending_count: 1, max_pending: 1, decision: 'coalesced', returned_job_id: 4 },
    ]);
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const counts = readRecentCoalesceCounts({ queue: 'default', windowMs: 24 * 3600_000, now });
      expect(counts.get('autopilot-cycle')?.count).toBe(2); // other-queue + >24h excluded
      expect(counts.get('sync')?.count).toBe(1);
      expect(counts.size).toBe(2);
      // Latest event wins the hint target: the 10-min-ago event (job 1) is
      // newer than the 20-min-ago one, and other-queue/out-of-window events
      // never contribute a target.
      expect(counts.get('autopilot-cycle')?.last_returned_job_id).toBe(1);
      expect(counts.get('sync')?.last_returned_job_id).toBe(2);
    });
  });

  test('24h window crossing an ISO-week boundary reads BOTH week files', async () => {
    // 2026-08-10 is a Monday: 06:00 Monday minus 24h lands in the previous
    // ISO week. Events split across the two files must both count.
    const now = new Date('2026-08-10T06:00:00.000Z');
    const currentFile = computeAuditFilename(now);
    const prevFile = computeAuditFilename(new Date(now.getTime() - 7 * 86400000));
    expect(prevFile).not.toBe(currentFile); // sanity: genuinely two files
    writeEvents(currentFile, [
      { ts: new Date(now.getTime() - 3600_000).toISOString(), queue: 'default', name: 'autopilot-cycle', decision: 'coalesced', returned_job_id: 1 },
    ]);
    writeEvents(prevFile, [
      // 20h ago = Sunday of the previous ISO week — inside the 24h window.
      { ts: new Date(now.getTime() - 20 * 3600_000).toISOString(), queue: 'default', name: 'autopilot-cycle', decision: 'coalesced', returned_job_id: 2 },
      // 30h ago — outside the window, same file.
      { ts: new Date(now.getTime() - 30 * 3600_000).toISOString(), queue: 'default', name: 'autopilot-cycle', decision: 'coalesced', returned_job_id: 3 },
    ]);
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      const counts = readRecentCoalesceCounts({ queue: 'default', windowMs: 24 * 3600_000, now });
      expect(counts.get('autopilot-cycle')?.count).toBe(2);
      // Latest in-window event (1h ago, current week, job 1) wins the target
      // over the older previous-week event (20h ago, job 2).
      expect(counts.get('autopilot-cycle')?.last_returned_job_id).toBe(1);
    });
  });

  test('missing files → empty map; malformed lines skipped', async () => {
    const now = new Date('2026-08-14T12:00:00.000Z');
    await withEnv({ GBRAIN_AUDIT_DIR: dir }, async () => {
      expect(readRecentCoalesceCounts({ queue: 'default', windowMs: 24 * 3600_000, now }).size).toBe(0);
      writeFileSync(join(dir, computeAuditFilename(now)),
        'not-json\n' +
        JSON.stringify({ ts: now.toISOString(), queue: 'default', name: 'ok', decision: 'coalesced', returned_job_id: 1 }) + '\n' +
        '{"truncated":\n', 'utf8');
      const counts = readRecentCoalesceCounts({ queue: 'default', windowMs: 24 * 3600_000, now });
      expect(counts.get('ok')?.count).toBe(1);
      expect(counts.size).toBe(1);
    });
  });
});
