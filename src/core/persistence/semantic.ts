import type { WriteRequest } from './model.ts';
export const SEMANTIC_PAGE_OPERATIONS: ReadonlySet<string> = new Set([
  'add_tag', 'remove_tag', 'add_timeline_entry', 'takes_add', 'takes_update', 'takes_supersede', 'takes_resolve', 'remember',
]);
/** Recompute only supported merges; caller-supplied stale replacements remain conflicts. */
export function mayReprepare(row: WriteRequest, error: { code?: string }): boolean {
  return error.code === 'revision_conflict' && row.intent?.expected_revision === undefined
    && (SEMANTIC_PAGE_OPERATIONS.has(row.operation) || row.intent?.force === true);
}
