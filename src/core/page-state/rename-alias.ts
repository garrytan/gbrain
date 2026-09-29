import type { BrainEngine } from '../engine.ts';
import { isUndefinedTableError } from '../utils.ts';

/**
 * Record `old -> new` in slug_aliases when a page is renamed, inside the
 * caller's transaction, so `[[old]]` links and `get_page old` keep resolving.
 * Aliases that named the old slug are repointed at the new one, and an alias
 * spelled like the new slug is dropped: a live page now owns that slug. A
 * brain whose schema predates slug_aliases (an early migration renaming
 * slugs) skips the alias inside a savepoint.
 */
export async function recordRenameAlias(
  tx: Pick<BrainEngine, 'transaction'>,
  sourceId: string,
  oldSlug: string,
  newSlug: string,
): Promise<void> {
  if (oldSlug === newSlug) return;
  try {
    await tx.transaction(async savepoint => {
      await savepoint.executeRaw('DELETE FROM slug_aliases WHERE source_id = $1 AND alias_slug = $2', [sourceId, newSlug]);
      await savepoint.executeRaw('UPDATE slug_aliases SET canonical_slug = $3 WHERE source_id = $1 AND canonical_slug = $2',
        [sourceId, oldSlug, newSlug]);
      await savepoint.executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
        VALUES ($1, $2, $3, 'rename')
        ON CONFLICT (source_id, alias_slug) DO UPDATE SET canonical_slug = EXCLUDED.canonical_slug`,
      [sourceId, oldSlug, newSlug]);
    });
  } catch (error) {
    if (!isUndefinedTableError(error)) throw error;
  }
}
