import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { BULK_DAY_RULE, findBulkFactDays } from '../../../core/facts/bulk-days.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { dateEvidenceKey, factDateEvidence } from './fact-bulk-date-evidence.ts';

/** Report the stock concentration threshold and separately report evidence for the recorded dates. */
export async function factBulkDatesCheck(engine: BrainEngine, sourceIds?: string[], evidencePath?: string): Promise<Check> {
  const name = 'fact_bulk_dates';
  const docs = 'docs/guides/repair.md#fact-claim-dates';
  try {
    const readDays = async (reader: BrainEngine) => {
      let evidenceInput: 'not_provided' | 'read' | 'unavailable' = 'not_provided';
      const bulk = await findBulkFactDays(reader, sourceIds);
      let evidence: Awaited<ReturnType<typeof factDateEvidence>> | undefined;
      if (evidencePath && bulk.length) {
        try {
          evidence = await factDateEvidence(reader, bulk, evidencePath);
          evidenceInput = 'read';
        } catch { evidenceInput = 'unavailable'; }
      }
      const days = bulk.map(day => ({ ...day, event_date_evidence: evidence?.get(dateEvidenceKey(day.source_id, day.day)) ??
        { verified_same_day: 0, verified_different_day: 0, unknown: day.facts } }));
      return { days, evidenceInput };
    };
    const { days, evidenceInput } = evidencePath
      ? await engine.transaction(async tx => {
          await tx.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
          return readDays(tx);
        }, { readOnly: true })
      : await readDays(engine);
    const source_ids = [...new Set(days.map(d => d.source_id))];
    const details = { days, source_ids, evidence_input: evidenceInput, rule: BULK_DAY_RULE, repair: 'fact-claim-dates', docs };
    if (!days.length) return { name, status: 'ok', details, message: 'No calendar day holds a concentrated share of any source\'s facts.' };
    const first = days[0]!;
    const lines = days.map(d => `${d.source_id} ${d.day}: ${d.facts} of ${d.source_facts} active facts across ${d.entities} entities`
      + `${d.top_sources.length ? ` (source tags: ${d.top_sources.map(top => `${top.source} ${top.facts}`).join(', ')})` : ''}, ${d.dated_claims} state one earlier date in the claim. Event-date evidence: ${d.event_date_evidence.verified_same_day} match, ${d.event_date_evidence.verified_different_day} differ, ${d.event_date_evidence.unknown} unknown`);
    return { name, status: 'warn', details,
      message: `${days.length} calendar day(s) hold a concentrated share of a source's facts as their valid_from: ${lines.join('; ')}. `
        + 'Concentration can indicate a bulk import. It does not establish the dates by itself. '
        + (details.evidence_input === 'unavailable' ? 'The supplied event-date evidence could not be read or validated. ' : '')
        + `Preview moving the facts whose claim states its own date on the brain host: gbrain repair fact-claim-dates --source ${first.source_id}`
        + `${source_ids.length > 1 ? ` (one source at a time: ${source_ids.map(id => `--source ${id}`).join(', ')})` : ''} — it changes nothing until the user agrees `
        + 'to the apply command it prints; facts without a date in the claim keep their recorded dates.',
      fix: agentFix(['gbrain', 'repair', 'fact-claim-dates', '--source', first.source_id, '--json'],
        'Read-only preview: lists the facts whose claim states an earlier date, saves the set under a hash and prints the apply command.', name, { docs }) };
  } catch (error) {
    return checkError(name, 'look for bulk-loaded fact dates', error, { details: { days: 'unknown', docs } });
  }
}
