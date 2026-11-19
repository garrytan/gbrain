/**
 * The commit notifier's host lease and host source list (migration v262 tables). notifier/store.ts claimLease,
 * readLease, holdsLease and releaseLease and notifier/resident.ts listHostSources sent these statements through `executeRaw`; the SQL text is
 * theirs, unchanged.
 *
 * - The lease (`sync_notifier_leases`): one owner per host. A claim wins when the row is free, expired or already the
 *   caller's; a takeover bumps the fencing token. A lost claim reads the current holder. The owner re-checks its token
 *   before each start (holdsNotifierLease) and expires the row on a clean stop (releaseNotifierLease).
 * - The host source list: every source that is not archived, in id order, with its managed binding, the worktree's
 *   owner host and checkout root, and the classic syncer host. notifier/resident.ts decides what the host watches.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';

/** The executor the notifier statements need: master's `executeRaw` path. */
type RawExec = Pick<SqlExecutor, 'executeRaw'>;

/** The host's lease row as a lost claim (or `gbrain sync status`) sees it. */
export interface NotifierLeaseHolder { owner_id: string; fence: number; resident_kind: string; pid: number | null; expires_at: string; live: boolean }

/** `claimNotifierLease(l)`: the resident's host, owner token, kind, pid and lease length in milliseconds. */
export interface NotifierLeaseClaimInput { hostId: string; ownerId: string; kind: string; pid: number; leaseMs: number }

/** The fencing token when the caller owns the lease, else the current holder (null when the row went away). */
export type NotifierLeaseClaim = { owner: true; fence: number } | { owner: false; holder: NotifierLeaseHolder | null };

/** One source as the notifier's host source list reads it. */
export interface NotifierHostSourceRow {
  id: string;
  local_path: string | null;
  last_commit: string | null;
  /** The source is bound to a managed worktree (persistence_source_bindings, this incarnation). */
  bound: boolean;
  /** The worktree's owner host, as text. */
  owner: string | null;
  /** The owner host's checkout root of that worktree. */
  root: string | null;
  /** The host that last advanced a classic source (sync_notifier_sources.syncer_host_id). */
  syncer: string | null;
  config: unknown;
}

const iso = (v: unknown): string | null => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const num = (v: unknown): number => typeof v === 'number' ? v : Number(v);
const optNum = (v: unknown): number | null => v === null || v === undefined ? null : num(v);
const optStr = (v: unknown): string | null => v === null || v === undefined ? null : String(v);
const bool = (v: unknown): boolean => v === true || v === 't';

/** Claims or renews the host's notifier lease: the fencing token when this resident owns it, else the current holder. */
export async function claimNotifierLease(exec: RawExec, l: NotifierLeaseClaimInput): Promise<NotifierLeaseClaim> {
  const [won] = await exec.executeRaw<{ fence: unknown }>(
    `INSERT INTO sync_notifier_leases (host_id, owner_id, fence, resident_kind, pid, renewed_at, expires_at)
     VALUES ($1, $2, 1, $3, $4, now(), now() + $5::int * interval '1 millisecond')
     ON CONFLICT (host_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, resident_kind = EXCLUDED.resident_kind, pid = EXCLUDED.pid,
       fence = sync_notifier_leases.fence + CASE WHEN sync_notifier_leases.owner_id = EXCLUDED.owner_id THEN 0 ELSE 1 END,
       renewed_at = now(), expires_at = EXCLUDED.expires_at
     WHERE sync_notifier_leases.owner_id = EXCLUDED.owner_id OR sync_notifier_leases.expires_at <= now()
     RETURNING fence`, [l.hostId, l.ownerId, l.kind, l.pid, Math.max(1, Math.round(l.leaseMs))]);
  if (won) return { owner: true, fence: num(won.fence) };
  return { owner: false, holder: await readNotifierLease(exec, l.hostId) };
}

/** The host's lease row, or null when it has none. */
export async function readNotifierLease(exec: RawExec, hostId: string): Promise<NotifierLeaseHolder | null> {
  const [row] = await exec.executeRaw<Record<string, unknown>>(
    'SELECT owner_id, fence, resident_kind, pid, expires_at, expires_at > now() AS live FROM sync_notifier_leases WHERE host_id = $1', [hostId]);
  return row ? { owner_id: String(row.owner_id), fence: num(row.fence), resident_kind: String(row.resident_kind),
    pid: optNum(row.pid), expires_at: iso(row.expires_at)!, live: bool(row.live) } : null;
}

/** The fencing check before a start: the host's lease is still `ownerId`'s, with the token it claimed, and unexpired. */
export async function holdsNotifierLease(exec: RawExec, hostId: string, ownerId: string, fence: number): Promise<boolean> {
  const rows = await exec.executeRaw<{ host_id: string }>(
    'SELECT host_id FROM sync_notifier_leases WHERE host_id = $1 AND owner_id = $2 AND fence = $3 AND expires_at > now()', [hostId, ownerId, fence]);
  return rows.length > 0;
}

/** Expires the host's lease now, only while `ownerId` still holds it, so a clean stop hands over at once. */
export async function releaseNotifierLease(exec: RawExec, hostId: string, ownerId: string): Promise<void> {
  await exec.executeRaw('UPDATE sync_notifier_leases SET expires_at = now() WHERE host_id = $1 AND owner_id = $2', [hostId, ownerId]);
}

/** Every source that is not archived, in id order, with what the notifier needs to decide whether this host watches it. */
export async function listNotifierHostSourceRows(exec: LegacyUnscopedRead): Promise<NotifierHostSourceRow[]> {
  const rows = await exec.executeRaw<{ id: string; local_path: string | null; last_commit: string | null; bound: boolean; owner: string | null; root: string | null; syncer: string | null; config: unknown }>(
    `SELECT s.id, s.local_path, s.last_commit, (b.source_id IS NOT NULL) AS bound, w.owner_host_id::text AS owner, h.local_path AS root, n.syncer_host_id AS syncer, s.config
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
       LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived ORDER BY s.id`);
  return rows.map(r => ({ id: String(r.id), local_path: optStr(r.local_path), last_commit: optStr(r.last_commit), bound: bool(r.bound),
    owner: optStr(r.owner), root: optStr(r.root), syncer: optStr(r.syncer), config: r.config }));
}
