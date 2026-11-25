/**
 * In-process memo for the `get_health` op (FOUNDATIONS 1, F4a, O-ENG-13).
 *
 * get_health aggregates the whole brain (or the caller's grant), and agents
 * and health checks poll it. The op handler serves a repeat call from this
 * memo when nothing it depends on moved. An entry is reused only when all of
 * these match the current call:
 *
 *   - engine identity: entries live in a WeakMap keyed by the engine object,
 *     and the brain id (`persistence_brain`) is part of the clock;
 *   - scope key: `all` (brain-wide), `scalar:<id>`, `set:<sorted unique ids>`,
 *     or `empty` (an empty grant or the no-sources sentinel; computes zeros
 *     and is never stored under `all`). The key is derived from the exact
 *     scope handed to `engine.getHealth`, so a scoped caller can never read
 *     an entry computed for another scope;
 *   - config generation: a hash of the orphan exclusions, the embedding
 *     column registry keys and the schema pack setting;
 *   - page clock (`engine.readHealthMemoClock`): `page_generation_clock_seq.last_value`,
 *     which every page insert, update or delete advances;
 *   - age below the TTL: `GBRAIN_HEALTH_CACHE_TTL_MS`, else config
 *     `health.cache_ttl_ms`, else 30000 ms; 0 disables the memo. The TTL
 *     bounds staleness from writes that do not touch `pages` (links,
 *     timeline rows, chunks).
 *
 * The memo is not in the engine: doctor checks, remediation, maintain,
 * embedding migration and repair verification call `engine.getHealth`
 * directly and always see fresh numbers. `gbrain repair --apply` and
 * `gbrain doctor --remediate` also clear it. If the clock or config read
 * fails (for example a brain mid-upgrade), the call computes uncached.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { NO_SOURCES } from './source-id.ts';
import { ORPHAN_EXCLUDE_PREFIXES_KEY, ORPHAN_EXCLUDE_SLUGS_KEY } from './orphan-policy.ts';

export const HEALTH_CACHE_TTL_KEY = 'health.cache_ttl_ms';
export const HEALTH_CACHE_TTL_ENV = 'GBRAIN_HEALTH_CACHE_TTL_MS';
export const DEFAULT_HEALTH_CACHE_TTL_MS = 30_000;

const GENERATION_CONFIG_KEYS = [
  ORPHAN_EXCLUDE_PREFIXES_KEY,
  ORPHAN_EXCLUDE_SLUGS_KEY,
  'search_embedding_column',
  'embedding_columns',
  'schema_pack',
] as const;
const MAX_ENTRIES_PER_ENGINE = 256;

interface Entry {
  configGeneration: string;
  pageClock: string;
  storedAt: number;
  computedAt: string;
  value: unknown;
}

let memo = new WeakMap<object, Map<string, Entry>>();

/** The memo key for the scope `engine.getHealth` receives (same normalization the engine applies). */
export function healthScopeKey(scope: { sourceId?: string; sourceIds?: string[] }): string {
  const ids = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : null);
  if (ids === null) return 'all';
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0 || unique.includes(NO_SOURCES)) return 'empty';
  if (scope.sourceIds === undefined) return `scalar:${unique[0]}`;
  return `set:${unique.join(',')}`;
}

function parseTtl(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function readGeneration(engine: BrainEngine): Promise<{ configGeneration: string; pageClock: string; configTtl: number | null } | null> {
  try {
    const [rows, pageClock] = await Promise.all([
      engine.getConfigValues([...GENERATION_CONFIG_KEYS, HEALTH_CACHE_TTL_KEY]),
      engine.readHealthMemoClock(),
    ]);
    const byKey = new Map<string, string | null>(rows.map(r => [r.key, r.value]));
    const generation = GENERATION_CONFIG_KEYS.map(k => [k, byKey.get(k) ?? null]);
    generation.push(['env:GBRAIN_SCHEMA_PACK', process.env.GBRAIN_SCHEMA_PACK ?? null]);
    return {
      configGeneration: createHash('sha256').update(JSON.stringify(generation)).digest('hex').slice(0, 16),
      pageClock,
      configTtl: parseTtl(byKey.get(HEALTH_CACHE_TTL_KEY)),
    };
  } catch {
    return null;
  }
}

/**
 * Serve `compute()` from the memo when engine, scope, config generation and
 * page clock match a fresh entry; otherwise compute, store and return it.
 * The result carries `computed_at`, the ISO time its numbers were read.
 */
export async function memoizedHealth<T extends object>(
  engine: BrainEngine,
  scope: { sourceId?: string; sourceIds?: string[] },
  compute: () => Promise<T>,
): Promise<T & { computed_at: string }> {
  const envTtl = parseTtl(process.env[HEALTH_CACHE_TTL_ENV]);
  const startedAt = Date.now();
  const generation = envTtl === 0 ? null : await readGeneration(engine);
  const ttl = envTtl ?? generation?.configTtl ?? DEFAULT_HEALTH_CACHE_TTL_MS;
  const key = healthScopeKey(scope);
  const entries = memo.get(engine);
  const hit = entries?.get(key);
  if (generation && ttl > 0 && hit
      && hit.configGeneration === generation.configGeneration
      && hit.pageClock === generation.pageClock
      && startedAt - hit.storedAt < ttl) {
    return { ...structuredClone(hit.value as T), computed_at: hit.computedAt };
  }
  const value = await compute();
  const computedAt = new Date(startedAt).toISOString();
  if (generation && ttl > 0) {
    const map = entries ?? new Map<string, Entry>();
    if (!entries) memo.set(engine, map);
    map.delete(key);
    if (map.size >= MAX_ENTRIES_PER_ENGINE) map.delete(map.keys().next().value as string);
    map.set(key, {
      configGeneration: generation.configGeneration,
      pageClock: generation.pageClock,
      storedAt: startedAt,
      computedAt,
      value: structuredClone(value),
    });
  }
  return { ...value, computed_at: computedAt };
}

/** Drop memoized health for one engine, or for every engine in this process. */
export function clearHealthMemo(engine?: BrainEngine): void {
  if (engine) memo.delete(engine);
  else memo = new WeakMap();
}
