/**
 * #7462: an atom names its origin page by slug (`frontmatter.source_slug`). A sync rename keeps the page row and
 * its id, records `old -> new` in slug_aliases with notes 'rename' (recordRenameAlias, chains collapsed onto the
 * newest slug), and leaves the atoms as they are: on a repo brain the slug is in the atom files, and git stays their
 * record. Readers that look up an atom's origin resolve the old slug through the rename alias instead. Other alias
 * rows (a removed frontmatter slug line, a schema-pack page-to-alias rule) never moved a page, so they are not
 * followed and an atom behind one keeps a missing origin. Static strings only.
 */

/** SQL: the slug a rename moved the page that held `slugSql` in source `sourceIdSql` to, or NULL (one probe of slug_aliases' (source_id, alias_slug) key). */
export function renamedSlugSql(sourceIdSql: string, slugSql: string): string {
  return `(SELECT renamed.canonical_slug FROM slug_aliases renamed
    WHERE renamed.source_id=${sourceIdSql} AND renamed.alias_slug=${slugSql} AND renamed.notes='rename')`;
}

/** SQL: the slug atom `a`'s origin page holds now: its `source_slug` while any page row holds it, deleted or not, else the slug a rename moved that page to. A page created later at the old slug, even one deleted since, is never passed over for the renamed page. */
export function atomOriginSlugSql(a: string): string {
  const slug = `(${a}.frontmatter->>'source_slug')`;
  return `COALESCE(CASE WHEN NOT EXISTS (SELECT 1 FROM pages live_origin WHERE live_origin.source_id=${a}.source_id
      AND live_origin.slug=${slug}) THEN ${renamedSlugSql(`${a}.source_id`, slug)} END, ${slug})`;
}

/** SQL array of every slug that may name atom `a`'s origin (its `source_slug` and that slug's rename target), for rules where either page being private makes the atom private. */
export function atomOriginSlugsSql(a: string): string {
  const slug = `(${a}.frontmatter->>'source_slug')`;
  return `ARRAY[${slug}, ${renamedSlugSql(`${a}.source_id`, slug)}]`;
}

/**
 * SQL: true when a page slug_rename_history moved atom `a`'s `source_slug` to is private (#8920). A later rename onto the
 * old slug drops the alias, so atomOriginSlugsSql alone misses that origin (GBRA-218, as gbrain_access_origin_restricted
 * reads it). A separate probe keeps the read rule's planner cost under jit_above_cost.
 */
export function atomMovedOriginPrivateSql(a: string): string {
  return `EXISTS (SELECT 1 FROM slug_rename_history moved JOIN pages moved_to ON moved_to.source_id=moved.source_id
    AND moved_to.slug=moved.new_slug WHERE moved.source_id=${a}.source_id AND moved.old_slug=(${a}.frontmatter->>'source_slug')
    AND moved_to.frontmatter->>'visibility'='private')`;
}
