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
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { temporalLinkTypes } from '../link-validity.ts';
import {
  buildRelationshipStateWrite, temporalKeys,
  type AssertionRow, type ExistingRow, type RelationshipEvidence, type RelationshipKey, type RelationshipStateWrite, type TransitionRow,
} from '../link-relationships.ts';
import { pipelined } from '../page-state/transactions.ts';
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
