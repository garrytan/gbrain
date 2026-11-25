/**
 * GBRA-248 W0a: when the host that owns a worktree was last active, read from
 * evidence that outlives a clean stop. A brain moved or restored onto another
 * machine (or a container with a fresh GBRAIN_HOME) queues writes for an owner
 * that never returns; receipts, doctor and --accept-pending need the facts to
 * say so instead of reading as an ordinary pending write.
 *
 * last_active is the greatest of: the owner's newest consumer heartbeat
 * (Postgres only; deleted on a clean stop), the owner's newest committed
 * receipt on the worktree (durable; survives a clean stop and compaction; read
 * through the foreground-committed and sync-watermark partial indexes, whose
 * predicates the two subqueries repeat verbatim. The foreground subquery
 * bounds worktree_id as a range and orders by (worktree_id, sequence): with
 * plain equality the correlated plan walked the sequence key through every
 * receipt, 68 ms against 0.05 ms at 300k receipts on a worktree with none;
 * the sync subquery reads the newest receipt of each source's current
 * incarnation instead of every sync receipt of the worktree)
 * and the worktree heartbeat (stamped at claim and on a consumer's clean stop).
 * null means no evidence at all: it reads as stale only once a write has
 * waited on the worktree past the stale window, and never as permission. The owner is never stale to itself:
 * on the owner host a pending write waits on this host's own consumer. Read-only.
 */
import type { BrainEngine } from '../engine.ts';
import { CONSUMER_LAPSED_MS } from './consumer-heartbeat.ts';
import { existingHostIdFor } from './identity.ts';

/** An owner with no live consumer and no activity for this long reads as stale. */
export const OWNER_STALE_MS = 24 * 60 * 60 * 1000;

export interface OwnerActivity {
  worktree_id: string;
  owner_host_id: string;
  /** A consumer of the owner host renewed its heartbeat within the lapse window (always false on PGLite). */
  live: boolean;
  last_active: string | null;
  /** PGLite: this process holds the database file but is not the owner host, so nothing here can publish for it. */
  foreign_file_holder: boolean;
  stale: boolean;
}

export async function ownerActivity(engine: BrainEngine, worktreeIds: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<Map<string, OwnerActivity>> {
  const result = new Map<string, OwnerActivity>();
  const ids = [...new Set(worktreeIds)].filter(Boolean);
  if (!ids.length) return result;
  const rows = await (await engine.refreshStore()).ownerActivity(ids, CONSUMER_LAPSED_MS, { signal: engine.kind === 'postgres' ? opts.signal : undefined });
  const local = existingHostIdFor(engine);
  for (const row of rows) {
    const lastActive = row.last_active === null ? null : new Date(row.last_active).toISOString();
    const self = local === row.owner_host_id;
    const foreign = engine.kind === 'pglite' && local !== null && !self;
    const since = lastActive ?? (row.oldest_open === null ? null : new Date(row.oldest_open).toISOString());
    const quiet = since !== null && new Date(row.db_now).getTime() - Date.parse(since) > OWNER_STALE_MS;
    result.set(row.worktree_id, { worktree_id: row.worktree_id, owner_host_id: row.owner_host_id, live: !!row.live,
      last_active: lastActive, foreign_file_holder: foreign, stale: !self && !row.live && (foreign || quiet) });
  }
  return result;
}

/** How long a receipt read waits for owner facts, counted from when the read started. */
export const OWNER_READ_BUDGET_MS = 500;

/**
 * Starts the owner read now and returns `settle(ms)`, which waits at most that
 * much longer for it. The read is cancelled (Postgres) OWNER_READ_BUDGET_MS
 * after it starts, or when a settle gives up first, and then, like a failed
 * read, settles to null (no answer), so callers fold it into a budget they
 * already have instead of adding one and no read outlives that budget.
 */
export function startOwnerRead(engine: BrainEngine, worktreeIds: readonly string[]): (budgetMs: number) => Promise<Map<string, OwnerActivity> | null> {
  const abort = new AbortController();
  const expiry = setTimeout(() => abort.abort(), OWNER_READ_BUDGET_MS);
  const read = (worktreeIds.length ? ownerActivity(engine, worktreeIds, { signal: abort.signal }).catch(() => null) : Promise.resolve(null))
    .finally(() => clearTimeout(expiry));
  return async budgetMs => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const owners = await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, budgetMs)); })])
      .finally(() => { if (timer) clearTimeout(timer); });
    if (!owners) abort.abort();
    return owners;
  };
}
