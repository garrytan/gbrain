/**
 * The Rust engine addon loader: fetch on first use, check before load, refuse before any write.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: selecting `engine: rust` loads only an addon whose SHA-256 and build-provenance match the release
 *    manifest of the running version; a fetched file is renamed into place only after that; a failure leaves the gbrain
 *    home and the brain as they were and says rust_engine_addon_missing or rust_engine_addon_mismatch.
 * 2. Credible regressions: skipping the digest or attestation check; renaming before verifying; leaving the staging
 *    file or a half-written addon behind; refetching when a verified addon is cached; GBRAIN_RUST_ENGINE_ADDON
 *    skipping the engine_abi or target checks too; loadRustEngineAddon swallowing an error that is not a refusal.
 *    Also: two starts sharing one gbrain home interleaving a replace and its rollback.
 * 3. Why not already covered: nothing else exercises the addon loader in src/core/rust-engine/.
 * 4. Production seam: AddonFetchDeps (the same shape binary-self-update.ts injects) plus `dlopen`, `target` and
 *    `rustDir`; no production caller needs them to differ, tests do.
 *
 * Only the network is faked: release lookup, download and attestation lookup read an in-memory "release" built from
 * the real addon that `bun run rust:build` made. Without that build the happy-path tests skip (set
 * GBRAIN_TEST_RUST_ADDON_REQUIRED=1, as rust-engine.yml does, to fail instead); the failure-path tests that never
 * reach a load still run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { EXPECTED_BUILDER_IDS, type ParsedAttestation } from '../src/core/binary-self-update.ts';
import { loadRustAddon, loadRustEngineAddon, type RustAddonLoaderDeps } from '../src/core/rust-engine/addon-loader.ts';
import { withAddonCacheLock } from '../src/core/rust-engine/addon-fetch.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import {
  parseRustAddonManifest,
  RUST_ADDON_MANIFEST_ASSET,
  RUST_ENGINE_ABI,
  type RustAddonManifest,
} from '../src/core/rust-engine/addon-manifest.ts';
import { withEnv } from './helpers/with-env.ts';

const ROOT = join(import.meta.dir, '..');
const TARGET = detectAddonTarget();
const BUILT = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT || 'no addon target'} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);
const VERSION_UNDER_TEST = '9.9.9.9';
const MANIFEST_ASSET_URL = 'fake://manifest';

const sha256 = (bytes: Uint8Array | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Every path under `root` (files and directories), relative, sorted. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      out.push(relative(root, path) + (statSync(path).isDirectory() ? '/' : ''));
      if (statSync(path).isDirectory()) walk(path);
    }
  };
  walk(root);
  return out.sort();
}

interface FakeRelease {
  deps: RustAddonLoaderDeps;
  home: string;
  rustDir: string;
  calls: { release: number; download: number; attestation: number };
  manifest: RustAddonManifest;
  /** Replace what the "network" serves for an asset. */
  serve(asset: string, bytes: Buffer): void;
  attest(fn: (digest: string) => ParsedAttestation[] | null): void;
  dropAsset(name: string): void;
  down(): void;
}

let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * A local release for VERSION_UNDER_TEST. The addon bytes are the real build when there is one (else placeholder
 * bytes, which is enough for every test that stops before a load).
 */
function fakeRelease(opts: { engineAbi?: number; target?: string; engineBuild?: string } = {}): FakeRelease {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-rust-addon-'));
  dirs.push(home);
  const rustDir = join(home, '.gbrain', 'engines', 'rust');
  const target = opts.target ?? TARGET ?? 'linux-x64-glibc';
  const addonBytes = HAVE_ADDON ? readFileSync(BUILT) : Buffer.from('not a real addon');
  const engineBuild = opts.engineBuild ?? (HAVE_ADDON ? (loadReal().engineBuild as string) : 'a'.repeat(64));
  const assetName = `gbrain-engine-rust-${target}.node`;
  const manifest: RustAddonManifest = {
    gbrain_version: VERSION_UNDER_TEST,
    engine_abi: opts.engineAbi ?? RUST_ENGINE_ABI,
    engine_build: engineBuild,
    targets: { [target]: { asset: assetName, sha256: sha256(addonBytes), bytes: addonBytes.length } },
  };
  const served = new Map<string, Buffer>([
    [assetName, addonBytes],
    [RUST_ADDON_MANIFEST_ASSET, Buffer.from(JSON.stringify(manifest))],
  ]);
  let assets = [
    { name: RUST_ADDON_MANIFEST_ASSET, url: `fake://${RUST_ADDON_MANIFEST_ASSET}` },
    { name: assetName, url: `fake://${assetName}` },
  ];
  let attestation: (digest: string) => ParsedAttestation[] | null = (digest) => {
    const name = [...served.entries()].find(([, b]) => sha256(b) === digest)?.[0];
    return name ? [{ builderId: EXPECTED_BUILDER_IDS[0]!, subjects: [{ name, sha256: digest }] }] : null;
  };
  let isDown = false;
  const calls = { release: 0, download: 0, attestation: 0 };
  const deps: RustAddonLoaderDeps = {
    env: {},
    rustDir,
    version: VERSION_UNDER_TEST,
    target,
    dlopen: (path) => realDlopen(path),
    async fetchRelease(tag) {
      calls.release++;
      expect(tag).toBe(`v${VERSION_UNDER_TEST}`);
      return isDown ? null : { tag, assets };
    },
    async download(url, dest) {
      calls.download++;
      if (isDown) throw new Error('network is down');
      const bytes = served.get(url.replace('fake://', ''));
      if (!bytes) throw new Error(`HTTP 404 for ${url}`);
      writeFileSync(dest, bytes);
    },
    computeDigest: (path) => sha256(readFileSync(path)),
    async fetchAttestation(digest) {
      calls.attestation++;
      return attestation(digest);
    },
  };
  return {
    deps, home, rustDir, calls, manifest,
    serve: (asset, bytes) => { served.set(asset, bytes); },
    attest: (fn) => { attestation = fn; },
    dropAsset: (name) => { assets = assets.filter((a) => a.name !== name); },
    down: () => { isDown = true; },
  };
}

function realDlopen(path: string): unknown {
  const module = { exports: {} as unknown };
  process.dlopen(module as NodeJS.Module, path);
  return module.exports;
}
let realAddon: Record<string, unknown> | undefined;
function loadReal(): Record<string, unknown> {
  realAddon ??= realDlopen(BUILT) as Record<string, unknown>;
  return realAddon;
}

async function refusal(run: Promise<unknown>): Promise<{ code: string; reason?: string; message: string }> {
  try {
    await run;
  } catch (err: any) {
    return { code: err.code, reason: err.reason, message: err.message };
  }
  throw new Error('expected a refusal, but the addon loaded');
}

describe('manifest parsing', () => {
  test('rejects anything that is not a complete manifest, including path-shaped names', () => {
    const good = { gbrain_version: '1.2.3.4', engine_abi: 1, engine_build: 'b'.repeat(64), targets: { 'linux-x64-glibc': { asset: 'x.node', sha256: 'c'.repeat(64), bytes: 10 } } };
    expect(parseRustAddonManifest(JSON.stringify(good))?.targets['linux-x64-glibc']?.bytes).toBe(10);
    for (const bad of [
      'not json',
      '[]',
      { ...good, engine_abi: '1' },
      { ...good, engine_build: '../escape' },
      { ...good, targets: { '../x': good.targets['linux-x64-glibc'] } },
      { ...good, targets: { 'linux-x64-glibc': { asset: 'x.node', sha256: 'XYZ', bytes: 10 } } },
      { ...good, targets: { 'linux-x64-glibc': { asset: 'x.node', sha256: 'c'.repeat(64), bytes: 0 } } },
    ]) {
      expect(parseRustAddonManifest(typeof bad === 'string' ? bad : JSON.stringify(bad))).toBeNull();
    }
  });
});

describe('fetch on first use', () => {
  withAddon('fetches into engines/rust/<engine_build>/<target>.node, checks it, loads it, and caches the manifest', async () => {
    const rel = fakeRelease();
    const addon = await loadRustAddon(rel.deps);
    expect(addon.target).toBe(TARGET!);
    expect(addon.engineAbi).toBe(RUST_ENGINE_ABI);
    const dest = join(rel.rustDir, rel.manifest.engine_build, `${TARGET}.node`);
    expect(sha256(readFileSync(dest))).toBe(rel.manifest.targets[TARGET!]!.sha256);
    // Release lookup once; the manifest and the addon each downloaded and attested once.
    expect(rel.calls).toEqual({ release: 1, download: 2, attestation: 2 });
    // Nothing left but the addon and the manifest of this version: no staging files.
    expect(tree(rel.rustDir)).toEqual([rel.manifest.engine_build + '/', `${rel.manifest.engine_build}/${TARGET}.node`, `manifest-${VERSION_UNDER_TEST}.json`].sort());
  });

  withAddon('a cached addon whose digest matches the manifest loads with zero network calls', async () => {
    const rel = fakeRelease();
    await loadRustAddon(rel.deps);
    const again = fakeRelease();
    // Same home and files, a network that must never be touched.
    const offline: RustAddonLoaderDeps = {
      ...again.deps,
      rustDir: rel.rustDir,
      fetchRelease: async () => { throw new Error('network touched'); },
      download: async () => { throw new Error('network touched'); },
      fetchAttestation: async () => { throw new Error('network touched'); },
    };
    const addon = await loadRustAddon(offline);
    expect(addon.engineBuild).toBe(rel.manifest.engine_build);
    expect(again.calls).toEqual({ release: 0, download: 0, attestation: 0 });
  });

  withAddon('a cached addon that no longer matches the manifest is fetched again and replaced', async () => {
    const rel = fakeRelease();
    await loadRustAddon(rel.deps);
    const dest = join(rel.rustDir, rel.manifest.engine_build, `${TARGET}.node`);
    // Replace, never truncate in place: the first load still has this file mapped, and truncating a mapped file kills the process.
    rmSync(dest);
    writeFileSync(dest, 'corrupted on disk');
    const before = { ...rel.calls };
    await loadRustAddon(rel.deps);
    expect(rel.calls.download).toBeGreaterThan(before.download);
    expect(sha256(readFileSync(dest))).toBe(rel.manifest.targets[TARGET!]!.sha256);
  });
});

describe('refusals', () => {
  withAddon('a digest mismatch is rust_engine_addon_mismatch; the staged file goes, the existing addon stays, nothing else is written', async () => {
    const rel = fakeRelease();
    const addonName = rel.manifest.targets[TARGET!]!.asset;
    rel.serve(addonName, Buffer.concat([readFileSync(BUILT), Buffer.from('tampered')]));
    const dir = join(rel.rustDir, rel.manifest.engine_build);
    mkdirSync(dir, { recursive: true });
    const existing = join(dir, `${TARGET}.node`);
    writeFileSync(existing, 'the addon that was already here');
    const before = tree(join(rel.home, '.gbrain'));
    const err = await refusal(loadRustAddon(rel.deps));
    expect(err).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'digest' });
    expect(readFileSync(existing, 'utf8')).toBe('the addon that was already here');
    expect(tree(join(rel.home, '.gbrain'))).toEqual(before);
    expect(readdirSync(dir)).toEqual([`${TARGET}.node`]);
  });

  test('a build-provenance attestation that does not cover the file is rust_engine_addon_mismatch', async () => {
    const rel = fakeRelease();
    rel.attest((digest) => [{ builderId: 'https://github.com/someone-else/repo/.github/workflows/release.yml@refs/heads/master', subjects: [{ name: 'gbrain-engine-rust.sha256.json', sha256: digest }] }]);
    expect(await refusal(loadRustAddon(rel.deps))).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'attestation' });
    expect(tree(join(rel.home, '.gbrain'))).toEqual([]);
  });

  withAddon('an addon with no attestation from the release workflow is refused even when the manifest is attested', async () => {
    const rel = fakeRelease();
    const manifestDigest = sha256(Buffer.from(JSON.stringify(rel.manifest)));
    rel.attest((digest) => digest === manifestDigest
      ? [{ builderId: EXPECTED_BUILDER_IDS[0]!, subjects: [{ name: RUST_ADDON_MANIFEST_ASSET, sha256: digest }] }]
      : [{ builderId: 'https://github.com/someone-else/repo/.github/workflows/release.yml@refs/heads/master', subjects: [{ name: rel.manifest.targets[TARGET!]!.asset, sha256: digest }] }]);
    expect(await refusal(loadRustAddon(rel.deps))).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'attestation' });
    expect(tree(join(rel.home, '.gbrain'))).toEqual([]);
  });

  test('no attestation available (GitHub unreachable or rate-limited) is rust_engine_addon_missing, fail closed', async () => {
    const rel = fakeRelease();
    rel.attest(() => null);
    expect(await refusal(loadRustAddon(rel.deps))).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'attestation_unavailable' });
    expect(tree(join(rel.home, '.gbrain'))).toEqual([]);
  });

  test('network down is rust_engine_addon_missing and writes nothing', async () => {
    const rel = fakeRelease();
    rel.down();
    expect(await refusal(loadRustAddon(rel.deps))).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'release_unavailable' });
    expect(tree(join(rel.home, '.gbrain'))).toEqual([]);
  });

  test('a release with no manifest is rust_engine_addon_missing', async () => {
    const rel = fakeRelease();
    rel.dropAsset(RUST_ADDON_MANIFEST_ASSET);
    expect(await refusal(loadRustAddon(rel.deps))).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'manifest_unavailable' });
    expect(tree(join(rel.home, '.gbrain'))).toEqual([]);
  });

  test('a download that fails is rust_engine_addon_missing and leaves no staging file or directory', async () => {
    const rel = fakeRelease();
    const addonName = rel.manifest.targets[TARGET ?? 'linux-x64-glibc']!.asset;
    rel.dropAsset(addonName);
    rel.deps.fetchRelease = async (tag) => ({ tag, assets: [{ name: RUST_ADDON_MANIFEST_ASSET, url: `fake://${RUST_ADDON_MANIFEST_ASSET}` }, { name: addonName, url: 'fake://does-not-exist' }] });
    expect(await refusal(loadRustAddon(rel.deps))).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'download_failed' });
    expect(tree(join(rel.home, '.gbrain'))).toEqual([]);
  });

  test('no asset for this target is rust_engine_addon_missing, naming the target', async () => {
    const rel = fakeRelease({ target: 'darwin-arm64' });
    const err = await refusal(loadRustAddon({ ...rel.deps, target: 'linux-x64-glibc' }));
    expect(err).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'unsupported_target' });
    expect(err.message).toContain('linux-x64-glibc');
    expect(tree(join(rel.home, '.gbrain'))).toEqual([]);
  });

  test('a platform no release publishes for is rust_engine_addon_missing without any network call', async () => {
    const rel = fakeRelease();
    for (const target of ['linux-x64-musl', 'linux-arm64-glibc', 'win32-x64', null]) {
      const err = await refusal(loadRustAddon({ ...rel.deps, target }));
      expect(err).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'unsupported_target' });
      expect(err.message).toContain('No Rust engine addon is published for');
    }
    expect(rel.calls).toEqual({ release: 0, download: 0, attestation: 0 });
  });

  test('a manifest whose engine_abi this gbrain does not load is rust_engine_addon_mismatch before anything is downloaded for the addon', async () => {
    const rel = fakeRelease({ engineAbi: RUST_ENGINE_ABI + 1 });
    expect(await refusal(loadRustAddon(rel.deps))).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'engine_abi' });
    expect(rel.calls.download).toBe(1); // the manifest only
    expect(tree(join(rel.home, '.gbrain'))).toEqual([]);
  });

  withAddon('a loaded addon that reports another engine_abi, engine_build or target is rust_engine_addon_mismatch and is not left in place', async () => {
    const real = loadReal();
    for (const [lie, reason] of [
      [{ engineAbi: RUST_ENGINE_ABI + 1 }, 'engine_abi'],
      [{ engineBuild: 'f'.repeat(64) }, 'engine_build'],
      [{ target: 'some-other-target' }, 'target'],
    ] as const) {
      const rel = fakeRelease();
      rel.deps.dlopen = () => ({ ...real, ...lie });
      expect(await refusal(loadRustAddon(rel.deps))).toMatchObject({ code: 'rust_engine_addon_mismatch', reason });
      // A file that verified but cannot be used must not stay where the next start would find it.
      expect(existsSync(join(rel.rustDir, rel.manifest.engine_build, `${TARGET}.node`))).toBe(false);
      expect(existsSync(join(rel.rustDir, `manifest-${VERSION_UNDER_TEST}.json`))).toBe(false);
    }
  });

  test('a file that cannot be dlopened is rust_engine_addon_mismatch (load_failed)', async () => {
    const rel = fakeRelease();
    rel.deps.dlopen = HAVE_ADDON ? () => { throw new Error('invalid ELF header'); } : rel.deps.dlopen;
    const err = await refusal(loadRustAddon(rel.deps));
    expect(err).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'load_failed' });
  });

  test('a fetched addon that fails to load puts back the addon it replaced, and leaves no staging file', async () => {
    const rel = fakeRelease();
    const target = rel.deps.target!;
    const dir = join(rel.rustDir, rel.manifest.engine_build);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${target}.node`);
    // An addon from another release that shares this engine_build (the cached manifest does not match it).
    writeFileSync(dest, 'previous addon');
    rel.deps.dlopen = () => { throw new Error('invalid ELF header'); };
    expect(await refusal(loadRustAddon(rel.deps))).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'load_failed' });
    expect(readFileSync(dest, 'utf8')).toBe('previous addon');
    expect(readdirSync(dir)).toEqual([`${target}.node`]);
    expect(existsSync(join(rel.rustDir, `manifest-${VERSION_UNDER_TEST}.json`))).toBe(false);
  });

  test('a fetched addon that loads replaces the old file and removes it', async () => {
    const rel = fakeRelease();
    const target = rel.deps.target!;
    const dir = join(rel.rustDir, rel.manifest.engine_build);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${target}.node`);
    writeFileSync(dest, 'previous addon');
    rel.deps.dlopen = () => ({ target, engineAbi: RUST_ENGINE_ABI, engineBuild: rel.manifest.engine_build, catalogVersion: 1, formatVersions: [] });
    const addon = await loadRustAddon(rel.deps);
    expect(addon.engineBuild).toBe(rel.manifest.engine_build);
    expect(readFileSync(dest, 'utf8')).not.toBe('previous addon');
    expect(readdirSync(dir)).toEqual([`${target}.node`]);
    expect(existsSync(join(rel.rustDir, `manifest-${VERSION_UNDER_TEST}.json`))).toBe(true);
  });
});

describe('one start at a time per gbrain home', () => {
  const fakeAddon = (rel: FakeRelease) => () =>
    ({ target: rel.deps.target!, engineAbi: RUST_ENGINE_ABI, engineBuild: rel.manifest.engine_build, catalogVersion: 1, formatVersions: [] });

  test('two starts that both fail to load the fetched addon leave the addon that was there', async () => {
    const rel = fakeRelease();
    const target = rel.deps.target!;
    const dir = join(rel.rustDir, rel.manifest.engine_build);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${target}.node`);
    writeFileSync(dest, 'previous addon');
    rel.deps.dlopen = () => { throw new Error('invalid ELF header'); };
    // Lets two starts pass the addon's attestation in the same tick, so without the cache lock one start's replace
    // lands between the other's replace and its rollback. A start that runs alone goes on after 200ms.
    const addonDigest = rel.manifest.targets[target]!.sha256;
    let waiting: Array<() => void> = [];
    const attestation = rel.deps.fetchAttestation;
    rel.deps.fetchAttestation = async (digest) => {
      if (digest === addonDigest) {
        await new Promise<void>((release) => {
          waiting.push(release);
          if (waiting.length === 2) {
            const both = waiting;
            waiting = [];
            for (const go of both) go();
          } else {
            setTimeout(() => {
              if (waiting.includes(release)) {
                waiting = waiting.filter((w) => w !== release);
                release();
              }
            }, 200);
          }
        });
      }
      return attestation(digest);
    };
    const [a, b] = await Promise.all([refusal(loadRustAddon(rel.deps)), refusal(loadRustAddon(rel.deps))]);
    expect(a).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'load_failed' });
    expect(b).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'load_failed' });
    expect(readFileSync(dest, 'utf8')).toBe('previous addon');
    expect(readdirSync(dir)).toEqual([`${target}.node`]);
    expect(readdirSync(dirname(rel.rustDir)).sort()).toEqual(['rust']);
  });

  test('a start waits while another holds the cache, then loads what that one fetched with no download', async () => {
    const rel = fakeRelease();
    const target = rel.deps.target!;
    rel.deps.dlopen = fakeAddon(rel);
    const bytes = HAVE_ADDON ? readFileSync(BUILT) : Buffer.from('not a real addon');
    let waiter: Promise<unknown> | undefined;
    await withAddonCacheLock(rel.rustDir, async () => {
      waiter = loadRustAddon(rel.deps);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(rel.calls).toEqual({ release: 0, download: 0, attestation: 0 });
      // What the holder installs: the addon and the manifest that names it.
      const dir = join(rel.rustDir, rel.manifest.engine_build);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${target}.node`), bytes);
      writeFileSync(join(rel.rustDir, `manifest-${VERSION_UNDER_TEST}.json`), JSON.stringify(rel.manifest));
    });
    const addon = (await waiter) as { engineBuild: string };
    expect(addon.engineBuild).toBe(rel.manifest.engine_build);
    expect(rel.calls).toEqual({ release: 0, download: 0, attestation: 0 });
  });

  test('a cache held for longer than the wait is rust_engine_addon_missing (cache_busy), with nothing fetched', async () => {
    const rel = fakeRelease();
    rel.deps.cacheLockWaitMs = 200;
    const err = await withAddonCacheLock(rel.rustDir, () => refusal(loadRustAddon(rel.deps)));
    expect(err).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'cache_busy' });
    expect(err.message).toContain(`pid ${process.pid}`);
    expect(rel.calls.download).toBe(0);
  });
});

describe('GBRAIN_RUST_ENGINE_ADDON (development override)', () => {
  withAddon('loads that file with no release lookup, download or digest pin', async () => {
    const rel = fakeRelease();
    // A copy: its bytes match no manifest, and nothing in the manifest or cache names it.
    const mine = join(rel.home, 'my-build.node');
    copyFileSync(BUILT, mine);
    const addon = await loadRustAddon({ ...rel.deps, env: { GBRAIN_RUST_ENGINE_ADDON: mine } });
    expect(addon.target).toBe(TARGET!);
    expect(rel.calls).toEqual({ release: 0, download: 0, attestation: 0 });
    expect(existsSync(rel.rustDir)).toBe(false);
  });

  withAddon('still checks engine_abi and target', async () => {
    const rel = fakeRelease();
    const real = loadReal();
    const env = { GBRAIN_RUST_ENGINE_ADDON: BUILT };
    expect(await refusal(loadRustAddon({ ...rel.deps, env, dlopen: () => ({ ...real, engineAbi: RUST_ENGINE_ABI + 1 }) })))
      .toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'engine_abi' });
    const other = TARGET === 'darwin-arm64' ? 'linux-x64-glibc' : 'darwin-arm64';
    expect(await refusal(loadRustAddon({ ...rel.deps, env, target: other })))
      .toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'target' });
  });

  test('a relative path or a file that does not exist is rust_engine_addon_missing', async () => {
    const rel = fakeRelease();
    for (const path of ['relative/addon.node', join(rel.home, 'nope.node')]) {
      expect(await refusal(loadRustAddon({ ...rel.deps, env: { GBRAIN_RUST_ENGINE_ADDON: path } })))
        .toMatchObject({ code: 'rust_engine_addon_missing', reason: 'override_not_found' });
    }
    expect(rel.calls).toEqual({ release: 0, download: 0, attestation: 0 });
  });
});


describe('loadRustEngineAddon (the entry point for the engine shell)', () => {
  withAddon('returns { ok: true, addon } for an addon that loads', async () => {
    const rel = fakeRelease();
    const result = await loadRustEngineAddon({ ...rel.deps, env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.addon.target).toBe(TARGET!);
  });

  test('returns rust_engine_addon_missing with its reason, and writes nothing', async () => {
    const rel = fakeRelease();
    const result = await loadRustEngineAddon({ ...rel.deps, env: { GBRAIN_RUST_ENGINE_ADDON: join(rel.home, 'nope.node') } });
    expect(result).toMatchObject({ ok: false, code: 'rust_engine_addon_missing', reason: 'override_not_found' });
    expect(existsSync(rel.rustDir)).toBe(false);
  });

  test('returns rust_engine_addon_mismatch with its reason', async () => {
    const rel = fakeRelease();
    const dummy = join(rel.home, 'dummy.node');
    writeFileSync(dummy, 'not an addon');
    const result = await loadRustEngineAddon({
      ...rel.deps,
      target: rel.deps.target ?? 'linux-x64-glibc',
      env: { GBRAIN_RUST_ENGINE_ADDON: dummy },
      dlopen: () => { throw new Error('bad ELF'); },
    });
    expect(result).toMatchObject({ ok: false, code: 'rust_engine_addon_mismatch', reason: 'load_failed' });
  });

  test('re-throws an error that is not one of the two refusals', async () => {
    const rel = fakeRelease();
    const dummy = join(rel.home, 'dummy.node');
    writeFileSync(dummy, 'x');
    const boom = new TypeError('a bug, not a refusal');
    await expect(loadRustEngineAddon({
      ...rel.deps,
      target: rel.deps.target ?? 'linux-x64-glibc',
      env: { GBRAIN_RUST_ENGINE_ADDON: dummy },
      dlopen: () => ({ get engineAbi(): number { throw boom; } }),
    })).rejects.toBe(boom);
  });
});
