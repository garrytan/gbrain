/**
 * The classifier read of `gbrain repair unwithdrawn-facts` (src/core/repair/unwithdrawn-facts.ts) beyond its listing: a
 * candidate's page body by id (null columns for a segmented body, which the classifier reads block by block). One SQL
 * implementation for both engines; the statement is the text the classifier sent through `executeRaw`, byte for byte,
 * with the same parameter. The Rust store serves it (rust/crates/gbrain-store/src/facts/unwithdrawn_restore.rs). The
 * restore itself runs only inside a managed publication (an unmanaged brain's preview excludes every row), so it keeps
 * its raw statements and its named stop.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** A page's inline body by id; a segmented body reads null columns. */
export interface PageInlineBody { id: number; compiled_truth: string | null; timeline: string | null; body_storage: string | null }

const PAGE_INLINE_BODY_SQL = `SELECT id, CASE WHEN body_storage = 'segmented' THEN NULL ELSE compiled_truth END AS compiled_truth,
        CASE WHEN body_storage = 'segmented' THEN NULL ELSE timeline END AS timeline, body_storage FROM pages WHERE id = $1`;

/** Page `pageId`'s inline body, or null when no page has the id. */
export async function readPageInlineBody(raw: Raw, pageId: number | string): Promise<PageInlineBody | null> {
  return (await raw.executeRaw<PageInlineBody>(PAGE_INLINE_BODY_SQL, [pageId]))[0] ?? null;
}
