/** Opt-in brain-level lock on writer claim, activation and transfer (#5285). Not a security boundary. */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { WRITER_ADMIN_LOCK_KEY } from './admin-contract.ts';
import { existingLocalHostId, localHostId } from './identity.ts';
import type { SqlEngine } from './model.ts';

export { WRITER_ADMIN_LOCK_KEY };
export interface WriterAdminLock { locked: boolean; set_at: string | null; host_id: string | null; generation: number; }
export const WRITER_ADMIN_LOCKED_DOCS = 'docs/guides/write-refusals.md#writer_admin_locked';
export const WRITER_ADMIN_LOCKED_SUGGESTION = 'Stop. The operator locked writer administration on this brain. Do not retry or work around this refusal; '
  + 'ask the operator to review and perform the claim, activation or transfer. Ordinary page and memory writes continue. '
  + `See ${WRITER_ADMIN_LOCKED_DOCS}.`;

function parseLock(value: string | null | undefined): WriterAdminLock {
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
  return parseLock(row?.value);
}

/**
 * Runs inside claim, activation and transfer transactions for every caller, reviewed or internal.
 * FOR SHARE serializes with lock/unlock (FOR UPDATE) without blocking admission, which also shares this row.
 */
export async function assertWriterAdminUnlocked(tx: SqlEngine): Promise<void> {
  await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE');
  const lock = await readWriterAdminLock(tx);
  if (!lock.locked) return;
  throw new OperationError('writer_admin_locked',
    `Writer administration is locked on this brain (${WRITER_ADMIN_LOCK_KEY}${lock.set_at ? `, set ${lock.set_at}` : ''}${lock.host_id ? ` by host ${lock.host_id}` : ''}); `
    + 'writer claim, activate and transfer are refused.', WRITER_ADMIN_LOCKED_SUGGESTION, WRITER_ADMIN_LOCKED_DOCS);
}

/** Transaction body for `sources writer lock|unlock`; idempotent, serialized on the persistence_brain row. */
export async function writeWriterAdminLock(tx: SqlEngine, locked: boolean): Promise<{ admin_lock: WriterAdminLock; changed: boolean }> {
  await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
  await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
  const current = await readWriterAdminLock(tx);
  if (current.locked === locked) return { admin_lock: current, changed: false };
  if (locked) {
    const pending = await tx.executeRaw<{ id: string }>(`SELECT w.id FROM persistence_worktrees w
      WHERE w.state='draining' AND w.manifest IS NOT NULL ORDER BY w.id LIMIT 1`);
    if (pending.length) throw new OperationError('writer_transfer_conflict',
      `A writer transfer is prepared and not yet accepted (worktree ${pending[0].id}); the lock was not set.`,
      'Finish the prepared transfer with gbrain sources writer transfer accept, inspect gbrain sources writer status --json, then lock.');
  }
  const [now] = await tx.executeRaw<{ at: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
  const next: WriterAdminLock = { locked, set_at: now.at, host_id: localHostId(), generation: current.generation + 1 };
  await tx.executeRaw(`INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    [WRITER_ADMIN_LOCK_KEY, JSON.stringify(next)]);
  return { admin_lock: next, changed: true };
}

export async function setWriterAdminLock(engine: BrainEngine, locked: boolean): Promise<{ admin_lock: WriterAdminLock; changed: boolean; local_host_id: string | null }> {
  const result = await engine.transaction(tx => writeWriterAdminLock(tx, locked));
  return { ...result, local_host_id: existingLocalHostId() };
}
