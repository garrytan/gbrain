/**
 * The reads of stamped trust tiers that page history and the quote path made through `executeRaw`: SQL once for
 * both engines.
 *
 * - `listVersionTrustTiers` / `listVersionReasonWriters`: the snapshot tier of a page version, and the type and tier
 *   of the write that replaced it (the next snapshot, or the live page).
 * - `listPageTypesByIds`: the stored type of each listed page, for the reads that quote a third-party page's rows
 *   (search/transcript-quote.ts `pageTypesById`).
 *
 * Every statement here is the statement its caller ran through `executeRaw`, byte for byte. Where master left the row
 * order to the plan the member sorts the rows in JavaScript (ids numeric), so every engine answers alike. Ids come
 * back as numbers.
 */
import type { BrainEngine } from '../engine.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';
import { activationSuppressedSql, pageEligibleSql, rederiveHiddenSql } from '../eligibility/sql.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import {
  callerReadersAllowedSql, privacyForCaller, privateLinkOriginFilterFragment, privatePagesFilterForCaller, privatePagesFilterFragment,
  privateSnapshotFilterFragment, remoteReadFloorSql,
} from '../search/private-visibility.ts';
import { validDateSql } from '../valid-time.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { replacedBecauseSql } from './pages.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

const json = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
const none = sqlFragment``;

async function rows<T>(tx: Raw, fragment: SqlFragment): Promise<T[]> {
  const { text, params } = renderFragment(fragment);
  return tx.executeRaw<T>(text, params);
}

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
  /** At most this many rows. */
  limit: number;
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

/** The live `always_load` pages, by source then slug, at most `limit`. */
export async function listCorePageRows(tx: Raw, spec: CorePageRowSpec): Promise<CorePageRow[]> {
  const policy = spec.eligibility;
  const sources = spec.sourceIds ? sqlFragment` AND p.source_id = ANY(${[...spec.sourceIds]}::text[])` : none;
  const exclude = spec.exclude ? sqlFragment` AND NOT (p.source_id = ${spec.exclude.sourceId} AND p.slug = ${spec.exclude.slug})` : none;
  const privacy = !spec.excludePrivate ? none
    : spec.forCaller ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('p'))}` : sqlFragment` AND ${trustedSql(remoteReadFloorSql('p'))}`;
  const eligible = policy
    ? sqlFragment` AND ${trustedSql(quarantineFilterFragment('p'))} AND ${trustedSql(pageEligibleSql('p', { floor: policy.floor }))}` : none;
  const suppressed = policy?.suppressFlagged ? sqlFragment`${trustedSql(activationSuppressedSql('pages', 'p'))}` : sqlFragment`false`;
  const trustCols = policy ? sqlFragment` p.trust_tier, p.write_origin, ${suppressed} AS suppressed,` : none;
  const got = await rows<Record<string, unknown>>(tx, sqlFragment`SELECT p.id, p.source_id, p.slug, p.title, p.compiled_truth, p.frontmatter,
      p.body_storage, p.body_bytes,${trustCols}
      EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = p.source_id AND (w.subject = '*' OR w.subject = p.slug)) AS withdrawn
    FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter @> '{"always_load": true}'::jsonb${sources}${exclude}${privacy}${eligible}
    ORDER BY p.source_id COLLATE "C", p.slug COLLATE "C" LIMIT ${spec.limit}`);
  return got.map(r => {
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

function scanFrom(table: TrustScanTable, tiers: readonly string[]): SqlFragment {
  const t = [...tiers];
  switch (table) {
    case 'pages': return sqlFragment`SELECT p.id, p.source_id, p.trust_tier, p.write_origin, p.title, p.compiled_truth, p.timeline, p.frontmatter
      FROM pages p WHERE p.deleted_at IS NULL AND p.trust_tier = ANY(${t}::text[])`;
    case 'facts': return sqlFragment`SELECT p.id, p.source_id, p.trust_tier, p.write_origin, p.fact, p.context, p.value, p.source
      FROM facts p WHERE p.trust_tier = ANY(${t}::text[])`;
    case 'takes': return sqlFragment`SELECT p.id, pg.source_id, p.trust_tier, p.write_origin, p.claim, p.source
      FROM takes p JOIN pages pg ON pg.id = p.page_id WHERE p.trust_tier = ANY(${t}::text[])`;
    case 'timeline_entries': return sqlFragment`SELECT p.id, pg.source_id, p.trust_tier, p.write_origin, p.summary, p.detail, p.source
      FROM timeline_entries p JOIN pages pg ON pg.id = p.page_id WHERE p.trust_tier = ANY(${t}::text[])`;
  }
}

/** The table's rows above `afterId` whose stored tier is listed, by id, at most `limit`. */
export async function listTrustScanRows(tx: Raw, spec: TrustScanRowSpec): Promise<TrustScanRow[]> {
  const got = await rows<Record<string, unknown>>(tx,
    sqlFragment`${scanFrom(spec.table, spec.tiers)} AND p.id > ${spec.afterId} ORDER BY p.id LIMIT ${spec.limit}`);
  return got.map(r => ({ ...r, id: Number(r.id), source_id: (r.source_id as string | null) ?? null, trust_tier: String(r.trust_tier),
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
export async function countUnscannedTrustRows(tx: Raw, spec: UnscannedTrustSpec): Promise<number> {
  const t = [...spec.tiers];
  const from = {
    pages: sqlFragment`FROM pages p WHERE p.deleted_at IS NULL AND`,
    facts: sqlFragment`FROM facts p WHERE`,
    takes: sqlFragment`FROM takes p WHERE`,
    timeline_entries: sqlFragment`FROM timeline_entries p WHERE`,
  }[spec.table];
  const ceiling = spec.until === null ? none : sqlFragment` AND p.id <= ${spec.until}`;
  const [row] = await rows<{ n: number | string }>(tx,
    sqlFragment`SELECT count(*)::int AS n ${from} p.trust_tier = ANY(${t}::text[]) AND p.id > ${spec.afterId}${ceiling}`);
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
export async function readBeliefHistoryRows(tx: Raw, q: BeliefHistoryRowQuery): Promise<Array<Record<string, unknown>>> {
  const order = trustedSql(q.descending ? 'DESC' : 'ASC');
  return rows(tx, sqlFragment`SELECT e.id, e.slug, e.page_lifetime::text AS page_lifetime,
      e.subject_kind, e.subject_key, e.event_type, e.origin, e.trust_tier, e.writer_tier, e.tier_basis, e.visibility, e.recorded_at, e.source_time,
      e.value, e.value_hash, e.prior_hash, e.state_hash, e.cause, e.purged, e.redacted_fields,
      (SELECT ${trustedSql(remoteReadFloorSql('p'))} AND (e.subject_kind NOT IN ('fact', 'take') OR ${trustedSql(quarantineFilterFragment('p'))})
        FROM belief_page_lifetimes l JOIN pages p ON p.source_id = l.source_id AND p.slug = l.slug
        AND p.deleted_at IS NULL AND (l.page_id IS NULL OR p.id = l.page_id)
        WHERE l.page_lifetime = e.page_lifetime AND l.ended_at IS NULL) AS stream_visible,
      (e.claim_fp IS NOT NULL AND EXISTS (SELECT 1 FROM belief_events v WHERE v.source_id = e.source_id AND v.source_incarnation = e.source_incarnation
        AND v.claim_fp = e.claim_fp AND v.subject_kind = e.subject_kind AND v.visibility = 'private' AND v.id > e.id)) AS later_private,
      CASE WHEN e.subject_kind = 'take' THEN COALESCE(e.value->>'holder', (SELECT t.value->>'holder' FROM belief_events t WHERE t.source_id = e.source_id
        AND t.source_incarnation = e.source_incarnation AND t.subject_kind = 'take' AND t.subject_key = e.subject_key AND t.id < e.id AND t.value->>'holder' IS NOT NULL
        ORDER BY t.id DESC LIMIT 1)) END AS take_holder
    FROM belief_events e
    WHERE e.source_id = ${q.sourceId} AND e.source_incarnation = (SELECT s.incarnation FROM sources s WHERE s.id = ${q.sourceId})
      AND (${q.slug}::text IS NULL OR e.slug = ${q.slug}) AND (${q.subjectKey}::text IS NULL OR e.subject_key = ${q.subjectKey}) AND e.id > ${q.afterId}
      AND (${q.recordedAfter}::timestamptz IS NULL OR e.recorded_at > ${q.recordedAfter}::timestamptz)
      AND (${q.recordedUntil}::timestamptz IS NULL OR e.recorded_at <= ${q.recordedUntil}::timestamptz)
      AND (${q.subjectKeys ? [...q.subjectKeys] : null}::text[] IS NULL OR e.subject_key = ANY(${q.subjectKeys ? [...q.subjectKeys] : null}::text[]))
      AND (${q.beforeId}::bigint IS NULL OR e.id < ${q.beforeId}::bigint)
      AND NOT EXISTS (SELECT 1 FROM belief_events h WHERE h.source_id = e.source_id AND h.subject_kind = e.subject_kind AND h.subject_key = e.subject_key
        AND h.event_type = 'derived.hidden' AND h.id <> e.id AND (h.id > e.id OR e.origin = 'backfill'))
    ORDER BY e.id ${order} LIMIT ${q.limit}`);
}

/** The listed page lifetimes that are live and whose page passes the remote read floor, in lifetime order. */
export async function listVisibleBeliefLifetimes(tx: Raw, lifetimes: readonly string[]): Promise<string[]> {
  const got = await rows<{ page_lifetime: string }>(tx, sqlFragment`SELECT l.page_lifetime::text AS page_lifetime
    FROM belief_page_lifetimes l JOIN pages p ON p.source_id = l.source_id AND p.slug = l.slug AND p.deleted_at IS NULL AND (l.page_id IS NULL OR p.id = l.page_id)
    WHERE l.page_lifetime = ANY(${[...lifetimes]}::uuid[]) AND l.ended_at IS NULL AND ${trustedSql(remoteReadFloorSql('p'))}
    ORDER BY l.page_lifetime::text COLLATE "C"`);
  return got.map(r => r.page_lifetime);
}

// ---------------------------------------------------------------------------------------------------------------
// Page history

/** The stored snapshot tier of each listed version (null when none was stamped), by id. */
export async function listVersionTrustTiers(tx: Raw, ids: readonly number[]): Promise<Array<{ id: number; trust_tier: string | null }>> {
  const got = await rows<{ id: number | string; trust_tier: string | null }>(tx,
    sqlFragment`SELECT pv.id, pv.trust_tier FROM page_versions pv WHERE pv.id = ANY(${[...ids]}::bigint[]) ORDER BY pv.id`);
  return got.map(r => ({ id: Number(r.id), trust_tier: r.trust_tier ?? null }));
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

/** A page named by id: its source, slug and stored type. */
export interface PageIdRef { id: number; source_id: string; slug: string; type: string | null }

/**
 * The source, slug and stored type of each listed page, deleted or not, by id; an id no page has answers nothing. No
 * scope or policy filter: the callers pass ids of rows they already read under the caller's scope.
 */
export async function listPageRefsByIds(tx: Raw, ids: readonly number[]): Promise<PageIdRef[]> {
  if (ids.length === 0) return [];
  const got = await rows<{ id: number | string; source_id: string; slug: string; type: string | null }>(tx,
    sqlFragment`SELECT id, source_id, slug, type FROM pages WHERE id = ANY(${[...new Set(ids.map(Number))]}::bigint[]) ORDER BY id`);
  return got.map(r => ({ id: Number(r.id), source_id: r.source_id, slug: r.slug, type: r.type ?? null }));
}

/** A page named by source and slug. */
export interface PageKeyRef { source_id: string; slug: string }

/**
 * The id and stored trust tier of each named page, deleted or not, in no set order; a key no page has answers nothing
 * and a key named twice answers twice.
 * Timeline projection (trust/timeline-projection.ts) stamps each row with its page's tier.
 */
export async function listPageTrustTiersByKey(tx: Raw, refs: readonly PageKeyRef[]): Promise<Array<{ id: number; source_id: string; slug: string; trust_tier: string | null }>> {
  const got = await tx.executeRaw<{ id: number | string; source_id: string; slug: string; trust_tier: string | null }>(
    `SELECT p.id,p.source_id,p.slug,p.trust_tier FROM pages p
      JOIN jsonb_to_recordset($1::text::jsonb) AS r(source_id text,slug text) ON p.source_id=r.source_id AND p.slug=r.slug`,
    [JSON.stringify(refs)]);
  return got.map(r => ({ id: Number(r.id), source_id: r.source_id, slug: r.slug, trust_tier: r.trust_tier }));
}

/**
 * The named pages that are live, in no set order, each held `FOR SHARE` until the transaction ends so a concurrent
 * delete cannot slip between this check and the write that follows (timeline projection's `requirePages`).
 */
export async function lockLivePagesByKey(tx: Raw, refs: readonly PageKeyRef[]): Promise<PageKeyRef[]> {
  return tx.executeRaw<PageKeyRef>(`SELECT p.source_id,p.slug FROM pages p
          JOIN jsonb_to_recordset($1::text::jsonb) AS r(source_id text,slug text) ON p.source_id=r.source_id AND p.slug=r.slug
          WHERE p.deleted_at IS NULL FOR SHARE OF p`, [JSON.stringify(refs)]);
}

// ---------------------------------------------------------------------------------------------------------------
// Valid time

export interface ValidTimeIdentitySpec {
  slug: string;
  /** Only this source; null is any. */
  sourceId: string | null;
  /** Only these sources; null is any. */
  sourceIds: readonly string[] | null;
  /** Leave out the pages the caller's page policy hides. */
  excludePrivate: boolean;
}

/** A page a valid-time read may follow: its file, its source's checkout, and whether the no-caller policy shows it. */
export interface ValidTimeIdentityRow { id: number; source_id: string; slug: string; source_path: string | null; local_path: string | null; world: boolean }

/**
 * The live pages with this slug in the scope, by source (at most six: a read that finds more than one refuses and asks
 * for a source). `world` is the no-caller page policy, which decides whether the page's Git history may be named.
 */
export async function listValidTimeIdentities(tx: Raw, spec: ValidTimeIdentitySpec): Promise<ValidTimeIdentityRow[]> {
  const source = spec.sourceId !== null ? sqlFragment` AND p.source_id = ${spec.sourceId}` : none;
  const sources = spec.sourceIds ? sqlFragment` AND p.source_id = ANY(${[...spec.sourceIds]}::text[])` : none;
  const hidden = spec.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('p'))}` : none;
  const got = await rows<{ id: number | string; source_id: string; slug: string; source_path: string | null; local_path: string | null; world: boolean }>(tx,
    sqlFragment`SELECT p.id, p.source_id, p.slug, p.source_path, s.local_path, ${trustedSql(privatePagesFilterFragment('p'))} AS world
      FROM pages p JOIN sources s ON s.id = p.source_id
     WHERE p.slug = ${spec.slug} AND p.deleted_at IS NULL${source}${sources}${hidden}
     ORDER BY p.source_id COLLATE "C" LIMIT 6`);
  return got.map(r => ({ id: Number(r.id), source_id: r.source_id, slug: r.slug, source_path: r.source_path ?? null, local_path: r.local_path ?? null, world: r.world === true }));
}

/** The ordinal the current page takes after every version id (one past the int4 range). */
export const VALID_TIME_CURRENT_ORD = 2147483648;

const PV_BODY_KEY = `CASE WHEN pv.body_storage = 'segmented' THEN 's:' || COALESCE(pv.content_hash, '')
  ELSE md5(COALESCE(pv.compiled_truth, '') || chr(1) || COALESCE(pv.timeline, '')) END`;
const P_BODY_KEY = `CASE WHEN p.body_storage = 'segmented' THEN 's:' || COALESCE(p.content_hash, '')
  ELSE md5(COALESCE(p.compiled_truth, '') || chr(1) || COALESCE(p.timeline, '')) END`;

export interface ValidTimePickSpec {
  pageId: number;
  /** YYYY-MM-DD. */
  asOf: string;
  /** The read hides private text: an introduced reason counts only from a visible row. */
  excludePrivate: boolean;
  /** Measure this ordinal (a cursor's edition) instead of picking. */
  pinOrd: number | null;
  /** A version body over this many bytes counts as large (it may have been pruned). */
  inlineMaxBytes: number;
}

/**
 * The pick over the current page and its retained versions: the greatest `valid_from` on or before the date, the most
 * recently recorded on a tie, else the earliest later one; with the ambiguity window, the counts and the page's gap
 * facts. One row (its pick columns null when no row is dated), or null when the page is gone.
 */
export async function pickValidTimeEdition(tx: Raw, spec: ValidTimePickSpec): Promise<Record<string, unknown> | null> {
  const { pageId, asOf, pinOrd } = spec;
  const visibleOnly = trustedSql(spec.excludePrivate ? ' AND r.visible' : '');
  const [r] = await rows<Record<string, unknown>>(tx, sqlFragment`WITH rows AS (
      SELECT pv.id AS version_id, pv.id::bigint AS ord, pv.snapshot_at AS replaced_at,
             ${trustedSql(validDateSql(`pv.frontmatter->>'valid_from'`))} AS valid_from, ${trustedSql(validDateSql(`pv.frontmatter->>'valid_until'`))} AS valid_until,
             ${trustedSql(PV_BODY_KEY)} AS body_key,
             (${trustedSql(callerReadersAllowedSql('pv', 'snapshot'))} AND ${trustedSql(privacyForCaller('p', privateSnapshotFilterFragment('pv')))}) AS visible,
             ${trustedSql(replacedBecauseSql('pv', spec.excludePrivate))} AS reason, pv.trust_tier AS tier,
             COALESCE(pv.successor_pruned, false) AS successor_pruned, COALESCE(pv.body_storage = 'segmented', false) AS segmented,
             (pv.body_storage IS DISTINCT FROM 'segmented' AND octet_length(COALESCE(pv.compiled_truth, '')) + octet_length(COALESCE(pv.timeline, '')) > ${spec.inlineMaxBytes}) AS large,
             pv.source_path IS NOT NULL AS filed
        FROM page_versions pv JOIN pages p ON p.id = pv.page_id WHERE pv.page_id = ${pageId}
      UNION ALL
      SELECT NULL, ${VALID_TIME_CURRENT_ORD}::bigint, NULL, ${trustedSql(validDateSql(`p.frontmatter->>'valid_from'`))}, ${trustedSql(validDateSql(`p.frontmatter->>'valid_until'`))},
             ${trustedSql(P_BODY_KEY)}, ${trustedSql(privatePagesFilterForCaller('p'))}, NULL, p.trust_tier,
             false, COALESCE(p.body_storage = 'segmented', false), false, p.source_path IS NOT NULL
        FROM pages p WHERE p.id = ${pageId}),
    seq AS (
      SELECT r.*, lag(r.replaced_at) OVER w AS recorded_since, lag(CASE WHEN NOT r.successor_pruned${visibleOnly} THEN r.reason END) OVER w AS introduced_because,
             lead(r.tier) OVER w AS successor_tier, lag(r.ord) OVER w AS prev_ord, lead(r.ord) OVER w AS next_ord
        FROM rows r WINDOW w AS (ORDER BY r.ord)),
    pick AS (
      SELECT s.*, (s.valid_from <= ${asOf}::text) AS chosen FROM seq s
       WHERE s.valid_from IS NOT NULL AND (${pinOrd}::bigint IS NULL OR s.ord = ${pinOrd}::bigint)
       ORDER BY (s.valid_from <= ${asOf}::text) DESC, CASE WHEN s.valid_from <= ${asOf}::text THEN s.valid_from END COLLATE "C" DESC,
                CASE WHEN s.valid_from > ${asOf}::text THEN s.valid_from END COLLATE "C" ASC, s.ord DESC
       LIMIT 1)
    SELECT k.version_id, k.ord, k.replaced_at, k.valid_from, k.valid_until, k.visible, k.reason, k.successor_pruned, k.segmented,
           k.recorded_since, k.introduced_because, k.chosen, k.tier, k.successor_tier,
           (SELECT array_agg(c.ord ORDER BY c.ord) FROM (SELECT s.ord FROM seq s
              WHERE s.valid_from IS NOT NULL AND s.ord <> k.ord AND (
                (s.ord > k.ord AND s.valid_from < k.valid_from)
                OR (s.ord IN (k.prev_ord, k.next_ord) AND s.body_key = (SELECT b.body_key FROM seq b WHERE b.ord = k.ord) AND s.valid_from <> k.valid_from))
              ORDER BY s.ord LIMIT 5) c) AS competing,
           (SELECT count(*) FROM seq WHERE valid_from IS NULL) AS undated,
           (SELECT count(*) FROM seq WHERE version_id IS NOT NULL AND large) AS large_versions,
           (SELECT count(*) FROM seq WHERE version_id IS NOT NULL AND segmented) AS segmented_versions,
           (SELECT bool_or(filed) FROM seq) AS any_filed,
           p.version_history_gap_at AS gap_at, p.created_at
      FROM pages p LEFT JOIN pick k ON true WHERE p.id = ${pageId}`);
  return r ?? null;
}

export interface AmendmentsNotAppliedSpec {
  pageId: number;
  /** The edition's `valid_from` (YYYY-MM-DD): an amendment dated on or before it is already in the text. */
  editionFrom: string;
  /** YYYY-MM-DD. */
  asOf: string;
  /** Leave out an amending page below the remote read floor and a link whose origin page is private. */
  excludePrivate: boolean;
  /** Only amending pages in these sources; null is any. */
  sourceIds: readonly string[] | null;
  limit: number;
}

/** An amending page, and the earliest date its `amends` relationship starts (null when undated). */
export interface AmendmentNotAppliedRow { slug: string; source_id: string; since: string | null }

/**
 * The live pages that amend this page (`amends` links to it) and are dated after the edition took effect and on or
 * before the date, or undated: an as-of read does not fold them in. By slug, then source, bytewise.
 */
export async function listAmendmentsNotApplied(tx: Raw, spec: AmendmentsNotAppliedSpec): Promise<AmendmentNotAppliedRow[]> {
  const floor = spec.excludePrivate ? sqlFragment` AND ${trustedSql(remoteReadFloorSql('f'))}` : none;
  const origin = spec.excludePrivate ? sqlFragment` AND ${trustedSql(privateLinkOriginFilterFragment('l'))}` : none;
  const sources = spec.sourceIds ? sqlFragment` AND f.source_id = ANY(${[...spec.sourceIds]}::text[])` : none;
  const scope = spec.excludePrivate ? 'world' : 'all';
  const got = await rows<{ slug: string; source_id: string; since: string | null }>(tx, sqlFragment`SELECT f.slug, f.source_id,
           min(to_char(r.first_start, 'YYYY-MM-DD')) AS since
      FROM links l JOIN pages f ON f.id = l.from_page_id AND f.deleted_at IS NULL${floor}
      LEFT JOIN link_relationships r ON r.from_page_id = l.from_page_id AND r.to_page_id = l.to_page_id AND r.link_type = l.link_type AND r.scope = ${scope}
     WHERE l.to_page_id = ${spec.pageId} AND l.link_type = 'amends'${origin}${sources}
       AND (r.first_start IS NULL OR (r.first_start > ${spec.editionFrom}::date AND r.first_start <= ${spec.asOf}::date))
     GROUP BY f.slug, f.source_id ORDER BY f.slug COLLATE "C", f.source_id COLLATE "C" LIMIT ${spec.limit}`);
  return got.map(r => ({ slug: r.slug, source_id: r.source_id, since: r.since ?? null }));
}

/** A retained version of one page as an as-of read loads it (`readPageVersionEdition`). */
export interface PageVersionEditionRow {
  id: number;
  title: string | null;
  type: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
  compiled_truth: string | null;
  timeline: string | null;
  revision: string | null;
  /** `segmented` on the snapshot of a segmented page, else null. */
  body_storage: string | null;
  body_generation: number | null;
}

/** The version `versionId` of page `pageId`, or null when the page keeps no such version. */
export async function readPageVersionEdition(tx: Raw, spec: { pageId: number; versionId: number }): Promise<PageVersionEditionRow | null> {
  const [v] = await rows<Record<string, unknown>>(tx, sqlFragment`SELECT id, title, type, tags, frontmatter, compiled_truth, timeline,
           knowledge_revision::text AS revision, body_storage, body_generation
      FROM page_versions WHERE id = ${spec.versionId} AND page_id = ${spec.pageId}`);
  if (!v) return null;
  const tags = Array.isArray(v.tags) ? v.tags.map(String) : typeof v.tags === 'string' ? (JSON.parse(v.tags) as unknown[]).map(String) : [];
  return {
    id: Number(v.id), title: v.title == null ? null : String(v.title), type: v.type == null ? null : String(v.type), tags,
    frontmatter: (json(v.frontmatter) ?? {}) as Record<string, unknown>,
    compiled_truth: v.compiled_truth == null ? null : String(v.compiled_truth), timeline: v.timeline == null ? null : String(v.timeline),
    revision: v.revision == null ? null : String(v.revision), body_storage: v.body_storage == null ? null : String(v.body_storage),
    body_generation: v.body_generation == null ? null : Number(v.body_generation),
  };
}

/** Where a window cursor's revision stands (`readCursorEdition`): still the page's, or the newest version with it. */
export interface CursorEditionRow { current: boolean; version_id: number | null }

/**
 * Whether the page (deleted or not) is still at `revision`, and the newest retained version recorded at it; null
 * when the page is gone.
 */
export async function readCursorEdition(tx: Raw, spec: { pageId: number; revision: string }): Promise<CursorEditionRow | null> {
  const [r] = await rows<{ current: boolean | null; version_id: number | string | null }>(tx, sqlFragment`SELECT
           (p.knowledge_revision::text = ${spec.revision}) AS current,
           (SELECT max(v.id) FROM page_versions v WHERE v.page_id = p.id AND v.knowledge_revision::text = ${spec.revision}) AS version_id
      FROM pages p WHERE p.id = ${spec.pageId}`);
  if (!r) return null;
  return { current: r.current === true, version_id: r.version_id == null ? null : Number(r.version_id) };
}

/** Whether a purge hid the page until it is derived again: a `needs_rederive` row names it. False for a missing page. */
export async function pageAwaitsRederive(tx: Raw, pageId: number): Promise<boolean> {
  const [r] = await rows<{ n: number | string }>(tx, sqlFragment`SELECT count(*)::int AS n
      FROM pages p WHERE p.id = ${pageId} AND NOT ${trustedSql(rederiveHiddenSql('pages', 'p'))}`);
  return Number(r?.n) > 0;
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

/** One pending remote-edit notice of a core page (core-memory.ts pendingCoreNotices). */
export interface CoreEditNoticeRow { source_id: string; slug: string; revision: string | null; actor: string; created_at: string }

/**
 * The unacknowledged remote-edit notices of core pages, the newest per page, by source then slug in byte order, at
 * most 50; only `sourceIds` when given (the core block's and doctor's notice lines).
 */
export async function listPendingCoreEditNotices(tx: Raw, sourceIds: readonly string[] | null): Promise<CoreEditNoticeRow[]> {
  return tx.executeRaw<CoreEditNoticeRow>(
    `SELECT DISTINCT ON (source_id COLLATE "C", slug COLLATE "C") source_id, slug, revision, actor, created_at::text AS created_at
       FROM core_edit_notices WHERE acked_at IS NULL ${sourceIds ? 'AND source_id = ANY($1::text[])' : ''}
      ORDER BY source_id COLLATE "C", slug COLLATE "C", id DESC LIMIT 50`, sourceIds ? [[...sourceIds]] : []);
}
