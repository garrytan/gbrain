/**
 * The Rust brain store handle (rust/README.md, "The brain store"): one `Pool` and one `Brain` of the loaded addon,
 * opened on the brain's directory. `RustEngine.connect` opens it and `disconnect` closes it; every typed member
 * reaches the store through it (rust-engine/store-members/).
 */
import { LATEST_SCHEMA_VERSION } from '../schema-migrations/latest.generated.ts';
import { embeddedSchemaEmbedding } from '../embedded-engine.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../ai/defaults.ts';
import { mapStoreError } from './store-errors.ts';

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
}

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
  close(): Promise<void>;
}

/**
 * Opens (or creates) the brain store at `databasePath`. A second open of the same directory rejects `rust_store_locked`.
 * A created brain records `embedding` as its embedding identity; an existing brain keeps its own.
 */
export async function openRustStore(addon: object, databasePath: string, embedding?: { model: string; dimensions: number }): Promise<RustStore> {
  const { Pool, Brain } = addon as StoreAddon;
  const pool = new Pool(STORE_POOL_THREADS);
  const brain = new Brain(pool);
  try {
    await brain.open(databasePath, {
      schemaVersion: LATEST_SCHEMA_VERSION, createdBy: 'gbrain', chunkStrategy: SEED_CHUNK_STRATEGY,
      ...(embedding ? { embeddingModel: embedding.model, embeddingDimensions: embedding.dimensions } : {}),
    });
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
