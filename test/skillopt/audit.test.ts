/**
 * SkillOpt audit JSONL writer tests.
 *
 * Uses withEnv (R1 compliant) to point GBRAIN_AUDIT_DIR at a tempdir per
 * test. Resets the cached writer between tests so each invocation re-reads
 * the env.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import {
  _resetAuditWriterForTests,
  currentAuditFilename,
  logEvent,
  readRecentEvents,
  resolveAuditDir,
  sha8,
} from '../../src/core/skillopt/audit.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-audit-'));
  _resetAuditWriterForTests();
});

afterEach(() => {
  _resetAuditWriterForTests();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('logEvent + readRecentEvents', () => {
  test('writes a JSONL row to the current ISO-week file', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logEvent({
        kind: 'run_start',
        run_id: 'r1',
        skill: 'meeting-prep',
        skill_sha8: 'abcd1234',
        benchmark_sha8: 'deadbeef',
        target_model: 'anthropic:claude-sonnet-4-6',
        optimizer_model: 'anthropic:claude-opus-4-7',
        judge_model: 'anthropic:claude-sonnet-4-6',
        epochs: 4,
        batch_size: 8,
        lr: 4,
        lr_schedule: 'cosine',
        max_cost_usd: 5.0,
      } as never);
      const file = path.join(tmpDir, currentAuditFilename());
      expect(fs.existsSync(file)).toBe(true);
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const ev = JSON.parse(lines[0]!);
      expect(ev.kind).toBe('run_start');
      expect(ev.skill).toBe('meeting-prep');
      expect(typeof ev.ts).toBe('string');
    });
  });

  test('readRecentEvents returns the row we just wrote', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logEvent({ kind: 'abort', run_id: 'r2', skill: 'foo', reason: 'budget_exhausted' } as never);
      const events = readRecentEvents(7);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const match = events.find((e) => e.kind === 'abort' && e.run_id === 'r2');
      expect(match).toBeDefined();
    });
  });

  test('resolveAuditDir honors GBRAIN_AUDIT_DIR override', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      expect(resolveAuditDir()).toBe(tmpDir);
    });
  });

  test('sha8 returns 8 hex chars deterministically', () => {
    expect(sha8('alice')).toMatch(/^[0-9a-f]{8}$/);
    expect(sha8('alice')).toBe(sha8('alice')); // deterministic
    expect(sha8('alice')).not.toBe(sha8('bob'));
  });
});
