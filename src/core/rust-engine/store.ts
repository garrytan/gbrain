/**
 * The Rust brain store handle (rust/README.md, "The brain store"): one `Pool` and one `Brain` of the loaded addon,
 * opened on the brain's directory. `RustEngine.connect` opens it and `disconnect` closes it; every typed member
 * reaches the store through it (rust-engine/store-members/).
 */
import { LATEST_SCHEMA_VERSION } from '../schema-migrations/latest.generated.ts';
import { mapStoreError } from './store-errors.ts';

/** Worker threads the store's pool runs its calls on. One write runs at a time; reads overlap. */
const STORE_POOL_THREADS = 4;
/** How long closing the store waits for calls that are still running (milliseconds). */
const STORE_SHUTDOWN_WAIT_MS = 5_000;

/** The napi `Brain`: every method returns a promise and rejects with an `Error` carrying a `code`. */
export interface StoreBrain {
  readonly isOpen: boolean;
  open(path: string, options?: { schemaVersion?: number; createdBy?: string }): Promise<unknown>;
  close(): Promise<void>;
  // The store's methods are documented in rust/README.md; each member module types what it sends and reads.
  [method: string]: any;
}

interface StorePool { shutdown(waitMs: number): Promise<unknown> }
interface StoreAddon { Pool: new (threads: number) => StorePool; Brain: new (pool: StorePool) => StoreBrain }

/** An open store: the brain and the pool it runs on. */
export interface RustStore {
  readonly brain: StoreBrain;
  close(): Promise<void>;
}

/** Opens (or creates) the brain store at `databasePath`. A second open of the same directory rejects `rust_store_locked`. */
export async function openRustStore(addon: object, databasePath: string): Promise<RustStore> {
  const { Pool, Brain } = addon as StoreAddon;
  const pool = new Pool(STORE_POOL_THREADS);
  const brain = new Brain(pool);
  try {
    await brain.open(databasePath, { schemaVersion: LATEST_SCHEMA_VERSION, createdBy: 'gbrain' });
  } catch (error) {
    await pool.shutdown(0).catch(() => undefined);
    throw mapStoreError(error, { member: 'connect' });
  }
  return {
    brain,
    async close() {
      try { await brain.close(); } finally { await pool.shutdown(STORE_SHUTDOWN_WAIT_MS).catch(() => undefined); }
    },
  };
}
