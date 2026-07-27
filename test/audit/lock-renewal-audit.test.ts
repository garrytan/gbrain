/**
 * v0.41.22.2 — lock-renewal audit JSONL primitive.
 *
 * Pins the contract for all 4 outcomes plus the privacy promise
 * (redactor wired into every error path). Hermetic via withEnv +
 * tempdir per test; no PGLite, no mocks.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from '../helpers/with-env.ts';
import {
  lockRenewalAudit,
  readRecentLockRenewalEvents,
  pruneOldLockRenewalAuditFiles,
  LOCK_RENEWAL_FEATURE_NAME,
} from '../../src/core/audit/lock-renewal-audit.ts';
import { computeIsoWeekFilename } from '../../src/core/audit/audit-writer.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-renewal-audit-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

describe('lockRenewalAudit: 4-outcome contract', () => {
  test('case 1 — logFailure writes outcome=failure with error_summary and error_code', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const err = Object.assign(new Error('Connection terminated'), { code: '08006' });
      lockRenewalAudit.logFailure(42, 'sync', 1, err);
      const result = readRecentLockRenewalEvents(24);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].outcome).toBe('failure');
      expect(result.events[0].job_id).toBe(42);
      expect(result.events[0].job_name).toBe('sync');
      expect(result.events[0].attempt).toBe(1);
      expect(result.events[0].error_message_summary).toContain('Connection terminated');
      expect(result.events[0].error_code).toBe('08006');
    });
  });

  test('case 2 — logSuccessAfterFailure writes outcome with attempt=recovery count, no error fields', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      lockRenewalAudit.logSuccessAfterFailure(99, 'embed', 3);
      const result = readRecentLockRenewalEvents(24);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].outcome).toBe('success_after_failure');
      expect(result.events[0].job_id).toBe(99);
      expect(result.events[0].job_name).toBe('embed');
      expect(result.events[0].attempt).toBe(3);
      expect(result.events[0].error_message_summary).toBeUndefined();
      expect(result.events[0].error_code).toBeUndefined();
    });
  });

  test('case 3 — logGaveUp writes outcome=gave_up with full error context', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const err = Object.assign(new Error('renewLock timed out after 10000ms'), { code: 'TIMEOUT' });
      lockRenewalAudit.logGaveUp(777, 'subagent', 5, err);
      const result = readRecentLockRenewalEvents(24);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].outcome).toBe('gave_up');
      expect(result.events[0].attempt).toBe(5);
      expect(result.events[0].error_message_summary).toContain('renewLock timed out');
    });
  });

  test('case 4 — logExecuteJobRejected writes outcome with no attempt field', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      lockRenewalAudit.logExecuteJobRejected(123, 'shell', new Error('failJob threw during outage'));
      const result = readRecentLockRenewalEvents(24);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].outcome).toBe('executeJob_rejected');
      expect(result.events[0].attempt).toBeUndefined();
      expect(result.events[0].error_message_summary).toContain('failJob threw');
    });
  });
});

describe('lockRenewalAudit: privacy via redactor (D9)', () => {
  test('case 5a — logFailure with PG connection-failure error: no DSN/IP in JSONL', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const err = new Error(
        'connection failed: postgres://garry:hunter2@db.example.com:5432/gbrain (192.168.1.42)',
      );
      lockRenewalAudit.logFailure(1, 'sync', 1, err);
      // Read raw JSONL — covers the wire format an operator would
      // actually paste into a GitHub issue.
      const file = path.join(tmpDir, computeIsoWeekFilename(LOCK_RENEWAL_FEATURE_NAME));
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).not.toContain('hunter2');
      expect(raw).not.toContain('192.168.1.42');
      expect(raw).not.toContain('postgres://garry');
      expect(raw).toContain('<REDACTED:pg_url>');
      expect(raw).toContain('<REDACTED:ipv4>');
    });
  });

  test('case 5b — logGaveUp redacts password=secret form', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const err = new Error('FATAL: password=hunter2 authentication failed');
      lockRenewalAudit.logGaveUp(1, 'sync', 3, err);
      const file = path.join(tmpDir, computeIsoWeekFilename(LOCK_RENEWAL_FEATURE_NAME));
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).not.toContain('hunter2');
      expect(raw).toContain('<REDACTED:password>');
    });
  });
});

describe('lockRenewalAudit: readback semantics', () => {
  test('case 6 — readRecentLockRenewalEvents applies hours cutoff', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      lockRenewalAudit.logFailure(1, 'sync', 1, new Error('blip 1'));
      // 48h ago event is older than 24h cutoff and should be filtered.
      const file = path.join(tmpDir, computeIsoWeekFilename(LOCK_RENEWAL_FEATURE_NAME));
      const stale = JSON.stringify({
        ts: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        job_id: 99,
        job_name: 'old',
        attempt: 1,
        outcome: 'failure',
      });
      fs.appendFileSync(file, stale + '\n');
      const result = readRecentLockRenewalEvents(24);
      // Only the recent event should appear; stale 48h-old event filtered.
      expect(result.events).toHaveLength(1);
      expect(result.events[0].job_id).toBe(1);
    });
  });

  test('case 7 — corrupted JSONL line increments corrupted_lines, doesn\'t throw', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const file = path.join(tmpDir, computeIsoWeekFilename(LOCK_RENEWAL_FEATURE_NAME));
      // Mix valid + invalid JSONL.
      lockRenewalAudit.logFailure(1, 'sync', 1, new Error('valid'));
      fs.appendFileSync(file, 'this is not json\n');
      fs.appendFileSync(file, '{"partial":\n');
      const result = readRecentLockRenewalEvents(24);
      expect(result.events).toHaveLength(1);
      expect(result.corrupted_lines).toBe(2);
    });
  });

  test('case 7b — readback with no audit dir returns empty + zero file counts', async () => {
    // tmpDir for GBRAIN_AUDIT_DIR points at an empty dir; no audit
    // files exist, but the dir itself exists. Both ENOENT files
    // counted as "scanned: 0, unreadable: 0".
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const result = readRecentLockRenewalEvents(24);
      expect(result.events).toHaveLength(0);
      expect(result.corrupted_lines).toBe(0);
      expect(result.files_scanned).toBe(0);
      expect(result.files_unreadable).toBe(0);
    });
  });
});

describe('lockRenewalAudit: pruning', () => {
  test('case 8 — pruneOldLockRenewalAuditFiles deletes files older than daysToKeep', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // Create an old file by writing then back-dating.
      const oldName = `${LOCK_RENEWAL_FEATURE_NAME}-2024-W01.jsonl`;
      const oldFile = path.join(tmpDir, oldName);
      fs.writeFileSync(oldFile, '{"ts":"2024-01-01T00:00:00Z","job_id":1,"job_name":"x","outcome":"failure"}\n');
      const ancientMs = Date.now() - 60 * 86400_000; // 60 days ago
      fs.utimesSync(oldFile, ancientMs / 1000, ancientMs / 1000);

      // Recent file should be kept.
      lockRenewalAudit.logFailure(1, 'sync', 1, new Error('recent'));

      const result = pruneOldLockRenewalAuditFiles(30);
      expect(result.removed).toBe(1);
      expect(result.kept).toBe(1);
      expect(fs.existsSync(oldFile)).toBe(false);
    });
  });

  test('case 8b — pruning a non-existent dir is a graceful no-op', async () => {
    const ghostDir = path.join(tmpDir, 'does-not-exist');
    await withEnv({ GBRAIN_AUDIT_DIR: ghostDir }, async () => {
      const result = pruneOldLockRenewalAuditFiles(30);
      expect(result.removed).toBe(0);
      expect(result.kept).toBe(0);
    });
  });
});
