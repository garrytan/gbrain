// v0.41.18.0 — batch_retry_health doctor check (codex H-9 thresholds).
//
// Hermetic: never touches a real engine. Stubs the audit-writer read by
// pointing GBRAIN_AUDIT_DIR at a tempdir and writing synthetic events.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from './helpers/with-env.ts';
import { checkBatchRetryHealth } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { BATCH_RETRY_FEATURE_NAME } from '../src/core/audit/batch-retry-audit.ts';

// Minimal stub engine — checkBatchRetryHealth doesn't use it (the audit
// read is via filesystem). Cast suppresses BrainEngine's many required
// methods we don't need here.
const stubEngine = {} as BrainEngine;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-batch-retry-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

function writeEvent(now: Date, event: Record<string, unknown>) {
  const filename = `${BATCH_RETRY_FEATURE_NAME}-${now.getUTCFullYear()}-W${String(getIsoWeek(now)).padStart(2, '0')}.jsonl`;
  const filePath = path.join(tmpDir, filename);
  fs.appendFileSync(filePath, JSON.stringify({ ts: now.toISOString(), ...event }) + '\n');
}

describe('checkBatchRetryHealth — ok states', () => {
  test('no events in window = ok', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const check = await checkBatchRetryHealth(stubEngine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('No exhausted batch retries');
    });
  });

  test('only successful retries = ok with recovery count', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const now = new Date();
      writeEvent(now, { site: 'extract.links_inc', batch_size: 100, attempt: 1, outcome: 'success', delay_ms: 1000, error_message_summary: 'blip' });
      writeEvent(now, { site: 'extract.links_inc', batch_size: 100, attempt: 2, outcome: 'success', delay_ms: 3000, error_message_summary: 'blip' });
      const check = await checkBatchRetryHealth(stubEngine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('transient retry');
    });
  });

  test('1-2 exhausted from same site (under per-site threshold of 3) = ok', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const now = new Date();
      writeEvent(now, { site: 'extract.links_inc', batch_size: 100, attempt: 4, outcome: 'exhausted', delay_ms: 0, error_message_summary: 'breaker' });
      writeEvent(now, { site: 'extract.links_inc', batch_size: 100, attempt: 4, outcome: 'exhausted', delay_ms: 0, error_message_summary: 'breaker' });
      const check = await checkBatchRetryHealth(stubEngine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('below per-site threshold');
    });
  });
});

describe('checkBatchRetryHealth — warn states (codex H-9 thresholds)', () => {
  test('>=3 exhausted from same site in 24h = warn', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const now = new Date();
      for (let i = 0; i < 3; i++) {
        writeEvent(now, { site: 'extract.links_inc', batch_size: 100, attempt: 4, outcome: 'exhausted', delay_ms: 0, error_message_summary: 'breaker' });
      }
      const check = await checkBatchRetryHealth(stubEngine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('extract.links_inc');
      expect(check.message).toContain('GBRAIN_BULK_MAX_RETRIES');
    });
  });

  test('>=5 cross-site exhausted in 24h = warn', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const now = new Date();
      // 2 from one site, 2 from another, 1 from a third = 5 total, none >=3 per site.
      writeEvent(now, { site: 'extract.links_inc', batch_size: 100, attempt: 4, outcome: 'exhausted', delay_ms: 0, error_message_summary: 'a' });
      writeEvent(now, { site: 'extract.links_inc', batch_size: 100, attempt: 4, outcome: 'exhausted', delay_ms: 0, error_message_summary: 'a' });
      writeEvent(now, { site: 'extract.timeline_fs', batch_size: 50, attempt: 4, outcome: 'exhausted', delay_ms: 0, error_message_summary: 'a' });
      writeEvent(now, { site: 'extract.timeline_fs', batch_size: 50, attempt: 4, outcome: 'exhausted', delay_ms: 0, error_message_summary: 'a' });
      writeEvent(now, { site: 'mcp.put_page.autolink', batch_size: 25, attempt: 4, outcome: 'exhausted', delay_ms: 0, error_message_summary: 'a' });
      const check = await checkBatchRetryHealth(stubEngine);
      expect(check.status).toBe('warn');
    });
  });
});

describe('checkBatchRetryHealth — fail state', () => {
  test('>=20 exhausted in 24h = fail (sustained breaker)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const now = new Date();
      for (let i = 0; i < 20; i++) {
        writeEvent(now, { site: 'extract.links_inc', batch_size: 100, attempt: 4, outcome: 'exhausted', delay_ms: 0, error_message_summary: 'breaker' });
      }
      const check = await checkBatchRetryHealth(stubEngine);
      expect(check.status).toBe('fail');
      expect(check.message).toContain('Sustained circuit-breaker');
    });
  });
});

describe('checkBatchRetryHealth — codex M-10 env validation at doctor time', () => {
  test('invalid GBRAIN_BULK_MAX_RETRIES surfaces at doctor time with paste-ready hint', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir, GBRAIN_BULK_MAX_RETRIES: '-1' }, async () => {
      const check = await checkBatchRetryHealth(stubEngine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('GBRAIN_BULK_*');
      expect(check.message).toContain('export GBRAIN_BULK_MAX_RETRIES');
    });
  });

  test('valid GBRAIN_BULK_MAX_RETRIES=0 (debug-mode disable) is accepted', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir, GBRAIN_BULK_MAX_RETRIES: '0' }, async () => {
      const check = await checkBatchRetryHealth(stubEngine);
      expect(check.status).toBe('ok'); // 0 retries is valid; no exhausted events either
    });
  });
});

describe('checkBatchRetryHealth — codex H-9 corruption tolerance', () => {
  test('corrupted JSONL lines are counted, not crashed-on', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const now = new Date();
      writeEvent(now, { site: 'extract.links_inc', batch_size: 100, attempt: 1, outcome: 'success', delay_ms: 1000, error_message_summary: 'a' });
      const filename = `${BATCH_RETRY_FEATURE_NAME}-${now.getUTCFullYear()}-W${String(getIsoWeek(now)).padStart(2, '0')}.jsonl`;
      const filePath = path.join(tmpDir, filename);
      fs.appendFileSync(filePath, '{not json}\nstill not\n');
      const check = await checkBatchRetryHealth(stubEngine);
      // Successful retry only, no exhausted events = ok. The corrupt count
      // appears in the message as a note.
      expect(check.status).toBe('ok');
      expect(check.message).toContain('corrupt JSONL');
    });
  });
});

function getIsoWeek(d: Date): number {
  const target = new Date(d.valueOf());
  const dayNumber = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}
