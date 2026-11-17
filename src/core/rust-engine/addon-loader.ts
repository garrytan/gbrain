/**
 * Finds, checks and loads the Rust engine addon. Only the `rust` engine's open path may import it, lazily,
 * so a PGLite or Postgres brain never loads it, never reaches the network for it and never creates
 * `<gbrain home>/engines/`. The engine shell calls {@link loadRustEngineAddon}.
 *
 * Order:
 *   1. GBRAIN_RUST_ENGINE_ADDON (an absolute path to a build you made with `bun run rust:build`) is the development
 *      override. It skips only the release checksum pin; engine_abi and target are still checked.
 *   2. An addon already at `<home>/engines/rust/<engine_build>/<target>.node` whose SHA-256 equals the cached manifest
 *      of this gbrain version loads with no network.
 *   3. Otherwise it is fetched (addon-fetch.ts), checked, and loaded.
 *
 * Every failure is `rust_engine_addon_missing` or `rust_engine_addon_mismatch`, raised before the brain is touched.
 * The addon is loaded with process.dlopen from a computed path: a literal `require('x.node')` would be bundled
 * into compiled executables, and the addon must not be inside them.
 */
import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { gbrainPath } from '../config.ts';
import { VERSION } from '../../version.ts';
import { OperationError } from '../ops/contract.ts';
import { addonMismatch, addonMissing } from './addon-errors.ts';
import { RELEASE_ADDON_TARGETS, RUST_ENGINE_ABI, type RustAddonManifest } from './addon-manifest.ts';
import { detectAddonTarget } from './addon-target.ts';
import {
  addonPath,
  defaultAddonFetchDeps,
  dropPreviousAddon,
  fetchAddon,
  fetchManifest,
  readCachedManifest,
  restorePreviousAddon,
  writeCachedManifest,
  type AddonFetchDeps,
} from './addon-fetch.ts';

/** What the loader reads from the addon; the crate's exports (rust/crates/gbrain-napi) beyond these are for the engine. */
export interface RustAddon {
  target: string;
  engineAbi: number;
  engineBuild: string;
  catalogVersion: number;
  formatVersions: unknown[];
  [name: string]: unknown;
}

export interface RustAddonLoaderDeps extends AddonFetchDeps {
  env: Record<string, string | undefined>;
  /** gbrain home's `engines/rust` directory. */
  rustDir: string;
  /** The running gbrain version; the release tag is `v<version>`. */
  version: string;
  /** This platform's addon target name, or null when it cannot be identified. */
  target: string | null;
  dlopen(path: string): unknown;
}

export function defaultRustAddonLoaderDeps(): RustAddonLoaderDeps {
  return {
    ...defaultAddonFetchDeps,
    env: process.env,
    rustDir: gbrainPath('engines', 'rust'),
    version: VERSION,
    target: detectAddonTarget(),
    dlopen(path) {
      const module = { exports: {} as unknown };
      process.dlopen(module as NodeJS.Module, path);
      return module.exports;
    },
  };
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

/** Removes the directories a failed fetch created under the gbrain home, when they are empty. */
function pruneNew(dirs: string[]): void {
  for (const dir of dirs.reverse()) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

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

  // An addon already in place that matches the cached manifest loads with no network call.
  const cached = readCachedManifest(deps.rustDir, deps.version);
  const entry = cached?.targets[target];
  if (cached && entry) {
    const path = addonPath(deps.rustDir, cached.engine_build, target);
    if (existsSync(path)) {
      let digest: string | null = null;
      try {
        digest = deps.computeDigest(path);
      } catch {
        // Unreadable: fall through to a fetch.
      }
      if (digest === entry.sha256) return load(path, { target, manifest: cached }, deps);
    }
  }

  const enginesDir = dirname(deps.rustDir);
  const newDirs = [enginesDir, deps.rustDir].filter((d) => !existsSync(d));
  try {
    const { manifest, text, assets } = await fetchManifest(deps.rustDir, deps.version, deps);
    const fetched = await fetchAddon(deps.rustDir, manifest, assets, target, deps);
    let addon: RustAddon;
    try {
      addon = load(fetched.path, { target, manifest }, deps);
      writeCachedManifest(deps.rustDir, deps.version, text);
    } catch (err) {
      // The file hashed and attested correctly yet is not usable here, so it must not stay where the next start
      // would find it; an addon it replaced goes back in place.
      restorePreviousAddon(fetched);
      throw err;
    }
    dropPreviousAddon(fetched);
    return addon;
  } catch (err) {
    pruneNew([...newDirs]);
    throw err;
  }
}

/** The two refusal codes {@link loadRustEngineAddon} reports; nothing else is ever caught. */
export type RustEngineAddonRefusalCode = 'rust_engine_addon_missing' | 'rust_engine_addon_mismatch';

/** What {@link loadRustEngineAddon} returns: the loaded addon, or the refusal it raised before touching the brain. */
export type RustEngineAddonLoad =
  | { ok: true; addon: RustAddon }
  | { ok: false; code: RustEngineAddonRefusalCode; reason: string; message: string };

/**
 * The engine shell's entry point to the addon: {@link loadRustAddon} as a result, never a throw, for the two refusal
 * codes. Any other error (a bug, not a refusal) is re-thrown unchanged. It is async because a first use may fetch.
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
