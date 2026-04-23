import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { configDir, configPath } from './config.ts';

export type RepoStrategy = 'markdown' | 'code' | 'auto';

export interface RepoConfig {
  path: string;
  name: string;
  strategy: RepoStrategy;
  include?: string[];
  exclude?: string[];
  syncEnabled?: boolean;
}

interface RawConfig {
  [key: string]: unknown;
  repos?: unknown;
}

function readRawConfig(): RawConfig {
  try {
    const raw = readFileSync(configPath(), 'utf-8');
    return JSON.parse(raw) as RawConfig;
  } catch {
    return {};
  }
}

function writeRawConfig(config: RawConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(configPath(), 0o600);
  } catch {
    // chmod may fail on some platforms
  }
}

export function normalizeRepoName(repoPath: string): string {
  const normalized = repoPath.replace(/\\/g, '/').replace(/\/+$/g, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'repo';
}

export function loadRepoConfigs(): RepoConfig[] {
  if (!existsSync(configPath())) return [];

  const parsed = readRawConfig();
  if (!Array.isArray(parsed.repos)) return [];

  const repos: RepoConfig[] = [];
  for (const candidate of parsed.repos) {
    if (!candidate || typeof candidate !== 'object') continue;
    const row = candidate as Record<string, unknown>;
    if (typeof row.path !== 'string' || typeof row.name !== 'string') continue;

    const strategy = row.strategy;
    const normalizedStrategy: RepoStrategy = strategy === 'code' || strategy === 'auto' ? strategy : 'markdown';

    repos.push({
      path: resolve(row.path),
      name: row.name,
      strategy: normalizedStrategy,
      include: Array.isArray(row.include) ? row.include.map(String) : undefined,
      exclude: Array.isArray(row.exclude) ? row.exclude.map(String) : undefined,
      syncEnabled: typeof row.syncEnabled === 'boolean' ? row.syncEnabled : true,
    });
  }

  return repos;
}

export function saveRepoConfigs(repos: RepoConfig[]): void {
  const parsed = readRawConfig();
  parsed.repos = repos.map((repo) => ({
    path: resolve(repo.path),
    name: repo.name,
    strategy: repo.strategy,
    ...(repo.include && repo.include.length > 0 ? { include: repo.include } : {}),
    ...(repo.exclude && repo.exclude.length > 0 ? { exclude: repo.exclude } : {}),
    ...(repo.syncEnabled === false ? { syncEnabled: false } : {}),
  }));
  writeRawConfig(parsed);
}

export function addRepoConfig(repo: RepoConfig): RepoConfig[] {
  const repos = loadRepoConfigs();
  const normalized: RepoConfig = {
    ...repo,
    path: resolve(repo.path),
    name: repo.name || normalizeRepoName(repo.path),
    strategy: repo.strategy || 'auto',
    syncEnabled: repo.syncEnabled ?? true,
  };

  const nameTaken = repos.find((r) => r.name === normalized.name);
  if (nameTaken) {
    throw new Error(`Repo name already exists: ${normalized.name}`);
  }

  const pathTaken = repos.find((r) => resolve(r.path) === normalized.path);
  if (pathTaken) {
    throw new Error(`Repo path already configured: ${normalized.path}`);
  }

  const updated = [...repos, normalized];
  saveRepoConfigs(updated);
  return updated;
}

export function removeRepoConfig(name: string): RepoConfig[] {
  const repos = loadRepoConfigs();
  const next = repos.filter((r) => r.name !== name);
  if (next.length === repos.length) {
    throw new Error(`Repo not found: ${name}`);
  }
  saveRepoConfigs(next);
  return next;
}
