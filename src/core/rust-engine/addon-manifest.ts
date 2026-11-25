/**
 * What a release says about the Rust engine addon: the manifest asset's shape, its parser, and the
 * platform names the addon and the release use.
 *
 * Pure: no disk, no network and no dependencies, so the release scripts under rust/scripts can import it.
 * The manifest is `gbrain-engine-rust.sha256.json`, written by the `rust-engine.yml` release build and
 * attested by `release.yml` like the executables.
 */

/** The engine_abi this gbrain source loads. Bumped with the crate's ENGINE_ABI when the JS side of the binding changes. */
export const RUST_ENGINE_ABI = 1;

/** One target's entry: the release asset to download and what its bytes must hash to. */
export interface RustAddonManifestTarget {
  /** The release asset name, which is also the subject name in its build-provenance attestation. */
  asset: string;
  sha256: string;
  bytes: number;
}

export interface RustAddonManifest {
  gbrain_version: string;
  engine_abi: number;
  engine_build: string;
  /** Keyed by the addon's own target name (what `target()` reports), e.g. `linux-x64-glibc`, `darwin-arm64`. */
  targets: Record<string, RustAddonManifestTarget>;
}

/** The target names a release publishes an addon for; the keys of `targets` in a release manifest. */
export const RELEASE_ADDON_TARGETS: readonly string[] = ['linux-x64-glibc', 'darwin-arm64'];

/** The release asset that holds the manifest. Also the subject name of its build-provenance attestation. */
export const RUST_ADDON_MANIFEST_ASSET = 'gbrain-engine-rust.sha256.json';

/** The release asset name of one target's addon, e.g. `gbrain-engine-rust-darwin-arm64.node`. */
export function rustAddonAssetName(target: string): string {
  return `gbrain-engine-rust-${target}.node`;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Parse and validate manifest text. Returns null for anything that is not a complete manifest. */
export function parseRustAddonManifest(text: string): RustAddonManifest | null {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.gbrain_version !== 'string' || raw.gbrain_version.length === 0) return null;
  if (!Number.isInteger(raw.engine_abi)) return null;
  if (typeof raw.engine_build !== 'string' || !/^[0-9A-Za-z._-]+$/.test(raw.engine_build)) return null;
  if (!raw.targets || typeof raw.targets !== 'object') return null;
  const targets: Record<string, RustAddonManifestTarget> = {};
  for (const [name, entry] of Object.entries<any>(raw.targets)) {
    // The target and engine_build become path segments of the cache path, so they are checked as such.
    if (!/^[0-9a-z_-]+$/.test(name)) return null;
    if (!entry || typeof entry.asset !== 'string' || entry.asset.length === 0) return null;
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) return null;
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) return null;
    targets[name] = { asset: entry.asset, sha256: entry.sha256, bytes: entry.bytes };
  }
  return { gbrain_version: raw.gbrain_version, engine_abi: raw.engine_abi, engine_build: raw.engine_build, targets };
}
