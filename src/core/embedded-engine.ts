import { engineKey } from './engine-key.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from './ai/defaults.ts';
import { opError } from './ops/contract.ts';
import { setEmbeddedKeyResolver } from './engine-scope-store.ts';

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
  /** `search.keyword_statement_timeout_ms` for this engine (Postgres). */
  keyword_statement_timeout_ms?: number;
  pglite?: { shared_buffers?: string };
  /**
   * This engine's AI gateway: the only providers its embed, chat and rerank calls reach, keyed by provider id
   * (`openai`, `voyage`, ...), and the `provider:model` it uses for chat, expansion and reranking. The embedding
   * model is `embedding` above. Without it every AI call refuses `engine_scope_missing`; no process key is used.
   */
  ai?: EngineAISettings;
  /**
   * Opaque name the host owns for one tenant database incarnation. With it, query embeddings cached for this engine
   * stay warm across reopens of the same brain (tagged by the namespace and a hash of the provider configuration);
   * without it every engine starts cold and its entries go when it closes. Never derive it from the stored brain id:
   * a cloned or restored database shares that.
   */
  cache_namespace?: string;
  /**
   * The object store every file operation on this engine uses, as values: `local` needs `localPath`, `s3` its bucket,
   * endpoint and keys (nothing is read from AWS_* variables or ~/.aws). Every object key is `<prefix>/<path>` when
   * `prefix` (one segment) is set; brains sharing a bucket each set a different prefix. No prefix keeps today's keys.
   */
  storage?: EngineStorageSettings;
}

export interface EngineStorageSettings {
  backend: 'local' | 's3';
  bucket?: string;
  localPath?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
}

export interface EngineAISettings {
  providers: Record<string, { apiKey?: string; baseUrl?: string }>;
  models?: { chat?: string; expansion?: string; reranker?: string };
}

/** The settings `embeddedSettings` returns: everything the host passed except the writer credential and the provider keys. */
type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
export type EmbeddedSettingsView = DeepReadonly<Omit<EngineSettings, 'writer' | 'ai' | 'storage'> & {
  writer?: { id: string; lane: 'cli' | 'stdio' };
  ai?: { providers: Record<string, { baseUrl?: string; hasApiKey: boolean }>; models?: EngineAISettings['models'] };
  storage?: Omit<EngineStorageSettings, 'secretAccessKey'> & { hasSecret: boolean };
}>;

interface EmbeddedRecord {
  hostId: string | undefined;
  settings: EngineSettings | null;
  /** The provider keys it held, kept past disconnect only so a call still in flight can scrub them from its error. */
  releasedKeys?: string[];
}

const parseConnectionUrl = (url: string) => new URL(url.replace(/^postgres(ql)?:\/\//, 'settings://'));

/** Why openEngine refuses a settings URL (not one parseable single-host URL, or no host, user or database name), or undefined. */
export function connectionUrlProblem(url: string): string | undefined {
  let parsed: URL;
  try { parsed = parseConnectionUrl(url); if (parsed.hostname.includes(',')) throw new Error('multi-host'); } catch { return 'is not a parseable single-host connection URL (openEngine reads no multi-host URL)'; }
  const missing = !parsed.hostname ? 'host' : !parsed.username ? 'user' : parsed.pathname.length <= 1 ? 'database name' : undefined;
  return missing && `names no ${missing}, and the driver would fill it from PG* environment variables`;
}

/**
 * postgres.js fills each connection field a URL leaves out from PGHOST, PGPORT, PGUSER, PGPASSWORD or PGDATABASE. A
 * pool opened from settings passes every field explicitly (the password as a function, so an empty one stays empty),
 * so none of those variables picks its server, database or credentials.
 */
export function settingsConnectionOptions(url: string): { host: string; port: number; user: string; password: () => string; database: string } {
  const parsed = parseConnectionUrl(url);
  const password = decodeURIComponent(parsed.password);
  return {
    host: decodeURIComponent(parsed.hostname),
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: () => password,
    database: decodeURIComponent(parsed.pathname.slice(1)),
  };
}

/** Keyed by `engineKey`, so a page-transaction clone, a view and every forwarding proxy over the engine share its record. */
const records = new WeakMap<object, EmbeddedRecord>();
let embeddedProcess = false;
let openEmbeddedEngines = 0;
setEmbeddedKeyResolver(engine => (records.has(engineKey(engine)) ? engineKey(engine) : undefined), processHoldsEmbeddedEngines);

function recordOf(engine: object): EmbeddedRecord | undefined {
  return records.get(engineKey(engine));
}

/** Marks `engine` as opened by `openEngine` with `settings`, and latches the process as one that holds embedded engines. */
export function markEmbeddedEngine(engine: object, settings: EngineSettings): void {
  const id = settings.host?.id;
  const record: EmbeddedRecord = { hostId: typeof id === 'string' && id ? id.toLowerCase() : undefined, settings };
  records.set(engineKey(engine), record);
  embeddedProcess = true;
  openEmbeddedEngines++;
}

/** True for an engine `openEngine` opened, and for its page transactions and read-through views. */
export function isEmbeddedEngine(engine: object): boolean {
  return recordOf(engine) !== undefined;
}

/** True once any `openEngine` call in this process has marked an engine; it never resets. */
export function processHasEmbeddedEngines(): boolean {
  return embeddedProcess;
}

/** True while an embedded engine is open in this process: then an AI call outside any engine scope refuses (engine-gateway.ts). */
export function processHoldsEmbeddedEngines(): boolean {
  return openEmbeddedEngines > 0;
}

/** The host id an embedded engine was opened with; undefined for every other engine. */
export function embeddedHostId(engine: object): string | undefined {
  return recordOf(engine)?.hostId;
}

/** The settings an embedded engine holds until it disconnects, the writer credential included. */
export function embeddedSettingsRecord(engine: object): EngineSettings | undefined {
  return recordOf(engine)?.settings ?? undefined;
}

/** A frozen copy of the settings an embedded engine was opened with, without the writer credential or provider keys; undefined after disconnect. */
export function embeddedSettings(engine: object): EmbeddedSettingsView | undefined {
  const settings = embeddedSettingsRecord(engine);
  if (!settings) return undefined;
  const { writer, ai, storage, ...rest } = settings;
  const providers = ai && Object.fromEntries(Object.entries(ai.providers)
    .map(([id, p]) => [id, { ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), hasApiKey: !!p.apiKey }]));
  const view = structuredClone({ ...rest, ...(writer ? { writer: { id: writer.id, lane: writer.lane } } : {}),
    ...(ai ? { ai: { providers: providers!, ...(ai.models ? { models: { ...ai.models } } : {}) } } : {}),
    ...(storage ? { storage: (({ secretAccessKey, ...open }) => ({ ...open, hasSecret: !!secretAccessKey }))(storage) } : {}) });
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  freeze(view);
  return view;
}

/** Drops the settings (the writer credential included) an embedded engine held; it stays marked embedded with its host id. */
export function releaseEmbeddedEngine(engine: object): void {
  const record = recordOf(engine);
  if (!record?.settings) return;
  openEmbeddedEngines--;
  record.releasedKeys = Object.values(record.settings.ai?.providers ?? {}).flatMap(provider => provider.apiKey ? [provider.apiKey] : []);
  record.settings = null;
}

/** The provider keys an embedded engine held before it disconnected; empty while it is open. */
export function releasedEngineKeys(engine: object): readonly string[] {
  return recordOf(engine)?.releasedKeys ?? [];
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
