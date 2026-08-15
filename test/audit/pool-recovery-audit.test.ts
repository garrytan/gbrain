// #1685 GAP B — pool-recovery audit JSONL primitive.
//
// Hermetic: GBRAIN_AUDIT_DIR override via withEnv; fresh tempdir per test.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from '../helpers/with-env.ts';
import {
  logPoolRecovery,
  readRecentPoolRecoveries,
  _poolRecoveryAuditFeatureName,
} from '../../src/core/audit/pool-recovery-audit.ts';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-recovery-audit-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('logPoolRecovery + readRecentPoolRecoveries', () => {
  test('round-trips a reap → recovered pair into the right counters', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logPoolRecovery('reap_detected', Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' }));
      logPoolRecovery('reconnect_succeeded');
      const r = readRecentPoolRecoveries(1);
      expect(r.reaps).toBe(1);
      expect(r.recoveries).toBe(1);
      expect(r.failures).toBe(0);
      expect(r.others).toBe(0);
      expect(r.events).toHaveLength(2);
    });
  });

  test('counts a reap that failed to recover (the not-auto-recovering signal)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logPoolRecovery('reap_detected');
      logPoolRecovery('reconnect_failed', new Error('EHOSTUNREACH'));
      const r = readRecentPoolRecoveries(1);
      expect(r.reaps).toBe(1);
      expect(r.failures).toBe(1);
      expect(r.recoveries).toBe(0);
    });
  });

  test('reconnect_other is tracked separately from reaps', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logPoolRecovery('reconnect_other', new Error('network blip'));
      logPoolRecovery('reconnect_succeeded');
      const r = readRecentPoolRecoveries(1);
      expect(r.reaps).toBe(0);
      expect(r.others).toBe(1);
      expect(r.recoveries).toBe(1);
    });
  });

  test('redacts connection info from the error summary', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logPoolRecovery(
        'reconnect_failed',
        new Error('could not connect to postgres://user:secret@db.example.com:5432/app (192.168.1.42)'),
      );
      const r = readRecentPoolRecoveries(1);
      const summary = r.events[0].error_summary ?? '';
      expect(summary).not.toContain('secret');
      expect(summary).not.toContain('192.168.1.42');
      expect(summary).toContain('<REDACTED');
    });
  });

  test('empty dir → all-zero counters, no throw', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const r = readRecentPoolRecoveries(1);
      expect(r.reaps).toBe(0);
      expect(r.events).toEqual([]);
      expect(r.most_recent_ts).toBeNull();
    });
  });

  test('stable feature name', () => {
    expect(_poolRecoveryAuditFeatureName()).toBe('pool-recovery');
  });
});
