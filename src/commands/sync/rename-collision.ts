/**
 * #5431 (W14 P1.8): the cheap sync rename, with its unique violation
 * classified instead of swallowed. `updateSlug` moves the row (keeping its id,
 * so every page-id-keyed row follows) and `source_path` is repaired in the
 * same maintenance transaction, so the full-sync purge never reads the live
 * renamed page as a removed file. When the destination slug is occupied:
 *
 * - by a soft-deleted page (a tombstone), the two are merged in one
 *   transaction: the tombstone is re-keyed purge-style (`<slug>~purged-<id>`,
 *   a name no derived slug can take; its history, edges and slug bindings
 *   stay with it, nothing is hard-deleted) and the renamed page moves in;
 * - by a live page, the caller decides (`live_destination`);
 * - any other error propagates: the file fails and the checkpoint stays.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { moveSlugBindings } from '../../core/page-state/rename-alias.ts';
import { maintenanceTransaction } from '../../core/persistence/attribution.ts';

export type RenameOutcome = 'renamed' | 'noop' | 'live_destination';

const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && String((error as { code?: unknown }).code) === UNIQUE_VIOLATION;
}

/** The purge-style slug a merged tombstone keeps; `~` is outside the slug grammar, so no file or write can claim it. */
export function purgedSlug(slug: string, pageId: number): string {
  return `${slug}~purged-${pageId}`;
}

export async function renamePageOntoSlug(engine: BrainEngine, input: { sourceId: string; oldSlug: string; newSlug: string; to: string }): Promise<RenameOutcome> {
  const { sourceId, oldSlug, newSlug, to } = input;
  const move = async (tx: BrainEngine) => {
    const moved = await tx.updateSlug(oldSlug, newSlug, { sourceId });
    if (moved > 0) await tx.executeRaw('UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug = $3', [to, sourceId, newSlug]);
    return moved;
  };
  try {
    return (await maintenanceTransaction(engine, move)) > 0 ? 'renamed' : 'noop';
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const [destination] = await engine.executeRaw<{ id: number | string; tombstone: boolean }>(
      'SELECT id, deleted_at IS NOT NULL AS tombstone FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, newSlug]);
    if (!destination) throw error;
    if (!destination.tombstone) return 'live_destination';
    const tombstoneId = Number(destination.id);
    const nothingToMove = Symbol('nothing to move');
    try {
      return await maintenanceTransaction(engine, async tx => {
        const rekeyed = await tx.executeRaw<{ id: number }>(
          'UPDATE pages SET slug = $1 WHERE id = $2 AND source_id = $3 AND deleted_at IS NOT NULL RETURNING id', [purgedSlug(newSlug, tombstoneId), tombstoneId, sourceId]);
        if (!rekeyed.length) return 'live_destination' as const;
        await moveSlugBindings(tx, sourceId, newSlug, purgedSlug(newSlug, tombstoneId));
        if (await move(tx) === 0) throw nothingToMove;
        return 'renamed' as const;
      });
    } catch (merge) {
      if (merge === nothingToMove) return 'noop';
      throw merge;
    }
  }
}
