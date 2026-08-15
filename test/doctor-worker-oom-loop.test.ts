// #1685 GAP A — worker_oom_loop doctor check.
//
// Hermetic: writes synthetic supervisor audit JSONL into a GBRAIN_AUDIT_DIR
// tempdir and drives computeWorkerOomLoopCheck with engine=null (supervised
// half + cap logic + thresholds; the minion_jobs bare-worker branch is
// Postgres-only and mirrors the queue_health subcheck-3 query covered by E2E).
// Also pins the cross-week supervisor reader (CODEX #7).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from './helpers/with-env.ts';
import { computeWorkerOomLoopCheck } from '../src/commands/doctor.ts';
import {
  computeSupervisorAuditFilename,
  readRecentSupervisorEvents,
} from '../src/core/minions/handlers/supervisor-audit.ts';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-oom-loop-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeSupervisorRows(rows: object[], fileDate = new Date()): void {
  const file = path.join(tmpDir, computeSupervisorAuditFilename(fileDate));
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const nowIso = () => new Date().toISOString();
const rssKill = () => ({ event: 'worker_exited', ts: nowIso(), likely_cause: 'rss_watchdog', code: 12 });
const breaker = (cap: number) => ({ event: 'health_warn', ts: nowIso(), reason: 'rss_watchdog_loop', max_rss_mb: cap });

describe('computeWorkerOomLoopCheck', () => {
  test('fail with breaker-stamped cap when the breaker tripped', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      writeSupervisorRows([rssKill(), rssKill(), rssKill(), rssKill(), rssKill(), rssKill(), breaker(2048)]);
      const c = await computeWorkerOomLoopCheck(null);
      expect(c?.status).toBe('fail');
      expect(c?.name).toBe('worker_oom_loop');
      expect(c?.message).toContain('cap=2048MB');
      expect(c?.message).toContain('raise --max-rss');
      expect(c?.details?.oom_kills).toBe(6);
      expect(c?.details?.supervisor_kills).toBe(6);
      expect(c?.details?.bare_worker_kills).toBe(0);
      expect(c?.details?.cap_source).toBe('breaker');
      expect(c?.details?.breaker_tripped).toBe(true);
    });
  });

  test('warn with auto-sized cap fallback when no breaker event stamped a cap (CODEX #6)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      writeSupervisorRows([rssKill(), rssKill()]);
      const c = await computeWorkerOomLoopCheck(null);
      expect(c?.status).toBe('warn');
      expect(c?.details?.cap_source).toBe('default');
      expect(c?.message).toContain('auto-sized default');
      expect(c?.details?.oom_kills).toBe(2);
    });
  });

  test('fail at >=5 kills even without a breaker event', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      writeSupervisorRows([rssKill(), rssKill(), rssKill(), rssKill(), rssKill()]);
      const c = await computeWorkerOomLoopCheck(null);
      expect(c?.status).toBe('fail');
      expect(c?.details?.breaker_tripped).toBe(false);
    });
  });

  test('null when the worker never OOM-looped', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      writeSupervisorRows([{ event: 'started', ts: nowIso() }]);
      expect(await computeWorkerOomLoopCheck(null)).toBeNull();
    });
  });

  test('null on an empty audit dir', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      expect(await computeWorkerOomLoopCheck(null)).toBeNull();
    });
  });
});

describe('readRecentSupervisorEvents — cross-week (CODEX #7)', () => {
  test('reads a within-24h event from the PREVIOUS ISO-week file', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // Event timestamped within the 24h window but written into last week's
      // file (the Monday-reads-Sunday case). The single-file reader would miss
      // it; the cross-week reader must find it.
      const prevWeekFileDate = new Date(Date.now() - 7 * 86400000);
      writeSupervisorRows([rssKill()], prevWeekFileDate);
      const events = readRecentSupervisorEvents(24);
      expect(events.length).toBe(1);
      expect(events[0].event).toBe('worker_exited');
    });
  });
});
