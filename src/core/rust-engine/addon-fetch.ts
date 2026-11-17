/**
 * Fetch the Rust engine addon for the running gbrain version into the gbrain home, checked before it
 * is ever loaded. Runs only when the rust engine is selected (see addon-loader.ts).
 *
 * Trust chain, same as the self-updater: the release for `v<version>` names a manifest asset; the manifest
 * and the addon are each checked against the build-provenance attestation (release.yml builder id,
 * asset name, SHA-256), and the addon's SHA-256 and size must equal the manifest's. The release lookup,
 * the downloads and the attestation lookup are the only network calls, and all go through
 * AddonFetchDeps. The reuse of binary-self-update.ts is deliberate: one definition of "attested".
 *
 * A fetch writes a staging file beside its destination, verifies it, fsyncs it and renames it into
 * place. On any failure the staging file is deleted, directories this call created are removed when
 * empty, and an addon already in place is left as it was.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  defaultComputeDigest,
  defaultDownload,
  defaultFetchAttestation,
  fetchReleaseByTag,
  verifyIntegrity,
  type ParsedAttestation,
  type ReleaseAsset,
} from '../binary-self-update.ts';
import { addonMismatch, addonMissing } from './addon-errors.ts';
import {
  parseRustAddonManifest,
  RUST_ADDON_MANIFEST_ASSET,
  RUST_ENGINE_ABI,
  type RustAddonManifest,
  type RustAddonManifestTarget,
} from './addon-manifest.ts';

export interface AddonFetchDeps {
  fetchRelease(tag: string): Promise<{ tag: string; assets: ReleaseAsset[] } | null>;
  download(url: string, destPath: string): Promise<void>;
  computeDigest(path: string): string;
  fetchAttestation(digest: string): Promise<ParsedAttestation[] | null>;
}

export const defaultAddonFetchDeps: AddonFetchDeps = {
  fetchRelease: fetchReleaseByTag,
  download: defaultDownload,
  computeDigest: defaultComputeDigest,
  fetchAttestation: defaultFetchAttestation,
};

/** `<home>/engines/rust/manifest-<version>.json`: the manifest of the release the addon was fetched for, written after the addon verified. */
export function cachedManifestPath(rustDir: string, version: string): string {
  return join(rustDir, `manifest-${version}.json`);
}

/** `<home>/engines/rust/<engine_build>/<target>.node` */
export function addonPath(rustDir: string, engineBuild: string, target: string): string {
  return join(rustDir, engineBuild, `${target}.node`);
}

/** Reads the cached manifest, or null when it is absent, unreadable or for another version. Never touches the network. */
export function readCachedManifest(rustDir: string, version: string): RustAddonManifest | null {
  try {
    const manifest = parseRustAddonManifest(readFileSync(cachedManifestPath(rustDir, version), 'utf8'));
    return manifest && manifest.gbrain_version === version ? manifest : null;
  } catch {
    return null;
  }
}

/** Creates `dir` (and parents) and returns the directories it had to create, outermost first. */
function mkdirTracked(dir: string): string[] {
  const created: string[] = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) created.unshift(d);
  mkdirSync(dir, { recursive: true });
  return created;
}

function stagingName(label: string): string {
  return `.${label}.${process.pid}.${randomBytes(4).toString('hex')}.staging`;
}

function fsyncFile(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    fsyncSync(fd);
  } catch {
    // A read-write reopen can fail on Windows; the download already fsynced the descriptor that wrote the bytes.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Runs `body` with a staging path in `dir`; always deletes the staging file, and removes the directories it made if it throws. */
async function withStaging<T>(dir: string, label: string, body: (staged: string) => Promise<T>): Promise<T> {
  const created = mkdirTracked(dir);
  const staged = join(dir, stagingName(label));
  try {
    return await body(staged);
  } catch (err) {
    rmSync(staged, { force: true });
    for (const d of created.reverse()) {
      try {
        rmdirSync(d);
      } catch {
        // Not empty (something else wrote there) or already gone: leave it.
      }
    }
    throw err;
  } finally {
    rmSync(staged, { force: true });
  }
}

async function downloadChecked(deps: AddonFetchDeps, asset: ReleaseAsset, staged: string): Promise<void> {
  try {
    await deps.download(asset.url, staged);
  } catch (err) {
    throw addonMissing('download_failed', `Could not download ${asset.name}: ${err instanceof Error ? err.message : String(err)}.`);
  }
}

async function attest(deps: AddonFetchDeps, staged: string, assetName: string): Promise<void> {
  const reason = await verifyIntegrity(staged, assetName, deps.computeDigest, deps.fetchAttestation);
  if (reason === 'integrity_unavailable') {
    throw addonMissing('attestation_unavailable', `Could not read a build-provenance attestation for ${assetName} (GitHub was unreachable, rate-limited, or has none).`);
  }
  if (reason) {
    throw addonMismatch('attestation', `${assetName} is not covered by a build-provenance attestation from the gbrain release workflow.`);
  }
}

/** Looks up the release for `v<version>`, downloads its manifest and checks it. Returns the manifest, its text and the release's assets. */
export async function fetchManifest(
  rustDir: string,
  version: string,
  deps: AddonFetchDeps,
): Promise<{ manifest: RustAddonManifest; text: string; assets: ReleaseAsset[] }> {
  const release = await deps.fetchRelease(`v${version}`);
  if (!release) throw addonMissing('release_unavailable', `Could not read the gbrain v${version} release from GitHub.`);
  const asset = release.assets.find((a) => a.name === RUST_ADDON_MANIFEST_ASSET);
  if (!asset) throw addonMissing('manifest_unavailable', `The gbrain v${version} release has no ${RUST_ADDON_MANIFEST_ASSET}, so it carries no Rust engine addon.`);
  return withStaging(rustDir, 'manifest', async (staged) => {
    await downloadChecked(deps, asset, staged);
    await attest(deps, staged, asset.name);
    const text = readFileSync(staged, 'utf8');
    const manifest = parseRustAddonManifest(text);
    if (!manifest || manifest.gbrain_version !== version) {
      throw addonMissing('manifest_unavailable', `${RUST_ADDON_MANIFEST_ASSET} in the gbrain v${version} release is not a manifest for v${version}.`);
    }
    return { manifest, text, assets: release.assets };
  });
}

/**
 * Downloads the addon the manifest names for `target`, checks it, and renames it to
 * `<rustDir>/<engine_build>/<target>.node`. Returns that path.
 */
export async function fetchAddon(
  rustDir: string,
  manifest: RustAddonManifest,
  assets: ReleaseAsset[],
  target: string,
  deps: AddonFetchDeps,
): Promise<string> {
  const entry: RustAddonManifestTarget | undefined = manifest.targets[target];
  if (!entry) throw addonMissing('unsupported_target', `No Rust engine addon is published for ${target} in the gbrain v${manifest.gbrain_version} release.`);
  if (manifest.engine_abi !== RUST_ENGINE_ABI) {
    throw addonMismatch('engine_abi', `The gbrain v${manifest.gbrain_version} release carries a Rust engine addon with engine_abi ${manifest.engine_abi}; this gbrain loads engine_abi ${RUST_ENGINE_ABI}.`);
  }
  const asset = assets.find((a) => a.name === entry.asset);
  if (!asset) throw addonMissing('asset_unavailable', `The gbrain v${manifest.gbrain_version} release lists ${entry.asset} in its manifest but does not carry it.`);

  const dest = addonPath(rustDir, manifest.engine_build, target);
  return withStaging(dirname(dest), target, async (staged) => {
    await downloadChecked(deps, asset, staged);
    let digest: string;
    try {
      digest = deps.computeDigest(staged);
    } catch {
      throw addonMissing('download_failed', `Could not read the downloaded ${entry.asset} back to check it.`);
    }
    if (digest !== entry.sha256 || statSync(staged).size !== entry.bytes) {
      throw addonMismatch('digest', `${entry.asset} does not match the checksum in ${RUST_ADDON_MANIFEST_ASSET} (expected sha256 ${entry.sha256}, ${entry.bytes} bytes).`);
    }
    await attest(deps, staged, entry.asset);
    fsyncFile(staged);
    renameSync(staged, dest);
    return dest;
  });
}

/** Writes the verified manifest beside the addon so the next start can check the cached addon with no network. Atomic. */
export function writeCachedManifest(rustDir: string, version: string, text: string): void {
  mkdirSync(rustDir, { recursive: true });
  const staged = join(rustDir, stagingName('manifest'));
  try {
    writeFileSync(staged, text);
    fsyncFile(staged);
    renameSync(staged, cachedManifestPath(rustDir, version));
  } finally {
    rmSync(staged, { force: true });
  }
}
