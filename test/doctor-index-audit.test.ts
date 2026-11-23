import { describe, expect, test } from 'bun:test';
import { summarizeIndexAudit, type IndexAuditCatalog } from '../src/commands/doctor/checks/index-audit.ts';

const catalog: IndexAuditCatalog = {
  indexes: 6,
  zero_scan_total: 4,
  write_enforcing_zero_scan: 2,
  empty_heap_zero_scan: 1,
  partition_parents: 1,
  unreviewed_zero_scan: 0,
  missing_counters: 0,
  unusable: 0,
  statistics_enabled: true,
  review_sample: [],
};

describe('index audit evidence', () => {
  test('reports all raw zeros when catalog checks explain the findings', () => {
    const check = summarizeIndexAudit(catalog);
    expect(check.status).toBe('ok');
    expect(check.details).toEqual({ ...catalog });
    expect(check.message).toContain('4 zero-scan index(es)');
  });

  test('keeps a workload warning for an ordinary index on a populated relation', () => {
    const check = summarizeIndexAudit({
      ...catalog, empty_heap_zero_scan: 0, unreviewed_zero_scan: 1, review_sample: ['fixture_lookup'],
    });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 zero-scan index(es) still require workload evidence');
    expect(check.details?.review_sample).toEqual(['fixture_lookup']);
  });

  test('warns for unusable catalog entries even if there are no zero scans', () => {
    const check = summarizeIndexAudit({
      ...catalog, zero_scan_total: 0, write_enforcing_zero_scan: 0, empty_heap_zero_scan: 0, unusable: 1,
    });
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 unusable index(es)');
  });

  test.each([{ statistics_enabled: false }, { missing_counters: 1 }])(
    'keeps unavailable statistics outside acceptance (%p)',
    unavailable => {
      const check = summarizeIndexAudit({ ...catalog, ...unavailable });
      expect(check.status).toBe('warn');
      expect(check.details?.health).toBe('unknown');
    },
  );
});
