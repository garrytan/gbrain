import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveConfig } from './engine-factory.ts';

export type EngineType = 'postgres' | 'sqlite';
export type EmbeddingProvider = 'none' | 'local';
export type QueryRewriteProvider = 'none' | 'heuristic' | 'local_llm';

export interface GBrainConfig {
  engine: EngineType;
  database_url?: string;
  database_path?: string;
  offline: boolean;
  embedding_provider: EmbeddingProvider;
  query_rewrite_provider: QueryRewriteProvider;
  openai_api_key?: string;
  anthropic_api_key?: string;
}

export interface GBrainConfigInput {
  engine?: EngineType;
  database_url?: string;
  database_path?: string;
  offline?: boolean;
  embedding_provider?: EmbeddingProvider;
  query_rewrite_provider?: QueryRewriteProvider;
  openai_api_key?: string;
  anthropic_api_key?: string;
}

// Lazy-evaluated to avoid calling homedir() at module scope (breaks in Deno Edge Functions)
function getConfigDir() { return process.env.GBRAIN_CONFIG_DIR || join(process.env.HOME || homedir(), '.gbrain'); }
function getConfigPath() { return join(getConfigDir(), 'config.json'); }

/**
 * Load config with credential precedence: env vars > config file, unless sqlite/local mode is explicitly configured.
 * Plugin config is handled by the plugin runtime injecting env vars.
 */
export function loadConfig(): GBrainConfig | null {
  let fileConfig: GBrainConfigInput | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    fileConfig = JSON.parse(raw) as GBrainConfigInput;
  } catch {
    /* no config file */
  }

  const dbUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
  const preferLocalConfig = fileConfig?.engine === 'sqlite';

  if (!fileConfig && !dbUrl) return null;

  const merged: GBrainConfigInput = {
    ...fileConfig,
    ...(!preferLocalConfig && dbUrl ? { database_url: dbUrl } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
  };

  return resolveConfig(merged);
}

export function saveConfig(config: GBrainConfigInput): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(getConfigPath(), 0o600);
  } catch {
    // chmod may fail on some platforms
  }
}

export { toEngineConfig } from './engine-factory.ts';

export function configDir(): string {
  return getConfigDir();
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}
