/**
 * The page reads of the maintenance sweep (core/sweep.ts): one SQL implementation for both engines. Each statement is
 * the text sweep.ts ran through `executeRaw` at c231d6c992, byte for byte (test/engine-sql-caller-raw-sql-pins.test.ts).
 * Every member runs on the executor it is given, so a member of a transaction-bound engine runs on that transaction.
 */

/** The engine's own executeRaw (a transaction-bound engine inside a transaction). */
export interface SweepReadsExec {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** The begin marker of a facts fence; a page whose compiled truth holds it may owe fence reconciliation. */
export const FACTS_FENCE_BEGIN_MARKER = 'gbrain:facts:begin';

/** `listFactsFencePages` options: `since` is an ISO timestamp, `scanCap` the newest pages scanned, `limit` the slugs kept. */
export interface FactsFencePagesQuery { sourceId: string; since: string; scanCap: number; limit: number }

/** `listSweepStalePages` options: `exclude` are slugs left out before the LIMIT. */
export interface SweepStalePagesQuery { sourceId: string; since: string; limit: number; exclude: readonly string[] }

/** `listSweepDeferredPages` options: only these slugs are read. */
export interface SweepDeferredPagesQuery { sourceId: string; since: string; slugs: readonly string[] }

/**
 * A page the links and timeline pass owes: `updated_at_iso` is its `updated_at` in full-µs UTC (#1768), `read_at` the
 * statement's `now()` in the same form, `body_bytes` a number (NULL for an inline page).
 */
export interface SweepStalePageRow { slug: string; read_at: string; updated_at_iso: string; body_storage: string | null; body_bytes: number | null }

/** A live page found by slug (`listPageRefsForSlugs`): its source, type and knowledge revision. */
export interface SweepPageRefRow { slug: string; source_id: string; type: string; knowledge_revision: string }

/** A deferred segmented page that is still stale: its slug and `updated_at` in full-µs UTC. */
export interface SweepDeferredPageRow { slug: string; updated_at_iso: string }

// The leading-wildcard LIKE can't use an index, so it scans only the newest scanCap rows in the recency window (inner
// subquery) rather than every row a bulk-sync day may have touched.
const FACTS_FENCE_PAGES_SQL = `SELECT slug FROM (
             SELECT id, slug, compiled_truth, body_storage, updated_at FROM pages
              WHERE source_id = $1
                AND deleted_at IS NULL
                AND updated_at >= $2::timestamptz
              ORDER BY updated_at DESC
              LIMIT $4
           ) AS recent
            WHERE compiled_truth LIKE $3
               OR (body_storage = 'segmented' AND EXISTS (SELECT 1 FROM page_body_manifest m
                     WHERE m.page_id = recent.id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots <> '[]'::jsonb))
            ORDER BY updated_at DESC
            LIMIT $5`;

const SWEEP_STALE_PAGES_SQL = `SELECT slug, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso,
            body_storage, body_bytes
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND updated_at >= $2::timestamptz
        AND (links_extracted_at IS NULL OR updated_at > links_extracted_at)
        AND NOT (slug = ANY($4::text[]))
      ORDER BY updated_at DESC
      LIMIT $3`;

const PAGE_REFS_FOR_SLUGS_SQL = `SELECT slug, source_id, type, knowledge_revision FROM pages
        WHERE deleted_at IS NULL AND slug = ANY($1::text[])`;

const SWEEP_DEFERRED_PAGES_SQL = `SELECT slug, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND updated_at >= $2::timestamptz
        AND (links_extracted_at IS NULL OR updated_at > links_extracted_at)
        AND slug = ANY($3::text[])`;

/**
 * The facts-fence pass's pages: of the newest `scanCap` live pages of the source updated at or after `since`, those
 * whose compiled truth holds the fence marker or that are segmented with a published facts slot, newest first, at most
 * `limit`.
 */
export async function listFactsFencePages(exec: SweepReadsExec, q: FactsFencePagesQuery): Promise<string[]> {
  const rows = await exec.executeRaw<{ slug: string }>(FACTS_FENCE_PAGES_SQL,
    [q.sourceId, q.since, `%${FACTS_FENCE_BEGIN_MARKER}%`, q.scanCap, q.limit]);
  return rows.map(r => r.slug);
}

/**
 * The links and timeline pass's pages: live pages of the source updated at or after `since` whose links watermark is
 * absent or older than the page, less `exclude`, newest first, at most `limit`. The predicate is engine-sql/pages.ts
 * stalePagesWhere without the version branch.
 */
export async function listSweepStalePages(exec: SweepReadsExec, q: SweepStalePagesQuery): Promise<SweepStalePageRow[]> {
  const rows = await exec.executeRaw<{ slug: string; read_at: string; updated_at_iso: string; body_storage: string | null; body_bytes: unknown }>(
    SWEEP_STALE_PAGES_SQL, [q.sourceId, q.since, q.limit, [...q.exclude]]);
  return rows.map(r => ({ ...r, body_bytes: r.body_bytes == null ? null : Number(r.body_bytes) }));
}

/** Of `slugs`, the live pages of the source updated at or after `since` that are still stale, in no set order. */
export async function listSweepDeferredPages(exec: SweepReadsExec, q: SweepDeferredPagesQuery): Promise<SweepDeferredPageRow[]> {
  if (q.slugs.length === 0) return [];
  return exec.executeRaw<SweepDeferredPageRow>(SWEEP_DEFERRED_PAGES_SQL, [q.sourceId, q.since, [...q.slugs]]);
}

/**
 * The links and timeline pass's page refs: the live pages of any source whose slug is in `slugs`, in no set order. One
 * statement with one bound array, so the text does not change with the number of slugs; a slug named twice reads its
 * pages once.
 */
export async function listPageRefsForSlugs(exec: SweepReadsExec, slugs: readonly string[]): Promise<SweepPageRefRow[]> {
  if (slugs.length === 0) return [];
  return exec.executeRaw<SweepPageRefRow>(PAGE_REFS_FOR_SLUGS_SQL, [[...slugs]]);
}
