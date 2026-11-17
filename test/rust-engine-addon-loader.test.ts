/**
 * The Rust engine addon loader: fetch on first use, check before load, refuse before any write.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: selecting `engine: rust` loads only an addon whose SHA-256 and build-provenance match the release
 *    manifest of the running version; a fetched file is renamed into place only after that; a failure leaves the gbrain
 *    home and the brain as they were and says rust_engine_addon_missing or rust_engine_addon_mismatch; nobody on
 *    PGLite or Postgres loads the loader or gets an engines/ directory.
 * 2. Credible regressions: skipping the digest or attestation check; renaming before verifying; leaving the staging
 *    file or a half-written addon behind; refetching when a verified addon is cached; GBRAIN_RUST_ENGINE_ADDON
 *    skipping the engine_abi or target checks too; constructEngine importing the loader for every engine.
 * 3. Why not already covered: nothing else exercises src/core/rust-engine/ or the `rust` branch of constructEngine.
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
import { createHash } from 'node:crypto';
import { EXPECTED_BUILDER_IDS, type ParsedAttestation } from '../src/core/binary-self-update.ts';
import { loadRustAddon, type RustAddonLoaderDeps } from '../src/core/rust-engine/addon-loader.ts';
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

describe('selecting the rust engine through the real CLI', () => {
  async function runCli(args: string[], env: Record<string, string>, preload?: string) {
    const proc = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: env.GBRAIN_HOME!, GBRAIN_NO_AUTOPILOT_INSTALL: '1', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: stdout + stderr, code };
  }
  function rustHome(): { home: string; dbPath: string } {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-rust-cli-'));
    dirs.push(home);
    const dbPath = join(home, 'brain.rust');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: dbPath }));
    return { home, dbPath };
  }

  test('an addon that cannot be found refuses with rust_engine_addon_missing before the brain is created', async () => {
    const { home, dbPath } = rustHome();
    const { out, code } = await runCli(['list'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: join(home, 'missing.node') });
    expect(code).toBe(1);
    expect(out).toContain('Error [rust_engine_addon_missing]');
    expect(out).toContain('GBRAIN_RUST_ENGINE_ADDON');
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
  }, 60_000);

  withAddon('a verified addon reaches the engine shell, which refuses engine_capability_missing and writes nothing', async () => {
    const { home, dbPath } = rustHome();
    const { out, code } = await runCli(['list'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT });
    expect(code).toBe(1);
    expect(out).toContain('Error [engine_capability_missing]');
    expect(out).toContain('the raw_sql capability');
    expect(out).toContain('so nothing ran');
    expect(out).not.toContain('rust_engine_addon_');
    expect(existsSync(dbPath)).toBe(false);
  }, 60_000);

  withAddon('engine status --probe on a rust brain with a real addon reports the shell\'s capability refusal', async () => {
    const { home, dbPath } = rustHome();
    const { out, code } = await runCli(['engine', 'status', '--json', '--probe'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT });
    expect(code).toBe(1);
    const report = JSON.parse(out.slice(out.indexOf('{')));
    expect(report.probe).toMatchObject({ ok: false, note: 'engine_capability_missing', refusal: { code: 'engine_capability_missing', reason: 'raw_sql' } });
    expect(existsSync(dbPath)).toBe(false);
  }, 60_000);

  withAddon('a spread of commands on a rust brain all stop at a typed refusal and write no brain', async () => {
    const { home, dbPath } = rustHome();
    for (const args of [['get', 'x'], ['search', 'x'], ['stats'], ['sources', 'list'], ['config', 'get', 'x'], ['jobs', 'list']]) {
      const { out, code } = await runCli(args, { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT });
      expect({ args, code, refused: out.includes('Error [engine_capability_missing]') }).toEqual({ args, code: 1, refused: true });
    }
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
  }, 120_000);

  test('PGLite never loads the loader, the shell or its member table, or creates engines/, through init, put and get', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-no-rust-'));
    dirs.push(home);
    const log = join(home, 'rust-engine-loads.log');
    const preload = join(home, 'trace-loads.ts');
    writeFileSync(preload, `
      import { appendFileSync } from 'node:fs';
      Bun.plugin({ name: 'trace-rust-engine', setup(b) {
        b.onResolve({ filter: /rust-engine(\\.ts|\\/(addon-|members))/ }, (args) => { appendFileSync(${JSON.stringify(log)}, args.path + '\\n'); return undefined; });
      } });
    `);
    const env = { GBRAIN_HOME: home };
    expect((await runCli(['init', '--pglite', '--no-embedding'], env, preload)).code).toBe(0);
    const put = Bun.spawn([process.execPath, '--preload', preload, join(ROOT, 'src', 'cli.ts'), 'put', 'people/no-rust'], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: home, GBRAIN_NO_AUTOPILOT_INSTALL: '1', GBRAIN_HOME: home }, stdin: new Blob(['---\ntitle: No Rust\n---\n\nplain pglite\n']), stdout: 'pipe', stderr: 'pipe',
    });
    expect(await put.exited).toBe(0);
    const get = await runCli(['get', 'people/no-rust'], env, preload);
    expect(get.code).toBe(0);
    expect(get.out).toContain('plain pglite');
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
  }, 180_000);

  test('the trace sees the loader when the rust engine is selected (the PGLite proof above can fail)', async () => {
    const { home } = rustHome();
    const log = join(home, 'loads.log');
    const preload = join(home, 'trace-loads.ts');
    writeFileSync(preload, `
      import { appendFileSync } from 'node:fs';
      Bun.plugin({ name: 'trace-rust-engine', setup(b) {
        b.onResolve({ filter: /rust-engine(\\.ts|\\/(addon-|members))/ }, (args) => { appendFileSync(${JSON.stringify(log)}, args.path + '\\n'); return undefined; });
      } });
    `);
    await runCli(['list'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: join(home, 'missing.node') }, preload);
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toContain('addon-loader');
  }, 60_000);
});
