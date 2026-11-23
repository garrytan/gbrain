/**
 * GBRA-150 `sync_landing_gaps`: pages a managed sync committed more than the source's freshness target ago
 * (`sync.freshness_target_seconds`, 300 s) that search still cannot fully see: chunks with no vector, no chunk rows,
 * quarantined, or removed by a write outside sync after it synced (`persistence/landing-gaps.ts`). Bounded reads only
 * (the last 24 h of receipts, at most 2,000 per source), so it is a cheap incident check that runs before the full scans
 * and still answers on a brain whose default doctor run cannot finish.
 *
 * ok when no bound source has a gap; warn naming each source's gaps and the first page's fix (the paid catch-up drain
 * for vectors asks first); info when a read did not answer (unknown, never ok) or no managed source is bound.
 */
import type { Check } from '../../doctor.ts';
import { infoCheck } from '../check-fix.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { managedPersistenceEnabled } from '../../../core/persistence/ownership.ts';
import { readLandingGaps, type LandingGaps } from '../../../core/persistence/landing-gaps.ts';

const DOCS = 'docs/guides/resolve-paths.md#synced-but-not-searchable';

async function runLandingGaps(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const engine = connectedEngine(ctx);
  if (!(await managedPersistenceEnabled(engine))) {
    checks.push(infoCheck('sync_landing_gaps', 'Not applicable: managed persistence is off, so no sync receipts say when a page landed.', 'not_applicable', undefined, { docs: DOCS }));
    return checks;
  }
  const sources = (await engine.executeRaw<{ id: string }>(`SELECT s.id FROM sources s WHERE s.archived IS NOT TRUE
      AND EXISTS (SELECT 1 FROM persistence_source_bindings b WHERE b.source_id=s.id AND b.source_incarnation=s.incarnation)
      AND ($1::text[] IS NULL OR s.id=ANY($1::text[])) ORDER BY s.id COLLATE "C"`, [doctorSourceIds(ctx) ?? null])).map(row => row.id);
  const read: Array<{ source_id: string; gaps: LandingGaps }> = [];
  for (const id of sources) read.push({ source_id: id, gaps: await readLandingGaps(engine, id) });
  const details = { docs: DOCS, sources: read.map(({ source_id, gaps }) => ({ source_id, ...gaps })) };
  const found = read.filter(entry => entry.gaps.status === 'ok' && entry.gaps.gaps > 0);
  if (found.length) {
    const first = found[0]!.gaps.status === 'ok' ? found[0]!.gaps.pages.find(page => page.fix) : undefined;
    const lines = found.map(({ source_id, gaps }) => gaps.status === 'ok'
      ? `${source_id}: ${gaps.gaps} page(s) (${Object.entries(gaps.by_state).map(([state, n]) => `${state} ${n}`).join(', ')}; e.g. ${gaps.pages.slice(0, 3).map(page => `${page.slug} [${page.state}]`).join(', ')})` : '');
    checks.push({ name: 'sync_landing_gaps', status: 'warn', details, ...(first?.fix ? { fix: first.fix } : { fix_unavailable_reason: 'operator_judgement' as const }),
      message: `Pages synced more than their freshness target ago are not fully searchable: ${lines.join('; ')}. `
        + 'pending_embedding pages are found by keyword but not by vector search; chunkless pages have no searchable body; quarantined pages are hidden; page_missing pages were removed outside sync. '
        + `gbrain sync status --source <id> --detail --json lists each page with its fix.` });
    return checks;
  }
  const unknown = read.filter(entry => entry.gaps.status === 'unknown');
  if (unknown.length) {
    checks.push(infoCheck('sync_landing_gaps', `Landing gaps are unknown for ${unknown.map(entry => `${entry.source_id} (${entry.gaps.status === 'unknown' ? entry.gaps.reason : ''})`).join(', ')}; this is not a clean result.`,
      'unknown', undefined, details));
    return checks;
  }
  if (!read.some(entry => entry.gaps.status === 'ok')) {
    checks.push(infoCheck('sync_landing_gaps', 'Not applicable: no managed source is bound to a checkout.', 'not_applicable', undefined, details));
    return checks;
  }
  checks.push({ name: 'sync_landing_gaps', status: 'ok', details, message: 'Every page managed sync committed past its freshness target in the last 24 h is searchable.' });
  return checks;
}

export const syncLandingGapsEntry: DoctorEntry = {
  name: 'sync_landing_gaps',
  emits: ['sync_landing_gaps'],
  run: runLandingGaps,
};
