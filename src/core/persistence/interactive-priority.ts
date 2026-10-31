/** Only retained, page-scoped maintenance intents qualify; unknown jobs remain FIFO. */
export const BULK_PUBLICATION_SQL = (r: string) => `(${r}.operation='extract_facts' AND COALESCE(${r}.intent->>'kind','') IN ('managed_facts_entity','managed_facts_complete')
  OR ${r}.operation='submit_job' AND COALESCE(${r}.intent->>'kind','') IN ('managed_atom_page','managed_atom_delete','managed_atom_complete'))`;

export function bulkPublication(row: { operation: string; intent: Record<string, unknown> | null }): boolean {
  const kind = row.intent?.kind;
  return row.operation === 'extract_facts' && ['managed_facts_entity', 'managed_facts_complete'].includes(String(kind))
    || row.operation === 'submit_job' && ['managed_atom_page', 'managed_atom_delete', 'managed_atom_complete'].includes(String(kind));
}

/**
 * Source publication may pass unstarted bulk work, never a running/recovering request,
 * its target, or the page the bulk job read. Unknown/null targets fail closed.
 * The existing foreground switch and one owed FIFO turn per root bound priority.
 */
export const PASSES_QUEUED_BULK = (bulk: string, write: string, priority: string) => `((${priority})
  AND ${write}.operation='put_page' AND ${bulk}.state='queued' AND ${bulk}.recovery IS NULL
  AND ${BULK_PUBLICATION_SQL(bulk)}
  AND ${bulk}.source_id IS NOT NULL AND ${write}.source_id IS NOT NULL
  AND (${bulk}.source_id<>${write}.source_id OR (
    ${bulk}.slug IS NOT NULL AND ${write}.slug IS NOT NULL AND ${bulk}.slug<>${write}.slug
    AND (${bulk}.page_id IS NULL OR ${write}.page_id IS NULL OR ${bulk}.page_id<>${write}.page_id)
    AND COALESCE(${bulk}.intent->'origin'->>'slug','')<>${write}.slug
    AND COALESCE(${bulk}.intent->'origin'->>'locator','')<>${write}.slug
    AND (${write}.page_id IS NULL OR COALESCE(${bulk}.intent->'origin'->>'pageId','')<>${write}.page_id::text))))`;
