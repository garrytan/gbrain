import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { BULK_DAY_RULE, findBulkFactDays } from '../../../core/facts/bulk-days.ts';
import { agentFix, checkError } from '../check-fix.ts';

/**
 * `fact_bulk_dates` (#7247): a calendar day holding a large share of a source's active facts as their valid_from,
 * which a bulk load writes when it stamps the day it ran onto every row. Those dates record when the facts were
 * loaded, not when they happened. One read-only aggregate (`findBulkFactDays`, the rule the repair uses) over the
 * scoped sources' active facts reports each day with its fact and entity counts, the most frequent source tags and
 * how many claims state exactly one earlier date, and names the explicit-only `gbrain repair fact-claim-dates`
 * preview. Remote callers see only their permitted sources.
 */
export async function factBulkDatesCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'fact_bulk_dates';
  const docs = 'docs/guides/repair.md#fact-claim-dates';
  try {
    const days = await findBulkFactDays(engine, sourceIds);
    const source_ids = [...new Set(days.map(d => d.source_id))];
    const details = { days, source_ids, rule: BULK_DAY_RULE, repair: 'fact-claim-dates', docs };
    if (!days.length) return { name, status: 'ok', details, message: 'No calendar day holds a bulk-loaded share of any source\'s facts.' };
    const first = days[0]!;
    const lines = days.map(d => `${d.source_id} ${d.day}: ${d.facts} of ${d.source_facts} active facts across ${d.entities} entities`
      + `${d.top_sources.length ? ` (source tags: ${d.top_sources.map(top => `${top.source} ${top.facts}`).join(', ')})` : ''}, ${d.dated_claims} state one earlier date in the claim`);
    return { name, status: 'warn', details,
      message: `${days.length} calendar day(s) hold a bulk-loaded share of a source's facts as their valid_from: ${lines.join('; ')}. `
        + 'These dates record when the facts were loaded, not when they happened, so timelines and as-of reads put every such fact on that day. '
        + `Preview moving the facts whose claim states its own date on the brain host: gbrain repair fact-claim-dates --source ${first.source_id}`
        + `${source_ids.length > 1 ? ` (one source at a time: ${source_ids.map(id => `--source ${id}`).join(', ')})` : ''} — it changes nothing until the user agrees `
        + 'to the apply command it prints; facts without a date in the claim keep the load day.',
      fix: agentFix(['gbrain', 'repair', 'fact-claim-dates', '--source', first.source_id, '--json'],
        'Read-only preview: lists the facts whose claim states an earlier date, saves the set under a hash and prints the apply command.', name, { docs }) };
  } catch (error) {
    return checkError(name, 'look for bulk-loaded fact dates', error, { details: { days: 'unknown', docs } });
  }
}
