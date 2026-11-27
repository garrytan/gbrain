/**
 * #6764: how a free conversation relink survives re-extraction.
 *
 * `gbrain facts relink --conversation` links a derived conversation row in
 * place (entity_slug set, `entity relinked from <tier>` appended to its
 * context; the row stays the page's derived row, so it has no fence to lose
 * and fence projection never touches it). A replacement of the page's batch
 * (`extract-conversation-facts --force`, a newer extractor version) clears
 * the page first: `clearConversationFacts` expires those relinked rows
 * instead of deleting them (and deletes the previous run's expired copies), and
 * each inserted row with no entity whose claim matches one of them inherits
 * its entity and note. The relink holds, and the page never carries two active
 * copies of the claim.
 */
import type { BrainEngine } from '../engine.ts';
import { appendContextNote } from './subject-infer.ts';
import { RELINKED_DERIVED_ROW } from '../engine-sql/facts-conversation.ts';

/** The SQL predicate (on alias `f`) of a derived row the free conversation relink linked (defined with the statements that read it, engine-sql/facts-conversation.ts). */
export { RELINKED_DERIVED_ROW };
const NOTE = /entity relinked from ([a-z]+)/;

/** `rows` with the entity a cleared relinked row of page `slug` carried for the same claim, when that entity page is still live. */
export async function inheritRelinkedEntities<T extends { fact: string; entity_slug?: string | null; context?: string | null }>(
  db: BrainEngine, sourceId: string, slug: string, rows: T[]): Promise<T[]> {
  if (!rows.some(row => !row.entity_slug)) return rows;
  const prior = await db.listClearedRelinkedFacts(sourceId, slug);
  if (!prior.length) return rows;
  const byClaim = new Map<string, { entity_slug: string; context: string }>();
  for (const p of prior) if (!byClaim.has(p.fact)) byClaim.set(p.fact, p);
  return rows.map(row => {
    const p = row.entity_slug ? undefined : byClaim.get(row.fact);
    return p ? { ...row, entity_slug: p.entity_slug, context: appendContextNote(row.context ?? null, `entity relinked from ${NOTE.exec(p.context)?.[1] ?? 'mention'}`) } : row;
  });
}
