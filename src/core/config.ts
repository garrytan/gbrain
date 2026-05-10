import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EngineConfig } from './types.ts';

/**
 * Where is the active DB URL coming from? Pure introspection, no connection
 * attempt. Used by `gbrain doctor --fast` so the user gets a precise message
 * instead of the misleading "No database configured" when GBRAIN_DATABASE_URL
 * (or DATABASE_URL) is actually set.
 *
 * Precedence matches loadConfig(): env vars win over config-file URL. Returns
 * null only when NO source provides a URL at all.
 */
export type DbUrlSource =
  | 'env:GBRAIN_DATABASE_URL'
  | 'env:DATABASE_URL'
  | 'config-file'
  | 'config-file-path' // PGLite: config file present, no URL but database_path set
  | null;

// Internal aliases retained for backwards compatibility with the existing call
// sites below. They forward to the exported configDir()/configPath() so
// GBRAIN_HOME is honored uniformly. Lazy: never call homedir() at module scope.
function getConfigDir() { return configDir(); }
function getConfigPath() { return configPath(); }

export interface GBrainConfig {
  engine: 'postgres' | 'pglite';
  database_url?: string;
  database_path?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  /** AI gateway config (v0.14+). Default: "openai:text-embedding-3-large" / 1536 / "anthropic:claude-haiku-4-5-20251001". */
  embedding_model?: string;
  embedding_dimensions?: number;
  expansion_model?: string;
  /**
   * Default chat model for `gateway.chat()` callers (v0.27+).
   * Default: "anthropic:claude-sonnet-4-6-20250929".
   */
  chat_model?: string;
  /**
   * Optional silent-refusal fallback chain for `chatWithFallback()` (v0.27+).
   * Each entry is a "provider:modelId" string. Blocked from critic/judge/
   * synthesize flows in their respective handlers (per D13 review decision).
   */
  chat_fallback_chain?: string[];
  /** Optional base URL overrides for openai-compatible providers (keyed by recipe id). */
  provider_base_urls?: Record<string, string>;
  /**
   * Optional storage backend config (S3/Supabase/local). Shape matches
   * `StorageConfig` in `./storage.ts`. Typed as `unknown` here to avoid
   * a cyclic import; callers pass this through `createStorage()` which
   * validates the shape at runtime.
   */
  storage?: unknown;
  /**
   * v0.25.0 — session capture settings. Read via file-plane `loadConfig()`
   * at process boot (NOT `gbrain config set` which writes the DB plane —
   * those are different stores). Edit `~/.gbrain/config.json` directly.
   * All fields default to ON — capture and scrubbing both opt-out.
   */
  eval?: {
    /** false disables capture entirely. Defaults to true. */
    capture?: boolean;
    /** false disables PII scrubbing before insert. Defaults to true. */
    scrub_pii?: boolean;
  };

  /**
   * v0.27.1 — multimodal ingestion flags. Default off; opt-in.
   *
   * Unlike `embedding_model` / `embedding_dimensions` (which size the
   * schema and must be set before initSchema), these flags only affect
   * runtime behavior. They live in the DB plane primarily — `gbrain config
   * set embedding_multimodal true` flips the gate without touching the file.
   * loadConfigWithEngine() merges DB config on top of file/env. Env vars
   * still win as the operator escape hatch.
   */
  embedding_multimodal?: boolean;
  /** Model override for multimodal embeddings (e.g. "voyage:voyage-multimodal-3"). */
  embedding_multimodal_model?: string;
  embedding_image_ocr?: boolean;
  embedding_image_ocr_model?: string;

  /**
   * Thin-client mode (multi-topology v1). When set, this install does NOT
   * have a local DB; it talks to a remote `gbrain serve --http` over MCP.
   * The CLI dispatch guard in `src/cli.ts` checks for this field BEFORE
   * `connectEngine` and refuses any DB-bound subcommand. The `engine` field
   * above is still populated (default-inferred) but never used.
   *
   * Two URLs because OAuth discovery + `/token` live at the issuer root,
   * while tool dispatch lives at `/mcp`. They compose from a common base
   * in the typical setup but the config keeps them explicit so reverse-proxy
   * topologies work.
   *
   * `oauth_client_secret` can also be supplied via the
   * `GBRAIN_REMOTE_CLIENT_SECRET` env var (preferred for headless agents);
   * env-var value wins when both are present.
   */
  remote_mcp?: {
    issuer_url: string;
    mcp_url: string;
    oauth_client_id: string;
    oauth_client_secret?: string;
  };
}

export type EnvFileSource = 'gbrain' | 'hermes';
export interface EnvFileLoadResult {
  source: EnvFileSource;
  path: string;
  keys: string[];
}

const SHARED_PROVIDER_ENV_KEYS = new Set([
  // Native providers
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'VOYAGE_API_KEY',
  // OpenAI-compatible providers with auth
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  // Local/proxy providers where auth/base-url may be optional but useful.
  'LITELLM_BASE_URL',
  'LITELLM_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
]);

function parseDotenv(raw: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const originalLine of raw.split(/\r?\n/)) {
    let line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();

    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    }
    entries.push([key, value]);
  }
  return entries;
}

function loadEnvFile(path: string, onlyKeys?: ReadonlySet<string>): string[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }

  const loaded: string[] = [];
  for (const [key, value] of parseDotenv(raw)) {
    if (onlyKeys && !onlyKeys.has(key)) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/**
 * Load key=value pairs from ~/.gbrain/.env into process.env.
 *
 * This is intentionally separate from loadConfig(): loadConfig remains a pure
 * reader of the current environment/config file, while the CLI may opt in to
 * a one-time dotenv-style bootstrap before command dispatch. Values already
 * present in the process environment win over the file.
 */
export function loadGbrainEnvFile(path = configEnvPath()): string[] {
  return loadEnvFile(path);
}

export function hermesEnvPath(): string {
  const home = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes');
  return join(home, '.env');
}

/**
 * Bridge provider credentials from local env files into CLI-launched gbrain.
 *
 * Precedence is explicit and narrow:
 *   process.env > ~/.gbrain/.env > ${HERMES_HOME:-~/.hermes}/.env
 *
 * The Hermes file is treated as a shared provider-credential source only. We do
 * not wholesale import unrelated Hermes secrets (Telegram tokens, gateway
 * webhooks, etc.) into gbrain's process.
 */
export function loadSharedProviderEnvFiles(opts: {
  gbrainEnvPath?: string;
  hermesEnvPath?: string;
} = {}): EnvFileLoadResult[] {
  const results: EnvFileLoadResult[] = [];

  const gbrainPath = opts.gbrainEnvPath ?? configEnvPath();
  const gbrainKeys = loadGbrainEnvFile(gbrainPath);
  if (gbrainKeys.length > 0) {
    results.push({ source: 'gbrain', path: gbrainPath, keys: gbrainKeys });
  }

  const hermesPath = opts.hermesEnvPath ?? hermesEnvPath();
  const hermesKeys = loadEnvFile(hermesPath, SHARED_PROVIDER_ENV_KEYS);
  if (hermesKeys.length > 0) {
    results.push({ source: 'hermes', path: hermesPath, keys: hermesKeys });
  }

  return results;
}

/**
 * True when this install is configured as a thin client of a remote
 * `gbrain serve --http`. Single source of truth for the "is this a
 * thin-client install?" check used by the CLI dispatch guard, doctor
 * branch, and remote subcommands.
 */
export function isThinClient(config: GBrainConfig | null): boolean {
  return !!config?.remote_mcp;
}

/**
 * Load config with credential precedence: env vars > config file.
 * Plugin config is handled by the plugin runtime injecting env vars.
 */
export function loadConfig(): GBrainConfig | null {
  let fileConfig: GBrainConfig | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    fileConfig = JSON.parse(raw) as GBrainConfig;
  } catch { /* no config file */ }

  // Try env vars
  const dbUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;

  if (!fileConfig && !dbUrl) return null;

  // Infer engine type. A DATABASE_URL-style env var is always a Postgres
  // connection target and must override a file-backed PGLite engine
  // selection; otherwise direct-script / operator paths can silently hit
  // the local PGLite brain while claiming to use the env URL. The PGLite
  // database_path is also cleared when dbUrl is set so toEngineConfig
  // doesn't pass a stale path through alongside the URL.
  const inferredEngine: 'postgres' | 'pglite' = dbUrl
    ? 'postgres'
    : fileConfig?.engine || (fileConfig?.database_path ? 'pglite' : 'postgres');

  // Merge: env vars override config file. READ only — never mutate process.env.
  const merged = {
    ...fileConfig,
    engine: inferredEngine,
    ...(dbUrl ? { database_url: dbUrl } : {}),
    ...(dbUrl ? { database_path: undefined } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.ANTHROPIC_API_KEY ? { anthropic_api_key: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.GBRAIN_EMBEDDING_MODEL ? { embedding_model: process.env.GBRAIN_EMBEDDING_MODEL } : {}),
    ...(process.env.GBRAIN_EMBEDDING_DIMENSIONS ? { embedding_dimensions: parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS, 10) } : {}),
    ...(process.env.GBRAIN_EXPANSION_MODEL ? { expansion_model: process.env.GBRAIN_EXPANSION_MODEL } : {}),
    ...(process.env.GBRAIN_CHAT_MODEL ? { chat_model: process.env.GBRAIN_CHAT_MODEL } : {}),
    ...(process.env.GBRAIN_CHAT_FALLBACK_CHAIN
      ? { chat_fallback_chain: process.env.GBRAIN_CHAT_FALLBACK_CHAIN.split(',').map(s => s.trim()).filter(Boolean) }
      : {}),
    ...(process.env.GBRAIN_EMBEDDING_MULTIMODAL
      ? { embedding_multimodal: process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true' }
      : {}),
    ...(process.env.GBRAIN_EMBEDDING_IMAGE_OCR
      ? { embedding_image_ocr: process.env.GBRAIN_EMBEDDING_IMAGE_OCR === 'true' }
      : {}),
    ...(process.env.GBRAIN_EMBEDDING_MULTIMODAL_MODEL
      ? { embedding_multimodal_model: process.env.GBRAIN_EMBEDDING_MULTIMODAL_MODEL }
      : {}),
    ...(process.env.GBRAIN_EMBEDDING_IMAGE_OCR_MODEL
      ? { embedding_image_ocr_model: process.env.GBRAIN_EMBEDDING_IMAGE_OCR_MODEL }
      : {}),
    ...(process.env.GBRAIN_REMOTE_CLIENT_SECRET && fileConfig?.remote_mcp
      ? { remote_mcp: { ...fileConfig.remote_mcp, oauth_client_secret: process.env.GBRAIN_REMOTE_CLIENT_SECRET } }
      : {}),
  };
  return merged as GBrainConfig;
}

/**
 * v0.27.1 — async config loader that overlays DB-plane config on top of the
 * file/env config. Used by `gbrain` CLI's connectEngine() AFTER engine.connect()
 * so flags written via `gbrain config set` actually take effect. Unlike the
 * sync loadConfig(), this needs an engine handle to read the config table.
 *
 * Precedence: env > file > DB > defaults. Env stays the operator escape hatch;
 * file is the durable per-machine config; DB is the user-mutable runtime knob.
 *
 * Today only the v0.27.1 multimodal flags participate in DB-merge. Existing
 * fields (embedding_model, etc.) keep their file/env-only loading because they
 * size the schema and must be stable across engine connect.
 */
export async function loadConfigWithEngine(
  engine: { getConfig(key: string): Promise<string | null | undefined> },
  base?: GBrainConfig | null,
): Promise<GBrainConfig | null> {
  const fileConfig = base !== undefined ? base : loadConfig();
  if (!fileConfig) return null;

  // DB-plane reads. Quiet failures — if the config table doesn't exist yet
  // (pre-v36 brain mid-migration), treat as null and let file/env defaults
  // win. The migration runner reads file/env directly anyway.
  async function dbBool(key: string): Promise<boolean | undefined> {
    try {
      const v = await engine.getConfig(key);
      if (v === undefined || v === null || v === '') return undefined;
      return v === 'true';
    } catch {
      return undefined;
    }
  }
  async function dbStr(key: string): Promise<string | undefined> {
    try {
      const v = await engine.getConfig(key);
      if (v === undefined || v === null || v === '') return undefined;
      return v;
    } catch {
      return undefined;
    }
  }

  const dbMultimodal = await dbBool('embedding_multimodal');
  const dbMultimodalModel = await dbStr('embedding_multimodal_model');
  const dbOcr = await dbBool('embedding_image_ocr');
  const dbOcrModel = await dbStr('embedding_image_ocr_model');

  // DB applies only when env did NOT win. Env presence is detected by the
  // sync loadConfig() already setting the field. For each flag, prefer the
  // existing fileConfig value when defined; otherwise fall through to DB.
  const merged: GBrainConfig = { ...fileConfig };
  if (merged.embedding_multimodal === undefined && dbMultimodal !== undefined) {
    merged.embedding_multimodal = dbMultimodal;
  }
  if (merged.embedding_multimodal_model === undefined && dbMultimodalModel !== undefined) {
    merged.embedding_multimodal_model = dbMultimodalModel;
  }
  if (merged.embedding_image_ocr === undefined && dbOcr !== undefined) {
    merged.embedding_image_ocr = dbOcr;
  }
  if (merged.embedding_image_ocr_model === undefined && dbOcrModel !== undefined) {
    merged.embedding_image_ocr_model = dbOcrModel;
  }
  return merged;
}

export function saveConfig(config: GBrainConfig): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(getConfigPath(), 0o600);
  } catch {
    // chmod may fail on some platforms
  }
}

export function toEngineConfig(config: GBrainConfig): EngineConfig {
  return {
    engine: config.engine,
    database_url: config.database_url,
    database_path: config.database_path,
  };
}

export function configDir(): string {
  // Allow override for tests, Docker, and multi-tenant deployments.
  // GBRAIN_HOME is a parent dir; we always append '.gbrain' ourselves so
  // setting GBRAIN_HOME=/tmp/x yields configDir() === '/tmp/x/.gbrain'.
  // Validates the override: must be absolute, no '..' segments.
  const override = process.env.GBRAIN_HOME;
  if (override && override.trim()) {
    const trimmed = override.trim();
    if (!trimmed.startsWith('/')) {
      throw new Error(`GBRAIN_HOME must be an absolute path; got: ${trimmed}`);
    }
    if (trimmed.split('/').includes('..')) {
      throw new Error(`GBRAIN_HOME must not contain '..' segments; got: ${trimmed}`);
    }
    return join(trimmed, '.gbrain');
  }
  return join(homedir(), '.gbrain');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function configEnvPath(): string {
  return join(configDir(), '.env');
}

/**
 * Sugar for joining paths under the active gbrain home. Use this anywhere you
 * would otherwise write `join(homedir(), '.gbrain', ...rest)`. Honors
 * GBRAIN_HOME, validates input, and centralizes the convention so future
 * audits stay simple.
 */
export function gbrainPath(...segments: string[]): string {
  return join(configDir(), ...segments);
}

/**
 * Introspect where the active DB URL would come from if we tried to connect.
 * Never throws, never connects. Env vars take precedence (matches loadConfig).
 */
export function getDbUrlSource(): DbUrlSource {
  if (process.env.GBRAIN_DATABASE_URL) return 'env:GBRAIN_DATABASE_URL';
  if (process.env.DATABASE_URL) return 'env:DATABASE_URL';
  if (!existsSync(configPath())) return null;
  try {
    const raw = readFileSync(configPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GBrainConfig>;
    if (parsed.database_url) return 'config-file';
    if (parsed.database_path) return 'config-file-path';
    return null;
  } catch {
    // Config file exists but is unreadable/malformed — treat as null source.
    return null;
  }
}
