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
 * Precedence matches loadConfig():
 *   1. GBRAIN_DATABASE_URL  (explicit gbrain-targeted override)
 *   2. config-file          (~/.gbrain/config.json)
 *   3. DATABASE_URL         (generic fallback — used only when no config exists)
 *
 * The generic DATABASE_URL ranks below the config file because bun auto-loads
 * `.env` from cwd, so an unrelated project's DATABASE_URL would otherwise
 * hijack the brain connection. GBRAIN_DATABASE_URL still wins for users who
 * intentionally want to override.
 *
 * Returns null only when NO source provides a URL at all.
 */
export type DbUrlSource =
  | 'env:GBRAIN_DATABASE_URL'
  | 'env:DATABASE_URL'
  | 'config-file'
  | 'config-file-path' // PGLite: config file present, no URL but database_path set
  | null;

// Lazy-evaluated to avoid calling homedir() at module scope (breaks in serverless/bundled environments).
// Prefer process.env.HOME so tests and runtime overrides work — bun caches homedir() after first call.
function home() { return process.env.HOME || homedir(); }
function getConfigDir() { return join(home(), '.gbrain'); }
function getConfigPath() { return join(getConfigDir(), 'config.json'); }

export interface GBrainConfig {
  engine: 'postgres' | 'pglite';
  database_url?: string;
  database_path?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  /**
   * Optional storage backend config (S3/Supabase/local). Shape matches
   * `StorageConfig` in `./storage.ts`. Typed as `unknown` here to avoid
   * a cyclic import; callers pass this through `createStorage()` which
   * validates the shape at runtime.
   */
  storage?: unknown;
}

/**
 * Load config with credential precedence:
 *   1. GBRAIN_DATABASE_URL   (explicit gbrain-targeted override)
 *   2. ~/.gbrain/config.json (the brain's own config)
 *   3. DATABASE_URL          (generic fallback, only if no config file URL)
 *
 * The generic DATABASE_URL is ranked below the config file because bun
 * auto-loads `.env` from cwd, so running gbrain inside an unrelated project
 * directory would otherwise let that project's DATABASE_URL hijack the brain
 * connection. Users who want explicit override still have GBRAIN_DATABASE_URL.
 *
 * Plugin config is handled by the plugin runtime injecting env vars.
 */
export function loadConfig(): GBrainConfig | null {
  let fileConfig: GBrainConfig | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    fileConfig = JSON.parse(raw) as GBrainConfig;
  } catch { /* no config file */ }

  const explicitGbrainUrl = process.env.GBRAIN_DATABASE_URL;
  const genericUrl = process.env.DATABASE_URL;
  const fileUrl = fileConfig?.database_url;
  // GBRAIN_DATABASE_URL > config file > DATABASE_URL.
  const dbUrl = explicitGbrainUrl || fileUrl || genericUrl;

  if (!fileConfig && !dbUrl) return null;

  // Infer engine type if not explicitly set
  const inferredEngine: 'postgres' | 'pglite' = fileConfig?.engine
    || (fileConfig?.database_path ? 'pglite' : 'postgres');

  const merged = {
    ...fileConfig,
    engine: inferredEngine,
    ...(dbUrl ? { database_url: dbUrl } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
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
  return getConfigDir();
}

export function configPath(): string {
  return getConfigPath();
}

/**
 * Introspect where the active DB URL would come from if we tried to connect.
 * Never throws, never connects. Matches loadConfig() precedence:
 *   GBRAIN_DATABASE_URL > config file > DATABASE_URL.
 */
export function getDbUrlSource(): DbUrlSource {
  if (process.env.GBRAIN_DATABASE_URL) return 'env:GBRAIN_DATABASE_URL';

  let parsed: Partial<GBrainConfig> | null = null;
  if (existsSync(configPath())) {
    try {
      parsed = JSON.parse(readFileSync(configPath(), 'utf-8')) as Partial<GBrainConfig>;
    } catch {
      // Config file exists but is unreadable/malformed — fall through.
    }
  }
  if (parsed?.database_url) return 'config-file';

  if (process.env.DATABASE_URL) return 'env:DATABASE_URL';
  if (parsed?.database_path) return 'config-file-path';
  return null;
}
