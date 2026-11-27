/**
 * `gbrain engine install rust`: puts the Rust engine addon this gbrain release names into the gbrain home, where the
 * loader (addon-loader.ts) finds it with no environment variable.
 *
 * Steps, each refusing before the next:
 *   1. This platform must be one a release publishes an addon for (RELEASE_ADDON_TARGETS); otherwise
 *      `unsupported_target`, with no network call.
 *   2. An addon already installed for this version, whose SHA-256 matches its cached manifest, is kept: no network.
 *   3. Download the release's manifest (`gbrain-engine-rust.sha256.json` of release `v<VERSION>`) and this target's
 *      addon (or take it from `--from <file>`) into a staging directory under `<home>/engines/rust/`.
 *   4. Check the addon's SHA-256 and size against the manifest, and check both files against their build-provenance
 *      attestation from this repository's release workflow (verifyIntegrity, as the binary self-update does).
 *   5. Rename the addon to `<engine_build>/<target>-<sha256>.node`, then write `manifest-<version>.json` last, so the
 *      loader never sees a manifest whose addon is not in place. The checksum in the name means installing one release
 *      never replaces a file another release's manifest names; an addon already there with that checksum (a release
 *      that left rust/ unchanged) is kept and not downloaded again.
 * A missing release asset is `not_published`; a network or HTTP failure is `fetch_failed`; a checksum or attestation
 * that does not match is `verification_failed`. Every failure deletes the staging directory and leaves the installed
 * addon as it was. Nothing here loads the addon: the loader checks engine_abi, target and engine_build when it opens it.
 *
 * Only this command and the post-upgrade refresh (for a brain on the Rust engine or with shadow mode on) reach the
 * network. A PGLite or Postgres brain never runs either, and never gets an `engines/` directory.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { relativeEscapesRoot } from '../path-confine.ts';
import { gbrainPath } from '../config.ts';
import { VERSION } from '../../version.ts';
import { defaultComputeDigest, defaultFetchAttestation, verifyIntegrity, type ParsedAttestation } from '../binary-self-update.ts';
import { OperationError } from '../ops/contract.ts';
import { addonMismatch, addonMissing } from './addon-errors.ts';
import { addonPath, cachedManifestPath, readCachedManifest } from './addon-loader.ts';
import {
  parseRustAddonManifest, RELEASE_ADDON_TARGETS, RUST_ADDON_MANIFEST_ASSET, RUST_ENGINE_ABI, rustAddonAssetName,
} from './addon-manifest.ts';
import { detectAddonTarget } from './addon-target.ts';

/** Largest manifest accepted; a real one is under 1 KB. */
const MANIFEST_MAX_BYTES = 64 * 1024;

export interface RustAddonInstallDeps {
  /** gbrain home's `engines/rust` directory. */
  rustDir: string;
  /** The running gbrain version; its release `v<version>` is the one read. */
  version: string;
  /** This platform's addon target name, or null when it cannot be identified. */
  target: string | null;
  /** Bytes of a release asset of `v<version>`; null when the release has no such asset (HTTP 404). Throws on any other failure. */
  fetchAsset(version: string, name: string): Promise<Uint8Array | null>;
  /** The build-provenance attestations for a SHA-256, or null when none can be read (after passing `onUnavailable` why). */
  fetchAttestation(digest: string, onUnavailable?: (detail: string) => void): Promise<ParsedAttestation[] | null>;
  computeDigest(path: string): string;
}

/** Downloads one asset of release `v<version>` from GitHub. 404 is null; anything else that is not 2xx throws. */
export async function defaultFetchReleaseAsset(version: string, name: string): Promise<Uint8Array | null> {
  const url = `https://github.com/garrytan/gbrain/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'gbrain-engine-install' },
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function defaultRustAddonInstallDeps(): RustAddonInstallDeps {
  return {
    rustDir: gbrainPath('engines', 'rust'),
    version: VERSION,
    target: detectAddonTarget(),
    fetchAsset: defaultFetchReleaseAsset,
    fetchAttestation: defaultFetchAttestation,
    computeDigest: defaultComputeDigest,
  };
}

export interface RustAddonInstallResult {
  status: 'installed' | 'already_installed';
  version: string;
  target: string;
  engine_build: string;
  sha256: string;
  /** Where the addon is, with the home directory shown as `~`. */
  path: string;
}

/** A path with the user's home directory written as `~`, so reports do not carry the user name. */
export function homeRelative(path: string): string {
  const rel = relative(homedir(), path);
  return rel && !relativeEscapesRoot(rel) ? join('~', rel) : path;
}

function writeSynced(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The installed addon for this version and target, when its bytes still match the cached manifest; else null. */
function installedAddon(deps: RustAddonInstallDeps, target: string): RustAddonInstallResult | null {
  const manifest = readCachedManifest(deps.rustDir, deps.version);
  const entry = manifest?.targets[target];
  if (!manifest || !entry) return null;
  const path = addonPath(deps.rustDir, manifest.engine_build, target, entry.sha256);
  if (!existsSync(path)) return null;
  let digest: string;
  try {
    digest = deps.computeDigest(path);
  } catch {
    return null; // silent-read-ok: an unreadable addon is reinstalled, which is what null asks for
  }
  if (digest !== entry.sha256) return null;
  return { status: 'already_installed', version: deps.version, target, engine_build: manifest.engine_build, sha256: digest, path: homeRelative(path) };
}

/** True when the file at `path` has this SHA-256; false when it differs or cannot be read. */
function sameDigest(deps: RustAddonInstallDeps, path: string, sha256: string): boolean {
  try {
    return deps.computeDigest(path) === sha256;
  } catch {
    return false; // silent-read-ok: an unreadable file is replaced by a checked download, which is what false asks for
  }
}

async function fetchOrRefuse(deps: RustAddonInstallDeps, name: string): Promise<Uint8Array> {
  let bytes: Uint8Array | null;
  try {
    bytes = await deps.fetchAsset(deps.version, name);
  } catch (err) {
    throw addonMissing('fetch_failed', `Downloading ${name} of gbrain v${deps.version} failed: ${err instanceof Error ? err.message : String(err)}. Nothing was installed; try again when the network is back.`);
  }
  if (!bytes) {
    throw addonMissing('not_published', `The gbrain v${deps.version} release publishes no ${name}, so there is no Rust engine addon to install for this version.`);
  }
  return bytes;
}

async function verifyAttested(deps: RustAddonInstallDeps, path: string, name: string): Promise<void> {
  let why = '';
  const failure = await verifyIntegrity(path, name, deps.computeDigest, (digest) => deps.fetchAttestation(digest, (detail) => { why = detail; }));
  if (failure === 'integrity_unavailable') {
    throw addonMissing('fetch_failed', `The build attestation for ${name} of gbrain v${deps.version} could not be read from GitHub${why ? ` (${why})` : ''}, so it was not installed; try again later.`);
  }
  if (failure) {
    throw addonMismatch('verification_failed', `${name} of gbrain v${deps.version} has no build attestation from the gbrain release workflow for its SHA-256, so it was deleted and not installed.`);
  }
}

/**
 * Installs the addon this release names for this platform. Idempotent. `from` is a local copy of the release addon
 * (the manifest and attestations are still read online). Throws only `rust_engine_addon_missing` or
 * `rust_engine_addon_mismatch`.
 */
export async function installRustAddon(opts: { from?: string } = {}, overrides: Partial<RustAddonInstallDeps> = {}): Promise<RustAddonInstallResult> {
  const deps: RustAddonInstallDeps = { ...defaultRustAddonInstallDeps(), ...overrides };
  const target = deps.target;
  if (!target || !RELEASE_ADDON_TARGETS.includes(target)) {
    throw addonMissing('unsupported_target', `No Rust engine addon is published for ${target ?? 'this platform'}; releases carry ${RELEASE_ADDON_TARGETS.join(' and ')}.`);
  }
  if (opts.from !== undefined && (!isAbsolute(opts.from) || !existsSync(opts.from))) {
    throw addonMissing('override_not_found', `--from ${opts.from} is not an existing absolute path to an addon file.`);
  }
  if (opts.from === undefined) {
    const installed = installedAddon(deps, target);
    if (installed) return installed;
  }

  const createdDir = !existsSync(deps.rustDir);
  mkdirSync(deps.rustDir, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(deps.rustDir, '.staging-'));
  let installed = false;
  try {
    const manifestBytes = await fetchOrRefuse(deps, RUST_ADDON_MANIFEST_ASSET);
    if (manifestBytes.byteLength > MANIFEST_MAX_BYTES) {
      throw addonMismatch('verification_failed', `${RUST_ADDON_MANIFEST_ASSET} of gbrain v${deps.version} is ${manifestBytes.byteLength} bytes, larger than any real manifest, so it was not used.`);
    }
    const stagedManifest = join(staging, RUST_ADDON_MANIFEST_ASSET);
    writeSynced(stagedManifest, manifestBytes);
    await verifyAttested(deps, stagedManifest, RUST_ADDON_MANIFEST_ASSET);
    const manifest = parseRustAddonManifest(new TextDecoder().decode(manifestBytes));
    if (!manifest || manifest.gbrain_version !== deps.version) {
      throw addonMismatch('verification_failed', `${RUST_ADDON_MANIFEST_ASSET} of gbrain v${deps.version} is not a manifest for this version, so it was not used.`);
    }
    if (manifest.engine_abi !== RUST_ENGINE_ABI) {
      throw addonMismatch('engine_abi', `The gbrain v${deps.version} release names an addon with engine_abi ${manifest.engine_abi}; this gbrain loads engine_abi ${RUST_ENGINE_ABI}.`);
    }
    const entry = manifest.targets[target];
    if (!entry || entry.asset !== rustAddonAssetName(target)) {
      throw addonMissing('not_published', `The gbrain v${deps.version} release publishes no Rust engine addon for ${target}.`);
    }

    const dest = addonPath(deps.rustDir, manifest.engine_build, target, entry.sha256);
    if (!existsSync(dest) || !sameDigest(deps, dest, entry.sha256) || opts.from !== undefined) {
      const stagedAddon = join(staging, entry.asset);
      if (opts.from !== undefined) copyFileSync(opts.from, stagedAddon);
      else writeSynced(stagedAddon, await fetchOrRefuse(deps, entry.asset));
      const digest = deps.computeDigest(stagedAddon);
      if (digest !== entry.sha256) {
        throw addonMismatch('verification_failed', `${opts.from ?? entry.asset} has SHA-256 ${digest}; the gbrain v${deps.version} manifest names ${entry.sha256}. It was not installed.`);
      }
      await verifyAttested(deps, stagedAddon, entry.asset);
      mkdirSync(join(deps.rustDir, manifest.engine_build), { recursive: true, mode: 0o700 });
      renameSync(stagedAddon, dest);
    }
    renameSync(stagedManifest, cachedManifestPath(deps.rustDir, deps.version));
    installed = true;
    return { status: 'installed', version: deps.version, target, engine_build: manifest.engine_build, sha256: entry.sha256, path: homeRelative(dest) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    // A refused first install leaves no empty engines/rust directory behind.
    if (!installed && createdDir && readdirSync(deps.rustDir).length === 0) rmSync(deps.rustDir, { recursive: true, force: true });
  }
}

/** What `gbrain engine status` reports about the addon: read from disk only, with no network call and no load. */
export interface RustAddonStatus {
  target: string | null;
  /** True when releases publish an addon for this target. */
  preview_target: boolean;
  /** GBRAIN_RUST_ENGINE_ADDON is set, so the loader uses that file and none of the fields below. */
  override: boolean;
  installed: boolean;
  path: string | null;
  sha256: string | null;
  /** The SHA-256 this release's cached manifest pins for this target. */
  pinned_sha256: string | null;
  engine_build: string | null;
}

/** `env` is the caller's environment; only GBRAIN_RUST_ENGINE_ADDON is read from it. */
export function rustAddonStatus(env: Record<string, string | undefined>, overrides: Partial<RustAddonInstallDeps> = {}): RustAddonStatus {
  const deps: RustAddonInstallDeps = { ...defaultRustAddonInstallDeps(), ...overrides };
  const target = deps.target;
  const status: RustAddonStatus = {
    target,
    preview_target: !!target && RELEASE_ADDON_TARGETS.includes(target),
    override: !!env.GBRAIN_RUST_ENGINE_ADDON?.trim(),
    installed: false, path: null, sha256: null, pinned_sha256: null, engine_build: null,
  };
  const manifest = readCachedManifest(deps.rustDir, deps.version);
  const entry = target ? manifest?.targets[target] : undefined;
  if (!manifest || !entry || !target) return status;
  const path = addonPath(deps.rustDir, manifest.engine_build, target, entry.sha256);
  status.pinned_sha256 = entry.sha256;
  status.engine_build = manifest.engine_build;
  if (!existsSync(path)) return status;
  status.path = homeRelative(path);
  try {
    status.sha256 = deps.computeDigest(path);
  } catch {
    return status; // silent-read-ok: sha256 stays null and installed false, which is what the report shows
  }
  status.installed = status.sha256 === entry.sha256;
  return status;
}

/**
 * The post-upgrade step: for a brain on the Rust engine, or one with shadow mode on, install the addon the new
 * release names. Best effort: a failure prints the install command and is returned as a warning, never thrown, so
 * an upgrade never fails for want of the addon. Any other brain returns at once, with no network call and no write.
 */
export async function refreshRustAddonAfterUpgrade(
  usesRust: () => boolean,
  overrides: Partial<RustAddonInstallDeps> = {},
  log: (line: string) => void = (line) => console.error(line),
): Promise<string | null> {
  let applies = false;
  try {
    applies = usesRust();
  } catch {
    applies = false; // silent-read-ok: no readable config means no Rust brain to refresh for
  }
  if (!applies) return null;
  try {
    const result = await installRustAddon({}, overrides);
    if (result.status === 'installed') log(`Rust engine addon for gbrain v${result.version} installed (${result.target}).`);
    return null;
  } catch (err) {
    // A refusal names its code and reason; anything else (a full disk, a permission error) is reported by its message.
    const what = err instanceof OperationError ? `${err.code} (${err.reason ?? 'unknown'}): ${err.message}` : (err instanceof Error ? err.message : String(err));
    const warning = `Rust engine addon not installed: ${what} Run gbrain engine install rust to try again.`;
    log(warning);
    return warning;
  }
}

