import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';

/**
 * `facts_redaction_marker` (#7125): active facts whose text holds a redaction
 * marker, which the prompt sanitizer wrote into stored facts before the fix
 * ("Business System (ABS)" stored as "Business [redacted](ABS)"). Counts them
 * with one scan of active facts and names the explicit-only
 * `foresights repair redacted-facts` preview, which proves each restoration from
 * the fact's source pages. Read-only.
 */
export async function factsRedactionMarkerCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'facts_redaction_marker';
  try {
    const [row] = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM facts f
      WHERE f.expired_at IS NULL AND f.superseded_by IS NULL AND f.fact LIKE '%[redacted%'
        AND f.source_id IN (SELECT id FROM sources WHERE archived IS NOT TRUE AND ($1::text[] IS NULL OR id=ANY($1::text[])))`, [sourceIds ?? null]);
    const affected = Number(row?.n ?? 0);
    const details = { affected, repair: 'redacted-facts', docs: 'docs/guides/repair.md#redacted-facts' };
    if (!affected) return { name, status: 'ok', details, message: 'No active fact holds a redaction marker.' };
    return { name, status: 'warn', details,
      message: `${affected} active fact(s) hold a redaction marker where the pre-fix prompt sanitizer deleted words from the stored text (#7125); `
        + 'recall returns them damaged and trust scan flags the marker. Preview the restoration on the brain host: foresights repair redacted-facts — '
        + 'then run the apply command it prints after the user agrees. Facts no source page can prove are listed and left unchanged.' };
  } catch (error) {
    return { name, status: 'warn', message: `Redaction markers in facts could not be counted: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { affected: 'unknown' } };
  }
}
