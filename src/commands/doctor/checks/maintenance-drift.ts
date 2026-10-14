import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { auditConflictsCommand, FILE_DRIFT_MESSAGE, fileDriftRepairCommand, liveFileDrift, readDriftSkips } from '../../../core/persistence/drift-conflicts.ts';

/** Newest request sequences scanned for drift conflicts (one range read of the unique sequence index). */
const WINDOW = 20_000;
/** Distinct slugs checked live per source; the rest are reported as unchecked. */
const LIVE_LIMIT = 100;

/**
 * #6643 (B3): pages whose canonical file differs from the database right now,
 * found from the drift conflict receipts of the newest 20,000 request sequences
 * and checked live on the canonical owner host (at most 100 slugs per source),
 * plus the concept synthesis skips recorded in `dream.concepts.drift_skips`.
 * It measures the drift itself, not conflict-row growth: producers back off
 * before admission, so a drifted page stops adding receipts. Names the
 * read-only audit and the explicit-only `gbrain repair file-drift` preview.
 */
export async function maintenanceWriteDriftCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const docs = 'docs/guides/troubleshooting.md#maintenance-write-drift';
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const [bounds] = await engine.executeRaw<{ top: string | null }>('SELECT max(sequence)::text AS top FROM persistence_requests');
    const floor = String(Math.max(0, Number(bounds?.top ?? 0) - WINDOW));
    const skips = await readDriftSkips(engine);
    const rows = [];
    for (const sourceId of sources) {
      const candidates = await engine.executeRaw<{ slug: string }>(`SELECT DISTINCT r.slug FROM persistence_requests r
        WHERE r.sequence > $2::bigint AND r.source_id=$1 AND r.state='conflict' AND r.error_code='source_changed' AND r.error_message=$3
        ORDER BY r.slug LIMIT ${LIVE_LIMIT + 1}`, [sourceId, floor, FILE_DRIFT_MESSAGE]);
      const skipped = Object.keys(skips).filter(key => key.startsWith(`${sourceId}:`)).map(key => key.slice(sourceId.length + 1));
      const drifted = new Set<string>();
      let unknown = 0;
      for (const slug of [...new Set([...candidates.slice(0, LIVE_LIMIT).map(row => row.slug), ...skipped])].slice(0, LIVE_LIMIT)) {
        const live = await liveFileDrift(engine, sourceId, slug);
        if (live.still_present === true) drifted.add(slug);
        else if (live.still_present === null) unknown++;
      }
      if (drifted.size || skipped.length || unknown) rows.push({ source_id: sourceId, drifted: drifted.size, sample: [...drifted].slice(0, 5),
        concept_skips: skipped.length, unknown, unchecked: Math.max(0, candidates.length - LIVE_LIMIT) });
    }
    const count = rows.reduce((sum, row) => sum + row.drifted, 0);
    const skipCount = rows.reduce((sum, row) => sum + row.concept_skips, 0);
    const details = { count, concept_skips: skipCount, sources: rows, window_sequences: WINDOW, repair: 'file-drift', docs };
    if (!count && !skipCount) {
      const unknown = rows.reduce((sum, row) => sum + row.unknown, 0);
      return { name: 'maintenance_write_drift', status: 'ok', details,
        message: unknown ? `No page checked on this host has a canonical file that differs from the database; ${unknown} could not be checked here (run doctor on the canonical owner host).`
          : 'No page whose writes refuse source_changed still has a canonical file that differs from the database.' };
    }
    const first = rows.find(row => row.drifted || row.concept_skips)!.source_id;
    return { name: 'maintenance_write_drift', status: 'warn', details,
      message: `${count} page(s) have a canonical file that differs from the database, so every coordinated write to them refuses source_changed `
        + `(${rows.filter(row => row.drifted || row.concept_skips).map(row => `${row.source_id}: ${row.drifted} drifted, ${row.concept_skips} concept skip(s)`).join('; ')}). `
        + `Maintenance now skips them before spending or admitting anything. List them: ${auditConflictsCommand(first)}; preview the resolution: ${fileDriftRepairCommand(first)} (or --prefer database), then apply with the --expect hash it prints.`,
      fix: agentFix(['gbrain', 'sources', 'reconcile', first, '--brain', 'host', '--audit', '--conflicts', '--json'],
        'Read-only: lists the conflict receipts grouped by slug, whether each file still differs, its drift class and producer.', 'maintenance_write_drift', { docs }) };
  } catch (error) {
    return checkError('maintenance_write_drift', 'check file/database drift behind conflict receipts', error, { details: { count: 'unknown', docs } });
  }
}
