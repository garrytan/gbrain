/**
 * rust/scripts/release-addon.ts: the manifest a release publishes is the merge of what each target's built addon reports.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: gbrain-engine-rust.sha256.json carries every release target with the SHA-256 and size of the file that is
 *    attached, and the release build stops when targets disagree about engine_build or engine_abi, when an
 *    engine_abi is one this gbrain does not load, or when a target is missing.
 * 2. Credible regressions: a manifest that drops or mislabels a target, or ships an abi the loader refuses.
 * 3. Not covered elsewhere: the loader tests read a manifest this script would have written but never run the script.
 * 4. Production seam: none; buildManifest is the function the script's `manifest` command calls.
 */
import { describe, expect, test } from 'bun:test';
import { buildManifest, type AddonMeta } from '../rust/scripts/release-addon.ts';
import { parseRustAddonManifest, RUST_ENGINE_ABI } from '../src/core/rust-engine/addon-manifest.ts';

const meta = (target: string, asset: string, over: Partial<AddonMeta> = {}): AddonMeta => ({
  target, asset, engine_abi: RUST_ENGINE_ABI, engine_build: 'e'.repeat(64), sha256: target.length.toString(16).padStart(64, 'a'), bytes: 1000, ...over,
});
const linux = (over: Partial<AddonMeta> = {}) => meta('linux-x64-glibc', 'gbrain-engine-rust-linux-x64.node', over);
const mac = (over: Partial<AddonMeta> = {}) => meta('darwin-arm64', 'gbrain-engine-rust-darwin-arm64.node', over);

describe('release addon manifest', () => {
  test('merges both targets into a manifest the loader accepts', () => {
    const manifest = buildManifest([linux(), mac({ sha256: 'b'.repeat(64), bytes: 2000 })], '1.2.3.4');
    const parsed = parseRustAddonManifest(JSON.stringify(manifest));
    expect(parsed).toEqual({
      gbrain_version: '1.2.3.4',
      engine_abi: RUST_ENGINE_ABI,
      engine_build: 'e'.repeat(64),
      targets: {
        'linux-x64-glibc': { asset: 'gbrain-engine-rust-linux-x64.node', sha256: linux().sha256, bytes: 1000 },
        'darwin-arm64': { asset: 'gbrain-engine-rust-darwin-arm64.node', sha256: 'b'.repeat(64), bytes: 2000 },
      },
    });
  });

  test('refuses disagreeing targets, a foreign engine_abi, a missing target and an empty set', () => {
    expect(() => buildManifest([linux(), mac({ engine_build: 'f'.repeat(64) })], '1')).toThrow('engine_build');
    expect(() => buildManifest([linux(), mac({ engine_abi: RUST_ENGINE_ABI + 1 })], '1')).toThrow('engine_abi');
    expect(() => buildManifest([linux({ engine_abi: RUST_ENGINE_ABI + 1 }), mac({ engine_abi: RUST_ENGINE_ABI + 1 })], '1')).toThrow('this gbrain loads');
    expect(() => buildManifest([linux()], '1')).toThrow('darwin-arm64');
    expect(() => buildManifest([], '1')).toThrow('no addon');
  });
});
