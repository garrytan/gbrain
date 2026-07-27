// v0.41.18.0 — batch-retry audit JSONL primitive.
//
// Hermetic: uses GBRAIN_AUDIT_DIR env override via the withEnv helper so
// the test never touches the user's ~/.gbrain/audit/. Each test gets a fresh
// tempdir via beforeEach so file-system state never leaks across cases.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from '../helpers/with-env.ts';
import {
  logBatchRetry,
  logBatchExhausted,
  readRecentBatchRetryEvents,
  pruneOldBatchRetryAuditFiles,
  BATCH_RETRY_FEATURE_NAME,
} from '../../src/core/audit/batch-retry-audit.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-retry-audit-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

describe('logBatchRetry — success-path emission', () => {
  test('writes JSONL row with outcome=success', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logBatchRetry('extract.links_inc', 100, 1, 1000, new Error('Connection terminated'));
      const result = readRecentBatchRetryEvents(24);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].site).toBe('extract.links_inc');
      expect(result.events[0].batch_size).toBe(100);
      expect(result.events[0].attempt).toBe(1);
      expect(result.events[0].outcome).toBe('success');
      expect(result.events[0].delay_ms).toBe(1000);
      expect(result.events[0].error_message_summary).toContain('Connection terminated');
    });
  });

  test('captures SQLSTATE code when present on error', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const err = Object.assign(new Error('connection failure'), { code: '08006' });
      logBatchRetry('extract.timeline_fs', 50, 2, 3000, err);
      const result = readRecentBatchRetryEvents(24);
      expect(result.events[0].error_code).toBe('08006');
    });
  });

  test('truncates long error messages to 200 chars', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const longMsg = 'A'.repeat(500);
      logBatchRetry('addLinksBatch', 100, 1, 1000, new Error(longMsg));
      const result = readRecentBatchRetryEvents(24);
      expect(result.events[0].error_message_summary.length).toBe(200);
    });
  });

  test('replaces newlines in error message (grep-friendly)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logBatchRetry('addLinksBatch', 100, 1, 1000, new Error('line1\nline2\tline3'));
      const result = readRecentBatchRetryEvents(24);
      expect(result.events[0].error_message_summary).toBe('line1 line2 line3');
    });
  });
});

describe('logBatchExhausted — exhausted-retry emission', () => {
  test('writes outcome=exhausted with total attempt count', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logBatchExhausted('mcp.put_page.autolink', 25, 4, new Error('Connection terminated'));
      const result = readRecentBatchRetryEvents(24);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].outcome).toBe('exhausted');
      expect(result.events[0].attempt).toBe(4);
      expect(result.events[0].site).toBe('mcp.put_page.autolink');
    });
  });
});

describe('readRecentBatchRetryEvents — windowing + corruption tolerance', () => {
  test('filters by hours-back cutoff', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // Write 3 events: one 25h ago (out of 24h window), one now, one 1h ago.
      const now = Date.now();
      const dir = tmpDir;
      // Use the writer to land in the correct ISO-week file.
      logBatchRetry('addLinksBatch', 1, 1, 100, new Error('a'));
      logBatchRetry('addLinksBatch', 2, 1, 100, new Error('b'));
      // Manually inject an old event by appending to the same file.
      const filename = `${BATCH_RETRY_FEATURE_NAME}-${new Date(now).getUTCFullYear()}-W${String(getIsoWeek(new Date(now))).padStart(2, '0')}.jsonl`;
      const filePath = path.join(dir, filename);
      const oldEvent = {
        ts: new Date(now - 25 * 3600_000).toISOString(),
        site: 'addLinksBatch',
        batch_size: 99,
        attempt: 1,
        outcome: 'success',
        delay_ms: 100,
        error_message_summary: 'old',
      };
      fs.appendFileSync(filePath, JSON.stringify(oldEvent) + '\n');

      const result = readRecentBatchRetryEvents(24);
      // Should see 2 recent events but NOT the 25h-old one.
      expect(result.events.length).toBeGreaterThanOrEqual(2);
      const oldFound = result.events.find(e => e.error_message_summary === 'old');
      expect(oldFound).toBeUndefined();
    });
  });

  test('counts corrupted JSONL lines without crashing', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // Write a valid event first to ensure the file exists.
      logBatchRetry('addLinksBatch', 1, 1, 100, new Error('valid'));
      const now = new Date();
      const filename = `${BATCH_RETRY_FEATURE_NAME}-${now.getUTCFullYear()}-W${String(getIsoWeek(now)).padStart(2, '0')}.jsonl`;
      const filePath = path.join(tmpDir, filename);
      // Append 3 corrupt lines.
      fs.appendFileSync(filePath, '{not json\n');
      fs.appendFileSync(filePath, 'still not json\n');
      fs.appendFileSync(filePath, '{"missing_close": true\n');

      const result = readRecentBatchRetryEvents(24);
      expect(result.events).toHaveLength(1); // the valid one
      expect(result.corrupted_lines).toBe(3);
    });
  });

  test('files_unreadable counts permission errors but ignores ENOENT', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // No files written; the only "missing" file is ENOENT which is expected.
      const result = readRecentBatchRetryEvents(24);
      expect(result.events).toHaveLength(0);
      expect(result.files_unreadable).toBe(0);
      expect(result.files_scanned).toBe(0);
    });
  });
});

describe('pruneOldBatchRetryAuditFiles — codex H-8 actual pruning', () => {
  test('deletes files older than daysToKeep', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // Create an old file (mtime 31 days ago).
      const oldFile = path.join(tmpDir, `${BATCH_RETRY_FEATURE_NAME}-2024-W01.jsonl`);
      fs.writeFileSync(oldFile, '{"ts":"2024-01-01T00:00:00Z"}\n');
      const oldTime = Date.now() - 31 * 86400_000;
      fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

      // Create a recent file (mtime now).
      const newFile = path.join(tmpDir, `${BATCH_RETRY_FEATURE_NAME}-2026-W22.jsonl`);
      fs.writeFileSync(newFile, '{"ts":"2026-05-26T00:00:00Z"}\n');

      const result = pruneOldBatchRetryAuditFiles(30);
      expect(result.removed).toBe(1);
      expect(result.kept).toBe(1);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(newFile)).toBe(true);
    });
  });

  test('ignores files that do not match the batch-retry-*.jsonl shape', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      // Other audit module's files should not be touched.
      const otherFile = path.join(tmpDir, 'shell-jobs-2024-W01.jsonl');
      fs.writeFileSync(otherFile, '{}\n');
      const oldTime = Date.now() - 31 * 86400_000;
      fs.utimesSync(otherFile, oldTime / 1000, oldTime / 1000);

      const result = pruneOldBatchRetryAuditFiles(30);
      expect(result.removed).toBe(0);
      expect(fs.existsSync(otherFile)).toBe(true);
    });
  });

  test('no-op when audit dir does not exist (ENOENT)', async () => {
    // Isolate GBRAIN_AUDIT_DIR at a guaranteed-nonexistent path (CLAUDE.md R1).
    // Pre-fix this called pruneOld with no override, so on a real dev machine it
    // walked ~/.gbrain/audit — which may already hold this-week's batch-retry
    // files from other (un-isolated) suites, making `kept` non-zero and the test
    // flaky. Pointing at a missing subdir makes the ENOENT path deterministic.
    const missing = path.join(tmpDir, 'does-not-exist');
    await withEnv({ GBRAIN_AUDIT_DIR: missing }, async () => {
      const result = pruneOldBatchRetryAuditFiles(30, new Date());
      // The function never throws on a missing dir; returns the empty result.
      expect(result).toEqual({ removed: 0, kept: 0 });
    });
  });
});

describe('privacy posture (codex review + CLAUDE.md privacy rule)', () => {
  test('audit row never contains slugs, page ids, or content', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logBatchRetry(
        'extract.links_inc',
        100,
        1,
        1000,
        new Error('insert failed for slug=people/alice page_id=42'),
      );
      const result = readRecentBatchRetryEvents(24);
      // The error message IS in the audit (necessary for debugging), but
      // schema fields don't carry slugs, IDs, or content separately. The
      // 200-char truncation prevents large blob leaks too.
      const row = result.events[0];
      // Verify the row shape — no slug, page_id, content, body fields.
      // error_code is optional (only present when error has SQLSTATE), so
      // the schema's closed set is these fields plus optional error_code.
      const keys = new Set(Object.keys(row));
      const requiredKeys = ['attempt', 'batch_size', 'delay_ms', 'error_message_summary', 'outcome', 'site', 'ts'];
      for (const k of requiredKeys) expect(keys.has(k)).toBe(true);
      // No leaky fields.
      for (const k of keys) {
        expect(['attempt', 'batch_size', 'delay_ms', 'error_code', 'error_message_summary', 'outcome', 'site', 'ts']).toContain(k);
      }
    });
  });
});

// Helper: ISO 8601 week number (matches the audit-writer.ts computation).
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
