/**
 * The reads of stamped trust tiers that core memory, the trust scan, belief history, page history and the quote path
 * made through `executeRaw`: SQL once for both engines.
 *
 * - `listCorePageRows`: the live `always_load` pages core memory lists, with the trust columns its delivery reads.
 * - `listTrustScanRows` / `countUnscannedTrustRows`: the rows at or below the activation ceiling the trust scan reads.
 * - `readBeliefHistoryRows` / `listVisibleBeliefLifetimes`: one page of the belief ledger and the visible lifetimes
 *   its link events name.
 * - `listVersionTrustTiers` / `listVersionReasonWriters`: the snapshot tier of a page version, and the type and tier
 *   of the write that replaced it (the next snapshot, or the live page).
 * - `pageAwaitsRederive`: whether a purge hid the page until it is derived again (`needs_rederive`).
 * - `listPageTypesByIds`: the stored type of each listed page, for the reads that quote a third-party page's rows
 *   (search/transcript-quote.ts `pageTypesById`).
 *
 * The statements that master built at run time (core memory's `where`, the trust scan's `IN (...)` lists and ids, belief
 * history's and rederive's spliced visibility fragments) are composed with `sqlFragment`: every value is bound, the
 * privacy, quarantine and eligibility predicates are spliced as the vetted builders' constant text. Their text differs
 * from master's; test/n3-sql-move-parity.test.ts runs master's text and these members on the same rows. Where master left
 * the row order to the plan the member sorts the rows in JavaScript (bytewise text, ids numeric), so every engine
 * answers alike. Ids come back as numbers.
 */
import type { BrainEngine } from '../engine.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';
import { activationSuppressedSql, pageEligibleSql, rederiveHiddenSql } from '../eligibility/sql.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { privatePagesFilterForCaller, remoteReadFloorSql } from '../search/private-visibility.ts';
import { CORE_MAX_PAGES } from '../core-memory.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

const none = sqlFragment``;

/** Render `fragment` and run it on the raw path, as the call sites ran their statements. */
async function rowsOf<T>(exec: Raw, fragment: SqlFragment): Promise<T[]> {
  const { text, params } = renderFragment(fragment);
  return exec.executeRaw<T>(text, params);
}

const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
/** Bytewise order, the order a Rust store sorts strings in. */
const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

// ---------------------------------------------------------------------------------------------------------------
// Core memory

export interface CorePageRowSpec {
  /** Restrict to these sources; omitted is every source. */
  sourceIds?: readonly string[];
  /** Leave out one page (the page being written, measured separately). */
  exclude?: { sourceId: string; slug: string };
  /** Hide the pages the reader may not see: the caller's page policy with `forCaller`, else the remote read floor. */
  excludePrivate?: boolean;
  forCaller?: boolean;
  /** Delivery reads: quarantined pages and pages below the floor are left out; the trust columns come back. */
  eligibility?: ReadEligibility;
}

export interface CorePageRow {
  id: number;
  source_id: string;
  slug: string;
  title: string | null;
  compiled_truth: string | null;
  frontmatter: Record<string, unknown> | null;
  /** The body is stored in segments; `body_bytes` is then its size, else null. */
  segmented: boolean;
  body_bytes: number | null;
  /** A withdrawal of the source covers the page (`*` or its slug). */
  withdrawn: boolean;
  /** Present only with `eligibility`. */
  trust_tier?: string;
  write_origin?: unknown;
  suppressed?: boolean;
}

interface CoreRow { id: number | string; source_id: string; slug: string; title: string | null; compiled_truth: string | null; frontmatter: unknown; withdrawn: boolean;
  body_storage: string | null; body_bytes: number | string | null;
  trust_tier?: string; write_origin?: unknown; suppressed?: boolean }

/** The live `always_load` pages, by source then slug, at most `CORE_MAX_PAGES * 4` (headroom over what core renders). */
export async function listCorePageRows(exec: Raw, opts: CorePageRowSpec): Promise<CorePageRow[]> {
  const policy = opts.eligibility;
  const sources = opts.sourceIds ? sqlFragment` AND p.source_id = ANY(${[...opts.sourceIds]}::text[])` : none;
  const exclude = opts.exclude ? sqlFragment` AND NOT (p.source_id = ${opts.exclude.sourceId} AND p.slug = ${opts.exclude.slug})` : none;
  const privacy = !opts.excludePrivate ? none
    : opts.forCaller ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('p'))}` : sqlFragment` AND ${trustedSql(remoteReadFloorSql('p'))}`;
  const eligible = policy
    ? sqlFragment` AND ${trustedSql(quarantineFilterFragment('p'))} AND ${trustedSql(pageEligibleSql('p', { floor: policy.floor }))}` : none;
  const suppressed = policy?.suppressFlagged ? sqlFragment`${trustedSql(activationSuppressedSql('pages', 'p'))}` : sqlFragment`false`;
  const trustCols = policy ? sqlFragment` p.trust_tier, p.write_origin, ${suppressed} AS suppressed,` : none;
  const rows = await rowsOf<CoreRow>(exec, sqlFragment`SELECT p.id, p.source_id, p.slug, p.title, p.compiled_truth, p.frontmatter, p.body_storage, p.body_bytes,${trustCols}
        EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = p.source_id AND (w.subject = '*' OR w.subject = p.slug)) AS withdrawn
      FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter @> '{"always_load": true}'::jsonb${sources}${exclude}${privacy}${eligible}
      ORDER BY p.source_id, p.slug LIMIT ${CORE_MAX_PAGES * 4}`);
  return rows.sort((a, b) => byteCmp(a.source_id, b.source_id) || byteCmp(a.slug, b.slug)).map(r => {
    const segmented = r.body_storage === 'segmented';
    return {
      id: Number(r.id), source_id: String(r.source_id), slug: String(r.slug),
      title: (r.title as string | null) ?? null, compiled_truth: (r.compiled_truth as string | null) ?? null,
      frontmatter: (json(r.frontmatter) as Record<string, unknown> | null) ?? null,
      segmented, body_bytes: segmented && r.body_bytes != null ? Number(r.body_bytes) : null, withdrawn: r.withdrawn === true,
      ...(policy ? { trust_tier: String(r.trust_tier), write_origin: json(r.write_origin) ?? null, suppressed: r.suppressed === true } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Trust scan

export type TrustScanTable = 'pages' | 'facts' | 'takes' | 'timeline_entries';

/** The table names the unscanned count reads from (a constant object: the key picks one of four literals). */
const SCAN_TABLE_NAMES = { pages: 'pages', facts: 'facts', takes: 'takes', timeline_entries: 'timeline_entries' } as const;

export interface TrustScanRowSpec {
  table: TrustScanTable;
  /** Rows with an id above this one. */
  afterId: number;
  limit: number;
  /** The stored tiers the scan reads (at or below the activation ceiling). */
  tiers: readonly string[];
}

/** One scanned row: the id, source, stored tier and write origin, then the table's content columns. */
export interface TrustScanRow {
  id: number;
  source_id: string | null;
  trust_tier: string;
  write_origin: unknown;
  [column: string]: unknown;
}

interface Row { id: number | string; source_id: string | null; trust_tier: string; write_origin: unknown; [k: string]: unknown }

/** The table's rows above `afterId` whose stored tier is listed, by id, at most `limit`. */
export async function listTrustScanRows(tx: Raw, spec: TrustScanRowSpec): Promise<TrustScanRow[]> {
  const tiers = [...spec.tiers];
  const scans: Readonly<Record<TrustScanTable, SqlFragment>> = {
    pages: sqlFragment`SELECT p.id, p.source_id, p.trust_tier, p.write_origin, p.title, p.compiled_truth, p.timeline, p.frontmatter FROM pages p
    WHERE p.id > ${spec.afterId} AND p.deleted_at IS NULL AND p.trust_tier = ANY(${tiers}::text[]) ORDER BY p.id LIMIT ${spec.limit}`,
    facts: sqlFragment`SELECT f.id, f.source_id, f.trust_tier, f.write_origin, f.fact, f.context, f.value, f.source FROM facts f
    WHERE f.id > ${spec.afterId} AND f.trust_tier = ANY(${tiers}::text[]) ORDER BY f.id LIMIT ${spec.limit}`,
    takes: sqlFragment`SELECT t.id, p.source_id, t.trust_tier, t.write_origin, t.claim, t.source FROM takes t JOIN pages p ON p.id = t.page_id
    WHERE t.id > ${spec.afterId} AND t.trust_tier = ANY(${tiers}::text[]) ORDER BY t.id LIMIT ${spec.limit}`,
    timeline_entries: sqlFragment`SELECT te.id, p.source_id, te.trust_tier, te.write_origin, te.summary, te.detail, te.source FROM timeline_entries te
    JOIN pages p ON p.id = te.page_id WHERE te.id > ${spec.afterId} AND te.trust_tier = ANY(${tiers}::text[]) ORDER BY te.id LIMIT ${spec.limit}`,
  };
  const got = await rowsOf<Row>(tx, scans[spec.table]);
  return got.sort((a, b) => Number(a.id) - Number(b.id)).map(r => ({ ...r, id: Number(r.id), source_id: (r.source_id as string | null) ?? null, trust_tier: String(r.trust_tier),
    write_origin: json(r.write_origin) ?? null }));
}

export interface UnscannedTrustSpec {
  table: TrustScanTable;
  afterId: number;
  /** The scan's id ceiling; null counts every later row. */
  until: number | null;
  tiers: readonly string[];
}

/** How many rows of the table above `afterId` (and at or below `until`) have a listed stored tier. */
export async function countUnscannedTrustRows(engine: Raw, spec: UnscannedTrustSpec): Promise<number> {
  const { table } = spec;
  const tiers = [...spec.tiers];
  const live = table === 'pages' ? sqlFragment` AND deleted_at IS NULL` : none;
  const ceiling = spec.until !== null ? sqlFragment` AND id <= ${spec.until}` : none;
  const [row] = await rowsOf<{ n: number | string }>(engine,
    sqlFragment`SELECT count(*)::int AS n FROM ${trustedSql(SCAN_TABLE_NAMES[table])} WHERE id > ${spec.afterId} AND trust_tier = ANY(${tiers}::text[])${live}${ceiling}`);
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Belief history

export interface BeliefHistoryRowQuery {
  sourceId: string;
  slug: string | null;
  subjectKey: string | null;
  afterId: number;
  limit: number;
  recordedAfter: string | null;
  recordedUntil: string | null;
  subjectKeys: readonly string[] | null;
  beforeId: number | null;
  descending: boolean;
}

/**
 * One page of the source's belief events, by id, with the per-row visibility facts the remote filter needs:
 * `stream_visible` (the page lifetime's live page passes the remote read floor, and quarantine for facts and takes),
 * `later_private` (a later private event of the same claim) and `take_holder`.
 */
export async function readBeliefHistoryRows(engine: Raw, q: BeliefHistoryRowQuery): Promise<Array<Record<string, unknown>>> {
  const order = trustedSql(q.descending ? 'DESC' : 'ASC');
  const subjectKeys = q.subjectKeys ? [...q.subjectKeys] : null;
  const rows = await rowsOf<Record<string, unknown>>(engine, sqlFragment`SELECT e.id, e.slug, e.page_lifetime::text AS page_lifetime,
      e.subject_kind, e.subject_key, e.event_type, e.origin, e.trust_tier, e.writer_tier, e.tier_basis, e.visibility, e.recorded_at, e.source_time,
      e.value, e.value_hash, e.prior_hash, e.state_hash, e.cause, e.purged, e.redacted_fields,
      (SELECT ${trustedSql(remoteReadFloorSql('p'))} AND (e.subject_kind NOT IN ('fact', 'take') OR ${trustedSql(quarantineFilterFragment('p'))}) FROM belief_page_lifetimes l JOIN pages p ON p.source_id = l.source_id AND p.slug = l.slug
        AND p.deleted_at IS NULL AND (l.page_id IS NULL OR p.id = l.page_id)
        WHERE l.page_lifetime = e.page_lifetime AND l.ended_at IS NULL) AS stream_visible,
      (e.claim_fp IS NOT NULL AND EXISTS (SELECT 1 FROM belief_events v WHERE v.source_id = e.source_id AND v.source_incarnation = e.source_incarnation
        AND v.claim_fp = e.claim_fp AND v.subject_kind = e.subject_kind AND v.visibility = 'private' AND v.id > e.id)) AS later_private,
      CASE WHEN e.subject_kind = 'take' THEN COALESCE(e.value->>'holder', (SELECT t.value->>'holder' FROM belief_events t WHERE t.source_id = e.source_id
        AND t.source_incarnation = e.source_incarnation AND t.subject_kind = 'take' AND t.subject_key = e.subject_key AND t.id < e.id AND t.value->>'holder' IS NOT NULL
        ORDER BY t.id DESC LIMIT 1)) END AS take_holder
    FROM belief_events e
    WHERE e.source_id = ${q.sourceId} AND e.source_incarnation = (SELECT s.incarnation FROM sources s WHERE s.id = ${q.sourceId}) AND (${q.slug}::text IS NULL OR e.slug = ${q.slug}) AND (${q.subjectKey}::text IS NULL OR e.subject_key = ${q.subjectKey}) AND e.id > ${q.afterId}
      AND (${q.recordedAfter}::timestamptz IS NULL OR e.recorded_at > ${q.recordedAfter}::timestamptz) AND (${q.recordedUntil}::timestamptz IS NULL OR e.recorded_at <= ${q.recordedUntil}::timestamptz)
      AND (${subjectKeys}::text[] IS NULL OR e.subject_key = ANY(${subjectKeys}::text[])) AND (${q.beforeId}::bigint IS NULL OR e.id < ${q.beforeId}::bigint)
      AND NOT EXISTS (SELECT 1 FROM belief_events h WHERE h.source_id = e.source_id AND h.subject_kind = e.subject_kind AND h.subject_key = e.subject_key
        AND h.event_type = 'derived.hidden' AND h.id <> e.id AND (h.id > e.id OR e.origin = 'backfill'))
    ORDER BY e.id ${order} LIMIT ${q.limit}`);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** The listed page lifetimes that are live and whose page passes the remote read floor, in lifetime order. */
export async function listVisibleBeliefLifetimes(engine: Raw, linkIds: readonly string[]): Promise<string[]> {
  const rows = await rowsOf<{ page_lifetime: string }>(engine, sqlFragment`SELECT l.page_lifetime::text AS page_lifetime
    FROM belief_page_lifetimes l JOIN pages p ON p.source_id = l.source_id AND p.slug = l.slug AND p.deleted_at IS NULL AND (l.page_id IS NULL OR p.id = l.page_id)
    WHERE l.page_lifetime = ANY(${[...linkIds]}::uuid[]) AND l.ended_at IS NULL AND ${trustedSql(remoteReadFloorSql('p'))}`);
  return rows.map(r => r.page_lifetime).sort(byteCmp);
}

// ---------------------------------------------------------------------------------------------------------------
// Page history

/** The stored snapshot tier of each listed version (null when none was stamped), by id. */
export async function listVersionTrustTiers(engine: Raw, ids: readonly number[]): Promise<Array<{ id: number; trust_tier: string | null }>> {
  const got = await engine.executeRaw<{ id: number | string; trust_tier: string | null }>(
    'SELECT id, trust_tier FROM page_versions WHERE id = ANY($1::bigint[])', [[...ids]]);
  return got.map(r => ({ id: Number(r.id), trust_tier: r.trust_tier ?? null })).sort((a, b) => a.id - b.id);
}

/**
 * For each listed version, the type and tier of the write that replaced it: the next snapshot of the page, or the live
 * page when there is none. By id.
 */
export async function listVersionReasonWriters(engine: Raw, ids: readonly number[]): Promise<Array<{ id: number; type: string | null; tier: string | null }>> {
  const got = await engine.executeRaw<{ id: number | string; type: string | null; tier: string | null }>(
    `SELECT pv.id, COALESCE(nx.type, p.type) AS type, CASE WHEN nx.id IS NULL THEN p.trust_tier ELSE nx.trust_tier END AS tier
       FROM page_versions pv JOIN pages p ON p.id = pv.page_id
       LEFT JOIN LATERAL (SELECT n.id, n.type, n.trust_tier FROM page_versions n WHERE n.page_id = pv.page_id AND n.id > pv.id ORDER BY n.id LIMIT 1) nx ON true
      WHERE pv.id = ANY($1::bigint[])`, [[...ids]]);
  return got.map(r => ({ id: Number(r.id), type: r.type ?? null, tier: r.tier ?? null })).sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------------------------------------------
// Quoting

/** A page named by id: its stored type. */
export interface PageTypeRef { id: number; type: string | null }

/**
 * The stored type of each listed page, deleted or not, by id; an id no page has answers nothing. No scope or policy
 * filter: the callers pass ids of rows they already read under the caller's scope.
 */
export async function listPageTypesByIds(engine: Raw, ids: readonly number[]): Promise<PageTypeRef[]> {
  if (!ids.length) return [];
  const rows = await engine.executeRaw<{ id: number | string; type: string | null }>('SELECT id, type FROM pages WHERE id = ANY($1::bigint[])', [[...new Set(ids.map(Number))]]);
  return rows.map(r => ({ id: Number(r.id), type: r.type ?? null })).sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------------------------------------------
// Rederive

/** Whether a purge hid the page until it is derived again (`needs_rederive`). */
export async function pageAwaitsRederive(engine: Raw, pageId: number): Promise<boolean> {
  const [hidden] = await rowsOf<{ n: number }>(engine,
    sqlFragment`SELECT count(*)::int AS n FROM pages p WHERE p.id = ${pageId} AND NOT ${trustedSql(rederiveHiddenSql('pages', 'p'))}`);
  return Number(hidden?.n) > 0;
}
