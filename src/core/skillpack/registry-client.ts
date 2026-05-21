/**
 * skillpack/registry-client.ts — fetch + cache + stale-fallback for the
 * `gbrain skillpack-registry` catalog.
 *
 * The default registry lives at
 *   https://raw.githubusercontent.com/garrytan/gbrain-skillpack-registry/main/registry.json
 *   https://raw.githubusercontent.com/garrytan/gbrain-skillpack-registry/main/endorsements.json
 *
 * Offline-safe per the user's decision: when the network fetch fails (DNS
 * miss, 5xx, timeout), fall back to the on-disk cache and emit a single
 * stderr warning per process. Cache freshness threshold: 1h soft TTL for
 * normal use, 7d before the "registry cache is stale" escalation fires.
 * Hard-fail only when there is NO cache at all (first run + offline).
 *
 * Pure Bun's fetch — no external HTTP library. Honors ETag for cheap
 * polling so successive fetches against an unchanged registry are
 * effectively free.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';

import { gbrainPath, loadConfig } from '../config.ts';
import {
  RegistrySchemaError,
  validateEndorsementsFile,
  validateRegistryCatalog,
  effectiveTier as computeEffectiveTier,
  type RegistryCatalog,
  type RegistryEntry,
  type EndorsementsFile,
  type RegistryTier,
} from './registry-schema.ts';

/** Default registry URL — the canonical Garry-controlled catalog. */
export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/garrytan/gbrain-skillpack-registry/main/registry.json';

/** Default endorsements URL — sibling file in the same repo. */
export const DEFAULT_ENDORSEMENTS_URL =
  'https://raw.githubusercontent.com/garrytan/gbrain-skillpack-registry/main/endorsements.json';

/** Soft TTL: prefer cache when it's younger than this (no fetch attempt). */
const SOFT_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Stale escalation: surface a louder warning when cache is older than this. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Cache file payload — wraps the validated registry + freshness metadata. */
interface RegistryCacheFile {
  fetched_at: string;
  etag: string | null;
  url: string;
  catalog: RegistryCatalog;
  endorsements: EndorsementsFile | null;
}

/** Result of `loadRegistry`. */
export interface LoadedRegistry {
  catalog: RegistryCatalog;
  endorsements: EndorsementsFile | null;
  /** Where the data came from — informational for status output. */
  origin: 'fresh_fetch' | 'cache_warm' | 'cache_soft_stale' | 'cache_hard_stale';
  /** How old the cache is in ms (always set when origin is one of the cache states). */
  cache_age_ms: number | null;
  /** URL the catalog came from (after config override). */
  registry_url: string;
}

export type RegistryClientErrorCode =
  | 'no_cache_no_network'
  | 'fetch_succeeded_but_schema_invalid'
  | 'cache_corrupt'
  | 'url_invalid';

export class RegistryClientError extends Error {
  constructor(
    message: string,
    public code: RegistryClientErrorCode,
  ) {
    super(message);
    this.name = 'RegistryClientError';
  }
}

export interface LoadRegistryOptions {
  /** Override the registry URL (defaults to config key skillpack.registry_url then DEFAULT_REGISTRY_URL). */
  url?: string;
  /** Force a fresh fetch even when cache is within the soft TTL. */
  refresh?: boolean;
  /** Test seam: inject a fetch implementation. Default uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: override the cache directory. */
  cacheDir?: string;
  /** Test seam: short-circuit network entirely (forces cache-or-fail). */
  noNetwork?: boolean;
}

/** Stable cache file path for a given registry URL. */
function cachePathFor(url: string, cacheDir: string): string {
  const sha = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return join(cacheDir, `registry-${sha}.json`);
}

/** Convert the registry URL to the sibling endorsements.json URL. */
function endorsementsUrlFor(registryUrl: string): string {
  if (registryUrl === DEFAULT_REGISTRY_URL) return DEFAULT_ENDORSEMENTS_URL;
  // Replace the trailing "registry.json" with "endorsements.json" so custom
  // registries that mirror the layout work transparently.
  return registryUrl.replace(/registry\.json$/, 'endorsements.json');
}

/** Resolve the active registry URL: opts → config → default. */
export function resolveRegistryUrl(opts: { url?: string } = {}): string {
  if (opts.url) return opts.url;
  try {
    const cfg = loadConfig();
    const configured = (cfg as unknown as Record<string, unknown>).skillpack;
    if (configured && typeof configured === 'object') {
      const url = (configured as Record<string, unknown>).registry_url;
      if (typeof url === 'string' && url.length > 0) return url;
    }
  } catch {
    // loadConfig() may throw on first-run before init; default is fine.
  }
  return DEFAULT_REGISTRY_URL;
}

/** Default cache directory under ~/.gbrain/skillpack-cache. */
function defaultCacheDir(): string {
  return gbrainPath('skillpack-cache');
}

/** Read a cache file from disk; null if missing or malformed. */
function readCache(cacheFile: string): RegistryCacheFile | null {
  if (!existsSync(cacheFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(cacheFile, 'utf-8')) as RegistryCacheFile;
    if (typeof raw !== 'object' || raw === null) return null;
    if (typeof raw.fetched_at !== 'string' || !raw.catalog) return null;
    validateRegistryCatalog(raw.catalog);
    if (raw.endorsements) validateEndorsementsFile(raw.endorsements);
    return raw;
  } catch {
    return null;
  }
}

/** Atomically write a cache file. */
function writeCache(cacheFile: string, payload: RegistryCacheFile): void {
  mkdirSync(dirname(cacheFile), { recursive: true });
  const tmp = cacheFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  // Use renameSync via fs writeFileSync followed by manual rename to atomically replace.
  // Bun's fs.renameSync is in node:fs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { renameSync } = require('fs');
  renameSync(tmp, cacheFile);
}

/** Format cache age for log lines. */
function fmtAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Load the registry. Tries network first (unless cache is fresh and
 * refresh=false), falls back to cache on any failure, escalates to the
 * stale warning when cache > 7d. Hard-fails only with no cache + no
 * network.
 */
export async function loadRegistry(opts: LoadRegistryOptions = {}): Promise<LoadedRegistry> {
  const url = resolveRegistryUrl(opts);
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const cacheFile = cachePathFor(url, cacheDir);
  const cached = readCache(cacheFile);

  // Cache-warm fast path: cache is fresh AND refresh wasn't requested.
  if (cached && !opts.refresh) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < SOFT_TTL_MS) {
      return {
        catalog: cached.catalog,
        endorsements: cached.endorsements,
        origin: 'cache_warm',
        cache_age_ms: ageMs,
        registry_url: url,
      };
    }
  }

  // Network path (unless explicitly disabled for tests).
  if (!opts.noNetwork) {
    const fetcher = opts.fetchImpl ?? fetch;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (cached?.etag && !opts.refresh) headers['If-None-Match'] = cached.etag;

      const catalogRes = await fetcher(url, { headers });
      if (catalogRes.status === 304 && cached) {
        // Cache hit via etag; touch the fetched_at so we don't re-poll within the soft TTL.
        const refreshed: RegistryCacheFile = { ...cached, fetched_at: new Date().toISOString() };
        writeCache(cacheFile, refreshed);
        return {
          catalog: refreshed.catalog,
          endorsements: refreshed.endorsements,
          origin: 'fresh_fetch',
          cache_age_ms: 0,
          registry_url: url,
        };
      }

      if (!catalogRes.ok) {
        throw new Error(`HTTP ${catalogRes.status} ${catalogRes.statusText}`);
      }

      const catalogJson = await catalogRes.json();
      let catalog: RegistryCatalog;
      try {
        catalog = validateRegistryCatalog(catalogJson);
      } catch (err) {
        throw new RegistryClientError(
          `fetched registry.json but schema is invalid: ${(err as Error).message}`,
          'fetch_succeeded_but_schema_invalid',
        );
      }

      // Fetch endorsements.json (best-effort: a missing file is not an error).
      let endorsements: EndorsementsFile | null = null;
      try {
        const endRes = await fetcher(endorsementsUrlFor(url));
        if (endRes.ok) {
          const endJson = await endRes.json();
          endorsements = validateEndorsementsFile(endJson);
        }
      } catch {
        // Silently skip; endorsements are an overlay, not load-bearing.
      }

      const etag = catalogRes.headers.get('etag');
      const payload: RegistryCacheFile = {
        fetched_at: new Date().toISOString(),
        etag,
        url,
        catalog,
        endorsements,
      };
      writeCache(cacheFile, payload);

      return {
        catalog,
        endorsements,
        origin: 'fresh_fetch',
        cache_age_ms: 0,
        registry_url: url,
      };
    } catch (err) {
      // Schema-invalid responses are a hard failure — don't degrade to cache.
      if (err instanceof RegistryClientError) throw err;
      // Network failure — fall through to cache.
      if (cached) {
        const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
        const origin: LoadedRegistry['origin'] =
          ageMs > STALE_AFTER_MS ? 'cache_hard_stale' : 'cache_soft_stale';
        process.stderr.write(
          `[skillpack] registry fetch failed (${(err as Error).message}); using cache from ${cached.fetched_at} (${fmtAge(ageMs)} old)\n`,
        );
        if (origin === 'cache_hard_stale') {
          process.stderr.write(
            `[skillpack] cache is older than 7 days. When back online run \`gbrain skillpack registry --refresh\`.\n`,
          );
        }
        return {
          catalog: cached.catalog,
          endorsements: cached.endorsements,
          origin,
          cache_age_ms: ageMs,
          registry_url: url,
        };
      }
      throw new RegistryClientError(
        `registry fetch failed (${(err as Error).message}) and no on-disk cache exists. First-run installs require network.`,
        'no_cache_no_network',
      );
    }
  }

  // noNetwork branch.
  if (cached) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    const origin: LoadedRegistry['origin'] =
      ageMs > STALE_AFTER_MS ? 'cache_hard_stale' : ageMs > SOFT_TTL_MS ? 'cache_soft_stale' : 'cache_warm';
    return {
      catalog: cached.catalog,
      endorsements: cached.endorsements,
      origin,
      cache_age_ms: ageMs,
      registry_url: url,
    };
  }
  throw new RegistryClientError(
    `--no-cache or noNetwork was set but no cache exists for ${url}`,
    'no_cache_no_network',
  );
}

/** Lookup a pack by name. Returns null when not present. */
export function findPack(loaded: LoadedRegistry, name: string): RegistryEntry | null {
  return loaded.catalog.skillpacks.find((e) => e.name === name) ?? null;
}

/** Lookup a pack with its effective tier applied. */
export function findPackWithTier(
  loaded: LoadedRegistry,
  name: string,
): { entry: RegistryEntry; tier: RegistryTier } | null {
  const entry = findPack(loaded, name);
  if (!entry) return null;
  return { entry, tier: computeEffectiveTier(entry, loaded.endorsements) };
}

/**
 * Search the catalog by free-text query. Matches against name, description,
 * author, and tags (lowercase contains). Returns entries paired with their
 * effective tier; sorted by tier (endorsed > community > experimental > dead)
 * then alphabetical by name.
 */
export function searchPacks(
  loaded: LoadedRegistry,
  opts: { query?: string; tier?: RegistryTier } = {},
): Array<{ entry: RegistryEntry; tier: RegistryTier }> {
  const q = (opts.query ?? '').trim().toLowerCase();
  const tierOrder: RegistryTier[] = ['endorsed', 'community', 'experimental', 'dead'];
  const results: Array<{ entry: RegistryEntry; tier: RegistryTier }> = [];
  for (const entry of loaded.catalog.skillpacks) {
    const tier = computeEffectiveTier(entry, loaded.endorsements);
    if (opts.tier && tier !== opts.tier) continue;
    if (q.length > 0) {
      const haystack = [
        entry.name,
        entry.description,
        entry.author,
        entry.author_handle,
        ...entry.tags,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    results.push({ entry, tier });
  }
  results.sort((a, b) => {
    const tDiff = tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier);
    if (tDiff !== 0) return tDiff;
    return a.entry.name.localeCompare(b.entry.name);
  });
  return results;
}
