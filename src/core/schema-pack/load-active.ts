// v0.38 active-pack loader — the boundary helper Phase B consumers call.
//
// Composes:
//   1. Resolution chain (registry.resolveActivePackName) — 7 tiers per D13
//   2. Pack manifest loading from disk:
//      - Built-in 'gbrain-base' lives at src/core/schema-pack/base/gbrain-base.yaml
//      - User packs live at ~/.gbrain/schema-packs/<name>/pack.yaml
//      - Custom paths supported via `__setPackLocatorForTests` (test seam)
//   3. `extends` chain resolution (registry.resolvePack)
//
// Result: a `ResolvedPack` keyed by pack identity (sha8-stable). Cached
// in-process; cache invalidated by manifest content changes (sha8 mismatch).
//
// Trust gate: per-call schema_pack opt is honored ONLY when
// `ctx.remote === false`. Remote/MCP callers passing schema_pack get
// `permission_denied` BEFORE this is invoked — operations.ts handles the
// rejection at the dispatch layer. This helper assumes the input is
// already-trust-vetted.
//
// Test seam: `__setPackLocatorForTests` replaces the disk-loader so unit
// tests can drive the boundary helper with synthetic packs without
// writing to `~/.gbrain/schema-packs/`.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GBrainConfig } from '../config.ts';
import { gbrainPath } from '../config.ts';
import type { SchemaPackManifest } from './manifest-v1.ts';
import { loadPackFromFile } from './loader.ts';
import {
  resolveActivePackName,
  resolvePack,
  tryCachedPack,
  UnknownPackError,
  type ResolvedPack,
  type ResolutionInput,
  type ResolutionResult,
} from './registry.ts';

/**
 * Inputs the caller (operations.ts handler / engine query path) provides.
 * Most callers only need `cfg` + `remote`; thin-client + source-aware
 * ops pass additional fields.
 */
export interface LoadActivePackInput {
  /** Loaded GBrain config (file + env merged). Pass null for default-only resolution. */
  cfg: GBrainConfig | null;
  /** Tier-1 trust gate: false for CLI, true for MCP/OAuth callers. */
  remote: boolean;
  /** Tier-1 per-call opt. Honored only when remote=false. */
  perCall?: string;
  /** Tier-3 per-source query target. */
  sourceId?: string;
  /** Tier-3 per-source DB config map (from `gbrain config get` keyspace). */
  perSourceDb?: ReadonlyMap<string, string>;
  /** Tier-5 gbrain.yml schema.pack field (already parsed by storage-config). */
  gbrainYml?: string;
  /** Tier-4 brain-wide DB config (overrides tier 6 file-plane). */
  dbConfig?: string;
}

/**
 * Test seam — a function that maps a pack name to the file path on disk.
 * Production wires this to the built-in + ~/.gbrain/schema-packs lookup.
 * Tests inject a Map-backed locator.
 */
export type PackLocator = (name: string) => string | null;

let _packLocator: PackLocator = defaultPackLocator;

/**
 * Replace the pack locator. Tests use this to inject synthetic packs
 * without writing to ~/.gbrain. Always pair with `_resetPackLocatorForTests`
 * in afterAll to avoid leaking across files.
 */
export function __setPackLocatorForTests(locator: PackLocator): void {
  _packLocator = locator;
}

/** Reset to the default disk-backed locator. */
export function _resetPackLocatorForTests(): void {
  _packLocator = defaultPackLocator;
}

/**
 * Default pack locator: maps a pack name to its filesystem path.
 *   'gbrain-base' → bundled src/core/schema-pack/base/gbrain-base.yaml
 *   other         → ~/.gbrain/schema-packs/<name>/pack.yaml or pack.json
 *
 * Returns null when the pack is not found. Callers handle null by
 * throwing UnknownPackError with a paste-ready install hint.
 */
function defaultPackLocator(name: string): string | null {
  // v0.39 T8 — bundled packs registry. gbrain-base + gbrain-recommended
  // ship in src/core/schema-pack/base/. Add a new entry here to bundle
  // additional canonical packs.
  //
  // v0.41 T4 — lens packs join the bundle: creator (atoms + concepts +
  // extract_atoms/synthesize_concepts phases), investor (theses + bet
  // resolution + 3 calibration domains), engineer (gstack-learnings bridge
  // + 3 calibration domains), everything (meta-pack stacking all three
  // via extends + borrow_from). Each ships as a real YAML at base/<name>.yaml.
  const BUNDLED: ReadonlyArray<string> = [
    'gbrain-base',
    'gbrain-recommended',
    'gbrain-creator',
    'gbrain-investor',
    'gbrain-engineer',
    'gbrain-everything',
    // v0.42 type-unification: 15-type canonical successor to gbrain-base.
    // Ships as install default (Lane E T17) + via gbrain onboard pack
    // upgrade flow (the unify-types Minion handler).
    'gbrain-base-v2',
  ];
  if (BUNDLED.includes(name)) {
    // Resolve bundled YAML relative to this source file. Works in both
    // direct-bun execution and bun --compile binaries.
    const here = dirname(fileURLToPath(import.meta.url));
    const bundledPath = join(here, 'base', `${name}.yaml`);
    if (existsSync(bundledPath)) return bundledPath;
    // Repo-root fallback for tests running from a worktree where the
    // module path doesn't resolve to the source tree.
    const repoRootFallback = join(here, '..', '..', '..', 'src', 'core', 'schema-pack', 'base', `${name}.yaml`);
    if (existsSync(repoRootFallback)) return repoRootFallback;
    return null;
  }
  // User-installed pack at ~/.gbrain/schema-packs/<name>/pack.{yaml,json}
  const baseDir = gbrainPath('schema-packs', name);
  const candidates = ['pack.yaml', 'pack.yml', 'pack.json'];
  for (const c of candidates) {
    const candidate = join(baseDir, c);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Load + parse + validate a pack by name. Used by `resolvePack` to walk
 * the extends chain. Throws UnknownPackError when the pack isn't on disk.
 */
async function loadPackManifestByName(name: string): Promise<SchemaPackManifest> {
  const path = _packLocator(name);
  if (!path) {
    throw new UnknownPackError(name);
  }
  return loadPackFromFile(path);
}

/**
 * The boundary helper. Resolves the active pack identity, loads the
 * manifest from disk, walks the extends chain, builds the alias graph
 * + closure hash, and returns the cached ResolvedPack.
 *
 * Throws:
 *   - UnknownPackError if the resolved pack name isn't on disk
 *   - ExtendsChainTooDeepError if the parent chain exceeds depth 8
 *   - AliasCycleError if the manifest contains a cycle in the alias graph
 *   - SchemaPackManifestError if any manifest fails validation
 */
export async function loadActivePack(input: LoadActivePackInput): Promise<ResolvedPack> {
  const resolutionInput = buildResolutionInput(input);
  const resolution: ResolutionResult = resolveActivePackName(resolutionInput);
  // v0.40.6.0: TTL-gated cache fast path. Inside STAT_TTL_MS (default 1s)
  // returns immediately (~10ns). Outside the window: stats files in the
  // extends chain; cascade-invalidates and falls through on mtime change.
  const cached = tryCachedPack(resolution.pack_name);
  if (cached) return cached;
  const manifest = await loadPackManifestByName(resolution.pack_name);
  // Thread the locator so resolvePack can snapshot file paths + mtimes
  // for the stat-TTL gate on subsequent calls (codex C6 + D11 + D13).
  return await resolvePack(manifest, loadPackManifestByName, {
    loadByPath: (name) => _packLocator(name),
  });
}

/**
 * Return the resolved pack NAME and source tier WITHOUT loading the
 * manifest from disk. Used by `gbrain schema active` to surface
 * provenance ("active pack: garry — source: gbrain.yml") without
 * paying the load cost.
 */
export function resolveActivePackNameOnly(input: LoadActivePackInput): ResolutionResult {
  return resolveActivePackName(buildResolutionInput(input));
}

/**
 * v0.42 (T4, plan D7): enumerate packs whose `migration_from` declares a
 * version range matching (packName, packVersion). Used by the
 * `checkPackUpgradeAvailable` onboard check to surface "your brain is on
 * gbrain-base@1.x; gbrain-base-v2@1.0.0 is available." Results sorted by
 * successor version descending so the highest-available successor wins.
 *
 * Walks BUNDLED_PACK_NAMES + any installed pack under `~/.gbrain/schema-packs/`
 * discoverable via the locator. Each candidate is loaded + parsed; load
 * failures are logged-and-skipped per the D4 EMPTY FILTER contract — a
 * corrupt pack on disk doesn't break the upgrade-available check for
 * everyone else.
 *
 * Version-range matching supports:
 *   - exact literal: `1.0.0` matches `1.0.0` only
 *   - major wildcard: `1.x` matches `1.0.0`, `1.5.2`, etc.
 *   - minor wildcard: `1.0.x` matches `1.0.0`, `1.0.5`, etc.
 *
 * Returns empty array when no successors found (caller interprets as
 * "brain already on latest").
 */
export async function findPackSuccessors(
  packName: string,
  packVersion: string,
): Promise<ResolvedPack[]> {
  const { BUNDLED_PACK_NAMES } = await import('./mutate.ts');
  const candidates: string[] = [];
  for (const name of BUNDLED_PACK_NAMES) {
    if (name !== packName) candidates.push(name);
  }
  // Walk ~/.gbrain/schema-packs/* via the locator. We can't enumerate
  // directly without filesystem scan; defer to v0.43+ for installed-pack
  // enumeration. Bundled packs alone cover v0.42's gbrain-base→v2 path.

  const successors: ResolvedPack[] = [];
  for (const candidateName of candidates) {
    try {
      const candidate = await loadActivePack({
        cfg: null,
        remote: false,
        perCall: candidateName,
      });
      const mf = candidate.manifest.migration_from;
      if (!mf) continue;
      if (mf.pack !== packName) continue;
      if (!_versionRangeMatches(packVersion, mf.version)) continue;
      successors.push(candidate);
    } catch {
      // Log-and-skip per D4 EMPTY FILTER contract; corrupt pack on disk
      // shouldn't break the upgrade-available check.
      continue;
    }
  }
  // Sort by successor version desc (so the newest successor wins when
  // multiple match — uncommon today but defensive for v0.43+).
  successors.sort((a, b) => _versionDescCompare(b.manifest.version, a.manifest.version));
  return successors;
}

/**
 * @internal exported for unit test seam (test/schema-pack-find-successors.test.ts).
 * Matches version against a wildcard range: `1.x` / `1.0.x` / `1.0.0` literal.
 */
export function _versionRangeMatches(version: string, range: string): boolean {
  // Exact match (no wildcards)
  if (!range.includes('x') && !range.includes('*')) {
    return version === range;
  }
  // Convert range like `1.x` or `1.0.x` to a regex
  const rangeParts = range.split('.');
  const versionParts = version.split('.');
  if (rangeParts.length > versionParts.length) return false;
  for (let i = 0; i < rangeParts.length; i++) {
    const r = rangeParts[i];
    if (r === 'x' || r === '*') continue;
    if (r !== versionParts[i]) return false;
  }
  return true;
}

/**
 * @internal Compare two semver strings (M.m.p). Negative if a < b; positive
 * if a > b; zero if equal. Treats `0.41.2.0` (4-part) by truncating to
 * 3-part because Zod schema validates `M.m.p` only.
 */
export function _versionDescCompare(a: string, b: string): number {
  const ap = a.split('.').slice(0, 3).map(n => parseInt(n, 10));
  const bp = b.split('.').slice(0, 3).map(n => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((ap[i] ?? 0) !== (bp[i] ?? 0)) return (ap[i] ?? 0) - (bp[i] ?? 0);
  }
  return 0;
}

function buildResolutionInput(input: LoadActivePackInput): ResolutionInput {
  const envVar = process.env.GBRAIN_SCHEMA_PACK?.trim() || undefined;
  // tier-6: ~/.gbrain/config.json schema_pack field
  const homeConfig = input.cfg?.schema_pack?.trim() || undefined;
  return {
    perCall: input.perCall,
    remote: input.remote,
    perSourceDb: input.perSourceDb,
    sourceId: input.sourceId,
    envVar,
    dbConfig: input.dbConfig,
    gbrainYml: input.gbrainYml,
    homeConfig,
  };
}
