/**
 * rust/scripts/release-addon.ts: the manifest a release publishes for the Rust engine addon, and when it publishes the
 * previous release's addon bytes again.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: the release manifest names every release target with the SHA-256 and size of the file published beside
 *    it, passes the parser `gbrain engine install rust` uses, and refuses a mixed or incomplete set; a release with an
 *    unchanged engine_build republishes the previous release's verified bytes, and any doubt about them publishes the
 *    new build.
 * 2. Credible regressions: a manifest whose digest is not the published file's; publishing one target only; mixing two
 *    engine_builds; carrying forward bytes that do not match the previous manifest, or carrying across an engine_build
 *    change.
 * 3. Why not already covered: the release workflow runs only on a version bump on master; nothing else runs this script.
 * 4. Production seam: none; the script's exported functions read and write the given directories.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildManifest, packageRelease, type AddonMeta } from '../rust/scripts/release-addon.ts';
import { parseRustAddonManifest, RELEASE_ADDON_TARGETS, RUST_ADDON_MANIFEST_ASSET, RUST_ENGINE_ABI, rustAddonAssetName } from '../src/core/rust-engine/addon-manifest.ts';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-release-addon-'));
  dirs.push(d);
  return d;
}

/** Lays out built addons the way download-artifact does: <dir>/<artifact>/<asset> plus <asset>.meta.json. */
function built(build: string, label: string, abi = RUST_ENGINE_ABI): string {
  const dir = tmp();
  for (const target of RELEASE_ADDON_TARGETS) {
    const asset = rustAddonAssetName(target);
    const bytes = `${label} ${target}`;
    mkdirSync(join(dir, `gbrain-engine-rust-${target}`), { recursive: true });
    writeFileSync(join(dir, `gbrain-engine-rust-${target}`, asset), bytes);
    const meta: AddonMeta = { target, asset, engine_abi: abi, engine_build: build, sha256: sha256(bytes), bytes: bytes.length };
    writeFileSync(join(dir, `gbrain-engine-rust-${target}`, `${asset}.meta.json`), JSON.stringify(meta));
  }
  return dir;
}

function meta(target: string, build = 'b1'): AddonMeta {
  return { target, asset: rustAddonAssetName(target), engine_abi: RUST_ENGINE_ABI, engine_build: build, sha256: 'a'.repeat(64), bytes: 3 };
}

describe('buildManifest', () => {
  test('refuses a set that is missing a target, mixes builds or names another engine_abi', () => {
    expect(() => buildManifest([meta('linux-x64-glibc')], '1.0.0.0')).toThrow('no addon for darwin-arm64');
    expect(() => buildManifest([meta('linux-x64-glibc', 'b1'), meta('darwin-arm64', 'b2')], '1.0.0.0')).toThrow('engine_build');
    expect(() => buildManifest(RELEASE_ADDON_TARGETS.map((t) => ({ ...meta(t), engine_abi: RUST_ENGINE_ABI + 1 })), '1.0.0.0')).toThrow('engine_abi');
  });
});

describe('packageRelease', () => {
  test('publishes the new build with a manifest the installer parses', () => {
    const out = tmp();
    const { manifest, carried } = packageRelease(built('b1', 'new'), '1.0.0.1', out);
    expect(carried).toBe(false);
    const written = parseRustAddonManifest(readFileSync(join(out, RUST_ADDON_MANIFEST_ASSET), 'utf8'));
    expect(written).toEqual(manifest);
    expect(written?.gbrain_version).toBe('1.0.0.1');
    for (const target of RELEASE_ADDON_TARGETS) {
      const bytes = readFileSync(join(out, rustAddonAssetName(target)));
      expect(written?.targets[target]).toEqual({ asset: rustAddonAssetName(target), sha256: sha256(bytes), bytes: bytes.length });
      expect(bytes.toString()).toBe(`new ${target}`);
    }
  });

  test('republishes the previous release bytes when engine_build is unchanged, and only when they check out', () => {
    const previous = tmp();
    packageRelease(built('b1', 'old'), '1.0.0.0', previous);

    const same = tmp();
    const carried = packageRelease(built('b1', 'new'), '1.0.0.1', same, previous);
    expect(carried.carried).toBe(true);
    expect(carried.manifest.gbrain_version).toBe('1.0.0.1');
    expect(readFileSync(join(same, rustAddonAssetName('darwin-arm64'))).toString()).toBe('old darwin-arm64');

    const changed = tmp();
    expect(packageRelease(built('b2', 'new'), '1.0.0.1', changed, previous).carried).toBe(false);
    expect(readFileSync(join(changed, rustAddonAssetName('darwin-arm64'))).toString()).toBe('new darwin-arm64');

    writeFileSync(join(previous, rustAddonAssetName('linux-x64-glibc')), 'tampered');
    const tampered = tmp();
    expect(packageRelease(built('b1', 'new'), '1.0.0.1', tampered, previous).carried).toBe(false);
    expect(readFileSync(join(tampered, rustAddonAssetName('linux-x64-glibc'))).toString()).toBe('new linux-x64-glibc');

    expect(packageRelease(built('b1', 'new'), '1.0.0.1', tmp(), join(tmp(), 'empty')).carried).toBe(false);
  });
});
