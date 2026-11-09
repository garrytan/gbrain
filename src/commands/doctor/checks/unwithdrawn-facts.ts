import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { classifyUnwithdrawnFacts } from '../../../core/repair/unwithdrawn-facts.ts';

/**
 * #8819: facts a facts-fence generation retired although no fence of their page ever held them (often the page's first
 * generation, which no generation restore can undo). Counts the restorable ones by class (evidenced, ambiguous) and
 * names the explicit-only repair's preview; excluded ones (a fence held them, withdrawn, superseded, duplicated, page
 * gone) are reported but never count as a finding. Read-only.
 */
export async function unwithdrawnFactsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const facts = await classifyUnwithdrawnFacts(engine, sources);
    const count = (klass: string) => facts.filter(f => f.class === klass).length;
    const details = { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded'),
      repair: 'unwithdrawn-facts', docs: 'docs/guides/repair.md#unwithdrawn-facts' };
    if (!details.evidenced && !details.ambiguous) {
      return { name: 'unwithdrawn_facts', status: 'ok', details,
        message: `No fact is left retired by a facts-fence generation that no fence withdrew${details.excluded ? ` (${details.excluded} retired fact(s) a fence held or that are excluded stay retired)` : ''}.` };
    }
    return { name: 'unwithdrawn_facts', status: 'warn', details,
      message: `${details.evidenced + details.ambiguous} fact(s) were retired by a facts-fence generation although no fence of their page held them `
        + `(${details.evidenced} evidenced, ${details.ambiguous} ambiguous); recall no longer returns them. `
        + 'Preview the restore on the brain host: gbrain repair unwithdrawn-facts — then run the apply command it prints after the user agrees '
        + '(ambiguous rows only with gbrain repair unwithdrawn-facts --include-ambiguous).' };
  } catch (error) {
    return { name: 'unwithdrawn_facts', status: 'warn',
      message: `Facts retired by facts-fence generations could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown' } };
  }
}
