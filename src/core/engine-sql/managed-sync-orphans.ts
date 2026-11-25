/**
 * The statements of the managed-sync orphan classification and retirement (persistence/managed-sync-orphans.ts),
 * moved here verbatim so the Rust engine can serve them as typed members. PGLite and Postgres run the same
 * statements as before: the classification reads unscoped through executeRaw; the retirement statements take the
 * engine's own executor, so they run inside the caller's transaction. The Rust engine answers from its store
 * (rust/docs/store/repair-bookkeeping.md, "Managed-sync orphans").
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { CHECKPOINT_MOVED_MESSAGE } from '../persistence/sync-slug-mode.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** One unfinished `managed-sync` cursor of a source's current incarnation, with what its classification reads. */
export interface ManagedSyncCursorRow {
  cursor_key: string; source_id: string; source_incarnation: string; run_id: string | null;
  principal_kind: string | null; principal_id: string | null; has_sync_options: boolean;
  pending_request_id: string | null; pending_state: string | null;
  principal_live: boolean; superseded: boolean; checkpoint_moved: boolean; slug_mode_refused: boolean; updated_at: string;
}
/** One `managed-sync-failure` row: its key, source, recorded incarnation, run and request. */
export interface ManagedSyncFailureRow {
  cursor_key: string; source_id: string; source_incarnation: string; run_id: string | null; request_id: string | null; updated_at: string;
}
/** One `managed-sync-pass` row whose slug-mode obligation was refused, with its newest stamp request and that request's state. */
export interface ManagedSyncPassRow {
  cursor_key: string; source_id: string; source_incarnation: string; run_id: string; request_id: string; state: string; updated_at: string;
}
/** One unfinished `managed-sync` cursor of an incarnation its source no longer has. */
export type ManagedSyncRetiredCursorRow = Pick<ManagedSyncCursorRow, 'cursor_key' | 'source_id' | 'source_incarnation' | 'run_id'
  | 'principal_kind' | 'principal_id' | 'pending_request_id' | 'pending_state' | 'updated_at'>;

/** What `listManagedSyncOrphanRows` returns: the five reads of the classification, each in its own order. */
export interface ManagedSyncOrphanRows {
  cursors: ManagedSyncCursorRow[];
  failures: ManagedSyncFailureRow[];
  passes: ManagedSyncPassRow[];
  retiredCursors: ManagedSyncRetiredCursorRow[];
  retiredFailures: ManagedSyncFailureRow[];
}

/** The retirement's binding of an unfinished cursor or pass row: the previewed key, source, incarnation, run and request. */
export interface ManagedSyncRetireTarget {
  cursorKey: string; sourceId: string; incarnation: string | null; runId: string | null; requestId: string | null;
}
/** How a cursor's retirement re-checks it (persistence/managed-sync-orphans.ts `retireManagedSyncOrphan`). */
export type ManagedSyncRetireMode = 'retired' | 'adoption' | 'checkpoint_moved' | 'slug_mode_refused' | 'orphan';

/**
 * #6834: the cursor `c` (of source `s`) stands at its checkpoint, which ended refused because `last_commit` moved, and the
 * source now records a commit other than the cursor's start and other than where the checkpoint would put it: the
 * target, or, for a path slice short of its target's end (#6349), the start again. A company-brain cursor records its
 * approval and is never one. Shared by the classification and the retirement's re-check, so both read the same rule.
 * `msg` is the moved-checkpoint message, bound as a parameter.
 */
const checkpointMovedSql = (msg: string): SqlFragment => sqlFragment`(c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL
  AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int
  AND s.last_commit IS DISTINCT FROM c.completed_keys->0->>'from'
  AND (c.completed_keys->0->'pending'->'intent'->'slice'->>'done'='false' OR s.last_commit IS DISTINCT FROM c.completed_keys->0->>'target')
  AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='revision_conflict' AND m.error_message=${msg})
  AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint
    AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL)))`;

/**
 * #6712 PR 3: the cursor `c` (of source `s`) stands at its checkpoint, refused `slug_root_mode_mismatch`, and the source
 * still pins a mode other than the run's. Shared by the classification and the retirement's re-check.
 */
const slugModeRefusedSql = `(c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL
  AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int
  AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM c.completed_keys->0->>'slugMode'
  AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch')
  AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint
    AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL)))`;

/**
 * #6694 on the live pass: the pass row `p` (of source `s`) carries the slug-root mode its unstamped run admitted under, the
 * source pins another, the pass's stamp `req` ended refused `slug_root_mode_mismatch`, and nothing that pass admitted is
 * still open. Shared by the classification and the retirement's re-check.
 */
const passSlugModeRefusedSql = (req: SqlFragment): SqlFragment => sqlFragment`(p.completed_keys->0->'obligations'->>'slug_mode' IS NOT NULL
  AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM p.completed_keys->0->'obligations'->>'slug_mode'
  AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=${req} AND m.intent->>'kind'='managed_sync_checkpoint'
    AND m.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch')
  AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id'
    AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL)))`;
/** The newest stamp request of the pass row `p`'s pass. */
const passStampSql = `(SELECT n.request_id FROM persistence_requests n WHERE n.source_id=s.id AND n.intent->>'kind'='managed_sync_checkpoint'
  AND n.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' ORDER BY n.sequence DESC LIMIT 1)`;

/** The five reads of the classification. `sourceIds` narrows to those sources; null reads every active source. */
export async function listManagedSyncOrphanRows(exec: LegacyUnscopedRead, sourceIds: readonly string[] | null): Promise<ManagedSyncOrphanRows> {
  const ids = sourceIds ? [...sourceIds] : null;
  const stamp = sqlFragment`${trustedSql(passStampSql)}`;
  const read = <T>(f: SqlFragment) => { const { text, params } = renderFragment(f); return exec.executeRaw<T>(text, params); };
  const cursors = await read<ManagedSyncCursorRow>(sqlFragment`
    SELECT c.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,c.completed_keys->0->>'runId' AS run_id,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id,
      (c.completed_keys->0 ? 'syncOptions') AS has_sync_options,
      c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state,
      EXISTS(SELECT 1 FROM persistence_local_writers w WHERE w.revoked_at IS NULL
        AND w.id::text=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
        AND c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' IN ('local_cli','local_stdio')) AS principal_live,
      EXISTS(SELECT 1 FROM op_checkpoints n WHERE n.op='managed-sync' AND n.fingerprint<>c.fingerprint
        AND n.completed_keys->0->>'sourceId'=s.id AND n.completed_keys->0->>'incarnation'=s.incarnation::text
        AND COALESCE(n.completed_keys->0->>'done','false')='true' AND n.updated_at>c.updated_at) AS superseded,
      ${checkpointMovedSql(CHECKPOINT_MOVED_MESSAGE)} AS checkpoint_moved,
      ${trustedSql(slugModeRefusedSql)} AS slug_mode_refused,
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false)
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.source_incarnation=s.incarnation
      AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
      AND r.principal_id=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
      AND r.principal_kind=c.completed_keys->0->'authority'->'writer'->'principal'->>'kind'
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND (${ids}::text[] IS NULL OR s.id=ANY(${ids}::text[]))
    ORDER BY s.id COLLATE "C",c.updated_at,c.fingerprint COLLATE "C"`);
  const failures = await read<ManagedSyncFailureRow>(sqlFragment`
    SELECT f.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id,
      f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text=f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false)
    WHERE f.op='managed-sync-failure' AND (${ids}::text[] IS NULL OR s.id=ANY(${ids}::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op IN ('managed-sync','managed-sync-pass') AND c.fingerprint=f.fingerprint)
    ORDER BY s.id COLLATE "C",f.fingerprint COLLATE "C"`);
  const passes = await read<ManagedSyncPassRow>(sqlFragment`
    SELECT p.fingerprint AS cursor_key,s.id AS source_id,s.incarnation::text AS source_incarnation,p.completed_keys->0->'telemetry'->>'pass_id' AS run_id,
      ${trustedSql(passStampSql)}::text AS request_id,(SELECT m.state FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=${trustedSql(passStampSql)}) AS state,
      to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints p
    JOIN sources s ON p.fingerprint=s.id||':'||s.incarnation::text AND NOT COALESCE(s.archived,false)
    WHERE p.op='managed-sync-pass' AND (${ids}::text[] IS NULL OR s.id=ANY(${ids}::text[])) AND ${passSlugModeRefusedSql(stamp)}
    ORDER BY s.id COLLATE "C"`);
  // #6518: rows keyed under an incarnation the source no longer has. The join is on the source id alone; the live
  // pending-request guard stays, the live-writer guard does not apply (no current key can select these rows).
  const retiredCursors = await read<ManagedSyncRetiredCursorRow>(sqlFragment`
    SELECT c.fingerprint AS cursor_key,s.id AS source_id,c.completed_keys->0->>'incarnation' AS source_incarnation,c.completed_keys->0->>'runId' AS run_id,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' AS principal_kind,
      c.completed_keys->0->'authority'->'writer'->'principal'->>'id' AS principal_id,
      c.completed_keys->0->'pending'->>'requestId' AS pending_request_id,r.state AS pending_state,
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints c
    JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text<>c.completed_keys->0->>'incarnation' AND NOT COALESCE(s.archived,false)
    LEFT JOIN persistence_requests r ON r.source_id=s.id AND r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND (${ids}::text[] IS NULL OR s.id=ANY(${ids}::text[]))
    ORDER BY s.id COLLATE "C",c.updated_at,c.fingerprint COLLATE "C"`);
  // A retired failure row rides with its unfinished cursor when one exists under its key (the cursor's retirement deletes it).
  const retiredFailures = await read<ManagedSyncFailureRow>(sqlFragment`
    SELECT f.fingerprint AS cursor_key,s.id AS source_id,f.completed_keys->0->>'source_incarnation' AS source_incarnation,f.completed_keys->0->>'run_id' AS run_id,
      f.completed_keys->0->>'request_id' AS request_id,to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
    FROM op_checkpoints f
    JOIN sources s ON s.id=f.completed_keys->0->>'source_id' AND s.incarnation::text<>f.completed_keys->0->>'source_incarnation' AND NOT COALESCE(s.archived,false)
    WHERE f.op='managed-sync-failure' AND (${ids}::text[] IS NULL OR s.id=ANY(${ids}::text[]))
      AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint AND COALESCE(c.completed_keys->0->>'done','false')<>'true')
    ORDER BY s.id COLLATE "C",f.fingerprint COLLATE "C"`);
  return { cursors, failures, passes, retiredCursors, retiredFailures };
}

/** The ids of the archived sources, in no stated order. */
export async function listArchivedSourceIds(exec: LegacyUnscopedRead): Promise<string[]> {
  return (await exec.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived = true')).map(row => row.id);
}

/** Which of `keys` have a durable `managed-sync-failure` row, in no stated order. */
export async function listManagedSyncFailureKeys(exec: LegacyUnscopedRead, keys: readonly string[]): Promise<string[]> {
  return (await exec.executeRaw<{ fingerprint: string }>("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=ANY($1::text[])",
    [[...keys]])).map(row => row.fingerprint);
}

/** The retirement transaction's settings: its commit waits for the flush, and a lock wait gives up after two seconds. */
export async function applyManagedSyncRetireLimits(exec: SqlExecutor): Promise<void> {
  await exec.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','2000ms',true)");
}

/**
 * Removes the `slug_mode` obligation of the previewed pass row while `passSlugModeRefusedSql` still holds for its stamp
 * and no pass holds the source's drain lease (its row locked first, so a pass that takes the lease next reads the
 * retired row). False when the lease is live or the row no longer qualifies; nothing changed then.
 */
export async function retireManagedSyncPassSlugMode(exec: SqlExecutor, target: ManagedSyncRetireTarget, lockId: string): Promise<boolean> {
  const lease = await exec.executeRaw<{ live: boolean }>('SELECT ttl_expires_at > now() AS live FROM gbrain_cycle_locks WHERE id=$1 FOR UPDATE', [lockId]);
  if (lease[0]?.live) return false;
  const { text, params } = renderFragment(sqlFragment`UPDATE op_checkpoints p SET completed_keys=jsonb_set(p.completed_keys,'{0,obligations}',(p.completed_keys->0->'obligations')-'slug_mode'),updated_at=now()
    FROM sources s WHERE p.op='managed-sync-pass' AND p.fingerprint=${target.cursorKey} AND s.id=${target.sourceId} AND s.incarnation::text=${target.incarnation} AND NOT COALESCE(s.archived,false)
      AND p.completed_keys->0->'telemetry'->>'pass_id' IS NOT DISTINCT FROM ${target.runId}::text AND ${passSlugModeRefusedSql(sqlFragment`${target.requestId}::uuid`)}
      AND ${trustedSql(passStampSql)}=${target.requestId}::uuid RETURNING p.fingerprint`);
  return (await exec.executeRaw(text, params)).length > 0;
}

/**
 * Deletes the unfinished cursor when its pending request is not live and `mode`'s re-check still holds; returns the
 * deleted cursor's pending intent (null inside when it had none), or null when the cursor was kept.
 */
export async function retireManagedSyncCursor(exec: SqlExecutor, target: ManagedSyncRetireTarget, mode: ManagedSyncRetireMode): Promise<{ intent: unknown } | null> {
  const { cursorKey: key, sourceId: sid, incarnation: inc, runId, requestId } = target;
  const { text, params } = renderFragment(sqlFragment`
    DELETE FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=${key}
      AND COALESCE(c.completed_keys->0->>'done','false')<>'true'
      AND c.completed_keys->0->>'sourceId'=${sid} AND c.completed_keys->0->>'incarnation'=${inc}
      AND NOT EXISTS(SELECT 1 FROM persistence_requests r WHERE r.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
        AND r.source_id=${sid} AND r.state NOT IN ('committed','failed','conflict','cancelled'))
      AND (${mode}::text='retired' AND EXISTS(SELECT 1 FROM sources s WHERE s.id=${sid} AND NOT COALESCE(s.archived,false) AND s.incarnation::text<>${inc})
        OR ${mode}::text='adoption' AND NOT EXISTS(SELECT 1 FROM persistence_requests r WHERE r.source_id=${sid} AND r.intent->>'cursorKey'=${key}
          AND (r.state IN ('queued','running','recovering') OR r.recovery IS NOT NULL))
        OR ${mode}::text='checkpoint_moved' AND c.completed_keys->0->>'runId' IS NOT DISTINCT FROM ${runId}::text
          AND c.completed_keys->0->'pending'->>'requestId' IS NOT DISTINCT FROM ${requestId}::text
          AND EXISTS(SELECT 1 FROM sources s WHERE s.id=${sid} AND s.incarnation::text=${inc} AND NOT COALESCE(s.archived,false) AND ${checkpointMovedSql(CHECKPOINT_MOVED_MESSAGE)})
        OR ${mode}::text='slug_mode_refused' AND c.completed_keys->0->>'runId' IS NOT DISTINCT FROM ${runId}::text
          AND c.completed_keys->0->'pending'->>'requestId' IS NOT DISTINCT FROM ${requestId}::text
          AND EXISTS(SELECT 1 FROM sources s WHERE s.id=${sid} AND s.incarnation::text=${inc} AND NOT COALESCE(s.archived,false) AND ${trustedSql(slugModeRefusedSql)})
        OR ${mode}::text='orphan' AND NOT EXISTS(SELECT 1 FROM persistence_local_writers w WHERE w.revoked_at IS NULL
          AND w.id::text=c.completed_keys->0->'authority'->'writer'->'principal'->>'id'
          AND c.completed_keys->0->'authority'->'writer'->'principal'->>'kind' IN ('local_cli','local_stdio')
          AND (c.completed_keys->0 ? 'syncOptions')))
    RETURNING fingerprint,c.completed_keys->0->'pending'->'intent' AS intent`);
  const rows = await exec.executeRaw<{ intent: unknown }>(text, params);
  return rows.length > 0 ? { intent: rows[0]!.intent ?? null } : null;
}

/**
 * Deletes the `managed-sync-failure` row under `key` while no `managed-sync` cursor shares the key. With `retired`
 * (an `incarnation_retired` failure row) only an unfinished cursor keeps it, and its source must still be active under
 * another incarnation.
 */
export async function deleteManagedSyncFailureRow(exec: SqlExecutor, key: string, retired: boolean): Promise<boolean> {
  return (await exec.executeRaw(`DELETE FROM op_checkpoints f WHERE f.op='managed-sync-failure' AND f.fingerprint=$1
    AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=$1
      AND ($2::boolean IS DISTINCT FROM true OR COALESCE(c.completed_keys->0->>'done','false')<>'true'))
    AND ($2::boolean IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM sources s WHERE s.id=f.completed_keys->0->>'source_id'
      AND NOT COALESCE(s.archived,false) AND s.incarnation::text<>f.completed_keys->0->>'source_incarnation'))
    RETURNING fingerprint`, [key, retired])).length > 0;
}

/** One recorded `managed-sync-failure` row of a source: its key, its record, and whether an unfinished cursor shares the key. */
export interface SourceManagedSyncFailure<F = Record<string, unknown>> { key: string; failure: F; unfinished: boolean }

/** The source's recorded `managed-sync-failure` rows (any incarnation), by byte key (persistence/sync-failures.ts). */
export function listSourceManagedSyncFailures<F = Record<string, unknown>>(exec: LegacyUnscopedRead, sourceId: string): Promise<Array<SourceManagedSyncFailure<F>>> {
  return exec.executeRaw<SourceManagedSyncFailure<F>>(`SELECT f.fingerprint AS key,f.completed_keys->0 AS failure,
      EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.fingerprint=f.fingerprint AND COALESCE(c.completed_keys->0->>'done','false')<>'true') AS unfinished
    FROM op_checkpoints f WHERE f.op='managed-sync-failure' AND f.completed_keys->0->>'source_id'=$1 ORDER BY f.fingerprint COLLATE "C"`, [sourceId]);
}

/** Deletes the `managed-sync-failure` row under `key` while it still records `observationId`; false when it is gone or records another. */
export async function deleteManagedSyncFailureObservation(exec: SqlExecutor, key: string, observationId: string): Promise<boolean> {
  return (await exec.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1
    AND completed_keys->0->>'observation_id'=$2 RETURNING fingerprint`, [key, observationId])).length > 0;
}

/** Deletes the run's `managed-sync-manifest` row while no `managed-sync` cursor names the run. */
export async function deleteManagedSyncManifest(exec: SqlExecutor, runId: string): Promise<boolean> {
  return (await exec.executeRaw(`DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1
    AND NOT EXISTS(SELECT 1 FROM op_checkpoints c WHERE c.op='managed-sync' AND c.completed_keys->0->>'runId'=$1) RETURNING fingerprint`, [runId])).length > 0;
}
