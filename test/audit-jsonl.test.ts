/**
 * Test the shared audit-log primitive at `src/core/audit-jsonl.ts`.
 *
 * Covers the factory (`createAuditLogger`) + the ISO-week filename math +
 * dir resolution. Per-domain audit modules (shell-audit, rerank-audit, etc.)
 * have their own test files that exercise the FULL surface via their
 * domain-specific re-exports; those tests pass unchanged by the refactor
 * (regression gate).
 *
 * Codified 2026-05-16 as part of the audit-substrate consolidation refactor.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import {
  computeIsoWeekFilename,
  resolveAuditDir,
  createAuditLogger,
} from '../src/core/audit-jsonl.ts';

// ─── ISO-week filename ────────────────────────────────────────────────────

describe('computeIsoWeekFilename', () => {
  test('basic case — 2026-05-16 (Saturday) is ISO week 20 of 2026', () => {
    const filename = computeIsoWeekFilename('my-audit', new Date(Date.UTC(2026, 4, 16, 12, 0, 0)));
    expect(filename).toBe('my-audit-2026-W20.jsonl');
  });

  test('year boundary — 2024-12-31 (Tuesday) is ISO week 01 of 2025', () => {
    const filename = computeIsoWeekFilename('audit', new Date(Date.UTC(2024, 11, 31, 12, 0, 0)));
    expect(filename).toBe('audit-2025-W01.jsonl');
  });

  test('year boundary — 2027-01-01 (Friday) is ISO week 53 of 2026', () => {
    const filename = computeIsoWeekFilename('audit', new Date(Date.UTC(2027, 0, 1, 12, 0, 0)));
    expect(filename).toBe('audit-2026-W53.jsonl');
  });

  test('different prefixes produce different filenames', () => {
    const ts = new Date(Date.UTC(2026, 4, 16, 12, 0, 0));
    expect(computeIsoWeekFilename('shell-jobs', ts)).toBe('shell-jobs-2026-W20.jsonl');
    expect(computeIsoWeekFilename('rerank-failures', ts)).toBe('rerank-failures-2026-W20.jsonl');
    expect(computeIsoWeekFilename('destructive-ops', ts)).toBe('destructive-ops-2026-W20.jsonl');
  });

  test('UTC handling — January 1 in California (before UTC midnight) still lands in correct ISO year', () => {
    // 2025-01-01 00:00 PST = 2025-01-01 08:00 UTC. ISO week of Jan 1 2025 is W01.
    const filename = computeIsoWeekFilename('audit', new Date(Date.UTC(2025, 0, 1, 8, 0, 0)));
    expect(filename).toBe('audit-2025-W01.jsonl');
  });
});

// ─── Dir resolution ───────────────────────────────────────────────────────

describe('resolveAuditDir', () => {
  test('honors GBRAIN_AUDIT_DIR override', async () => {
    const override = '/tmp/gbrain-test-override-' + Date.now();
    await withEnv({ GBRAIN_AUDIT_DIR: override }, async () => {
      expect(resolveAuditDir()).toBe(override);
    });
  });

  test('defaults to gbrainPath("audit") when GBRAIN_AUDIT_DIR unset', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: undefined }, async () => {
      const resolved = resolveAuditDir();
      expect(resolved).toContain('audit');
    });
  });

  test('ignores empty-string override (treats as unset)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: '' }, async () => {
      const resolved = resolveAuditDir();
      expect(resolved).toContain('audit');
      expect(resolved).not.toBe('');
    });
  });

  test('ignores whitespace-only override (treats as unset)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: '   ' }, async () => {
      const resolved = resolveAuditDir();
      expect(resolved).not.toBe('   ');
    });
  });
});

// ─── createAuditLogger factory ────────────────────────────────────────────

interface TestEvent {
  ts: string;
  kind: string;
  payload: number;
  optional_array?: string[];
  truncated?: boolean;
}

describe('createAuditLogger', () => {
  let auditDir: string;

  beforeAll(() => {
    auditDir = mkdtempSync(join(tmpdir(), 'gbrain-audit-jsonl-test-'));
  });

  afterAll(() => {
    try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  beforeEach(() => {
    if (existsSync(auditDir)) {
      for (const f of readdirSync(auditDir)) {
        try { rmSync(join(auditDir, f), { force: true }); } catch { /* swallow */ }
      }
    }
  });

  test('log() + readRecent() roundtrip preserves event shape', async () => {
    const logger = createAuditLogger<TestEvent>({
      prefix: 'my-audit',
      stderrTag: '[my-audit]',
      continueMessage: 'op continues',
    });
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      logger.log({ kind: 'foo', payload: 42 });
      const events = logger.readRecent(1);
      expect(events.length).toBe(1);
      expect(events[0].kind).toBe('foo');
      expect(events[0].payload).toBe(42);
      expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  test('log() applies transform before serialization', async () => {
    const logger = createAuditLogger<TestEvent>({
      prefix: 'transform-test',
      stderrTag: '[t]',
      continueMessage: 'continues',
      transform: (event) => {
        // Truncate arrays > 3 entries
        if (event.optional_array && event.optional_array.length > 3) {
          return {
            ...event,
            optional_array: event.optional_array.slice(0, 3),
            truncated: true,
          };
        }
        return event;
      },
    });
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      logger.log({
        kind: 'bulk',
        payload: 0,
        optional_array: ['a', 'b', 'c', 'd', 'e'],
      });
      const events = logger.readRecent(1);
      expect(events.length).toBe(1);
      expect(events[0].optional_array).toEqual(['a', 'b', 'c']);
      expect(events[0].truncated).toBe(true);
    });
  });

  test('transform is identity when not provided', async () => {
    const logger = createAuditLogger<TestEvent>({
      prefix: 'no-transform',
      stderrTag: '[nt]',
      continueMessage: 'continues',
    });
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      logger.log({ kind: 'untransformed', payload: 7, optional_array: ['x', 'y'] });
      const events = logger.readRecent(1);
      expect(events[0].optional_array).toEqual(['x', 'y']);
      expect(events[0].truncated).toBeUndefined();
    });
  });

  test('readRecent() filters by days window', async () => {
    const logger = createAuditLogger<TestEvent>({
      prefix: 'window-test',
      stderrTag: '[w]',
      continueMessage: 'continues',
    });
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      mkdirSync(auditDir, { recursive: true });
      const filename = logger.computeFilename();
      const filePath = join(auditDir, filename);
      const oldTs = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      const recentTs = new Date().toISOString();
      const content = [
        JSON.stringify({ ts: oldTs, kind: 'old', payload: 1 }),
        JSON.stringify({ ts: recentTs, kind: 'recent', payload: 2 }),
      ].join('\n');
      writeFileSync(filePath, content);
      expect(logger.readRecent(7).length).toBe(1);
      expect(logger.readRecent(14).length).toBe(2);
    });
  });

  test('readRecent() returns newest-first', async () => {
    const logger = createAuditLogger<TestEvent>({
      prefix: 'order-test',
      stderrTag: '[o]',
      continueMessage: 'continues',
    });
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      logger.log({ kind: 'first', payload: 1 });
      await new Promise((r) => setTimeout(r, 5));
      logger.log({ kind: 'second', payload: 2 });
      await new Promise((r) => setTimeout(r, 5));
      logger.log({ kind: 'third', payload: 3 });
      const events = logger.readRecent(1);
      expect(events.length).toBe(3);
      expect(events[0].kind).toBe('third');
      expect(events[1].kind).toBe('second');
      expect(events[2].kind).toBe('first');
    });
  });

  test('readRecent() tolerates malformed JSONL lines', async () => {
    const logger = createAuditLogger<TestEvent>({
      prefix: 'malformed-test',
      stderrTag: '[m]',
      continueMessage: 'continues',
    });
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      mkdirSync(auditDir, { recursive: true });
      const filename = logger.computeFilename();
      const filePath = join(auditDir, filename);
      const content = [
        JSON.stringify({ ts: new Date().toISOString(), kind: 'good-1', payload: 1 }),
        '{ this is not valid json',
        JSON.stringify({ ts: new Date().toISOString(), kind: 'good-2', payload: 2 }),
        '',
        '   ',
        JSON.stringify({ ts: new Date().toISOString(), kind: 'good-3', payload: 3 }),
      ].join('\n');
      writeFileSync(filePath, content);
      const events = logger.readRecent(1);
      expect(events.length).toBe(3);
      const kinds = events.map((e) => e.kind).sort();
      expect(kinds).toEqual(['good-1', 'good-2', 'good-3']);
    });
  });

  test('readRecent() filters by prefix — sibling audit kinds do not bleed in', async () => {
    const loggerA = createAuditLogger<TestEvent>({
      prefix: 'prefix-A',
      stderrTag: '[a]',
      continueMessage: 'continues',
    });
    const loggerB = createAuditLogger<TestEvent>({
      prefix: 'prefix-B',
      stderrTag: '[b]',
      continueMessage: 'continues',
    });
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      loggerA.log({ kind: 'from-A', payload: 1 });
      loggerB.log({ kind: 'from-B', payload: 2 });
      const eventsA = loggerA.readRecent(1);
      const eventsB = loggerB.readRecent(1);
      expect(eventsA.length).toBe(1);
      expect(eventsA[0].kind).toBe('from-A');
      expect(eventsB.length).toBe(1);
      expect(eventsB[0].kind).toBe('from-B');
    });
  });

  test('log() does NOT throw when audit dir is unwritable (best-effort posture)', async () => {
    const dummy = mkdtempSync(join(tmpdir(), 'gbrain-audit-fail-'));
    const blockingFile = join(dummy, 'blocker');
    writeFileSync(blockingFile, 'this is a file, not a dir');
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: blockingFile }, async () => {
        const logger = createAuditLogger<TestEvent>({
          prefix: 'fail-test',
          stderrTag: '[fail]',
          continueMessage: 'op continues',
        });
        expect(() => {
          logger.log({ kind: 'never-written', payload: 0 });
        }).not.toThrow();
      });
    } finally {
      rmSync(dummy, { recursive: true, force: true });
    }
  });

  test('computeFilename() returns the same string as the module-level helper', async () => {
    const logger = createAuditLogger<TestEvent>({
      prefix: 'consistency',
      stderrTag: '[c]',
      continueMessage: 'continues',
    });
    const ts = new Date(Date.UTC(2026, 4, 16, 12, 0, 0));
    expect(logger.computeFilename(ts)).toBe(computeIsoWeekFilename('consistency', ts));
  });

  test('readRecent() returns empty array when audit dir does not exist', async () => {
    const nonexistent = '/tmp/gbrain-this-dir-does-not-exist-' + Date.now();
    await withEnv({ GBRAIN_AUDIT_DIR: nonexistent }, async () => {
      const logger = createAuditLogger<TestEvent>({
        prefix: 'no-dir',
        stderrTag: '[nd]',
        continueMessage: 'continues',
      });
      const events = logger.readRecent(7);
      expect(events.length).toBe(0);
    });
  });
});
