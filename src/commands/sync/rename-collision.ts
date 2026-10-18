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
import { randomUUID } from 'node:crypto';
import { lockedBeliefBatch } from '../../core/belief/writers.ts';
import { markBeliefCommits } from '../../core/belief/append.ts';
import { bindOrigin, classifyOriginUniqueViolation } from '../../core/persistence/origin-guard.ts';

export type RenameOutcome = 'renamed' | 'noop' | 'live_destination';

const UNIQUE_VIOLATION = '23505';

/** A slug collision: any 23505 except the live-origin index (#6948), which is an origin refusal, not an occupied slug. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && String((error as { code?: unknown }).code) === UNIQUE_VIOLATION && !classifyOriginUniqueViolation(error);
}

/** The purge-style slug a merged tombstone keeps; `~` is outside the slug grammar, so no file or write can claim it. */
export function purgedSlug(slug: string, pageId: number): string {
  return `${slug}~purged-${pageId}`;
}

export async function renamePageOntoSlug(engine: BrainEngine, input: { sourceId: string; oldSlug: string; newSlug: string; to: string }): Promise<RenameOutcome> {
  const { sourceId, oldSlug, newSlug, to } = input;
  const publicationId = randomUUID();
  const report = { appended: 0 };
  // W1 #6783 §3: the moved row keeps its id, so its batch pairs both sides into one page.renamed on the same lifetime.
  const move = (tx: BrainEngine) => lockedBeliefBatch(tx, { sourceId, slugs: [oldSlug, newSlug], publicationId, op: 'sync_rename', remote: false, report }, async () => {
    const moved = await tx.updateSlug(oldSlug, newSlug, { sourceId });
    if (moved > 0) await bindOrigin(tx, { sourceId, slug: newSlug, sourcePath: to });
    return moved;
  });
  const recorded = async <T>(outcome: T) => {
    if (report.appended) await markBeliefCommits(engine, [publicationId]).catch(() => undefined);
    return outcome;
  };
  try {
    return recorded((await maintenanceTransaction(engine, move)) > 0 ? 'renamed' : 'noop');
  } catch (error) {
    if (!isUniqueViolation(error)) throw classifyOriginUniqueViolation(error, { sourceId, sourcePath: to, slug: newSlug }) ?? error;
    const [destination] = await engine.executeRaw<{ id: number | string; tombstone: boolean }>(
      'SELECT id, deleted_at IS NOT NULL AS tombstone FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, newSlug]);
    if (!destination) throw error;
    if (!destination.tombstone) return 'live_destination';
    const tombstoneId = Number(destination.id);
    const nothingToMove = Symbol('nothing to move');
    try {
      return await recorded(await maintenanceTransaction(engine, async tx => {
        await tx.lockPageKeys([{ sourceId, slug: oldSlug }, { sourceId, slug: newSlug }]);
        // origin-guard-ok: rekeys a tombstone only (deleted_at IS NOT NULL), which claims no origin
        const rekeyed = await tx.executeRaw<{ id: number }>(
          'UPDATE pages SET slug = $1 WHERE id = $2 AND source_id = $3 AND deleted_at IS NOT NULL RETURNING id', [purgedSlug(newSlug, tombstoneId), tombstoneId, sourceId]);
        if (!rekeyed.length) return 'live_destination' as const;
        await moveSlugBindings(tx, sourceId, newSlug, purgedSlug(newSlug, tombstoneId));
        if (await move(tx) === 0) throw nothingToMove;
        return 'renamed' as const;
      }));
    } catch (merge) {
      if (merge === nothingToMove) return 'noop';
      throw merge;
    }
  }
}
