/**
 * The reads of the overwritten-edits scan (src/core/persistence/overwritten-edits.ts: `gbrain repair overwritten-edits`
 * and the doctor check) and of the repair's version re-read. Both SQL engines delegate here; the Rust store serves the
 * same members from its version receipts and write journal (rust/crates/gbrain-store/src/repair_versions.rs).
 *
 * - `listOverwriteCandidates`: versions of live pages whose archiving request is a committed managed-sync import and
 *   whose writing request is a committed database write that published no file, newest first.
 * - `listVersionsAfter`: the later versions of the candidate pages.
 * - `listOverwriteLivePages`: each candidate page's revision, its writing request, content and tags.
 * - `readVersionContent`: one version's content columns (the repair renders it as `revert_version` does).
 * - `readPageVersionRow`: the whole version row `revert_version` reverts to (src/core/persistence/page-prepare.ts).
 */
import type { BrainEngine } from '../engine.ts';
import type { PageVersion } from '../page-state/version-types.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The content columns of a page or page version. */
export interface OverwriteContentRow {
  body_storage: string | null; title: string | null; type: string | null; compiled_truth: string | null; timeline: string | null;
  frontmatter: Record<string, unknown> | string | null; tags: unknown;
}
export interface OverwriteCandidateRow extends OverwriteContentRow {
  version_id: number | string; page_id: number | string; slug: string; lost_revision: string; db_request_id: string; db_operation: string;
  import_request_id: string; imported_at: string | Date | null; db_outcome_known: boolean;
}
export interface OverwriteVersionRow extends OverwriteContentRow { id: number | string; page_id: number | string; write_request_id: string | null }
export interface OverwriteLiveRow extends OverwriteContentRow { page_id: number | string; revision: string; revision_write_request_id: string | null }

/** The source's overwrite candidates (`slugs` narrows them), newest version first, at most `limit`. */
export async function listOverwriteCandidates(raw: Raw, sourceId: string, slugs: readonly string[] | null, limit: number): Promise<OverwriteCandidateRow[]> {
  return raw.executeRaw<OverwriteCandidateRow>(`SELECT v.id AS version_id, v.page_id, p.slug, v.knowledge_revision::text AS lost_revision,
      w.id::text AS db_request_id, w.operation AS db_operation, s.id::text AS import_request_id, s.completed_at AS imported_at,
      COALESCE(w.outcome->'persistence'->>'mode' = 'database', false) AS db_outcome_known, v.body_storage, v.title, v.type, v.compiled_truth, v.timeline, v.frontmatter, v.tags
    FROM page_versions v
    JOIN pages p ON p.id = v.page_id
    JOIN persistence_requests s ON s.id = v.archived_write_request_id
    JOIN persistence_requests w ON w.id = v.write_request_id
    WHERE p.source_id = $1 AND p.deleted_at IS NULL AND ($3::text[] IS NULL OR p.slug = ANY($3::text[]))
      AND s.state = 'committed' AND s.operation = 'submit_job' AND s.source_id = p.source_id AND (s.intent->>'kind' = 'managed_sync_import'
  OR (s.intent IS NULL AND s.outcome->>'imported_file' = 'true' AND NOT (s.outcome ? 'connector_database')))
      AND w.state = 'committed' AND w.source_id = p.source_id AND NOT (w.operation = 'submit_job' AND COALESCE(w.outcome->>'imported_file', '') = 'true')
      AND (w.outcome->'persistence'->>'mode' = 'database'
        OR (NOT (COALESCE(w.outcome, '{}'::jsonb) ? 'persistence') AND COALESCE(w.outcome->'write_through'->>'written', 'false') <> 'true'))
      AND COALESCE(w.outcome->'write_through'->>'skipped', '') <> 'mirror_read_only' AND COALESCE(w.outcome->>'storage', '') <> 'database_only'
      AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.kind = 'git' AND e.revision = v.knowledge_revision)
    ORDER BY v.id DESC LIMIT $2`, [sourceId, limit, slugs === null ? null : [...slugs]]);
}

/** The versions of the pages with an id over `afterId`, by id. */
export async function listVersionsAfter(raw: Raw, pageIds: readonly number[], afterId: number): Promise<OverwriteVersionRow[]> {
  return raw.executeRaw<OverwriteVersionRow>(`SELECT v.id, v.page_id, v.write_request_id::text AS write_request_id, v.body_storage, v.title, v.type, v.compiled_truth, v.timeline, v.frontmatter, v.tags
    FROM page_versions v WHERE v.page_id = ANY($1::int[]) AND v.id > $2 ORDER BY v.id`, [[...pageIds], afterId]);
}

/** Each named page's revision, the request that wrote it, its content and its tags in tag order. */
export async function listOverwriteLivePages(raw: Raw, pageIds: readonly number[]): Promise<OverwriteLiveRow[]> {
  return raw.executeRaw<OverwriteLiveRow>(`SELECT p.id AS page_id, p.knowledge_revision::text AS revision, p.revision_write_request_id::text AS revision_write_request_id,
      p.body_storage, p.title, p.type, p.compiled_truth, p.timeline, p.frontmatter, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags
    FROM pages p WHERE p.id = ANY($1::int[])`, [[...pageIds]]);
}

/** The content columns of version `versionId` of page `pageId`, or null. */
export async function readVersionContent(raw: Raw, versionId: number, pageId: number): Promise<OverwriteContentRow | null> {
  const [row] = await raw.executeRaw<OverwriteContentRow>(
    'SELECT body_storage, title, type, compiled_truth, timeline, frontmatter, tags FROM page_versions WHERE id=$1 AND page_id=$2', [versionId, pageId]);
  return row ?? null;
}

/** The whole row of version `versionId` of page `pageId`, as `revert_version` reads it (moved from page-prepare.ts unchanged), or null. */
export async function readPageVersionRow(raw: Raw, versionId: number, pageId: number): Promise<PageVersion | null> {
  const [version] = await raw.executeRaw<PageVersion>(
        'SELECT * FROM page_versions WHERE id=$1 AND page_id=$2', [versionId, pageId]);
  return version ?? null;
}
