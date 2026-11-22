/**
 * The bookkeeping reads and writes of five repair kinds (orphan-bindings, loop-facts, connector-checkpoints), moved
 * here verbatim from persistence/orphan-bindings.ts, persistence/loop-fact-retirement.ts and
 * persistence/connector-checkpoint-migration.ts so the Rust engine can serve them as typed members. PGLite and
 * Postgres run the same statements as before, unscoped through executeRaw; writes and locked reads
 * take the engine's own executor, so they run inside the caller's transaction. The Rust engine answers from its store (rust/docs/store/repair-bookkeeping.md).
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { CONNECTOR_SOURCE_KINDS } from '../persistence/connector-kinds.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/**
 * Persistence source bindings whose source or source incarnation no longer exists (#5732). `pending_requests` counts
 * the non-terminal requests of the binding's incarnation; the repair keeps a binding one still references.
 */
export interface OrphanBinding {
  source_id: string;
  source_incarnation: string;
  worktree_id: string;
  reason: 'source_removed' | 'incarnation_replaced';
  pending_requests: number;
}

const ORPHANS = `SELECT b.source_id, b.source_incarnation::text AS source_incarnation, b.worktree_id::text AS worktree_id,
    CASE WHEN s.id IS NULL THEN 'source_removed' ELSE 'incarnation_replaced' END AS reason,
    (SELECT COUNT(*)::int FROM persistence_requests r
      WHERE r.source_id = b.source_id AND r.source_incarnation = b.source_incarnation
        AND r.state IN ('queued','deferred','running','recovering')) AS pending_requests
  FROM persistence_source_bindings b
  LEFT JOIN sources s ON s.id = b.source_id
  WHERE s.id IS NULL OR s.incarnation <> b.source_incarnation`;

/** Every orphan binding, brain-wide, by source id; at most `limit` when given. */
export function listOrphanBindings(exec: LegacyUnscopedRead, opts: { limit?: number } = {}): Promise<OrphanBinding[]> {
  const limit = opts.limit ? sqlFragment` LIMIT ${Math.floor(opts.limit)}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`${trustedSql(ORPHANS)} ORDER BY b.source_id COLLATE "C"${limit}`);
  return exec.executeRaw<OrphanBinding>(text, params);
}

/** Deletes one orphan binding, rechecking in the same statement that it is still orphaned and has no pending request. */
export async function deleteOrphanBinding(exec: SqlExecutor, binding: Pick<OrphanBinding, 'source_id' | 'source_incarnation'>): Promise<boolean> {
  const rows = await exec.executeRaw(
    `DELETE FROM persistence_source_bindings b
      WHERE b.source_id = $1 AND b.source_incarnation = $2::uuid
        AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = b.source_id AND s.incarnation = b.source_incarnation)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE r.source_id = b.source_id
          AND r.source_incarnation = b.source_incarnation AND r.state IN ('queued','deferred','running','recovering'))
      RETURNING b.source_id`,
    [binding.source_id, binding.source_incarnation],
  );
  return rows.length > 0;
}

/** A loop, its commitment fact and whether another open loop references that fact (`readLoopFactState`). */
export interface LoopFactState {
  loop: { id: number; source_id: string; status: string; fact_id: number | null } | null;
  fact: { id: number; source_id: string; expired_at: string | null; row_num: number | null; source_markdown_slug: string | null; fact: string } | null;
  shared: boolean;
}

/**
 * The loop, its fact and whether another open loop references that fact. `lock` locks the loop and fact rows
 * `FOR UPDATE` for the caller's publication transaction. `expired_at` is ISO 8601 UTC.
 */
export async function readLoopFactState(exec: SqlExecutor, loopId: number, opts: { lock?: boolean } = {}): Promise<LoopFactState> {
  const suffix = opts.lock ? ' FOR UPDATE' : '';
  const loopRead = renderFragment(sqlFragment`SELECT id, source_id, status, fact_id FROM open_loops WHERE id=${loopId}${trustedSql(suffix)}`);
  const [loop] = await exec.executeRaw<{ id: number; source_id: string; status: string; fact_id: number | null }>(loopRead.text, loopRead.params);
  if (!loop || loop.fact_id === null) return { loop: loop ? { ...loop, id: Number(loop.id), fact_id: null } : null, fact: null, shared: false };
  const factRead = renderFragment(sqlFragment`SELECT id, source_id, expired_at, row_num, source_markdown_slug, fact FROM facts WHERE id=${loop.fact_id}${trustedSql(suffix)}`);
  const [fact] = await exec.executeRaw<{ id: number; source_id: string; expired_at: string | null; row_num: number | null; source_markdown_slug: string | null; fact: string }>(
    factRead.text, factRead.params);
  const others = await exec.executeRaw(`SELECT 1 FROM open_loops WHERE fact_id=$1 AND id<>$2 AND status='open' LIMIT 1`, [loop.fact_id, loop.id]);
  return {
    loop: { ...loop, id: Number(loop.id), fact_id: Number(loop.fact_id) },
    fact: fact ? { ...fact, id: Number(fact.id), row_num: fact.row_num === null ? null : Number(fact.row_num),
      expired_at: fact.expired_at === null ? null : new Date(fact.expired_at).toISOString() } : null,
    shared: others.length > 0,
  };
}

/** Expires an active fact of `sourceId` now, its `valid_until` clipped to now; false when no active fact matched. */
export async function expireSourceFactNow(exec: SqlExecutor, factId: number, sourceId: string): Promise<boolean> {
  const rows = await exec.executeRaw(`UPDATE facts SET expired_at=now(), valid_until=LEAST(COALESCE(valid_until, now()), now())
      WHERE id=$1 AND source_id=$2 AND expired_at IS NULL RETURNING id`, [factId, sourceId]);
  return rows.length === 1;
}

/** One connector source as the checkpoint cleanup reads it (`listConnectorSources`). */
export interface ConnectorSourceRow { id: string; incarnation: string; local_path: string | null; config: Record<string, unknown> | string | null; archived: boolean }

/**
 * Every source whose `config.kind` is a connector kind, archived ones included. `lock` share-locks them in id order
 * for the caller's transaction, so a config change cannot make a key current while orphans are deleted.
 */
export async function listConnectorSources(exec: SqlExecutor, opts: { lock?: boolean } = {}): Promise<ConnectorSourceRow[]> {
  const kinds = [...CONNECTOR_SOURCE_KINDS];
  if (opts.lock) {
    const lock = renderFragment(sqlFragment`SELECT id FROM sources WHERE config->>'kind' = ANY(${kinds}::text[]) ORDER BY id FOR SHARE`);
    await exec.executeRaw(lock.text, lock.params);
  }
  const { text, params } = renderFragment(sqlFragment`SELECT id,incarnation::text,local_path,config,archived FROM sources WHERE config->>'kind' = ANY(${kinds}::text[])`);
  return exec.executeRaw<ConnectorSourceRow>(text, params);
}

/** A `managed-connector` checkpoint or retry pointer no source loads; `updated_at` is Postgres timestamptz text. */
export interface OrphanCheckpointRow { op: 'managed-connector' | 'managed-connector-retry'; fingerprint: string; updated_at: string }

/** The bounds of an orphan scan or delete: `before` bounds `updated_at`, `minAgeDays` adds the age floor, `stateOp` names the pending sets. */
export interface OrphanCheckpointBounds { before?: string | null; minAgeDays?: number | null; stateOp: string }

/** The orphan test for op_checkpoints row `c`; binds loadable keys, before, min age days and the state op. */
const orphanPredicate = (loadable: readonly string[], bounds: OrphanCheckpointBounds): SqlFragment => {
  const [keys, before, days] = [[...loadable], bounds.before ?? null, bounds.minAgeDays ?? null];
  return sqlFragment`(
      ((c.op='managed-connector' AND NOT (c.fingerprint = ANY(${keys}::text[])))
        OR (c.op='managed-connector-retry' AND NOT (COALESCE(c.completed_keys->0->>'checkpointKey','') = ANY(${keys}::text[]))))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests r
        WHERE (r.state IN ('queued','deferred','running','recovering') OR r.recovery IS NOT NULL)
          AND (r.intent->>'kind' LIKE 'connector\\_v2\\_%' OR r.intent->>'kind' LIKE 'managed\\_connector\\_%')
          AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey'
            OR r.request_id::text = c.completed_keys->0->>'requestId'))
      AND NOT EXISTS (SELECT 1 FROM op_checkpoints s
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.completed_keys->0->'pending','[]'::jsonb)) p
        JOIN persistence_requests r ON r.request_id::text = p->>'requestId'
        WHERE s.op=${bounds.stateOp} AND (r.intent->>'checkpointKey' = c.fingerprint OR r.intent->>'checkpointKey' = c.completed_keys->0->>'checkpointKey'
          OR r.request_id::text = c.completed_keys->0->>'requestId'))
      AND (${before}::text IS NULL OR c.updated_at <= ${before}::text::timestamptz)
      AND (${days}::integer IS NULL OR c.updated_at < now() - make_interval(days => ${days}::integer)))`;
};

/** Checkpoint and retry rows whose key is not in `loadable` and that nothing pending references, by op then fingerprint. */
export function listOrphanConnectorCheckpoints(exec: LegacyUnscopedRead, loadable: readonly string[], bounds: OrphanCheckpointBounds,
  limit: number): Promise<OrphanCheckpointRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT c.op, c.fingerprint, c.updated_at::text AS updated_at FROM op_checkpoints c
    WHERE c.op IN ('managed-connector','managed-connector-retry') AND ${orphanPredicate(loadable, bounds)}
    ORDER BY c.op COLLATE "C", c.fingerprint COLLATE "C" LIMIT ${limit}`);
  return exec.executeRaw<OrphanCheckpointRow>(text, params);
}

/** How many checkpoint and retry rows carry one of `aliases` (#6561 alias keys) as their key. */
export async function countConnectorCheckpointsKeyed(exec: LegacyUnscopedRead, aliases: readonly string[]): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM op_checkpoints c
    WHERE (c.op='managed-connector' AND c.fingerprint = ANY($1::text[]))
       OR (c.op='managed-connector-retry' AND c.completed_keys->0->>'checkpointKey' = ANY($1::text[]))`, [[...aliases]]);
  return Number(row?.n ?? 0);
}

/** Deletes one planned orphan, re-applying the whole orphan predicate and its stamp in the same statement. */
export async function deleteOrphanConnectorCheckpoint(exec: SqlExecutor, row: OrphanCheckpointRow, loadable: readonly string[],
  bounds: OrphanCheckpointBounds): Promise<boolean> {
  const { text, params } = renderFragment(sqlFragment`DELETE FROM op_checkpoints c WHERE c.op=${row.op} AND c.fingerprint=${row.fingerprint} AND c.updated_at=${row.updated_at}::text::timestamptz
        AND ${orphanPredicate(loadable, bounds)} RETURNING c.op`);
  const deleted = await exec.executeRaw<{ op: string }>(text, params);
  return deleted.length > 0;
}
