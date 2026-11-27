/**
 * The managed sync checkpoint's validation reads (BrainEngine readIncompleteSyncReceipt, readOpenPassWork and readIncompleteSyncReceiptRows;
 * SQL in engine-sql/checkpoint-validation.ts), served from the store's request records (gbrain-store `persistence::checkpoint_validation`).
 *
 * Every request here has a null worktree, so no request matches the worktree the statements key on and each read answers no blocker, as
 * Postgres answers a worktree with no rows. What each read judges and why: rust/docs/store/persistence.md, "Checkpoint validation".
 */
import type { BrainEngine } from '../../engine.ts';
import type { IncompleteSyncReceiptRow } from '../../engine-sql/checkpoint-validation.ts';
import { storeCall, type StoreMember } from './common.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The statements cast these arguments to uuid, so a value that is not one refuses with the cast's message, as on Postgres. */
function requireUuid(value: string): void {
  if (!UUID.test(value)) throw new Error(`invalid input syntax for type uuid: "${value}"`);
}

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The receipt that blocks the run's checkpoint. */
export const readIncompleteSyncReceipt: Member<'readIncompleteSyncReceipt'> = async (brain, spec) => {
  requireUuid(spec.worktreeId);
  return await storeCall({ member: 'readIncompleteSyncReceipt' },
    () => brain.readIncompleteSyncReceipt({ ...spec, superseded: [...spec.superseded], ranges: spec.ranges.map(range => [range[0], range[1]]) })) as string | null;
};

/** The work that blocks a pass stamp. */
export const readOpenPassWork: Member<'readOpenPassWork'> = async (brain, spec) => {
  requireUuid(spec.worktreeId);
  requireUuid(spec.selfRequestId);
  return await storeCall({ member: 'readOpenPassWork' }, () => brain.readOpenPassWork({ ...spec })) as string | null;
};

/** The blocking receipts `sync status` lists. */
export const readIncompleteSyncReceiptRows: Member<'readIncompleteSyncReceiptRows'> = async (brain, spec) => {
  requireUuid(spec.worktreeId);
  return await storeCall({ member: 'readIncompleteSyncReceiptRows' },
    () => brain.readIncompleteSyncReceiptRows({ ...spec, superseded: [...spec.superseded], ranges: spec.ranges.map(range => [range[0], range[1]]) })) as IncompleteSyncReceiptRow[];
};
