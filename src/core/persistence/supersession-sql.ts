/**
 * The supersession rule's SQL text (`supersessionSql`), in a leaf module (only terminal-constants.ts) so the managed sync's
 * statement table (engine-sql/managed-sync-store.ts) can carry the statements that embed it without importing the persistence
 * modules. `terminal-classify.ts` re-exports it; the text is the one it always built.
 */
import { PAGE_REMOVAL_OPERATIONS, CONNECTOR_RETRY_LINEAGE_MAX_DEPTH, CONNECTOR_WRITE_KIND_LIST } from './terminal-constants.ts';

/**
 * The supersession rule of `gbrain repair failed-writes`, as a predicate over a candidate later request `c` of the
 * failed request `r` (both `persistence_requests` aliases): the same intent committed, failed or still pending; a later
 * page removal committed or pending; for a `put_page`, any later write committed or pending, or a later caller
 * `put_page` that failed (the newer content); #6834: for a refused sync checkpoint, any later committed checkpoint of the
 * source (both read by kind; a compacted row, which keeps no kind, by its operation); #6824: for a refused connector
 * write, a later committed connector retry whose recorded `retryOf` lineage reaches it (connectorRetrySql). `r` must
 * expose `id`. Literal strings only; NULL-safe for a compacted `c` (no intent).
 */
export function supersessionSql(r: string, c: string, rKind?: string): string {
  const removals = PAGE_REMOVAL_OPERATIONS.map(op => `'${op}'`).join(',');
  return `(${c}.source_id=${r}.source_id AND ${c}.slug=${r}.slug AND ${c}.sequence>${r}.sequence AND (
    (${c}.digest=${r}.digest AND ${c}.state IN ('committed','failed','queued','running','recovering'))
    OR (${c}.state IN ('committed','queued','running','recovering') AND (${c}.operation IN (${removals}) OR ${r}.operation='put_page'))
    OR (${r}.slug='__managed_sync_checkpoint__' AND ${r}.operation='submit_job' AND ${c}.state='committed' AND ${c}.operation='submit_job'
      AND COALESCE((SELECT k.intent->>'kind' FROM persistence_requests k WHERE k.id=${r}.id),'managed_sync_checkpoint')='managed_sync_checkpoint'
      AND COALESCE(${c}.intent->>'kind','managed_sync_checkpoint')='managed_sync_checkpoint')
    OR (${r}.operation='put_page' AND ${c}.state='failed' AND ${c}.operation='put_page' AND COALESCE(NOT (${c}.intent ? 'kind'), false))
    OR ${connectorRetrySql(r, c, rKind)}))`;
}

const CONNECTOR_WRITE_KINDS = CONNECTOR_WRITE_KIND_LIST.map(kind => `'${kind}'`).join(',');
const UUID_TEXT = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

/**
 * #6824: a connector retry records `retryBase`/`retryOf`/`retryAttempt` in its intent, so its digest never equals the
 * refusal it replaces. A committed retry `c` (read whole as `cc` by its unique sequence) supersedes the refused `r`
 * (read whole as `k` by id; callers may pass narrow row aliases) only when every hop of its
 * recorded `retryOf` chain, back to `r`, has the same principal, source and incarnation, operation, slug and connector
 * intent kind, at a lower sequence, within CONNECTOR_RETRY_LINEAGE_MAX_DEPTH hops. Another refusal of the same item with
 * no recorded link is not proof. Each hop is one lookup on the (principal_kind, principal_id, request_id) unique index.
 */
function connectorRetrySql(r: string, c: string, rKind?: string): string {
  return `(${r}.operation='submit_job' AND ${c}.operation='submit_job' AND ${c}.state='committed'${rKind ? ` AND ${rKind} IN (${CONNECTOR_WRITE_KINDS})` : ''} AND COALESCE(${c}.intent ? 'retryOf', false)
      AND EXISTS (SELECT 1 FROM persistence_requests k, persistence_requests cc WHERE k.id=${r}.id AND cc.sequence=${c}.sequence
        AND k.intent->>'kind' IN (${CONNECTOR_WRITE_KINDS})
        AND cc.intent->>'kind'=k.intent->>'kind' AND cc.principal_kind=k.principal_kind AND cc.principal_id=k.principal_id
        AND cc.source_incarnation=k.source_incarnation
        AND EXISTS (WITH RECURSIVE lineage(request_id, sequence, intent, depth) AS (
            SELECT cc.request_id, cc.sequence, cc.intent, 0
            UNION ALL
            SELECT p.request_id, p.sequence, p.intent, l.depth+1 FROM lineage l JOIN persistence_requests p
              ON p.principal_kind=k.principal_kind AND p.principal_id=k.principal_id
              AND p.request_id=CASE WHEN l.intent->>'retryOf' ~ ${UUID_TEXT} THEN (l.intent->>'retryOf')::uuid END
            WHERE l.depth<${CONNECTOR_RETRY_LINEAGE_MAX_DEPTH} AND p.sequence<l.sequence AND p.source_id=k.source_id
              AND p.source_incarnation=k.source_incarnation AND p.operation=k.operation AND p.slug=k.slug AND p.intent->>'kind'=k.intent->>'kind')
          SELECT 1 FROM lineage WHERE request_id=k.request_id)))`;
}
