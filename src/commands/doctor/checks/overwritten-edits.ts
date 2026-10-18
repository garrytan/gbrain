/**
 * #6712 follow-up `sync_overwritten_db_edits` (BRAIN): live pages whose database-only edit an incremental managed sync
 * replaced with a committed file edit and no `file_drift` hold (the bug #6887 fixes, or any other unguarded import). Read-only;
 * per source it runs `scanOverwrittenEdits` (`persistence/overwritten-edits.ts`, at most `OVERWRITE_SCAN_LIMIT` candidate
 * versions, newest first) and reports each source's count and first slugs. `warn` only for `high` findings; `unknown`
 * ones (no persistence outcome on the writer's receipt, the import's content no longer readable, a segmented version)
 * are counted separately and never warn. The fix previews `gbrain repair overwritten-edits`, which writes nothing.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { scanOverwrittenEdits, type OverwriteSourceScan } from '../../../core/persistence/overwritten-edits.ts';

const DOCS = 'docs/guides/repair.md#overwritten-edits';
/** Slugs listed per source. */
const SLUGS_SHOWN = 10;

async function runOverwrittenEdits(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const sourceIds = ctx.sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const scans: OverwriteSourceScan[] = [];
    for (const sourceId of sourceIds) scans.push(await scanOverwrittenEdits(engine, sourceId));
    const high = scans.reduce((sum, scan) => sum + scan.high, 0);
    const unknown = scans.reduce((sum, scan) => sum + scan.unknown, 0);
    const details = { count: high, unknown, truncated: scans.some(scan => scan.truncated), docs: DOCS,
      sources: scans.filter(scan => scan.edits.length || scan.truncated).map(scan => ({ source_id: scan.source_id, count: scan.high, unknown: scan.unknown, truncated: scan.truncated,
        slugs: scan.edits.filter(edit => edit.confidence === 'high').slice(0, SLUGS_SHOWN).map(edit => edit.slug),
        unknown_slugs: scan.edits.filter(edit => edit.confidence === 'unknown').slice(0, SLUGS_SHOWN).map(edit => ({ slug: edit.slug, reason: edit.reason })) })) };
    const bounded = details.truncated ? ' (bounded scan: more candidate versions were not read)' : '';
    if (!high) {
      checks.push({ name: 'sync_overwritten_db_edits', status: 'ok', details,
        message: unknown ? `No page shows a database edit that a sync import provably overwrote; ${unknown} page(s) could not be classified (unknown, listed in details.sources[].unknown_slugs)${bounded}.`
          : `No page shows a database edit that a sync import overwrote${bounded}.` });
      return checks;
    }
    const found = scans.filter(scan => scan.high);
    const first = found[0]!;
    const sample = first.edits.find(edit => edit.confidence === 'high')!;
    const preview = ['gbrain', 'repair', 'overwritten-edits', '--source', first.source_id, '--json'];
    checks.push({ name: 'sync_overwritten_db_edits', status: 'warn', details,
      message: `${high} page(s) lost a database edit to an incremental sync that published a committed file edit over it without a file_drift hold `
        + `(${found.map(scan => `${scan.source_id}: ${scan.high}`).join('; ')}; e.g. ${found.flatMap(scan => scan.edits.filter(edit => edit.confidence === 'high').slice(0, 3).map(edit => `${scan.source_id}:${edit.slug}`)).slice(0, 5).join(', ')})`
        + `${unknown ? `; ${unknown} more could not be classified (unknown)` : ''}${bounded}. Each edit is still in the page's history. Preview the restore with `
        + `gbrain repair overwritten-edits --source ${first.source_id}; it shows both versions and writes nothing.`,
      fix: agentFix(preview, 'Lists each page with the database edit, the sync import that replaced it and a diff; it writes nothing. Restoring is the user\'s call.',
        'sync_overwritten_db_edits', { ask_user: true, docs: DOCS,
          user_message: `${high} page(s) (for example ${sample.slug}) had a database edit replaced by a later file edit during sync, with no warning. `
            + 'The edit is still in history. Should I show you both versions and restore the ones you want? A restored page keeps its committed file unchanged and that file is held until you choose a side.' }) });
  } catch (error) {
    checks.push(checkError('sync_overwritten_db_edits', 'check page history for database edits a sync import overwrote', error, { details: { count: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const overwrittenEditsEntry: DoctorEntry = { name: 'sync_overwritten_db_edits', emits: ['sync_overwritten_db_edits'], run: runOverwrittenEdits };
