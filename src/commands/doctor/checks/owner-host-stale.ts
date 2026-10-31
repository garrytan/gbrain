/**
 * GBRA-248 W0a: `owner_host_stale` warns when managed writes wait on a
 * worktree whose owner host runs no consumer and has been quiet past the stale
 * window (owner-activity.ts): a brain moved or restored onto another machine,
 * or a container restarted with a fresh GBRAIN_HOME, queues writes for an
 * owner that never comes back. Read-only; never claims or transfers anything.
 * `host_identity_mismatch` (persistence-consumers.ts) is the sibling for an
 * owner whose checkout this filesystem holds.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { ownerActivity, OWNER_STALE_MS } from '../../../core/persistence/owner-activity.ts';
import { PENDING_WRITE_EXIT_CODE } from '../../../core/exit-codes.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/troubleshooting.md#owner-host-stale';

export async function ownerHostStaleCheck(engine: BrainEngine): Promise<Check> {
  try {
    const [present] = await engine.executeRaw<{ managed: boolean }>(`SELECT to_regclass('public.persistence_requests') IS NOT NULL AND to_regclass('public.persistence_worktrees') IS NOT NULL AS managed`);
    if (!present?.managed) return { name: 'owner_host_stale', status: 'ok', message: 'This brain keeps no managed write journal.', details: { count: 0, stale_after_ms: OWNER_STALE_MS, stale: [], docs: DOCS } };
    const open = await engine.executeRaw<{ worktree_id: string; open_writes: number; oldest_open: string | Date; source_ids: string[] | null }>(`
      SELECT r.worktree_id::text AS worktree_id, count(*)::int AS open_writes, min(r.created_at) AS oldest_open,
        (SELECT array_agg(b.source_id ORDER BY b.source_id) FROM persistence_source_bindings b WHERE b.worktree_id=r.worktree_id) AS source_ids
      FROM persistence_requests r WHERE r.worktree_id IS NOT NULL AND r.state IN ('queued','running','recovering')
      GROUP BY r.worktree_id`);
    const owners = await ownerActivity(engine, open.map(row => row.worktree_id));
    const stale = open.flatMap(row => {
      const owner = owners.get(row.worktree_id);
      return owner?.stale ? [{ worktree_id: row.worktree_id, source_ids: row.source_ids ?? [], owner_host_id: owner.owner_host_id, last_active: owner.last_active,
        foreign_file_holder: owner.foreign_file_holder, open_writes: Number(row.open_writes), oldest_open: new Date(row.oldest_open).toISOString() }] : [];
    });
    const details = { count: stale.length, stale_after_ms: OWNER_STALE_MS, stale, docs: DOCS };
    if (!stale.length) return { name: 'owner_host_stale', status: 'ok', details,
      message: open.length ? `Every worktree with waiting writes has a live or recently active owner host (${open.length} checked).` : 'No managed write is waiting on an owner host.' };
    const waiting = stale.reduce((sum, row) => sum + row.open_writes, 0);
    return { name: 'owner_host_stale', status: 'warn', details,
      message: `owner_host_stale: ${waiting} write(s) wait for an owner host that runs no gbrain consumer and has been quiet for over ${OWNER_STALE_MS / 3_600_000} h. `
        + stale.slice(0, 3).map(row => `${row.source_ids.join(', ') || row.worktree_id}: owner host ${row.owner_host_id}, last active ${row.last_active ?? 'at no recorded time'}, ${row.open_writes} waiting since ${row.oldest_open}${row.foreign_file_holder ? ' (this process holds the PGLite file under a different host identity)' : ''}.`).join(' ')
        + `${stale.length > 3 ? ` (first 3 of ${stale.length} shown.)` : ''} `
        + 'These writes are kept and publish only when that host runs gbrain again. If the brain was moved or restored onto this machine, or this container restarted with a new GBRAIN_HOME, '
        + 'run gbrain with the owner\'s GBRAIN_HOME (keep it stable per container). The accept-pending opt-in does not cover these writes: they still exit ' + PENDING_WRITE_EXIT_CODE + '. Never edit or delete a host.json.',
      fix: agentFix(['gbrain', 'sources', 'writer', 'status', '--json'], 'Read-only: shows local_host_id, each binding\'s owner_host_id and the owner\'s consumers.', 'owner_host_stale', { docs: DOCS }) };
  } catch (error) {
    return checkError('owner_host_stale', 'read the owner hosts of waiting writes', error, { details: { count: 'unknown', health: 'unknown', docs: DOCS } });
  }
}

async function runOwnerHostStale(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await ownerHostStaleCheck(connectedEngine(ctx)));
  return checks;
}

export const ownerHostStaleEntry: DoctorEntry = {
  name: 'owner_host_stale',
  emits: ['owner_host_stale'],
  run: runOwnerHostStale,
};
