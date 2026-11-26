/**
 * The managed leases a process holds on a multi-user Rust brain, and the check every protected write transaction makes
 * against them (lane LM slice 3, docs/designs/rust-engine/multi-user-server.md "I-5, managed mode").
 *
 * `managedLock` (managed-lock.ts) registers each handle it returns here: an immutable record of the host fence the
 * operation took its lease under and the managed lease tokens (`managed:topology:*`, `managed:worktree:*`,
 * `managed:refresh:*`) it holds. `RustEngine.transaction` (store-members/transactions.ts) calls
 * `assertManagedHeld` first thing inside the writing transaction, on every run of its callback, so each write
 * transaction a managed operation makes asserts, in the store's own transaction, the exact tokens the operation was
 * given, never the host registration read at call time. A token whose lease was taken over, released or expired
 * refuses the whole transaction `lease_lost` and nothing is written; a handle whose renewal found its lease lost
 * refuses at once with the reason the renewal saw.
 *
 * The expiry window (written down, not hidden): the store checks a lease's expiry when `assert` runs inside the
 * writing transaction, not again at commit. A writer that asserted a live lease can still commit after the lease's
 * expiry time while nobody has taken the lease over. A takeover that commits between the assert and the commit puts
 * the lease row in the transaction's read set and refuses the commit (`write_conflict`; the rerun refuses
 * `lease_lost`), and the single-writer store and an explicit transaction hold the writer from assert to commit, so no
 * takeover lands in between. That late commit is safe: no other holder exists, and the owner host's native lock,
 * which a managed operation keeps beneath its lease, still excludes a same-host successor from the checkout files.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { rustLeases, type LeaseToken } from '../rust-engine/store-members/leases.ts';
import { leaseLostError, type LeaseLostReason } from '../rust-engine/store-errors.ts';

/** What one managed lock handle has captured at acquisition. Never changes. */
export interface ManagedOperation {
  /** The host registration's lease the operation was started under (its fence), or null off a multi-user store. */
  readonly hostFence: LeaseToken | null;
  /** The managed lease tokens this operation holds. */
  readonly tokens: readonly LeaseToken[];
  /** True once a renewal found a lease lost (terminal: the operation must stop; nothing re-acquires into it). */
  readonly lost: boolean;
  /** The reason the lease was lost, when it was. */
  readonly lostReason: LeaseLostReason | null;
  /** True once the handle was released. */
  readonly released: boolean;
}

const live = new WeakMap<object, Set<ManagedOperation>>();

/** The engine whose registry a call belongs to: a transaction-bound clone shares its root's. */
export function managedRoot(engine: object): object {
  return (engine as { _txScope?: { root?: object } })._txScope?.root ?? engine;
}

export function registerManagedOperation(engine: object, operation: ManagedOperation): () => void {
  const root = managedRoot(engine);
  let set = live.get(root);
  if (!set) live.set(root, set = new Set());
  set.add(operation);
  return () => { set!.delete(operation); if (set!.size === 0 && live.get(root) === set) live.delete(root); };
}

/** The operations `engine` holds right now (read-only view; used by tests and diagnostics). */
export function heldManagedOperations(engine: object): readonly ManagedOperation[] {
  return [...(live.get(managedRoot(engine)) ?? [])];
}

/** The `lease_lost` refusal for a handle the renewal already marked lost. */
export function lostOperationError(operation: ManagedOperation): unknown {
  return opError('lease_lost',
    `A managed lease this operation holds (${operation.tokens.map(token => token.name).join(', ') || 'none'}) no longer fences it (${operation.lostReason ?? 'expired'}), so nothing was written.`,
    'Stop the work this lease protected, take the lease again (a new epoch) and re-read the state before writing.',
    { reason: operation.lostReason ?? 'expired' });
}

/**
 * Inside the writing transaction `tx`: asserts every distinct host fence and managed token the engine's live managed
 * operations hold. Returns null when there is nothing to assert, so a call on an engine with no managed operation does
 * no extra work and does not even yield.
 */
export function assertManagedHeld(engine: object, tx: BrainEngine): Promise<void> | null {
  const held = live.get(managedRoot(engine));
  if (!held || held.size === 0) return null;
  const operations = [...held];
  return (async () => {
    const seen = new Set<string>();
    const leases = rustLeases(tx as unknown as { openStore(member: string): { brain: never } });
    for (const operation of operations) {
      if (operation.lost) throw lostOperationError(operation);
      for (const token of [...(operation.hostFence ? [operation.hostFence] : []), ...operation.tokens]) {
        const key = `${token.name}\0${token.epoch}\0${token.token}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await leases.assert(token);
      }
    }
  })();
}

const rustEngines = new Set<WeakRef<object>>();

/** A Rust engine opened its store (rust-engine.ts); whether it runs multi-user is read later, from the store. */
export function noteRustEngine(engine: object): void { rustEngines.add(new WeakRef(engine)); }

/**
 * True while some Rust engine of this process has a store open in multi-user mode (`isMultiuser` reads that from the engine).
 * A managed lock taken with no engine at all cannot tell which brain it guards, so it refuses on such a process instead of
 * falling back to a native-only lock.
 */
export function multiuserRustEngineOpen(isMultiuser: (engine: object) => boolean): boolean {
  for (const ref of [...rustEngines]) {
    const engine = ref.deref();
    if (!engine) { rustEngines.delete(ref); continue; }
    if (isMultiuser(engine)) return true;
  }
  return false;
}

/** Re-exported for the lock seam. */
export { leaseLostError };
