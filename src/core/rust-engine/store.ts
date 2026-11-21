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
  importRelation(seedId: string, relation: string, rows: SeedRow[], digests?: SeedDigest[]): Promise<SeedImportResult>;
  /**
   * Applies one batch of the primary's changes to a relation: the rows `keys` name are stored (with the digests in
   * `digests`, by sort key) or, when `rows` has none for a key, deleted. One write transaction; an entry written at a
   * later `generation` than this call's is left as it is (`skipped_older`). Rejects `invalid_state` for another
   * seed's store and `unsupported` for a relation whose rows cannot be removed (rust/docs/store/seed.md, "Follow
   * and reconcile").
   */
  replaceRelationRows(
    seedId: string, relation: string, generation: number, keys: SeedFollowKey[], rows: SeedRow[], digests: SeedDigest[],
  ): Promise<SeedFollowResult>;
  /**
   * Makes the rows with a sort key in `[lo, hi)` (hex; null is unbounded) exactly `rows`: other entries in the
   * interval are deleted. Atomic.
   */
  replaceInterval(
    seedId: string, relation: string, generation: number, lo: string | null, hi: string | null,
    rows: SeedRow[], digests: SeedDigest[],
  ): Promise<SeedFollowResult>;
  /** The entry count and digest of the digest entries with a sort key in `[lo, hi)` (hex; null is unbounded). */
  relationDigest(seedId: string, relation: string, lo: string | null, hi: string | null): Promise<SeedIntervalDigest>;
  /**
   * The digest entries with a sort key in `[lo, hi)` (hex; null is unbounded), in sort order, at most `limit`
   * (1 to 5000; anything else is `invalid_argument`).
   */
  relationEntries(
    seedId: string, relation: string, lo: string | null, hi: string | null, limit: number,
  ): Promise<SeedEntry[]>;
  /**
   * For every relation whose import raises an id counter: the store's next id against `primaryMax[relation]`, the
   * primary's highest integer id as text (null or absent when its table is empty). A relation with no counter is
   * not reported; an unknown relation in `primaryMax` is `invalid_argument`.
   */
  allocatorCheck(seedId: string, primaryMax: Record<string, string | null>): Promise<SeedAllocatorCheck[]>;
  /** The store's fact fingerprints of `texts`: the normalized one and the earlier raw-text one. */
  factFingerprints(texts: string[]): Promise<FactFingerprints[]>;
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
  /** Whether `replaceRelationRows` can delete this relation's rows. `false`: it rejects `unsupported`. */
  removable: boolean;
}

/** A row's sort key and digest, both lowercase hex (src/shadow/follow-digest.ts). */
export interface SeedDigest {
  sort: string;
  digest: string;
}

/** A primary key `replaceRelationRows` applies: its sort key (hex) and its columns' `::text` values. */
export interface SeedFollowKey {
  sort: string;
  key: Record<string, string>;
}

/** What `replaceRelationRows` and `replaceInterval` did. */
export interface SeedFollowResult {
  upserted: number;
  deleted: number;
  /** Entries left as they were: written at a later generation than the call's. */
  skipped_older: number;
  /**
   * Stored rows removed because a row of the call took a unique natural key they held (two chunks trading
   * `chunk_index`). Their digest entries are gone too, so the relation differs from the primary until a reconcile
   * restores them: mark it dirty when this is above zero.
   */
  displaced: number;
  dropped: number;
  unmapped_columns: string[];
  losses: Record<string, number>;
}

export interface SeedIntervalDigest {
  rows: number;
  /** Lowercase hex sha256. */
  digest: string;
}

export interface SeedEntry {
  /** Lowercase hex of the sort key. */
  sort: string;
  /** Lowercase hex of the 32-byte row digest. */
  digest: string;
  /** The generation of the call that last wrote the entry (0: the import). */
  generation: number;
}

export interface SeedAllocatorCheck {
  relation: string;
  /** The id the store hands out next, as text. */
  counter: string;
  /** The primary's highest id, as text; null when its table is empty. */
  primary_max: string | null;
  /** The counter is above the primary's highest id (true when the table is empty). */
  ok: boolean;
}

export interface FactFingerprints {
  fingerprint: string;
  fingerprint_v1: string;
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
  /** Runs one addon call, mapping its failure to the store error `member` names. */
  const call = async <T>(member: string, run: () => Promise<unknown>): Promise<T> => {
    try {
      return await run() as T;
    } catch (error) {
      throw mapStoreError(error, { member });
    }
  };
  return {
    brain,
    importRelation: (seedId, relation, rows, digests) => call('importRelation', () => brain.importRelation(seedId, relation, rows, digests ?? null)),
    replaceRelationRows: (seedId, relation, generation, keys, rows, digests) =>
      call('replaceRelationRows', () => brain.replaceRelationRows(seedId, relation, generation, keys, rows, digests)),
    replaceInterval: (seedId, relation, generation, lo, hi, rows, digests) =>
      call('replaceInterval', () => brain.replaceInterval(seedId, relation, generation, lo, hi, rows, digests)),
    relationDigest: (seedId, relation, lo, hi) => call('relationDigest', () => brain.relationDigest(seedId, relation, lo, hi)),
    relationEntries: (seedId, relation, lo, hi, limit) => call('relationEntries', () => brain.relationEntries(seedId, relation, lo, hi, limit)),
    allocatorCheck: (seedId, primaryMax) => call('allocatorCheck', () => brain.allocatorCheck(seedId, primaryMax)),
    factFingerprints: (texts) => call('factFingerprints', () => brain.factFingerprints(texts)),
    seedPlan: () => call('seedPlan', () => brain.seedPlan()),
    async close() {
      try { await brain.close(); } finally { await pool.shutdown(STORE_SHUTDOWN_WAIT_MS).catch(() => undefined); }
    },
  };
}
