/**
 * #7891 `provenance_stamp_drift` (BRAIN): pages whose provenance stamps (`source_kind`, `ingested_via`, `ingested_at`)
 * a write rewrote, or whose lowering marker a write removed, before #7892 made the stamps server-owned, and classified
 * pages whose file would re-read above their stored tier (#7918). Read-only; per source it runs `scanProvenanceDrift`
 * (trust/provenance-drift.ts, at most `DRIFT_SCAN_LIMIT` live pages). `warn` when a remote or unattributed write did
 * the damage or a marker is missing; the owner's own edits are listed in details only. The fix previews
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
    const damaged = (scan: SourceDrift) => scan.marker_lost.remote + scan.marker_lost.unattributed + scan.stamps_rewritten.remote
      + scan.stamps_rewritten.unattributed + scan.marker_missing + scan.needs_review;
    const pages = (scan: SourceDrift) => scan.items.filter(item => item.verdict.class !== 'local').length;
    const details = { docs: DOCS, truncated: scans.some(scan => scan.truncated),
      sources: scans.filter(scan => scan.items.length || scan.truncated || scan.schema !== 'current').map(({ items, ...scan }) => ({ ...scan, pages: items.filter(item => item.verdict.class !== 'local').length })) };
    const bounded = details.truncated ? ' (bounded scan: more pages were not read)' : '';
    const found = scans.filter(damaged);
    if (!found.length) {
      const local = scans.reduce((sum, scan) => sum + scan.items.length, 0);
      checks.push({ name: 'provenance_stamp_drift', status: 'ok', details,
        message: `No page has provenance stamps or a trust marker that another writer removed${local ? `; ${local} page(s) changed them in the owner's own edits (listed in details)` : ''}${bounded}.` });
      return checks;
    }
    const total = found.reduce((sum, scan) => sum + pages(scan), 0);
    const first = found[0]!;
    const sample = first.items.find(item => item.verdict.class !== 'local')!;
    const preview = ['gbrain', 'repair', 'provenance', '--source', first.source_id, '--json'];
    checks.push({ name: 'provenance_stamp_drift', status: 'warn', details,
      message: `${total} page(s) carry provenance stamps or a trust marker that a write removed before stamps became server-owned, or would re-read above their stored tier `
        + `(${found.map(scan => `${scan.source_id}: ${pages(scan)}`).join('; ')}; e.g. ${found.flatMap(scan => scan.items.filter(item => item.verdict.class !== 'local').slice(0, 3).map(item => `${scan.source_id}:${item.slug}`)).slice(0, 5).join(', ')})${bounded}. `
        + `Preview the repair with gbrain repair provenance --source ${first.source_id}; it lists each page and writes nothing. Applying it only lowers trust.`,
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
