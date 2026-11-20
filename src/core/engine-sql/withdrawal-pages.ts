/**
 * The page statements a fact withdrawal (recordFactWithdrawal, src/core/facts/withdrawal.ts) runs on the pages that
 * carry the withdrawn claim. They ran through `executeRaw` before they were typed members; each keeps the statement
 * text and parameter order its call site ran, so PGLite and Postgres answer exactly as before
 * (test/withdrawal-pages-sql-pin.test.ts pins the text). A Rust brain refuses them with
 * engine_capability_missing until the Rust store gets native methods.
 *
 * - `listSegmentedPages`: the id and slug of the segmented pages among `slugs` in the source, which the withdrawal
 *   strikes segment by segment.
 * - `invalidateWithdrawnPages`: gives every other page among `slugs` in the source a new knowledge revision and
 *   clears its text projection revision and embedding signature, returning id, slug and the new revision. The
 *   revision triggers queue the page's projection rebuild in the same transaction.
 *
 * Neither filters soft-deleted pages, as neither statement did. The withdrawal reads a segmented page's new revision
 * after its rewrite with a plain `SELECT id,slug,knowledge_revision FROM pages WHERE id=ANY(...)` in
 * src/core/facts/withdrawal.ts.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** A page a withdrawal changes: its id, slug and (after invalidation) its new knowledge revision. */
export interface WithdrawnPageRow { id: number; slug: string; knowledge_revision: string }

const SEGMENTED_PAGES_SQL = `SELECT id,slug FROM pages
        WHERE source_id=$1 AND slug=ANY($2::text[]) AND body_storage='segmented'`;

const INVALIDATE_PAGES_SQL = `UPDATE pages SET knowledge_revision=gen_random_uuid(),text_projection_revision=NULL,embedding_signature=NULL
          WHERE source_id=$1 AND slug=ANY($2::text[]) AND body_storage<>'segmented' RETURNING id,slug,knowledge_revision`;

/** The segmented pages among `slugs` in `sourceId`. */
export async function listSegmentedPages(exec: Raw, sourceId: string, slugs: readonly string[]): Promise<Array<{ id: number; slug: string }>> {
  return exec.executeRaw<{ id: number; slug: string }>(SEGMENTED_PAGES_SQL, [sourceId, [...slugs]]);
}

/** New knowledge revisions for the inline pages among `slugs` in `sourceId`, with their projection and signature cleared. */
export async function invalidateWithdrawnPages(exec: Raw, sourceId: string, slugs: readonly string[]): Promise<WithdrawnPageRow[]> {
  return exec.executeRaw<WithdrawnPageRow>(INVALIDATE_PAGES_SQL, [sourceId, [...slugs]]);
}
