/**
 * The page scans of the `safe-chunks`, `origin-twins`, `ghost-pages` and `legacy-twins` repair plans, moved here from
 * their repair modules (and ghost-pages.ts), and the twin-merge conflict read (from persistence/twin-merge.ts), so the
 * Rust engine can serve them as typed members, and the tombstone read of `gbrain repair uncommitted-deletions` (from
 * uncommitted-deletions.ts). PGLite and Postgres read unscoped through
 * executeRaw, as before. The Rust engine scans its page records (rust/crates/gbrain-store/src/repair_scans.rs;
 * rust/docs/store/repair-bookkeeping.md, "Repair page scans").
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import { CREDENTIAL_RESEAL_HELD } from '../page-state/credential-reseal-hold.ts';
import { syncDeleteOrigin } from '../persistence/sync-delete-tombstones.ts';

/** One page `gbrain repair safe-chunks` re-seals (`rebuildable`) or reports. */
export interface SafeChunksPendingRow { id: number; source_id: string; slug: string; page_kind: string; rebuildable: boolean; chars: number }

/** Live pages of one source recording the same origin, ids ascending. */
export interface OriginTwinGroupRow { source_path: string; ids: number[]; paths: string[] }

/** A live page recording `<prefix><origin>` beside another live page recording `origin`. */
export interface LegacyOriginPair { legacy_id: number; legacy_path: string; legacy_slug: string; origin: string }

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
  const [where, params]: [string, unknown[]] = 'ids' in q ? ['id=ANY($2::bigint[])', [q.ids.map(Number)]]
    : 'slugs' in q ? [`deleted_at IS NULL AND slug=ANY($2::text[]) AND NOT ${BLANK_ORIGIN}`, [[...q.slugs]]]
    : [`deleted_at IS NULL AND id > $2${q.legacy ? ` AND ${BLANK_ORIGIN} AND database_only_reason IS NULL` : ''}`, [q.afterId]];
  const limit = 'afterId' in q ? ` LIMIT ${Math.max(1, Math.floor(q.limit))}` : '';
  const rows = await exec.executeRaw<RepairScanPage>(`SELECT id, slug, knowledge_revision::text AS revision, content_hash, source_path, source_uri,
      revision_write_request_id::text AS request_id, (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms,
      deleted_at IS NOT NULL AS deleted, database_only_reason
    FROM pages WHERE source_id=$1 AND ${where} ORDER BY id${limit}`, [sourceId, ...params]);
  return rows.map(row => ({ ...row, id: Number(row.id), updated_ms: Number(row.updated_ms), deleted: row.deleted === true }));
}

/** The live pages of `sourceIds` below the safe chunker version, or held for a credential re-chunk and inline, by id. */
export async function listSafeChunksPending(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<SafeChunksPendingRow[]> {
  const rows = await exec.executeRaw<SafeChunksPendingRow>(`SELECT p.id,p.source_id,p.slug,p.page_kind,
      (p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL)) AS rebuildable,
      length(p.compiled_truth)+length(COALESCE(p.timeline,'')) AS chars
    FROM pages p WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL
      AND (p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION} OR (${CREDENTIAL_RESEAL_HELD} AND p.body_storage IS DISTINCT FROM 'segmented'))
    ORDER BY p.id`, [[...sourceIds]]);
  return rows.map(row => ({ id: Number(row.id), source_id: row.source_id, slug: row.slug, page_kind: row.page_kind,
    rebuildable: row.rebuildable === true, chars: Number(row.chars) }));
}

/** The origins two or more live pages of the source record, at most `limit`, in byte order. */
export async function listOriginTwinGroups(exec: LegacyUnscopedRead, sourceId: string, limit: number): Promise<OriginTwinGroupRow[]> {
  const rows = await exec.executeRaw<OriginTwinGroupRow>(`SELECT source_path, array_agg(id ORDER BY id) AS ids, array_agg(source_path ORDER BY id) AS paths
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path IS NOT NULL GROUP BY source_path HAVING count(*) > 1
    ORDER BY source_path COLLATE "C" LIMIT ${Math.max(1, Math.floor(limit))}`, [sourceId]);
  return rows.map(row => ({ source_path: row.source_path, ids: row.ids.map(Number), paths: [...row.paths] }));
}

/** Each live page recording `prefix` plus another live page's origin, by the legacy page's id then the other's, at most `limit`. */
export async function listLegacyOriginPairs(exec: LegacyUnscopedRead, sourceId: string, prefix: string, limit: number): Promise<LegacyOriginPair[]> {
  const rows = await exec.executeRaw<LegacyOriginPair>(`SELECT l.id AS legacy_id, l.source_path AS legacy_path, l.slug AS legacy_slug, o.source_path AS origin
    FROM pages l JOIN pages o ON o.source_id=l.source_id AND l.source_path = $2 || o.source_path
    WHERE l.source_id=$1 AND l.deleted_at IS NULL AND o.deleted_at IS NULL AND l.id <> o.id ORDER BY l.id, o.id LIMIT ${Math.max(1, Math.floor(limit))}`, [sourceId, prefix]);
  return rows.map(row => ({ legacy_id: Number(row.legacy_id), legacy_path: row.legacy_path, legacy_slug: row.legacy_slug, origin: row.origin }));
}

/** The live pages of the source recording any of `paths`, by id. */
export async function listLiveOriginPages(exec: LegacyUnscopedRead, sourceId: string, paths: readonly string[]): Promise<LiveOriginPage[]> {
  const rows = await exec.executeRaw<LiveOriginPage>('SELECT id, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND source_path=ANY($2::text[]) ORDER BY id',
    [sourceId, [...paths]]);
  return rows.map(row => ({ id: Number(row.id), source_path: row.source_path }));
}

/** The soft-deleted pages of the source recording a non-blank file, below `q.before`, by id descending. */
export async function listFileTombstones(exec: LegacyUnscopedRead, sourceId: string, q: FileTombstoneQuery): Promise<FileTombstone[]> {
  const rows = await exec.executeRaw<Omit<FileTombstone, 'deleted_at'> & { deleted_at: Date | string }>(`SELECT p.id, p.slug, p.source_path, p.source_uri, p.deleted_at, p.knowledge_revision::text AS revision, ${syncDeleteOrigin('p')} AS by_sync
    FROM pages p WHERE p.source_id=$1 AND p.deleted_at IS NOT NULL AND NULLIF(btrim(p.source_path), '') IS NOT NULL AND ($2::bigint IS NULL OR p.id < $2::bigint)
    ORDER BY p.id DESC LIMIT ${Math.max(1, Math.floor(q.limit))}`, [sourceId, q.before ?? null]);
  return rows.map(row => ({ ...row, id: Number(row.id), source_uri: row.source_uri ?? null, deleted_at: new Date(row.deleted_at).toISOString(), by_sync: row.by_sync === true }));
}

/** The live pages of the source that record an origin; `nonBlank` skips a blank one. */
export async function countLiveFileBackedPages(exec: LegacyUnscopedRead, sourceId: string, opts: { nonBlank?: boolean } = {}): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND ${opts.nonBlank ? `NOT ${BLANK_ORIGIN}` : 'source_path IS NOT NULL'}`, [sourceId]);
  return Number(row?.n ?? 0);
}

/** The twin-merge SQL fragments ($1 the twin, $2 the survivor); persistence/twin-merge.ts `mergeTwinInto` moves rows with them. */
export const PAIR = 'NOT (from_page_id IN ($1::int, $2::int) AND to_page_id IN ($1::int, $2::int))';
export const MAP = (col: string) => `CASE WHEN ${col}=$1::int THEN $2::int ELSE ${col} END`;
const TOUCHES = 'from_page_id IN ($1::int, $2::int) OR to_page_id IN ($1::int, $2::int) OR origin_page_id IN ($1::int, $2::int)';
export const MOVING = '(from_page_id=$1::int OR to_page_id=$1::int OR origin_page_id IS NOT DISTINCT FROM $1::int)';

/** Moving rows of the twin that land on another row's unique key, with whether every such row says the same thing. */
export const LINK_LOSERS = `WITH m AS (
    SELECT id, link_type, link_source, context, origin_field, link_kind, resolution_type, assertion_tense, ${MOVING} AS moving,
      ${MAP('from_page_id')} AS f, ${MAP('to_page_id')} AS t, ${MAP('origin_page_id')} AS o
    FROM links WHERE (${TOUCHES}) AND ${PAIR})
  SELECT s.id, s.link_source, bool_and(s.context=k.context AND s.origin_field IS NOT DISTINCT FROM k.origin_field AND s.link_kind IS NOT DISTINCT FROM k.link_kind
      AND s.resolution_type IS NOT DISTINCT FROM k.resolution_type AND s.assertion_tense IS NOT DISTINCT FROM k.assertion_tense) AS same
  FROM m s JOIN m k ON s.moving AND k.id<>s.id AND k.f=s.f AND k.t=s.t AND k.link_type=s.link_type
    AND k.link_source IS NOT DISTINCT FROM s.link_source AND k.o IS NOT DISTINCT FROM s.o AND (NOT k.moving OR k.id<s.id)
  GROUP BY s.id, s.link_source ORDER BY s.id`;

export const TRANSITION_LOSERS = `WITH m AS (
    SELECT id, link_type, kind, occurred_on, producer, date_precision, ${MOVING} AS moving,
      ${MAP('from_page_id')} AS f, ${MAP('to_page_id')} AS t, ${MAP('origin_page_id')} AS o
    FROM link_transitions WHERE (${TOUCHES}) AND ${PAIR})
  SELECT s.id, s.producer, bool_and(s.date_precision=k.date_precision) AS same
  FROM m s JOIN m k ON s.moving AND k.id<>s.id AND k.f=s.f AND k.t=s.t AND k.link_type=s.link_type AND k.kind=s.kind
    AND k.occurred_on=s.occurred_on AND k.producer=s.producer AND k.o IS NOT DISTINCT FROM s.o AND (NOT k.moving OR k.id<s.id)
  GROUP BY s.id, s.producer ORDER BY s.id`;

/** What moving twin `twinId` into `survivorId` would land on (`TwinMergeLosers`). Read-only; runs inside a caller's transaction too. */
export async function listTwinMergeLosers(exec: LegacyUnscopedRead, survivorId: number, twinId: number): Promise<TwinMergeLosers> {
  const params = [twinId, survivorId];
  const links = await exec.executeRaw<{ id: number; link_source: string | null; same: boolean }>(LINK_LOSERS, params);
  const transitions = await exec.executeRaw<{ id: number; producer: string; same: boolean }>(TRANSITION_LOSERS, params);
  const timeline = await exec.executeRaw<{ id: number }>(`SELECT s.id FROM timeline_entries s JOIN timeline_entries o ON o.page_id=$2::int AND o.date=s.date
      AND md5(o.summary)=md5(s.summary) AND o.source=s.source WHERE s.page_id=$1::int AND o.detail<>s.detail ORDER BY s.id`, params);
  const raw = await exec.executeRaw<{ source: string }>(`SELECT s.source FROM raw_data s JOIN raw_data o ON o.page_id=$2::int AND o.source=s.source
      WHERE s.page_id=$1::int AND o.data IS DISTINCT FROM s.data ORDER BY s.source COLLATE "C"`, params);
  return {
    links: links.map(row => ({ id: Number(row.id), link_source: row.link_source ?? null, same: row.same === true })),
    transitions: transitions.map(row => ({ id: Number(row.id), producer: row.producer, same: row.same === true })),
    timeline: timeline.map(row => ({ id: Number(row.id) })),
    raw_data: raw.map(row => ({ source: row.source })),
  };
}
