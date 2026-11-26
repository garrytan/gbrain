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
import { renderFragment, type SqlFragment } from './fragment.ts';
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
