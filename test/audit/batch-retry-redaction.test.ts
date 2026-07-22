/**
 * v0.41.22.2 — batch-retry-audit privacy backfill regression.
 *
 * Pins that `redactConnectionInfo` is wired into `logBatchRetry` and
 * `logBatchExhausted` (D9 privacy backfill). A future refactor that
 * removes the redactor call from `summarizeError` would silently
 * reintroduce the DSN/host/password leak class. This test catches that
 * via wire-format inspection.
 *
 * Hermetic via withEnv + tempdir per test.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from '../helpers/with-env.ts';
import {
  logBatchRetry,
  logBatchExhausted,
  BATCH_RETRY_FEATURE_NAME,
} from '../../src/core/audit/batch-retry-audit.ts';
import { computeIsoWeekFilename } from '../../src/core/audit/audit-writer.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-retry-redact-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

describe('batch-retry-audit privacy backfill (D9)', () => {
  test('case 1 — logBatchRetry: PG connection-failure error has no DSN/IP/password in JSONL', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const err = new Error(
        'PG retry context: postgres://garry:hunter2@db.example.com:5432/gbrain failed (192.168.1.42)',
      );
      logBatchRetry('addLinksBatch', 100, 1, 1000, err);
      const file = path.join(tmpDir, computeIsoWeekFilename(BATCH_RETRY_FEATURE_NAME));
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).not.toContain('hunter2');
      expect(raw).not.toContain('192.168.1.42');
      expect(raw).not.toContain('postgres://garry');
      expect(raw).toContain('<REDACTED:pg_url>');
      expect(raw).toContain('<REDACTED:ipv4>');
    });
  });

  test('case 2 — logBatchExhausted: same privacy contract on the exhausted path', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const err = new Error('FATAL: password=hunter2 authentication failed for user=postgres');
      logBatchExhausted('addTimelineEntriesBatch', 50, 4, err);
      const file = path.join(tmpDir, computeIsoWeekFilename(BATCH_RETRY_FEATURE_NAME));
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).not.toContain('hunter2');
      expect(raw).toContain('<REDACTED:password>');
      expect(raw).toContain('<REDACTED:user>');
    });
  });

  test('case 3 — plain error message (no secrets) flows through unchanged', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logBatchRetry('upsertChunks', 100, 1, 1000, new Error('Connection terminated unexpectedly'));
      const file = path.join(tmpDir, computeIsoWeekFilename(BATCH_RETRY_FEATURE_NAME));
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw).toContain('Connection terminated unexpectedly');
      expect(raw).not.toContain('<REDACTED');
    });
  });
});
