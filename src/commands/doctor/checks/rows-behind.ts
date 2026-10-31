/**
 * #8071 `sync_rows_behind_checkpoint`: live pages of a managed source whose row holds an older version of its file than
 * the source's sync checkpoint (`sources.last_commit`) says was imported, with no hold (`persistence/rows-behind.ts`).
 * Landing checks pass such a row (it exists and is not held); this one compares its content with the file read from Git
 * at the checkpoint commit and confirms the difference with the importer.
 *
 * warn when any source has a `behind` row: per-source counts, the first slugs and the read-only preview
 * `gbrain repair rows-behind --source <id>`. Rows with no import record (`unproven`) are counted from the content comparison
 * alone (no importer confirmation) and never warn. ok when
 * every source read completely and none is behind; a scan the budget stopped, or a checkout Git cannot read, is info
 * `unknown` (never a clean ok). Not applicable (ok, info) on a brain without managed sync, a source without a checkout or
 * checkpoint (a repo-less brain) and off the owner host. Bounded by `GBRAIN_DOCTOR_ROWS_BEHIND_TIMEOUT_MS` (default 10 s)
 * and the entry's deadline. Read-only.
 */
import type { Check } from '../../doctor.ts';
import { scanDeadline } from '../budget.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { ROWS_BEHIND_DOCS, scanRowsBehind, type RowsBehindScan } from '../../../core/persistence/rows-behind.ts';

const SAMPLES = 10;

/** `GBRAIN_DOCTOR_ROWS_BEHIND_TIMEOUT_MS` (default 10 s): the wall-clock bound of the scan across every source. */
export function rowsBehindScanTimeoutMs(): number {
  const n = parseInt(process.env.GBRAIN_DOCTOR_ROWS_BEHIND_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

async function runRowsBehind(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const deadlineAt = scanDeadline(ctx, rowsBehindScanTimeoutMs());
    const ids = doctorSourceIds(ctx) ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const scans: RowsBehindScan[] = [];
    for (const id of ids) scans.push(await scanRowsBehind(engine, id, { deadlineAt, confirmUnproven: false }));
    const known = scans.filter(scan => scan.status === 'known');
    const count = known.reduce((sum, scan) => sum + scan.behind_count, 0);
    const unproven = known.reduce((sum, scan) => sum + scan.unproven_count, 0);
    const partial = known.filter(scan => !scan.complete);
    const unknown = scans.filter(scan => scan.status === 'unknown');
    const details = { count, unproven, docs: ROWS_BEHIND_DOCS, timeout_ms: rowsBehindScanTimeoutMs(),
      sources: scans.map(scan => ({ source_id: scan.source_id, status: scan.status, ...(scan.reason ? { reason: scan.reason } : {}), checkpoint: scan.checkpoint, complete: scan.complete, stopped_at: scan.stopped_at,
        pages: scan.pages, behind: scan.behind_count, unproven: scan.unproven_count, counts: scan.counts,
        samples: (ctx.remote ? [] : scan.behind).slice(0, SAMPLES).map(row => row.slug), unproven_samples: (ctx.remote ? [] : scan.unproven).slice(0, SAMPLES).map(row => row.slug) })) };
    const unprovenNote = unproven ? ` ${unproven} more row(s) differ from their checkpoint file but have no import record, so the side that moved is unknown; gbrain repair rows-behind --source <id> --include-ambiguous lists and re-imports them, which replaces any database-only edit those rows hold.` : '';
    if (count) {
      const found = known.filter(scan => scan.behind_count);
      checks.push({ name: 'sync_rows_behind_checkpoint', status: 'warn', details,
        message: `${count}${partial.length ? '+' : ''} page(s) hold an older version of their file than the sync checkpoint says was imported, with no hold `
          + `(${found.map(scan => `${scan.source_id}: ${scan.behind_count}${ctx.remote ? '' : `, e.g. ${scan.behind.slice(0, 3).map(row => row.slug).join(', ')}`}`).join('; ')}). `
          + `Search and reads return the old text, and no later sync re-imports them. Preview the re-import with gbrain repair rows-behind --source ${found[0]!.source_id}; it writes nothing.${unprovenNote}`,
        fix: agentFix(['gbrain', 'repair', 'rows-behind', '--source', found[0]!.source_id, '--json'],
          'Read-only preview: lists each row behind its checkpoint file and what the re-import would do (or the hold it would open), and prints the apply command with its hash.',
          'sync_rows_behind_checkpoint', { docs: ROWS_BEHIND_DOCS }) });
      return checks;
    }
    if (unknown.length || partial.length) {
      checks.push(infoCheck('sync_rows_behind_checkpoint', `Rows behind the sync checkpoint are unknown for ${[...unknown.map(scan => `${scan.source_id} (${scan.reason})`),
        ...partial.map(scan => `${scan.source_id} (stopped after ${scan.pages} page(s)${scan.stopped_at !== null ? ` at page id ${scan.stopped_at}` : ''} at the ${details.timeout_ms / 1000} s budget)`)].join(', ')}; this is not a clean result. `
        + `The full read: gbrain repair rows-behind --source <id> (writes nothing).${unprovenNote}`, 'unknown', undefined, details));
      return checks;
    }
    if (!known.length) {
      const reasons = [...new Set(scans.map(scan => scan.reason ?? 'not_applicable'))];
      checks.push(infoCheck('sync_rows_behind_checkpoint', reasons.includes('not_owner_host')
        ? 'Not applicable on this host: rows are compared with the checkpoint commit in each source\'s checkout on its canonical owner host (run doctor there).'
        : 'Not applicable: no managed source has a checkout and a sync checkpoint here (a repo-less brain keeps its pages in the database, which is the record).',
        'not_applicable', undefined, { ...details, reasons }));
      return checks;
    }
    checks.push({ name: 'sync_rows_behind_checkpoint', status: 'ok', details,
      message: `Every file-backed page holds its file as of the sync checkpoint (${known.reduce((sum, scan) => sum + scan.pages, 0)} page(s) read).${unprovenNote}` });
  } catch (error) {
    checks.push(checkError('sync_rows_behind_checkpoint', 'compare pages with their files at the sync checkpoint', error, { details: { count: 'unknown', docs: ROWS_BEHIND_DOCS } }));
  }
  return checks;
}

export const rowsBehindEntry: DoctorEntry = { name: 'sync_rows_behind_checkpoint', emits: ['sync_rows_behind_checkpoint'], run: runRowsBehind };
