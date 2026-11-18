import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { classifyCapturedFacts } from '../../../core/repair/captured-facts.ts';
import { sortSourcesById } from '../../../core/source-rows.ts';

/**
 * `captured_facts_active`: active facts the capture lanes extracted from
 * gbrain's own claude-cli sessions (evidenced) or, by heuristic, from pasted
 * text (ambiguous), before v0.60.30.0 stopped both. Counts them and names the
 * explicit-only `gbrain repair captured-facts` preview. It reports facts in
 * the database; the `self_capture` check reports corpus files. Read-only;
 * reads the brain host's harness transcripts and session corpus.
 */
export async function capturedFactsCheck(engine: BrainEngine, sourceIds?: string[], opts: { projectsRoot?: string; corpusDir?: string | null } = {}): Promise<Check> {
  const name = 'captured_facts_active';
  try {
    const sources = sourceIds ?? sortSourcesById(await engine.listAllSources()).map(row => row.id);
    const { candidates, unclassifiable } = await classifyCapturedFacts(engine, sources, opts);
    const count = (klass: string) => candidates.filter(c => c.class === klass).length;
    const details = { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded'), unclassifiable,
      repair: 'captured-facts', docs: 'docs/guides/repair.md#explicit-only-repair-kinds' };
    const differs = 'This counts facts in the database; the self_capture check counts corpus files.';
    if (!details.evidenced && !details.ambiguous) {
      return { name, status: 'ok', details, message: `No active fact from a gbrain self-capture or paste candidate remains. ${differs}` };
    }
    return { name, status: 'warn', details,
      message: `${details.evidenced + details.ambiguous} active fact(s) were captured before v0.60.30.0 from gbrain's own claude-cli sessions `
        + `(${details.evidenced} with evidence) or from pasted text (${details.ambiguous} paste candidate(s), heuristic); recall still returns them. ${differs} `
        + 'Preview the cleanup on the brain host: gbrain repair captured-facts — then run the apply command it prints after the user agrees '
        + '(paste candidates only with gbrain repair captured-facts --include-ambiguous).' };
  } catch (error) {
    return { name, status: 'warn', message: `Captured facts could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown' } };
  }
}
