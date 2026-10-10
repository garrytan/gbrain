/**
 * Batched exact-key page snapshots for bulk walks (`gbrain extract --source db`).
 *
 * One statement returns, for a run of `(slug, sourceId)` refs, the same
 * `PageSnapshot` that `engine.readPageSnapshot(slug, { sourceId })` returns
 * for each: live rows only, tags, withdrawals and page-subject purges, the
 * source's '*' purge marker, source incarnation and the withdrawal overlay.
 * The projection mirrors `page-state/snapshot.ts` (pinned by
 * test/page-snapshot-batch.test.ts); the line fingerprints the overlay needs
 * are only computed for a page that has withdrawals, purges or a '*' purge
 * marker, because `overlayWithdrawalBody` ignores them otherwise.
 *
 * Page bodies are unbounded, so a call covers the longest prefix of `refs`
 * whose bodies fit `maxBytes` (always at least one ref); `covered` says how
 * many refs the result answers. A ref the statement does not return is read
 * again through `readPageSnapshot`, so a caller never gets less than the
 * per-page read would give it. Engines run every statement on `query`, so
 * Postgres can bind the batch's sources for RLS (`engine.readPageSnapshotsBatch`).
 */
import { overlayWithdrawalBody } from './facts/withdrawal-overlay.ts';
import { readPageSnapshot, resolveGlobalPurges } from './page-state/snapshot.ts';
import type { GlobalPurgeMarker, PageSnapshot, PageWithdrawal } from './page-state/types.ts';
import { REVISION_BACKFILL_PENDING } from './page-state/types.ts';
import type { ReadQuery } from './search/read-enrichment.ts';
import { rowToPage } from './utils.ts';

export const PAGE_SNAPSHOT_BATCH_MAX_BYTES = 32 * 1024 * 1024;

export const pageSnapshotKey = (sourceId: string, slug: string) => `${sourceId}\u0000${slug}`;

export interface PageSnapshotBatch {
  /** Keyed by `pageSnapshotKey(sourceId, slug)`; refs with no live page are absent. */
  snapshots: Map<string, PageSnapshot>;
  /** How many leading refs this batch answers. */
  covered: number;
}

export async function readPageSnapshotsBatch(
  query: ReadQuery,
  refs: ReadonlyArray<{ slug: string; sourceId: string }>,
  opts: { maxBytes?: number } = {},
): Promise<PageSnapshotBatch> {
  const snapshots = new Map<string, PageSnapshot>();
  if (!refs.length) return { snapshots, covered: 0 };
  const rows = await query<Record<string, unknown>>(`WITH wanted AS (
    SELECT v.slug AS batch_slug, v.source_id AS batch_source_id, v.n AS batch_n, p.id AS batch_page_id,
      COALESCE(sum(octet_length(p.compiled_truth) + COALESCE(octet_length(p.timeline), 0))
        OVER (ORDER BY v.n ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS batch_prior_bytes
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS v(slug, source_id, n)
    LEFT JOIN pages p ON p.slug = v.slug AND p.source_id = v.source_id AND p.deleted_at IS NULL
  ), chosen AS (
    SELECT w.batch_n, w.batch_slug, w.batch_source_id, p.* FROM wanted w LEFT JOIN pages p ON p.id = w.batch_page_id
    WHERE w.batch_n = 1 OR w.batch_prior_bytes < $3
  ) SELECT p.*,
    (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS snapshot_tags,
    wd.snapshot_withdrawals, wd.snapshot_global_purges,
    CASE WHEN wd.snapshot_withdrawals <> '[]'::jsonb OR (wd.snapshot_global_purges->>'count')::int > 0 THEN (SELECT string_agg(regexp_replace(lower(line), '[[:space:]]+', ' ', 'g'), chr(10) ORDER BY ord)
      FROM unnest(string_to_array(p.compiled_truth,chr(10))) WITH ORDINALITY AS lines(line,ord)) END AS fingerprint_body,
    CASE WHEN wd.snapshot_withdrawals <> '[]'::jsonb OR (wd.snapshot_global_purges->>'count')::int > 0 THEN (SELECT string_agg(regexp_replace(lower(line), '[[:space:]]+', ' ', 'g'), chr(10) ORDER BY ord)
      FROM unnest(string_to_array(p.timeline,chr(10))) WITH ORDINALITY AS lines(line,ord)) END AS fingerprint_timeline
    FROM chosen p
    CROSS JOIN LATERAL (SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('visibility',w.visibility,'fact_hash',w.fact_hash,'withdrawn_at',w.withdrawn_at)
      ORDER BY w.visibility,w.fact_hash) FROM (SELECT visibility,fact_hash,min(withdrawn_at) AS withdrawn_at
        FROM fact_withdrawals WHERE source_id=p.source_id AND (subject='*' OR subject=p.slug)
        GROUP BY visibility,fact_hash) w), '[]'::jsonb)
      || COALESCE((SELECT jsonb_agg(jsonb_build_object('visibility',x.visibility,'fact_hash',x.fact_hash,'withdrawn_at',x.purged_at,'purged',true)
        ORDER BY x.visibility,x.fact_hash) FROM (SELECT visibility,fact_hash,min(purged_at) AS purged_at
          FROM fact_purges WHERE source_id=p.source_id AND subject=p.slug
          GROUP BY visibility,fact_hash) x), '[]'::jsonb) AS snapshot_withdrawals,
      (SELECT jsonb_build_object('count',count(*),'latest',max(g.purged_at)) FROM fact_purges g
        WHERE g.source_id=p.source_id AND g.subject='*') AS snapshot_global_purges) wd
    ORDER BY p.batch_n`,
  [refs.map(r => r.slug), refs.map(r => r.sourceId), opts.maxBytes ?? PAGE_SNAPSHOT_BATCH_MAX_BYTES]);
  for (const row of rows) {
    const key = pageSnapshotKey(String(row.batch_source_id), String(row.batch_slug));
    if (row.id == null) {
      const snapshot = await readPageSnapshot(query, String(row.batch_slug), { sourceId: String(row.batch_source_id) });
      if (snapshot) snapshots.set(key, snapshot);
      continue;
    }
    const page = rowToPage(row);
    const raw = (typeof row.snapshot_global_purges === 'string' ? JSON.parse(row.snapshot_global_purges) : row.snapshot_global_purges) as { count?: unknown; latest?: unknown } | null;
    const globalPurges: GlobalPurgeMarker = { count: Number(raw?.count ?? 0), latest: raw?.latest == null ? null : String(raw.latest), world_only: false };
    const withdrawals = [...row.snapshot_withdrawals as PageWithdrawal[], ...await resolveGlobalPurges(query, page.source_id, globalPurges,
      [String(row.fingerprint_body ?? ''), String(row.fingerprint_timeline ?? '')])];
    page.compiled_truth = overlayWithdrawalBody(page.compiled_truth, String(row.fingerprint_body ?? ''), withdrawals);
    page.timeline = overlayWithdrawalBody(page.timeline, String(row.fingerprint_timeline ?? ''), withdrawals);
    snapshots.set(key, { page, tags: row.snapshot_tags as string[], revision: row.knowledge_revision == null ? REVISION_BACKFILL_PENDING : String(row.knowledge_revision),
      sourceIncarnation: String(row.source_incarnation), withdrawals, ...(globalPurges.count > 0 ? { globalPurges } : {}) });
  }
  return { snapshots, covered: rows.length };
}
