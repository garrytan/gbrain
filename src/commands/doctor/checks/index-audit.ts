import type { Check } from '../../doctor.ts';

const NAME = 'index_audit';

export interface IndexAuditCatalog {
  indexes: number;
  zero_scan_total: number;
  write_enforcing_zero_scan: number;
  empty_heap_zero_scan: number;
  partition_parents: number;
  unreviewed_zero_scan: number;
  missing_counters: number;
  unusable: number;
  statistics_enabled: boolean;
  review_sample: string[];
}

export function summarizeIndexAudit(catalog: IndexAuditCatalog): Check {
  const { zero_scan_total: total, write_enforcing_zero_scan: enforcing, empty_heap_zero_scan: empty,
          unreviewed_zero_scan: review, missing_counters: missing, unusable, statistics_enabled: enabled } = catalog;
  const warnings = [
    unusable ? `${unusable} unusable index(es)` : null,
    !enabled ? 'PostgreSQL index statistics are disabled in this session' : null,
    missing ? `${missing} physical index(es) lack a counter` : null,
    review ? `${review} zero-scan index(es) still require workload evidence` : null,
  ].filter(Boolean);
  const observed = `${total} zero-scan index(es), including ${enforcing} write-enforcing and ${empty} on empty heap tables.`;
  return {
    name: NAME,
    status: warnings.length ? 'warn' : 'ok',
    details: { ...catalog, ...(!enabled || missing ? { health: 'unknown' } : {}) },
    message: warnings.length
      ? `${observed} ${warnings.join('; ')}. Inspect the catalog and workload before removing any index.`
      : `${observed} All current findings are supported by the PostgreSQL catalog.`,
  };
}
