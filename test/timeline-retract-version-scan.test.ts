import { describe, expect, test } from 'bun:test';
import { retractRemovedTimelineEntries, type StoredTimelineTuple } from '../src/core/timeline-extract.ts';

describe('retractRemovedTimelineEntries version scan', () => {
  test('does not DISTINCT-compare whole version bodies in one statement', async () => {
    const statements: string[] = [];
    const bodies = new Map<number, string>([[1, '- **2024-01-02** | Old fact']]);
    const engine = {
      executeRaw: async (sql: string, params: unknown[] = []) => {
        statements.push(sql);
        if (/SELECT DISTINCT/i.test(sql) && /FROM page_versions/.test(sql)) {
          return [{ compiled_truth: bodies.get(1), timeline: null, body_storage: 'inline', page_id: 1, generation: null }];
        }
        if (/FROM page_versions/.test(sql) && /WHERE v?\.?id = \$1/.test(sql)) {
          return [{ compiled_truth: bodies.get(Number(params[0])), timeline: null }];
        }
        if (/FROM page_versions/.test(sql)) return [{ id: 1, body_storage: 'inline', page_id: 1, generation: null }];
        return [];
      },
      readManifest: async () => null,
      readSegmentTexts: async () => [],
    };
    const stored = [{ id: 7, date: '2024-01-02', summary: 'Old fact', source: '', detail: null }] as unknown as StoredTimelineTuple[];
    await retractRemovedTimelineEntries(engine as never, 'people/a', 'default', 'no timeline here', { dryRun: true, storedRows: stored });
    const scans = statements.filter(sql => /FROM page_versions/.test(sql));
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.some(sql => /DISTINCT/i.test(sql))).toBe(false);
  });
});
