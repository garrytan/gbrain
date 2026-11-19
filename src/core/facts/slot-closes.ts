import type { BrainEngine } from '../engine.ts';
import { CONVERSATION_SLOT_SQL } from '../chronicle/ontology.ts';
import { deriveSlotCloses, slotCloseEndSql, slotCloseLinkSql, type SlotRow } from './slots.ts';

/**
 * GST-3170: the stored conversation slot closes (slots.ts). Every write of them, by the conversation publication or by a
 * delete of fact rows a close can point at, runs under one transaction lock per source, so two never derive closes from
 * each other's uncommitted rows or wait on each other's row locks.
 */

type Db = Pick<BrainEngine, 'executeRaw'>;

/** Taken before the first slot row is touched and held to commit; taking it again in the same transaction is free. */
export async function lockSlotCloses(tx: Db, sourceId: string): Promise<void> {
  await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gbrain:conversation-slot-closes:${sourceId}`]);
}

export type SlotKey = { entity_slug: string; dimension: string };

/**
 * GST-3170: stores exactly the closes deriveSlotCloses gives for `slots` of the source from their active conversation
 * slot rows (valid_until and superseded_by; never expired_at); a world row's from the world rows alone, since a private
 * row never ends a world row at read time either. Only a row that is open (no superseded_by, no valid_until) or carries
 * a close stored here (slotCloseEndSql) changes, so another writer's end or link is never touched. Runs after every
 * insert and clear of the conversation publication and every delete withSlotClosesReleased wraps, in that transaction and
 * under lockSlotCloses, so the stored closes always match the rows present.
 */
export async function storeSlotCloses(tx: Db, sourceId: string, slots: readonly SlotKey[]): Promise<void> {
  if (!slots.length) return;
  await lockSlotCloses(tx, sourceId);
  const rows = await tx.executeRaw<SlotRow & { visibility: string; superseded_by: number | string | null; open: boolean; ours: boolean }>(
    `SELECT f.id, f.source_id, f.entity_slug, f.dimension, f.value_hash, f.valid_from, f.source_markdown_slug, f.fact, f.visibility, f.superseded_by,
       f.superseded_by IS NULL AND f.valid_until IS NULL AS open, ${slotCloseEndSql('f')} AS ours
     FROM facts f WHERE f.source_id = $1 AND (f.entity_slug, f.dimension) IN (SELECT * FROM unnest($2::text[], $3::text[]))
       AND f.expired_at IS NULL AND f.value_hash IS NOT NULL AND COALESCE(f.dim_status, 'active') = 'active' AND ${CONVERSATION_SLOT_SQL}
       AND (f.superseded_by IS NULL OR ${slotCloseLinkSql('f')})`,
    [sourceId, slots.map(slot => slot.entity_slug), slots.map(slot => slot.dimension)]);
  const all = deriveSlotCloses(rows);
  const world = deriveSlotCloses(rows.filter(row => row.visibility === 'world'));
  const changes = rows.flatMap(row => {
    const want = (row.visibility === 'world' ? world : all).get(Number(row.id))?.by ?? null;
    return (row.open || row.ours) && want !== (row.superseded_by == null ? null : Number(row.superseded_by)) ? [{ id: Number(row.id), succ: want }] : [];
  });
  if (!changes.length) return;
  await tx.executeRaw(`UPDATE facts f SET superseded_by = x.succ, valid_until = s.valid_from
    FROM unnest($1::bigint[], $2::bigint[]) AS x(id, succ) LEFT JOIN facts s ON s.id = x.succ WHERE f.id = x.id`, [changes.map(c => c.id), changes.map(c => c.succ)]);
}

/**
 * Runs `remove`, which deletes or re-points the fact rows `ids`, with the closes stored toward them released first and
 * re-derived after from the rows that remain. Without it, deleting a successor clears only the predecessor's
 * superseded_by (the foreign key's ON DELETE SET NULL) and leaves its valid_until, an end no reader or publish undoes.
 */
export async function withSlotClosesReleased<T>(tx: Db, sourceId: string, ids: readonly number[], remove: () => Promise<T>): Promise<T> {
  const [slotted] = ids.length ? await tx.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts
    WHERE source_id = $1 AND id = ANY($2::bigint[]) AND dimension IS NOT NULL AND ${CONVERSATION_SLOT_SQL}`, [sourceId, [...ids]]) : [];
  if (!Number(slotted?.n ?? 0)) return remove();
  await lockSlotCloses(tx, sourceId);
  const slots = await tx.executeRaw<SlotKey>(`UPDATE facts g SET superseded_by = NULL, valid_until = CASE WHEN ${slotCloseEndSql('g')} THEN NULL ELSE g.valid_until END
    WHERE g.source_id = $1 AND g.superseded_by = ANY($2::bigint[]) AND ${slotCloseLinkSql('g')} RETURNING g.entity_slug, g.dimension`, [sourceId, [...ids]]);
  const out = await remove();
  await storeSlotCloses(tx, sourceId, slots);
  return out;
}
