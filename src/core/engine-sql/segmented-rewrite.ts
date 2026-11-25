/**
 * The statements of a segmented page's write that ran through `engine.executeRaw` and are typed members now, so a Rust
 * brain answers each from its store (rust/docs/store/page_body.md): a live fence rewrite's page read and `deleted_at`
 * restore (page-body/segment-rewrite.ts), and the live page a segmented write diffs against (page-body/ingest.ts). The
 * chunk probes, the stale-chunk retirement and the retired-vector read of a segmented write are in
 * engine-sql/segmented-writes.ts. PGLite and Postgres run the statements their callers ran.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead };

/** The page a live fence rewrite reads (page-body/segment-rewrite.ts), deleted or not, with its tags in byte order. */
export interface SegmentedRewritePageRow {
  id: number; slug: string; source_id: string; title: string; type: string; page_kind: string; frontmatter: Record<string, unknown> | null;
  body_generation: number | string; body_bytes: number | string; body_flags: Record<string, unknown> | null; body_storage: string; deleted_at: string | null;
  contextual_retrieval_mode: string | null; corpus_generation: string | null; tags: string[];
}

/** Page `pageId` as a live fence rewrite reads it, deleted or not, or null. Tags sort bytewise (COLLATE "C") on every engine. */
export async function readSegmentedRewritePage(raw: EngineRawRead, pageId: number): Promise<SegmentedRewritePageRow | null> {
  const [row] = await raw<SegmentedRewritePageRow>(`SELECT p.id,p.slug,p.source_id,p.title,
      p.type,p.page_kind,p.frontmatter,p.body_generation,p.body_bytes,p.body_flags,p.body_storage,p.deleted_at,p.contextual_retrieval_mode,p.corpus_generation,
      COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id=p.id),'[]'::jsonb) AS tags FROM pages p WHERE p.id=$1`, [pageId]);
  return row ?? null;
}

/** Sets page `pageId`'s deleted_at back to `deletedAt` (a rewrite of a soft-deleted page leaves it deleted). */
export async function restorePageDeletedAt(raw: EngineRawRead, pageId: number, deletedAt: string): Promise<void> {
  await raw('UPDATE pages SET deleted_at=$2 WHERE id=$1', [pageId, deletedAt]);
}

// ─── the page read of a segmented write ────────────────

/** The live page a segmented write diffs against, read by id (metadata only). */
export interface SegmentedLivePageRow {
  id: number; body_generation: number | string; body_storage: string; title: string; type: string; body_flags: Record<string, unknown> | null;
}

/** Page `pageId`'s storage class, generation, title, type and body flags, deleted or not; null when there is no such page. */
export async function readSegmentedLivePage(raw: EngineRawRead, pageId: number): Promise<SegmentedLivePageRow | null> {
  const [row] = await raw<SegmentedLivePageRow>('SELECT id, body_generation, body_storage, title, type, body_flags FROM pages WHERE id=$1', [pageId]);
  return row ?? null;
}
