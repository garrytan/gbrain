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
import {
  buildRelationshipStateWrite, temporalKeys,
  type AssertionRow, type ExistingRow, type RelationshipEvidence, type RelationshipKey, type RelationshipStateWrite, type TransitionRow,
} from '../link-relationships.ts';
import type { SqlExecutor } from './executor.ts';

type Exec = Pick<SqlExecutor, 'executeRaw'>;

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
