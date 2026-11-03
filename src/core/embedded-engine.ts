import { engineKey } from './engine-key.ts';
import type { StorageConfig } from './storage.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from './ai/defaults.ts';
import { opError } from './ops/contract.ts';

/**
 * The value an embedding host passes to `openEngine` (engine-open.ts). Nothing in it is read from a config file, an
 * environment variable, the home directory or the working directory: a host that keeps those reads them itself and
 * builds this object, one per brain.
 */
export interface EngineSettings {
  /** Must be `true`. `openEngine` refuses every other value (`embedded_core_required`); the setting is off by default. */
  embedded_core: boolean;
  engine: 'postgres' | 'pglite';
  /** Postgres: `url`, and `directUrl` for the direct (DDL/session) pool. PGLite: `path`, or none for an in-memory brain. */
  database: { url?: string; directUrl?: string; path?: string };
  /** Postgres only: this engine's own pool size (default 4). */
  pool?: { max?: number };
  /** The persistence host identity this engine claims and publishes under: a UUID. Required. */
  host: { id: string };
  /** The local writer the host holds as a value. Unauthenticated writes use it; no credential file is read. */
  writer?: { id: string; credential: string; lane: 'cli' | 'stdio' };
  /** The embedding identity `initSchema()` seeds a fresh brain with and checks an existing one against. */
  embedding?: { model: string; dimensions: number };
  /** The file storage backend and the host's object prefix, carried for the file operations. */
  storage?: StorageConfig;
  storagePrefix?: string;
  /** `search.keyword_statement_timeout_ms` for this engine (Postgres). */
  keyword_statement_timeout_ms?: number;
  pglite?: { shared_buffers?: string };
  /** AI provider settings for this engine; opaque here and recorded as given. */
  ai?: Record<string, unknown>;
}

/** The settings `embeddedSettings` returns: everything the host passed except the writer credential. */
export type EmbeddedSettingsView = Readonly<Omit<EngineSettings, 'writer'> & { writer?: { id: string; lane: 'cli' | 'stdio' } }>;

interface EmbeddedRecord {
  hostId: string | undefined;
  settings: EngineSettings | null;
}

const records = new WeakMap<object, EmbeddedRecord>();
/**
 * The same record as a non-enumerable property of the engine, so a forwarding proxy that is not a registered view
 * (a batch's shared-read cache, an authority read cache) still reads it through its target.
 */
const RECORD = Symbol('gbrain.embeddedEngine');
/** Every record `markEmbeddedEngine` issued, so an object that answers any property (a test double) is never read as one. */
const issued = new WeakSet<EmbeddedRecord>();
let embeddedProcess = false;

function recordOf(engine: object): EmbeddedRecord | undefined {
  const viaProperty = (engine as { [RECORD]?: EmbeddedRecord })[RECORD];
  return records.get(engineKey(engine)) ?? (viaProperty && issued.has(viaProperty) ? viaProperty : undefined);
}

/** Marks `engine` as opened by `openEngine` with `settings`, and latches the process as one that holds embedded engines. */
export function markEmbeddedEngine(engine: object, settings: EngineSettings): void {
  const id = settings.host?.id;
  const record: EmbeddedRecord = { hostId: typeof id === 'string' && id ? id.toLowerCase() : undefined, settings };
  issued.add(record);
  records.set(engineKey(engine), record);
  Object.defineProperty(engine, RECORD, { value: record });
  embeddedProcess = true;
}

/** True for an engine `openEngine` opened, and for its page transactions and read-through views. */
export function isEmbeddedEngine(engine: object): boolean {
  return recordOf(engine) !== undefined;
}

/** True once any `openEngine` call in this process has marked an engine; it never resets. */
export function processHasEmbeddedEngines(): boolean {
  return embeddedProcess;
}

/** The host id an embedded engine was opened with; undefined for every other engine. */
export function embeddedHostId(engine: object): string | undefined {
  return recordOf(engine)?.hostId;
}

/** The settings an embedded engine holds until it disconnects, the writer credential included. */
export function embeddedSettingsRecord(engine: object): EngineSettings | undefined {
  return recordOf(engine)?.settings ?? undefined;
}

/** The settings an embedded engine was opened with, without the writer credential; undefined after disconnect. */
export function embeddedSettings(engine: object): EmbeddedSettingsView | undefined {
  const settings = embeddedSettingsRecord(engine);
  if (!settings) return undefined;
  const { writer, ...rest } = settings;
  return Object.freeze({ ...rest, ...(writer ? { writer: { id: writer.id, lane: writer.lane } } : {}) });
}

/** Drops the settings (credentials, AI keys, storage) an embedded engine held; it stays marked embedded with its host id. */
export function releaseEmbeddedEngine(engine: object): void {
  const record = recordOf(engine);
  if (record) record.settings = null;
}

/**
 * The embedding identity `initSchema()` seeds an embedded engine's fresh brain with: `settings.embedding`, else the
 * built-in defaults, never the process gateway or the config file. Undefined for every other engine.
 */
export function embeddedSchemaEmbedding(engine: object): { model: string; dimensions: number; given: boolean } | undefined {
  if (!isEmbeddedEngine(engine)) return undefined;
  const given = embeddedSettingsRecord(engine)?.embedding;
  return given ? { model: given.model, dimensions: given.dimensions, given: true }
    : { model: DEFAULT_EMBEDDING_MODEL, dimensions: DEFAULT_EMBEDDING_DIMENSIONS, given: false };
}

/** An existing database must record the embedding identity the settings name; `initSchema()` changes nothing otherwise. */
export function assertEmbeddedEmbedding(want: { model: string; dimensions: number; given: boolean }, stored: { model: string | null; dimensions: number }): void {
  if (!want.given || (stored.model === want.model && stored.dimensions === want.dimensions)) return;
  throw opError('engine_embedding_mismatch', 'The database records another embedding model or width than settings.embedding.',
    `This database's vector column is ${stored.dimensions} wide for ${stored.model ?? 'an unrecorded model'}, and the engine was opened with ${want.model} at ${want.dimensions}, so initSchema changed nothing. Pass the recorded model and width in settings.embedding, or read the recorded identity on the brain host with gbrain migrate embeddings --status --json and preview a migration from there. Changing the width is a re-embed the user decides on.`);
}
