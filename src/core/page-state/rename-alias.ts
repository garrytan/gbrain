import type { BrainEngine } from '../engine.ts';
import { isUndefinedTableError } from '../utils.ts';
import { MOVE_WITHDRAWAL_SUBJECT_SQL } from '../facts/withdrawal-schema.ts';

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

/**
 * Move the slug-keyed rows that belong to a renamed page (#5431): facts about
 * it (`entity_slug`), facts read from its `## Facts` fence
 * (`source_markdown_slug`), its free-text search aliases (`page_aliases`), and
 * its fact withdrawals (a forgotten claim stays forgotten). Runs inside the
 * caller's rename transaction. The new slug is free (the page UPDATE
 * succeeded), so fence rows or aliases still keyed to it belong to a purged
 * page and yield to the moved ones. A brain whose schema predates the facts or
 * alias tables skips them inside a savepoint.
 */
export async function moveSlugBindings(
  tx: Pick<BrainEngine, 'transaction' | 'executeRaw'>,
  sourceId: string,
  oldSlug: string,
  newSlug: string,
): Promise<void> {
  if (oldSlug === newSlug) return;
  await tx.executeRaw(MOVE_WITHDRAWAL_SUBJECT_SQL, [sourceId, oldSlug, newSlug]);
  const statements = [
    `UPDATE facts SET entity_slug = $3 WHERE source_id = $1 AND entity_slug = $2`,
    `DELETE FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug = $3 AND f.row_num IS NOT NULL
       AND EXISTS (SELECT 1 FROM facts o WHERE o.source_id = $1 AND o.source_markdown_slug = $2 AND o.row_num = f.row_num)`,
    `UPDATE facts SET source_markdown_slug = $3 WHERE source_id = $1 AND source_markdown_slug = $2`,
    `DELETE FROM page_aliases a WHERE a.source_id = $1 AND a.slug = $3
       AND EXISTS (SELECT 1 FROM page_aliases o WHERE o.source_id = $1 AND o.slug = $2 AND o.alias_norm = a.alias_norm)`,
    `UPDATE page_aliases SET slug = $3 WHERE source_id = $1 AND slug = $2`,
  ];
  for (const sql of statements) {
    try {
      await tx.transaction(savepoint => savepoint.executeRaw(sql, [sourceId, oldSlug, newSlug]));
    } catch (error) {
      if (!isUndefinedTableError(error)) throw error;
    }
  }
}
