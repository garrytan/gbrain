/**
 * GST-3170: read-time slot ends (facts/slots.ts deriveSlotEnds) for the fact readers other than the query facts block,
 * which derives its own (slot-history.ts slotWindows). No writes.
 */
import type { BrainEngine } from '../engine.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { deriveSlotEnds, SLOT_DIMENSIONS } from '../facts/slots.ts';
import { readSlotRows, type FactPoolScope } from './fact-relevance.ts';

/**
 * The block's read-time ends (deriveSlotEnds) for every other fact reader. One read of the slot rows of the
 * rows' entities in every slot dimension, under `scope` (readSlotRows: the caller's source scope, visibility, trust
 * floor, quarantine and private-page filters), so a row the caller cannot read never ends one it can. `entities` lists
 * the fact keys (factEntitySlugs) a reader already resolved for one entity, grouped as that entity. A stored valid_until
 * wins; a derived end becomes the row's valid_until where the row carries one, and an active-only reader drops a row
 * whose end has passed. A failed read leaves the rows as stored. A row that names a dimension outside the slot
 * vocabulary (or none) has no slot to end, so rows that are all like that cost no read.
 */
export async function applySlotEnds<T extends { id: number; source_id: string; entity_slug: string | null; valid_until?: Date | string | null; dimension?: string | null }>(
  engine: BrainEngine, scope: FactPoolScope, rows: T[], opts: { activeOnly: boolean; entities?: ReadonlyArray<{ source_id: string; slugs: readonly string[] }> }): Promise<T[]> {
  const key = (source: string, slug: string) => source + '\u0000' + slug;
  const keyed = new Map(rows.flatMap(r => (r.entity_slug && (r.dimension === undefined || SLOT_DIMENSIONS.has(r.dimension ?? '')) ? [[key(r.source_id, r.entity_slug), { source_id: r.source_id, entity_slug: r.entity_slug }] as const] : [])));
  if (!keyed.size) return rows;
  const canonical = new Map<string, string>();
  for (const e of opts.entities ?? []) for (const s of e.slugs) {
    canonical.set(key(e.source_id, s), e.slugs[0]!);
    keyed.set(key(e.source_id, s), { source_id: e.source_id, entity_slug: s });
  }
  const slots = [...keyed.values()].flatMap(k => [...SLOT_DIMENSIONS].map(dimension => ({ ...k, dimension })));
  const slotRows = await readSlotRows(engine, scope, slots).catch(e => { rethrowCapabilityRefusal(e); return []; });
  const ends = deriveSlotEnds(slotRows.map(r => ({ ...r, entity_slug: canonical.get(key(r.source_id, r.entity_slug)) ?? r.entity_slug })));
  if (!ends.size) return rows;
  const now = Date.now();
  return rows.flatMap(r => {
    const end = r.valid_until ? undefined : ends.get(Number(r.id));
    if (!end) return [r];
    if (opts.activeOnly && end.getTime() <= now) return [];
    return ['valid_until' in r ? { ...r, valid_until: end } : r];
  });
}
