/**
 * The fence generation statements (engine-sql/fence-holds.ts) on a Rust brain.
 *
 * A fence result is held only by a facts or takes fence publish (generations/publish.ts), which writes
 * `derived_generations` through `executeRaw`, and this engine refuses `executeRaw`. The store holds no
 * `derived_generations` rows, so no fence result is held: the held list is empty and clearing a hold deletes nothing.
 * A family that lets the store publish fence generations must read and clear its held rows here.
 *
 * The generation key lock is the store's write: a `transaction` holds the store's writer gate from open to commit or
 * rollback, so two writers of one key already run one after the other, and the lock adds nothing.
 *
 * The two page reads answer from the store's pages by exact slug (no alias), as the SQL reads `pages`.
 */
import type { FenceHoldFileRow, FenceHoldKey, FenceHoldRow } from '../../engine-sql/fence-holds.ts';
import { storeCall, type StoreMember } from './common.ts';

/** No fence result is held on this engine (see the module comment). */
export const listFenceHoldRows: StoreMember<[sourceIds: readonly string[], kinds: readonly string[], ownerKey?: string], FenceHoldRow[]> = async () => [];

/** The page at `(sourceId, slug)` in any deleted state, or null. */
type StoredPage = { page: { deleted_at?: string | null; source_path?: string | null } } | null;

/** Whether `slug` is deleted (or gone) in `sourceId`. */
export const readFenceOriginGone: StoreMember<[sourceId: string, slug: string], boolean> = async (brain, sourceId, slug) => {
  const snapshot: StoredPage = await storeCall({ member: 'readFenceOriginGone', slug, sourceId },
    () => brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }));
  return snapshot === null || snapshot.page.deleted_at != null;
};

/** The store's write is the generation key lock (see the module comment). */
export const lockGenerationKey: StoreMember<[lockKey: string], void> = async () => {};

/** No fence result is held on this engine, so no held row is deleted (see the module comment). */
export const clearFenceHoldRows: StoreMember<[key: FenceHoldKey], void> = async () => {};

/** The live pages of `slugs` in `sourceIds`, with whether each records no file. */
export const readFenceHoldFiles: StoreMember<[sourceIds: readonly string[], slugs: readonly string[]], FenceHoldFileRow[]> =
  async (brain, sourceIds, slugs) => {
    const rows: FenceHoldFileRow[] = [];
    for (const sourceId of new Set(sourceIds)) {
      for (const slug of new Set(slugs)) {
        const snapshot: StoredPage = await storeCall({ member: 'readFenceHoldFiles', slug, sourceId },
          () => brain.readPageSnapshot(slug, { sourceId }));
        if (snapshot !== null) rows.push({ source_id: sourceId, slug, database_only: !snapshot.page.source_path?.trim() });
      }
    }
    return rows;
  };
