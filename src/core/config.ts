import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { EngineConfig } from './types.ts';

const CONFIG_DIR = join(homedir(), '.gbrain');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export interface GBrainConfig {
  engine: 'postgres' | 'sqlite' | 'pglite';
  database_url?: string;
  database_path?: string;
  openai_api_key?: string;
  anthropic_api_key?: string;
}

/**
 * Load config with credential precedence: env vars > config file.
 * Plugin config is handled by the plugin runtime injecting env vars.
 */
export function loadConfig(): GBrainConfig | null {
  let fileConfig: GBrainConfig | null = null;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    fileConfig = JSON.parse(raw) as GBrainConfig;
  } catch { /* no config file */ }

  // Try env vars
  const dbUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
  const dbPath = process.env.GBRAIN_DATABASE_PATH;

  if (!fileConfig && !dbUrl && !dbPath) return null;

  // Merge with explicit engine precedence:
  // DATABASE_URL/GBRAIN_DATABASE_URL forces postgres mode.
  // GBRAIN_DATABASE_PATH forces pglite mode when no URL override is present.
  const merged: GBrainConfig = {
    engine: 'postgres',
    ...fileConfig,
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
  };

  if (dbUrl) {
    merged.engine = 'postgres';
    merged.database_url = dbUrl;
    delete merged.database_path;
    return merged;
  }

  if (dbPath) {
    merged.engine = 'pglite';
    merged.database_path = dbPath;
    delete merged.database_url;
    return merged;
  }

  return merged;
}

export function saveConfig(config: GBrainConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
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

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
