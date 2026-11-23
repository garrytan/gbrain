import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import type { Check } from '../../doctor.ts';

const NAME = 'index_audit';

/** Keep the raw zero counts, but distinguish catalog evidence from absence of read statistics. */
export const INDEX_AUDIT_SQL = `
  WITH catalog AS (
    SELECT i.relname AS name, a.idx_scan AS scans,
           x.indisvalid AND x.indisready AND x.indislive AS usable,
           x.indisunique OR x.indisexclusion AS enforces_writes,
           CASE WHEN a.idx_scan = 0 AND t.relkind = 'r' AND am.amname = 'heap'
                THEN pg_relation_size(t.oid, 'main') = 0 ELSE false END AS empty_heap,
           i.relkind = 'i' AS physical
    FROM pg_catalog.pg_index x
    JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
    LEFT JOIN pg_catalog.pg_am am ON am.oid = t.relam
    LEFT JOIN pg_catalog.pg_stat_user_indexes a ON a.indexrelid = i.oid
    WHERE n.nspname = 'public'
  ), classified AS (
    SELECT name, scans, CASE
      WHEN NOT usable THEN 'unusable'
      WHEN NOT physical THEN 'partition_parent'
      WHEN scans IS NULL THEN 'missing_counter'
      WHEN scans > 0 THEN 'observed'
      WHEN enforces_writes THEN 'write_enforcing'
      WHEN empty_heap THEN 'empty_heap'
      ELSE 'unreviewed'
    END AS state
    FROM catalog
  )
  SELECT count(*)::int AS indexes,
         count(*) FILTER (WHERE scans = 0)::int AS zero_scan_total,
         count(*) FILTER (WHERE state = 'write_enforcing')::int AS write_enforcing_zero_scan,
         count(*) FILTER (WHERE state = 'empty_heap')::int AS empty_heap_zero_scan,
         count(*) FILTER (WHERE state = 'partition_parent')::int AS partition_parents,
         count(*) FILTER (WHERE state = 'unreviewed')::int AS unreviewed_zero_scan,
         count(*) FILTER (WHERE state = 'missing_counter')::int AS missing_counters,
         count(*) FILTER (WHERE state = 'unusable')::int AS unusable,
         current_setting('track_counts') = 'on' AS statistics_enabled,
         ARRAY(SELECT name FROM classified WHERE state IN ('unusable','missing_counter','unreviewed')
               ORDER BY CASE state WHEN 'unusable' THEN 0 WHEN 'missing_counter' THEN 1 ELSE 2 END, name
               LIMIT 20) AS review_sample
  FROM classified`;

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

async function runIndexAudit(ctx: DoctorContext): Promise<Check[]> {
  if (!ctx.args.includes('--index-audit')) return [];
  ctx.progress.heartbeat(NAME);
  const engine = connectedEngine(ctx);
  if (engine.kind === 'pglite') return [{
    name: NAME, status: 'ok', message: 'Skipped (PGLite — pg_stat_user_indexes is a Postgres extension)',
  }];
  try {
    const [catalog] = await engine.executeRaw<IndexAuditCatalog>(INDEX_AUDIT_SQL);
    if (!catalog) throw new Error('PostgreSQL did not return an index catalog census');
    return [summarizeIndexAudit(catalog)];
  } catch (error) {
    return [checkError(NAME, 'read the PostgreSQL index catalog', error, { details: { health: 'unknown' } })];
  }
}

export const indexAuditEntry: DoctorEntry = {
  name: NAME,
  emits: [NAME],
  run: runIndexAudit,
};
