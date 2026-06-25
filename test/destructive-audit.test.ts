/**
 * Test: destructive-op audit log.
 *
 * Pure-helper tests for the audit module (filename, dir resolution, write+read
 * roundtrip, truncation, best-effort posture) + end-to-end coverage that the
 * pglite engine actually emits audit lines on `deletePage` and
 * `purgeDeletedPages`. The latter exercises the real wire-in via a temp
 * GBRAIN_AUDIT_DIR so the test never touches the operator's real audit dir.
 *
 * Closes #1063 follow-up — makes future hard-deletes reconstructible without
 * the Claude Code JSONL transcript dependency.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  computeDestructiveAuditFilename,
  resolveAuditDir,
  logDestructiveOp,
  readRecentDestructiveOps,
} from '../src/core/destructive-audit.ts';

describe('destructive-audit: filename + dir helpers', () => {
  test('ISO-week filename — 2026-W20 lands at expected boundary', () => {
    // 2026-05-16 is in ISO week 20 of 2026.
    const filename = computeDestructiveAuditFilename(new Date(Date.UTC(2026, 4, 16, 12, 0, 0)));
    expect(filename).toBe('destructive-ops-2026-W20.jsonl');
  });

  test('ISO-year boundary — Dec 31 may belong to W01 of next year', () => {
    // 2024-12-31 is ISO week 01 of 2025 (week containing Jan 1 2025 is W01).
    const filename = computeDestructiveAuditFilename(new Date(Date.UTC(2024, 11, 31, 12, 0, 0)));
    expect(filename).toBe('destructive-ops-2025-W01.jsonl');
  });

  test('resolveAuditDir honors GBRAIN_AUDIT_DIR override', async () => {
    const override = '/tmp/gbrain-test-audit-override-' + Date.now();
    await withEnv({ GBRAIN_AUDIT_DIR: override }, async () => {
      expect(resolveAuditDir()).toBe(override);
    });
  });

  test('resolveAuditDir defaults to ~/.gbrain/audit when override unset', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: undefined }, async () => {
      const resolved = resolveAuditDir();
      expect(resolved).toContain('audit');
      // Defaults to gbrainPath('audit') — could be GBRAIN_HOME-overridden in CI
      expect(resolved.endsWith('/audit') || resolved.endsWith('audit')).toBe(true);
    });
  });
});

describe('destructive-audit: write + read roundtrip', () => {
  let auditDir: string;

  beforeAll(() => {
    auditDir = mkdtempSync(join(tmpdir(), 'gbrain-destructive-audit-'));
  });

  afterAll(() => {
    try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  beforeEach(() => {
    // Clean the audit dir between tests so each test sees only its own writes.
    if (existsSync(auditDir)) {
      for (const f of readdirSync(auditDir)) {
        try { rmSync(join(auditDir, f), { force: true }); } catch { /* swallow */ }
      }
    }
  });

  test('logDestructiveOp writes a JSONL line + readRecentDestructiveOps reads it back', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      logDestructiveOp({
        op: 'deletePage',
        engine: 'pglite',
        slug: 'people/alice',
        source_id: 'default',
      });
      const events = readRecentDestructiveOps(1);
      expect(events.length).toBe(1);
      expect(events[0].op).toBe('deletePage');
      expect(events[0].engine).toBe('pglite');
      expect(events[0].slug).toBe('people/alice');
      expect(events[0].source_id).toBe('default');
      expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  test('readRecentDestructiveOps returns newest-first', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      logDestructiveOp({ op: 'deletePage', engine: 'pglite', slug: 'a' });
      // Tiny delay so timestamps differ deterministically
      await new Promise((r) => setTimeout(r, 5));
      logDestructiveOp({ op: 'deletePage', engine: 'pglite', slug: 'b' });
      await new Promise((r) => setTimeout(r, 5));
      logDestructiveOp({ op: 'deletePage', engine: 'pglite', slug: 'c' });
      const events = readRecentDestructiveOps(1);
      expect(events.length).toBe(3);
      expect(events[0].slug).toBe('c');
      expect(events[1].slug).toBe('b');
      expect(events[2].slug).toBe('a');
    });
  });

  test('logDestructiveOp truncates page_slugs > 50 with truncated marker', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const manySlugs = Array.from({ length: 100 }, (_, i) => `wiki/page-${i}`);
      logDestructiveOp({
        op: 'purgeDeletedPages',
        engine: 'pglite',
        older_than_hours: 72,
        pages_purged: 100,
        page_slugs: manySlugs,
      });
      const events = readRecentDestructiveOps(1);
      expect(events.length).toBe(1);
      expect(events[0].pages_purged).toBe(100); // count is ground truth
      expect(events[0].page_slugs?.length).toBe(50); // capped
      expect(events[0].page_slugs_truncated).toBe(true);
      // First 50 preserved in order
      expect(events[0].page_slugs?.[0]).toBe('wiki/page-0');
      expect(events[0].page_slugs?.[49]).toBe('wiki/page-49');
    });
  });

  test('page_slugs <= 50 stays untruncated, no truncated marker', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      const fewSlugs = ['a', 'b', 'c'];
      logDestructiveOp({
        op: 'purgeDeletedPages',
        engine: 'pglite',
        older_than_hours: 72,
        pages_purged: 3,
        page_slugs: fewSlugs,
      });
      const events = readRecentDestructiveOps(1);
      expect(events[0].page_slugs).toEqual(['a', 'b', 'c']);
      expect(events[0].page_slugs_truncated).toBeUndefined();
    });
  });

  test('readRecentDestructiveOps skips malformed JSONL lines (partial-write tolerance)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      mkdirSync(auditDir, { recursive: true });
      const filename = computeDestructiveAuditFilename();
      const filePath = join(auditDir, filename);
      // Mix valid + invalid lines — readRecentDestructiveOps must skip the invalid ones
      const content = [
        JSON.stringify({ ts: new Date().toISOString(), op: 'deletePage', engine: 'pglite', slug: 'good-1' }),
        '{ this is not valid json',
        JSON.stringify({ ts: new Date().toISOString(), op: 'deletePage', engine: 'pglite', slug: 'good-2' }),
        '',
        '   ',
        JSON.stringify({ ts: new Date().toISOString(), op: 'deletePage', engine: 'pglite', slug: 'good-3' }),
      ].join('\n');
      writeFileSync(filePath, content);
      const events = readRecentDestructiveOps(1);
      expect(events.length).toBe(3);
      // Ordering: newest-first; all 3 have nearly-identical timestamps so any order is fine
      const slugs = events.map((e) => e.slug).sort();
      expect(slugs).toEqual(['good-1', 'good-2', 'good-3']);
    });
  });

  test('readRecentDestructiveOps filters by days window', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      mkdirSync(auditDir, { recursive: true });
      const filename = computeDestructiveAuditFilename();
      const filePath = join(auditDir, filename);
      // One event in the past (10 days ago), one recent
      const oldTs = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
      const recentTs = new Date().toISOString();
      const content = [
        JSON.stringify({ ts: oldTs, op: 'deletePage', engine: 'pglite', slug: 'old' }),
        JSON.stringify({ ts: recentTs, op: 'deletePage', engine: 'pglite', slug: 'recent' }),
      ].join('\n');
      writeFileSync(filePath, content);
      const events7 = readRecentDestructiveOps(7);
      expect(events7.length).toBe(1);
      expect(events7[0].slug).toBe('recent');
      const events14 = readRecentDestructiveOps(14);
      expect(events14.length).toBe(2);
    });
  });

  test('best-effort: logDestructiveOp does NOT throw when audit dir is unwritable', async () => {
    // Point at a path that fs.mkdirSync will refuse — a file masquerading as a dir
    const dummy = mkdtempSync(join(tmpdir(), 'gbrain-destructive-audit-fail-'));
    const blockingFile = join(dummy, 'blocker');
    writeFileSync(blockingFile, 'this is a file, not a dir');
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: blockingFile }, async () => {
        // mkdirSync of a path whose parent is a file will throw — log should swallow it
        expect(() => {
          logDestructiveOp({ op: 'deletePage', engine: 'pglite', slug: 'whatever' });
        }).not.toThrow();
      });
    } finally {
      rmSync(dummy, { recursive: true, force: true });
    }
  });
});

describe('destructive-audit: end-to-end through pglite engine', () => {
  let engine: PGLiteEngine;
  let auditDir: string;

  beforeAll(async () => {
    auditDir = mkdtempSync(join(tmpdir(), 'gbrain-destructive-audit-e2e-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    // Clean the audit dir between tests
    if (existsSync(auditDir)) {
      for (const f of readdirSync(auditDir)) {
        try { rmSync(join(auditDir, f), { force: true }); } catch { /* swallow */ }
      }
    }
  });

  test('engine.deletePage emits a deletePage audit line', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // Seed a page first
      await engine.putPage('wiki/test-page', {
        type: 'concept',
        title: 'Test Page',
        compiled_truth: 'body',
        chunker_version: 2,
        page_kind: 'markdown',
      });
      // Hard-delete it
      await engine.deletePage('wiki/test-page');
      const events = readRecentDestructiveOps(1);
      expect(events.length).toBe(1);
      expect(events[0].op).toBe('deletePage');
      expect(events[0].engine).toBe('pglite');
      expect(events[0].slug).toBe('wiki/test-page');
      expect(events[0].source_id).toBe('default');
    });
  });

  test('engine.purgeDeletedPages emits a purgeDeletedPages audit line when rows are purged', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // Seed + soft-delete two pages
      await engine.putPage('wiki/p1', {
        type: 'concept', title: 'P1', compiled_truth: 'a',
        chunker_version: 2, page_kind: 'markdown',
      });
      await engine.putPage('wiki/p2', {
        type: 'concept', title: 'P2', compiled_truth: 'b',
        chunker_version: 2, page_kind: 'markdown',
      });
      await engine.softDeletePage('wiki/p1');
      await engine.softDeletePage('wiki/p2');
      // Purge with 0h threshold (immediate)
      const result = await engine.purgeDeletedPages(0);
      expect(result.count).toBe(2);
      const events = readRecentDestructiveOps(1);
      expect(events.length).toBe(1);
      expect(events[0].op).toBe('purgeDeletedPages');
      expect(events[0].engine).toBe('pglite');
      expect(events[0].older_than_hours).toBe(0);
      expect(events[0].pages_purged).toBe(2);
      expect(events[0].page_slugs?.sort()).toEqual(['wiki/p1', 'wiki/p2']);
    });
  });

  test('engine.purgeDeletedPages with zero rows purged does NOT emit an audit line (avoid no-op churn)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // No soft-deleted pages exist
      const result = await engine.purgeDeletedPages(72);
      expect(result.count).toBe(0);
      const events = readRecentDestructiveOps(1);
      expect(events.length).toBe(0); // no audit line — saves disk on clean autopilot runs
    });
  });
});
