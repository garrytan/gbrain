/**
 * Leases with epochs and fencing for the multi-user Rust build (interface I-5; rust/crates/gbrain-store/src/leases.rs).
 * Not BrainEngine members: the SQL engines fence with their own row locks and tokens, and only a Rust brain in
 * multi-user mode needs a lease the store checks at commit. Callers reach them through `rustLeases(engine)`.
 *
 * - `acquire(name, holder, ttlMs)`: the token `{ name, epoch, token }`, or null while another holder's lease is live
 *   (never an error, never a busy wait). Every takeover raises the epoch.
 * - `renew(lease, ttlMs)`, `release(lease)`, `read(name)`, `assert(lease)`.
 * - A fence that fails rejects `lease_lost` (error registry), with `reason` one of `LEASE_LOST_REASONS`.
 *
 * Expiry is judged on the clock of the process that runs the store; a caller's clock is never sent.
 */
import type { LeaseToken } from '../../engine-sql/lease-token.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';

/** Who holds a lease (interface I-3). `host_id` is the machine id from host.json, never a hostname. */
export interface WriteOrigin { host_id: string; incarnation: string; writer_id: string }

/** What a holder keeps and shows on every protected write (defined with the engine types, which name it in their options). */
export type { LeaseToken };

/** A stored lease, without its token. */
export interface LeaseState {
  name: string; epoch: number; holder: WriteOrigin; acquired_at_us: number; renewed_at_us: number; expires_at_us: number;
  released: boolean; live: boolean;
}

export { LEASE_LOST_REASONS, type LeaseLostReason } from '../store-errors.ts';

export interface RustLeases {
  acquire(name: string, holder: WriteOrigin, ttlMs: number): Promise<LeaseToken | null>;
  /** The next epoch of `name` when its record is still at `expectedEpoch` (the caller proved that holder dead), else null. */
  takeOver(name: string, expectedEpoch: number, holder: WriteOrigin, ttlMs: number): Promise<LeaseToken | null>;
  renew(lease: LeaseToken, ttlMs: number): Promise<void>;
  release(lease: LeaseToken): Promise<void>;
  read(name: string): Promise<LeaseState | null>;
  /** Inside a transaction-bound engine, one statement of that transaction, so the check holds at its commit. */
  assert(lease: LeaseToken): Promise<void>;
}

/** The lease members over one store brain. */
export function leasesOn(brain: StoreBrain): RustLeases {
  return {
    acquire: (name, holder, ttlMs) =>
      storeCall({ member: 'acquireLease' }, () => brain.acquireLease({ name, holder, ttl_ms: ttlMs })) as Promise<LeaseToken | null>,
    takeOver: (name, expectedEpoch, holder, ttlMs) =>
      storeCall({ member: 'takeOverLease' }, () => brain.takeOverLease({ name, expected_epoch: expectedEpoch, holder, ttl_ms: ttlMs })) as Promise<LeaseToken | null>,
    renew: async (lease, ttlMs) => { await storeCall({ member: 'renewLease' }, () => brain.renewLease({ lease, ttl_ms: ttlMs })); },
    release: async (lease) => { await storeCall({ member: 'releaseLease' }, () => brain.releaseLease(lease)); },
    read: (name) => storeCall({ member: 'readLease' }, () => brain.readLease(name)) as Promise<LeaseState | null>,
    assert: async (lease) => { await storeCall({ member: 'assertLease' }, () => brain.assertLease(lease)); },
  };
}

/** The lease members of a Rust engine (or of a transaction-bound clone of one, whose calls run in its transaction). */
export function rustLeases(engine: { openStore(member: string): { brain: StoreBrain } }): RustLeases {
  return leasesOn(engine.openStore('leases').brain);
}
