/**
 * `jobs stats` Backpressure (24h) line + suppression hint — WIRING test.
 *
 * readRecentCoalesceCounts (the data source) is pinned in
 * test/backpressure-audit-read.test.ts; this file covers the stats-case
 * composition the coverage audit flagged as the remaining gap:
 *   1. the "Backpressure (24h)" line renders per-name counts for the queue
 *   2. the suppression hint fires when waiting=0 AND a live-lock active row
 *      is older than the shared wedge threshold, naming the job id
 *   3. no audit events → no Backpressure line (omission path)
 *
 * Serial: mutates GBRAIN_AUDIT_DIR + GBRAIN_WEDGED_QUEUE_WARN_MINUTES via
 * withEnv around the runJobs call and captures console.log.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { computeAuditFilename } from '../src/core/minions/backpressure-audit.ts';
import { runJobs } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

async function captureStats(auditDir: string): Promise<string> {
  const origLog = console.log;
  let out = '';
  console.log = (...args: unknown[]) => { out += args.map(String).join(' ') + '\n'; };
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir, GBRAIN_WEDGED_QUEUE_WARN_MINUTES: '15' }, async () => {
      await runJobs(engine, ['stats']);
    });
  } finally {
    console.log = origLog;
  }
  return out;
}

describe('jobs stats — Backpressure line + suppression hint wiring', () => {
  test('renders per-name counts and the suppressed-by hint for a stale live-lock active with zero waiting', async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
    // One ACTIVE autopilot-cycle with a LIVE lock, 30 minutes in (> 15m
    // threshold), zero waiting rows — the exact post-maxPending suppression
    // shape that used to be invisible to the waiting>0 wedge detectors.
    const job = await queue.add('autopilot-cycle', {});
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'active', lock_token = 'live-worker',
              lock_until = now() + interval '5 minutes',
              started_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [job.id],
    );
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-stats-bp-'));
    try {
      mkdirSync(auditDir, { recursive: true });
      writeFileSync(join(auditDir, computeAuditFilename()),
        JSON.stringify({
          ts: new Date().toISOString(), queue: 'default', name: 'autopilot-cycle',
          pending_count: 1, max_pending: 1, decision: 'coalesced', returned_job_id: job.id,
        }) + '\n', 'utf8');

      const out = await captureStats(auditDir);

      expect(out).toContain('Backpressure (24h)');
      expect(out).toContain('autopilot-cycle: 1');
      expect(out).toContain(`dispatch suppressed by in-flight job #${job.id}`);
      expect(out).toContain(`gbrain jobs get ${job.id}`);
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('no audit events → Backpressure line omitted entirely', async () => {
    await engine.executeRaw('DELETE FROM minion_jobs');
    const emptyDir = mkdtempSync(join(tmpdir(), 'gbrain-stats-bp-empty-'));
    try {
      const out = await captureStats(emptyDir);
      expect(out).not.toContain('Backpressure (24h)');
      expect(out).not.toContain('dispatch suppressed');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 30_000);
});
