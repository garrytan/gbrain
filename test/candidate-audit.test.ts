// v0.38 candidate-audit gap-fill (T1 from gap audit).
//
// Pins the privacy contract + file I/O behavior for the schema-candidate
// audit trail used by `gbrain schema review-candidates` (v0.39).
//
// Why this matters: candidate-audit is the only on-disk surface for
// lenient-mode put_page events. The privacy contract (sha8-by-default,
// slug-prefix-only, key names never values) is the leak boundary. If it
// regresses, therapy/adversary/hater diagnostic categories surface in
// plaintext. The verbose env-var escape hatch must stay opt-in.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import {
  computeCandidateAuditPath,
  computeIsoWeekName,
  isAuditVerbose,
  logCandidate,
  readRecentCandidates,
} from '../src/core/schema-pack/candidate-audit.ts';

let auditDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-candidate-audit-'));
});

afterEach(() => {
  rmSync(auditDir, { recursive: true, force: true });
});

describe('isAuditVerbose', () => {
  test('false when env unset', async () => {
    await withEnv({ GBRAIN_SCHEMA_AUDIT_VERBOSE: undefined }, () => {
      expect(isAuditVerbose()).toBe(false);
    });
  });
  test('true when env=1', async () => {
    await withEnv({ GBRAIN_SCHEMA_AUDIT_VERBOSE: '1' }, () => {
      expect(isAuditVerbose()).toBe(true);
    });
  });
  test('false for any other value', async () => {
    await withEnv({ GBRAIN_SCHEMA_AUDIT_VERBOSE: 'true' }, () => {
      expect(isAuditVerbose()).toBe(false);
    });
    await withEnv({ GBRAIN_SCHEMA_AUDIT_VERBOSE: 'yes' }, () => {
      expect(isAuditVerbose()).toBe(false);
    });
  });
});

describe('computeIsoWeekName', () => {
  test('formats YYYY-Www with zero-padded week', () => {
    expect(computeIsoWeekName(new Date('2026-01-05T12:00:00Z'))).toBe('2026-W02');
    expect(computeIsoWeekName(new Date('2026-06-15T12:00:00Z'))).toBe('2026-W25');
  });
  test('ISO year boundary: 2026-12-29 sits in 2026-W53', () => {
    // 2026 has 53 ISO weeks (starts on Thursday).
    expect(computeIsoWeekName(new Date('2026-12-29T12:00:00Z'))).toBe('2026-W53');
  });
});

describe('computeCandidateAuditPath', () => {
  test('honors GBRAIN_AUDIT_DIR override', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => {
      const path = computeCandidateAuditPath(new Date('2026-03-15T12:00:00Z'));
      expect(path).toStartWith(auditDir);
      expect(path).toEndWith('schema-candidates-2026-W11.jsonl');
    });
  });
});

describe('logCandidate (redacted by default)', () => {
  test('writes sha8 hash, not raw type, when verbose is unset', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir, GBRAIN_SCHEMA_AUDIT_VERBOSE: undefined }, async () => {
      await logCandidate({
        type: 'therapy-session',
        slug: 'personal/therapy/2025-03-15-session-12.md',
        frontmatterKeys: ['date', 'therapist', 'mood'],
        packIdentity: 'gbrain-base@1.0.0+aaaaaaaa',
      });
      const filePath = computeCandidateAuditPath();
      const content = readFileSync(filePath, 'utf-8').trim();
      const record = JSON.parse(content);
      expect(record.type_redacted).toBe(true);
      expect(record.type_or_hash).not.toBe('therapy-session');
      // sha8 is 8 hex chars.
      expect(record.type_or_hash).toMatch(/^[0-9a-f]{8}$/);
      // Slug is reduced to first segment only.
      expect(record.slug_prefix).toBe('personal');
      expect(record.slug_prefix).not.toContain('therapy');
      // Keys sorted, values absent.
      expect(record.frontmatter_keys).toEqual(['date', 'mood', 'therapist']);
      expect(record.pack_identity).toBe('gbrain-base@1.0.0+aaaaaaaa');
      expect(record.count).toBe(1);
      expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  test('writes raw type when GBRAIN_SCHEMA_AUDIT_VERBOSE=1', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir, GBRAIN_SCHEMA_AUDIT_VERBOSE: '1' }, async () => {
      await logCandidate({
        type: 'therapy-session',
        slug: 'personal/therapy/foo.md',
        frontmatterKeys: ['date'],
        packIdentity: 'gbrain-base@1.0.0+bbbbbbbb',
      });
      const record = JSON.parse(readFileSync(computeCandidateAuditPath(), 'utf-8').trim());
      expect(record.type_redacted).toBe(false);
      expect(record.type_or_hash).toBe('therapy-session');
    });
  });

  test('honors custom count', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await logCandidate({
        type: 'foo',
        slug: 'bar/baz.md',
        frontmatterKeys: [],
        packIdentity: 'p',
        count: 42,
      });
      const record = JSON.parse(readFileSync(computeCandidateAuditPath(), 'utf-8').trim());
      expect(record.count).toBe(42);
    });
  });

  test('appends multiple entries as JSONL', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await logCandidate({ type: 'a', slug: 'x/1.md', frontmatterKeys: [], packIdentity: 'p' });
      await logCandidate({ type: 'b', slug: 'y/2.md', frontmatterKeys: [], packIdentity: 'p' });
      const lines = readFileSync(computeCandidateAuditPath(), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      JSON.parse(lines[0]);
      JSON.parse(lines[1]);
    });
  });

  test('best-effort: unwritable audit dir warns but does not throw', async () => {
    // Point GBRAIN_AUDIT_DIR at a path that mkdirSync(recursive:true) can't create.
    // Using a non-existent file as a parent (file, not dir) triggers ENOTDIR.
    const blockerFile = join(auditDir, 'blocker');
    writeFileSync(blockerFile, 'this is a file, not a dir');
    await withEnv({ GBRAIN_AUDIT_DIR: join(blockerFile, 'subdir') }, async () => {
      // Should not throw.
      await logCandidate({ type: 'x', slug: 'y/z.md', frontmatterKeys: [], packIdentity: 'p' });
    });
  });

  test('slug with no slashes falls back to whole slug as prefix', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await logCandidate({ type: 'x', slug: 'rootonly', frontmatterKeys: [], packIdentity: 'p' });
      const record = JSON.parse(readFileSync(computeCandidateAuditPath(), 'utf-8').trim());
      expect(record.slug_prefix).toBe('rootonly');
    });
  });
});

describe('readRecentCandidates', () => {
  test('returns [] when audit dir does not exist', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: join(auditDir, 'nope') }, () => {
      expect(readRecentCandidates(30)).toEqual([]);
    });
  });

  test('reads recently-written entries', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      await logCandidate({ type: 'a', slug: 'x/1.md', frontmatterKeys: [], packIdentity: 'p' });
      await logCandidate({ type: 'b', slug: 'y/2.md', frontmatterKeys: [], packIdentity: 'p' });
      const records = readRecentCandidates(30);
      expect(records).toHaveLength(2);
      // sha8-redacted entries (default).
      expect(records[0].type_or_hash).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  test('skips malformed lines silently', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // Pre-create a valid entry, then append junk.
      await logCandidate({ type: 'a', slug: 'x/1.md', frontmatterKeys: [], packIdentity: 'p' });
      const path = computeCandidateAuditPath();
      writeFileSync(path, readFileSync(path, 'utf-8') + 'this is not json\n{"partial":\n', { flag: 'w' });
      // Append one more valid entry.
      await logCandidate({ type: 'b', slug: 'y/2.md', frontmatterKeys: [], packIdentity: 'p' });
      const records = readRecentCandidates(30);
      // Should get the two valid entries, skipping the junk.
      expect(records.length).toBeGreaterThanOrEqual(1);
      for (const r of records) {
        expect(typeof r.type_or_hash).toBe('string');
      }
    });
  });

  test('filters by daysBack cutoff', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      // Write a record by hand with an ancient ts, plus one fresh via the API.
      const ancientPath = join(auditDir, 'schema-candidates-2020-W01.jsonl');
      mkdirSync(auditDir, { recursive: true });
      const ancient = {
        ts: '2020-01-01T00:00:00.000Z',
        type_or_hash: 'old',
        type_redacted: false,
        slug_prefix: 'x',
        frontmatter_keys: [],
        count: 1,
        pack_identity: 'p',
      };
      writeFileSync(ancientPath, JSON.stringify(ancient) + '\n');
      await logCandidate({ type: 'fresh', slug: 'y/z.md', frontmatterKeys: [], packIdentity: 'p' });

      const recent = readRecentCandidates(30);
      // Only the fresh one should pass the 30-day cutoff.
      expect(recent.every(r => r.ts !== ancient.ts)).toBe(true);
      expect(recent.length).toBeGreaterThanOrEqual(1);

      // Widening the window picks up the ancient row.
      const all = readRecentCandidates(365 * 20);
      expect(all.some(r => r.ts === ancient.ts)).toBe(true);
    });
  });

  test('ignores files that do not match the audit prefix', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
      mkdirSync(auditDir, { recursive: true });
      // Sibling audit file from a different surface — must be ignored.
      writeFileSync(
        join(auditDir, 'shell-jobs-2026-W11.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), unrelated: true }) + '\n',
      );
      await logCandidate({ type: 'x', slug: 'a/b.md', frontmatterKeys: [], packIdentity: 'p' });
      const records = readRecentCandidates(30);
      expect(records).toHaveLength(1);
    });
  });
});
