/**
 * The page scans of the `safe-chunks`, `origin-twins`, `ghost-pages` and `legacy-twins` repair plans, moved here from
 * their repair modules (and ghost-pages.ts), and the twin-merge conflict read (from persistence/twin-merge.ts), so the
 * Rust engine can serve them as typed members, and the tombstone read of `gbrain repair uncommitted-deletions` (from
 * uncommitted-deletions.ts). PGLite and Postgres read unscoped through
 * executeRaw, as before. The Rust engine scans its page records (rust/crates/gbrain-store/src/repair_scans.rs;
 * rust/docs/store/repair-bookkeeping.md, "Repair page scans").
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { CREDENTIAL_RESEAL_HELD } from '../page-state/credential-reseal-hold.ts';
import { syncDeleteOrigin } from '../persistence/sync-delete-tombstones.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';

/** One page `gbrain repair safe-chunks` re-seals (`rebuildable`) or reports. */
export interface SafeChunksPendingRow { id: number; source_id: string; slug: string; page_kind: string; rebuildable: boolean; chars: number }

/** Live pages of one source recording the same origin, ids ascending. */
export interface OriginTwinGroupRow { source_path: string; ids: number[]; paths: string[] }

/** A live page recording `<prefix><origin>` beside another live page recording `origin`. */
export interface LegacyOriginPair { legacy_id: number; legacy_path: string; legacy_slug: string; origin: string }

/**
 * What the origin-twins verdict reads of a live page (persistence/origin-twins.ts `decideOriginTwins`): the inline body
 * digest (`md5(compiled_truth) || md5(timeline)`, NULL for a segmented body, so unknown never matches), the explicit
 * frontmatter id, the trust tier, whether the no-caller page policy keeps the page (`private`, its SQL value under that
 * name) and whether fact withdrawals or purges are keyed to its slug (`restricted`).
 */
export interface OriginClaimantRow {
  id: number; slug: string; revision: string; body_hash: string | null; fm_id: string | null; trust_tier: string | null;
  private: boolean; restricted: boolean;
}

/** A live page and the origin it records. */
export interface LiveOriginPage { id: number; source_path: string }

/** A page the ghost-pages and legacy-twins repairs read: its live revision, origin, revision writer and state. */
export interface RepairScanPage {
  id: number; slug: string; revision: string; content_hash: string | null; source_path: string | null; source_uri: string | null;
  request_id: string | null; updated_ms: number; deleted: boolean; database_only_reason: string | null;
}

/**
 * Which pages of one source `listRepairScanPages` reads, by id: `afterId` pages the live pages past an id (`legacy`
 * keeps those with a blank origin and no database-only stamp), `slugs` the live pages at those slugs recording a
 * non-blank origin, `ids` those pages in any state.
 */
export type RepairScanQuery = { afterId: number; limit: number; legacy?: boolean } | { slugs: readonly string[] } | { ids: readonly number[] };

/**
 * The rows of a twin whose move into its survivor would land on another row's unique key (persistence/twin-merge.ts
 * `twinMergeConflicts` keeps the ones that would discard distinct evidence). `links` and `transitions` carry whether
 * every row on that key says the same thing; `timeline` names the twin's entries whose detail differs from the
 * survivor's same-day entry; `raw_data` names the sources whose payload differs. Each list is in id (source) order.
 */
export interface TwinMergeLosers {
  links: Array<{ id: number; link_source: string | null; same: boolean }>;
  transitions: Array<{ id: number; producer: string; same: boolean }>;
  timeline: Array<{ id: number }>;
  raw_data: Array<{ source: string }>;
}

/**
 * A soft-deleted page of one source that records a non-blank file: `deleted_at` as ISO 8601 (milliseconds), `by_sync`
 * when a managed sync made its current tombstone (persistence/sync-delete-tombstones.ts `syncDeleteOrigin`).
 */
export interface FileTombstone { id: number; slug: string; source_path: string; source_uri: string | null; deleted_at: string; revision: string; by_sync: boolean }

/** Which tombstones `listFileTombstones` reads: those below page id `before` (all when null), descending, at most `limit`. */
export interface FileTombstoneQuery { before: number | null; limit: number }

const BLANK_ORIGIN = `COALESCE(btrim(source_path), '')=''`;

/** The pages of the source `q` names, by id. */
export async function listRepairScanPages(exec: LegacyUnscopedRead, sourceId: string, q: RepairScanQuery): Promise<RepairScanPage[]> {
  const where = 'ids' in q ? sqlFragment`id=ANY(${q.ids.map(Number)}::bigint[])`
    : 'slugs' in q ? sqlFragment`deleted_at IS NULL AND slug=ANY(${[...q.slugs]}::text[]) AND NOT ${trustedSql(BLANK_ORIGIN)}`
    : sqlFragment`deleted_at IS NULL AND id > ${q.afterId}${q.legacy ? sqlFragment` AND ${trustedSql(BLANK_ORIGIN)} AND database_only_reason IS NULL` : sqlFragment``}`;
  const limit = 'afterId' in q ? sqlFragment` LIMIT ${Math.max(1, Math.floor(q.limit))}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT id, slug, knowledge_revision::text AS revision, content_hash, source_path, source_uri,
      revision_write_request_id::text AS request_id, (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms,
      deleted_at IS NOT NULL AS deleted, database_only_reason
    FROM pages WHERE source_id=${sourceId} AND ${where} ORDER BY id${limit}`);
  const rows = await exec.executeRaw<RepairScanPage>(text, params);
  return rows.map(row => ({ ...row, id: Number(row.id), updated_ms: Number(row.updated_ms), deleted: row.deleted === true }));
}

/** The live pages of `sourceIds` below the safe chunker version, or held for a credential re-chunk and inline, by id. */
export async function listSafeChunksPending(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<SafeChunksPendingRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id,p.source_id,p.slug,p.page_kind,
      (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)) AS rebuildable,
      length(p.compiled_truth)+length(COALESCE(p.timeline,'')) AS chars
    FROM pages p WHERE p.source_id=ANY(${[...sourceIds]}::text[]) AND p.deleted_at IS NULL
      AND (p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION}::int OR (${trustedSql(CREDENTIAL_RESEAL_HELD)} AND p.body_storage IS DISTINCT FROM 'segmented'))
    ORDER BY p.id`);
  const rows = await exec.executeRaw<SafeChunksPendingRow>(text, params);
  return rows.map(row => ({ id: Number(row.id), source_id: row.source_id, slug: row.slug, page_kind: row.page_kind,
    rebuildable: row.rebuildable === true, chars: Number(row.chars) }));
}

/** The origins two or more live pages of the source record, at most `limit`, in byte order. */
export async function listOriginTwinGroups(exec: LegacyUnscopedRead, sourceId: string, limit: number): Promise<OriginTwinGroupRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT source_path, array_agg(id ORDER BY id) AS ids, array_agg(source_path ORDER BY id) AS paths
    FROM pages WHERE source_id=${sourceId} AND deleted_at IS NULL AND source_path IS NOT NULL GROUP BY source_path HAVING count(*) > 1
    ORDER BY source_path COLLATE "C" LIMIT ${Math.max(1, Math.floor(limit))}`);
  const rows = await exec.executeRaw<OriginTwinGroupRow>(text, params);
  return rows.map(row => ({ source_path: row.source_path, ids: row.ids.map(Number), paths: [...row.paths] }));
}

/** Each live page recording `prefix` plus another live page's origin, by the legacy page's id then the other's, at most `limit`. */
export async function listLegacyOriginPairs(exec: LegacyUnscopedRead, sourceId: string, prefix: string, limit: number): Promise<LegacyOriginPair[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT l.id AS legacy_id, l.source_path AS legacy_path, l.slug AS legacy_slug, o.source_path AS origin
    FROM pages l JOIN pages o ON o.source_id=l.source_id AND l.source_path = ${prefix} || o.source_path
    WHERE l.source_id=${sourceId} AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND l.id <> o.id ORDER BY l.id, o.id LIMIT ${Math.max(1, Math.floor(limit))}`);
  const rows = await exec.executeRaw<LegacyOriginPair>(text, params);
  return rows.map(row => ({ legacy_id: Number(row.legacy_id), legacy_path: row.legacy_path, legacy_slug: row.legacy_slug, origin: row.origin }));
}

/** The live pages of the source recording any of `paths`, by id. */
export async function listLiveOriginPages(exec: LegacyUnscopedRead, sourceId: string, paths: readonly string[]): Promise<LiveOriginPage[]> {
  const rows = await exec.executeRaw<LiveOriginPage>('SELECT id, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path=ANY($2::text[]) ORDER BY id',
    [sourceId, [...paths]]);
  return rows.map(row => ({ id: Number(row.id), source_path: row.source_path }));
}

/** The verdict inputs of the live pages of the source with these ids, by id (`OriginClaimantRow`). */
export async function listOriginClaimants(exec: LegacyUnscopedRead, sourceId: string, ids: readonly number[]): Promise<OriginClaimantRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.slug, p.knowledge_revision::text AS revision,
       CASE WHEN p.compiled_truth IS NULL THEN NULL ELSE md5(p.compiled_truth) || md5(COALESCE(p.timeline, '')) END AS body_hash,
       p.frontmatter->>'id' AS fm_id, p.trust_tier::text AS trust_tier, (${trustedSql(privatePagesFilterFragment('p'))}) AS private,
       (EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=p.source_id AND w.subject=p.slug)
         OR EXISTS (SELECT 1 FROM fact_purges f WHERE f.source_id=p.source_id AND f.subject=p.slug)) AS restricted
     FROM pages p WHERE p.source_id=${sourceId} AND p.id=ANY(${[...ids]}::bigint[]) AND p.deleted_at IS NULL ORDER BY p.id`);
  const rows = await exec.executeRaw<OriginClaimantRow>(text, params);
  return rows.map(row => ({ id: Number(row.id), slug: row.slug, revision: String(row.revision), body_hash: row.body_hash, fm_id: row.fm_id,
    trust_tier: row.trust_tier ?? null, private: row.private === true, restricted: row.restricted === true }));
}

/** The soft-deleted pages of the source recording a non-blank file, below `q.before`, by id descending. */
export async function listFileTombstones(exec: LegacyUnscopedRead, sourceId: string, q: FileTombstoneQuery): Promise<FileTombstone[]> {
  const before = q.before ?? null;
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.slug, p.source_path, p.source_uri, p.deleted_at, p.knowledge_revision::text AS revision, ${trustedSql(syncDeleteOrigin('p'))} AS by_sync
    FROM pages p WHERE p.source_id=${sourceId} AND p.deleted_at IS NOT NULL AND NULLIF(btrim(p.source_path), '') IS NOT NULL AND (${before}::bigint IS NULL OR p.id < ${before}::bigint)
    ORDER BY p.id DESC LIMIT ${Math.max(1, Math.floor(q.limit))}`);
  const rows = await exec.executeRaw<Omit<FileTombstone, 'deleted_at'> & { deleted_at: Date | string }>(text, params);
  return rows.map(row => ({ ...row, id: Number(row.id), source_uri: row.source_uri ?? null, deleted_at: new Date(row.deleted_at).toISOString(), by_sync: row.by_sync === true }));
}

/** A tombstone a managed sync made that no live page of its source backs by content; `expired` when older than the cutoff. */
export interface UnreviewedSyncTombstone { id: number; source_id: string; slug: string; expired: boolean }

/**
 * Every tombstone a managed sync made whose content no live page of its source holds, by deleted_at, then byte source
 * id, then byte slug (persistence/sync-delete-tombstones.ts readUnreviewedSyncTombstones).
 */
export async function listUnreviewedSyncTombstones(exec: LegacyUnscopedRead, olderThanHours: number): Promise<UnreviewedSyncTombstone[]> {
  const hours = String(Math.max(0, Math.floor(olderThanHours)));
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.source_id, p.slug, p.deleted_at < now() - (${hours} || ' hours')::interval AS expired FROM pages p
      WHERE p.deleted_at IS NOT NULL AND ${trustedSql(syncDeleteOrigin('p'))}
        AND NOT EXISTS (SELECT 1 FROM pages tw WHERE tw.source_id = p.source_id AND tw.deleted_at IS NULL AND tw.content_hash = p.content_hash)
      ORDER BY p.deleted_at ASC, p.source_id COLLATE "C" ASC, p.slug COLLATE "C" ASC`);
  const rows = await exec.executeRaw<{ id: number | string; source_id: string; slug: string; expired: boolean }>(text, params);
  return rows.map(row => ({ id: Number(row.id), source_id: row.source_id, slug: row.slug, expired: row.expired === true }));
}

/** The live pages of the source that record an origin; `nonBlank` skips a blank one. */
export async function countLiveFileBackedPages(exec: LegacyUnscopedRead, sourceId: string, opts: { nonBlank?: boolean } = {}): Promise<number> {
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM pages WHERE source_id=${sourceId} AND deleted_at IS NULL AND ${trustedSql(opts.nonBlank ? `NOT ${BLANK_ORIGIN}` : 'source_path IS NOT NULL')}`);
  const [row] = await exec.executeRaw<{ n: number }>(text, params);
  return Number(row?.n ?? 0);
}

/** The page ids the twin-merge statements take: the twin and the survivor it moves into. */
interface TwinPair { twinId: number; survivorId: number }

type MovedColumn = 'from_page_id' | 'to_page_id' | 'origin_page_id';
const MOVED_COLUMN_SQL = { from_page_id: 'from_page_id', to_page_id: 'to_page_id', origin_page_id: 'origin_page_id' } as const;

/** The two tables the twin merge moves relationship rows in. */
export type TwinMergeTable = 'links' | 'link_transitions';
const TWIN_MERGE_TABLE_SQL = { links: 'links', link_transitions: 'link_transitions' } as const;

/** The column's value with the twin replaced by the survivor. */
const mapColumn = (col: MovedColumn, { twinId, survivorId }: TwinPair): SqlFragment =>
  sqlFragment`CASE WHEN ${trustedSql(MOVED_COLUMN_SQL[col])}=${twinId}::int THEN ${survivorId}::int ELSE ${trustedSql(MOVED_COLUMN_SQL[col])} END`;

/** Rows that run between the twin and the survivor stay put (they would become self-links). */
const notBetweenPair = ({ twinId, survivorId }: TwinPair): SqlFragment => {
  const ids = [twinId, survivorId];
  return sqlFragment`NOT (from_page_id = ANY(${ids}::int[]) AND to_page_id = ANY(${ids}::int[]))`;
};

const touchesPair = ({ twinId, survivorId }: TwinPair): SqlFragment => {
  const ids = [twinId, survivorId];
  return sqlFragment`from_page_id = ANY(${ids}::int[]) OR to_page_id = ANY(${ids}::int[]) OR origin_page_id = ANY(${ids}::int[])`;
};

const movingTwin = ({ twinId }: TwinPair): SqlFragment =>
  sqlFragment`(from_page_id=${twinId}::int OR to_page_id=${twinId}::int OR origin_page_id IS NOT DISTINCT FROM ${twinId}::int)`;

/** Moving rows of the twin that land on another row's unique key, with whether every such row says the same thing. */
const linkLosersFragment = (pair: TwinPair): SqlFragment => sqlFragment`WITH m AS (
    SELECT id, link_type, link_source, context, origin_field, link_kind, resolution_type, assertion_tense, ${movingTwin(pair)} AS moving,
      ${mapColumn('from_page_id', pair)} AS f, ${mapColumn('to_page_id', pair)} AS t, ${mapColumn('origin_page_id', pair)} AS o
    FROM links WHERE (${touchesPair(pair)}) AND ${notBetweenPair(pair)})
  SELECT s.id, s.link_source, bool_and(s.context=k.context AND s.origin_field IS NOT DISTINCT FROM k.origin_field AND s.link_kind IS NOT DISTINCT FROM k.link_kind
      AND s.resolution_type IS NOT DISTINCT FROM k.resolution_type AND s.assertion_tense IS NOT DISTINCT FROM k.assertion_tense) AS same
  FROM m s JOIN m k ON s.moving AND k.id<>s.id AND k.f=s.f AND k.t=s.t AND k.link_type=s.link_type
    AND k.link_source IS NOT DISTINCT FROM s.link_source AND k.o IS NOT DISTINCT FROM s.o AND (NOT k.moving OR k.id<s.id)
  GROUP BY s.id, s.link_source ORDER BY s.id`;

const transitionLosersFragment = (pair: TwinPair): SqlFragment => sqlFragment`WITH m AS (
    SELECT id, link_type, kind, occurred_on, producer, date_precision, ${movingTwin(pair)} AS moving,
      ${mapColumn('from_page_id', pair)} AS f, ${mapColumn('to_page_id', pair)} AS t, ${mapColumn('origin_page_id', pair)} AS o
    FROM link_transitions WHERE (${touchesPair(pair)}) AND ${notBetweenPair(pair)})
  SELECT s.id, s.producer, bool_and(s.date_precision=k.date_precision) AS same
  FROM m s JOIN m k ON s.moving AND k.id<>s.id AND k.f=s.f AND k.t=s.t AND k.link_type=s.link_type AND k.kind=s.kind
    AND k.occurred_on=s.occurred_on AND k.producer=s.producer AND k.o IS NOT DISTINCT FROM s.o AND (NOT k.moving OR k.id<s.id)
  GROUP BY s.id, s.producer ORDER BY s.id`;

/** The statement and values of the link rows moving twin `twinId` would land on another row's key (`id` only is read). */
export function twinLinkLosersStatement(twinId: number, survivorId: number): { text: string; params: unknown[] } {
  return renderFragment(linkLosersFragment({ twinId, survivorId }));
}

/** The statement and values of the transition rows moving twin `twinId` would land on another row's key (`id` only is read). */
export function twinTransitionLosersStatement(twinId: number, survivorId: number): { text: string; params: unknown[] } {
  return renderFragment(transitionLosersFragment({ twinId, survivorId }));
}

/** The statement and values that move the twin's relationship rows of `table` onto the survivor (persistence/twin-merge.ts `mergeTwinInto`); returns the moved ids. */
export function twinMoveRowsStatement(table: TwinMergeTable, twinId: number, survivorId: number): { text: string; params: unknown[] } {
  const pair = { twinId, survivorId };
  return renderFragment(sqlFragment`UPDATE ${trustedSql(TWIN_MERGE_TABLE_SQL[table])} SET from_page_id=${mapColumn('from_page_id', pair)}, to_page_id=${mapColumn('to_page_id', pair)}, origin_page_id=${mapColumn('origin_page_id', pair)}
    WHERE ${movingTwin(pair)} AND ${notBetweenPair(pair)} RETURNING id`);
}

/** What moving twin `twinId` into `survivorId` would land on (`TwinMergeLosers`). Read-only; runs inside a caller's transaction too. */
export async function listTwinMergeLosers(exec: LegacyUnscopedRead, survivorId: number, twinId: number): Promise<TwinMergeLosers> {
  const linksSql = twinLinkLosersStatement(twinId, survivorId);
  const transitionsSql = twinTransitionLosersStatement(twinId, survivorId);
  const links = await exec.executeRaw<{ id: number; link_source: string | null; same: boolean }>(linksSql.text, linksSql.params);
  const transitions = await exec.executeRaw<{ id: number; producer: string; same: boolean }>(transitionsSql.text, transitionsSql.params);
  const timelineSql = renderFragment(sqlFragment`SELECT s.id FROM timeline_entries s JOIN timeline_entries o ON o.page_id=${survivorId}::int AND o.date=s.date
      AND md5(o.summary)=md5(s.summary) AND o.source=s.source WHERE s.page_id=${twinId}::int AND o.detail<>s.detail ORDER BY s.id`);
  const timeline = await exec.executeRaw<{ id: number }>(timelineSql.text, timelineSql.params);
  const rawSql = renderFragment(sqlFragment`SELECT s.source FROM raw_data s JOIN raw_data o ON o.page_id=${survivorId}::int AND o.source=s.source
      WHERE s.page_id=${twinId}::int AND o.data IS DISTINCT FROM s.data ORDER BY s.source COLLATE "C"`);
  const raw = await exec.executeRaw<{ source: string }>(rawSql.text, rawSql.params);
  return {
    links: links.map(row => ({ id: Number(row.id), link_source: row.link_source ?? null, same: row.same === true })),
    transitions: transitions.map(row => ({ id: Number(row.id), producer: row.producer, same: row.same === true })),
    timeline: timeline.map(row => ({ id: Number(row.id) })),
    raw_data: raw.map(row => ({ source: row.source })),
  };
}
