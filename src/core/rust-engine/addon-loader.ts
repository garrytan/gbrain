/**
 * Finds, checks and loads the Rust engine addon. Only the `rust` engine's open path may import it, lazily,
 * so a PGLite or Postgres brain never loads it and never creates `<gbrain home>/engines/`. The engine shell calls
 * {@link loadRustEngineAddon}.
 *
 * Order:
 *   1. GBRAIN_RUST_ENGINE_ADDON (an absolute path to a build you made with `bun run rust:build`) is the development
 *      override. It skips only the release checksum pin; engine_abi and target are still checked.
 *   2. An addon at `<home>/engines/rust/<engine_build>/<target>-<sha256>.node` whose SHA-256 equals the cached manifest of this
 *      gbrain version (`<home>/engines/rust/manifest-<version>.json`) loads. `gbrain engine install rust`
 *      (addon-install.ts) writes both, after it checks them against the release's checksums and build attestations.
 *   3. Otherwise it refuses with rust_engine_addon_missing (not_installed). It never reaches the network.
 *
 * Every failure is `rust_engine_addon_missing` or `rust_engine_addon_mismatch`, raised before the brain is touched.
 * The addon is loaded with process.dlopen from a computed path: a literal `require('x.node')` would be bundled
 * into compiled executables, and the addon must not be inside them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { gbrainPath } from '../config.ts';
import { VERSION } from '../../version.ts';
import { defaultComputeDigest } from '../binary-self-update.ts';
import { OperationError } from '../ops/contract.ts';
import { addonMismatch, addonMissing } from './addon-errors.ts';
import { parseRustAddonManifest, RELEASE_ADDON_TARGETS, RUST_ENGINE_ABI, type RustAddonManifest } from './addon-manifest.ts';
import { detectAddonTarget } from './addon-target.ts';

/** What the loader reads from the addon; the crate's exports (rust/crates/gbrain-napi) beyond these are for the engine. */
export interface RustAddon {
  target: string;
  engineAbi: number;
  engineBuild: string;
  catalogVersion: number;
  formatVersions: unknown[];
  [name: string]: unknown;
}

export interface RustAddonLoaderDeps {
  env: Record<string, string | undefined>;
  /** gbrain home's `engines/rust` directory. */
  rustDir: string;
  /** The running gbrain version; the cached manifest must name it. */
  version: string;
  /** This platform's addon target name, or null when it cannot be identified. */
  target: string | null;
  /** SHA-256 of a file, lowercase hex. */
  computeDigest(path: string): string;
  dlopen(path: string): unknown;
}

export function defaultRustAddonLoaderDeps(): RustAddonLoaderDeps {
  return {
    env: process.env,
    rustDir: gbrainPath('engines', 'rust'),
    version: VERSION,
    target: detectAddonTarget(),
    computeDigest: defaultComputeDigest,
    dlopen(path) {
      const module = { exports: {} as unknown };
      process.dlopen(module as NodeJS.Module, path);
      return module.exports;
    },
  };
}

/** `<home>/engines/rust/manifest-<version>.json`: the release manifest that names the cached addon. */
export function cachedManifestPath(rustDir: string, version: string): string {
  return join(rustDir, `manifest-${version}.json`);
}

/**
 * `<home>/engines/rust/<engine_build>/<target>-<sha256>.node`. The SHA-256 is in the name because two releases with the
 * same engine_build (the rust/ sources) can pin different bytes, and installing one must not replace the file another
 * release's manifest names.
 */
export function addonPath(rustDir: string, engineBuild: string, target: string, sha256: string): string {
  return join(rustDir, engineBuild, `${target}-${sha256}.node`);
}

/** The installed addon path the cached manifest of `version` names for `target`, or null when it names none. */
export function installedAddonPath(rustDir: string, version: string, target: string): string | null {
  const manifest = readCachedManifest(rustDir, version);
  const entry = manifest?.targets[target];
  return manifest && entry ? addonPath(rustDir, manifest.engine_build, target, entry.sha256) : null;
}

/** Reads the cached manifest, or null when it is absent, unreadable or for another version. */
export function readCachedManifest(rustDir: string, version: string): RustAddonManifest | null {
  try {
    const manifest = parseRustAddonManifest(readFileSync(cachedManifestPath(rustDir, version), 'utf8'));
    return manifest && manifest.gbrain_version === version ? manifest : null;
  } catch {
    return null;
  }
}

interface Expected {
  target: string;
  /** Unset under the development override, which names no build to pin. */
  manifest?: RustAddonManifest;
}

function load(path: string, expected: Expected, deps: RustAddonLoaderDeps): RustAddon {
  let addon: RustAddon;
  try {
    addon = deps.dlopen(path) as RustAddon;
  } catch (err) {
    throw addonMismatch('load_failed', `The Rust engine addon at ${path} could not be loaded: ${err instanceof Error ? err.message : String(err)}.`);
  }
  if (addon?.engineAbi !== RUST_ENGINE_ABI) {
    throw addonMismatch('engine_abi', `The Rust engine addon at ${path} reports engine_abi ${String(addon?.engineAbi)}; this gbrain loads engine_abi ${RUST_ENGINE_ABI}.`);
  }
  if (addon.target !== expected.target) {
    throw addonMismatch('target', `The Rust engine addon at ${path} was built for ${String(addon.target)}; this machine is ${expected.target}.`);
  }
  if (expected.manifest && addon.engineBuild !== expected.manifest.engine_build) {
    throw addonMismatch('engine_build', `The Rust engine addon at ${path} is engine_build ${String(addon.engineBuild)}; the gbrain v${expected.manifest.gbrain_version} release names ${expected.manifest.engine_build}.`);
  }
  return addon;
}

/**
 * Loads the addon: the development override, else the cached addon whose SHA-256 matches the cached manifest.
 * It is async because the release fetch that comes later is; today it never waits on anything.
 */
export async function loadRustAddon(overrides: Partial<RustAddonLoaderDeps> = {}): Promise<RustAddon> {
  const deps: RustAddonLoaderDeps = { ...defaultRustAddonLoaderDeps(), ...overrides };

  const override = deps.env.GBRAIN_RUST_ENGINE_ADDON?.trim();
  if (override) {
    if (!isAbsolute(override) || !existsSync(override)) {
      throw addonMissing('override_not_found', `GBRAIN_RUST_ENGINE_ADDON is ${override}, which is not an existing absolute path to an addon file.`);
    }
    const target = deps.target;
    if (!target) throw addonMissing('unsupported_target', 'This machine\'s platform could not be identified, so no Rust engine addon can be chosen for it.');
    return load(override, { target }, deps);
  }

  const target = deps.target;
  if (!target || !RELEASE_ADDON_TARGETS.includes(target)) {
    throw addonMissing('unsupported_target', `No Rust engine addon is published for ${target ?? 'this platform'}; releases carry ${RELEASE_ADDON_TARGETS.join(' and ')}.`);
  }

  const cached = readCachedManifest(deps.rustDir, deps.version);
  const entry = cached?.targets[target];
  const path = cached && entry ? addonPath(deps.rustDir, cached.engine_build, target, entry.sha256) : null;
  if (!cached || !entry || !path || !existsSync(path)) {
    throw addonMissing('not_installed', `No Rust engine addon for gbrain v${deps.version} on ${target} is installed in ${deps.rustDir}. Run gbrain engine install rust to download and check it, or set GBRAIN_RUST_ENGINE_ADDON to a build from bun run rust:build.`);
  }
  let digest: string;
  try {
    digest = deps.computeDigest(path);
  } catch (err) {
    throw addonMismatch('digest', `The Rust engine addon at ${path} could not be read to check its SHA-256: ${err instanceof Error ? err.message : String(err)}.`);
  }
  if (digest !== entry.sha256) {
    throw addonMismatch('digest', `The Rust engine addon at ${path} has SHA-256 ${digest}; the gbrain v${deps.version} manifest names ${entry.sha256}.`);
  }
  return load(path, { target, manifest: cached }, deps);
}

/** The two refusal codes {@link loadRustEngineAddon} reports; nothing else is ever caught. */
export type RustEngineAddonRefusalCode = 'rust_engine_addon_missing' | 'rust_engine_addon_mismatch';

/** What {@link loadRustEngineAddon} returns: the loaded addon, or the refusal it raised before touching the brain. */
export type RustEngineAddonLoad =
  | { ok: true; addon: RustAddon }
  | { ok: false; code: RustEngineAddonRefusalCode; reason: string; message: string };

/**
 * The engine shell's entry point to the addon: {@link loadRustAddon} as a result, never a throw, for the two refusal
 * codes. Any other error (a bug, not a refusal) is re-thrown unchanged.
 */
export async function loadRustEngineAddon(overrides: Partial<RustAddonLoaderDeps> = {}): Promise<RustEngineAddonLoad> {
  try {
    return { ok: true, addon: await loadRustAddon(overrides) };
  } catch (err) {
    if (err instanceof OperationError) {
      const code = err.code as string;
      if (code === 'rust_engine_addon_missing' || code === 'rust_engine_addon_mismatch') {
        return { ok: false, code, reason: err.reason ?? 'unknown', message: err.message };
      }
    }
    throw err;
  }
}
