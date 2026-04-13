import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EngineConfig } from './types.ts';

// Lazy-evaluated to avoid calling homedir() at module scope (breaks in serverless/bundled environments)
function getConfigDir() { return join(homedir(), '.gbrain'); }
function getConfigPath() { return join(getConfigDir(), 'config.json'); }

export interface GBrainConfig {
  engine: 'postgres' | 'pglite';
  database_url?: string;
  database_path?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
  /** Embedding provider: 'openai' (default) or 'ollama' (local) */
  embedding_provider?: 'openai' | 'ollama';
  /** Generic embedding model name for the active provider. */
  embedding_model?: string;
  /** Optional explicit embedding dimensions override. */
  embedding_dimensions?: number;
  /** Ollama API base URL (default: http://localhost:11434) */
  ollama_base_url?: string;
  /** Legacy alias for Ollama embedding model name. */
  ollama_model?: string;
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

  // Merge: env vars override config file
  const merged = {
    ...fileConfig,
    engine: inferredEngine,
    ...(dbUrl ? { database_url: dbUrl } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.GBRAIN_EMBEDDING_PROVIDER ? { embedding_provider: process.env.GBRAIN_EMBEDDING_PROVIDER as 'openai' | 'ollama' } : {}),
    ...((process.env.GBRAIN_EMBEDDING_MODEL || process.env.OLLAMA_EMBEDDING_MODEL)
      ? { embedding_model: process.env.GBRAIN_EMBEDDING_MODEL || process.env.OLLAMA_EMBEDDING_MODEL }
      : {}),
    ...(process.env.GBRAIN_EMBEDDING_DIMENSIONS
      ? { embedding_dimensions: parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS, 10) }
      : {}),
    ...(process.env.OLLAMA_BASE_URL ? { ollama_base_url: process.env.OLLAMA_BASE_URL } : {}),
  };

  if (!merged.embedding_model && merged.ollama_model) {
    merged.embedding_model = merged.ollama_model;
  }

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
  return join(homedir(), '.gbrain');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}
