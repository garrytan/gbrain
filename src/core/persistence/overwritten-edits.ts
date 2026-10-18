/**
 * #6712 follow-up: pages an incremental managed sync silently overwrote. Before #6887, `classifyBaseline`
 * (sync-prescreen.ts) guarded a page that moved in both the database and Git only in a tree walk, so a plain delta sync
 * published a committed file edit over a database-only edit (a `put_page` with `sync.write_through` off) with no
 * `file_drift` hold and no backup. The edit survives as the page
 * version the import archived. This module finds it from durable rows only, so it finds damage done before the fix too:
 *
 * - `page_versions.write_request_id` names the request that wrote the lost revision and `archived_write_request_id` the
 *   request whose write archived it (attribution-schema.ts, `STAMP_VERSION_FUNCTION`);
 * - the archiving request is a managed-sync import: intent kind `managed_sync_import`, or, once receipt compaction nulled
 *   the intent, operation `submit_job` with `outcome.imported_file` and no `outcome.connector_database`;
 * - the lost revision's writer published no file: its committed receipt says `outcome.persistence.mode = 'database'`
 *   (coordinator.ts `decoratePublicationOutcome`), it is not itself an import, no `git` effect carries that revision, and
 *   it was not a read-only mirror write (upstream wins there by design);
 * - the import replaced it with different content: the import's own revision (its version row, or the live page) differs
 *   from the lost one (`reconcileCanonical` digest), and no later revision of the page holds the lost content again.
 *
 * `high`: every condition holds and every version involved is inline. `unknown`: the writer receipt carries no
 * `persistence` outcome, the import's content is no longer readable, or a version is segmented. A lost revision with no
 * recorded writer (pre-attribution, classic sync, unattributed maintenance) is not reported: it cannot be told apart from
 * ordinary sync history. Read-only and bounded (`OVERWRITE_SCAN_LIMIT` candidate versions per source, newest first).
 */
import type { BrainEngine } from '../engine.ts';
import type { PageType } from '../types.ts';
import { digest } from './digest.ts';
import { reconcileCanonical } from './reconcile-merge.ts';

/** Candidate versions read per source, newest first. */
export const OVERWRITE_SCAN_LIMIT = 500;

export type OverwriteConfidence = 'high' | 'unknown';
export type OverwriteUnknownReason = 'no_persistence_outcome' | 'import_content_unreadable' | 'segmented';

/** The content fields of a page or page version that a restore brings back. */
export interface OverwriteContent { title: string; type: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown>; tags: string[] }

export interface OverwrittenEdit {
  source_id: string; slug: string; page_id: number;
  /** The archived version holding the database edit; a restore reverts to it. */
  version_id: number; lost_revision: string;
  db_request_id: string; db_operation: string; import_request_id: string; imported_at: string | null;
  confidence: OverwriteConfidence; reason?: OverwriteUnknownReason;
  /** The page's live revision when scanned (a restore is bound to it). */
  page_revision: string;
  /** Digest of the lost content; null for a segmented version. */
  lost_digest: string | null;
  /** Older open overwrites of the same page (the newest one is the reported edit). */
  earlier: number;
}

export interface OverwriteSourceScan { source_id: string; high: number; unknown: number; edits: OverwrittenEdit[]; truncated: boolean }

interface ContentRow {
  body_storage: string | null; title: string | null; type: string | null; compiled_truth: string | null; timeline: string | null;
  frontmatter: Record<string, unknown> | string | null; tags: unknown;
}
interface CandidateRow extends ContentRow {
  version_id: number | string; page_id: number | string; slug: string; lost_revision: string; db_request_id: string; db_operation: string;
  import_request_id: string; imported_at: string | Date | null; db_outcome_known: boolean;
}
interface VersionRow extends ContentRow { id: number | string; page_id: number | string; write_request_id: string | null }
interface LiveRow extends ContentRow { page_id: number | string; revision: string; revision_write_request_id: string | null }

const MANAGED_IMPORT = (r: string) => `(${r}.intent->>'kind' = 'managed_sync_import'
  OR (${r}.intent IS NULL AND ${r}.outcome->>'imported_file' = 'true' AND NOT (${r}.outcome ? 'connector_database')))`;
const CONTENT_COLUMNS = (v: string) => `${v}.body_storage, ${v}.title, ${v}.type, ${v}.compiled_truth, ${v}.timeline, ${v}.frontmatter`;

const parsed = (value: unknown) => typeof value === 'string' ? JSON.parse(value) as unknown : value;

/** The comparable content of an inline page or version row; null when it is segmented (its body lives in segments). */
export function overwriteContent(row: ContentRow): OverwriteContent | null {
  if (row.body_storage === 'segmented' || row.compiled_truth === null) return null;
  const tags = parsed(row.tags);
  return { title: row.title ?? '', type: row.type ?? '', compiled_truth: row.compiled_truth, timeline: row.timeline ?? '',
    frontmatter: (parsed(row.frontmatter) ?? {}) as Record<string, unknown>, tags: Array.isArray(tags) ? [...new Set(tags.map(String))].sort() : [] };
}

export const overwriteDigest = (content: OverwriteContent) => digest(reconcileCanonical({ title: content.title, type: content.type as PageType,
  compiled_truth: content.compiled_truth, timeline: content.timeline, frontmatter: content.frontmatter }, content.tags));

const sameContent = (row: ContentRow, lostDigest: string) => {
  const content = overwriteContent(row);
  return content !== null && overwriteDigest(content) === lostDigest;
};

/** The source's open overwrites of live pages (the newest per page), from at most `limit` candidate versions; `slugs` narrows it. */
export async function scanOverwrittenEdits(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string,
  opts: { limit?: number; slugs?: readonly string[] } = {}): Promise<OverwriteSourceScan> {
  const limit = opts.limit ?? OVERWRITE_SCAN_LIMIT;
  const candidates = await engine.executeRaw<CandidateRow>(`SELECT v.id AS version_id, v.page_id, p.slug, v.knowledge_revision::text AS lost_revision,
      w.id::text AS db_request_id, w.operation AS db_operation, s.id::text AS import_request_id, s.completed_at AS imported_at,
      COALESCE(w.outcome->'persistence'->>'mode' = 'database', false) AS db_outcome_known, ${CONTENT_COLUMNS('v')}, v.tags
    FROM pages p
    JOIN page_versions v ON v.page_id = p.id
    JOIN persistence_requests s ON s.id = v.archived_write_request_id
    JOIN persistence_requests w ON w.id = v.write_request_id
    WHERE p.source_id = $1 AND p.deleted_at IS NULL AND ($3::text[] IS NULL OR p.slug = ANY($3::text[]))
      AND s.state = 'committed' AND s.operation = 'submit_job' AND s.source_id = p.source_id AND ${MANAGED_IMPORT('s')}
      AND w.state = 'committed' AND w.source_id = p.source_id AND NOT (w.operation = 'submit_job' AND COALESCE(w.outcome->>'imported_file', '') = 'true')
      AND (w.outcome->'persistence'->>'mode' = 'database'
        OR (NOT (COALESCE(w.outcome, '{}'::jsonb) ? 'persistence') AND COALESCE(w.outcome->'write_through'->>'written', 'false') <> 'true'))
      AND COALESCE(w.outcome->'write_through'->>'skipped', '') <> 'mirror_read_only' AND COALESCE(w.outcome->>'storage', '') <> 'database_only'
      AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.kind = 'git' AND e.revision = v.knowledge_revision)
    ORDER BY v.id DESC LIMIT $2`, [sourceId, limit + 1, opts.slugs?.length ? [...opts.slugs] : null]);
  const truncated = candidates.length > limit;
  const rows = candidates.slice(0, limit);
  if (!rows.length) return { source_id: sourceId, high: 0, unknown: 0, edits: [], truncated };
  const pageIds = [...new Set(rows.map(row => Number(row.page_id)))];
  const later = await engine.executeRaw<VersionRow>(`SELECT v.id, v.page_id, v.write_request_id::text AS write_request_id, ${CONTENT_COLUMNS('v')}, v.tags
    FROM page_versions v WHERE v.page_id = ANY($1::int[]) AND v.id > $2 ORDER BY v.id`, [pageIds, Math.min(...rows.map(row => Number(row.version_id)))]);
  const live = await engine.executeRaw<LiveRow>(`SELECT p.id AS page_id, p.knowledge_revision::text AS revision, p.revision_write_request_id::text AS revision_write_request_id,
      ${CONTENT_COLUMNS('p')}, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags
    FROM pages p WHERE p.id = ANY($1::int[])`, [pageIds]);
  const pages = new Map(live.map(row => [Number(row.page_id), row]));
  const newest = new Map<number, OverwrittenEdit>();
  for (const row of rows) {
    const pageId = Number(row.page_id), versionId = Number(row.version_id);
    const page = pages.get(pageId);
    if (!page) continue;
    const after = later.filter(entry => Number(entry.page_id) === pageId && Number(entry.id) > versionId);
    const imported: ContentRow | undefined = after.find(entry => entry.write_request_id === row.import_request_id)
      ?? (page.revision_write_request_id === row.import_request_id ? page : undefined);
    const lost = overwriteContent(row);
    const lostDigest = lost ? overwriteDigest(lost) : null;
    if (lostDigest !== null && imported && sameContent(imported, lostDigest)) continue;
    if (lostDigest !== null && [...after, page].some(entry => entry !== imported && sameContent(entry, lostDigest))) continue;
    const reason: OverwriteUnknownReason | undefined = !lost || (imported && !overwriteContent(imported)) || !overwriteContent(page) ? 'segmented'
      : !imported ? 'import_content_unreadable' : !row.db_outcome_known ? 'no_persistence_outcome' : undefined;
    const kept = newest.get(pageId);
    if (kept) { kept.earlier++; continue; }
    newest.set(pageId, { source_id: sourceId, slug: row.slug, page_id: pageId, version_id: versionId, lost_revision: row.lost_revision,
      db_request_id: row.db_request_id, db_operation: row.db_operation, import_request_id: row.import_request_id,
      imported_at: row.imported_at === null ? null : new Date(row.imported_at).toISOString(),
      confidence: reason ? 'unknown' : 'high', ...(reason ? { reason } : {}), page_revision: page.revision, lost_digest: lostDigest, earlier: 0 });
  }
  const edits = [...newest.values()];
  return { source_id: sourceId, high: edits.filter(edit => edit.confidence === 'high').length, unknown: edits.filter(edit => edit.confidence === 'unknown').length, edits, truncated };
}
