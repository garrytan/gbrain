/**
 * v0.32.7 CJK wave — slug-fallback audit JSONL.
 *
 * Direct unit coverage for `logSlugFallback` and `readRecentSlugFallbacks`.
 * Uses GBRAIN_AUDIT_DIR override pointed at a tmpdir for hermeticity (the
 * shared-audit-dir helper honors that env var; see shell-audit.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  computeSlugFallbackAuditFilename,
  logSlugFallback,
  readRecentSlugFallbacks,
} from '../src/core/audit-slug-fallback.ts';

let auditDir: string;
let savedEnv: string | undefined;

beforeAll(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-slug-fallback-audit-'));
  savedEnv = process.env.GBRAIN_AUDIT_DIR;
  process.env.GBRAIN_AUDIT_DIR = auditDir;
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.GBRAIN_AUDIT_DIR;
  else process.env.GBRAIN_AUDIT_DIR = savedEnv;
  rmSync(auditDir, { recursive: true, force: true });
});

afterEach(() => {
  // Empty the audit dir between tests so file rotation doesn't leak state.
  for (const f of readdirSync(auditDir)) rmSync(join(auditDir, f));
});

describe('slug-fallback audit (v0.32.7)', () => {
  test('computeSlugFallbackAuditFilename has stable ISO-week shape', () => {
    const filename = computeSlugFallbackAuditFilename(new Date('2026-05-15T12:00:00Z'));
    expect(filename).toMatch(/^slug-fallback-\d{4}-W\d{2}\.jsonl$/);
    expect(filename).toContain('2026-W20');
  });

  test('logSlugFallback writes one JSONL row + stderr line', () => {
    logSlugFallback('projects/launch', '🚀.md');
    const files = readdirSync(auditDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^slug-fallback-\d{4}-W\d{2}\.jsonl$/);
    const content = readFileSync(join(auditDir, files[0]), 'utf8');
    const lines = content.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.slug).toBe('projects/launch');
    expect(parsed.source_path).toBe('🚀.md');
    expect(parsed.severity).toBe('info');
    expect(parsed.code).toBe('SLUG_FALLBACK_FRONTMATTER');
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('readRecentSlugFallbacks returns events from the last 7 days', () => {
    logSlugFallback('a/one', '🚀.md');
    logSlugFallback('b/two', '🌟.md');
    const events = readRecentSlugFallbacks(7);
    expect(events.length).toBe(2);
    expect(events.every(e => e.severity === 'info')).toBe(true);
  });

  test('readRecentSlugFallbacks skips corrupt rows silently', () => {
    const filename = computeSlugFallbackAuditFilename();
    const file = join(auditDir, filename);
    writeFileSync(file, [
      JSON.stringify({ ts: new Date().toISOString(), slug: 'a/good', source_path: 'a.md', severity: 'info', code: 'SLUG_FALLBACK_FRONTMATTER' }),
      'not-json',
      '{"ts": "garbage", "slug": "b/bad"',
      '',
    ].join('\n'));
    const events = readRecentSlugFallbacks(7);
    expect(events.length).toBe(1);
    expect(events[0].slug).toBe('a/good');
  });

  test('readRecentSlugFallbacks returns empty when no file exists', () => {
    const events = readRecentSlugFallbacks(7);
    expect(events).toEqual([]);
  });

  test('readRecentSlugFallbacks honors the days window', () => {
    // Write an event with a 10-day-old timestamp.
    const oldTs = new Date(Date.now() - 10 * 86400000).toISOString();
    const filename = computeSlugFallbackAuditFilename();
    writeFileSync(
      join(auditDir, filename),
      JSON.stringify({ ts: oldTs, slug: 'stale', source_path: 'old.md', severity: 'info', code: 'SLUG_FALLBACK_FRONTMATTER' }) + '\n',
    );
    expect(readRecentSlugFallbacks(7).length).toBe(0);
    expect(readRecentSlugFallbacks(30).length).toBe(1);
  });
});
