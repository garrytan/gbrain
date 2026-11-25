/**
 * What `gbrain engine shadow start` and `gbrain engine shadow seed` record about managed storage (`start` keeps it in `state.json`, `seed` in `seed.json`).
 *
 * Shadow mode gathers evidence on managed brains too; only the swap refuses them (`engine_swap_refused` / `managed_storage`,
 * src/core/engine-swap/refusals.ts). Nothing here refuses: it reads the brain's mode once, best-effort, and returns a record
 * that the state file, `status` and the report carry, so a reader of the evidence knows the brain cannot swap.
 * The read is one SELECT on the `persistence_brain` row; it writes nothing.
 */
import type { SqlEngine } from '../core/persistence/model.ts';
import { readManagedMode } from '../core/persistence/managed-mode.ts';

/**
 * The mode as read at `checked_at`. `managed` is `true` or `false` when the read worked and `null` when it did not;
 * then `reason` is the failing error's code (`pglite_busy`, `no_brain`, `storage_error`, ...) or `open_failed` / `read_failed`.
 */
export interface ManagedStorageRecord { managed: boolean | null; checked_at: string; reason?: string }

/** What `status --json` and the report carry: the record plus `note`, null unless the swap is blocked or the mode is unknown. */
export interface StorageReport extends ManagedStorageRecord { note: string | null }

export const SWAP_BLOCKED_NOTE = 'this brain cannot swap while it uses managed storage';
export const MODE_UNREAD_NOTE = 'could not read whether this brain uses managed storage; the swap will check it';

/** Reads the mode of an open brain. Never throws: a failed read is `managed: null` with the error's code. */
export async function readManagedStorage(engine: SqlEngine, now: Date = new Date()): Promise<ManagedStorageRecord> {
  try {
    return { managed: await readManagedMode(engine), checked_at: now.toISOString() };
  } catch (e) {
    return unreadManagedStorage(e, 'read_failed', now);
  }
}

/** The record for a brain that could not be opened to read its mode. */
export function unopenableManagedStorage(e: unknown, now: Date = new Date()): ManagedStorageRecord {
  return unreadManagedStorage(e, 'open_failed', now);
}

function unreadManagedStorage(e: unknown, fallback: string, now: Date): ManagedStorageRecord {
  const code = (e as { code?: unknown } | null)?.code;
  return { managed: null, checked_at: now.toISOString(), reason: typeof code === 'string' && /^[a-z0-9_]{1,64}$/i.test(code) ? code : fallback };
}

/** A state file's record, or null when it is absent (a state written before this field existed) or malformed. */
export function storageReport(record: unknown): StorageReport | null {
  const r = record as Partial<ManagedStorageRecord> | null | undefined;
  if (!r || typeof r !== 'object' || (r.managed !== true && r.managed !== false && r.managed !== null) || typeof r.checked_at !== 'string') return null;
  return {
    managed: r.managed, checked_at: r.checked_at, ...(typeof r.reason === 'string' ? { reason: r.reason } : {}),
    note: r.managed === true ? SWAP_BLOCKED_NOTE : r.managed === null ? MODE_UNREAD_NOTE : null,
  };
}

/** The one line `start`, `status` and the report print, or null for an unmanaged brain. */
export function storageLine(record: unknown): string | null {
  const s = storageReport(record);
  if (!s?.note) return null;
  return s.managed === null && s.reason ? `${s.note} (${s.reason})` : s.note;
}
