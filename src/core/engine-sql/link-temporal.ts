/**
 * Link temporal state (temporal typed edges): the `link_relationships` and
 * `link_transitions` statements, and the reads that join them, once for both
 * engines. The callers are link-relationships.ts, link-temporal-apply.ts,
 * link-relationship-notes.ts, doctor's edge_validity check and the referrer
 * record metadata of mentions/referrers.ts; the state itself is built by the
 * pure `buildRelationshipStateWrite` there. The entity card's referrer groups read here too; their text is
 * mentions/referrers-sql.ts's. The Rust store answers the same
 * members (rust/docs/store/link_temporal.md).
 *
 * Every statement here ran on master from the caller named on its function.
 * They keep master's text and run on master's raw path (`exec.executeRaw`)
 * unscoped, as before. A caller that swallowed a database error still does;
 * a refused capability is never swallowed (engine-capability-refusal.ts).
 */
import { executeRawJsonb } from '../sql-query.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import {
  privateLinkOriginFilterForCaller, privatePagesFilterForCaller, privatePagesFilterFragment,
} from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { temporalLinkJoinSql, temporalLinkTypes, TEMPORAL_LINK_SELECT_SQL } from '../link-validity.ts';
import {
  buildRelationshipStateWrite, temporalKeys,
  type AssertionRow, type ExistingRow, type RelationshipEvidence, type RelationshipKey, type RelationshipStateWrite, type TransitionRow,
} from '../link-relationships.ts';
import { pipelined } from '../page-state/transactions.ts';
import {
  REFERRER_RECORD_PAGES_SQL, REFERRER_TARGET_SOURCES_SQL, referrerCountSql, referrerGroupsSql, referrerPageDetailsSql, referrerRecordCandidatesSql,
  referrerRowsSql, referrerTargetCountsSql, referrerTypesSql,
} from '../mentions/referrers-sql.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';
import type { SqlExecutor } from './executor.ts';

type Exec = Pick<SqlExecutor, 'executeRaw'>;

const keyRows = (rows: RelationshipKey[]) =>
  rows.map(r => ({ from_page_id: Number(r.from_page_id), to_page_id: Number(r.to_page_id), link_type: r.link_type }));

/** The derived transition producers an origin's evidence replacement owns (manual rows are left alone). */
export const DERIVED_TRANSITION_PRODUCERS = ['timeline', 'explicit', 'frontmatter', 'dream', 'inline'];

// ---------------------------------------------------------------------------------------------------------------------
// Relationship state (link-relationships.ts refreshRelationships)
// ---------------------------------------------------------------------------------------------------------------------

/** Render `fragment`, whose only bound value is one JSONB document, and run it through executeRawJsonb (master's path). */
function jsonbRows<R>(exec: Exec, fragment: SqlFragment): Promise<R[]> {
  const { text, params } = renderFragment(fragment);
  return executeRawJsonb<R>(exec, text, [], params);
}

/** Render `fragment` and run it on master's raw path, unscoped. */
function rows<R>(exec: Exec, fragment: SqlFragment): Promise<R[]> {
  const { text, params } = renderFragment(fragment);
  return exec.executeRaw<R>(text, params);
}

/** The assertions, transitions and existing state rows of `keys` (already deduped temporal keys). */
export async function readLinkRelationshipEvidence(exec: Exec, keys: readonly RelationshipKey[]): Promise<RelationshipEvidence> {
  if (!keys.length) return { assertions: [], transitions: [], existing: [] };
  const payload = { rows: keys };
  const assertions = await jsonbRows<AssertionRow>(exec, sqlFragment`SELECT v.from_page_id, v.to_page_id, v.link_type,
            COALESCE(l.origin_page_id, l.from_page_id) AS origin_id,
            COALESCE(l.assertion_tense, 'present') AS tense, l.created_at, f.source_id,
            (${trustedSql(privatePagesFilterFragment('o'))}) AS origin_public
       FROM jsonb_to_recordset((${payload}::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text)
       JOIN links l ON l.from_page_id = v.from_page_id AND l.to_page_id = v.to_page_id AND l.link_type = v.link_type
       JOIN pages f ON f.id = l.from_page_id AND f.deleted_at IS NULL
       JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL
       JOIN pages o ON o.id = COALESCE(l.origin_page_id, l.from_page_id) AND o.deleted_at IS NULL AND o.source_id = f.source_id`);
  const transitions = await jsonbRows<TransitionRow>(exec, sqlFragment`SELECT v.from_page_id, v.to_page_id, v.link_type, lt.origin_page_id AS origin_id, lt.kind,
            lt.occurred_on::text AS occurred_on, lt.producer, lt.created_at, f.source_id,
            (o.id IS NULL OR ${trustedSql(privatePagesFilterFragment('o'))}) AS origin_public
       FROM jsonb_to_recordset((${payload}::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text)
       JOIN link_transitions lt ON lt.from_page_id = v.from_page_id AND lt.to_page_id = v.to_page_id AND lt.link_type = v.link_type
       JOIN pages f ON f.id = lt.from_page_id AND f.deleted_at IS NULL
       JOIN pages t ON t.id = lt.to_page_id AND t.deleted_at IS NULL
       LEFT JOIN pages o ON o.id = lt.origin_page_id
      WHERE lt.origin_page_id IS NULL OR (o.deleted_at IS NULL AND o.source_id = f.source_id)`);
  const existing = await executeRawJsonb<ExistingRow>(exec,
    `SELECT lr.from_page_id, lr.to_page_id, lr.link_type, lr.scope, lr.recorded_at, lr.retired_at, lr.evidence_hash
       FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text)
       JOIN link_relationships lr ON lr.from_page_id = v.from_page_id AND lr.to_page_id = v.to_page_id AND lr.link_type = v.link_type`,
    [], [payload]);
  return { assertions, transitions, existing };
}

/** Upsert and remove state rows; returns the changed upserts plus the rows removed, and bumps the graph generation when any. */
export async function writeLinkRelationshipState(exec: Exec, write: RelationshipStateWrite): Promise<number> {
  let changed = write.changed;
  if (write.upserts.length) {
    const written = await executeRawJsonb(exec,
      `INSERT INTO link_relationships (from_page_id, to_page_id, link_type, scope, source_id, semantics, valid_ranges,
         status_now, first_start, last_start, last_end, undated_present, undated_past, disputed, recorded_at, retired_at,
         evidence_hash, refreshed_at)
       SELECT v.from_page_id, v.to_page_id, v.link_type, v.scope, v.source_id, v.semantics, v.valid_ranges::datemultirange,
              v.status_now, v.first_start, v.last_start, v.last_end, v.undated_present, v.undated_past, v.disputed,
              v.recorded_at, v.retired_at, v.evidence_hash, now()
         FROM jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text, scope text,
           source_id text, semantics text, valid_ranges text, status_now text, first_start date, last_start date,
           last_end date, undated_present int, undated_past int, disputed boolean, recorded_at timestamptz,
           retired_at timestamptz, evidence_hash text)
       ON CONFLICT (from_page_id, to_page_id, link_type, scope) DO UPDATE SET
         source_id = EXCLUDED.source_id, semantics = EXCLUDED.semantics, valid_ranges = EXCLUDED.valid_ranges,
         status_now = EXCLUDED.status_now, first_start = EXCLUDED.first_start, last_start = EXCLUDED.last_start,
         last_end = EXCLUDED.last_end, undated_present = EXCLUDED.undated_present, undated_past = EXCLUDED.undated_past,
         disputed = EXCLUDED.disputed, recorded_at = LEAST(link_relationships.recorded_at, EXCLUDED.recorded_at),
         retired_at = EXCLUDED.retired_at, evidence_hash = EXCLUDED.evidence_hash, refreshed_at = now()
       RETURNING 1`,
      [], [{ rows: write.upserts }]);
    if (written.length !== write.upserts.length) throw new Error('link_relationships refresh did not persist every state row');
  }
  if (write.removals.length) {
    const removed = await executeRawJsonb(exec,
      `DELETE FROM link_relationships lr
        USING jsonb_to_recordset(($1::jsonb)->'rows') AS v(from_page_id int, to_page_id int, link_type text, scope text)
        WHERE lr.from_page_id = v.from_page_id AND lr.to_page_id = v.to_page_id AND lr.link_type = v.link_type AND lr.scope = v.scope
        RETURNING 1`,
      [], [{ rows: write.removals }]);
    changed += removed.length;
  }
  if (changed) await exec.executeRaw(`SELECT nextval('graph_generation_seq')`);
  return changed;
}

/** refreshRelationships over the executor itself, for the link writers of engine-sql/links.ts (same transaction). */
export async function refreshRelationshipsSql(exec: Exec, keys: Iterable<RelationshipKey>): Promise<number> {
  const rows = temporalKeys(keys);
  if (rows.length === 0) return 0;
  return writeLinkRelationshipState(exec, buildRelationshipStateWrite(rows, await readLinkRelationshipEvidence(exec, rows)));
}

/** Relationship keys with any evidence touching these pages (as endpoint or origin). */
export async function linkRelationshipKeysForPages(exec: Exec, ids: readonly number[]): Promise<RelationshipKey[]> {
  if (!ids.length) return [];
  const rows = await exec.executeRaw<RelationshipKey>(
    `SELECT DISTINCT from_page_id, to_page_id, link_type FROM links
      WHERE (from_page_id = ANY($1::int[]) OR to_page_id = ANY($1::int[]) OR origin_page_id = ANY($1::int[]))
        AND link_type = ANY($2::text[])
     UNION
     SELECT DISTINCT from_page_id, to_page_id, link_type FROM link_transitions
      WHERE from_page_id = ANY($1::int[]) OR to_page_id = ANY($1::int[]) OR origin_page_id = ANY($1::int[])
     UNION
     SELECT from_page_id, to_page_id, link_type FROM link_relationships
      WHERE from_page_id = ANY($1::int[]) OR to_page_id = ANY($1::int[])`,
    [[...ids], temporalLinkTypes()]);
  return keyRows(rows);
}

/** Relationships whose state is missing, older than their newest evidence, or orphaned, oldest first, up to `limit`. */
export async function staleLinkRelationshipKeys(exec: Exec, limit: number): Promise<RelationshipKey[]> {
  const rows = await exec.executeRaw<RelationshipKey>(
    `SELECT from_page_id, to_page_id, link_type FROM (
       SELECT l.from_page_id, l.to_page_id, l.link_type, max(l.created_at) AS newest
         FROM links l WHERE l.link_type = ANY($1::text[]) GROUP BY 1, 2, 3
       UNION ALL
       SELECT lt.from_page_id, lt.to_page_id, lt.link_type, max(lt.created_at)
         FROM link_transitions lt GROUP BY 1, 2, 3
     ) e
     WHERE NOT EXISTS (SELECT 1 FROM link_relationships lr WHERE lr.from_page_id = e.from_page_id
         AND lr.to_page_id = e.to_page_id AND lr.link_type = e.link_type AND lr.scope = 'all' AND lr.refreshed_at >= e.newest)
     GROUP BY from_page_id, to_page_id, link_type
     ORDER BY min(newest), from_page_id, to_page_id, link_type COLLATE "C" LIMIT $2`,
    [temporalLinkTypes(), limit]);
  // Relationships whose evidence-owning page was deleted, restored or edited
  // after the last refresh (soft deletes change no evidence row).
  const originChanged = rows.length >= limit ? [] : await exec.executeRaw<RelationshipKey>(
    `SELECT DISTINCT lr.from_page_id, lr.to_page_id, lr.link_type FROM link_relationships lr
       JOIN links l ON l.from_page_id = lr.from_page_id AND l.to_page_id = lr.to_page_id AND l.link_type = lr.link_type
       JOIN pages o ON o.id = COALESCE(l.origin_page_id, l.from_page_id)
      WHERE lr.scope = 'all' AND GREATEST(o.updated_at, COALESCE(o.deleted_at, o.updated_at)) > lr.refreshed_at
      LIMIT $1`, [limit - rows.length]);
  rows.push(...originChanged.filter(k => !rows.some(r => r.from_page_id === k.from_page_id && r.to_page_id === k.to_page_id && r.link_type === k.link_type)));
  // State rows whose evidence is gone entirely (raw deletes) are refreshed away too.
  const orphans = rows.length >= limit ? [] : await exec.executeRaw<RelationshipKey>(
    `SELECT lr.from_page_id, lr.to_page_id, lr.link_type FROM link_relationships lr
      WHERE lr.scope = 'all'
        AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = lr.from_page_id AND l.to_page_id = lr.to_page_id AND l.link_type = lr.link_type)
        AND NOT EXISTS (SELECT 1 FROM link_transitions t WHERE t.from_page_id = lr.from_page_id AND t.to_page_id = lr.to_page_id AND t.link_type = lr.link_type)
      LIMIT $1`, [limit - rows.length]);
  return keyRows([...rows, ...orphans]);
}

// ---------------------------------------------------------------------------------------------------------------------
// One origin's temporal evidence (link-temporal-apply.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Relationship keys whose evidence this origin page owns (links rows + derived transitions + state rows it starts). */
export async function linkRelationshipKeysForOrigin(exec: Exec, pageId: number): Promise<RelationshipKey[]> {
  const rows = await exec.executeRaw<RelationshipKey>(
    `SELECT from_page_id, to_page_id, link_type FROM links
      WHERE (origin_page_id = $1 OR (origin_page_id IS NULL AND from_page_id = $1)) AND link_type = ANY($2::text[])
     UNION
     SELECT from_page_id, to_page_id, link_type FROM link_transitions WHERE origin_page_id = $1
     UNION
     SELECT from_page_id, to_page_id, link_type FROM link_relationships WHERE from_page_id = $1 AND scope = 'all'`,
    [pageId, temporalLinkTypes()]);
  return keyRows(rows);
}

/** One links row of the origin whose `assertion_tense` is set (`past`) or cleared (null). */
export interface LinkTenseRow {
  from_slug: string; to_slug: string; link_type: string; link_source: string; from_source_id: string; to_source_id: string; tense: 'past' | null;
}

/** One derived dated transition of the origin. */
export interface LinkTransitionRow {
  from_slug: string; to_slug: string; link_type: string; kind: 'start' | 'end'; occurred_on: string;
  date_precision: string; producer: string; line_hash: string;
}

/** What `applyLinkTemporalRows` writes for one origin page. */
export interface LinkTemporalRows {
  pageId: number;
  sourceId: string;
  tenseRows: LinkTenseRow[];
  transitions: LinkTransitionRow[];
  /** Targets of explicit and dream transitions, checked for a live page in the origin's source. */
  explicitTargets: string[];
}

export interface LinkTemporalApplied {
  /** The relationship of each transition inserted. */
  inserted: RelationshipKey[];
  /** The explicit targets that are live pages. */
  liveTargets: string[];
  /** linkRelationshipKeysForOrigin after the write. */
  keysAfter: RelationshipKey[];
}

/**
 * Stamp the origin's tense, replace its derived transitions, check its explicit targets and read its keys after,
 * sent together in this order. The caller refreshes the relationship state. On Postgres the statements are pipelined,
 * which keeps their order only on one connection, so the caller holds a transaction (the engine member opens one).
 */
export async function applyLinkTemporalRows(exec: Exec & Pick<SqlExecutor, 'dialect'>, input: LinkTemporalRows): Promise<LinkTemporalApplied> {
  const { pageId, sourceId, tenseRows, transitions, explicitTargets } = input;
  const tense = tenseRows.length ? () => executeRawJsonb(exec,
      `UPDATE links l SET assertion_tense = v.tense
         FROM jsonb_to_recordset(($2::jsonb)->'rows') AS v(from_slug text, to_slug text, link_type text, link_source text,
           from_source_id text, to_source_id text, tense text)
         JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
         JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
        WHERE l.from_page_id = f.id AND l.to_page_id = t.id AND l.link_type = v.link_type AND l.link_source = v.link_source
          AND (l.origin_page_id = $1 OR (l.origin_page_id IS NULL AND l.from_page_id = $1))
          AND l.assertion_tense IS DISTINCT FROM v.tense`,
      [pageId], [{ rows: tenseRows }]) : async () => undefined;
  const insert = transitions.length ? () => executeRawJsonb<RelationshipKey>(exec,
      `INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, date_precision, producer, origin_page_id, line_hash)
       SELECT $2, f.id, t.id, v.link_type, v.kind, v.occurred_on::date, v.date_precision, v.producer, $1, v.line_hash
         FROM jsonb_to_recordset(($3::jsonb)->'rows') AS v(from_slug text, to_slug text, link_type text, kind text,
           occurred_on text, date_precision text, producer text, line_hash text)
         JOIN pages f ON f.slug = v.from_slug AND f.source_id = $2 AND f.deleted_at IS NULL
         JOIN pages t ON t.slug = v.to_slug AND t.source_id = $2 AND t.deleted_at IS NULL
       ON CONFLICT DO NOTHING
       RETURNING from_page_id, to_page_id, link_type`,
      [pageId, sourceId], [{ rows: transitions }]) : async () => [] as RelationshipKey[];
  const [, , inserted, live, keysAfter] = await pipelined({ kind: exec.dialect }, [
    tense,
    () => exec.executeRaw(`DELETE FROM link_transitions WHERE origin_page_id = $1 AND producer = ANY($2::text[])`, [pageId, DERIVED_TRANSITION_PRODUCERS]),
    insert,
    () => explicitTargets.length ? exec.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`, [sourceId, explicitTargets]) : Promise.resolve([]),
    () => linkRelationshipKeysForOrigin(exec, pageId),
  ]) as [unknown, unknown, RelationshipKey[], Array<{ slug: string }>, RelationshipKey[]];
  return { inserted: keyRows(inserted), liveTargets: live.map(r => r.slug), keysAfter };
}

/** The relationship of a manual (database-only) dated statement. */
export interface ManualLinkRelationship { from: string; to: string; linkType: string; sourceId: string }

/** Insert manual transitions; returns how many were inserted and the relationship key (null when an endpoint is missing). */
export async function writeManualLinkTransitions(exec: Exec, rel: ManualLinkRelationship,
  rows: ReadonlyArray<{ kind: 'start' | 'end'; occurred_on: string }>): Promise<{ inserted: number; key: RelationshipKey | null }> {
  const inserted = await executeRawJsonb<RelationshipKey>(exec,
    `INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
     SELECT $1, f.id, t.id, $4, v.kind, v.occurred_on::date, 'manual', NULL
       FROM jsonb_to_recordset(($5::jsonb)->'rows') AS v(kind text, occurred_on text)
       JOIN pages f ON f.slug = $2 AND f.source_id = $1 AND f.deleted_at IS NULL
       JOIN pages t ON t.slug = $3 AND t.source_id = $1 AND t.deleted_at IS NULL
     ON CONFLICT DO NOTHING
     RETURNING from_page_id, to_page_id, link_type`,
    [rel.sourceId, rel.from, rel.to, rel.linkType], [{ rows }]);
  const [key] = await exec.executeRaw<RelationshipKey>(
    `SELECT f.id AS from_page_id, t.id AS to_page_id, $4::text AS link_type FROM pages f, pages t
      WHERE f.slug = $2 AND f.source_id = $1 AND t.slug = $3 AND t.source_id = $1`, [rel.sourceId, rel.from, rel.to, rel.linkType]);
  return { inserted: inserted.length, key: key ? keyRows([key])[0]! : null };
}

/** Delete manual transitions of a relationship (all types when `linkType` is absent); returns the keys they belonged to. */
export async function removeManualLinkTransitions(exec: Exec,
  rel: { from: string; to: string; linkType?: string; sourceId: string; databaseOnly?: boolean }): Promise<RelationshipKey[]> {
  const keys = await exec.executeRaw<RelationshipKey>(
    `DELETE FROM link_transitions lt USING pages f, pages t
      WHERE f.id = lt.from_page_id AND t.id = lt.to_page_id AND f.slug = $1 AND t.slug = $2
        AND f.source_id = $3 AND t.source_id = $3 AND lt.producer = 'manual'
        AND ($4::text IS NULL OR lt.link_type = $4) AND (NOT $5::boolean OR lt.origin_page_id IS NULL)
      RETURNING lt.from_page_id, lt.to_page_id, lt.link_type`, [rel.from, rel.to, rel.sourceId, rel.linkType ?? null, rel.databaseOnly === true]);
  return keyRows(keys);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads (link-relationship-notes.ts, doctor edge_validity, mentions/referrers.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** One state relation of a note subject, with the temporal columns of TEMPORAL_LINK_SELECT_SQL. */
export interface RelationshipNoteRow {
  from_slug: string; source_id: string; to_slug: string; to_title: string | null; link_type: string;
  last_end: string | null; end_upper_bound: boolean | null; [temporal: string]: unknown;
}

/**
 * The state relations of `subjects` with live targets. `excludePrivate` reads the world-scope state and hides private
 * targets and private-origin links.
 */
export async function listRelationshipNoteRows(exec: Exec, subjects: ReadonlyArray<{ slug: string; source_id: string }>,
  opts: { excludePrivate: boolean }): Promise<RelationshipNoteRow[]> {
  if (!subjects.length) return [];
  const privacy = opts.excludePrivate
    ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('t'))} AND ${trustedSql(privateLinkOriginFilterForCaller('l'))}` : sqlFragment``;
  const endPrivacy = opts.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('xo'))}` : sqlFragment``;
  // The evidence the relationship projection counts for this scope (link-relationships.ts): an origin that is gone or in
  // another source never counts, and a private origin does not count toward the world scope.
  const endBy = (dream: boolean) => sqlFragment`EXISTS (SELECT 1 FROM link_transitions x LEFT JOIN pages xo ON xo.id = x.origin_page_id
        WHERE x.from_page_id = l.from_page_id AND x.to_page_id = l.to_page_id AND x.link_type = l.link_type AND x.kind = 'end'
        AND x.occurred_on = lr_t.last_end AND x.producer ${dream ? trustedSql("= 'dream'") : trustedSql("<> 'dream'")}
        AND (x.origin_page_id IS NULL OR xo.deleted_at IS NULL AND xo.source_id = f.source_id${endPrivacy}))`;
  return rows<RelationshipNoteRow>(exec, sqlFragment`SELECT f.slug AS from_slug, f.source_id, t.slug AS to_slug, t.title AS to_title, l.link_type, lr_t.last_end::text AS last_end,
        (${endBy(true)} AND NOT ${endBy(false)}) AS end_upper_bound${trustedSql(TEMPORAL_LINK_SELECT_SQL)}
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       ${trustedSql(temporalLinkJoinSql('l', opts.excludePrivate))}
      WHERE (f.source_id, f.slug) IN (SELECT s.source_id, s.slug FROM unnest(${subjects.map(s => s.source_id)}::text[], ${subjects.map(s => s.slug)}::text[]) AS s(source_id, slug))
        AND lr_t.semantics = 'state' AND t.deleted_at IS NULL${privacy}`);
}

/** What doctor's edge_validity counts, before the lag and settings it reads itself. */
export interface EdgeValidityCounts {
  byStatus: Array<{ status: string; n: number }>;
  /** Up to `staleLimit` pages that still state a relationship their timeline ended, newest end first. */
  stale: Array<{ slug: string; target: string; link_type: string; ended: string | null }>;
  proposals: { proposed: number; undated: number; applied: number };
}

/** Relationship state by status, stale assertions and contradiction proposals; null when the state tables are absent. */
export async function edgeValidityCounts(exec: Exec, opts: { sourceIds?: readonly string[]; staleLimit: number }): Promise<EdgeValidityCounts | null> {
  const present = !!(await exec.executeRaw<{ lr: string | null }>(`SELECT to_regclass('link_relationships')::text AS lr`))[0]?.lr;
  if (!present) return null;
  const scope = opts.sourceIds?.length ? [...opts.sourceIds] : null;
  const byStatus = await rows<{ status: string; n: number }>(exec,
    sqlFragment`SELECT CASE WHEN semantics = 'event' THEN 'event' WHEN disputed THEN 'disputed' ELSE status_now END AS status, COUNT(*)::int AS n
       FROM link_relationships WHERE scope = 'all' AND (${scope}::text[] IS NULL OR source_id = ANY(${scope}::text[])) GROUP BY 1`);
  const stale = await rows<{ slug: string; target: string; link_type: string; ended: string | null }>(exec,
    sqlFragment`SELECT f.slug, t.slug AS target, lr.link_type, lr.last_end::text AS ended
       FROM link_relationships lr JOIN pages f ON f.id = lr.from_page_id JOIN pages t ON t.id = lr.to_page_id
      WHERE lr.scope = 'all' AND lr.semantics = 'state' AND lr.last_end IS NOT NULL AND lr.undated_present > 0
        AND NOT (lr.valid_ranges @> (now() AT TIME ZONE 'UTC')::date)
        AND (${scope}::text[] IS NULL OR lr.source_id = ANY(${scope}::text[]))
        AND EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = lr.from_page_id AND l.to_page_id = lr.to_page_id
          AND l.link_type = lr.link_type AND COALESCE(l.origin_page_id, l.from_page_id) = lr.from_page_id
          AND COALESCE(l.assertion_tense, 'present') = 'present')
      ORDER BY lr.last_end DESC, lr.from_page_id, lr.to_page_id, lr.link_type COLLATE "C" LIMIT ${Math.trunc(opts.staleLimit)}`);
  const [p] = await rows<{ proposed: number; undated: number; applied: number }>(exec,
    sqlFragment`SELECT COUNT(*) FILTER (WHERE status = 'proposed')::int AS proposed, COUNT(*) FILTER (WHERE status = 'undated_unresolved')::int AS undated,
            COUNT(*) FILTER (WHERE status = 'applied')::int AS applied
       FROM link_edge_proposals WHERE ${scope}::text[] IS NULL OR source_id = ANY(${scope}::text[])`);
  return {
    byStatus: byStatus.map(r => ({ status: r.status, n: Number(r.n) })),
    stale,
    proposals: { proposed: Number(p?.proposed ?? 0), undated: Number(p?.undated ?? 0), applied: Number(p?.applied ?? 0) },
  };
}

/** The raw frontmatter `status` of live pages by `(source_id, slug)`, for pages that have one. */
export async function listPageStatusByRef(exec: Exec, refs: ReadonlyArray<{ source_id: string; slug: string }>,
  scope: { excludePrivate: boolean; includeQuarantined?: boolean }): Promise<Array<{ source_id: string; slug: string; status: unknown }>> {
  if (!refs.length) return [];
  const priv = scope.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('p'))}` : sqlFragment``;
  const quarantine = scope.includeQuarantined ? sqlFragment`` : sqlFragment` AND ${trustedSql(quarantineFilterFragment('p'))}`;
  return rows<{ source_id: string; slug: string; status: unknown }>(exec, sqlFragment`SELECT p.source_id, p.slug, p.frontmatter->'status' AS status
       FROM pages p JOIN unnest(${refs.map(r => r.source_id)}::text[], ${refs.map(r => r.slug)}::text[]) AS u(s, g) ON p.source_id = u.s AND p.slug = u.g
      WHERE p.deleted_at IS NULL AND p.frontmatter ? 'status'${priv}${quarantine}`);
}

/** The raw rows of referring pages' record metadata: frontmatter `status` by id, and their amends / supersedes links. */
export interface RecordMetadataRows {
  status: Array<{ id: number; status: unknown }>;
  links: Array<{ from_id: number; slug: string; link_type: string; since: string | null }>;
}

/**
 * Frontmatter `status` of `pageIds`, and their `amends` and `supersedes` links to visible targets in
 * `referrerSources`, with each amends link's `since` from the relationship state of the caller's scope. A failed link
 * read (an older schema) reads as no links, as on master.
 */
export async function listRecordMetadataRows(exec: Exec, pageIds: readonly number[],
  scope: { referrerSources: readonly string[]; excludePrivate: boolean; includeQuarantined?: boolean }): Promise<RecordMetadataRows> {
  if (!pageIds.length) return { status: [], links: [] };
  const linkPriv = scope.excludePrivate ? sqlFragment` AND ${trustedSql(privateLinkOriginFilterForCaller('l'))}` : sqlFragment``;
  const targetPriv = scope.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('t'))}` : sqlFragment``;
  const targetQuarantine = scope.includeQuarantined ? sqlFragment`` : sqlFragment` AND ${trustedSql(quarantineFilterFragment('t'))}`;
  const [status, links] = await Promise.all([
    exec.executeRaw<{ id: number; status: unknown }>(`SELECT id, frontmatter->'status' AS status FROM pages WHERE id = ANY($1::int[])`, [[...pageIds]]),
    rows<{ from_id: number; slug: string; link_type: string; since: string | null }>(exec,
      sqlFragment`SELECT DISTINCT l.from_page_id AS from_id, t.slug COLLATE "C" AS slug, l.link_type,
              CASE WHEN l.link_type = 'amends' THEN to_char(r.first_start, 'YYYY-MM-DD') END AS since
         FROM links l JOIN pages t ON t.id = l.to_page_id AND t.deleted_at IS NULL AND t.source_id = ANY(${[...scope.referrerSources]}::text[])${targetPriv}${targetQuarantine}
         LEFT JOIN link_relationships r ON r.from_page_id = l.from_page_id AND r.to_page_id = l.to_page_id
              AND r.link_type = l.link_type AND r.scope = ${scope.excludePrivate ? 'world' : 'all'}
        WHERE l.from_page_id = ANY(${[...pageIds]}::int[]) AND l.link_type IN ('amends', 'supersedes')${linkPriv}
        ORDER BY l.from_page_id, t.slug COLLATE "C"`).catch(() => []),
  ]);
  return { status, links };
}

// ---------------------------------------------------------------------------------------------------------------------
// The entity card's referrer groups (mentions/referrers.ts readReferrerGroups)
// ---------------------------------------------------------------------------------------------------------------------

export interface ReferrerGroupScope {
  /** Sources a referring page may live in (the caller's read scope). */
  referrerSources: readonly string[];
  /** Pack type aliases and the canonical type each maps to (mentions/policy.ts typeAliasPairs), index for index. */
  storedTypes: readonly string[];
  canonicalTypes: readonly string[];
  excludePrivate: boolean;
  eligibility?: ReadEligibility;
  includeQuarantined?: boolean;
  /** Rows kept per canonical type. */
  perGroup: number;
}

/** One referring page: its canonical type, its date (`COALESCE(effective_date, updated_at)`, UTC microsecond text) and its group's total. */
export interface ReferrerGroupRow {
  id: number;
  slug: string;
  source_id: string;
  type: string | null;
  canonical_type: string;
  d: string | null;
  gtotal: number;
}

/**
 * The live pages in `referrerSources` that link to a live target page (other than the targets), grouped by canonical
 * type: the newest `perGroup` of each by `(d DESC, source_id, slug)`, groups by canonical type, each row with its
 * group's total. An untrusted read leaves out a hidden target, a link whose origin page is hidden and a hidden
 * referrer; the eligibility and quarantine apply before the cap.
 */
export async function readReferrerGroupRows(exec: Exec, target: { sources: readonly string[]; slugs: readonly string[] },
  scope: ReferrerGroupScope): Promise<ReferrerGroupRow[]> {
  const rows = await exec.executeRaw<ReferrerGroupRow>(referrerGroupsSql(scope),
    [[...target.sources], [...target.slugs], [...scope.referrerSources], [...scope.storedTypes], [...scope.canonicalTypes], scope.perGroup]);
  return rows.map(r => ({ ...r, id: Number(r.id), gtotal: Number(r.gtotal) }));
}

/** One referring page's card details: its bounded body, date source, trust fields, activation flag and frontmatter. */
export interface ReferrerPageDetailRow {
  id: number;
  title: string | null;
  /** The first 4000 characters of the bounded body prefix. */
  body: string | null;
  /** `updated_at` when the page has no effective date, else the effective date's source. */
  date_source: string;
  trust_tier: string;
  write_origin: unknown;
  /** `activationSuppressedSql`: a flagged low-trust write the card marks unconfirmed. */
  flagged: boolean;
  frontmatter: Record<string, unknown> | null;
}

/** The card details of these page ids, one row per id that exists (soft-deleted pages too), in no set order. */
export async function readReferrerPageDetails(exec: Exec, ids: readonly number[]): Promise<ReferrerPageDetailRow[]> {
  const rows = await exec.executeRaw<ReferrerPageDetailRow>(referrerPageDetailsSql(), [[...ids]]);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/**
 * The date `referenced_by` reports for a live page, `COALESCE(effective_date, updated_at)`, as UTC text with
 * microseconds (`YYYY-MM-DDTHH:MM:SS.ffffffZ`), or null for a missing or soft-deleted page (the newer-mentions cutoff).
 */
export async function readPageReferenceDate(exec: Exec, sourceId: string, slug: string): Promise<string | null> {
  const [page] = await exec.executeRaw<{ d: string | null }>(
      `SELECT to_char(COALESCE(effective_date, updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d
         FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`, [sourceId, slug]);
  return page?.d ?? null;
}

/** The batched card counts' scope: the group read's, without the cap, plus the canonical record types to total. */
export type ReferrerTargetCountScope = Omit<ReferrerGroupScope, 'perGroup'> & { recordTypes: readonly string[] };

/** One count: a target index's referrer total (`canonical_type` null) or its total for one record type. */
export interface ReferrerTargetCountRow {
  i: number;
  canonical_type: string | null;
  n: number;
}

/**
 * Per target index (`target.indexes[k]` names the index of `(sources[k], slugs[k])`; an index may hold several pages),
 * the live pages in `referrerSources` that link to one of its live pages, other than its own pages: the total, and
 * the total of each canonical type in `recordTypes` that has any. An index with no referrer has no row. Rows come in
 * no set order. The read scope applies as in `readReferrerGroupRows`.
 */
export async function readReferrerTargetCounts(exec: Exec,
  target: { sources: readonly string[]; slugs: readonly string[]; indexes: readonly number[] },
  scope: ReferrerTargetCountScope): Promise<ReferrerTargetCountRow[]> {
  const rows = await exec.executeRaw<ReferrerTargetCountRow>(referrerTargetCountsSql(scope),
    [[...target.sources], [...target.slugs], [...target.indexes], [...scope.referrerSources], [...scope.storedTypes],
      [...scope.canonicalTypes], [...scope.recordTypes]]);
  return rows.map(r => ({ i: Number(r.i), canonical_type: r.canonical_type ?? null, n: Number(r.n) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The referrer page (get_backlinks group "page", mentions/referrers.ts readReferrerPage) and the card's record rows
// (mentions/referrers.ts readTargetReferences)
// ---------------------------------------------------------------------------------------------------------------------

/** The sources among `sources` that hold a live page with this slug, in no set order (ops/backlinks-paged.ts targetSource). */
export async function listReferrerTargetSources(exec: Exec, slug: string, sources: readonly string[]): Promise<string[]> {
  const rows = await exec.executeRaw<{ source_id: string }>(REFERRER_TARGET_SOURCES_SQL, [slug, [...sources]]);
  return rows.map(r => r.source_id);
}

/** The referrer page's scope: the group read's, without the cap, plus the type filter (a canonical or stored type; null for all). */
export type ReferrerRowScope = Omit<ReferrerGroupScope, 'perGroup'> & { type: string | null };

/** One referring page of a referrer page: its canonical type and its date (UTC microsecond text). */
export type ReferrerRow = Omit<ReferrerGroupRow, 'gtotal'>;

/** The observed-type read's scope: the referrer page's, with no type filter. */
export type ReferrerTypeScope = Omit<ReferrerRowScope, 'type'>;

/** One distinct canonical and stored type pair among the referrers; `type` is the stored type as the driver returns it. */
export interface ReferrerTypeRow { canonical_type: string; type: string | null }

/**
 * The distinct `(canonical_type, type)` pairs among the referring pages `countReferrerRows` counts with no type filter,
 * in no set order: the observed types the unknown-type error names.
 */
export async function readReferrerTypes(exec: Exec, target: { sources: readonly string[]; slugs: readonly string[] },
  scope: ReferrerTypeScope): Promise<ReferrerTypeRow[]> {
  return exec.executeRaw<ReferrerTypeRow>(referrerTypesSql(scope),
    [[...target.sources], [...target.slugs], [...scope.referrerSources], [...scope.storedTypes], [...scope.canonicalTypes]]);
}

/** How many referring pages `readReferrerRows` pages through (every page, no cursor). The read scope applies as in `readReferrerGroupRows`. */
export async function countReferrerRows(exec: Exec, target: { sources: readonly string[]; slugs: readonly string[] },
  scope: ReferrerRowScope): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>(referrerCountSql(scope),
    [[...target.sources], [...target.slugs], [...scope.referrerSources], [...scope.storedTypes], [...scope.canonicalTypes], scope.type]);
  return Number(row?.n ?? 0);
}

/**
 * The referring pages of `readReferrerGroupRows`, of `scope.type` (its canonical or stored type) when set, newest first
 * by `(d DESC, source_id, slug)`, after the cursor `[d, source_id, slug]` when one is given (a null date sorts last), at
 * most `limit` rows.
 */
export async function readReferrerRows(exec: Exec, target: { sources: readonly string[]; slugs: readonly string[] },
  scope: ReferrerRowScope & { cursor: readonly [string | null, string, string] | null; limit: number }): Promise<ReferrerRow[]> {
  const params: unknown[] = [[...target.sources], [...target.slugs], [...scope.referrerSources], [...scope.storedTypes], [...scope.canonicalTypes], scope.type];
  if (scope.cursor) params.push(scope.cursor[0], scope.cursor[1], scope.cursor[2]);
  params.push(scope.limit);
  const rows = await exec.executeRaw<ReferrerRow>(referrerRowsSql(scope, scope.cursor !== null), params);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** The record candidates' scope: the batched counts' scope plus the rows kept per target index. */
export type ReferrerRecordCandidateScope = ReferrerTargetCountScope & { perTarget: number };

/** One record candidate: a target index's referring page of a record type, with its date (UTC microsecond text). */
export interface ReferrerRecordCandidateRow {
  i: number;
  id: number;
  slug: string;
  source_id: string;
  canonical_type: string;
  d: string | null;
}

/**
 * Per target index (as in `readReferrerTargetCounts`), its newest `perTarget` referring pages whose canonical type is
 * one of `recordTypes`, by `(d DESC, source_id, slug)`; rows by index, then that order. The read scope applies as in
 * `readReferrerGroupRows`.
 */
export async function readReferrerRecordCandidates(exec: Exec,
  target: { sources: readonly string[]; slugs: readonly string[]; indexes: readonly number[] },
  scope: ReferrerRecordCandidateScope): Promise<ReferrerRecordCandidateRow[]> {
  const rows = await exec.executeRaw<ReferrerRecordCandidateRow>(referrerRecordCandidatesSql(scope),
    [[...target.sources], [...target.slugs], [...target.indexes], [...scope.referrerSources], [...scope.storedTypes],
      [...scope.canonicalTypes], [...scope.recordTypes], scope.perTarget]);
  return rows.map(r => ({ ...r, i: Number(r.i), id: Number(r.id) }));
}

/** A record page's title and date source (`updated_at` when it has no effective date, else the effective date's source). */
export interface ReferrerRecordPageRow {
  id: number;
  title: string | null;
  date_source: string;
}

/** The record pages of these ids, one row per id that exists (soft-deleted pages too), in no set order. */
export async function readReferrerRecordPages(exec: Exec, ids: readonly number[]): Promise<ReferrerRecordPageRow[]> {
  const rows = await exec.executeRaw<ReferrerRecordPageRow>(REFERRER_RECORD_PAGES_SQL, [[...ids]]);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}
