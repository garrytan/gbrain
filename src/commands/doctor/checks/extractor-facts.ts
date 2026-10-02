import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { managedPersistenceEnabled } from '../../../core/persistence/ownership.ts';
import { classifyExtractorFacts } from '../../../core/repair/extractor-facts.ts';

/**
 * #5731: conversation-extractor facts the pre-fix canonical projection
 * expired (expired, row number cleared). Counts the restorable ones by class
 * (evidenced, ambiguous) and names the explicit-only repair's preview; the
 * excluded ones (superseded, withdrawn, duplicated, page gone) are reported
 * but never count as a finding. Read-only.
 */
export async function extractorFactsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const facts = await classifyExtractorFacts(engine, sources, { managed: await managedPersistenceEnabled(engine) });
    const count = (klass: string) => facts.filter(f => f.class === klass).length;
    const details = { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded'),
      repair: 'extractor-facts', docs: 'docs/guides/repair.md#explicit-only-repair-kinds' };
    if (!details.evidenced && !details.ambiguous) {
      return { name: 'extractor_facts_expired', status: 'ok', details,
        message: `No conversation-extractor fact is left expired by the pre-v0.60.11.0 projection${details.excluded ? ` (${details.excluded} expired candidate(s) are excluded and stay expired)` : ''}.` };
    }
    return { name: 'extractor_facts_expired', status: 'warn', details,
      message: `${details.evidenced + details.ambiguous} conversation-extractor fact(s) were expired by the pre-v0.60.11.0 canonical projection `
        + `(${details.evidenced} with receipt evidence, ${details.ambiguous} ambiguous); recall no longer returns them. `
        + 'Preview the restore on the brain host: gbrain repair extractor-facts — then run the apply command it prints after the user agrees '
        + '(ambiguous rows only with gbrain repair extractor-facts --include-ambiguous).' };
  } catch (error) {
    return { name: 'extractor_facts_expired', status: 'warn',
      message: `Expired extractor facts could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown' } };
  }
}
