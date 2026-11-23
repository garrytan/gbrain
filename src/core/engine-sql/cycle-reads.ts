/**
 * The cycle, belief and sync statements that ran through `engine.executeRaw` and are now typed members, so a Rust brain
 * answers each from its store (rust/docs/store/take-proposals.md, cycle-window.md, identity-downgrades.md,
 * mention-scan-reads.md, trust.md). PGLite and Postgres run the statements their callers ran; the notes below name the
 * few places a statement changed shape.
 *
 *  - propose_takes failure tombstones (cycle/propose-takes-failures.ts): the insert returns the id it inserted, so the
 *    caller learns whether the claim was already recorded.
 *  - the per-source cycle's changed-page window (cycle/source-window.ts): the listing instant and one window of pages.
 *    The "is the listing instant before the last page" comparison now happens on the two UTC ISO texts, which sort as
 *    time, instead of in a third statement.
 *  - `recordIdentityDowngrades` (sync-identity-downgrades.ts): the soft-deleted page a renamed file once backed, the
 *    live pages at the new path (by slug bytes) and what a carry would move.
 *  - `scanStaleMentions` (by-mention.ts): the scanned pages and their mention links.
 *  - the belief ledger's orphan lifetimes (belief/coverage-report.ts): the limit is a bound parameter, not spliced text.
 *  - the phantom-redirect pass's walk of root pages lives in engine-sql/facts-cycle.ts (`listRootPageSlugsAfter`).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead };

// ─── propose_takes failure tombstones ────────────────────────────────────

/** What a failure tombstone names; its kind, holder, weight, domain and status are fixed (`fact`, `brain`, 0, none, `rejected`). */
export interface FailureTombstoneInput {
  sourceId: string; slug: string; contentHash: string; promptVersion: string; proposalRunId: string; claimText: string; modelId: string;
}

/** One tombstone as listed; `proposed_at` is the column's `::text` form. */
export interface FailureTombstoneRow { page_slug: string; claim_text: string; prompt_version: string; proposed_at: string }

/** The phase's tombstone insert: a claim already recorded for the page, content hash and prompt version is left alone. */
export async function recordFailureTombstone(raw: EngineRawRead, p: FailureTombstoneInput): Promise<boolean> {
  const rows = await raw(`INSERT INTO take_proposals
             (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
              claim_text, kind, holder, weight, domain, dedup_against_fence_rows, model_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'fact', 'brain', 0, NULL, '[]'::jsonb, $7, 'rejected')
           ON CONFLICT (source_id, page_slug, content_hash, prompt_version, md5(claim_text)) DO NOTHING RETURNING id`,
  [p.sourceId, p.slug, p.contentHash, p.promptVersion, p.proposalRunId, p.claimText, p.modelId]);
  return rows.length > 0;
}

/** The source's unacted `rejected` proposals whose claim text starts with the prefix, by page slug bytes. */
export async function listFailureTombstones(raw: EngineRawRead, sourceId: string, claimPrefix: string): Promise<FailureTombstoneRow[]> {
  const rows = await raw<{ slug: string; claim_text: string; prompt_version: string; proposed_at: string }>(
    `SELECT page_slug AS slug, claim_text, prompt_version, proposed_at::text AS proposed_at FROM take_proposals
      WHERE source_id = $1 AND status = 'rejected' AND acted_at IS NULL AND starts_with(claim_text, $2) ORDER BY page_slug COLLATE "C"`, [sourceId, claimPrefix]);
  return rows.map(r => ({ page_slug: r.slug, claim_text: r.claim_text, prompt_version: r.prompt_version, proposed_at: r.proposed_at }));
}

// ─── the cycle's changed-page window ─────────────────────────────────────

/** One page of a window; `updated_at` is UTC ISO with microseconds. */
export interface SourceChangedPageRow { slug: string; updated_at: string }

/**
 * The listing instant, moved back to just before the oldest transaction still open on another connection the cycle's
 * role can see (at most 10 minutes back), as UTC ISO text with microseconds; null when the engine returns no row.
 */
export async function readCycleListingInstant(raw: EngineRawRead): Promise<string | null> {
  const [row] = await raw<{ at: string | null }>(`SELECT to_char(GREATEST(LEAST(clock_timestamp(),
  (SELECT min(xact_start) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type <> 'autovacuum worker') - interval '1 millisecond'),
  clock_timestamp() - interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
  return row?.at ?? null;
}

/** Up to `limit` live pages of a source after the cursor `(since, slug)`, by `(updated_at, slug bytes)`; every page when `since` is null. Cursors bind as text (a driver reading a timestamp parameter as a JS date keeps milliseconds). */
export async function listSourceChangedPagesAfter(raw: EngineRawRead, sourceId: string, since: string | null, slug: string, limit: number): Promise<SourceChangedPageRow[]> {
  return raw<SourceChangedPageRow>(`SELECT slug, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR (updated_at, slug COLLATE "C") > ($2::text::timestamptz, $3::text))
      ORDER BY updated_at, slug COLLATE "C" LIMIT $4`, [sourceId, since, slug, limit]);
}

// ─── identity downgrades ─────────────────────────────────────────────────

/** A soft-deleted page; `deleted_at` is the column's `::text` form. */
export interface SoftDeletedPageRow { id: number; slug: string; deleted_at: string }

/** The soft-deleted page of a source whose origin is `path`, or whose slug is `slug` when it has no origin: the latest deletion first, the lowest page id among equals. */
export async function readSoftDeletedPageAtOrigin(raw: EngineRawRead, sourceId: string, path: string, slug: string): Promise<SoftDeletedPageRow | null> {
  const [row] = await raw<{ id: number | string; slug: string; deleted_at: string }>(
    `SELECT id, slug, deleted_at::text AS deleted_at FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL
        AND (source_path = $2 OR (source_path IS NULL AND slug = $3)) ORDER BY deleted_at DESC, id LIMIT 1`, [sourceId, path, slug]);
  return row ? { id: Number(row.id), slug: row.slug, deleted_at: row.deleted_at } : null;
}

/** A live page at a file path. */
export interface LivePageAtOriginRow { id: number; slug: string }

/** The live pages of a source whose origin is `sourcePath`, by slug bytes. */
export async function listLivePagesAtOrigin(raw: EngineRawRead, sourceId: string, sourcePath: string): Promise<LivePageAtOriginRow[]> {
  const rows = await raw<{ id: number | string; slug: string }>(
    `SELECT id, slug FROM pages WHERE source_id = $1 AND source_path = $2 AND deleted_at IS NULL ORDER BY slug COLLATE "C"`, [sourceId, sourcePath]);
  return rows.map(r => ({ id: Number(r.id), slug: r.slug }));
}

/** What a carry would move off a page. */
export interface PageCarryCounts { facts: number; links: number; aliases: number }

/** The facts about a slug, the links of a page and the aliases of a slug. */
export async function countPageCarryRows(raw: EngineRawRead, sourceId: string, slug: string, pageId: number): Promise<PageCarryCounts> {
  const [row] = await raw<{ facts: number | string; links: number | string; aliases: number | string }>(`SELECT
        (SELECT count(*) FROM facts WHERE source_id = $1 AND entity_slug = $2) AS facts,
        (SELECT count(*) FROM links WHERE from_page_id = $3 OR to_page_id = $3) AS links,
        (SELECT count(*) FROM page_aliases WHERE source_id = $1 AND slug = $2) AS aliases`, [sourceId, slug, pageId]);
  return { facts: Number(row?.facts ?? 0), links: Number(row?.links ?? 0), aliases: Number(row?.aliases ?? 0) };
}

// ─── the stale-mention scan ──────────────────────────────────────────────

export interface StaleMentionPageRow {
  id: number; slug: string; source_id: string | null; body: string; title: string | null; body_storage: string | null;
}

/** The first `limit` live pages (by slug bytes, then id) with a `mentions` link, with their `title, body, timeline` text. */
export async function listStaleMentionPages(raw: EngineRawRead, limit: number): Promise<StaleMentionPageRow[]> {
  return raw<StaleMentionPageRow>(
    `WITH scanned AS (
       SELECT p.id
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM links l
             WHERE l.from_page_id = p.id AND l.link_source = 'mentions'
          )
        ORDER BY p.slug COLLATE "C", p.id
        LIMIT $1
     )
     SELECT p.id, p.slug, p.source_id, p.title, p.body_storage,
            COALESCE(p.title, '') || E'\\n\\n' || COALESCE(p.compiled_truth, '') || E'\\n\\n' || COALESCE(p.timeline, '') AS body
       FROM pages p
       JOIN scanned s ON s.id = p.id
      ORDER BY p.slug COLLATE "C", p.id`,
    [limit]);
}

export interface StaleMentionLinkRow {
  from_id: number; from_slug: string; to_slug: string; to_source_id: string | null; link_kind: string | null; link_type: string;
}

/** The `mentions` links of those same pages, by from slug then to slug bytes. */
export async function listStaleMentionLinks(raw: EngineRawRead, limit: number): Promise<StaleMentionLinkRow[]> {
  return raw<StaleMentionLinkRow>(
    `WITH scanned AS (
       SELECT p.id
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM links l
             WHERE l.from_page_id = p.id AND l.link_source = 'mentions'
          )
        ORDER BY p.slug COLLATE "C", p.id
        LIMIT $1
     )
     SELECT l.from_page_id AS from_id, f.slug AS from_slug,
            t.slug AS to_slug, t.source_id AS to_source_id, l.link_kind, l.link_type
       FROM links l
       JOIN scanned s ON s.id = l.from_page_id
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_source = 'mentions'
      ORDER BY f.slug COLLATE "C", t.slug COLLATE "C"`,
    [limit]);
}

// ─── the belief ledger's orphan lifetimes ────────────────────────────────

export type OrphanReason = 'no_page' | 'no_lifetime';
export interface OrphanLifetimeSamples { count: number; samples: Array<{ slug: string; page_lifetime: string; reason: OrphanReason }> }

/** Open lifetimes with no page at their slug (an untracked hard delete), and (`deep`, a whole-ledger read) events naming a lifetime that does not exist. */
export async function listOrphanLifetimes(raw: EngineRawRead, sourceId: string, limit: number, deep: boolean): Promise<OrphanLifetimeSamples> {
  const rows = await raw<{ slug: string; page_lifetime: string; reason: OrphanReason; total: number }>(`SELECT slug, page_lifetime, reason, count(*) OVER ()::int AS total FROM (
      SELECT l.slug, l.page_lifetime::text AS page_lifetime, 'no_page' AS reason FROM belief_page_lifetimes l JOIN sources s ON s.id = l.source_id AND s.incarnation = l.source_incarnation
      WHERE l.source_id = $1 AND l.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = l.source_id AND p.slug = l.slug)
      UNION ALL SELECT DISTINCT e.slug, e.page_lifetime::text, 'no_lifetime' FROM belief_events e
      WHERE $2::boolean AND e.source_id = $1 AND e.page_lifetime IS NOT NULL AND NOT EXISTS (SELECT 1 FROM belief_page_lifetimes l WHERE l.page_lifetime = e.page_lifetime)
    ) o ORDER BY slug COLLATE "C", page_lifetime COLLATE "C" LIMIT $3`, [sourceId, deep, Math.min(Math.max(1, Math.floor(limit)), 2 ** 31 - 1)]);
  return { count: Number(rows[0]?.total ?? 0), samples: rows.map(r => ({ slug: r.slug, page_lifetime: r.page_lifetime, reason: r.reason })) };
}
