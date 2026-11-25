/** Opt-in brain-level lock on writer claim, activation and transfer (#5285). Not a security boundary. */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { WRITER_ADMIN_LOCK_KEY } from './admin-contract.ts';
import { hostIdFor, existingHostIdFor } from './identity.ts';
import type { SqlEngine } from './model.ts';
import type { WriterAdminStore } from '../engine-sql/writer-admin.ts';
import type { WriterReleaseStore } from '../engine-sql/writer-release.ts';

export { WRITER_ADMIN_LOCK_KEY };
export interface WriterAdminLock { locked: boolean; set_at: string | null; host_id: string | null; generation: number; }
export const WRITER_ADMIN_LOCKED_DOCS = 'docs/guides/write-refusals.md#writer_admin_locked';
export const WRITER_ADMIN_LOCKED_SUGGESTION = 'Stop. The operator locked writer administration on this brain. Do not retry or work around this refusal; '
  + 'ask the operator to review and perform the claim, activation or transfer. Ordinary page and memory writes continue. '
  + `See ${WRITER_ADMIN_LOCKED_DOCS}.`;

/** The lock a stored `WRITER_ADMIN_LOCK_KEY` value names (null when unset); an unreadable value reads locked. */
export function parseWriterAdminLock(value: string | null | undefined): WriterAdminLock {
  const unlocked: WriterAdminLock = { locked: false, set_at: null, host_id: null, generation: 0 };
  if (!value) return unlocked;
  let parsed: Partial<WriterAdminLock>;
  try { parsed = JSON.parse(value) as Partial<WriterAdminLock>; }
  catch { return { ...unlocked, locked: true }; }
  // Anything but an explicit false stays locked: an unreadable row never unlocks administration.
  return { locked: parsed?.locked !== false, set_at: typeof parsed?.set_at === 'string' ? parsed.set_at : null,
    host_id: typeof parsed?.host_id === 'string' ? parsed.host_id : null,
    generation: Number.isSafeInteger(parsed?.generation) ? parsed.generation! : 0 };
}

export async function readWriterAdminLock(engine: SqlEngine): Promise<WriterAdminLock> {
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [WRITER_ADMIN_LOCK_KEY]);
  return parseWriterAdminLock(row?.value);
}

/**
 * The operator lock, read through the typed config read every engine serves (writer status, graduation and
 * deactivation blockers, and the in-transaction refusal below).
 */
export async function readWriterAdminLockTyped(engine: Pick<BrainEngine, 'getConfig'>): Promise<WriterAdminLock> {
  return parseWriterAdminLock(await engine.getConfig(WRITER_ADMIN_LOCK_KEY));
}

/**
 * Runs inside claim, activation and transfer transactions for every caller, reviewed or internal.
 * FOR SHARE serializes with lock/unlock (FOR UPDATE) without blocking admission, which also shares this row.
 */
export async function assertWriterAdminUnlocked(tx: Pick<BrainEngine, 'getConfig' | 'topologyStore'>): Promise<void> {
  await (await tx.topologyStore()).shareBrain();
  refuseWriterAdminLocked(await readWriterAdminLockTyped(tx));
}

/** `assertWriterAdminUnlocked` over the writer release store (engine-sql/writer-release.ts), inside its transaction. */
export async function assertStoreAdminUnlocked(store: Pick<WriterReleaseStore, 'shareBrain' | 'adminLockValue'>): Promise<void> {
  await store.shareBrain();
  refuseWriterAdminLocked(parseWriterAdminLock(await store.adminLockValue()));
}

/** The same refusal from the stored config value of `WRITER_ADMIN_LOCK_KEY` (null when unset), for a typed config read. */
export function assertWriterAdminLockValue(value: string | null | undefined): void {
  refuseWriterAdminLocked(parseWriterAdminLock(value));
}

function refuseWriterAdminLocked(lock: WriterAdminLock): void {
  if (!lock.locked) return;
  throw new OperationError('writer_admin_locked',
    `Writer administration is locked on this brain (${WRITER_ADMIN_LOCK_KEY}${lock.set_at ? `, set ${lock.set_at}` : ''}${lock.host_id ? ` by host ${lock.host_id}` : ''}); `
    + 'writer claim, activate and transfer are refused.', WRITER_ADMIN_LOCKED_SUGGESTION, WRITER_ADMIN_LOCKED_DOCS);
}

/**
 * Transaction body for `sources writer lock|unlock`; idempotent, serialized on the persistence_brain row. `tx` names the
 * host that set the lock.
 */
export async function writeWriterAdminLock(store: WriterAdminStore, tx: BrainEngine, locked: boolean): Promise<{ admin_lock: WriterAdminLock; changed: boolean }> {
  await store.lockBrain();
  const current = parseWriterAdminLock(await store.adminLockValue());
  if (current.locked === locked) return { admin_lock: current, changed: false };
  if (locked) {
    const pending = await store.preparedTransferWorktree();
    if (pending !== null) throw new OperationError('writer_transfer_conflict',
      `A writer transfer is prepared and not yet accepted (worktree ${pending}); the lock was not set.`,
      'Finish the prepared transfer with gbrain sources writer transfer accept, inspect gbrain sources writer status --json, then lock.');
  }
  const next: WriterAdminLock = { locked, set_at: await store.now(), host_id: hostIdFor(tx), generation: current.generation + 1 };
  await store.setAdminLockValue(JSON.stringify(next));
  return { admin_lock: next, changed: true };
}

export async function setWriterAdminLock(engine: BrainEngine, locked: boolean): Promise<{ admin_lock: WriterAdminLock; changed: boolean; local_host_id: string | null }> {
  // engine-sql/writer-admin.ts `writerAdminTransaction`, inline: that module imports this one.
  const result = await engine.transaction(async tx => writeWriterAdminLock(await tx.writerAdminStore(), tx, locked));
  return { ...result, local_host_id: existingHostIdFor(engine) };
}
