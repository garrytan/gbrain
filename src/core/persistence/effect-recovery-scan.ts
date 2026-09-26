import type { BrainEngine } from '../engine.ts';
import type { PersistenceEffect } from './effect-model.ts';

const cursors = new WeakMap<BrainEngine, { hostId: string; after: string }>();

/** Advance even past unavailable locks; their recovery remains durable and blocks only that root. */
export async function selectEffectRecoveries(engine: BrainEngine, hostId: string, limit: number): Promise<PersistenceEffect[]> {
  const cursor = cursors.get(engine);
  const scan = (after: string | null) => engine.executeRaw<PersistenceEffect>(`SELECT e.* FROM persistence_effects e
    JOIN persistence_worktrees w ON w.id=e.worktree_id
    WHERE e.recovery IS NOT NULL AND w.owner_host_id=$1::uuid AND e.next_attempt_at<=now()
      AND ($2::bigint IS NULL OR e.id>$2::bigint) ORDER BY e.id LIMIT $3`, [hostId, after, limit]);
  let rows = await scan(cursor?.hostId === hostId ? cursor.after : null);
  if (!rows.length && cursor?.hostId === hostId) rows = await scan(null);
  if (rows.length) cursors.set(engine, { hostId, after: String(rows[rows.length - 1].id) });
  else cursors.delete(engine);
  return rows;
}
