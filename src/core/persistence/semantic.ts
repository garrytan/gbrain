import type { WriteRequest } from './model.ts';
export const SEMANTIC_PAGE_OPERATIONS: ReadonlySet<string> = new Set([
  'add_tag', 'remove_tag', 'add_timeline_entry', 'takes_add', 'takes_update', 'takes_supersede', 'takes_resolve', 'takes_remove', 'remember',
]);
/**
 * Recompute only supported merges; caller-supplied stale replacements remain conflicts. #5385 [R13]: a merge submitted
 * without `expected_revision` meets the page as it is, so the missing-precondition code `revision_required` is as
 * recomputable as the mid-preparation `revision_conflict`; a stale supplied revision is neither.
 */
export function mayReprepare(row: WriteRequest, error: { code?: string }): boolean {
  return (error.code === 'revision_conflict' || error.code === 'revision_required') && row.intent?.expected_revision === undefined
    && (SEMANTIC_PAGE_OPERATIONS.has(row.operation) || row.intent?.force === true);
}
