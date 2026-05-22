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

  // Infer engine type if not explicitly set
  const inferredEngine: 'postgres' | 'pglite' = fileConfig?.engine
    || (fileConfig?.database_path ? 'pglite' : 'postgres');

  // Merge: env vars override config file. READ only — never mutate process.env.
  const merged = {
    ...fileConfig,
    engine: inferredEngine,
    ...(dbUrl ? { database_url: dbUrl } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.GBRAIN_EMBEDDING_MODEL ? { embedding_model: process.env.GBRAIN_EMBEDDING_MODEL } : {}),
    ...(process.env.GBRAIN_EMBEDDING_DIMENSIONS ? { embedding_dimensions: parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS, 10) } : {}),
    ...(process.env.GBRAIN_EXPANSION_MODEL ? { expansion_model: process.env.GBRAIN_EXPANSION_MODEL } : {}),
    ...(process.env.GBRAIN_CHAT_MODEL ? { chat_model: process.env.GBRAIN_CHAT_MODEL } : {}),
    ...(process.env.GBRAIN_CHAT_FALLBACK_CHAIN
      ? { chat_fallback_chain: process.env.GBRAIN_CHAT_FALLBACK_CHAIN.split(',').map(s => s.trim()).filter(Boolean) }
      : {}),
  };
  return merged as GBrainConfig;
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
