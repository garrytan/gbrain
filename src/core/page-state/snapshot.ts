import { fenceClaimHashes, overlayWithdrawalBody } from '../facts/withdrawal-overlay.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { ReadQuery } from '../search/read-enrichment.ts';
import { rowToPage } from '../utils.ts';
import type { GlobalPurgeMarker, PageSnapshot, PageSnapshotOptions, PageWithdrawal } from './types.ts';
import { PageSnapshotAmbiguousError, REVISION_BACKFILL_PENDING } from './types.ts';

/**
 * Subject-'*' fact purges that name a fence row of the given DB-normalized
 * text, as purge withdrawals. Snapshot reads carry only a marker for them
 * (GlobalPurgeMarker), because listing every '*' tombstone of a source made
 * each snapshot aggregate the whole ledger. The lookup runs on the caller's
 * `query`, so inside a transaction it reads that transaction's ledger; nothing
 * runs when the source has no '*' tombstone or the text has no fence row.
 * Purging only adds tombstones (unpurge removes a page's own, and changes the
 * marker), so a later read finds the same rows or more: a stale caller drops
 * at most fewer rows than a fresh one, and the import path re-checks the
 * ledger itself (facts/purge-overlay.ts) before anything is published.
 */
export async function resolveGlobalPurges(query: ReadQuery, sourceId: string, marker: GlobalPurgeMarker | undefined,
  normalizedTexts: readonly string[]): Promise<PageWithdrawal[]> {
  if (!marker || marker.count <= 0) return [];
  const hashes = fenceClaimHashes(normalizedTexts);
  if (!hashes.length) return [];
  const rows = await query<{ w: PageWithdrawal }>(`SELECT jsonb_build_object('visibility',visibility,'fact_hash',fact_hash,
      'withdrawn_at',min(purged_at),'purged',true) AS w
    FROM fact_purges WHERE source_id=$1 AND subject='*' AND fact_hash=ANY($2::text[]) ${marker.world_only ? "AND visibility='world'" : ''}
    GROUP BY visibility,fact_hash ORDER BY visibility,fact_hash`, [sourceId, hashes]);
  return rows.map(r => typeof r.w === 'string' ? JSON.parse(r.w) as PageWithdrawal : r.w);
}

/**
 * Normalize filesystem bytes with the exact ledger fingerprint rules before comparing them. `global` names the
 * snapshot's source and '*' purge marker, resolved against this text's fence rows (not the stored page's).
 */
export async function overlayCanonicalBodies(query: ReadQuery, body: string, timeline: string, withdrawals: PageWithdrawal[],
  global?: { sourceId: string; marker?: GlobalPurgeMarker }): Promise<{ compiled_truth: string; timeline: string }> {
  const pending = global?.marker && global.marker.count > 0 ? global : undefined;
  if (!withdrawals.length && !pending) return { compiled_truth: body, timeline };
  if (!body.includes('gbrain:facts:begin') && !timeline.includes('gbrain:facts:begin')) return { compiled_truth: body, timeline };
  const [normalized] = await query<{ body: string; timeline: string }>(`SELECT
    (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array($1::text,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS body,
    (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array($2::text,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS timeline`, [body, timeline]);
  const resolved = pending ? await resolveGlobalPurges(query, pending.sourceId, pending.marker, [normalized.body ?? '', normalized.timeline ?? '']) : [];
  const all = resolved.length ? [...withdrawals, ...resolved] : withdrawals;
  return { compiled_truth: overlayWithdrawalBody(body, normalized.body ?? '', all),
    timeline: overlayWithdrawalBody(timeline, normalized.timeline ?? '', all) };
}

/**
 * One MVCC statement binds content, tags, identity and withdrawals to one revision.
 * The normalized body and timeline fingerprints feed only the withdrawal overlay,
 * so the statement computes them only for a page with withdrawals (as the batch
 * reader in page-snapshot-batch.ts does): per-line regexp over the whole body
 * was most of the cost of every snapshot read.
 *
 * An alias-resolving read first runs the exact-slug statement: an exact match
 * outranks every alias match, so a hit is the row the alias statement would
 * pick. Only a miss runs the alias statement, whose `slug = $1 OR EXISTS
 * (alias)` disjunction scans the source's pages (23-80 ms at 50k pages, under
 * 1 ms for the exact lookup). An ambiguity check counts alias matches too, so
 * it always runs the alias statement.
 */
export async function readPageSnapshot(query: ReadQuery, slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null> {
  if (opts?.resolveAlias === true && opts.requireUnambiguous !== true) {
    const exact = await readSnapshotStatement(query, slug, { ...opts, resolveAlias: false });
    if (exact) return exact;
  }
  return readSnapshotStatement(query, slug, opts);
}

async function readSnapshotStatement(query: ReadQuery, slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null> {
  const params: unknown[] = [slug];
  // Alias resolution is part of the statement text, not a parameter, so a
  // cached plan for an exact-slug read keeps using the slug index.
  const where = [opts?.resolveAlias === true ? `(p.slug=$1 OR (
    ${opts?.preserveExactIdentity ? 'NOT EXISTS (SELECT 1 FROM pages exact_page WHERE exact_page.source_id=p.source_id AND exact_page.slug=$1) AND' : ''}
    EXISTS (SELECT 1 FROM slug_aliases a
    WHERE a.alias_slug=$1 AND a.source_id=p.source_id AND a.canonical_slug=p.slug
      AND EXISTS (SELECT 1 FROM sources alias_source WHERE alias_source.id=a.source_id ${opts?.includeDeleted ? '' : 'AND NOT alias_source.archived'}))))` : 'p.slug=$1'];
  if (opts?.sourceIds?.length) {
    params.push(opts.sourceIds);
    where.push(`p.source_id=ANY($${params.length}::text[])`);
  } else if (opts?.sourceId) {
    params.push(opts.sourceId);
    where.push(`p.source_id=$${params.length}`);
  }
  if (!opts?.includeDeleted) where.push('p.deleted_at IS NULL');
  if (opts?.excludePrivate) where.push(privatePagesFilterFragment('p'));
  if (opts?.requireLiveSource) where.push('EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)');
  params.push(opts?.sourceIds?.[0] ?? 'default');
  const rows = await query<Record<string, unknown>>(`WITH chosen AS (
    SELECT p.*${opts?.requireUnambiguous ? ', count(*) OVER () AS snapshot_matches' : ''} FROM pages p WHERE ${where.join(' AND ')}
    ORDER BY (p.slug=$1) DESC, (p.source_id=$${params.length}) DESC, p.source_id ASC LIMIT 1
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
        ${opts?.excludePrivate ? "AND visibility='world'" : ''} GROUP BY visibility,fact_hash) w), '[]'::jsonb)
      || COALESCE((SELECT jsonb_agg(jsonb_build_object('visibility',x.visibility,'fact_hash',x.fact_hash,'withdrawn_at',x.purged_at,'purged',true)
        ORDER BY x.visibility,x.fact_hash) FROM (SELECT visibility,fact_hash,min(purged_at) AS purged_at
          FROM fact_purges WHERE source_id=p.source_id AND subject=p.slug
          ${opts?.excludePrivate ? "AND visibility='world'" : ''} GROUP BY visibility,fact_hash) x), '[]'::jsonb) AS snapshot_withdrawals,
      (SELECT jsonb_build_object('count',count(*),'latest',max(g.purged_at)) FROM fact_purges g WHERE g.source_id=p.source_id AND g.subject='*'
        ${opts?.excludePrivate ? "AND g.visibility='world'" : ''}) AS snapshot_global_purges) wd`, params);
  if (!rows.length) return null;
  const row = rows[0];
  if (opts?.requireUnambiguous && Number(row.snapshot_matches) > 1) throw new PageSnapshotAmbiguousError();
  const page = rowToPage(row);
  const raw = (typeof row.snapshot_global_purges === 'string' ? JSON.parse(row.snapshot_global_purges) : row.snapshot_global_purges) as { count?: unknown; latest?: unknown } | null;
  const globalPurges: GlobalPurgeMarker = { count: Number(raw?.count ?? 0), latest: raw?.latest == null ? null : String(raw.latest), world_only: opts?.excludePrivate === true };
  const withdrawals = [...row.snapshot_withdrawals as PageWithdrawal[], ...await resolveGlobalPurges(query, page.source_id, globalPurges,
    [String(row.fingerprint_body ?? ''), String(row.fingerprint_timeline ?? '')])];
  page.compiled_truth = overlayWithdrawalBody(page.compiled_truth, String(row.fingerprint_body ?? ''), withdrawals);
  page.timeline = overlayWithdrawalBody(page.timeline, String(row.fingerprint_timeline ?? ''), withdrawals);
  return { page, tags: row.snapshot_tags as string[], revision: row.knowledge_revision == null ? REVISION_BACKFILL_PENDING : String(row.knowledge_revision),
    sourceIncarnation: String(row.source_incarnation), withdrawals, ...(globalPurges.count > 0 ? { globalPurges } : {}) };
}
