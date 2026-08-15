/**
 * Test: `childTableOrphansCheck` (closes #1063).
 *
 * Pure-helper test surface — the check function only consumes `engine.executeRaw`,
 * so a structurally-typed mock satisfies the contract. This is faster and more
 * focused than spinning up real PGLite, AND it doesn't require disabling FK
 * constraints to seed orphans (which PGLite blocks at INSERT time anyway via
 * the normal FK trigger).
 *
 * 10 FK-child tables checked. Six have NOT NULL FKs (orphan = any value not in
 * pages.id). Four — wait, two — have nullable FKs (`files.page_id`, `links.origin_page_id`
 * declared ON DELETE SET NULL); orphan check skips NULL via the `IS NOT NULL` filter.
 */

import { describe, test, expect } from 'bun:test';
import { childTableOrphansCheck } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/** Build a structurally-typed BrainEngine whose executeRaw returns per-SQL results. */
function makeMockEngine(handler: (sql: string) => Promise<unknown[]>): BrainEngine {
  return {
    executeRaw: handler,
  } as unknown as BrainEngine;
}

describe('childTableOrphansCheck (#1063)', () => {
  test('all clean → status:ok with "10 tables checked"', async () => {
    const engine = makeMockEngine(async () => [{ n: 0 }]);
    const result = await childTableOrphansCheck(engine);
    expect(result.name).toBe('child_table_orphans');
    expect(result.status).toBe('ok');
    expect(result.message).toContain('10 tables checked');
  });

  test('one orphan in content_chunks → status:warn with paste-ready cleanup SQL', async () => {
    const engine = makeMockEngine(async (sql: string) => {
      if (sql.includes('content_chunks')) return [{ n: 5 }];
      return [{ n: 0 }];
    });
    const result = await childTableOrphansCheck(engine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('5 orphan row(s)');
    expect(result.message).toContain('content_chunks.page_id=5');
    expect(result.message).toContain('DELETE FROM content_chunks WHERE page_id NOT IN (SELECT id FROM pages)');
  });

  test('orphans in multiple tables → aggregated breakdown + multi-line cleanup', async () => {
    const engine = makeMockEngine(async (sql: string) => {
      if (sql.includes('content_chunks')) return [{ n: 234 }];
      if (sql.includes('page_versions')) return [{ n: 12 }];
      if (sql.includes('FROM tags')) return [{ n: 3 }];
      return [{ n: 0 }];
    });
    const result = await childTableOrphansCheck(engine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('249 orphan row(s)'); // 234 + 12 + 3
    expect(result.message).toContain('content_chunks.page_id=234');
    expect(result.message).toContain('page_versions.page_id=12');
    expect(result.message).toContain('tags.page_id=3');
    expect(result.message).toContain('DELETE FROM content_chunks');
    expect(result.message).toContain('DELETE FROM page_versions');
    expect(result.message).toContain('DELETE FROM tags');
  });

  test('nullable FK (files.page_id, links.origin_page_id) filters IS NOT NULL', async () => {
    // Capture the actual SQL strings issued so we can pin the filter behavior
    const capturedSql: string[] = [];
    const engine = makeMockEngine(async (sql: string) => {
      capturedSql.push(sql);
      return [{ n: 0 }];
    });
    await childTableOrphansCheck(engine);
    // The nullable-FK tables MUST have `IS NOT NULL AND` in their predicate
    // (NULL is a valid SET NULL outcome, not an orphan).
    const filesSql = capturedSql.find((s) => s.includes('FROM files WHERE'));
    expect(filesSql).toBeDefined();
    expect(filesSql!).toContain('page_id IS NOT NULL AND page_id NOT IN');
    const linksOrigSql = capturedSql.find((s) => s.includes('FROM links WHERE') && s.includes('origin_page_id'));
    expect(linksOrigSql).toBeDefined();
    expect(linksOrigSql!).toContain('origin_page_id IS NOT NULL AND origin_page_id NOT IN');
    // NOT-NULL FK tables MUST NOT have the IS NOT NULL filter (it'd be redundant)
    const ccSql = capturedSql.find((s) => s.includes('FROM content_chunks WHERE'));
    expect(ccSql).toBeDefined();
    expect(ccSql!).not.toContain('IS NOT NULL');
  });

  test('executeRaw throws on N tables → warn with error summary, no false-ok', async () => {
    // Simulate older schema where some tables don't exist (pre-v0.34 ish).
    // The check must not return "ok" when it couldn't actually check.
    const engine = makeMockEngine(async (sql: string) => {
      if (sql.includes('synthesis_evidence') || sql.includes('timeline_entries')) {
        throw new Error('relation does not exist');
      }
      return [{ n: 0 }];
    });
    const result = await childTableOrphansCheck(engine);
    // synthesis_evidence isn't in the target list (it FKs synthesis_page_id, not page_id)
    // — but timeline_entries IS. So one error in this test.
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Could not check');
    expect(result.message).toContain('FK-child tables');
  });

  test('orphans + some skipped tables → still reports orphans (errors don\'t mask findings)', async () => {
    // Mixed case: real orphans in one table, older schema missing another.
    // The check should report the real orphans, not get overridden by the
    // "could not check" warning shape.
    const engine = makeMockEngine(async (sql: string) => {
      if (sql.includes('content_chunks')) return [{ n: 234 }];
      if (sql.includes('timeline_entries')) throw new Error('relation does not exist');
      return [{ n: 0 }];
    });
    const result = await childTableOrphansCheck(engine);
    expect(result.status).toBe('warn');
    // The orphan branch wins over the error-only branch when both exist
    expect(result.message).toContain('234 orphan row(s)');
    expect(result.message).toContain('content_chunks.page_id=234');
  });

  test('all 10 target tables are queried (no silent drops)', async () => {
    const queriedTables = new Set<string>();
    const engine = makeMockEngine(async (sql: string) => {
      // Extract `FROM <table>` to verify every target gets visited
      const m = sql.match(/FROM (\w+) WHERE/);
      if (m) queriedTables.add(m[1]);
      return [{ n: 0 }];
    });
    await childTableOrphansCheck(engine);
    // 10 target rows, but links appears 3 times (from/to/origin) — so 8 unique tables
    const expectedTables = new Set([
      'content_chunks',
      'page_versions',
      'tags',
      'takes',
      'raw_data',
      'timeline_entries',
      'links',
      'files',
    ]);
    expect(queriedTables.size).toBe(expectedTables.size);
    for (const t of expectedTables) {
      expect(queriedTables.has(t)).toBe(true);
    }
  });
});
