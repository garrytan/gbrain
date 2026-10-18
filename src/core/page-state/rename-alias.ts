import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';
import { MOVE_WITHDRAWAL_SUBJECT_SQL } from '../facts/withdrawal-schema.ts';
import { dropRekeyDuplicates } from '../facts/ontology-rekey.ts';

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
    if (!isMissingSchemaObject(error, 'table', 'slug_aliases')) throw error;
  }
}

/**
 * #6865: records the slug a removed stray frontmatter `slug:` line declared as an alias of the page its path decides,
 * inside the caller's write (the content-repair publication). Only while no live page has that slug, and never over an
 * alias someone already set. A brain whose schema predates slug_aliases skips it inside a savepoint.
 */
export async function recordSlugLineAlias(tx: Pick<BrainEngine, 'transaction'>, sourceId: string, alias: string, canonical: string): Promise<void> {
  if (!alias || alias === canonical) return;
  try {
    await tx.transaction(async savepoint => {
      await savepoint.executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
        SELECT $1::text, $2::text, $3::text, 'frontmatter_slug_line' WHERE NOT EXISTS (SELECT 1 FROM pages WHERE source_id=$1::text AND slug=$2::text AND deleted_at IS NULL)
        ON CONFLICT (source_id, alias_slug) DO NOTHING`, [sourceId, alias, canonical]);
    });
  } catch (error) {
    if (!isMissingSchemaObject(error, 'table', 'slug_aliases')) throw error;
  }
}

/**
 * Move the slug-keyed rows that belong to a renamed page (#5431): facts about
 * it (`entity_slug`), facts read from its `## Facts` fence
 * (`source_markdown_slug`), its free-text search aliases (`page_aliases`), and
 * its fact withdrawals (a forgotten claim stays forgotten). Runs inside the
 * caller's rename transaction. The new slug is free (the page UPDATE
 * succeeded), so fence rows or aliases still keyed to it belong to a purged
 * page and yield to the moved ones. An ontology observation the new slug
 * already holds is dropped before its key moves (B-10, dropRekeyDuplicates).
 * A brain whose schema predates the facts or alias tables skips them inside a
 * savepoint.
 */
export async function moveSlugBindings(
  tx: Pick<BrainEngine, 'transaction' | 'executeRaw'>,
  sourceId: string,
  oldSlug: string,
  newSlug: string,
): Promise<void> {
  if (oldSlug === newSlug) return;
  await tx.executeRaw(MOVE_WITHDRAWAL_SUBJECT_SQL, [sourceId, oldSlug, newSlug]);
  type Savepoint = Pick<BrainEngine, 'executeRaw'>;
  const sql = (text: string) => (savepoint: Savepoint) => savepoint.executeRaw(text, [sourceId, oldSlug, newSlug]);
  const statements: Array<(savepoint: Savepoint) => Promise<unknown>> = [
    savepoint => dropRekeyDuplicates(savepoint, sourceId, { where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: [oldSlug, newSlug] }),
    sql(`UPDATE facts SET entity_slug = $3 WHERE source_id = $1 AND entity_slug = $2`),
    sql(`DELETE FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug = $3 AND f.row_num IS NOT NULL
       AND EXISTS (SELECT 1 FROM facts o WHERE o.source_id = $1 AND o.source_markdown_slug = $2 AND o.row_num = f.row_num)`),
    savepoint => dropRekeyDuplicates(savepoint, sourceId, { where: 'f.source_markdown_slug = $2', entity: 'f.entity_slug', sms: '$3::text', params: [oldSlug, newSlug] }),
    sql(`UPDATE facts SET source_markdown_slug = $3 WHERE source_id = $1 AND source_markdown_slug = $2`),
    sql(`DELETE FROM page_aliases a WHERE a.source_id = $1 AND a.slug = $3
       AND EXISTS (SELECT 1 FROM page_aliases o WHERE o.source_id = $1 AND o.slug = $2 AND o.alias_norm = a.alias_norm AND o.origin = a.origin)`),
    sql(`UPDATE page_aliases SET slug = $3 WHERE source_id = $1 AND slug = $2`),
  ];
  for (const statement of statements) {
    try {
      await tx.transaction(savepoint => statement(savepoint));
    } catch (error) {
      if (!isMissingSchemaObject(error, 'table', ['facts', 'page_aliases']) && !isMissingSchemaObject(error, 'column', ['dimension', 'value_hash'])) throw error;
    }
  }
}

/**
 * Move the page-id-keyed rows of a page whose rename fell back to add
 * semantics (#5431) onto the row that materialized at the destination, before
 * the stale row is soft-deleted: edges where it is the source, target or
 * origin, its timeline entries and its version history. Rows the surviving
 * page already holds under the same unique key (`links` composite key,
 * timeline dedup indexes) are dropped from the stale side, never duplicated.
 * Runs inside the caller's transaction and is idempotent.
 */
export async function movePageIdReferences(
  tx: Pick<BrainEngine, 'executeRaw'>,
  fromPageId: number,
  toPageId: number,
): Promise<void> {
  if (fromPageId === toPageId) return;
  const statements: Array<[string, unknown[]]> = [
    [`DELETE FROM links s WHERE s.from_page_id = $1 AND EXISTS (SELECT 1 FROM links o WHERE o.from_page_id = $2 AND o.to_page_id = s.to_page_id
        AND o.link_type = s.link_type AND o.link_source IS NOT DISTINCT FROM s.link_source AND o.origin_page_id IS NOT DISTINCT FROM s.origin_page_id)`, [fromPageId, toPageId]],
    [`UPDATE links SET from_page_id = $2 WHERE from_page_id = $1`, [fromPageId, toPageId]],
    [`DELETE FROM links s WHERE s.to_page_id = $1 AND EXISTS (SELECT 1 FROM links o WHERE o.to_page_id = $2 AND o.from_page_id = s.from_page_id
        AND o.link_type = s.link_type AND o.link_source IS NOT DISTINCT FROM s.link_source AND o.origin_page_id IS NOT DISTINCT FROM s.origin_page_id)`, [fromPageId, toPageId]],
    [`UPDATE links SET to_page_id = $2 WHERE to_page_id = $1`, [fromPageId, toPageId]],
    [`DELETE FROM links s WHERE s.origin_page_id = $1 AND EXISTS (SELECT 1 FROM links o WHERE o.origin_page_id = $2 AND o.from_page_id = s.from_page_id
        AND o.to_page_id = s.to_page_id AND o.link_type = s.link_type AND o.link_source IS NOT DISTINCT FROM s.link_source)`, [fromPageId, toPageId]],
    [`UPDATE links SET origin_page_id = $2 WHERE origin_page_id = $1`, [fromPageId, toPageId]],
    [`DELETE FROM timeline_entries s WHERE s.page_id = $1 AND EXISTS (SELECT 1 FROM timeline_entries o WHERE o.page_id = $2 AND o.date = s.date
        AND md5(o.summary) = md5(s.summary) AND o.source = s.source)`, [fromPageId, toPageId]],
    [`UPDATE timeline_entries SET page_id = $2 WHERE page_id = $1`, [fromPageId, toPageId]],
    [`DELETE FROM timeline_entries s WHERE s.event_page_id = $1 AND EXISTS (SELECT 1 FROM timeline_entries o WHERE o.event_page_id = $2 AND o.date = s.date)`, [fromPageId, toPageId]],
    [`UPDATE timeline_entries SET event_page_id = $2 WHERE event_page_id = $1`, [fromPageId, toPageId]],
    [`UPDATE page_versions SET page_id = $2 WHERE page_id = $1`, [fromPageId, toPageId]],
  ];
  for (const [sql, params] of statements) await tx.executeRaw(sql, params);
}
