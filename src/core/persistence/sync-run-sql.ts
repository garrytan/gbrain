/**
 * The SQL text the managed sync's statement table (engine-sql/managed-sync-store.ts) composes from shared parts: the unfinished
 * page request predicate, the no-op kernel's page read and the folded stamp's refused-checkpoint read. Kept here, beside the
 * callers that build the same text (sync-waivers.ts, noop-kernel.ts, sync-pass-fold.ts), so the table carries each statement whole.
 */
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { supersessionSql } from './supersession-sql.ts';

const PAGE_MATCH = `r.source_id=$3 AND (r.slug=$4 OR r.page_id=$5::bigint OR r.intent->'renameFrom'->>'slug'=$4 OR r.intent->'renameFrom'->>'pageId'=$6
  OR ($7::text IS NOT NULL AND (r.intent->>'path'=$7 OR r.intent->>'sourcePath'=$8 OR r.intent->'renameFrom'->>'sourcePath'=$8)))`;

/**
 * CEO-A12/A34: an unfinished request for the page, by slug, page id or a rename from it; #6278: also by the entry's file path or
 * origin, or a rename from that origin (`$7`, `$8`; null skips the path match). Each branch matches one partial request index:
 * worktree pending, worktree recovery, and database-only pending by source incarnation.
 */
export const UNFINISHED_PAGE_REQUEST_SQL = `SELECT 1 FROM (
  (SELECT r.id FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.state IN ('queued','running','recovering') AND ${PAGE_MATCH} LIMIT 1)
  UNION ALL (SELECT r.id FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND r.recovery IS NOT NULL AND ${PAGE_MATCH} LIMIT 1)
  UNION ALL (SELECT r.id FROM persistence_requests r WHERE r.source_incarnation=$2::uuid AND r.worktree_id IS NULL
    AND r.state IN ('queued','running','recovering') AND ${PAGE_MATCH} LIMIT 1)) unfinished LIMIT 1`;

/**
 * The kernel's page read; callers append the `WHERE` (one page by id, or #6712 PR 1 a prescreened run by slug).
 * `manifest` is chunkManifestReads: a write role without the segment grants that sees no segmented chunk reads it too.
 */
export const kernelPageSql = (manifest: boolean) => `SELECT p.id,p.slug,p.chunker_version,p.text_projection_revision::text,p.knowledge_revision::text,p.source_path,
      (p.contextual_retrieval_mode IS NULL AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding IS NOT NULL AND ${chunkGenerationFilter('p', 'c', manifest)})) AS mode_pending,
      EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id AND c.embedding IS NULL AND ${chunkGenerationFilter('p', 'c', manifest)}) AS unembedded
    FROM pages p`;


export const KERNEL_PAGES_BY_SLUG_SQL = `${kernelPageSql(true)} WHERE p.source_id=$1 AND p.slug=ANY($2::text[]) AND p.deleted_at IS NULL`;
export const KERNEL_PAGES_BY_SLUG_UNMANIFESTED_SQL = `${kernelPageSql(false)} WHERE p.source_id=$1 AND p.slug=ANY($2::text[]) AND p.deleted_at IS NULL`;
export const KERNEL_PAGE_BY_ID_SQL = `${kernelPageSql(true)} WHERE p.id=$1 AND p.deleted_at IS NULL`;
export const KERNEL_PAGE_BY_ID_UNMANIFESTED_SQL = `${kernelPageSql(false)} WHERE p.id=$1 AND p.deleted_at IS NULL`;

/** A failed, conflicted or cancelled sync checkpoint of the source that no later request supersedes (`supersessionSql`). */
export const REFUSED_CHECKPOINT_SQL = `SELECT 1 FROM persistence_requests r WHERE r.source_id=$1 AND r.slug='__managed_sync_checkpoint__' AND r.intent IS NOT NULL AND NOT r.compacted
      AND r.operation='submit_job' AND r.intent->>'kind'='managed_sync_checkpoint' AND r.state IN ('failed','conflict','cancelled')
      AND NOT EXISTS (SELECT 1 FROM persistence_requests c WHERE ${supersessionSql('r', 'c')}) LIMIT 1`;
