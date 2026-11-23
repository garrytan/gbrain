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

export function summarizeIndexAudit(
  catalog: IndexAuditCatalog, evidence?: { open: { name: string }[]; proven: number; receipt?: string },
): Check {
  const { zero_scan_total: total, write_enforcing_zero_scan: enforcing, empty_heap_zero_scan: empty,
          unreviewed_zero_scan: withoutCatalogProof, missing_counters: missing, unusable, statistics_enabled: enabled } = catalog;
  const review = evidence?.open.length ?? withoutCatalogProof;
  const proven = evidence?.proven ?? 0;
  const warnings = [
    unusable ? `${unusable} unusable index(es)` : null,
    !enabled ? 'PostgreSQL index statistics are disabled in this session' : null,
    missing ? `${missing} physical index(es) lack a counter` : null,
    review ? `${review} zero-scan index(es) still require workload evidence` : null,
  ].filter(Boolean);
  const observed = `${total} zero-scan index(es), including ${enforcing} write-enforcing and ${empty} on empty heap tables.`;
  const workload = proven ? ` ${proven} zero-scan index(es) have matching retained workload evidence.` : '';
  return {
    name: NAME,
    status: warnings.length ? 'warn' : 'ok',
    details: { ...catalog,
      ...(evidence ? { workload_proven_zero_scan: proven, unresolved_zero_scan: review, unresolved_sample: evidence.open.map(index => index.name).sort().slice(0, 20),
        workload_receipt_sha256: evidence.receipt ?? null } : {}),
      ...(!enabled || missing ? { health: 'unknown' } : {}) },
    message: warnings.length
      ? `${observed}${workload} ${warnings.join('; ')}. Inspect the catalog and workload before removing any index.`
      : `${observed}${workload}`,
  };
}
