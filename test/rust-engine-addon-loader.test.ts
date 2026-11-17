/**
 * The Rust engine addon loader: load only a cached addon whose SHA-256 matches this release's cached manifest, or the
 * development override, and refuse before any write.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: selecting `engine: rust` loads only an addon whose SHA-256 matches the cached manifest of the running
 *    version (or the GBRAIN_RUST_ENGINE_ADDON build), checked for engine_abi, target and engine_build; a failure
 *    leaves the gbrain home as it was and says rust_engine_addon_missing or rust_engine_addon_mismatch.
 * 2. Credible regressions: skipping the digest check; loading a manifest of another version; deleting or creating
 *    files in the gbrain home on a refusal; GBRAIN_RUST_ENGINE_ADDON skipping the engine_abi or target checks too;
 *    loadRustEngineAddon swallowing an error that is not a refusal.
 * 3. Why not already covered: nothing else exercises the addon loader in src/core/rust-engine/.
 * 4. Production seam: RustAddonLoaderDeps (`dlopen`, `computeDigest`, `target`, `rustDir`, `version`, `env`); no
 *    production caller needs them to differ, tests do.
 *
 * The cache is written by the test the way a future install would. The happy-path tests load the real addon that
 * `bun run rust:build` made; without that build they skip (set GBRAIN_TEST_RUST_ADDON_REQUIRED=1 to fail instead).
 * Every refusal test runs without it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { loadRustAddon, loadRustEngineAddon, type RustAddonLoaderDeps } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { parseRustAddonManifest, RUST_ENGINE_ABI, type RustAddonManifest } from '../src/core/rust-engine/addon-manifest.ts';

const ROOT = join(import.meta.dir, '..');
const TARGET = detectAddonTarget();
const BUILT = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT || 'no addon target'} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);
const VERSION_UNDER_TEST = '9.9.9.9';

const sha256 = (bytes: Uint8Array | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Every path under `root` (files and directories), relative, sorted, with each file's SHA-256. */
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

interface Home {
  deps: RustAddonLoaderDeps;
  home: string;
  rustDir: string;
  manifest: RustAddonManifest;
  /** Where the cached addon for `manifest` goes. */
  dest: string;
  /** Writes the cached manifest (as given, or `manifest`) and, unless `addon` is null, the addon bytes. */
  install(opts?: { addon?: Buffer | null; manifest?: RustAddonManifest }): void;
}

let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

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

/** A gbrain home with nothing cached yet. The addon bytes are the real build when there is one, else placeholder bytes. */
function gbrainHome(opts: { target?: string } = {}): Home {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-rust-addon-'));
  dirs.push(home);
  const rustDir = join(home, '.gbrain', 'engines', 'rust');
  const target = opts.target ?? TARGET ?? 'linux-x64-glibc';
  const addonBytes = HAVE_ADDON ? readFileSync(BUILT) : Buffer.from('not a real addon');
  const engineBuild = HAVE_ADDON ? (loadReal().engineBuild as string) : 'a'.repeat(64);
  const manifest: RustAddonManifest = {
    gbrain_version: VERSION_UNDER_TEST,
    engine_abi: RUST_ENGINE_ABI,
    engine_build: engineBuild,
    targets: { [target]: { asset: `gbrain-engine-rust-${target}.node`, sha256: sha256(addonBytes), bytes: addonBytes.length } },
  };
  const dest = join(rustDir, engineBuild, `${target}.node`);
  const deps: RustAddonLoaderDeps = {
    env: {},
    rustDir,
    version: VERSION_UNDER_TEST,
    target,
    computeDigest: (path) => sha256(readFileSync(path)),
    dlopen: (path) => realDlopen(path),
  };
  return {
    deps, home, rustDir, manifest, dest,
    install(o = {}) {
      const m = o.manifest ?? manifest;
      mkdirSync(rustDir, { recursive: true });
      writeFileSync(join(rustDir, `manifest-${m.gbrain_version}.json`), JSON.stringify(m));
      if (o.addon === null) return;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, o.addon ?? addonBytes);
    },
  };
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

describe('the cached addon', () => {
  withAddon('an addon whose SHA-256 matches the cached manifest of this version loads, and nothing is written', async () => {
    const h = gbrainHome();
    h.install();
    const before = tree(h.home);
    const addon = await loadRustAddon(h.deps);
    expect(addon.target).toBe(TARGET!);
    expect(addon.engineAbi).toBe(RUST_ENGINE_ABI);
    expect(addon.engineBuild).toBe(h.manifest.engine_build);
    expect(tree(h.home)).toEqual(before);
  });

  test('no cache at all is rust_engine_addon_missing (not_installed), and the gbrain home gets no engines directory', async () => {
    const h = gbrainHome();
    const err = await refusal(loadRustAddon(h.deps));
    expect(err).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'not_installed' });
    expect(err.message).toContain('GBRAIN_RUST_ENGINE_ADDON');
    expect(existsSync(dirname(h.rustDir))).toBe(false);
  });

  test('a manifest with no addon file, or only a manifest of another version, is rust_engine_addon_missing (not_installed)', async () => {
    const noFile = gbrainHome();
    noFile.install({ addon: null });
    expect(await refusal(loadRustAddon(noFile.deps))).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'not_installed' });

    const otherVersion = gbrainHome();
    otherVersion.install({ manifest: { ...otherVersion.manifest, gbrain_version: '1.0.0.0' } });
    const before = tree(otherVersion.home);
    expect(await refusal(loadRustAddon(otherVersion.deps))).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'not_installed' });
    expect(tree(otherVersion.home)).toEqual(before);
  });

  test('a cached file whose SHA-256 differs from the manifest is rust_engine_addon_mismatch (digest), is never loaded, and stays as it was', async () => {
    const h = gbrainHome();
    h.install({ addon: Buffer.from('some other bytes') });
    let loaded = false;
    h.deps.dlopen = () => { loaded = true; return {}; };
    const before = tree(h.home);
    const err = await refusal(loadRustAddon(h.deps));
    expect(err).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'digest' });
    expect(err.message).toContain(h.manifest.targets[h.deps.target!]!.sha256);
    expect(loaded).toBe(false);
    expect(tree(h.home)).toEqual(before);
  });

  test('a cached file that cannot be read is rust_engine_addon_mismatch (digest) and is never loaded', async () => {
    const h = gbrainHome();
    h.install();
    let loaded = false;
    h.deps.dlopen = () => { loaded = true; return {}; };
    h.deps.computeDigest = () => { throw new Error('EACCES: permission denied'); };
    expect(await refusal(loadRustAddon(h.deps))).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'digest' });
    expect(loaded).toBe(false);
  });

  test('a cached addon that reports another engine_abi, engine_build or target is rust_engine_addon_mismatch, and the file stays', async () => {
    for (const [lie, reason] of [
      [{ engineAbi: RUST_ENGINE_ABI + 1 }, 'engine_abi'],
      [{ engineBuild: 'f'.repeat(64) }, 'engine_build'],
      [{ target: 'some-other-target' }, 'target'],
    ] as const) {
      const h = gbrainHome();
      h.install();
      h.deps.dlopen = () => Object.assign({ target: h.deps.target, engineAbi: RUST_ENGINE_ABI, engineBuild: h.manifest.engine_build }, lie);
      const before = tree(h.home);
      expect(await refusal(loadRustAddon(h.deps))).toMatchObject({ code: 'rust_engine_addon_mismatch', reason });
      expect(tree(h.home)).toEqual(before);
    }
  });

  test('a cached file that cannot be dlopened is rust_engine_addon_mismatch (load_failed)', async () => {
    const h = gbrainHome();
    h.install();
    h.deps.dlopen = () => { throw new Error('invalid ELF header'); };
    expect(await refusal(loadRustAddon(h.deps))).toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'load_failed' });
  });

  test('a platform no release publishes for is rust_engine_addon_missing (unsupported_target)', async () => {
    const h = gbrainHome();
    for (const target of ['linux-x64-musl', 'linux-arm64-glibc', 'win32-x64', null]) {
      const err = await refusal(loadRustAddon({ ...h.deps, target }));
      expect(err).toMatchObject({ code: 'rust_engine_addon_missing', reason: 'unsupported_target' });
      expect(err.message).toContain('No Rust engine addon is published for');
    }
    expect(existsSync(dirname(h.rustDir))).toBe(false);
  });
});

describe('GBRAIN_RUST_ENGINE_ADDON (development override)', () => {
  withAddon('loads that file with no digest pin and no cache', async () => {
    const h = gbrainHome();
    // A copy: its bytes match no manifest, and nothing in the cache names it.
    const mine = join(h.home, 'my-build.node');
    copyFileSync(BUILT, mine);
    const addon = await loadRustAddon({ ...h.deps, env: { GBRAIN_RUST_ENGINE_ADDON: mine } });
    expect(addon.target).toBe(TARGET!);
    expect(existsSync(h.rustDir)).toBe(false);
  });

  withAddon('still checks engine_abi and target', async () => {
    const h = gbrainHome();
    const real = loadReal();
    const env = { GBRAIN_RUST_ENGINE_ADDON: BUILT };
    expect(await refusal(loadRustAddon({ ...h.deps, env, dlopen: () => ({ ...real, engineAbi: RUST_ENGINE_ABI + 1 }) })))
      .toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'engine_abi' });
    const other = TARGET === 'darwin-arm64' ? 'linux-x64-glibc' : 'darwin-arm64';
    expect(await refusal(loadRustAddon({ ...h.deps, env, target: other })))
      .toMatchObject({ code: 'rust_engine_addon_mismatch', reason: 'target' });
  });

  test('a relative path or a file that does not exist is rust_engine_addon_missing', async () => {
    const h = gbrainHome();
    for (const path of ['relative/addon.node', join(h.home, 'nope.node')]) {
      expect(await refusal(loadRustAddon({ ...h.deps, env: { GBRAIN_RUST_ENGINE_ADDON: path } })))
        .toMatchObject({ code: 'rust_engine_addon_missing', reason: 'override_not_found' });
    }
    expect(existsSync(h.rustDir)).toBe(false);
  });
});

describe('loadRustEngineAddon (the entry point for the engine shell)', () => {
  withAddon('returns { ok: true, addon } for an addon that loads', async () => {
    const h = gbrainHome();
    const result = await loadRustEngineAddon({ ...h.deps, env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.addon.target).toBe(TARGET!);
  });

  test('returns rust_engine_addon_missing with its reason, and writes nothing', async () => {
    const h = gbrainHome();
    const result = await loadRustEngineAddon(h.deps);
    expect(result).toMatchObject({ ok: false, code: 'rust_engine_addon_missing', reason: 'not_installed' });
    expect(existsSync(dirname(h.rustDir))).toBe(false);
  });

  test('returns rust_engine_addon_mismatch with its reason', async () => {
    const h = gbrainHome();
    const dummy = join(h.home, 'dummy.node');
    writeFileSync(dummy, 'not an addon');
    const result = await loadRustEngineAddon({
      ...h.deps,
      env: { GBRAIN_RUST_ENGINE_ADDON: dummy },
      dlopen: () => { throw new Error('bad ELF'); },
    });
    expect(result).toMatchObject({ ok: false, code: 'rust_engine_addon_mismatch', reason: 'load_failed' });
  });

  test('re-throws an error that is not one of the two refusals', async () => {
    const h = gbrainHome();
    const dummy = join(h.home, 'dummy.node');
    writeFileSync(dummy, 'x');
    const boom = new TypeError('a bug, not a refusal');
    await expect(loadRustEngineAddon({
      ...h.deps,
      env: { GBRAIN_RUST_ENGINE_ADDON: dummy },
      dlopen: () => ({ get engineAbi(): number { throw boom; } }),
    })).rejects.toBe(boom);
  });
});
