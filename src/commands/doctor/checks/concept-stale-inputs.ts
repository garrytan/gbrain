/**
 * #9653 `concept_stale_inputs`: live synthesized concepts that still hold a derivation_inputs edge to a deleted page
 * which is no longer one of their members (no concept-provenance `synthesized_from` link). Before #9653 a concept's
 * input edges were only ever added, so a concept re-synthesized without a retired atom kept the edge, and the purge of
 * that atom hid the live concept and marked it needs_rederive. A publication now replaces the edges; one already
 * recorded stays until the concept is next re-synthesized with changed members. Read-only; nothing repairs it.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';

export async function conceptStaleInputsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'concept_stale_inputs';
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const [row] = await engine.executeRaw<{ concepts: number; edges: number }>(`
      SELECT count(DISTINCT c.id)::int AS concepts, count(*)::int AS edges
        FROM pages c JOIN derivation_inputs d ON d.derived_table='pages' AND d.derived_id=c.id::text AND d.input_table='pages'
        JOIN pages a ON a.id::text=d.input_id AND a.deleted_at IS NOT NULL
       WHERE c.source_id=ANY($1::text[]) AND c.type='concept' AND c.deleted_at IS NULL AND c.frontmatter->>'synthesized_by' LIKE 'synthesize_concepts%'
         AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id=c.id AND l.to_page_id=a.id
           AND l.link_source='concept-provenance' AND l.link_type='synthesized_from')`, [sources]);
    const details = { count: Number(row?.concepts ?? 0), edges: Number(row?.edges ?? 0) };
    if (!details.count) return { name, status: 'ok', details, message: 'No live concept holds an input edge to a deleted page that is no longer one of its members.' };
    return { name, status: 'warn', details,
      message: `${details.count} live concept(s) still record ${details.edges} input edge(s) to deleted pages that are no longer their members (#9653). `
        + 'Purging those pages would hide each such concept and mark it needs_rederive. A concept\'s edges are replaced the next time it is re-synthesized with changed members; no repair rewrites them.' };
  } catch (error) {
    return { name, status: 'warn', message: `Concept input edges could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown' } };
  }
}
