import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import { configDir, gbrainPath } from '../../config.ts';
import { redactTokenLike } from './token-store.ts';

export interface OpenAICodexModelMetadata {
  slug: string;
  display_name?: string;
  supported_in_api: boolean;
  context_window?: number;
  max_output_tokens?: number;
  supported_reasoning_levels?: string[];
  service_tiers?: string[];
  [key: string]: unknown;
}

export interface OpenAICodexModelCache {
  schema_version: 1;
  fetched_at: string;
  client_version?: string;
  etag?: string;
  raw_count: number;
  supported_count: number;
  models: OpenAICodexModelMetadata[];
}

const CACHE_FILE = 'cache/openai-codex-models.json';

export function modelCachePath(): string {
  return gbrainPath(CACHE_FILE);
}

export function filterSupportedModels(models: OpenAICodexModelMetadata[]): OpenAICodexModelMetadata[] {
  return models.filter((model) => model.supported_in_api === true);
}

export function isModelCacheFresh(cache: OpenAICodexModelCache, ttlMs: number, now = new Date()): boolean {
  const fetched = Date.parse(cache.fetched_at);
  if (Number.isNaN(fetched)) return false;
  return now.getTime() - fetched < ttlMs;
}

function assertInsideGBrainHome(path: string): void {
  const base = resolve(configDir());
  const target = resolve(path);
  const rel = relative(base, target);
  if (rel.startsWith('..') || rel === '..' || resolve(rel) === rel) {
    throw new Error(`openai-codex model cache path is outside GBRAIN_HOME: ${path}`);
  }
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function assertSafeFile(path: string): void {
  assertInsideGBrainHome(path);
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new Error(`openai-codex model cache must not be a symlink: ${path}`);
  }
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`openai-codex model cache permissions must be 0600; got ${mode.toString(8)}`);
  }
}

function validateModel(value: unknown): OpenAICodexModelMetadata {
  if (!value || typeof value !== 'object') throw new Error('openai-codex model entry must be an object');
  const v = value as Record<string, unknown>;
  if (typeof v.slug !== 'string' || v.slug.length === 0) throw new Error('openai-codex model entry missing slug');
  if (typeof v.supported_in_api !== 'boolean') throw new Error(`openai-codex model ${v.slug} missing supported_in_api`);
  return {
    ...v,
    slug: v.slug,
    supported_in_api: v.supported_in_api,
    ...(typeof v.display_name === 'string' ? { display_name: v.display_name } : {}),
    ...(typeof v.context_window === 'number' ? { context_window: v.context_window } : {}),
    ...(typeof v.max_output_tokens === 'number' ? { max_output_tokens: v.max_output_tokens } : {}),
    ...(Array.isArray(v.supported_reasoning_levels) && v.supported_reasoning_levels.every((x) => typeof x === 'string')
      ? { supported_reasoning_levels: v.supported_reasoning_levels }
      : {}),
    ...(Array.isArray(v.service_tiers) && v.service_tiers.every((x) => typeof x === 'string')
      ? { service_tiers: v.service_tiers }
      : {}),
  } as OpenAICodexModelMetadata;
}

function validateCache(value: unknown): OpenAICodexModelCache {
  if (!value || typeof value !== 'object') throw new Error('openai-codex model cache must be an object');
  const v = value as Record<string, unknown>;
  if (v.schema_version !== 1) throw new Error('openai-codex model cache schema_version must be 1');
  if (typeof v.fetched_at !== 'string' || Number.isNaN(Date.parse(v.fetched_at))) throw new Error('openai-codex model cache missing valid fetched_at');
  if (!Array.isArray(v.models)) throw new Error('openai-codex model cache missing models array');
  const models = v.models.map(validateModel);
  const supported = filterSupportedModels(models);
  const rawCount = typeof v.raw_count === 'number' ? v.raw_count : models.length;
  const supportedCount = typeof v.supported_count === 'number' ? v.supported_count : supported.length;
  if (rawCount < models.length) throw new Error('openai-codex model cache raw_count must be at least cached models length');
  if (supportedCount !== supported.length) throw new Error('openai-codex model cache supported_count does not match supported models');
  return {
    schema_version: 1,
    fetched_at: v.fetched_at,
    ...(typeof v.client_version === 'string' ? { client_version: v.client_version } : {}),
    ...(typeof v.etag === 'string' ? { etag: v.etag } : {}),
    raw_count: rawCount,
    supported_count: supportedCount,
    models,
  };
}

function rejectCredentialMaterial(serialized: string): void {
  if (/(access_token|refresh_token|id_token|authorization|sk-proj-|sk-)/i.test(serialized)) {
    throw new Error('openai-codex model cache must not contain credential material');
  }
}

export async function writeModelCache(cache: OpenAICodexModelCache, path = modelCachePath()): Promise<void> {
  assertInsideGBrainHome(path);
  const normalized = validateCache(cache);
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  rejectCredentialMaterial(payload);
  ensurePrivateDir(dirname(path));
  assertSafeFile(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, payload, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export async function loadModelCache(path = modelCachePath()): Promise<OpenAICodexModelCache> {
  assertSafeFile(path);
  try {
    return validateCache(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read openai-codex model cache: ${redactTokenLike(msg)}`);
  }
}

export async function readModelCacheOrNull(path = modelCachePath()): Promise<OpenAICodexModelCache | null> {
  assertSafeFile(path);
  if (!existsSync(path)) return null;
  return loadModelCache(path);
}

export interface OpenAICodexModelCacheManagerOptions {
  ttlMs: number;
  refresh: () => Promise<OpenAICodexModelCache>;
  now?: () => Date;
  path?: string;
}

export interface OpenAICodexModelCacheResult {
  cache: OpenAICodexModelCache;
  source: 'fresh-cache' | 'refreshed' | 'stale-cache';
  warning?: string;
}

export class OpenAICodexModelCacheManager {
  private inFlight: Promise<OpenAICodexModelCacheResult> | null = null;
  private readonly now: () => Date;

  constructor(private readonly opts: OpenAICodexModelCacheManagerOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  async getFresh(options: { force?: boolean } = {}): Promise<OpenAICodexModelCacheResult> {
    if (!options.force) {
      const existing = await readModelCacheOrNull(this.opts.path);
      if (existing && isModelCacheFresh(existing, this.opts.ttlMs, this.now())) {
        return { cache: existing, source: 'fresh-cache' };
      }
    }

    if (!this.inFlight) {
      this.inFlight = this.refreshAndCache().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async refreshAndCache(): Promise<OpenAICodexModelCacheResult> {
    try {
      const refreshed = validateCache(await this.opts.refresh());
      await writeModelCache(refreshed, this.opts.path);
      return { cache: refreshed, source: 'refreshed' };
    } catch (err) {
      const existing = await readModelCacheOrNull(this.opts.path);
      const msg = err instanceof Error ? err.message : String(err);
      if (existing) {
        return {
          cache: existing,
          source: 'stale-cache',
          warning: `Using stale openai-codex model cache after refresh failure: ${redactTokenLike(msg)}`,
        };
      }
      throw new Error(`Failed to refresh openai-codex model cache and no cache exists: ${redactTokenLike(msg)}`);
    }
  }
}
