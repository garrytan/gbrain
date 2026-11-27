/**
 * Managed-sync orphans (#5459): durable sync bookkeeping nothing current can
 * resume, clear or retire, which doctor reports as an unresolved failure forever.
 *
 * Four shapes:
 *
 * - `failure_row`: a `managed-sync-failure` row whose cursor key has no
 *   `managed-sync` cursor at all. `clearManagedSyncFailureAfterSuccess` clears a
 *   failure only on a success under the same key, and live runs succeed under a
 *   different key, so the row never clears.
 * - `unfinished_cursor`: a `managed-sync` cursor that is not `done` and that the
 *   live writer cannot resume: its recorded principal is not an active local
 *   writer ([R19]: the join is on the principal the cursor recorded, never on
 *   the current one), or it predates recorded sync options and a newer cursor
 *   for the same source and incarnation has since completed. A cursor whose
 *   pending request is still queued, running or recovering is never an orphan.
 * - `incarnation_retired` (#6518): an unfinished cursor, or a failure row, whose
 *   recorded source incarnation is no longer the source's (the source was
 *   re-pointed at a new checkout, or removed and added again). The cursor key
 *   digests the incarnation, so no current run selects it, and every
 *   incarnation-joined reader (`readManagedSyncFailures`, the two passes above,
 *   the clear paths) drops it; only the local ledger mirror still shows it.
 *   Archived sources are excluded; a live pending request still retains it.
 * - `checkpoint_moved` (#6834): an unfinished cursor whose every page committed and whose checkpoint was refused
 *   because `sources.last_commit` moved to a commit that is neither the cursor's start nor its target (another run,
 *   or an older binary, checkpointed the source elsewhere). The checkpoint can never publish and no resume clears it;
 *   retiring the cursor lets the next sync discover from the commit the source now records. A cursor whose source
 *   already stands at its target is not one: the next sync finishes it (sync-slug-mode.ts `checkpointMovedToTarget`).
 * - `slug_mode_refused` (#6712 PR 3): an unfinished cursor whose every page committed and whose checkpoint was refused
 *   `slug_root_mode_mismatch` while the source still pins the other mode. Which mode the source keeps is a person's
 *   decision, so no sync rediscovers it by itself; retiring the cursor is how they keep the pin: the next sync discovers
 *   the source again under it. Setting the pin back instead lets the next sync retry the checkpoint by itself.
 *   On the live pass (#6712 PR 4b) the unfinished run is the pass row's `obligations.slug_mode`: the same orphan, keyed by
 *   the pass row's fingerprint, whose newest stamp was refused that way; retiring it removes that obligation.
 * - `mirror_only` (#6518): a row of the local compatibility ledger
 *   (`~/.gbrain/sync-failures.jsonl`) carrying a `managed_cursor_key` with no
 *   durable `managed-sync-failure` row under that key in any incarnation. The
 *   mirror is only ever pruned after a durable delete, so one whose durable row
 *   is already gone keeps `doctor --fast` warning forever.
 *
 * `classifyManagedSyncOrphans` is read-only (doctor consumes it); a failed
 * durable read throws instead of returning an empty list, so an unreachable
 * database never reads as "no orphans". `retireManagedSyncOrphan` deletes one
 * orphan's rows atomically with every predicate re-checked, so a cursor the
 * writer picked up meanwhile is kept and a mirror whose durable row appeared
 * since the preview is kept.
 */
import type { BrainEngine } from '../engine.ts';
import { clearManagedSyncFailure, loadSyncFailures } from '../sync-failure-ledger.ts';
import type { ManagedSyncRetireMode } from '../engine-sql/managed-sync-orphans.ts';
import { clearSyncSlice } from './sync-slices.ts';
import { syncLockId } from '../db-lock.ts';
import type { SyncCursorOptions } from './sync-prepare.ts';

/** `superseded_by_adoption` (#6712 PR 1): an unfinished cursor of the incarnation that the drain's fan-in did not adopt (sync-cursor-key.ts). */
export type ManagedSyncOrphanReason = 'no_cursor' | 'principal_unadoptable' | 'superseded' | 'incarnation_retired' | 'mirror_only' | 'superseded_by_adoption' | 'checkpoint_moved' | 'slug_mode_refused';
export type ManagedSyncOrphanRetained = 'pending_request_live' | 'resumable';

export interface ManagedSyncOrphan {
  kind: 'failure_row' | 'unfinished_cursor' | 'mirror_row';
  cursor_key: string;
  source_id: string;
  /** The incarnation the row recorded; null for a ledger mirror row, which records none. */
  source_incarnation: string | null;
  run_id: string | null;
  /** The principal the cursor recorded (null for a failure row without one). */
  principal: { kind: string; id: string } | null;
  pending_request_id: string | null;
  pending_state: string | null;
  reason: ManagedSyncOrphanReason;
  updated_at: string;
}

export interface ManagedSyncOrphanClassification {
  orphans: ManagedSyncOrphan[];
  /** Unfinished cursors kept with why: a live pending request, or a cursor the live writer can still resume. */
  retained: Array<{ cursor_key: string; source_id: string; why: ManagedSyncOrphanRetained }>;
}

/** The reads the classification takes from the engine. */
type OrphanReads = Pick<BrainEngine, 'listManagedSyncOrphanRows' | 'listArchivedSourceIds' | 'listManagedSyncFailureKeys'>;

const TERMINAL = ['committed', 'failed', 'conflict', 'cancelled'];

// The statements this module runs, and the rules they share, live in engine-sql/managed-sync-orphans.ts.

/** Read-only. `sourceIds` narrows to those sources; null reads every active source. */
export async function classifyManagedSyncOrphans(engine: OrphanReads, sourceIds: string[] | null = null): Promise<ManagedSyncOrphanClassification> {
  const { cursors, failures, passes, retiredCursors, retiredFailures } = await engine.listManagedSyncOrphanRows(sourceIds);
  const orphans: ManagedSyncOrphan[] = [];
  const retained: ManagedSyncOrphanClassification['retained'] = [];
  for (const row of cursors) {
    const principal = row.principal_kind && row.principal_id ? { kind: row.principal_kind, id: row.principal_id } : null;
    if (row.pending_request_id && row.pending_state && !TERMINAL.includes(row.pending_state)) { retained.push({ cursor_key: row.cursor_key, source_id: row.source_id, why: 'pending_request_live' }); continue; }
    const reason: ManagedSyncOrphanReason | null = !row.principal_live ? 'principal_unadoptable' : !row.has_sync_options && row.superseded ? 'superseded'
      : row.checkpoint_moved ? 'checkpoint_moved' : row.slug_mode_refused ? 'slug_mode_refused' : null;
    if (!reason) { retained.push({ cursor_key: row.cursor_key, source_id: row.source_id, why: 'resumable' }); continue; }
    orphans.push({ kind: 'unfinished_cursor', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: row.source_incarnation, run_id: row.run_id,
      principal, pending_request_id: row.pending_request_id, pending_state: row.pending_state, reason, updated_at: row.updated_at });
  }
  for (const row of failures) {
    orphans.push({ kind: 'failure_row', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: row.source_incarnation, run_id: row.run_id,
      principal: null, pending_request_id: row.request_id, pending_state: null, reason: 'no_cursor', updated_at: row.updated_at });
  }
  for (const row of passes) {
    orphans.push({ kind: 'unfinished_cursor', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: row.source_incarnation, run_id: row.run_id,
      principal: null, pending_request_id: row.request_id, pending_state: row.state, reason: 'slug_mode_refused', updated_at: row.updated_at });
  }
  // #6518: rows keyed under an incarnation the source no longer has: the live pending-request guard stays, the
  // live-writer guard does not apply (no current key can select these rows).
  for (const row of retiredCursors) {
    if (row.pending_request_id && row.pending_state && !TERMINAL.includes(row.pending_state)) { retained.push({ cursor_key: row.cursor_key, source_id: row.source_id, why: 'pending_request_live' }); continue; }
    orphans.push({ kind: 'unfinished_cursor', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: row.source_incarnation, run_id: row.run_id,
      principal: row.principal_kind && row.principal_id ? { kind: row.principal_kind, id: row.principal_id } : null, pending_request_id: row.pending_request_id, pending_state: row.pending_state,
      reason: 'incarnation_retired', updated_at: row.updated_at });
  }
  // A retired failure row rides with its unfinished cursor when one exists under its key (the cursor's retirement deletes it).
  for (const row of retiredFailures) {
    orphans.push({ kind: 'failure_row', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: row.source_incarnation, run_id: row.run_id,
      principal: null, pending_request_id: row.request_id, pending_state: null, reason: 'incarnation_retired', updated_at: row.updated_at });
  }
  for (const row of await mirrorOnlyManagedFailures(engine, sourceIds)) {
    orphans.push({ kind: 'mirror_row', cursor_key: row.cursor_key, source_id: row.source_id, source_incarnation: null, run_id: row.run_id, principal: null,
      pending_request_id: row.request_id, pending_state: null, reason: 'mirror_only', updated_at: row.updated_at });
  }
  return { orphans, retained };
}

/**
 * #6518: local ledger rows carrying a `managed_cursor_key` with no durable `managed-sync-failure` row under that key
 * (any incarnation), on active sources. The durable read is the authority: when it fails, this throws rather than
 * naming every mirror as prunable. A ledger that cannot be read names nothing.
 */
export async function mirrorOnlyManagedFailures(engine: OrphanReads, sourceIds: string[] | null = null): Promise<Array<{ cursor_key: string; source_id: string; run_id: string | null; request_id: string | null; updated_at: string }>> {
  let rows: ReturnType<typeof loadSyncFailures> = [];
  try { rows = loadSyncFailures(); } catch { return []; }
  const mirrors = rows.filter(row => row.managed_cursor_key && (!sourceIds || sourceIds.includes(row.source_id)));
  if (!mirrors.length) return [];
  const archived = new Set(await engine.listArchivedSourceIds());
  const keys = [...new Set(mirrors.map(row => row.managed_cursor_key!))];
  const durable = new Set(await engine.listManagedSyncFailureKeys(keys));
  const seen = new Set<string>();
  const out: Array<{ cursor_key: string; source_id: string; run_id: string | null; request_id: string | null; updated_at: string }> = [];
  for (const row of mirrors) {
    const key = row.managed_cursor_key!;
    if (durable.has(key) || archived.has(row.source_id) || seen.has(key)) continue;
    seen.add(key);
    out.push({ cursor_key: key, source_id: row.source_id, run_id: row.run_id ?? null, request_id: row.request_id ?? null, updated_at: row.ts });
  }
  return out;
}

/** #6518: prunes a source's mirror-only ledger rows (the successful-sync path); returns how many it removed. */
export async function pruneMirrorOnlyManagedFailures(engine: OrphanReads, sourceId: string): Promise<number> {
  const rows = await mirrorOnlyManagedFailures(engine, [sourceId]);
  for (const row of rows) clearManagedSyncFailure(row.cursor_key);
  return rows.length;
}

/**
 * Delete one orphan's rows in one transaction: the cursor (unless the writer
 * finished or resumed it meanwhile, or its pending request went live), its
 * same-key failure row, and its manifest when no other cursor shares the run.
 * A `mirror_row` orphan deletes nothing durable: its ledger row goes only when
 * the durable read, repeated now, still finds no failure row under its key.
 * Returns what was removed; an empty result means the orphan is gone or no
 * longer qualifies and nothing was touched.
 *
 * #6518 [R18]: an `incarnation_retired` cursor is deleted when the source is
 * still active under a different incarnation at apply time; the live-writer
 * veto below is for a cursor the live writer could still resume, which no
 * retired key can be, so it does not apply. The live pending-request guard does.
 *
 * #6712 PR 1: a `superseded_by_adoption` cursor is one the drain's fan-in passed over for the incarnation's adopted
 * cursor; it is deleted only while no request admitted under its key is still open or carries recovery, and `inTx`
 * (the drain lease's fence) runs first in the same transaction.
 *
 * #6834: a `checkpoint_moved` cursor is deleted only while the classification's rule still holds (`checkpointMovedSql`):
 * its checkpoint is still the refused one, the source still records a commit other than its start and target, and no
 * request under its key is open or carries recovery. It is bound to the previewed run and checkpoint request, so a run
 * that replaced the cursor under the same key since the preview is kept, and a path slice's record is cleared with it.
 * A `slug_mode_refused` cursor (#6712 PR 3) is retired under the same binding while `slugModeRefusedSql` still holds.
 * A `slug_mode_refused` pass row (#6694 on the pass) loses its `slug_mode` obligation under the previewed pass and stamp
 * while `passSlugModeRefusedSql` still holds and no pass holds the source's drain lease (its row locked, so a pass that
 * takes the lease next reads the retired row).
 */
export async function retireManagedSyncOrphan(engine: BrainEngine, orphan: Pick<ManagedSyncOrphan, 'kind' | 'cursor_key' | 'run_id' | 'source_id' | 'source_incarnation' | 'reason'>
  & { pending_request_id?: string | null },
  inTx?: (tx: BrainEngine) => Promise<void>): Promise<{ cursor: boolean; failure: boolean; manifest: boolean; mirror: boolean }> {
  const retired = orphan.reason === 'incarnation_retired';
  const mode: ManagedSyncRetireMode = retired ? 'retired' : orphan.reason === 'superseded_by_adoption' ? 'adoption' : orphan.reason === 'checkpoint_moved' ? 'checkpoint_moved'
    : orphan.reason === 'slug_mode_refused' ? 'slug_mode_refused' : 'orphan';
  if (orphan.kind === 'mirror_row') {
    if ((await engine.listManagedSyncFailureKeys([orphan.cursor_key])).length) return { cursor: false, failure: false, manifest: false, mirror: false };
    return { cursor: false, failure: false, manifest: false, mirror: clearManagedSyncFailure(orphan.cursor_key) };
  }
  const target = { cursorKey: orphan.cursor_key, sourceId: orphan.source_id, incarnation: orphan.source_incarnation, runId: orphan.run_id,
    requestId: orphan.pending_request_id ?? null };
  const removed = await engine.transaction(async tx => {
    await tx.applyManagedSyncRetireLimits();
    await inTx?.(tx);
    let cursor = false;
    if (orphan.kind === 'unfinished_cursor' && mode === 'slug_mode_refused' && orphan.cursor_key === `${orphan.source_id}:${orphan.source_incarnation}`) {
      cursor = await tx.retireManagedSyncPassSlugMode(target, syncLockId(orphan.source_id));
      if (!cursor) return { cursor: false, failure: false, manifest: false, mirror: false };
    } else if (orphan.kind === 'unfinished_cursor') {
      const deleted = await tx.retireManagedSyncCursor(target, mode);
      cursor = deleted !== null;
      if (!deleted) return { cursor: false, failure: false, manifest: false, mirror: false };
      // #6834: a retired path slice's record goes with it, so the next discovery starts from the recorded commit instead of resuming that slice.
      const intent = deleted.intent as { slice?: { target?: string }; syncOptions?: SyncCursorOptions } | null;
      if ((mode === 'checkpoint_moved' || mode === 'slug_mode_refused') && intent?.slice?.target && intent.syncOptions) await clearSyncSlice(tx, orphan.source_id, orphan.source_incarnation!, intent.syncOptions, intent.slice.target);
    }
    const failure = await tx.deleteManagedSyncFailureRow(orphan.cursor_key, retired && orphan.kind === 'failure_row');
    const manifest = orphan.run_id ? await tx.deleteManagedSyncManifest(orphan.run_id) : false;
    return { cursor, failure, manifest, mirror: false };
  });
  if (removed.cursor || removed.failure) try { removed.mirror = clearManagedSyncFailure(orphan.cursor_key); } catch { /* the local ledger is a compatibility mirror */ }
  return removed;
}

/**
 * #6834: the cursor `c` (of source `s`) stands at its checkpoint, which ended refused because `last_commit` moved, and the
 * source now records a commit other than the cursor's start and other than where the checkpoint would put it: the
 * target, or, for a path slice short of its target's end (#6349), the start again. A company-brain cursor records its
 * approval and is never one. Shared by the classification and the retirement's re-check, so both read the same rule.
 * `$msg` is the moved-checkpoint message parameter.
 */
export const checkpointMovedSql = (msg: string) => `(c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL
  AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int
  AND s.last_commit IS DISTINCT FROM c.completed_keys->0->>'from'
  AND (c.completed_keys->0->'pending'->'intent'->'slice'->>'done'='false' OR s.last_commit IS DISTINCT FROM c.completed_keys->0->>'target')
  AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='revision_conflict' AND m.error_message=${msg})
  AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint
    AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL)))`;

/**
 * #6694 on the live pass: the pass row `p` (of source `s`) carries the slug-root mode its unstamped run admitted under, the
 * source pins another, the pass's stamp `req` ended refused `slug_root_mode_mismatch`, and nothing that pass admitted is
 * still open. Shared by the classification and the retirement's re-check.
 */
export const passSlugModeRefusedSql = (req: string) => `(p.completed_keys->0->'obligations'->>'slug_mode' IS NOT NULL
  AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM p.completed_keys->0->'obligations'->>'slug_mode'
  AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=${req} AND m.intent->>'kind'='managed_sync_checkpoint'
    AND m.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch')
  AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id'
    AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL)))`;

/** The newest stamp request of the pass row `p`'s pass. */
export const passStampSql = `(SELECT n.request_id FROM persistence_requests n WHERE n.source_id=s.id AND n.intent->>'kind'='managed_sync_checkpoint'
  AND n.intent->>'passId'=p.completed_keys->0->'telemetry'->>'pass_id' ORDER BY n.sequence DESC LIMIT 1)`;

/**
 * #6712 PR 3: the cursor `c` (of source `s`) stands at its checkpoint, refused `slug_root_mode_mismatch`, and the source
 * still pins a mode other than the run's. Shared by the classification and the retirement's re-check.
 */
export const slugModeRefusedSql = `(c.completed_keys->0->'pending'->'intent'->>'kind'='managed_sync_checkpoint' AND c.completed_keys->0->>'companyReceiptId' IS NULL
  AND (c.completed_keys->0->>'index')::int>=(c.completed_keys->0->>'total')::int
  AND s.config->>'slug_root_mode' IS NOT NULL AND s.config->>'slug_root_mode' IS DISTINCT FROM c.completed_keys->0->>'slugMode'
  AND EXISTS(SELECT 1 FROM persistence_requests m WHERE m.source_id=s.id AND m.request_id=(c.completed_keys->0->'pending'->>'requestId')::uuid
    AND m.state IN ('failed','conflict') AND m.recovery IS NULL AND m.error_code='slug_root_mode_mismatch')
  AND NOT EXISTS(SELECT 1 FROM persistence_requests o WHERE o.source_id=s.id AND o.intent->>'cursorKey'=c.fingerprint
    AND (o.state IN ('queued','running','recovering') OR o.recovery IS NOT NULL)))`;
