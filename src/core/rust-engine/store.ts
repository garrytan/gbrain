/**
 * The Rust brain store handle (rust/README.md, "The brain store"): one `Pool` and one `Brain` of the loaded addon,
 * opened on the brain's directory. `RustEngine.connect` opens it and `disconnect` closes it; every typed member
 * reaches the store through it (rust-engine/store-members/).
 */
import { LATEST_SCHEMA_VERSION } from '../schema-migrations/latest.generated.ts';
import { embeddedSchemaEmbedding } from '../embedded-engine.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../ai/defaults.ts';
import { WRITE_GATE_DETECTOR_VERSION } from '../write-gate-schema.ts';
import { mapStoreError } from './store-errors.ts';
import { rustMultiuserFromEnv, rustMultiuserSubSwitch } from './multiuser-switch.ts';
import type { RestoreCensus, RestoreQuarantinePlan, RestoreQuarantineReport } from './restore-types.ts';

/** Worker threads the store's pool runs its calls on. One write runs at a time; reads overlap. */
const STORE_POOL_THREADS = 4;
/** How long closing the store waits for calls that are still running (milliseconds). */
const STORE_SHUTDOWN_WAIT_MS = 5_000;

/** What `Brain#open` takes. The embedding rows and `chunkStrategy` are written only when the open creates the brain. */
export interface StoreOpenOptions {
  schemaVersion?: number;
  createdBy?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  chunkStrategy?: string;
  /** A fresh brain records the write gate's scan baseline under this detector version. */
  writeGateDetectorVersion?: number;
  /** Multi-user mode from the environment (I-0, multiuser-switch.ts); sent only when true, so an open with the switch off is unchanged. */
  multiuser?: boolean;
  /** Multi-user sub-switches (`GBRAIN_RUST_COMMIT_LOG=1`, `GBRAIN_RUST_WRITE_ORIGIN=1`), sent only when set; the store applies them only in multi-user mode. */
  commitLog?: boolean;
  writeOrigin?: boolean;
  /** This machine's host id, the write origin the sub-switches stamp; sent only with one of them. */
  hostId?: string;
}

/** The start of the store's refusal of a multi-user open whose write origin names no machine (`gbrain_store::HOST_ID_REQUIRED`). */
const HOST_ID_REQUIRED_TEXT = "multi-user write origin needs this machine's host id";

/** The answer a sub-switch is read under before the open resolves the brain's mode: the store decides (I-0.v2). */
const MODE_MAY_BE_ON = { multiuser: true } as const;

/** The strategy the SQL engines' schema seeds as config `chunk_strategy` (src/schema.sql). */
const SEED_CHUNK_STRATEGY = 'semantic';

/**
 * The embedding identity a fresh brain records, resolved the way the SQL engines' `initSchema` resolves it:
 * `settings.embedding` of an embedded engine, else the configured gateway, else the shipped defaults.
 */
export async function seedEmbeddingIdentity(engine: object): Promise<{ model: string; dimensions: number }> {
  const embedded = embeddedSchemaEmbedding(engine);
  if (embedded) return { model: embedded.model, dimensions: embedded.dimensions };
  try {
    // Lazy like the SQL engines: the gateway closure is large, and both accessors throw when it is unconfigured.
    const gw = await import('../ai/gateway.ts'); // engine-dynamic-import-ok
    return { model: gw.getEmbeddingModel(), dimensions: gw.getEmbeddingDimensions() };
  } catch {
    return { model: DEFAULT_EMBEDDING_MODEL, dimensions: DEFAULT_EMBEDDING_DIMENSIONS };
  }
}

/** The napi `Brain`: every method returns a promise and rejects with an `Error` carrying a `code`. */
export interface StoreBrain {
  readonly isOpen: boolean;
  open(path: string, options?: StoreOpenOptions): Promise<unknown>;
  close(): Promise<void>;
  // The store's methods are documented in rust/README.md; each member module types what it sends and reads.
  [method: string]: any;
}

interface StorePool { shutdown(waitMs: number): Promise<unknown> }
interface StoreAddon { Pool: new (threads: number) => StorePool; Brain: new (pool: StorePool) => StoreBrain }

/** An open store: the brain and the pool it runs on. */
export interface RustStore {
  readonly brain: StoreBrain;
  /** True when the store runs in multi-user mode (I-0): the environment switch or the brain's own config row. */
  readonly multiuser: boolean;
  /** True when the store keeps a commit log (multi-user mode): the engine then reports `commit_log`. */
  readonly commitLog: boolean;
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
  /** Raises every id counter so its next id is above the floor (the primary's highest id per relation); never lowers one. Resolves the allocatorCheck report taken after the write. */
  allocatorAdvance(seedId: string, primaryFloor: Record<string, string | null>): Promise<SeedAllocatorCheck[]>;
  /** The store's fact fingerprints of `texts`: the normalized one and the earlier raw-text one. */
  factFingerprints(texts: string[]): Promise<FactFingerprints[]>;
  /**
   * The seed plan: the relations `importRelation` takes in import order (with the key columns to read each
   * by), the tables carried inside them, and the tables the seed leaves behind on purpose. Any other primary
   * table is a gap (rust/docs/store/seed.md).
   */
  seedPlan(): Promise<SeedPlan>;
  /**
   * Copies the open brain at one committed generation into the new directory `target` (rust/docs/store/snapshot.md).
   * Writers are never blocked and none of their later commits is in the copy. Resolves the manifest, or rejects, only
   * after the Rust call has returned: the read of the brain is released and a cancelled or failed copy has removed
   * what it wrote. Rejects `snapshot_cancelled` after `snapshotCancel(opId)`, `invalid_argument` for a target that
   * exists, sits under a symbolic link or overlaps the brain, `invalid_state` for an `opId` already running.
   */
  snapshotTo(target: string, options: StoreSnapshotOptions): Promise<StoreSnapshotManifest>;
  /** Asks the snapshot `opId` to stop; true when one was running. It returns at once and does not wait for the copy. */
  snapshotCancel(opId: string): boolean;
  /**
   * `gbrain backup restore` only (not a BrainEngine member): one read of what could still run in a restored store, the
   * authority it holds and the settings a restore changes, with the named `blockers` that refuse a publish. An addon built
   * before the restore step lacks it (`restoreAddonSupportsSafety`).
   */
  restoreCensus(purgeRequestIds: string[]): Promise<RestoreCensus>;
  /**
   * `gbrain backup restore` only: detaches sources, rebases managed paths and origins, turns off automation settings,
   * cancels unfinished jobs, in one write transaction. It revokes nothing: a live OAuth client or local writer is the
   * blocker `archived_authority`. Rejects `restore_refused` while a blocker stands, `invalid_argument` when the plan
   * does not match the store and `invalid_state` for a restore id already applied; each leaves the store as it was.
   */
  restoreQuarantine(plan: RestoreQuarantinePlan): Promise<RestoreQuarantineReport>;
  close(): Promise<void>;
}

/** What `snapshotTo` takes. The two test seams only slow a copy down so a test can reach its middle. */
export interface StoreSnapshotOptions {
  /** 1 to 128 letters, digits, `.`, `_` or `-`; names the call for `snapshotCancel`. */
  opId: string;
  /** Test seam: pause this many milliseconds (at most 1000) after every batch. */
  batchDelayMs?: number;
  /** Test seam: end a batch at this many bytes (at least 4096) instead of 64 MiB. */
  batchBytes?: number;
}

/** Count and digest of the keys under one tag byte (two lowercase hex digits). */
export interface StoreTagDigest { keys: number; sha256: string }

/** What `SNAPSHOT.json` holds and `snapshotTo` resolves; every field but `created_at_us` is compared by `verifyStoreDir`. */
export interface StoreSnapshotManifest {
  version: number;
  brain_id: string;
  /** The commit sequence the copy was taken at. */
  generation: number;
  engine_format_version: number;
  schema_version: number;
  keys: number;
  bytes: number;
  tags: Record<string, StoreTagDigest>;
  /** Only for a store that holds a seed: the digest of each seeded relation. */
  relations?: Record<string, { rows: number; sha256: string }>;
  created_at_us: number;
}

/** What `verifyStoreDir` found. `mismatches` holds codes (`generation`, `tag_digest:50`, ...), never a key or a value. */
export interface StoreVerifyReport {
  /** `integrity`: redb's own checks refused the file; the other fields are then what was read before that. */
  verdict: 'ok' | 'mismatch' | 'integrity';
  integrity: string | null;
  brain_id: string | null;
  generation: number | null;
  engine_format_version: number | null;
  format_file_version: number | null;
  schema_version: number | null;
  keys: number;
  bytes: number;
  tags: Record<string, StoreTagDigest>;
  relations: Record<string, { rows: number; sha256: string }> | null;
  keyword_index: { state: 'complete' | 'incomplete' | 'absent'; cursor: number | null; pages_checked: number; ok: boolean } | null;
  mismatches: string[];
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

/**
 * Opens (or creates) the brain store at `databasePath`. A second open of the same directory rejects `rust_store_locked`.
 * A created brain records `embedding` as its embedding identity; an existing brain keeps its own.
 */
export async function openRustStore(
  addon: object,
  databasePath: string,
  embedding?: { model: string; dimensions: number },
  origin?: { hostId?: string; mint?: () => string },
  opts: { createMissing?: boolean } = {},
): Promise<RustStore> {
  const { Pool, Brain } = addon as StoreAddon;
  const pool = new Pool(STORE_POOL_THREADS);
  const brain = new Brain(pool);
  let multiuser = false;
  let commitLog = false;
  try {
    // The commit log and write origin sub-switches, sent only when set: an open without them sends what it always
    // sent. The brain's mode is resolved by this very open (the switch or its config row), so they go as requests the
    // store applies only when it resolves the mode on (I-0.v2). The host id comes from the caller (`origin`), which
    // reads it only when the switch itself is on or a sub-switch is set.
    const commitLogOn = rustMultiuserSubSwitch('GBRAIN_RUST_COMMIT_LOG', MODE_MAY_BE_ON);
    const writeOriginOn = rustMultiuserSubSwitch('GBRAIN_RUST_WRITE_ORIGIN', MODE_MAY_BE_ON);
    const writes = (hostId: string | undefined) => ({
      ...(commitLogOn ? { commitLog: true } : {}),
      ...(writeOriginOn ? { writeOrigin: true } : {}),
      ...((commitLogOn || writeOriginOn) && hostId ? { hostId } : {}),
    });
    const base = {
      schemaVersion: LATEST_SCHEMA_VERSION, createdBy: 'gbrain', chunkStrategy: SEED_CHUNK_STRATEGY,
      writeGateDetectorVersion: WRITE_GATE_DETECTOR_VERSION,
      ...(embedding ? { embeddingModel: embedding.model, embeddingDimensions: embedding.dimensions } : {}),
      ...(rustMultiuserFromEnv() ? { multiuser: true } : {}),
      // Sent only when the store must already be there, so every other open sends what it always sent.
      ...(opts.createMissing === false ? { createMissing: false } : {}),
    };
    let info: { multiuser?: unknown; commit_log?: unknown } | null;
    try {
      info = await brain.open(databasePath, { ...base, ...writes(origin?.hostId) }) as typeof info;
    } catch (error) {
      // The store resolved multi-user mode on (its config row) and write origin needs this machine's id, which was not
      // sent because the mode was not known before the open: name the machine now and open again. Nothing was written.
      const needsHost = (writeOriginOn || commitLogOn) && !origin?.hostId && origin?.mint
        && String((error as { message?: unknown } | null)?.message ?? '').includes(HOST_ID_REQUIRED_TEXT);
      if (!needsHost) throw error;
      info = await brain.open(databasePath, { ...base, ...writes(origin!.mint!()) }) as typeof info;
    }
    multiuser = info?.multiuser === true;
    commitLog = info?.commit_log === true;
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
    multiuser,
    commitLog,
    importRelation: (seedId, relation, rows, digests) => call('importRelation', () => brain.importRelation(seedId, relation, rows, digests ?? null)),
    replaceRelationRows: (seedId, relation, generation, keys, rows, digests) =>
      call('replaceRelationRows', () => brain.replaceRelationRows(seedId, relation, generation, keys, rows, digests)),
    replaceInterval: (seedId, relation, generation, lo, hi, rows, digests) =>
      call('replaceInterval', () => brain.replaceInterval(seedId, relation, generation, lo, hi, rows, digests)),
    relationDigest: (seedId, relation, lo, hi) => call('relationDigest', () => brain.relationDigest(seedId, relation, lo, hi)),
    relationEntries: (seedId, relation, lo, hi, limit) => call('relationEntries', () => brain.relationEntries(seedId, relation, lo, hi, limit)),
    allocatorCheck: (seedId, primaryMax) => call('allocatorCheck', () => brain.allocatorCheck(seedId, primaryMax)),
    allocatorAdvance: (seedId, primaryFloor) => call('allocatorAdvance', () => brain.allocatorAdvance(seedId, primaryFloor)),
    factFingerprints: (texts) => call('factFingerprints', () => brain.factFingerprints(texts)),
    seedPlan: () => call('seedPlan', () => brain.seedPlan()),
    snapshotTo: (target, options) => call('snapshotTo', () => brain.snapshotTo(target, { v: 1, ...options })),
    snapshotCancel: opId => {
      if (typeof brain.snapshotCancel !== 'function') throw mapStoreError(new Error('this addon has no snapshotCancel'), { member: 'snapshotCancel' });
      return brain.snapshotCancel(opId) as boolean;
    },
    restoreCensus: (purgeRequestIds) => call('restoreCensus', () => brain.restoreCensus(purgeRequestIds)),
    restoreQuarantine: (plan) => call('restoreQuarantine', () => brain.restoreQuarantine(plan)),
    async close() {
      try { await brain.close(); } finally { await pool.shutdown(STORE_SHUTDOWN_WAIT_MS).catch(() => undefined); }
    },
  };
}

/**
 * Reads the brain directory `dir` (a snapshot target, or the copy of a stopped store) without opening it the normal
 * way, so no format upgrade, repair or keyword index build can change it before it is compared. `expected` is the
 * manifest `snapshotTo` returned; without it the report states what the directory holds (rust/docs/store/snapshot.md,
 * "Verifying a copy"). A damaged file is the `integrity` verdict, not a rejection; a file that is missing or was not
 * closed cleanly rejects `rust_store_unreadable`.
 */
export async function verifyStoreDir(addon: object, dir: string, expected?: StoreSnapshotManifest): Promise<StoreVerifyReport> {
  const { Pool } = addon as { Pool: new (threads: number) => StorePool & { verifyStoreDir?: (dir: string, options: object) => Promise<unknown> } };
  const pool = new Pool(1);
  try {
    if (typeof pool.verifyStoreDir !== 'function') throw new Error('this addon has no verifyStoreDir');
    return await pool.verifyStoreDir(dir, { v: 1, ...(expected ? { expected } : {}) }) as StoreVerifyReport;
  } catch (error) {
    throw mapStoreError(error, { member: 'verifyStoreDir' });
  } finally {
    await pool.shutdown(STORE_SHUTDOWN_WAIT_MS).then(() => undefined, () => undefined);
  }
}
