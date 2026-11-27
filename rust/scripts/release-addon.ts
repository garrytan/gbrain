#!/usr/bin/env bun
/**
 * Release packaging for the Rust engine addon, run by .github/workflows/release.yml. Not needed to build or use the
 * addon locally (`bun run rust:build` does that).
 *
 *   bun rust/scripts/release-addon.ts stage --target <name> --out <dir>
 *       Loads the addon `bun run rust:build` made on this machine, checks it reports <name> and the engine_abi this
 *       gbrain loads, copies it to <dir>/gbrain-engine-rust-<name>.node and writes <that>.meta.json (target, asset,
 *       engine_abi, engine_build, sha256, bytes).
 *
 *   bun rust/scripts/release-addon.ts package --meta-dir <dir> --version <version> --out <dir> [--previous <dir>]
 *       Merges every *.meta.json under --meta-dir (searched recursively, as download-artifact lays them out) into
 *       <out>/gbrain-engine-rust.sha256.json and copies each addon next to it under its asset name. When --previous
 *       holds the manifest and addons of the previous release with the same engine_build and engine_abi, and every
 *       previous addon matches its manifest, those bytes are published again instead of the new build, so an
 *       installed addon (and the shadow evidence that names its SHA-256) stays valid across a release that leaves
 *       rust/ unchanged. The workflow checks the previous files' build attestations before it passes them here.
 *       Refuses when the targets disagree on engine_abi or engine_build, when the engine_abi is one this gbrain does not
 *       load, or when a target a release must carry is missing.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRustAddonManifest, RELEASE_ADDON_TARGETS, RUST_ADDON_MANIFEST_ASSET, RUST_ENGINE_ABI, rustAddonAssetName,
  type RustAddonManifest,
} from '../../src/core/rust-engine/addon-manifest.ts';

export interface AddonMeta {
  target: string;
  asset: string;
  engine_abi: number;
  engine_build: string;
  sha256: string;
  bytes: number;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The manifest for the addons just built. Throws on any inconsistency; a release must not publish half a set. */
export function buildManifest(metas: AddonMeta[], version: string): RustAddonManifest {
  if (metas.length === 0) throw new Error('no addon metadata was found');
  const first = metas[0]!;
  const targets: RustAddonManifest['targets'] = {};
  for (const m of metas) {
    if (m.engine_abi !== first.engine_abi) throw new Error(`${m.target} reports engine_abi ${m.engine_abi} but ${first.target} reports ${first.engine_abi}`);
    if (m.engine_build !== first.engine_build) throw new Error(`${m.target} reports engine_build ${m.engine_build} but ${first.target} reports ${first.engine_build}`);
    if (targets[m.target]) throw new Error(`two addons for ${m.target}`);
    if (m.asset !== rustAddonAssetName(m.target)) throw new Error(`${m.target}'s asset is ${m.asset}, not ${rustAddonAssetName(m.target)}`);
    targets[m.target] = { asset: m.asset, sha256: m.sha256, bytes: m.bytes };
  }
  if (first.engine_abi !== RUST_ENGINE_ABI) {
    throw new Error(`the addons report engine_abi ${first.engine_abi}; this gbrain loads engine_abi ${RUST_ENGINE_ABI} (src/core/rust-engine/addon-manifest.ts)`);
  }
  for (const target of RELEASE_ADDON_TARGETS) {
    if (!targets[target]) throw new Error(`no addon for ${target}; a release must carry ${RELEASE_ADDON_TARGETS.join(' and ')}`);
  }
  const manifest: RustAddonManifest = { gbrain_version: version, engine_abi: first.engine_abi, engine_build: first.engine_build, targets };
  if (!parseRustAddonManifest(JSON.stringify(manifest))) throw new Error('the manifest does not pass parseRustAddonManifest');
  return manifest;
}

/**
 * The previous release's manifest when its addons can be published again: same engine_build and engine_abi, the same
 * target set, and each previous addon file present in `previousDir` with the SHA-256 and size its manifest names.
 * Null otherwise (the new build is published).
 */
export function carriedForward(built: RustAddonManifest, previousDir: string | undefined): RustAddonManifest | null {
  if (!previousDir) return null;
  const manifestPath = join(previousDir, RUST_ADDON_MANIFEST_ASSET);
  if (!existsSync(manifestPath)) return null;
  const previous = parseRustAddonManifest(readFileSync(manifestPath, 'utf8'));
  if (!previous || previous.engine_build !== built.engine_build || previous.engine_abi !== built.engine_abi) return null;
  const targets = Object.keys(built.targets).sort();
  if (Object.keys(previous.targets).sort().join(',') !== targets.join(',')) return null;
  for (const target of targets) {
    const entry = previous.targets[target]!;
    const path = join(previousDir, entry.asset);
    if (entry.asset !== rustAddonAssetName(target) || !existsSync(path)) return null;
    const bytes = readFileSync(path);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) return null;
  }
  return previous;
}

function findMetaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...findMetaFiles(path));
    else if (name.endsWith('.meta.json')) out.push(path);
  }
  return out.sort();
}

function arg(args: string[], name: string, optional = false): string | undefined {
  const i = args.indexOf(name);
  const value = i >= 0 ? args[i + 1] : undefined;
  if (!value && !optional) throw new Error(`missing ${name}`);
  return value;
}

function stage(args: string[]): void {
  const target = arg(args, '--target')!;
  const out = resolve(arg(args, '--out')!);
  const rustDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const built = join(rustDir, 'target', 'addon', `gbrain_engine.${target}.node`);
  const module = { exports: {} as Record<string, unknown> };
  process.dlopen(module as unknown as NodeJS.Module, built);
  const addon = module.exports;
  if (addon.target !== target) throw new Error(`${built} reports target ${String(addon.target)}, not ${target}`);
  if (addon.engineAbi !== RUST_ENGINE_ABI) throw new Error(`${built} reports engine_abi ${String(addon.engineAbi)}; this gbrain loads ${RUST_ENGINE_ABI}`);
  if (typeof addon.engineBuild !== 'string') throw new Error(`${built} does not report engineBuild`);
  mkdirSync(out, { recursive: true });
  const asset = rustAddonAssetName(target);
  const dest = join(out, asset);
  copyFileSync(built, dest);
  const bytes = readFileSync(dest);
  const meta: AddonMeta = { target, asset, engine_abi: addon.engineAbi, engine_build: addon.engineBuild, sha256: sha256(bytes), bytes: bytes.length };
  writeFileSync(`${dest}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`staged ${asset}: ${meta.bytes} bytes, sha256 ${meta.sha256}, engine_build ${meta.engine_build}`);
}

/** Writes the manifest and the addons to publish into `out`; returns whether the previous release's bytes were reused. */
export function packageRelease(metaDir: string, version: string, out: string, previousDir?: string): { manifest: RustAddonManifest; carried: boolean } {
  const metaFiles = findMetaFiles(metaDir);
  const metas = metaFiles.map((p) => JSON.parse(readFileSync(p, 'utf8')) as AddonMeta);
  const built = buildManifest(metas, version);
  const previous = carriedForward(built, previousDir);
  mkdirSync(out, { recursive: true });
  for (const target of Object.keys(built.targets)) {
    const asset = rustAddonAssetName(target);
    const from = previous ? join(previousDir!, asset) : join(dirname(metaFiles.find((p) => p.endsWith(`${asset}.meta.json`))!), asset);
    const bytes = readFileSync(from);
    const want = (previous ?? built).targets[target]!;
    if (bytes.length !== want.bytes || sha256(bytes) !== want.sha256) throw new Error(`${from} does not match its metadata`);
    copyFileSync(from, join(out, asset));
  }
  const manifest: RustAddonManifest = previous ? { ...previous, gbrain_version: version } : built;
  writeFileSync(join(out, RUST_ADDON_MANIFEST_ASSET), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, carried: !!previous };
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'stage') stage(rest);
    else if (command === 'package') {
      const { manifest, carried } = packageRelease(resolve(arg(rest, '--meta-dir')!), arg(rest, '--version')!, resolve(arg(rest, '--out')!), arg(rest, '--previous', true));
      console.log(`${carried ? 'carried forward the previous release addons' : 'packaged the new build'} for ${Object.keys(manifest.targets).join(', ')} (engine_build ${manifest.engine_build})`);
    } else throw new Error('usage: release-addon.ts stage|package ...');
  } catch (err) {
    console.error(`release-addon: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
