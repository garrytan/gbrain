import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withEnv } from './helpers/with-env.ts';
import {
  computeStubGuardAuditFilename,
  readRecentStubGuardEvents,
  logStubGuardEvent,
} from '../src/core/facts/stub-guard-audit.ts';

/** Make a fresh tempdir for one test's audit files. Caller is responsible for cleanup. */
function freshTmpDir(): string {
  const dir = join(tmpdir(), `stub-guard-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('computeStubGuardAuditFilename', () => {
  it('produces ISO-week filename for a mid-week date', () => {
    // 2026-05-13 is a Wednesday in ISO week 20 of 2026.
    const filename = computeStubGuardAuditFilename(new Date('2026-05-13T12:00:00Z'));
    expect(filename).toBe('stub-guard-2026-W20.jsonl');
  });

  it('handles ISO year-boundary correctly (2027-01-01 is W53 of 2026)', () => {
    // The ISO-week standard: 2027-01-01 (Friday) belongs to W53 of 2026
    // because W1 of 2027 starts on Monday 2027-01-04.
    const filename = computeStubGuardAuditFilename(new Date('2027-01-01T12:00:00Z'));
    expect(filename).toBe('stub-guard-2026-W53.jsonl');
  });
});

describe('logStubGuardEvent', () => {
  it('appends a JSONL line to the current ISO-week file', async () => {
    const tmpAuditDir = freshTmpDir();
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
        logStubGuardEvent({ slug: 'alice', source_id: 'default', fact_count: 3 });
        const filename = computeStubGuardAuditFilename();
        const fullPath = join(tmpAuditDir, filename);
        expect(existsSync(fullPath)).toBe(true);
        const content = readFileSync(fullPath, 'utf8');
        const lines = content.trim().split('\n');
        expect(lines.length).toBe(1);
        const obj = JSON.parse(lines[0]);
        expect(obj.slug).toBe('alice');
        expect(obj.source_id).toBe('default');
        expect(obj.fact_count).toBe(3);
        expect(typeof obj.ts).toBe('string');
        expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });
    } finally {
      if (existsSync(tmpAuditDir)) rmSync(tmpAuditDir, { recursive: true, force: true });
    }
  });

  it('never throws when audit dir is unwritable', async () => {
    // Point GBRAIN_AUDIT_DIR at a file (not a directory) — mkdirSync will fail,
    // appendFileSync will fail. Both should be swallowed.
    const blockerFile = join(tmpdir(), `stub-guard-blocker-${Date.now()}.txt`);
    writeFileSync(blockerFile, 'this is a regular file');
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: blockerFile }, async () => {
        expect(() => logStubGuardEvent({ slug: 'bob', source_id: 'default', fact_count: 1 })).not.toThrow();
      });
    } finally {
      if (existsSync(blockerFile)) rmSync(blockerFile);
    }
  });
});

describe('readRecentStubGuardEvents — cross-week-boundary correctness', () => {
  it('reads events from BOTH current and previous ISO-week files', async () => {
    // Simulate "Monday 00:01 UTC just after a Sunday 23:55 UTC fire."
    // The Sunday event is in last week's file; the Monday read window
    // must surface it. This is the case readSupervisorEvents misses.
    const tmpAuditDir = freshTmpDir();
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
        const fakeNow = new Date('2026-05-11T00:01:00Z'); // Monday W20 2026
        const prevSunday = new Date('2026-05-10T23:55:00Z'); // Sunday W19 2026
        const earlierInWindow = new Date('2026-05-10T00:30:00Z'); // earlier in 24h window, W19
        const outsideWindow = new Date('2026-05-09T12:00:00Z'); // outside 24h window, W19
        const earlyMonday = new Date('2026-05-11T00:00:30Z'); // current week, in window

        const prevWeekFile = computeStubGuardAuditFilename(prevSunday);
        const currentFile = computeStubGuardAuditFilename(fakeNow);

        // Sanity: they MUST be different files for this regression test to mean anything.
        expect(prevWeekFile).not.toBe(currentFile);

        // Manually write to both files (bypass writer to control timestamps).
        const prevPath = join(tmpAuditDir, prevWeekFile);
        const currentPath = join(tmpAuditDir, currentFile);
        writeFileSync(prevPath, [
          JSON.stringify({ ts: outsideWindow.toISOString(), slug: 'too-old', source_id: 'default', fact_count: 1 }),
          JSON.stringify({ ts: earlierInWindow.toISOString(), slug: 'monday-prev-week', source_id: 'default', fact_count: 1 }),
          JSON.stringify({ ts: prevSunday.toISOString(), slug: 'sunday-late', source_id: 'default', fact_count: 1 }),
        ].join('\n') + '\n');
        writeFileSync(currentPath, [
          JSON.stringify({ ts: earlyMonday.toISOString(), slug: 'monday-current-week', source_id: 'default', fact_count: 1 }),
        ].join('\n') + '\n');

        // Read with a 24h window relative to fakeNow.
        const events = readRecentStubGuardEvents({ sinceMs: 24 * 60 * 60 * 1000, now: fakeNow });
        const slugs = events.map(e => e.slug);

        expect(slugs).toContain('sunday-late');
        expect(slugs).toContain('monday-prev-week');
        expect(slugs).toContain('monday-current-week');
        expect(slugs).not.toContain('too-old');
      });
    } finally {
      if (existsSync(tmpAuditDir)) rmSync(tmpAuditDir, { recursive: true, force: true });
    }
  });

  it('returns events sorted oldest-first', async () => {
    const tmpAuditDir = freshTmpDir();
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
        const now = new Date('2026-05-13T12:00:00Z');
        const filename = computeStubGuardAuditFilename(now);
        const fullPath = join(tmpAuditDir, filename);

        writeFileSync(fullPath, [
          JSON.stringify({ ts: '2026-05-13T11:00:00Z', slug: 'second', source_id: 'default', fact_count: 1 }),
          JSON.stringify({ ts: '2026-05-13T10:00:00Z', slug: 'first', source_id: 'default', fact_count: 1 }),
          JSON.stringify({ ts: '2026-05-13T11:30:00Z', slug: 'third', source_id: 'default', fact_count: 1 }),
        ].join('\n') + '\n');

        const events = readRecentStubGuardEvents({ sinceMs: 24 * 60 * 60 * 1000, now });
        expect(events.map(e => e.slug)).toEqual(['first', 'second', 'third']);
      });
    } finally {
      if (existsSync(tmpAuditDir)) rmSync(tmpAuditDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when no files exist', async () => {
    const tmpAuditDir = freshTmpDir();
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
        const events = readRecentStubGuardEvents({ sinceMs: 24 * 60 * 60 * 1000 });
        expect(events).toEqual([]);
      });
    } finally {
      if (existsSync(tmpAuditDir)) rmSync(tmpAuditDir, { recursive: true, force: true });
    }
  });

  it('skips malformed JSON lines without crashing', async () => {
    const tmpAuditDir = freshTmpDir();
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
        const now = new Date('2026-05-13T12:00:00Z');
        const filename = computeStubGuardAuditFilename(now);
        const fullPath = join(tmpAuditDir, filename);

        writeFileSync(fullPath, [
          JSON.stringify({ ts: '2026-05-13T11:00:00Z', slug: 'valid', source_id: 'default', fact_count: 1 }),
          'this is not JSON',
          '{"ts":"truncated',
          '',
        ].join('\n') + '\n');

        const events = readRecentStubGuardEvents({ sinceMs: 24 * 60 * 60 * 1000, now });
        expect(events.length).toBe(1);
        expect(events[0].slug).toBe('valid');
      });
    } finally {
      if (existsSync(tmpAuditDir)) rmSync(tmpAuditDir, { recursive: true, force: true });
    }
  });

  it('skips rows missing required fields (ts, slug)', async () => {
    const tmpAuditDir = freshTmpDir();
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
        const now = new Date('2026-05-13T12:00:00Z');
        const filename = computeStubGuardAuditFilename(now);
        const fullPath = join(tmpAuditDir, filename);

        writeFileSync(fullPath, [
          JSON.stringify({ ts: '2026-05-13T11:00:00Z', source_id: 'default' }), // missing slug
          JSON.stringify({ slug: 'no-ts', source_id: 'default', fact_count: 1 }), // missing ts
          JSON.stringify({ ts: '2026-05-13T11:30:00Z', slug: 'valid', source_id: 'default', fact_count: 1 }),
        ].join('\n') + '\n');

        const events = readRecentStubGuardEvents({ sinceMs: 24 * 60 * 60 * 1000, now });
        expect(events.length).toBe(1);
        expect(events[0].slug).toBe('valid');
      });
    } finally {
      if (existsSync(tmpAuditDir)) rmSync(tmpAuditDir, { recursive: true, force: true });
    }
  });
});
