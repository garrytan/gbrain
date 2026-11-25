/**
 * `gbrain engine install rust`: download the Rust engine addon this release names, check it, and put it where the
 * loader finds it with no GBRAIN_RUST_ENGINE_ADDON.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: an install puts `manifest-<version>.json` and `<engine_build>/<target>-<sha256>.node` under the gbrain home only
 *    after the addon's SHA-256 matches the release manifest and both files carry this repository's release-workflow
 *    attestation; the loader then loads it with no environment variable. Every refusal (unsupported platform with no
 *    network call, a release with no addon, a failed download, a bad checksum or attestation) leaves the gbrain home
 *    as it was. The post-upgrade refresh never fetches for a brain that does not use Rust and never throws.
 * 2. Credible regressions: installing before the checksum or attestation check; writing the manifest before the addon
 *    (a loader sees a manifest whose addon is missing); leaving staging files behind; fetching on an unsupported
 *    platform or for a PGLite brain; an upgrade failing because the addon fetch failed; the loader's refusal not naming
 *    the install command.
 * 3. Why not already covered: nothing installed the addon before this command; rust-engine-addon-loader.test.ts writes
 *    the cache by hand.
 * 4. Production seam: RustAddonInstallDeps (`fetchAsset`, `fetchAttestation`, `computeDigest`, `target`, `rustDir`,
 *    `version`); the network is the only thing tests replace. The real-addon case loads the addon `bun run rust:build`
 *    made, served as the release asset; without that build it skips (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 fails instead).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { EXPECTED_BUILDER_IDS, type ParsedAttestation } from '../src/core/binary-self-update.ts';
import {
  installRustAddon, refreshRustAddonAfterUpgrade, rustAddonStatus, type RustAddonInstallDeps,
} from '../src/core/rust-engine/addon-install.ts';
import { loadRustAddon, loadRustEngineAddon } from '../src/core/rust-engine/addon-loader.ts';
import { RUST_ADDON_MANIFEST_ASSET, RUST_ENGINE_ABI, rustAddonAssetName } from '../src/core/rust-engine/addon-manifest.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { runEngineInstall } from '../src/commands/engine-install.ts';
import { configuredBrainUsesRust, installAddonWithInstalledBinary } from '../src/commands/rust-addon-upgrade.ts';
import type { EngineConfig } from '../src/core/types.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const VERSION = '9.9.9.9';
const TARGET = 'linux-x64-glibc';
const BUILD = 'b'.repeat(64);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'gbrain-addon-install-'));
  dirs.push(d);
  return d;
}

/** Every path under `root`, relative and sorted, with each file's SHA-256. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const isDir = statSync(path).isDirectory();
      out.push(relative(root, path) + (isDir ? '/' : ` ${sha256(readFileSync(path))}`));
      if (isDir) walk(path);
    }
  };
  walk(root);
  return out.sort();
}

interface FakeRelease {
  deps: RustAddonInstallDeps;
  rustDir: string;
  addon: Uint8Array;
  /** Release assets by name; delete one to make it a 404. */
  assets: Map<string, Uint8Array>;
  /** Digests the release workflow attested, by subject name. */
  attested: Map<string, string>;
  fetched: string[];
}

function manifestFor(addon: Uint8Array, opts: { version?: string; abi?: number; targets?: string[] } = {}): Uint8Array {
  const targets: Record<string, unknown> = {};
  for (const t of opts.targets ?? [TARGET]) targets[t] = { asset: rustAddonAssetName(t), sha256: sha256(addon), bytes: addon.byteLength };
  return new TextEncoder().encode(JSON.stringify({ gbrain_version: opts.version ?? VERSION, engine_abi: opts.abi ?? RUST_ENGINE_ABI, engine_build: BUILD, targets }));
}

function fakeRelease(opts: { addon?: Uint8Array; manifest?: Uint8Array; target?: string | null; version?: string } = {}): FakeRelease {
  const rustDir = join(tmp(), '.gbrain', 'engines', 'rust');
  const addon = opts.addon ?? new TextEncoder().encode('a release addon');
  const manifest = opts.manifest ?? manifestFor(addon);
  const assets = new Map<string, Uint8Array>([[RUST_ADDON_MANIFEST_ASSET, manifest], [rustAddonAssetName(TARGET), addon]]);
  const attested = new Map<string, string>([[RUST_ADDON_MANIFEST_ASSET, sha256(manifest)], [rustAddonAssetName(TARGET), sha256(addon)]]);
  const fetched: string[] = [];
  const r: FakeRelease = {
    rustDir, addon, assets, attested, fetched,
    deps: {
      rustDir,
      version: opts.version ?? VERSION,
      target: opts.target === undefined ? TARGET : opts.target,
      computeDigest: (path) => sha256(readFileSync(path)),
      async fetchAsset(version, name) {
        fetched.push(`${version}/${name}`);
        return r.assets.get(name) ?? null;
      },
      async fetchAttestation(digest): Promise<ParsedAttestation[] | null> {
        const subjects = [...r.attested].filter(([, d]) => d === digest).map(([name, d]) => ({ name, sha256: d }));
        return subjects.length ? [{ builderId: EXPECTED_BUILDER_IDS[0]!, subjects }] : null;
      },
    },
  };
  return r;
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; reason: string | undefined }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OperationError) return { code: err.code, reason: err.reason };
    throw err;
  }
  throw new Error('expected a refusal');
}

const fakeDlopen = (target = TARGET, engineBuild = BUILD) => () => ({ target, engineAbi: RUST_ENGINE_ABI, engineBuild, catalogVersion: 1, formatVersions: [] });

describe('installRustAddon', () => {
  test('installs the checked addon where the loader finds it with no GBRAIN_RUST_ENGINE_ADDON', async () => {
    const r = fakeRelease();
    const result = await installRustAddon({}, r.deps);
    expect(result).toMatchObject({ status: 'installed', version: VERSION, target: TARGET, engine_build: BUILD, sha256: sha256(r.addon) });
    expect(tree(r.rustDir)).toEqual([`${BUILD}/`, `${BUILD}/${TARGET}-${sha256(r.addon)}.node ${sha256(r.addon)}`, `manifest-${VERSION}.json ${sha256(r.assets.get(RUST_ADDON_MANIFEST_ASSET)!)}`]);
    const addon = await loadRustAddon({ env: {}, rustDir: r.rustDir, version: VERSION, target: TARGET, dlopen: fakeDlopen() });
    expect(addon.engineBuild).toBe(BUILD);
  });

  test('a second install keeps the installed addon and makes no network call', async () => {
    const r = fakeRelease();
    await installRustAddon({}, r.deps);
    r.fetched.length = 0;
    expect((await installRustAddon({}, r.deps)).status).toBe('already_installed');
    expect(r.fetched).toEqual([]);
  });

  test('a later release with the same engine_build but other bytes leaves the earlier release loadable', async () => {
    const a = fakeRelease();
    await installRustAddon({}, a.deps);
    const otherBytes = new TextEncoder().encode('a rebuilt addon');
    const b = fakeRelease({ addon: otherBytes, version: '9.9.9.10', manifest: manifestFor(otherBytes, { version: '9.9.9.10' }) });
    b.deps.rustDir = a.rustDir;
    await installRustAddon({}, b.deps);
    for (const [version, bytes] of [[VERSION, a.addon], ['9.9.9.10', otherBytes]] as const) {
      const addon = await loadRustAddon({ env: {}, rustDir: a.rustDir, version, target: TARGET, dlopen: fakeDlopen(), computeDigest: (p) => sha256(readFileSync(p)) });
      expect({ version, build: addon.engineBuild, sha: rustAddonStatus({}, { ...a.deps, version }).sha256 }).toEqual({ version, build: BUILD, sha: sha256(bytes) });
    }
  });

  test('a later release that pins the same addon bytes downloads only its manifest', async () => {
    const a = fakeRelease();
    await installRustAddon({}, a.deps);
    const b = fakeRelease({ addon: a.addon, version: '9.9.9.10', manifest: manifestFor(a.addon, { version: '9.9.9.10' }) });
    b.deps.rustDir = a.rustDir;
    expect((await installRustAddon({}, b.deps)).status).toBe('installed');
    expect(b.fetched).toEqual([`9.9.9.10/${RUST_ADDON_MANIFEST_ASSET}`]);
  });

  test('an unsupported or unknown platform refuses with no network call and writes nothing', async () => {
    for (const target of ['linux-arm64-glibc', 'linux-x64-musl', 'darwin-x64', 'win32-x64', null]) {
      const r = fakeRelease({ target });
      expect(await refusal(installRustAddon({}, r.deps))).toEqual({ code: 'rust_engine_addon_missing', reason: 'unsupported_target' });
      expect(r.fetched).toEqual([]);
      expect(existsSync(r.rustDir)).toBe(false);
    }
  });

  test('a release with no manifest, or none for this target, is not_published', async () => {
    const none = fakeRelease();
    none.assets.delete(RUST_ADDON_MANIFEST_ASSET);
    expect(await refusal(installRustAddon({}, none.deps))).toEqual({ code: 'rust_engine_addon_missing', reason: 'not_published' });
    expect(existsSync(none.rustDir)).toBe(false);

    const other = fakeRelease();
    other.assets.set(RUST_ADDON_MANIFEST_ASSET, manifestFor(other.addon, { targets: ['darwin-arm64'] }));
    other.attested.set(RUST_ADDON_MANIFEST_ASSET, sha256(other.assets.get(RUST_ADDON_MANIFEST_ASSET)!));
    expect(await refusal(installRustAddon({}, other.deps))).toEqual({ code: 'rust_engine_addon_missing', reason: 'not_published' });
    expect(tree(other.rustDir)).toEqual([]);
  });

  test('a download that fails is fetch_failed and leaves the installed addon as it was', async () => {
    const r = fakeRelease();
    await installRustAddon({}, r.deps);
    const before = tree(r.rustDir);
    const next = manifestFor(new TextEncoder().encode('the next addon'), { version: '9.9.9.10' });
    const deps = { ...r.deps, version: '9.9.9.10', fetchAsset: async (_v: string, name: string) => {
      if (name === RUST_ADDON_MANIFEST_ASSET) return next;
      throw new Error('connection reset');
    } };
    r.attested.set(RUST_ADDON_MANIFEST_ASSET, sha256(next));
    expect(await refusal(installRustAddon({}, deps))).toEqual({ code: 'rust_engine_addon_missing', reason: 'fetch_failed' });
    expect(tree(r.rustDir)).toEqual(before);
  });

  test('an addon whose SHA-256 differs from the manifest is verification_failed and is not installed', async () => {
    const r = fakeRelease();
    r.assets.set(rustAddonAssetName(TARGET), new TextEncoder().encode('a swapped addon'));
    expect(await refusal(installRustAddon({}, r.deps))).toEqual({ code: 'rust_engine_addon_mismatch', reason: 'verification_failed' });
    expect(tree(r.rustDir)).toEqual([]);
  });

  test('a file with no release-workflow attestation is refused; an unreadable attestation is fetch_failed', async () => {
    const foreign = fakeRelease();
    foreign.deps.fetchAttestation = async (digest) => [{ builderId: 'https://github.com/someone/fork/.github/workflows/release.yml@refs/heads/master', subjects: [{ name: RUST_ADDON_MANIFEST_ASSET, sha256: digest }, { name: rustAddonAssetName(TARGET), sha256: digest }] }];
    expect(await refusal(installRustAddon({}, foreign.deps))).toEqual({ code: 'rust_engine_addon_mismatch', reason: 'verification_failed' });
    expect(tree(foreign.rustDir)).toEqual([]);

    const unattestedAddon = fakeRelease();
    unattestedAddon.attested.delete(rustAddonAssetName(TARGET));
    expect(await refusal(installRustAddon({}, unattestedAddon.deps))).toEqual({ code: 'rust_engine_addon_missing', reason: 'fetch_failed' });
    expect(tree(unattestedAddon.rustDir)).toEqual([]);
  });

  test('a manifest for another version or engine_abi is refused', async () => {
    const r = fakeRelease();
    r.assets.set(RUST_ADDON_MANIFEST_ASSET, manifestFor(r.addon, { version: '1.2.3.4' }));
    r.attested.set(RUST_ADDON_MANIFEST_ASSET, sha256(r.assets.get(RUST_ADDON_MANIFEST_ASSET)!));
    expect(await refusal(installRustAddon({}, r.deps))).toEqual({ code: 'rust_engine_addon_mismatch', reason: 'verification_failed' });

    const abi = fakeRelease();
    abi.assets.set(RUST_ADDON_MANIFEST_ASSET, manifestFor(abi.addon, { abi: RUST_ENGINE_ABI + 1 }));
    abi.attested.set(RUST_ADDON_MANIFEST_ASSET, sha256(abi.assets.get(RUST_ADDON_MANIFEST_ASSET)!));
    expect(await refusal(installRustAddon({}, abi.deps))).toEqual({ code: 'rust_engine_addon_mismatch', reason: 'engine_abi' });
    expect(tree(abi.rustDir)).toEqual([]);
  });

  test('--from installs a local copy of the release addon without downloading it, and refuses a different file', async () => {
    const r = fakeRelease();
    const copy = join(tmp(), 'addon.node');
    writeFileSync(copy, r.addon);
    expect((await installRustAddon({ from: copy }, r.deps)).status).toBe('installed');
    expect(r.fetched).toEqual([`${VERSION}/${RUST_ADDON_MANIFEST_ASSET}`]);

    const before = tree(r.rustDir);
    writeFileSync(copy, 'another file');
    expect(await refusal(installRustAddon({ from: copy }, r.deps))).toEqual({ code: 'rust_engine_addon_mismatch', reason: 'verification_failed' });
    expect(tree(r.rustDir)).toEqual(before);
    expect(await refusal(installRustAddon({ from: 'addon.node' }, r.deps))).toEqual({ code: 'rust_engine_addon_missing', reason: 'override_not_found' });
  });
});

describe('the loader and shadow start name the install command', () => {
  test('a missing addon refusal tells the user to run gbrain engine install rust', async () => {
    const r = fakeRelease();
    const load = await loadRustEngineAddon({ env: {}, rustDir: r.rustDir, version: VERSION, target: TARGET });
    expect(load.ok).toBe(false);
    if (!load.ok) {
      expect(load.reason).toBe('not_installed');
      expect(load.message).toContain('gbrain engine install rust');
    }
  });
});

describe('rustAddonStatus', () => {
  test('reports the pinned and installed SHA-256 from disk', async () => {
    const r = fakeRelease();
    expect(rustAddonStatus({}, r.deps)).toEqual({ target: TARGET, preview_target: true, override: false, installed: false, path: null, sha256: null, pinned_sha256: null, engine_build: null });
    await installRustAddon({}, r.deps);
    const status = rustAddonStatus({ GBRAIN_RUST_ENGINE_ADDON: '/x/y.node' }, r.deps);
    expect(status).toMatchObject({ installed: true, override: true, sha256: sha256(r.addon), pinned_sha256: sha256(r.addon), engine_build: BUILD });
    expect(rustAddonStatus({}, { ...r.deps, target: 'win32-x64' }).preview_target).toBe(false);
  });
});

describe('the post-upgrade refresh', () => {
  test('a brain that does not use Rust makes no network call and writes nothing', async () => {
    const r = fakeRelease();
    expect(await refreshRustAddonAfterUpgrade(() => false, r.deps, () => {})).toBeNull();
    expect(r.fetched).toEqual([]);
    expect(existsSync(r.rustDir)).toBe(false);
  });

  test('a Rust brain gets the addon; a failed fetch is a warning naming the install command, never a throw', async () => {
    const ok = fakeRelease();
    expect(await refreshRustAddonAfterUpgrade(() => true, ok.deps, () => {})).toBeNull();
    expect(rustAddonStatus({}, ok.deps).installed).toBe(true);

    const down = fakeRelease();
    down.deps.fetchAsset = async () => { throw new Error('offline'); };
    const lines: string[] = [];
    const warning = await refreshRustAddonAfterUpgrade(() => true, down.deps, (l) => lines.push(l));
    expect(warning).toContain('fetch_failed');
    expect(warning).toContain('gbrain engine install rust');
    expect(lines).toEqual([warning!]);

    const broken = fakeRelease();
    broken.deps.rustDir = join(broken.rustDir, '\0bad');
    expect(await refreshRustAddonAfterUpgrade(() => true, broken.deps, () => {})).toContain('gbrain engine install rust');
  });

  test('only a Rust brain counts as using Rust', () => {
    expect(configuredBrainUsesRust(null)).toBe(false);
    expect(configuredBrainUsesRust({ engine: 'pglite', database_path: join(tmp(), 'brain.pglite') } as EngineConfig)).toBe(false);
    expect(configuredBrainUsesRust({ engine: 'rust', database_path: join(tmp(), 'brain.rust') } as EngineConfig)).toBe(true);
  });
});

describe('the addon install after a swap-only upgrade', () => {
  test('runs the new binary\'s install for a Rust brain only, and never throws', () => {
    const calls: string[][] = [];
    const run = (_cmd: string, args: string[]) => { calls.push(args); return ''; };
    expect(installAddonWithInstalledBinary({}, run, () => false)).toBe(false);
    expect(calls).toEqual([]);
    expect(installAddonWithInstalledBinary({}, run, () => true)).toBe(true);
    expect(calls).toEqual([['engine', 'install', 'rust', '--json']]);
    expect(installAddonWithInstalledBinary({}, () => { throw new Error('exit 1'); }, () => true)).toBe(false);
    expect(installAddonWithInstalledBinary({}, run, () => { throw new Error('bad config'); })).toBe(false);
  });

  test('runs under its own bound, well inside the 300 s autopilot gives the whole swap', () => {
    let timeout = 0;
    installAddonWithInstalledBinary({}, (_c, _a, opts) => { timeout = opts.timeout; return ''; }, () => true);
    expect(timeout).toBe(120_000);
  });
});

describe('gbrain engine install', () => {
  function io(install?: () => Promise<any>) {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), install } };
  }

  test('needs the engine name', async () => {
    const t = io();
    expect(await runEngineInstall([], t.io)).toBe(2);
    expect(await runEngineInstall(['postgres'], t.io)).toBe(2);
  });

  test('--json prints the result, and a refusal with its code, reason and fix', async () => {
    const r = fakeRelease();
    const ok = io(() => installRustAddon({}, r.deps));
    expect(await runEngineInstall(['rust', '--json'], ok.io)).toBe(0);
    expect(JSON.parse(ok.out.join('\n'))).toMatchObject({ schema_version: 1, status: 'installed', target: TARGET });

    const none = fakeRelease({ target: 'win32-x64' });
    const refused = io(() => installRustAddon({}, none.deps));
    expect(await runEngineInstall(['rust', '--json'], refused.io)).toBe(1);
    const doc = JSON.parse(refused.out.join('\n'));
    expect(doc).toMatchObject({ status: 'refused', code: 'rust_engine_addon_missing', reason: 'unsupported_target' });
    expect(doc.suggestion).toContain('gbrain engine install rust');
  });
});

// The release addon `bun run rust:build` made, served as the release asset: after the install, the real loader opens it
// from the gbrain home with no GBRAIN_RUST_ENGINE_ADDON. The Rust engine CI job builds the addon, so it runs there.
const BUILT_TARGET = detectAddonTarget();
const BUILT = BUILT_TARGET ? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${BUILT_TARGET}.node`) : '';
const HAVE_ADDON = !!BUILT_TARGET && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT || 'no addon target'} does not exist; run bun run rust:build`);
}

test.skipIf(!HAVE_ADDON)('the real addon installed from a release loads with no GBRAIN_RUST_ENGINE_ADDON', async () => {
  const bytes = new Uint8Array(readFileSync(BUILT));
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module as unknown as NodeJS.Module, BUILT);
  const engineBuild = String(module.exports.engineBuild);
  const r = fakeRelease({ addon: bytes, target: BUILT_TARGET });
  const manifest = new TextEncoder().encode(JSON.stringify({
    gbrain_version: VERSION, engine_abi: RUST_ENGINE_ABI, engine_build: engineBuild,
    targets: { [BUILT_TARGET!]: { asset: rustAddonAssetName(BUILT_TARGET!), sha256: sha256(bytes), bytes: bytes.byteLength } },
  }));
  r.assets.clear();
  r.assets.set(RUST_ADDON_MANIFEST_ASSET, manifest).set(rustAddonAssetName(BUILT_TARGET!), bytes);
  r.attested.clear();
  r.attested.set(RUST_ADDON_MANIFEST_ASSET, sha256(manifest)).set(rustAddonAssetName(BUILT_TARGET!), sha256(bytes));
  mkdirSync(r.rustDir, { recursive: true });
  const result = await installRustAddon({}, r.deps);
  expect(result.engine_build).toBe(engineBuild);
  const load = await loadRustEngineAddon({ env: {}, rustDir: r.rustDir, version: VERSION, target: BUILT_TARGET });
  expect(load.ok).toBe(true);
  if (load.ok) expect(load.addon.engineBuild).toBe(engineBuild);
});
