import { fenceClaimHashes, overlayWithdrawalBody, withLegacyLedgerRows } from '../facts/withdrawal-overlay.ts';
import { FACT_SPACE_CLASS } from '../facts/withdrawal-schema.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import type { ReadQuery } from '../search/read-enrichment.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { rowToPage } from '../utils.ts';
import type { BrainEngine } from '../engine.ts';
import { hasCapability } from '../engine-capabilities.ts';
import type { GlobalPurgeMarker, PageSnapshot, PageSnapshotOptions, PageWithdrawal } from './types.ts';
import { GLOBAL_PURGES_SQL, GLOBAL_WORLD_PURGES_SQL } from '../engine-sql/segmented-mirror-effects.ts';
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
  const rows = await query<{ w: PageWithdrawal }>(marker.world_only ? GLOBAL_WORLD_PURGES_SQL : GLOBAL_PURGES_SQL, [sourceId, hashes]);
  return rows.map(r => typeof r.w === 'string' ? JSON.parse(r.w) as PageWithdrawal : r.w);
}

/**
 * Normalize filesystem bytes with the exact ledger fingerprint rules before comparing them. `global` names the
 * snapshot's source and '*' purge marker, resolved against this text's fence rows (not the stored page's). On a SQL
 * query the lines fold the explicit whitespace list (FACT_SPACE_CLASS, as every fingerprint does) and a withdrawal or
 * purge stored under a fence claim's pre-v341 Postgres fingerprint is aliased in (withLegacyLedgerRows).
 */
export async function overlayCanonicalBodies(query: ReadQuery, body: string, timeline: string, withdrawals: PageWithdrawal[],
  global?: { sourceId: string; marker?: GlobalPurgeMarker }): Promise<{ compiled_truth: string; timeline: string }> {
  return overlayWith({
    normalize: async () => (await query<{ body: string; timeline: string }>(`SELECT
    (SELECT string_agg(regexp_replace(lower(line),'${FACT_SPACE_CLASS}+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array($1::text,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS body,
    (SELECT string_agg(regexp_replace(lower(line),'${FACT_SPACE_CLASS}+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array($2::text,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS timeline`, [body, timeline]))[0],
    purges: (sourceId, marker, texts) => resolveGlobalPurges(query, sourceId, marker, texts),
    legacy: (ledger, pending) => withLegacyLedgerRows(query, [body, timeline], ledger, pending),
  }, body, timeline, withdrawals, global);
}

/**
 * `overlayCanonicalBodies` through typed engine members: the line normalization is `normalizeFenceLines` and the `*`
 * purge lookup is `listGlobalPurgeWithdrawals`, so an engine without raw SQL (the Rust engine) overlays the same way. An
 * engine with raw SQL also aliases the pre-v341 Postgres fingerprints in, as the SQL form does; the Rust store never held
 * one.
 */
export async function overlayCanonicalBodiesTyped(engine: Pick<BrainEngine, 'normalizeFenceLines' | 'listGlobalPurgeWithdrawals'>
  & Partial<Pick<BrainEngine, 'executeRaw' | 'capabilities'>>, body: string, timeline: string,
  withdrawals: PageWithdrawal[], global?: { sourceId: string; marker?: GlobalPurgeMarker }): Promise<{ compiled_truth: string; timeline: string }> {
  const sql = engine.capabilities && engine.executeRaw && hasCapability(engine as Pick<BrainEngine, 'capabilities'>, 'raw_sql')
    ? engine.executeRaw.bind(engine) as ReadQuery : undefined;
  return overlayWith({
    normalize: async () => (await engine.normalizeFenceLines([body], [timeline]))[0],
    purges: async (sourceId, marker, texts) => {
      if (!marker || marker.count <= 0) return [];
      const hashes = fenceClaimHashes(texts);
      return hashes.length ? engine.listGlobalPurgeWithdrawals(sourceId, hashes, marker.world_only === true) : [];
    },
    ...(sql ? { legacy: (ledger: PageWithdrawal[], pending?: { sourceId: string; marker?: GlobalPurgeMarker }) => withLegacyLedgerRows(sql, [body, timeline], ledger, pending) } : {}),
  }, body, timeline, withdrawals, global);
}

interface OverlayReads {
  normalize(): Promise<{ body: string | null; timeline: string | null } | undefined>;
  purges(sourceId: string, marker: GlobalPurgeMarker, normalizedTexts: readonly string[]): Promise<PageWithdrawal[]>;
  /** The ledger with the rows stored under a fence claim's pre-v341 fingerprint added (SQL engines only). */
  legacy?(ledger: PageWithdrawal[], pending?: { sourceId: string; marker?: GlobalPurgeMarker }): Promise<PageWithdrawal[]>;
}

async function overlayWith(reads: OverlayReads, body: string, timeline: string, withdrawals: PageWithdrawal[],
  global?: { sourceId: string; marker?: GlobalPurgeMarker }): Promise<{ compiled_truth: string; timeline: string }> {
  const pending = global?.marker && global.marker.count > 0 ? global : undefined;
  if (!withdrawals.length && !pending) return { compiled_truth: body, timeline };
  if (!body.includes('gbrain:facts:begin') && !timeline.includes('gbrain:facts:begin')) return { compiled_truth: body, timeline };
  const normalized = (await reads.normalize()) ?? { body: '', timeline: '' };
  const resolved = pending ? await reads.purges(pending.sourceId, pending.marker!, [normalized.body ?? '', normalized.timeline ?? '']) : [];
  const ledger = resolved.length ? [...withdrawals, ...resolved] : withdrawals;
  const all = reads.legacy ? await reads.legacy(ledger, pending) : ledger;
  return { compiled_truth: overlayWithdrawalBody(body, normalized.body ?? '', all),
    timeline: overlayWithdrawalBody(timeline, normalized.timeline ?? '', all) };
}

/**
 * One MVCC statement binds content, tags, identity and withdrawals to one revision.
 * The normalized body and timeline fingerprints feed only the withdrawal overlay,
 * so the statement computes them only for a page with withdrawals (as the batch
 * reader in page-snapshot-batch.ts does): per-line regexp over the whole body
 * was most of the cost of every snapshot read. The withdrawals are read as
 * `visibility IN (...) AND subject IN ('*', slug)`, seeks on fact_withdrawals'
 * (source_id, visibility, subject, fact_hash) key; `subject='*' OR subject=slug`
 * scanned the table on every read (#9350).
 *
 * An alias-resolving read first runs the exact-slug statement: an exact match
 * outranks every alias match, so a hit is the row the alias statement would
 * pick. Only a miss runs the alias statement, a UNION ALL of the exact-slug
 * probe and an alias-join probe (#6281), both index lookups. An ambiguity check
 * counts alias matches too, so it always runs the alias statement.
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
  const filters: string[] = [];
  if (opts?.sourceIds?.length) {
    params.push(opts.sourceIds);
    filters.push(`p.source_id=ANY($${params.length}::text[])`);
  } else if (opts?.sourceId) {
    params.push(opts.sourceId);
    filters.push(`p.source_id=$${params.length}`);
  }
  if (!opts?.includeDeleted) filters.push('p.deleted_at IS NULL');
  if (opts?.excludePrivate) filters.push(privatePagesFilterForCaller('p'));
  if (opts?.requireLiveSource) filters.push('EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)');
  params.push(opts?.sourceIds?.[0] ?? 'default');
  const and = filters.map(filter => ` AND ${filter}`).join('');
  // Alias resolution is part of the statement text, not a parameter, so a cached plan for an exact-slug read keeps
  // using the slug index. #6281: the alias read is a UNION ALL of two indexable branches (the exact slug, and pages an
  // alias row names), never `slug=$1 OR EXISTS(alias)`, which scans every page; `p.slug<>$1` keeps the branches disjoint
  // so the ambiguity count still counts pages.
  const candidates = opts?.resolveAlias === true ? `(SELECT p.* FROM pages p WHERE p.slug=$1${and}
    UNION ALL
    SELECT p.* FROM slug_aliases a JOIN pages p ON p.source_id=a.source_id AND p.slug=a.canonical_slug
    WHERE a.alias_slug=$1 AND p.slug<>$1
      AND EXISTS (SELECT 1 FROM sources alias_source WHERE alias_source.id=a.source_id ${opts?.includeDeleted ? '' : 'AND NOT alias_source.archived'})
      ${opts?.preserveExactIdentity ? 'AND NOT EXISTS (SELECT 1 FROM pages exact_page WHERE exact_page.source_id=a.source_id AND exact_page.slug=$1)' : ''}${and}) p`
    : `pages p WHERE p.slug=$1${and}`;
  const rows = await query<Record<string, unknown>>(`WITH chosen AS (
    SELECT p.*${opts?.requireUnambiguous ? ', count(*) OVER () AS snapshot_matches' : ''} FROM ${candidates}
    ORDER BY (p.slug=$1) DESC, (p.source_id=$${params.length}) DESC, p.source_id COLLATE "C" ASC LIMIT 1
  ) SELECT p.*,
    (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS snapshot_tags,
    wd.snapshot_withdrawals, wd.snapshot_global_purges,
    CASE WHEN wd.snapshot_withdrawals <> '[]'::jsonb OR (wd.snapshot_global_purges->>'count')::int > 0 THEN (SELECT string_agg(regexp_replace(lower(line), '${FACT_SPACE_CLASS}+', ' ', 'g'), chr(10) ORDER BY ord)
      FROM unnest(string_to_array(p.compiled_truth,chr(10))) WITH ORDINALITY AS lines(line,ord)) END AS fingerprint_body,
    CASE WHEN wd.snapshot_withdrawals <> '[]'::jsonb OR (wd.snapshot_global_purges->>'count')::int > 0 THEN (SELECT string_agg(regexp_replace(lower(line), '${FACT_SPACE_CLASS}+', ' ', 'g'), chr(10) ORDER BY ord)
      FROM unnest(string_to_array(p.timeline,chr(10))) WITH ORDINALITY AS lines(line,ord)) END AS fingerprint_timeline
    FROM chosen p
    CROSS JOIN LATERAL (SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('visibility',w.visibility,'fact_hash',w.fact_hash,'withdrawn_at',w.withdrawn_at)
      ORDER BY w.visibility COLLATE "C",w.fact_hash COLLATE "C") FROM (SELECT visibility,fact_hash,min(withdrawn_at) AS withdrawn_at
        FROM fact_withdrawals WHERE source_id=p.source_id AND visibility IN (${opts?.excludePrivate ? "'world'" : "'private','world'"}) AND subject IN ('*',p.slug)
        GROUP BY visibility,fact_hash) w), '[]'::jsonb)
      || COALESCE((SELECT jsonb_agg(jsonb_build_object('visibility',x.visibility,'fact_hash',x.fact_hash,'withdrawn_at',x.purged_at,'purged',true)
        ORDER BY x.visibility COLLATE "C",x.fact_hash COLLATE "C") FROM (SELECT visibility,fact_hash,min(purged_at) AS purged_at
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
  if (!isSegmentedPage(page)) {
    const overlay = await withLegacyLedgerRows(query, [page.compiled_truth, page.timeline], withdrawals, { sourceId: page.source_id, marker: globalPurges });
    page.compiled_truth = overlayWithdrawalBody(page.compiled_truth, String(row.fingerprint_body ?? ''), overlay);
    page.timeline = overlayWithdrawalBody(page.timeline, String(row.fingerprint_timeline ?? ''), overlay);
  }
  return { page, tags: row.snapshot_tags as string[], revision: row.knowledge_revision == null ? REVISION_BACKFILL_PENDING : String(row.knowledge_revision),
    sourceIncarnation: String(row.source_incarnation), withdrawals, ...(globalPurges.count > 0 ? { globalPurges } : {}),
    ...(isSegmentedPage(page) ? { bodyGeneration: Number(row.body_generation) } : {}) };
}
