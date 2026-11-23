/**
 * Belief ledger source probe: one SQL implementation for both engines.
 *
 * `readLedgerSource` is the read every transaction that commits canonical state starts with
 * (`beginBeliefBatch`), whether or not the source has belief coverage. The other belief SQL
 * (state reads, event appends, commit marks) stays in `src/core/belief/`.
 */
import { COVERAGE_KEY } from '../belief/keys.ts';
import type { BrainEngine } from '../engine.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { managedModeRowsJson } from './persistence-state.ts';

/** What the ledger knows about one source; the batch probe adds the managed-mode rows and the plan mode it replaced. */
export interface LedgerSource {
  incarnation: string;
  purgeEpoch: number;
  /** The newest coverage event other than `coverage.restored`, or null. */
  coverage: string | null;
  purgesPossible: boolean;
  managedRows?: Array<{ enabled: unknown }>;
  planModePrev?: string;
}

/**
 * Coverage and purge probes for one source, in one read; null for an unknown source. `batch` (a belief batch
 * beginning) also reads the managed mode and, when coverage is active, switches the transaction to generic plans
 * for the state read that follows (`set_config('plan_cache_mode', ..., true)`), returning the mode it replaced.
 */
export async function readLedgerSource(exec: LegacyUnscopedRead, sourceId: string, opts: { batch?: boolean } = {}): Promise<LedgerSource | null> {
  const batchHead = opts.batch ? sqlFragment`SELECT q.*, ${managedModeRowsJson} AS managed_rows, current_setting('plan_cache_mode') AS plan_mode_prev,
      set_config('plan_cache_mode', CASE WHEN q.coverage IS NOT NULL AND q.coverage <> 'coverage.stopped' THEN 'force_generic_plan'
        ELSE current_setting('plan_cache_mode') END, true) FROM (` : sqlFragment``;
  const batchTail = opts.batch ? trustedSql(') q') : trustedSql('');
  const { rows: [row] } = await exec.run<Record<string, unknown>>(sqlFragment`${batchHead}SELECT s.incarnation::text AS incarnation, s.purge_epoch,
      (SELECT e.event_type FROM belief_events e WHERE e.source_id = s.id AND e.subject_kind = 'coverage' AND e.subject_key = ${COVERAGE_KEY}
        AND e.source_incarnation = s.incarnation AND e.event_type <> 'coverage.restored' ORDER BY e.id DESC LIMIT 1) AS coverage,
      (s.purge_epoch > 0 OR EXISTS (SELECT 1 FROM fact_purges WHERE source_id = s.id) OR EXISTS (SELECT 1 FROM take_purges WHERE source_id = s.id)
        OR EXISTS (SELECT 1 FROM page_purges WHERE source_id = s.id)) AS purges
    FROM sources s WHERE s.id = ${sourceId}${batchTail}`);
  if (!row) return null;
  return { incarnation: String(row.incarnation), purgeEpoch: Number(row.purge_epoch), coverage: (row.coverage as string | null) ?? null,
    purgesPossible: row.purges === true,
    ...(opts.batch ? { managedRows: row.managed_rows as Array<{ enabled: unknown }>, planModePrev: String(row.plan_mode_prev) } : {}) };
}

/**
 * The sources with a belief event about `subjectKey` (`COVERAGE_KEY` for coverage) in their current incarnation, by id.
 * The statement `belief/coverage-report.ts` `coveredSources` sent through `executeRaw`.
 */
export async function listCoveredSources(tx: Pick<BrainEngine, 'executeRaw'>, subjectKey: string): Promise<string[]> {
  const rows = await tx.executeRaw<{ id: string }>(`SELECT s.id FROM sources s WHERE EXISTS (SELECT 1 FROM belief_events e
    WHERE e.source_id = s.id AND e.subject_kind = 'coverage' AND e.subject_key = $1 AND e.source_incarnation = s.incarnation) ORDER BY 1`, [subjectKey]);
  return rows.map(r => r.id);
}
