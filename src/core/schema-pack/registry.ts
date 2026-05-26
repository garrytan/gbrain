// v0.38 schema pack registry — load, cache, resolve active pack.
//
//                  ┌──────────────────────────────────────────────────────┐
//                  │   loadActivePack lifecycle (per process, v0.40.6.0)  │
//                  └──────────────────────────────────────────────────────┘
//                                       │
//              ┌────────────────────────┼────────────────────────┐
//              ▼                        ▼                        ▼
//       cache miss               cache hit                cache hit + TTL expired
//              │                        │                        │
//       fresh load               STAT_TTL_MS gate         statSync compare every file
//       (resolvePack)             (~10ns fast return)     in the extends chain
//              │                        │                        │
//              │                        │              ┌──────────┴──────────┐
//              │                        │              ▼                     ▼
//              │                        │      every mtime unchanged    any mtime changed
//              │                        │              │                     │
//              │                        │      refresh lastStatMs   invalidate(name) +
//              │                        │      return cached         extends-chain cascade
//              │                        │                                  (codex C6)
//              ▼                        ▼                                   │
//       byName.set(name, entry)   return cached                       fresh load
//
// Pack resolution chain (7 tiers per D13, tier-1 trust-gated):
//   1. Per-call `schema_pack` opt — CLI only (`ctx.remote === false`).
//      Rejected for `ctx.remote === true` (D13 trust boundary).
//   2. `GBRAIN_SCHEMA_PACK` env var
//   3. Per-source DB config key `schema_pack.source.<id>`
//   4. Brain-wide DB config key `schema_pack`
//   5. `gbrain.yml schema:` section
//   6. `~/.gbrain/config.json schema_pack` field
//   7. Default `gbrain-base`
//
// Extends chain semantics (E4):
//   - Depth tracked via BFS during resolve.
//   - Soft warn to stderr at depth > 4.
//   - Hard reject at depth > 8.
//
// v0.40.6.0 cache invariants (codex C6 + D11 + D13):
//   - Cache key is the pack NAME (not identity sha8). Per-name cache entry
//     records the resolved pack PLUS every file path that fed it AND the
//     identities of every parent in the extends chain.
//   - Cache hits go through a stat-TTL gate (default 1000ms via
//     STAT_TTL_MS, env override GBRAIN_PACK_STAT_TTL_MS). Inside the
//     window: hot-path return (~10ns). Outside: statSync each file; if
//     any mtime changed, invalidate by name + cascade to every dependent.
//   - invalidatePackCache(name) walks the reverse extends-graph and
//     evicts every pack that has `name` in its chain. Without the cascade,
//     editing a parent silently leaves children stale (the codex C6 bug).
//   - The PUBLIC `ResolvedPack.identity` field is unchanged
//     (`<name>@<version>+<sha8>`); the composite cache key lives only
//     inside the registry.

import { statSync } from 'node:fs';
import type { SchemaPackManifest } from './manifest-v1.ts';
import { computeManifestSha8, packIdentity } from './manifest-v1.ts';
import { computeAliasClosureHash, buildAliasGraph, type AliasGraph } from './closure.ts';

export const EXTENDS_DEPTH_WARN = 4 as const;
export const EXTENDS_DEPTH_HARD_CAP = 8 as const;
export const STAT_TTL_MS_DEFAULT = 1000 as const;

export class ExtendsChainTooDeepError extends Error {
  readonly depth: number;
  readonly chain: string[];
  constructor(depth: number, chain: string[]) {
    super(`pack extends chain depth ${depth} exceeds hard cap ${EXTENDS_DEPTH_HARD_CAP}: ${chain.join(' → ')}`);
    this.name = 'ExtendsChainTooDeepError';
    this.depth = depth;
    this.chain = chain;
  }
}

export class UnknownPackError extends Error {
  readonly name_: string;
  constructor(name_: string) {
    super(`unknown schema pack: ${name_}`);
    this.name = 'UnknownPackError';
    this.name_ = name_;
  }
}

export interface ResolvedPack {
  manifest: SchemaPackManifest;
  identity: string;        // `<name>@<version>+<sha8>` (child only — wire-stable)
  manifest_sha8: string;
  alias_closure_hash: string;
  alias_graph: AliasGraph;
}

export interface ResolutionInput {
  perCall?: string;
  remote: boolean;
  perSourceDb?: ReadonlyMap<string, string>;
  sourceId?: string;
  envVar?: string;
  dbConfig?: string;
  gbrainYml?: string;
  homeConfig?: string;
}

export interface ResolutionResult {
  pack_name: string;
  source: 'per-call' | 'env' | 'per-source-db' | 'db-config' | 'gbrain-yml' | 'home-config' | 'default';
}

export function resolveActivePackName(input: ResolutionInput): ResolutionResult {
  if (input.perCall && input.remote === false) {
    return { pack_name: input.perCall, source: 'per-call' };
  }
  if (input.envVar) return { pack_name: input.envVar, source: 'env' };
  if (input.sourceId && input.perSourceDb?.has(input.sourceId)) {
    return { pack_name: input.perSourceDb.get(input.sourceId)!, source: 'per-source-db' };
  }
  if (input.dbConfig) return { pack_name: input.dbConfig, source: 'db-config' };
  if (input.gbrainYml) return { pack_name: input.gbrainYml, source: 'gbrain-yml' };
  if (input.homeConfig) return { pack_name: input.homeConfig, source: 'home-config' };
  return { pack_name: 'gbrain-base', source: 'default' };
}

/**
 * Per-name cache entry. Tracks the resolved pack PLUS the file-stat
 * snapshot every file in the extends chain fed at resolve time. The
 * stat snapshot is what the cross-process stat-TTL gate compares
 * against on each loadActivePack call.
 */
interface CacheEntry {
  resolved: ResolvedPack;
  /** Names that fed this entry (this pack + every parent transitively). */
  chain: ReadonlyArray<string>;
  /** Stat snapshot per file at resolve time. */
  files: ReadonlyArray<{ name: string; path: string; mtimeMs: number }>;
  /** Last time we stat()'d the files. Date.now() ms. */
  lastStatMs: number;
}

const _byName = new Map<string, CacheEntry>();

/** Test seam — clears the in-process resolver cache. */
export function _resetPackCacheForTests(): void {
  _byName.clear();
}

/**
 * Resolve the effective STAT_TTL_MS, honoring the
 * `GBRAIN_PACK_STAT_TTL_MS` env override. Invalid values fall back to
 * the default with no warning (this is a power-user knob).
 */
function resolveStatTtlMs(): number {
  const raw = process.env.GBRAIN_PACK_STAT_TTL_MS;
  if (!raw) return STAT_TTL_MS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return STAT_TTL_MS_DEFAULT;
}

/**
 * Cheap statSync that returns Infinity on error so callers treat
 * disappearing files as "changed" (forcing reload).
 */
function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Check whether a cached entry's file snapshot is still fresh on disk.
 * Returns true when EVERY file's mtime matches the snapshot.
 */
function snapshotMatches(files: ReadonlyArray<{ path: string; mtimeMs: number }>): boolean {
  for (const f of files) {
    if (safeMtimeMs(f.path) !== f.mtimeMs) return false;
  }
  return true;
}

/**
 * Walk the reverse extends-graph: every cached entry whose `chain`
 * contains `name`. The set is unbounded in principle but bounded in
 * practice by EXTENDS_DEPTH_HARD_CAP × installed packs (typically <50).
 */
function findDependents(name: string): string[] {
  const out: string[] = [];
  for (const [cachedName, entry] of _byName) {
    if (entry.chain.includes(name)) out.push(cachedName);
  }
  return out;
}

/**
 * Invalidate the cache for a pack name AND every pack that extends it
 * (transitive — the codex C6 fix). When called with no argument,
 * invalidates everything.
 *
 * Called automatically by `withMutation` (Phase 2) after every
 * successful pack mutation; also exposed via `gbrain schema reload`.
 */
export function invalidatePackCache(name?: string): { invalidated: string[] } {
  if (name === undefined) {
    const all = [..._byName.keys()];
    _byName.clear();
    return { invalidated: all };
  }
  const dependents = findDependents(name);
  // The pack itself + all dependents.
  const toEvict = Array.from(new Set([name, ...dependents]));
  for (const n of toEvict) _byName.delete(n);
  return { invalidated: toEvict };
}

/** Test-only access for assertions on the cache shape. */
export function _cacheSizeForTests(): number {
  return _byName.size;
}

/** Test-only access for assertions on which names are cached. */
export function _cacheNamesForTests(): string[] {
  return [..._byName.keys()];
}

/**
 * Resolve + cache a manifest. Loads parent packs via the `loadByName`
 * dependency, tracks extends-chain depth, applies the E4 cap.
 *
 * v0.40.6.0: cache is name-keyed and tracks file-stat snapshots so the
 * stat-TTL gate (inside `loadActivePack`) can detect cross-process
 * mutations without re-reading the bytes.
 *
 * `loadByPath` is the disk path resolver for each name in the extends
 * chain (used for the file-stat snapshot). Optional — when omitted, the
 * snapshot is empty and stat-TTL becomes a no-op for this entry (used
 * by tests that drive synthetic manifests with no disk backing).
 */
export async function resolvePack(
  manifest: SchemaPackManifest,
  loadByName: (name: string) => Promise<SchemaPackManifest>,
  opts: {
    onDepthWarn?: (depth: number, chain: string[]) => void;
    loadByPath?: (name: string) => string | null;
  } = {},
): Promise<ResolvedPack> {
  const sha8 = await computeManifestSha8(manifest);
  const id = packIdentity(manifest, sha8);

  // Reference-equality fast path: if a previous resolvePack(manifest, ...)
  // produced the SAME identity, return the cached resolved object. This
  // preserves the v0.38 contract that two calls with the same manifest
  // bytes return the same JS object reference.
  const existing = _byName.get(manifest.name);
  if (existing && existing.resolved.identity === id) {
    return existing.resolved;
  }

  // Walk extends chain to enforce depth cap AND collect names for the
  // cache snapshot (codex C6 — child cache entry must remember every
  // parent so invalidatePackCache(parentName) can cascade).
  const chain: string[] = [manifest.name];
  let cursor: SchemaPackManifest | null = manifest;
  while (cursor?.extends) {
    const parentName = cursor.extends;
    if (chain.includes(parentName)) {
      throw new ExtendsChainTooDeepError(chain.length, [...chain, parentName]);
    }
    chain.push(parentName);
    if (chain.length > EXTENDS_DEPTH_HARD_CAP) {
      throw new ExtendsChainTooDeepError(chain.length, chain);
    }
    if (chain.length > EXTENDS_DEPTH_WARN) {
      opts.onDepthWarn?.(chain.length, chain);
    }
    cursor = await loadByName(parentName);
  }

  // For v0.38 skeleton: closure is computed on the manifest itself.
  // Full extends-merging (child-wins) is the v0.41+ T20 follow-up.
  const alias_graph = buildAliasGraph(manifest);
  const alias_closure_hash = await computeAliasClosureHash(manifest);

  const resolved: ResolvedPack = {
    manifest,
    identity: id,
    manifest_sha8: sha8,
    alias_closure_hash,
    alias_graph,
  };

  // Capture file-stat snapshot for the stat-TTL gate. Skip names that
  // the locator can't resolve (synthetic manifests in tests).
  const files: Array<{ name: string; path: string; mtimeMs: number }> = [];
  if (opts.loadByPath) {
    for (const n of chain) {
      const path = opts.loadByPath(n);
      if (path === null) continue;
      files.push({ name: n, path, mtimeMs: safeMtimeMs(path) });
    }
  }

  _byName.set(manifest.name, {
    resolved,
    chain: [...chain],
    files,
    lastStatMs: Date.now(),
  });
  return resolved;
}

/**
 * Try to return a cached resolved pack for `name` without re-reading the
 * manifest from disk. Returns null on cache miss OR when the stat-TTL
 * gate detects a file change (which triggers eviction + cascade).
 *
 * The TTL gate keeps the hot path cheap: most calls inside the 1-second
 * window return immediately (~10ns) without statting. Outside the
 * window: one statSync per file in the extends chain (~50µs per file).
 * Worst-case latency for a daemon picking up an operator's mutation:
 * 1 second.
 */
export function tryCachedPack(name: string): ResolvedPack | null {
  const entry = _byName.get(name);
  if (!entry) return null;
  const ttl = resolveStatTtlMs();
  const ageMs = Date.now() - entry.lastStatMs;
  if (ageMs < ttl) return entry.resolved;
  // TTL expired: stat all files. If any changed, cascade-invalidate.
  if (!snapshotMatches(entry.files)) {
    invalidatePackCache(name);
    return null;
  }
  // Snapshot still fresh: refresh lastStatMs so the next hot-path return
  // is cheap again.
  _byName.set(name, { ...entry, lastStatMs: Date.now() });
  return entry.resolved;
}
