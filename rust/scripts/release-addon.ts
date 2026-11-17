#!/usr/bin/env bun
/**
 * Release packaging for the Rust engine addon. Used by .github/workflows/rust-engine.yml when it is
 * called from release.yml (for_release); not needed to build or use the addon.
 *
 *   bun rust/scripts/release-addon.ts stage --target <name> --asset <file name> --out <dir>
 *       Loads the addon `bun run rust:build` made for this machine, checks it reports <name>, copies it to
 *       <dir>/<asset> and writes <dir>/<asset>.meta.json (target, asset, engine_abi, engine_build, sha256, bytes).
 *
 *   bun rust/scripts/release-addon.ts manifest --meta-dir <dir> --version <version> --out <file>
 *       Merges every *.meta.json under <dir> (searched recursively, as download-artifact lays them out) into
 *       gbrain-engine-rust.sha256.json. Refuses when the targets disagree on engine_abi or engine_build, when the
 *       engine_abi is one this gbrain does not load, or when a target a release must carry is missing.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_ADDON_TARGETS, RUST_ENGINE_ABI, type RustAddonManifest } from '../../src/core/rust-engine/addon-manifest.ts';

export interface AddonMeta {
  target: string;
  asset: string;
  engine_abi: number;
  engine_build: string;
  sha256: string;
  bytes: number;
}

export function buildManifest(metas: AddonMeta[], version: string): RustAddonManifest {
  if (metas.length === 0) throw new Error('no addon metadata was found');
  const [first] = metas;
  const targets: RustAddonManifest['targets'] = {};
  for (const m of metas) {
    if (m.engine_abi !== first!.engine_abi) throw new Error(`${m.target} reports engine_abi ${m.engine_abi} but ${first!.target} reports ${first!.engine_abi}`);
    if (m.engine_build !== first!.engine_build) throw new Error(`${m.target} reports engine_build ${m.engine_build} but ${first!.target} reports ${first!.engine_build}`);
    if (targets[m.target]) throw new Error(`two addons for ${m.target}`);
    targets[m.target] = { asset: m.asset, sha256: m.sha256, bytes: m.bytes };
  }
  if (first!.engine_abi !== RUST_ENGINE_ABI) {
    throw new Error(`the addons report engine_abi ${first!.engine_abi}; this gbrain loads engine_abi ${RUST_ENGINE_ABI} (src/core/rust-engine/addon-manifest.ts)`);
  }
  for (const target of RELEASE_ADDON_TARGETS) {
    if (!targets[target]) throw new Error(`no addon for ${target}; a release must carry ${RELEASE_ADDON_TARGETS.join(' and ')}`);
  }
  return { gbrain_version: version, engine_abi: first!.engine_abi, engine_build: first!.engine_build, targets };
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

function arg(args: string[], name: string): string {
  const i = args.indexOf(name);
  const value = i >= 0 ? args[i + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function stage(args: string[]): void {
  const target = arg(args, '--target');
  const asset = arg(args, '--asset');
  const out = resolve(arg(args, '--out'));
  const rustDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const built = join(rustDir, 'target', 'addon', `gbrain_engine.${target}.node`);
  const module = { exports: {} as any };
  process.dlopen(module as NodeJS.Module, built);
  const addon = module.exports;
  if (addon.target !== target) throw new Error(`${built} reports target ${addon.target}, not ${target}`);
  if (typeof addon.engineBuild !== 'string' || !Number.isInteger(addon.engineAbi)) throw new Error(`${built} does not report engineAbi and engineBuild`);
  mkdirSync(out, { recursive: true });
  const dest = join(out, asset);
  copyFileSync(built, dest);
  const bytes = readFileSync(dest);
  const meta: AddonMeta = {
    target,
    asset,
    engine_abi: addon.engineAbi,
    engine_build: addon.engineBuild,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
  writeFileSync(`${dest}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`staged ${asset}: ${meta.bytes} bytes, sha256 ${meta.sha256}, engine_build ${meta.engine_build}`);
}

function manifest(args: string[]): void {
  const metaDir = resolve(arg(args, '--meta-dir'));
  const metas = findMetaFiles(metaDir).map((p) => JSON.parse(readFileSync(p, 'utf8')) as AddonMeta);
  const result = buildManifest(metas, arg(args, '--version'));
  writeFileSync(resolve(arg(args, '--out')), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`wrote the manifest for ${Object.keys(result.targets).join(', ')}`);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'stage') stage(rest);
    else if (command === 'manifest') manifest(rest);
    else throw new Error('usage: release-addon.ts stage|manifest ...');
  } catch (err) {
    console.error(`release-addon: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
