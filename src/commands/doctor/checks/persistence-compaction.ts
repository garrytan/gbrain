import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';
import { COMPACTION_STALE_HOURS_KEY, DEFAULT_COMPACTION_STALE_HOURS, readLastCompaction } from '../../../core/persistence/compaction-pass.ts';
import { TRUE_UP_CLAMPED_KEY } from '../../../core/persistence/receipt-bytes.ts';

const COMPACTION_DOCS = 'docs/guides/repair.md#receipt-compaction';
const DRIFT_DOCS = 'docs/guides/concurrent-writes.md#counter-drift';

/**
 * #6696 (A11): receipt compaction is how receipt bytes come back, and it runs
 * on a resident consumer's idle and volume ticks. Warns when a full consumer
 * has been up longer than `persistence.maintenance.compaction_stale_hours`
 * (24) and no pass was recorded within that window; ok with no live consumer
 * (nothing is expected to compact) and on a fresh brain.
 */
/** GBRA-130 A-14: a pass that compacted nothing names what it skipped (a fresh record is not proof bytes came back). */
const skippedNote = (last: { compacted: number; skipped_by_reason?: Record<string, number> }) => {
  const skipped = Object.entries(last.skipped_by_reason ?? {}).map(([reason, n]) => `${reason}: ${n}`);
  return last.compacted === 0 && skipped.length ? `; it skipped ${skipped.join(', ')}` : '';
};
export async function checkPersistenceCompaction(engine: BrainEngine): Promise<Check> {
  try {
    const [consumers] = await engine.executeRaw<{ live: string; oldest_hours: number | null }>(`SELECT count(DISTINCT host_id)::text AS live,
        (EXTRACT(EPOCH FROM now()-min(started_at))/3600)::float8 AS oldest_hours
      FROM persistence_consumers WHERE mode IN ('full','promoted') AND renewed_at > now()-interval '5 minutes'`);
    const staleRaw = Number(await engine.getConfig(COMPACTION_STALE_HOURS_KEY));
    const staleHours = Number.isFinite(staleRaw) && staleRaw > 0 ? staleRaw : DEFAULT_COMPACTION_STALE_HOURS;
    const last = await readLastCompaction(engine);
    const ageHours = last ? (Date.now() - Date.parse(last.at)) / 3_600_000 : null;
    const details = { live_consumers: Number(consumers?.live ?? 0), stale_hours: staleHours, last_compaction: last,
      last_compaction_age_hours: ageHours === null ? null : Math.floor(ageHours), docs: COMPACTION_DOCS };
    const overdue = details.live_consumers > 0 && Number(consumers?.oldest_hours ?? 0) > staleHours && (ageHours === null || ageHours > staleHours);
    if (!overdue) return { name: 'persistence_compaction', status: 'ok', details,
      message: last ? `Receipt compaction last ran ${details.last_compaction_age_hours} hour(s) ago (compacted ${last.compacted}, freed ${last.freed_bytes} bytes${skippedNote(last)}).`
        : 'No receipt compaction recorded yet; a resident consumer compacts receipts past the retention window on its idle ticks.' };
    return { name: 'persistence_compaction', status: 'warn', details,
      message: `A resident consumer has run for over ${staleHours} hours but ${last ? `the last receipt compaction was ${details.last_compaction_age_hours} hours ago` : 'no receipt compaction was recorded'}, `
        + 'so receipt bytes are not coming back. Check the consumer (gbrain sources writer status --json), and preview an on-demand pass with gbrain repair receipt-compaction --json.',
      fix: { argv: ['gbrain', 'repair', 'receipt-compaction', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify: doctorVerify('persistence_compaction'),
        docs: COMPACTION_DOCS, why: 'Previews compacting the receipts past the retention window; it writes nothing.' } };
  } catch (error) {
    return { name: 'persistence_compaction', status: 'warn', message: `Receipt compaction state could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown' } };
  }
}

/**
 * #6696 (A10): the receipt-bytes counters must equal what the receipts reserve
 * (`terminal_reservation` per request, plus lifecycle receipts) per principal
 * and brain-wide. Read-only, one statement (one snapshot); also reports how
 * many true-up decrements were clamped at zero (`persistence.true_up.clamped`).
 * #6759: each drifting scope names its direction (a positive delta is a
 * bounded overcharge of write capacity, a negative one under-counts) and the
 * receipts behind it by kind; the comparison is live, so a warn's incident is
 * current.
 */
export async function checkPersistenceCounterDrift(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ key: string; counter: string; req_rows: string; req_bytes: string; topo_rows: string; topo_bytes: string; clamped: string | null }>(`WITH u AS (
          SELECT 'principal:'||principal_kind||':'||principal_id AS key,'requests' AS kind,terminal_reservation AS bytes FROM persistence_requests
          UNION ALL SELECT 'principal:local_cli:'||principal_id::text,'topology_changes',terminal_bytes FROM persistence_topology_changes),
      s AS (SELECT key,count(*) FILTER (WHERE kind='requests') AS req_rows,COALESCE(SUM(bytes) FILTER (WHERE kind='requests'),0) AS req_bytes,
          count(*) FILTER (WHERE kind='topology_changes') AS topo_rows,COALESCE(SUM(bytes) FILTER (WHERE kind='topology_changes'),0) AS topo_bytes FROM u GROUP BY key),
      every AS (SELECT * FROM s UNION ALL SELECT 'brain',COALESCE(SUM(req_rows),0),COALESCE(SUM(req_bytes),0),COALESCE(SUM(topo_rows),0),COALESCE(SUM(topo_bytes),0) FROM s)
      SELECT c.key,c.terminal_bytes::text AS counter,COALESCE(e.req_rows,0)::text AS req_rows,COALESCE(e.req_bytes,0)::text AS req_bytes,
        COALESCE(e.topo_rows,0)::text AS topo_rows,COALESCE(e.topo_bytes,0)::text AS topo_bytes,(SELECT value FROM config WHERE key=$1) AS clamped
      FROM persistence_counters c LEFT JOIN every e ON e.key=c.key WHERE c.key='brain' OR c.key LIKE 'principal:%' ORDER BY c.key`, [TRUE_UP_CLAMPED_KEY]);
    const clamped = Number(rows[0]?.clamped ?? 0) || 0;
    const drift = rows.map(row => {
      const receipts = Number(row.req_bytes) + Number(row.topo_bytes);
      const delta = Number(row.counter) - receipts;
      return { scope: row.key, counter: Number(row.counter), receipts, delta, direction: delta > 0 ? 'overcharge' : 'undercount',
        receipts_by_kind: { requests: { rows: Number(row.req_rows), bytes: Number(row.req_bytes) }, topology_changes: { rows: Number(row.topo_rows), bytes: Number(row.topo_bytes) } } };
    }).filter(row => row.delta !== 0);
    const details = { inspected: rows.length, drift, true_up_clamped: clamped, docs: DRIFT_DOCS };
    if (!drift.length) return { name: 'persistence_counter_drift', status: 'ok', details,
      message: `Receipt-bytes counters match the receipts they account for (${rows.length} scope(s))${clamped ? `; ${clamped} true-up decrement(s) were clamped at zero earlier` : ''}.` };
    return { name: 'persistence_counter_drift', status: 'warn', details: { ...details, incident: { scope: 'current', since: null } },
      message: `Receipt-bytes counters differ from the receipts they account for: ${drift.map(row => `${row.scope} counter ${row.counter} vs receipts ${row.receipts} (${row.delta > 0 ? '+' : ''}${row.delta}): `
          + (row.delta > 0 ? `a bounded overcharge of ${row.delta} bytes` : `under-counts by ${-row.delta} bytes`)).join('; ')}. `
        + (drift.some(row => row.delta > 0) ? 'An overcharge holds back write capacity no receipt uses; no data is lost. ' : '')
        + (drift.some(row => row.delta < 0) ? 'An under-count lets writes use capacity the receipts already reserve. ' : '')
        + `${clamped ? `${clamped} true-up decrement(s) were clamped at zero. ` : ''}`
        + 'Nothing is changed by this check; details.drift lists the receipts behind each scope by kind. Report it with gbrain doctor --only persistence_counter_drift --json.' };
  } catch (error) {
    return { name: 'persistence_counter_drift', status: 'warn', message: `Receipt-bytes counters could not be compared: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown' } };
  }
}
