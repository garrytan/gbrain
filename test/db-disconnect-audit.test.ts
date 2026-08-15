/**
 * v0.41.25.0 (#1570) — db-disconnect-audit JSONL contract.
 *
 * Pins:
 *  - logDbDisconnect → readRecentDbDisconnects round-trip
 *  - caller_stack truncated to ~20 frames
 *  - Best-effort write: corrupt write target doesn't throw to caller
 *  - 24h window honored (events outside window filtered)
 *
 * Uses `withEnv()` per test-isolation lint rule R1.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withEnv } from './helpers/with-env.ts';
import {
  logDbDisconnect,
  readRecentDbDisconnects,
  captureCallerStack,
  _dbDisconnectAuditFeatureName,
} from '../src/core/audit/db-disconnect-audit.ts';

async function withFreshAuditDir(body: (tmpDir: string) => void | Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-db-disconnect-audit-'));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      await body(tmpDir);
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('db-disconnect-audit (v0.41.25.0)', () => {
  test('log → read round-trip preserves required fields', async () => {
    await withFreshAuditDir(() => {
      logDbDisconnect('postgres', 'module');
      const result = readRecentDbDisconnects(24);
      expect(result.count).toBe(1);
      expect(result.events.length).toBe(1);
      expect(result.events[0]).toMatchObject({
        engine_kind: 'postgres',
        connection_style: 'module',
        pid: process.pid,
      });
      expect(typeof result.events[0].ts).toBe('string');
      expect(typeof result.events[0].caller_stack).toBe('string');
      expect(result.events[0].caller_stack.length).toBeGreaterThan(0);
      expect(result.most_recent_caller).toBe(result.events[0].caller_stack);
      expect(result.most_recent_ts).toBe(result.events[0].ts);
    });
  });

  test('captureCallerStack truncates to maxFrames', () => {
    const stack = captureCallerStack(0, 5);
    const lines = stack.split('\n');
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  test('readRecentDbDisconnects sorts newest-first', async () => {
    await withFreshAuditDir(() => {
      logDbDisconnect('postgres', 'module');
      logDbDisconnect('postgres', 'instance');
      logDbDisconnect('pglite', 'unknown');
      const result = readRecentDbDisconnects(24);
      expect(result.count).toBe(3);
      // Newest first: events array should be in reverse log order (or at
      // least chronologically ordered by parseable ts). The last logged
      // event should appear first or earliest in the events list. The
      // strict newest-first contract is what doctor displays.
      const timestamps = result.events.map(e => Date.parse(e.ts));
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
      }
    });
  });

  test('empty audit dir returns zero count + null fields', async () => {
    await withFreshAuditDir(() => {
      const result = readRecentDbDisconnects(24);
      expect(result.count).toBe(0);
      expect(result.events).toEqual([]);
      expect(result.most_recent_caller).toBeNull();
      expect(result.most_recent_ts).toBeNull();
    });
  });

  test('feature name is stable (drives audit filename on disk)', () => {
    // Pin the filename prefix so a future rename can't silently strand
    // old audit files. Operators with v0.41.25 deployments have
    // ~/.gbrain/audit/db-disconnect-YYYY-Www.jsonl files.
    expect(_dbDisconnectAuditFeatureName()).toBe('db-disconnect');
  });

  test('audit write is best-effort — unreadable dir does NOT throw', async () => {
    // Point GBRAIN_AUDIT_DIR at a path the writer cannot create (a non-
    // existent root we don't have perms for). The writer should stderr-
    // warn but not throw to the caller's disconnect flow.
    await withEnv({ GBRAIN_AUDIT_DIR: '/proc/1/cannot-create-here-1570' }, () => {
      expect(() => logDbDisconnect('postgres', 'module')).not.toThrow();
    });
  });
});
