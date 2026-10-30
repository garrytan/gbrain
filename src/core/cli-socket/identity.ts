/**
 * The brain identity the warm CLI socket is bound to. A serve computes it once
 * when it binds; the CLI computes it per call and sends it in the request. The
 * serve answers only a CLI whose identity matches its own part by part
 * (`cliSocketIdentityMismatch`), so a CLI aimed at another database, another
 * GBRAIN_HOME, another brain (mount), an edited config file, a different
 * read-behavior environment or another gbrain release always takes its own
 * cold path, and the refusal names the part that differed. The socket path
 * alone never decides.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import type { GBrainConfig } from '../config.ts';
import { listRecipes } from '../ai/recipes/index.ts';
import { mergedProviderEnv } from '../ai/provider-env.ts';

/**
 * The GBRAIN_* variables that can change what a socket read (search, query,
 * get, recall) answers or where its text goes. An explicit allow-list:
 * connection sizing and driver tuning (GBRAIN_POOL_SIZE, GBRAIN_PREPARE, ...)
 * never change an answer, so a serve and a CLI may differ there. Variables that
 * only choose a location are compared by what they resolve to, never by whether
 * they are set: GBRAIN_HOME as the config home, GBRAIN_BRAIN_ID as the brain id,
 * the database URL variables as the database target (`DatabaseTarget`). GBRAIN_SOURCE
 * travels in every request and is resolved per call.
 * test/cli-socket.test.ts classifies every GBRAIN_* name in src, so a new one
 * cannot skip this decision.
 */
export const READ_BEHAVIOR_ENV: readonly string[] = [
  'GBRAIN_SEARCH_EXCLUDE', 'GBRAIN_SEARCH_SALVAGE', 'GBRAIN_SEARCH_DEBUG', 'GBRAIN_SOURCE_BOOST', 'GBRAIN_RECENCY_DECAY',
  'GBRAIN_FTS_LANGUAGE', 'GBRAIN_HNSW_ITERATIVE_SCAN', 'GBRAIN_VECTOR_LEGACY_GUARD', 'GBRAIN_PROJECTION_READINESS_CACHE',
  'GBRAIN_REMOTE_PRIVATE_PAGES', 'GBRAIN_RLS_SCOPE_BINDING', 'GBRAIN_STALENESS_CEILING_HOURS', 'GBRAIN_SERVE_DEGRADED',
  'GBRAIN_STATEMENT_TIMEOUT', 'GBRAIN_MAX_REGEX_INPUT_CHARS', 'GBRAIN_SCHEMA_PACK',
  'GBRAIN_CONTENT_SANITY_DISABLED', 'GBRAIN_NO_SANITY', 'GBRAIN_MAX_MARKUP_RATIO',
  'GBRAIN_RETRIEVAL_REFLEX', 'GBRAIN_RETRIEVAL_REFLEX_LEXICAL_ARMS', 'GBRAIN_RETRIEVAL_REFLEX_VOLUNTEER', 'GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS',
  'GBRAIN_DECIDE_SLOTS', 'GBRAIN_MEMORABLE', 'GBRAIN_MEMORABLE_CONFIG', 'GBRAIN_SYNOPSIS_DOC_MAX_CHARS',
  'GBRAIN_MODEL', 'GBRAIN_MODEL_DISCOVERY', 'GBRAIN_CHAT_MODEL', 'GBRAIN_CHAT_FALLBACK_CHAIN', 'GBRAIN_CHAT_FALLBACK_ON_REFUSAL',
  'GBRAIN_EXPANSION_MODEL', 'GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL',
  'GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS', 'GBRAIN_EMBEDDING_MULTIMODAL', 'GBRAIN_EMBEDDING_MULTIMODAL_MODEL',
  'GBRAIN_EMBEDDING_IMAGE_OCR', 'GBRAIN_EMBEDDING_IMAGE_OCR_MODEL', 'GBRAIN_MAX_CHUNK_TOKENS',
  'GBRAIN_QUERY_EMBED_TIMEOUT_MS', 'GBRAIN_AI_EMBED_TIMEOUT_MS', 'GBRAIN_AI_CHAT_TIMEOUT_MS', 'GBRAIN_AI_MULTIMODAL_TIMEOUT_MS',
  'GBRAIN_RECIPES_DIR', 'GBRAIN_PLUGIN_PATH', 'GBRAIN_GUARDRAILS_MODULE', 'GBRAIN_AI_CALL_LOG', 'GBRAIN_CONTRIBUTOR_MODE',
];
/** Provider credentials: only whether each is set enters the identity. Every other provider variable (endpoints, deployments, versions, org/project/group ids) enters with its value. */
const SECRET_PROVIDER_ENV = /(_API_KEY|_TOKEN|_SECRET)$/;
/** Provider env names read outside the recipe registry: the Google alias and the compatibility endpoints. */
const EXTRA_PROVIDER_ENV = ['GEMINI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'];
/**
 * Connection-string parameters that can change what a statement sees
 * (`options` carries `-c search_path=...`, roles and the like). Every other
 * parameter (prepare, sslmode, application_name, timeouts, pooler flags) only
 * tunes the driver or the transport.
 */
const BEHAVIOR_URL_PARAMS = new Set(['options']);
/**
 * Supavisor pooler hosts (the same patterns as connection-manager.ts). One
 * pooler host serves the session lane (5432) and the transaction lane (6543)
 * of every project, and the project is part of the user name, so the same host
 * and user on another port is the same database. On any other host a port is
 * another server.
 */
const POOLER_HOST = /(^|\.)pooler\.supabase\.com$/i;

let providerEnvNames: string[] | undefined;
function providerEnv(): string[] {
  providerEnvNames ??= [...new Set([
    ...listRecipes().flatMap(recipe => [...(recipe.auth_env?.required ?? []), ...(recipe.auth_env?.optional ?? [])]),
    ...EXTRA_PROVIDER_ENV,
  ])].sort();
  return providerEnvNames;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Provider variables that cannot reach any answer from this side: every name belongs only to providers that cannot
 * authenticate here, because one of their required variables is absent from the provider environment the gateway
 * builds (`mergedProviderEnv`: this environment plus the config file's provider fields) and none of their credential
 * variables is set. A provider with no required variable (local servers) and the compatibility endpoints never count.
 * The serve compares such a name only when the other side can use its provider, so a variable of a provider neither
 * side can call (an Azure API version on a brain with no Azure endpoint) no longer sends a CLI to its cold path.
 */
function inertProviderEnv(merged: Record<string, string>): Set<string> {
  const inert = new Set<string>();
  const live = new Set<string>(EXTRA_PROVIDER_ENV);
  for (const recipe of listRecipes()) {
    const required = recipe.auth_env?.required ?? [];
    const names = [...required, ...(recipe.auth_env?.optional ?? [])];
    const callable = required.length === 0 || required.every(name => merged[name] !== undefined)
      || names.some(name => SECRET_PROVIDER_ENV.test(name) && merged[name] !== undefined);
    for (const name of names) (callable ? live : inert).add(name);
  }
  for (const name of live) inert.delete(name);
  return inert;
}

/** The parts of the environment that change what a read answers or where its text goes, each value as a SHA-256 and credentials as names only. */
export interface BehaviorEnv {
  /** READ_BEHAVIOR_ENV names that are set, with the SHA-256 of each value; routing variables (base URLs, endpoints, deployments, ids) of providers this side can call likewise. */
  values: Record<string, string>;
  /** The provider credentials that are set, by name (never the value), for every provider. */
  credentials: string[];
}

/** `fileConfig`: the config file's contents, whose provider fields (keys, the Azure endpoint and deployment) can make a provider callable. */
export function behaviorEnv(env: Record<string, string | undefined>, fileConfig: GBrainConfig | null = null): BehaviorEnv {
  const values: Record<string, string> = {};
  for (const name of READ_BEHAVIOR_ENV) if (env[name] !== undefined) values[name] = sha256(env[name]!);
  const set = providerEnv().filter(name => env[name] !== undefined && env[name] !== '');
  const inert = inertProviderEnv(mergedProviderEnv(fileConfig, env));
  for (const name of set) if (!SECRET_PROVIDER_ENV.test(name) && !inert.has(name)) values[name] = sha256(env[name]!);
  return { values, credentials: set.filter(name => SECRET_PROVIDER_ENV.test(name)) };
}

/** A database URL reduced to what decides which database a read sees: never the password, and query parameters only when they change what a statement sees. */
export interface DatabaseTarget {
  protocol: string;
  host: string;
  port: string;
  database: string;
  user: string;
  params: string;
}

export function databaseTarget(databaseUrl: string): DatabaseTarget {
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { return { protocol: 'unparsed', host: sha256(databaseUrl), port: '', database: '', user: '', params: '' }; }
  const params = [...url.searchParams.entries()]
    .filter(([key]) => BEHAVIOR_URL_PARAMS.has(key))
    .sort(([a, av], [b, bv]) => a === b ? av.localeCompare(bv) : a.localeCompare(b));
  return {
    protocol: url.protocol === 'postgres:' ? 'postgresql:' : url.protocol,
    host: url.hostname.toLowerCase(),
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname) || '/',
    user: decodeURIComponent(url.username),
    params: new URLSearchParams(params).toString(),
  };
}

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return `absent:${path}`; }
}

function readConfigFile(path: string): { digest: string; config: GBrainConfig | null } {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return { digest: 'absent', config: null }; }
  let config: GBrainConfig | null = null;
  try { const parsed: unknown = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as GBrainConfig; } catch { /* the digest still compares it */ }
  return { digest: sha256(text), config };
}

export interface CliSocketIdentityInput {
  /** The serve's: the config its engine connected with. The CLI's: the config it would connect with. */
  config: Pick<GBrainConfig, 'engine' | 'database_url'>;
  /** The resolved brain id (src/core/brain-resolver.ts resolveBrainId). */
  brainId: string;
  configDir: string;
  configFile: string;
  version: string;
  env: Record<string, string | undefined>;
}

export interface CliSocketIdentity {
  version: string;
  brain: string;
  engine: string;
  database: DatabaseTarget | null;
  config_dir: string;
  config_file: string;
  config_sha256: string;
  env: BehaviorEnv;
}

/** The brain id, the database target, the config home and file (realpath and content), the read-behavior env and the gbrain version. */
export function cliSocketIdentity(input: CliSocketIdentityInput): CliSocketIdentity {
  const file = readConfigFile(input.configFile);
  return {
    version: input.version,
    brain: input.brainId,
    engine: input.config.engine,
    database: input.config.database_url ? databaseTarget(input.config.database_url) : null,
    config_dir: realpathOr(input.configDir),
    config_file: realpathOr(input.configFile),
    config_sha256: file.digest,
    env: behaviorEnv(input.env, file.config),
  };
}

/**
 * Null when `cli` may be answered by the serve bound to `serve`; otherwise the
 * first part that differs (`version`, `database port`, `env GBRAIN_MODEL`,
 * `provider key VOYAGE_API_KEY`, ...), named without its value. The database
 * port may differ only on a Supavisor pooler host (POOLER_HOST), where host and
 * user already name the database.
 */
export function cliSocketIdentityMismatch(serve: CliSocketIdentity, cli: CliSocketIdentity): string | null {
  for (const part of ['version', 'brain', 'engine'] as const) if (serve[part] !== cli[part]) return part;
  if (!serve.database || !cli.database) {
    if (serve.database !== cli.database) return 'database';
  } else {
    for (const part of ['protocol', 'host', 'database', 'user', 'params'] as const) {
      if (serve.database[part] !== cli.database[part]) return `database ${part}`;
    }
    if (serve.database.port !== cli.database.port && !POOLER_HOST.test(serve.database.host)) return 'database port';
  }
  if (serve.config_dir !== cli.config_dir) return 'config home';
  if (serve.config_file !== cli.config_file) return 'config file';
  if (serve.config_sha256 !== cli.config_sha256) return 'config contents';
  const names = [...new Set([...Object.keys(serve.env.values), ...Object.keys(cli.env.values)])].sort();
  for (const name of names) if (serve.env.values[name] !== cli.env.values[name]) return `env ${name}`;
  const keys = [...new Set([...serve.env.credentials, ...cli.env.credentials])].sort();
  for (const name of keys) if (serve.env.credentials.includes(name) !== cli.env.credentials.includes(name)) return `provider key ${name}`;
  return null;
}

/** True when `value` has the shape of a CliSocketIdentity (the request validator's check). */
export function isCliSocketIdentity(value: unknown): value is CliSocketIdentity {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!record(value) || !record(value.env) || !record(value.env.values) || !Array.isArray(value.env.credentials)) return false;
  if (!['version', 'brain', 'engine', 'config_dir', 'config_file', 'config_sha256'].every(key => typeof value[key] === 'string')) return false;
  if (!Object.values(value.env.values).every(v => typeof v === 'string') || !value.env.credentials.every(v => typeof v === 'string')) return false;
  const db = value.database;
  return db === null || (record(db) && ['protocol', 'host', 'port', 'database', 'user', 'params'].every(key => typeof db[key] === 'string'));
}
