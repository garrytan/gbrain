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
  /**
   * Copies one batch of a primary relation into this store for the shadow seed (rust/docs/store/seed.md).
   * Every value is the column's text form (`::text`, UTC) or null. Not a BrainEngine member.
   */
  importRelation(seedId: string, relation: string, rows: SeedRow[]): Promise<SeedImportResult>;
  /**
   * The seed plan: the relations `importRelation` takes in import order (with the key columns to read each
   * by), the tables carried inside them, and the tables the seed leaves behind on purpose. Any other primary
   * table is a gap (rust/docs/store/seed.md).
   */
  seedPlan(): Promise<SeedPlan>;
  close(): Promise<void>;
}

/** One primary row: column name to its `::text` value, or null. */
export type SeedRow = Record<string, string | null>;

/** One relation of the seed plan: the primary table and its primary key columns. */
export interface SeedRelationPlan {
  relation: string;
  key: string[];
}

/** A primary table the seed leaves behind on purpose, and the read that differs on the seeded store. */
export interface SeedNotCopied {
  table: string;
  kind: 'jobs' | 'telemetry' | 'cache' | 'machine_local' | 'segmented_body';
  read: string;
  /** Rows of the table that are brain state: counted as the gap `gap`, not lost. */
  gap_rows: { gap: string; column: string; equals: string } | null;
}

export interface SeedPlan {
  relations: SeedRelationPlan[];
  /** `[table, relation]`: a table whose rows ride in the rows of `relation`. */
  carried: [string, string][];
  not_copied: SeedNotCopied[];
  /** Columns of copied relations the store cannot keep yet: a non-null value is the gap `gap`. */
  gap_columns: SeedGapColumn[];
}

export interface SeedGapColumn {
  table: string;
  column: string;
  gap: string;
}

/** What one `importRelation` batch did. `losses` counts values the store could not keep, by kind. */
export interface SeedImportResult {
  imported: number;
  skipped: number;
  dropped: number;
  unmapped_columns: string[];
  losses: Record<string, number>;
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
    async importRelation(seedId, relation, rows) {
      try {
        return await brain.importRelation(seedId, relation, rows) as SeedImportResult;
      } catch (error) {
        throw mapStoreError(error, { member: 'importRelation' });
      }
    },
    async seedPlan() {
      try {
        return await brain.seedPlan() as SeedPlan;
      } catch (error) {
        throw mapStoreError(error, { member: 'seedPlan' });
      }
    },
    async close() {
      try { await brain.close(); } finally { await pool.shutdown(STORE_SHUTDOWN_WAIT_MS).catch(() => undefined); }
    },
  };
}
