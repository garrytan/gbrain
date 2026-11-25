/**
 * `recordRenameAlias` as a typed member (page-state/rename-alias.ts is its caller-facing wrapper): the seven statements
 * that record `old -> new` in `slug_rename_history` and `slug_aliases` when a page is renamed or merged into another.
 * Both SQL engines delegate here; the Rust store serves the same member from its alias family
 * (`record_rename_alias`, rust/crates/gbrain-store/src/aliases.rs). Each half runs in its own savepoint, so a brain
 * whose schema predates a table skips only that half: a missing `slug_rename_history` or `slug_aliases` table skips the
 * history half, a missing `slug_aliases` table the alias half, and any other error is rethrown.
 */
import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';

/** Records `old -> new` in the rename history and the slug aliases, inside the caller's transaction (a savepoint per half). */
export async function recordRenameAliasRows(
  tx: Pick<BrainEngine, 'transaction'>,
  sourceId: string,
  oldSlug: string,
  newSlug: string,
): Promise<void> {
  if (oldSlug === newSlug) return;
  try {
    await tx.transaction(async savepoint => {
      await savepoint.executeRaw(`INSERT INTO slug_rename_history (source_id, old_slug, new_slug)
        SELECT source_id, alias_slug, canonical_slug FROM slug_aliases WHERE source_id = $1 AND alias_slug = $2
        ON CONFLICT DO NOTHING`, [sourceId, newSlug]);
      await savepoint.executeRaw(`DELETE FROM slug_rename_history h WHERE h.source_id = $1 AND h.new_slug = $2
        AND EXISTS (SELECT 1 FROM slug_rename_history o WHERE o.source_id = $1 AND o.old_slug = h.old_slug AND o.new_slug = $3)`, [sourceId, oldSlug, newSlug]);
      await savepoint.executeRaw('UPDATE slug_rename_history SET new_slug = $3 WHERE source_id = $1 AND new_slug = $2', [sourceId, oldSlug, newSlug]);
      await savepoint.executeRaw(`INSERT INTO slug_rename_history (source_id, old_slug, new_slug) VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING`, [sourceId, oldSlug, newSlug]);
    });
  } catch (error) {
    if (!isMissingSchemaObject(error, 'table', 'slug_rename_history') && !isMissingSchemaObject(error, 'table', 'slug_aliases')) throw error;
  }
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
    if (!isMissingSchemaObject(error, 'table', 'slug_aliases')) throw error;
  }
}
