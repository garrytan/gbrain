/**
 * #7891 `provenance_stamp_drift` (BRAIN): pages whose provenance stamps (`source_kind`, `ingested_via`, `ingested_at`)
 * a write rewrote, or whose lowering marker a write removed, before #7892 made the stamps server-owned, and classified
 * pages whose file would re-read above their stored tier (#7918). Read-only; per source it runs `scanProvenanceDrift`
 * (trust/provenance-drift.ts, at most `DRIFT_SCAN_LIMIT` live pages). `warn` when a remote or unattributed write did
 * the damage or a marker is missing; the owner's own edits are listed in details only. Pages a later local edit changed
 * again (needs_review, #10190) have no repair target: they are named and never offered the repair, and hold the check
 * at warn only while their file lacks the lowering marker their stored tier needs (lost to a remote write, or missing). The fix previews
 * `gbrain repair provenance`, which writes nothing; applying it only lowers trust and is the user's call.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { scanProvenanceDrift, type SourceDrift } from '../../../core/trust/provenance-drift.ts';

const DOCS = 'docs/guides/repair.md#provenance';

async function runProvenanceStampDrift(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const sourceIds = ctx.sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const scans: SourceDrift[] = [];
    for (const sourceId of sourceIds) scans.push(await scanProvenanceDrift(engine, sourceId));
    // #10190: a needs_review page (a later local edit changed the stamp again) has no repair target: it is named and never
    // offered the repair. It holds the check at warn while its file would re-read above its stored tier (marker_lost or marker_missing).
    const pick = (scan: SourceDrift, kind: 'repair' | 'exposed' | 'named') => scan.items.filter(item => item.verdict.class !== 'local'
      && (item.verdict.class !== 'needs_review' ? kind === 'repair' : (item.verdict.marker_lost || item.verdict.marker_missing ? 'exposed' : 'named') === kind));
    const pages = (scan: SourceDrift) => pick(scan, 'repair').length;
    const manual = scans.flatMap(scan => [...pick(scan, 'exposed'), ...pick(scan, 'named')].map(item => `${scan.source_id}:${item.slug}`));
    const exposed = scans.reduce((sum, scan) => sum + pick(scan, 'exposed').length, 0);
    const manualNote = manual.length ? `${manual.length} page(s) need manual review: a later local edit changed the same stamp again, so no automatic repair applies `
      + `(${manual.slice(0, 5).join(', ')}${manual.length > 5 ? ', ...' : ''}). ` : '';
    const details = { docs: DOCS, truncated: scans.some(scan => scan.truncated),
      sources: scans.filter(scan => scan.items.length || scan.truncated || scan.schema !== 'current').map(({ items, ...scan }) => ({ ...scan, pages: items.filter(item => item.verdict.class !== 'local').length })) };
    const bounded = details.truncated ? ' (bounded scan: more pages were not read)' : '';
    const found = scans.filter(scan => pages(scan) > 0);
    if (!found.length && !exposed) {
      const local = scans.reduce((sum, scan) => sum + scan.items.filter(item => item.verdict.class === 'local').length, 0);
      checks.push({ name: 'provenance_stamp_drift', status: 'ok', details,
        message: `No page has provenance stamps or a trust marker that another writer removed${manual.length ? ' and gbrain can put back' : ''}${local ? `; ${local} page(s) changed them in the owner's own edits (listed in details)` : ''}${bounded}. ${manualNote}`.trimEnd() });
      return checks;
    }
    const exposedNote = exposed ? `${exposed} of them lack the lowering trust marker their stored tier needs, so a re-read may trust them more than it should; edit those pages by hand. ` : '';
    if (!found.length) {
      checks.push({ name: 'provenance_stamp_drift', status: 'warn', details, message: `${manualNote}${exposedNote}`.trimEnd() + bounded });
      return checks;
    }
    const total = found.reduce((sum, scan) => sum + pages(scan), 0);
    const first = found[0]!;
    const sample = pick(first, 'repair')[0]!;
    const preview = ['gbrain', 'repair', 'provenance', '--source', first.source_id, '--json'];
    checks.push({ name: 'provenance_stamp_drift', status: 'warn', details,
      message: `${total} page(s) carry provenance stamps or a trust marker that a write removed before stamps became server-owned, or would re-read above their stored tier `
        + `(${found.map(scan => `${scan.source_id}: ${pages(scan)}`).join('; ')}; e.g. ${found.flatMap(scan => pick(scan, 'repair').slice(0, 3).map(item => `${scan.source_id}:${item.slug}`)).slice(0, 5).join(', ')})${bounded}. `
        + `${manualNote}${exposedNote}Preview the repair with gbrain repair provenance --source ${first.source_id}; it lists each page and writes nothing. Applying it only lowers trust.`,
      fix: agentFix(preview, 'Lists each page with the stamps, marker and tier before and after; it writes nothing. Applying the repair is the user\'s call.',
        'provenance_stamp_drift', { ask_user: true, docs: DOCS,
          user_message: `${total} page(s) (for example ${sample.slug}) lost the record of where they came from, so gbrain may trust them more than it should. `
            + 'Should I show you the list and put the original record back? It only lowers trust, and you can undo each page in gbrain trust review.' }) });
  } catch (error) {
    checks.push(checkError('provenance_stamp_drift', 'check page history for provenance stamps and trust markers a write removed', error, { details: { docs: DOCS } }));
  }
  return checks;
}

export const provenanceStampDriftEntry: DoctorEntry = { name: 'provenance_stamp_drift', emits: ['provenance_stamp_drift'], run: runProvenanceStampDrift };
