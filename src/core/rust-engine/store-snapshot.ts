/**
 * The owner side of a Rust brain's snapshot (rust/docs/store/snapshot.md). The process that owns the brain runs the
 * whole operation, so the copy reads the brain the owner holds and the owner can bound it:
 *
 * - One snapshot at a time per store (`busy`). Every call has an operation id, and the owner keeps what became of it,
 *   so a caller that lost its connection can ask `snapshotStatus(opId)`.
 * - The call settles only when the Rust call has returned: the read of the brain is released and a copy that did not
 *   finish has removed what it wrote. A caller that is gone (its connection closed, its call cancelled or past its
 *   deadline) cancels the copy; the owner goes on to the end of it, and the status says `cancelled` once the files are
 *   gone, never before. A caller deletes its scratch space only after the status is terminal.
 * - A live copy holds old pages of the brain until it ends, so a long copy on a busy brain grows the file. The owner
 *   checks the free space of the filesystem of the target and of the brain every second and stops the copy below a
 *   reserve of max(2 GiB, 5 % of the filesystem), and stops a copy older than the age budget (2 hours). The result
 *   records the free bytes when the copy started and the lowest it saw; the worst overshoot is one check interval of
 *   writes, so the reserve is a floor to be defended, not a guarantee of a free disk.
 * - Only the trusted local caller runs it, in process as well as before it is forwarded (whole-op.ts): a snapshot holds
 *   every page of the brain whatever any source grant says.
 *
 * Errors are `rust_snapshot_stopped` with `reason` `busy`, `cancelled`, `disk_pressure` or `age_budget`, nothing left.
 */
import { statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { opError, type OperationError } from '../ops/contract.ts';
import { requestSignal } from '../request-signal.ts';
import { callerIsRemote } from './owner-ipc/client.ts';
import { ownerIpcRefusal } from './owner-ipc/routes.ts';
import { storeErrorCode } from './store-errors.ts';
import type { RustStore, StoreSnapshotManifest } from './store.ts';

const GIB = 1024 ** 3;
/** A copy stops when a filesystem it uses has less than max(this, SNAPSHOT_RESERVE_FRACTION of its size) free. */
export const SNAPSHOT_MIN_RESERVE_BYTES = 2 * GIB;
export const SNAPSHOT_RESERVE_FRACTION = 0.05;
/** A copy older than this is stopped. */
export const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** How often the free space is read (milliseconds). */
export const SNAPSHOT_POLL_MS = 1000;
/** Finished operations the owner remembers, oldest dropped first. */
const REMEMBERED = 32;

export type SnapshotStopReason = 'busy' | 'cancelled' | 'disk_pressure' | 'age_budget';
export type SnapshotState = 'running' | 'done' | 'failed' | 'cancelled' | 'unknown';

/** Free space as `statfs` reports it: blocks of `bsize` bytes, `bavail` of them free to this user, `blocks` in all. */
export interface FsStats { bavail: number | bigint; bsize: number | bigint; blocks: number | bigint }

export interface SnapshotStoreOptions {
  /** Names the call for `snapshotStatus` and the native cancel; 1 to 128 letters, digits, `.`, `_`, `-`. */
  opId: string;
  /** Overrides of the budgets above, for tests and for a host with a different disk plan. */
  maxAgeMs?: number;
  minReserveBytes?: number;
  pollMs?: number;
  /** Test seams, passed to the native copy (store.ts `StoreSnapshotOptions`). */
  batchDelayMs?: number;
  batchBytes?: number;
}

/** What a finished call resolves, and what `snapshotStatus` reports. */
export interface SnapshotStatus {
  op_id: string;
  state: SnapshotState;
  /** Why a `cancelled` copy stopped. */
  reason?: Exclude<SnapshotStopReason, 'busy'>;
  /** The store's own error code for a `failed` copy. */
  code?: string;
  started_at?: number;
  ended_at?: number;
  /** Free bytes of the most constrained filesystem when the copy started and the lowest value seen. */
  free_bytes?: { initial: number; low: number };
  manifest?: StoreSnapshotManifest;
}

/** What the owner reads from the machine; tests replace it. */
export interface SnapshotDeps { statfs?: (path: string) => FsStats; now?: () => number }

interface Entry extends SnapshotStatus { stopReason?: Exclude<SnapshotStopReason, 'busy'> }

const entries = new Map<string, Entry>();
const busyStores = new WeakMap<object, string>();

function stopped(reason: SnapshotStopReason, detail: string): OperationError {
  return opError('rust_snapshot_stopped', `The brain's snapshot did not finish (${reason}); nothing of it remains.`,
    reason === 'busy' ? 'Wait for the running snapshot to end, then start again.' : 'Free disk space or start the snapshot again when the brain is quieter.',
    { reason, retryable: reason !== 'cancelled', detail });
}

const free = (stats: FsStats): number => Number(stats.bavail) * Number(stats.bsize);
const size = (stats: FsStats): number => Number(stats.blocks) * Number(stats.bsize);

function remember(entry: Entry): void {
  entries.delete(entry.op_id);
  entries.set(entry.op_id, entry);
  for (const [id, old] of entries) {
    if (entries.size <= REMEMBERED) break;
    if (old.state !== 'running') entries.delete(id);
  }
}

/** What became of operation `opId` on this owner. `unknown`: this process never ran it (or has restarted since). */
export function snapshotStatus(opId: string): SnapshotStatus {
  const entry = entries.get(String(opId));
  if (!entry) return { op_id: String(opId), state: 'unknown' };
  const { stopReason: _stop, ...status } = entry;
  return status;
}

/**
 * Copies the brain `engine` owns into the new directory `target` and resolves what the call recorded. `engine` is the
 * owner's engine: a `RustEngine` that holds the store.
 */
export async function snapshotStore(
  engine: object, target: string, options: SnapshotStoreOptions, deps: SnapshotDeps = {},
): Promise<SnapshotStatus & { manifest: StoreSnapshotManifest; free_bytes: { initial: number; low: number } }> {
  if (callerIsRemote()) throw ownerIpcRefusal('snapshotStore', 'a remote caller may not copy the whole brain');
  const opId = String(options?.opId ?? '');
  // The open store, at once when there is one. A call that reaches an owner whose store is still opening waits for it
  // (`storeFor`), as every other served member does, and is refused only when the engine is not connected.
  const served = engine as { openStore(member: string): RustStore; storeFor?(member: string, args?: unknown[]): Promise<RustStore>; disconnecting?: boolean };
  let store: RustStore;
  try {
    store = served.openStore('snapshotStore');
  } catch (error) {
    if (!served.storeFor) throw error;
    store = await served.storeFor('snapshotStore');
  }
  // `disconnect()` captures its stop hooks in its first synchronous step and sets this flag in the same step, so a copy
  // admitted after it would never be stopped before the store closes: it is refused here, before the native call.
  if (served.disconnecting) throw stopped('cancelled', 'the engine is disconnecting');
  if (busyStores.has(store) || entries.get(opId)?.state === 'running') throw stopped('busy', `op=${busyStores.get(store) ?? opId}`);
  const now = deps.now ?? Date.now;
  const statfs = deps.statfs ?? ((path: string) => statfsSync(path) as FsStats);
  const absolute = resolve(target);
  const watched = [dirname(absolute), (engine as { databasePath?: string }).databasePath].filter((p): p is string => typeof p === 'string');
  const reserveFloor = options.minReserveBytes ?? SNAPSHOT_MIN_RESERVE_BYTES;
  const free_bytes = { initial: Number.POSITIVE_INFINITY, low: Number.POSITIVE_INFINITY };
  /** The first filesystem below its reserve, as text; also tracks the low-water mark. */
  const sample = (): string | undefined => {
    let short: string | undefined;
    for (const path of watched) {
      let stats: FsStats;
      try { stats = statfs(path); } catch { return 'statfs_failed'; }
      const left = free(stats);
      free_bytes.low = Math.min(free_bytes.low, left);
      if (left < Math.max(reserveFloor, SNAPSHOT_RESERVE_FRACTION * size(stats))) short ??= `free=${left} total=${size(stats)}`;
    }
    return short;
  };
  const refusal = sample();
  free_bytes.initial = free_bytes.low;
  if (refusal) throw stopped('disk_pressure', refusal);

  const entry: Entry = { op_id: opId, state: 'running', started_at: now(), free_bytes };
  remember(entry);
  busyStores.set(store, opId);
  const stop = (why: Exclude<SnapshotStopReason, 'busy'>): void => {
    if (entry.stopReason) return;
    entry.stopReason = why;
    store.snapshotCancel(opId);
  };
  // The native call registers its operation id before it returns its promise, so a stop made below always finds it.
  const copying = store.snapshotTo(absolute, {
    opId,
    ...(options.batchDelayMs !== undefined ? { batchDelayMs: options.batchDelayMs } : {}),
    ...(options.batchBytes !== undefined ? { batchBytes: options.batchBytes } : {}),
  });
  // A disconnect stops the copy and waits for the native call to return, so the store never closes under a running copy.
  const unregister = (engine as { registerBeforeDisconnect?(stop: () => Promise<void>): () => void }).registerBeforeDisconnect?.(async () => {
    stop('cancelled');
    await copying.catch(() => undefined);
  });
  const signal = requestSignal();
  const onAbort = (): void => stop('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const poll = setInterval(() => {
    const short = sample();
    if (short) stop('disk_pressure');
  }, options.pollMs ?? SNAPSHOT_POLL_MS);
  const age = setTimeout(() => stop('age_budget'), options.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS);
  const end = (outcome: Partial<Entry>): void => { Object.assign(entry, outcome, { ended_at: now() }); };
  try {
    const manifest = await copying;
    end({ state: 'done', manifest });
    return { ...snapshotStatus(opId), manifest, free_bytes };
  } catch (error) {
    if (storeErrorCode(error) === 'snapshot_cancelled') {
      const reason = entry.stopReason ?? 'cancelled';
      end({ state: 'cancelled', reason });
      throw stopped(reason, `op=${opId}`);
    }
    end({ state: 'failed', code: storeErrorCode(error) ?? 'error' });
    throw error;
  } finally {
    clearInterval(poll);
    clearTimeout(age);
    unregister?.();
    signal?.removeEventListener('abort', onAbort);
    busyStores.delete(store);
  }
}
