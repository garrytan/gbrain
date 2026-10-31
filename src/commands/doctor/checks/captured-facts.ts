import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { classifyCapturedFacts } from '../../../core/repair/captured-facts.ts';

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
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    // Aggregate all active rows; recall's cap must not truncate this audit.
    const speakers = await engine.executeRaw<{ source_id: string; entity_slug: string; total: number; assistant: number }>(`
      SELECT source_id, entity_slug, COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE attributed_to = 'assistant')::int AS assistant
      FROM facts
      WHERE source_id = ANY($1::text[]) AND entity_slug IS NOT NULL
        AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())
      GROUP BY source_id, entity_slug
      HAVING COUNT(*) FILTER (WHERE attributed_to = 'assistant') > 0
      ORDER BY source_id, entity_slug
    `, [sources]);
    const quality = speakers.map(row =>
      `${row.source_id}:${row.entity_slug}: ${row.assistant}/${row.total} active facts attributed to the assistant (${(100 * row.assistant / row.total).toFixed(1)}%).`).join(' ');
    const { candidates, unclassifiable } = await classifyCapturedFacts(engine, sources, opts);
    const count = (klass: string) => candidates.filter(c => c.class === klass).length;
    const details = { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded'), unclassifiable,
      repair: 'captured-facts', docs: 'docs/guides/repair.md#explicit-only-repair-kinds' };
    const differs = 'This counts facts in the database; the self_capture check counts corpus files.';
    if (!details.evidenced && !details.ambiguous) {
      return { name, status: quality ? 'warn' : 'ok', details, message: quality
        ? `${quality} Speaker attribution identifies the claimant, not user confirmation; review these claims before relying on them. ${differs}`
        : `No active fact from a gbrain self-capture or paste candidate remains. ${differs}` };
    }
    return { name, status: 'warn', details,
      message: `${quality ? `${quality} ` : ''}${details.evidenced + details.ambiguous} active fact(s) were captured before v0.60.30.0 from gbrain's own claude-cli sessions `
        + `(${details.evidenced} with evidence) or from pasted text (${details.ambiguous} paste candidate(s), heuristic); recall still returns them. ${differs} `
        + 'Preview the cleanup on the brain host: gbrain repair captured-facts — then run the apply command it prints after the user agrees '
        + '(paste candidates only with gbrain repair captured-facts --include-ambiguous).' };
  } catch (error) {
    return { name, status: 'warn', message: `Captured facts could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown' } };
  }
}
