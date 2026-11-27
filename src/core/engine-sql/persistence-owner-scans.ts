/**
 * Owner scans: one SQL implementation for both engines (Rust engine persistence, write path housekeeping).
 *
 * The reads the write owner's housekeeping sent through `executeRaw` on each scan tick: the deferred-write expiry
 * (persistence/refresh-barrier.ts `expireDeferredWrites`), its overdue lists and the per-row hold checks it makes under
 * the protocol lock, the consumer's recovery scan (persistence/consumer.ts `readOwnerRecoveryHeads`), and the refresh
 * resume's list and source-commit read (persistence/worktree-refresh.ts `resumeWorktreeRefreshes`). The text is the one
 * those callers always sent, byte for byte; the idle probe
 * (`overdueDeferredWorkSql`) builds its EXISTS checks from the same fragments. Every scan joins the request to a
 * worktree the host owns, so an engine without managed worktrees answers none. Decisions stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { QueryOpts } from './executor.ts';
/** One expiry's recheck under the protocol lock: the refresh it waits behind, or the import hold it scanned. */
export type OverdueHold =
  | { kind: 'refresh'; refreshId: string | null }
  | { kind: 'import'; id: string; importFrom: string | null; maxWaitMs: number };
/** The FROM tail of a write deferred behind a refresh still unreleased past the wait limit, on worktrees `host` owns. */
export const overdueDeferredFrom = (host: string, maxWait: string) => `JOIN persistence_worktrees w ON w.id=r.worktree_id
    JOIN persistence_worktree_refreshes f ON f.id=r.deferred_refresh_id
    WHERE w.owner_host_id=${host}::uuid AND r.state='deferred' AND f.released_at IS NULL AND r.created_at<now()-(${maxWait}*interval '1 millisecond')`;
/**
 * GST-1623: however often a write is held again (another writer committing to its file faster than sync imports), it waits at
 * most this many wait limits from its admission, and never less than HOLD_CEILING_FLOOR_MS.
 */
const HOLD_CEILING_LIMITS = 4;
const HOLD_CEILING_FLOOR_MS = 4 * 60 * 60_000;
const holdCeiling = (maxWait: string) => `GREATEST(${maxWait}*${HOLD_CEILING_LIMITS},${HOLD_CEILING_FLOOR_MS})`;
/** A held write past its limit: held longer than the wait limit, or accepted longer ago than the ceiling. */
export const holdOverdue = (maxWait: string) => `(r.updated_at<now()-(${maxWait}*interval '1 millisecond') OR r.created_at<now()-(${holdCeiling(maxWait)}*interval '1 millisecond'))`;
/** GST-1582: a write held for an import still pending (its refresh, if any, released) whose hold is past its limit. */
export const overdueImportFrom = (host: string, maxWait: string) => `JOIN persistence_worktrees w ON w.id=r.worktree_id JOIN sources s ON s.id=r.source_id
    WHERE w.owner_host_id=${host}::uuid AND r.state='deferred' AND r.deferred_import_from IS NOT NULL AND COALESCE(s.last_commit,'')=r.deferred_import_from
      AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=r.deferred_refresh_id AND f.released_at IS NOT NULL))
      AND ${holdOverdue(maxWait)}`;

/** Which hold an overdue list or a hold check is about: a refresh barrier, or (GST-1582) an import that has not landed. */
export type OverdueHoldKind = 'refresh' | 'import';

/** `listOverdueHeldWrites`: $1 host id, $2 the wait limit in ms. */
export const OVERDUE_HELD_WRITES_SQL: Record<OverdueHoldKind, string> = {
  refresh: `SELECT r.* FROM persistence_requests r ${overdueDeferredFrom('$1', '$2::double precision')}
    ORDER BY r.sequence LIMIT 100`,
  import: `SELECT r.* FROM persistence_requests r ${overdueImportFrom('$1', '$2::double precision')}
    ORDER BY r.sequence LIMIT 100`,
};

/**
 * `listOwnerRecoveryHeads`: $1 host id, $2 the worktree ids to leave out (as text). The head columns only (#10083): the full row
 * (intent, before-image) is read once the consumer holds the worktree's lock. The Rust engine answers whole rows, a superset.
 */
export const OWNER_RECOVERY_HEADS_SQL = `SELECT r.id,r.source_id,r.worktree_id,r.state,r.blocked_reason FROM persistence_requests r
    JOIN persistence_worktrees w ON w.id=r.worktree_id
    WHERE w.owner_host_id=$1::uuid AND r.recovery IS NOT NULL AND NOT(r.worktree_id::text=ANY($2::text[]))
    AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier WHERE earlier.worktree_id=r.worktree_id
      AND earlier.recovery IS NOT NULL AND earlier.sequence<r.sequence)
    ORDER BY r.updated_at,r.sequence LIMIT 16`;

/** Interrupted refreshes of worktrees `$1` owns, a syncing row last (#9649: `stale` once it has not moved for a whole sync budget `$2`). */
export const RESUMABLE_REFRESHES_SQL = `SELECT f.*,f.updated_at<now()-($2::double precision*interval '1 millisecond') AS stale FROM persistence_worktree_refreshes f
    JOIN persistence_worktrees w ON w.id=f.worktree_id WHERE w.owner_host_id=$1::uuid AND f.state IN ('draining','fenced','merged','syncing') AND (f.state<>'syncing'
      OR f.updated_at<now()-($2::double precision*interval '1 millisecond') OR NOT EXISTS (SELECT 1 FROM sources s WHERE s.id=ANY(f.source_ids) AND (s.last_commit IS NULL OR s.last_commit=f.old_head)))
    ORDER BY f.state='syncing', f.created_at LIMIT 16`;


/** The FROM tail of a write deferred behind a refresh still unreleased past the wait limit, on worktrees `host` owns. */

/**
 * Up to 100 deferred writes on worktrees `hostId` owns whose `hold` is past the wait limit `maxWaitMs`, in sequence
 * order. A host id that is not a uuid refuses, as `::uuid` does.
 */
export function listOverdueHeldWrites<R = Record<string, unknown>>(exec: LegacyUnscopedRead, hostId: string, maxWaitMs: number,
  hold: OverdueHoldKind, opts?: QueryOpts): Promise<R[]> {
  return exec.executeRaw<R>(OVERDUE_HELD_WRITES_SQL[hold], [hostId, maxWaitMs], opts);
}

/**
 * The oldest recovering write of each worktree `hostId` owns that is not in `excluded`, at most 16, oldest update
 * first (the consumer's recovery scan). A host id that is not a uuid refuses, as `::uuid` does.
 */
export function listOwnerRecoveryHeads<R = Record<string, unknown>>(exec: LegacyUnscopedRead, hostId: string,
  excluded: readonly string[], opts?: QueryOpts): Promise<R[]> {
  return exec.executeRaw<R>(OWNER_RECOVERY_HEADS_SQL, [hostId, excluded], opts);
}

/**
 * The refreshes of worktrees `hostId` owns that an owner's topology scan should converge, at most 16: each draining,
 * fenced or merged row, and a syncing row whose members all moved off the old head or that has not moved for
 * `budgetMs`. Each row carries `stale` (no move for `budgetMs`). A host id that is not a uuid refuses.
 */
export function listResumableRefreshes<R = Record<string, unknown>>(exec: LegacyUnscopedRead, hostId: string, budgetMs: number,
  opts?: QueryOpts): Promise<(R & { stale: boolean })[]> {
  return exec.executeRaw<R & { stale: boolean }>(RESUMABLE_REFRESHES_SQL, [hostId, budgetMs], opts);
}

/** The request `id` still deferred on import `importFrom`, that import still pending and the hold past `maxWait` (its sources row FOR SHARE). */
const pendingImportHold = (id: string, importFrom: string, maxWait: string) => `SELECT 1 FROM persistence_requests r JOIN sources s ON s.id=r.source_id
        WHERE r.id=${id}::uuid AND r.state='deferred' AND r.deferred_import_from=${importFrom} AND COALESCE(s.last_commit,'')=r.deferred_import_from
          AND ${holdOverdue(maxWait)} FOR SHARE OF s`;

/** `lockOverdueHold`: the refresh row unreleased (locked FOR NO KEY UPDATE), or the import hold still pending and overdue. */
export const LOCK_OVERDUE_HOLD_SQL: Record<OverdueHoldKind, string> = {
  refresh: 'SELECT 1 FROM persistence_worktree_refreshes WHERE id=$1::uuid AND released_at IS NULL FOR NO KEY UPDATE',
  import: pendingImportHold('$1', '$2', '$3::double precision'),
};

/**
 * Whether the hold an expiry scanned still stands, with its row locked for the caller's transaction: the refresh
 * still unreleased, or the write still deferred on the same import, that import still pending and the hold still past
 * its limit. False when it moved; the caller then leaves the write.
 */
export async function lockOverdueHold(exec: LegacyUnscopedRead, hold: OverdueHold): Promise<boolean> {
  const rows = hold.kind === 'refresh'
    ? await exec.executeRaw(LOCK_OVERDUE_HOLD_SQL.refresh, [hold.refreshId])
    : await exec.executeRaw(LOCK_OVERDUE_HOLD_SQL.import, [hold.id, hold.importFrom, hold.maxWaitMs]);
  return rows.length > 0;
}
