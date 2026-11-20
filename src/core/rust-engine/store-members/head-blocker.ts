/**
 * The head-blocker probe (BrainEngine readHeadBlockerRows and readRecoveringHeadRow; SQL in engine-sql/head-blocker.ts), served from
 * the store's request records (gbrain-store `persistence::head_blocker`).
 *
 * Every request here has a null worktree, so the columns the statement reads through the head's worktree (owner, fence, effect and
 * request recoveries, mirrors, the running rows ahead of a sync row) are null, as Postgres answers them for a null worktree. What each
 * column holds and why: rust/docs/store/persistence.md, "Head-blocker probe".
 */
import type { BrainEngine } from '../../engine.ts';
import type { HeadBlockerRow } from '../../engine-sql/head-blocker.ts';
import { storeCall, type StoreMember } from './common.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The statement casts these arguments to uuid, so a value that is not one refuses with the cast's message, as on Postgres. */
function requireUuid(value: string | null): void {
  if (value !== null && !UUID.test(value)) throw new Error(`invalid input syntax for type uuid: "${value}"`);
}

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The probe rows. The host id decides only worktree ownership, and no request here has a worktree; it is still checked as a uuid. */
export const readHeadBlockerRows: Member<'readHeadBlockerRows'> = async (brain, ids, hostId, opts) => {
  requireUuid(hostId);
  for (const id of ids) requireUuid(id);
  if (!ids.length) return [];
  return await storeCall({ member: 'readHeadBlockerRows' },
    () => brain.readHeadBlockerRows({ ids: [...ids], priority: opts?.priority ?? null })) as HeadBlockerRow[];
};

/** The recovering head's record joined to its worktree: none here, as Postgres answers a request with a null worktree. The id is still
 * checked as a uuid. */
export const readRecoveringHeadRow: Member<'readRecoveringHeadRow'> = async (_brain, id) => {
  requireUuid(id);
  return null;
};
