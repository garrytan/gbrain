/**
 * subagent-audit tests. Exercises filename rotation, best-effort writes, and
 * the readback path used by `gbrain agent logs`. No real engine; purely
 * filesystem.
 */

import { describe, test, expect, beforeEach, afterAll, beforeAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  computeSubagentAuditFilename,
  logSubagentSubmission,
  logSubagentHeartbeat,
  readSubagentAuditForJob,
} from '../src/core/minions/handlers/subagent-audit.ts';

let tmpDir: string;
const savedAuditDir = process.env.GBRAIN_AUDIT_DIR;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-audit-test-'));
  process.env.GBRAIN_AUDIT_DIR = tmpDir;
});

afterAll(() => {
  if (savedAuditDir === undefined) delete process.env.GBRAIN_AUDIT_DIR;
  else process.env.GBRAIN_AUDIT_DIR = savedAuditDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) {
    fs.rmSync(path.join(tmpDir, f), { force: true });
  }
});

describe('computeSubagentAuditFilename', () => {
  test('formats as subagent-jobs-YYYY-Www.jsonl', () => {
    const name = computeSubagentAuditFilename(new Date('2026-04-20T12:00:00Z'));
    expect(name).toMatch(/^subagent-jobs-2026-W\d{2}\.jsonl$/);
  });

  test('ISO year-boundary: 2027-01-01 is W53 of 2026', () => {
    // 2027-01-01 is a Friday; ISO week containing that day is W53 of 2026.
    const name = computeSubagentAuditFilename(new Date('2027-01-01T00:00:00Z'));
    expect(name).toBe('subagent-jobs-2026-W53.jsonl');
  });

  test('mid-year dates carry the same year', () => {
    const name = computeSubagentAuditFilename(new Date('2026-06-15T12:00:00Z'));
    expect(name.startsWith('subagent-jobs-2026-W')).toBe(true);
  });
});

describe('logSubagentSubmission', () => {
  test('writes a JSONL line with submission type', () => {
    logSubagentSubmission({ caller: 'cli', remote: false, job_id: 42, model: 'sonnet' });
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);
    const raw = fs.readFileSync(path.join(tmpDir, files[0]!), 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe('submission');
    expect(parsed.caller).toBe('cli');
    expect(parsed.job_id).toBe(42);
    expect(parsed.model).toBe('sonnet');
    expect(parsed.ts).toMatch(/^20\d\d-/);
  });
});

describe('logSubagentHeartbeat', () => {
  test('writes heartbeat type with turn_idx', () => {
    logSubagentHeartbeat({
      job_id: 1,
      event: 'llm_call_completed',
      turn_idx: 3,
      ms_elapsed: 1250,
      tokens: { in: 1000, out: 200, cache_read: 500 },
    });
    const files = fs.readdirSync(tmpDir);
    const raw = fs.readFileSync(path.join(tmpDir, files[0]!), 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe('heartbeat');
    expect(parsed.event).toBe('llm_call_completed');
    expect(parsed.turn_idx).toBe(3);
    expect(parsed.tokens.in).toBe(1000);
  });

  test('truncates long error text to 200 chars', () => {
    const long = 'x'.repeat(500);
    logSubagentHeartbeat({
      job_id: 1,
      event: 'tool_failed',
      turn_idx: 0,
      tool_name: 'brain_put_page',
      error: long,
    });
    const files = fs.readdirSync(tmpDir);
    const raw = fs.readFileSync(path.join(tmpDir, files[0]!), 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.error.length).toBe(200);
  });

  test('best-effort: write failure does not throw', () => {
    const bogus = '/dev/null/not-a-dir';
    process.env.GBRAIN_AUDIT_DIR = bogus;
    try {
      expect(() => logSubagentHeartbeat({
        job_id: 1,
        event: 'llm_call_started',
        turn_idx: 0,
      })).not.toThrow();
    } finally {
      process.env.GBRAIN_AUDIT_DIR = tmpDir;
    }
  });
});

describe('readSubagentAuditForJob', () => {
  test('returns events for the target job in chronological order', () => {
    logSubagentSubmission({ caller: 'cli', remote: false, job_id: 100 });
    logSubagentHeartbeat({ job_id: 100, event: 'llm_call_started', turn_idx: 0 });
    logSubagentHeartbeat({ job_id: 100, event: 'llm_call_completed', turn_idx: 0, ms_elapsed: 500 });

    const events = readSubagentAuditForJob(100);
    expect(events.length).toBe(3);
    // chronological
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.ts >= events[i - 1]!.ts).toBe(true);
    }
  });

  test('filters to the requested job_id', () => {
    logSubagentSubmission({ caller: 'cli', remote: false, job_id: 1 });
    logSubagentSubmission({ caller: 'cli', remote: false, job_id: 2 });
    const justOne = readSubagentAuditForJob(1);
    expect(justOne.length).toBe(1);
    expect((justOne[0] as { job_id: number }).job_id).toBe(1);
  });

  test('honors sinceIso filter', () => {
    logSubagentSubmission({ caller: 'cli', remote: false, job_id: 1 });
    // Use a future threshold to drop everything above.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(readSubagentAuditForJob(1, { sinceIso: future })).toEqual([]);
  });

  test('returns [] when no audit files exist', () => {
    expect(readSubagentAuditForJob(999)).toEqual([]);
  });
});
