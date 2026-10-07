import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { classifyOntologyFacts } from '../../../core/repair/ontology-facts.ts';

/**
 * #6264: ontology observations the extract_facts fence step moved onto an
 * entity page's Facts table (fenced, or retired by a later page write).
 * Counts the restorable ones by state and names the explicit-only repair's
 * preview; excluded ones (withdrawn, consolidated, duplicated) are reported
 * but never count as a finding. Read-only.
 */
export async function ontologyFactsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const facts = await classifyOntologyFacts(engine, sources);
    const count = (reason: string) => facts.filter(f => f.class === 'restorable' && f.reason === reason).length;
    const details = { fenced: count('fenced'), retired: count('retired'), excluded: facts.filter(f => f.class === 'excluded').length,
      repair: 'ontology-facts', docs: 'docs/guides/repair.md#explicit-only-repair-kinds' };
    if (!details.fenced && !details.retired) {
      return { name: 'ontology_facts_fenced', status: 'ok', details,
        message: `No ontology observation is held by a page's Facts table${details.excluded ? ` (${details.excluded} affected observation(s) are excluded and stay as they are)` : ''}.` };
    }
    return { name: 'ontology_facts_fenced', status: 'warn', details,
      message: `${details.fenced + details.retired} ontology observation(s) were moved onto an entity page's Facts table by the extract_facts fence step `
        + `(${details.retired} since retired by a page write, so ontology_get no longer returns them; ${details.fenced} still fenced under the page's provenance). `
        + 'Preview the restore on the brain host: gbrain repair ontology-facts — then run the apply command it prints after the user agrees.' };
  } catch (error) {
    return { name: 'ontology_facts_fenced', status: 'warn',
      message: `Fenced ontology observations could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown' } };
  }
}
