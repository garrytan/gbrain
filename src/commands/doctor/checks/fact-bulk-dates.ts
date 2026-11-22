import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { BULK_DAY_RULE } from '../../../core/facts/bulk-days.ts';
import { findFactDateAuditDays } from '../../../core/facts/fact-date-audit.ts';
import { agentFix, checkError } from '../check-fix.ts';

/**
 * `fact_bulk_dates` (#7247): a calendar day holding a large share of a source's active facts as their valid_from.
 * A bulk load stamping every row at once can produce this distribution. Report all bulk days, keeping the warning unless every fact has a
 * current original-evidence receipt and no claim states an earlier date. Remote reads stay source scoped.
 */
export async function factBulkDatesCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'fact_bulk_dates';
  const docs = 'docs/guides/repair.md#fact-claim-dates';
  try {
    const days = await findFactDateAuditDays(engine, sourceIds);
    const review = days.filter(d => d.evidence_status === 'review_required');
    const source_ids = [...new Set(review.map(d => d.source_id))];
    const details = { days, source_ids, rule: BULK_DAY_RULE, repair: 'fact-claim-dates', docs };
    if (!days.length) return { name, status: 'ok', details, message: 'No calendar day holds a bulk-loaded share of any source\'s facts.' };
    if (!review.length) return { name, status: 'ok', details,
      message: `Current local operator attestations verify each fact's date across all ${days.length} detected bulk day(s).` };
    const first = review[0]!;
    const lines = review.map(d => `${d.source_id} ${d.day}: ${d.facts} of ${d.source_facts} active facts across ${d.entities} entities`
      + `${d.top_sources.length ? ` (source tags: ${d.top_sources.map(top => `${top.source} ${top.facts}`).join(', ')})` : ''}, ${d.dated_claims} state one earlier date in the claim, ${d.verified_facts} have current same-day evidence`);
    return { name, status: 'warn', details,
      message: `${review.length} calendar day(s) hold a bulk-loaded share of a source's facts as their valid_from and need review: ${lines.join('; ')}. `
        + 'Timelines and as-of reads place these facts on that day. Compare the source records to distinguish an import date from events that happened together. '
        + `Preview moving the facts whose claim states its own date on the brain host: gbrain repair fact-claim-dates --source ${first.source_id}`
        + `${source_ids.length > 1 ? ` (one source at a time: ${source_ids.map(id => `--source ${id}`).join(', ')})` : ''} — it changes nothing until the user agrees `
        + 'to the apply command it prints; facts without a supported date candidate keep their recorded date.',
      fix: agentFix(['gbrain', 'repair', 'fact-claim-dates', '--source', first.source_id, '--json'],
        'Read-only preview: lists the facts whose claim states an earlier date, saves the set under a hash and prints the apply command.', name, { docs }) };
  } catch (error) {
    return checkError(name, 'look for bulk-loaded fact dates', error, { details: { days: 'unknown', health: 'unknown', docs } });
  }
}
