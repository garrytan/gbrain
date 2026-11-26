/**
 * Batched exact-key page snapshots for bulk walks (`gbrain extract --source db`).
 *
 * One statement returns, for a run of `(slug, sourceId)` refs, the same
 * `PageSnapshot` that `engine.readPageSnapshot(slug, { sourceId })` returns
 * for each (with `includeDeleted`, the one `{ sourceId, includeDeleted: true }`
 * returns: a soft-deleted row too, as the managed import reads it): tags, withdrawals and page-subject purges, the
 * source's '*' purge marker, source incarnation and the withdrawal overlay.
 * The projection mirrors `page-state/snapshot.ts` (pinned by
 * test/page-snapshot-batch.test.ts); the line fingerprints the overlay needs
 * are only computed for a page that has withdrawals, purges or a '*' purge
 * marker, because `overlayWithdrawalBody` ignores them otherwise.
 *
 * #9350: a source's '*' withdrawals (source-wide forgets, often thousands) are
 * read once per batch and carried on the first row of each source; each page
 * row carries only its own page-subject withdrawals, already merged with a
 * '*' row for the same claim at the earlier time. Read per page, the '*' ledger
 * cost a scan of fact_withdrawals and its whole JSON on every page, enough to
 * push a 39k-file source's sync past its 600 s deadline.
 *
 * Page bodies are unbounded, so a call covers the longest prefix of `refs`
 * whose bodies fit `maxBytes` (always at least one ref); `covered` says how
 * many refs the result answers. A ref the statement does not return is read
 * again through `readPageSnapshot`, so a caller never gets less than the
 * per-page read would give it; with `absentIsNull` (GBRA-75 wave 10, the managed
 * import, where most refs name new pages) the statement's own answer stands.
 * Engines run every statement on `query`, so
 * Postgres can bind the batch's sources for RLS (`engine.readPageSnapshotsBatch`).
 */
import { overlayWithdrawalBody } from './facts/withdrawal-overlay.ts';
import { readPageSnapshot, resolveGlobalPurges } from './page-state/snapshot.ts';
import type { GlobalPurgeMarker, PageSnapshot, PageWithdrawal } from './page-state/types.ts';
import { REVISION_BACKFILL_PENDING } from './page-state/types.ts';
import type { ReadQuery } from './search/read-enrichment.ts';
import { isSegmentedPage } from './page-body/page-shape.ts';
import { rowToPage } from './utils.ts';

export const PAGE_SNAPSHOT_BATCH_MAX_BYTES = 32 * 1024 * 1024;

export const pageSnapshotKey = (sourceId: string, slug: string) => `${sourceId}\u0000${slug}`;

export interface PageSnapshotBatch {
  /** Keyed by `pageSnapshotKey(sourceId, slug)`; refs with no live page are absent. */
  snapshots: Map<string, PageSnapshot>;
  /** How many leading refs this batch answers. */
  covered: number;
}

/**
 * A page's withdrawals as the per-page read lists them: its own withdrawals (each already at the earlier of its own
 * and a '*' row's time for the same claim, which SQL computed) and every other '*' withdrawal of its source, ordered by
 * visibility then fact hash, with its purge rows after them.
 */
function withSourceWide(own: PageWithdrawal[], sourceWide: PageWithdrawal[]): PageWithdrawal[] {
  if (!sourceWide.length) return own;
  const key = (w: PageWithdrawal) => `${w.visibility}\u0000${w.fact_hash}`;
  const withdrawn = own.filter(w => !w.purged);
  const mine = new Set(withdrawn.map(key));
  const merged = [...withdrawn, ...sourceWide.filter(w => !mine.has(key(w)))]
    .sort((a, b) => a.visibility < b.visibility ? -1 : a.visibility > b.visibility ? 1 : a.fact_hash < b.fact_hash ? -1 : a.fact_hash > b.fact_hash ? 1 : 0);
  return [...merged, ...own.filter(w => w.purged)];
}

export async function readPageSnapshotsBatch(
  query: ReadQuery,
  refs: ReadonlyArray<{ slug: string; sourceId: string }>,
  opts: { maxBytes?: number; includeDeleted?: boolean; absentIsNull?: boolean } = {},
): Promise<PageSnapshotBatch> {
  const snapshots = new Map<string, PageSnapshot>();
  if (!refs.length) return { snapshots, covered: 0 };
  const rows = await query<Record<string, unknown>>(`WITH wanted AS (
    SELECT v.slug AS batch_slug, v.source_id AS batch_source_id, v.n AS batch_n, p.id AS batch_page_id,
      COALESCE(sum(octet_length(p.compiled_truth) + COALESCE(octet_length(p.timeline), 0))
        OVER (ORDER BY v.n ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS batch_prior_bytes
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS v(slug, source_id, n)
    LEFT JOIN pages p ON p.slug = v.slug AND p.source_id = v.source_id AND ($4::boolean OR p.deleted_at IS NULL)
  ), chosen AS (
    SELECT w.batch_n, w.batch_slug, w.batch_source_id, p.* FROM wanted w LEFT JOIN pages p ON p.id = w.batch_page_id
    WHERE w.batch_n = 1 OR w.batch_prior_bytes < $3
  ), source_wide AS MATERIALIZED (
    SELECT source_id, visibility, fact_hash, min(withdrawn_at) AS withdrawn_at FROM fact_withdrawals
    WHERE subject='*' AND source_id IN (SELECT source_id FROM chosen WHERE id IS NOT NULL) GROUP BY source_id, visibility, fact_hash
  ) SELECT p.*,
    (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS snapshot_tags,
    wd.snapshot_withdrawals, wd.snapshot_global_purges,
    CASE WHEN p.batch_n=(SELECT min(c.batch_n) FROM chosen c WHERE c.source_id=p.source_id) THEN (SELECT jsonb_agg(jsonb_build_object(
      'visibility',g.visibility,'fact_hash',g.fact_hash,'withdrawn_at',g.withdrawn_at) ORDER BY g.visibility,g.fact_hash) FROM source_wide g
      WHERE g.source_id=p.source_id) END AS snapshot_source_withdrawals,
    CASE WHEN wd.snapshot_withdrawals <> '[]'::jsonb OR (wd.snapshot_global_purges->>'count')::int > 0 OR wd.source_wide THEN (SELECT string_agg(regexp_replace(lower(line), '[[:space:]]+', ' ', 'g'), chr(10) ORDER BY ord)
      FROM unnest(string_to_array(p.compiled_truth,chr(10))) WITH ORDINALITY AS lines(line,ord)) END AS fingerprint_body,
    CASE WHEN wd.snapshot_withdrawals <> '[]'::jsonb OR (wd.snapshot_global_purges->>'count')::int > 0 OR wd.source_wide THEN (SELECT string_agg(regexp_replace(lower(line), '[[:space:]]+', ' ', 'g'), chr(10) ORDER BY ord)
      FROM unnest(string_to_array(p.timeline,chr(10))) WITH ORDINALITY AS lines(line,ord)) END AS fingerprint_timeline
    FROM chosen p
    CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM source_wide g WHERE g.source_id=p.source_id) AS source_wide,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('visibility',w.visibility,'fact_hash',w.fact_hash,'withdrawn_at',LEAST(w.withdrawn_at,g.withdrawn_at))
      ORDER BY w.visibility,w.fact_hash) FROM (SELECT visibility,fact_hash,min(withdrawn_at) AS withdrawn_at
        FROM fact_withdrawals WHERE source_id=p.source_id AND visibility IN ('private','world') AND subject=p.slug
        GROUP BY visibility,fact_hash) w LEFT JOIN source_wide g ON g.source_id=p.source_id AND g.visibility=w.visibility AND g.fact_hash=w.fact_hash), '[]'::jsonb)
      || COALESCE((SELECT jsonb_agg(jsonb_build_object('visibility',x.visibility,'fact_hash',x.fact_hash,'withdrawn_at',x.purged_at,'purged',true)
        ORDER BY x.visibility,x.fact_hash) FROM (SELECT visibility,fact_hash,min(purged_at) AS purged_at
          FROM fact_purges WHERE source_id=p.source_id AND subject=p.slug
          GROUP BY visibility,fact_hash) x), '[]'::jsonb) AS snapshot_withdrawals,
      (SELECT jsonb_build_object('count',count(*),'latest',max(g.purged_at)) FROM fact_purges g
        WHERE g.source_id=p.source_id AND g.subject='*') AS snapshot_global_purges) wd
    ORDER BY p.batch_n`,
  [refs.map(r => r.slug), refs.map(r => r.sourceId), opts.maxBytes ?? PAGE_SNAPSHOT_BATCH_MAX_BYTES, opts.includeDeleted === true]);
  const sourceWide = new Map<string, PageWithdrawal[]>();
  for (const row of rows) {
    const key = pageSnapshotKey(String(row.batch_source_id), String(row.batch_slug));
    if (row.snapshot_source_withdrawals != null) sourceWide.set(String(row.source_id), row.snapshot_source_withdrawals as PageWithdrawal[]);
    if (row.id == null) {
      if (opts.absentIsNull) continue;
      const snapshot = await readPageSnapshot(query, String(row.batch_slug), { sourceId: String(row.batch_source_id), ...(opts.includeDeleted ? { includeDeleted: true } : {}) });
      if (snapshot) snapshots.set(key, snapshot);
      continue;
    }
    const page = rowToPage(row);
    const raw = (typeof row.snapshot_global_purges === 'string' ? JSON.parse(row.snapshot_global_purges) : row.snapshot_global_purges) as { count?: unknown; latest?: unknown } | null;
    const globalPurges: GlobalPurgeMarker = { count: Number(raw?.count ?? 0), latest: raw?.latest == null ? null : String(raw.latest), world_only: false };
    const withdrawals = [...withSourceWide(row.snapshot_withdrawals as PageWithdrawal[], sourceWide.get(page.source_id) ?? []), ...await resolveGlobalPurges(query, page.source_id, globalPurges,
      [String(row.fingerprint_body ?? ''), String(row.fingerprint_timeline ?? '')])];
    if (!isSegmentedPage(page)) {
      page.compiled_truth = overlayWithdrawalBody(page.compiled_truth, String(row.fingerprint_body ?? ''), withdrawals);
      page.timeline = overlayWithdrawalBody(page.timeline, String(row.fingerprint_timeline ?? ''), withdrawals);
    }
    snapshots.set(key, { page, tags: row.snapshot_tags as string[], revision: row.knowledge_revision == null ? REVISION_BACKFILL_PENDING : String(row.knowledge_revision),
      sourceIncarnation: String(row.source_incarnation), withdrawals, ...(globalPurges.count > 0 ? { globalPurges } : {}),
      ...(isSegmentedPage(page) ? { bodyGeneration: Number(row.body_generation) } : {}) });
  }
  return { snapshots, covered: rows.length };
}
