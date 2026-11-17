/**
 * The opt-in Rust arm of the parity suite.
 *
 * `GBRAIN_TEST_RUST_ARM=1` adds a Rust engine to every parity file's arms, loading the addon `bun run rust:build` wrote
 * (or the file GBRAIN_TEST_RUST_ENGINE_ADDON names). With the flag set and no addon the run fails: an arm that was asked for never skips.
 * Without the flag nothing here runs and the parity files compare PGLite (and Postgres) exactly as before.
 *
 * What the Rust arm owes each case:
 *  - A case that only calls members the store serves must return what PGLite returns, unless its row in
 *    `test/rust-expected-divergence.tsv` says why it cannot (an expected failure: when the case starts to match, the
 *    row must go).
 *  - A case that calls a member the Rust engine still refuses must stop on the typed `engine_capability_missing`
 *    refusal naming that member's capability, having run nothing past it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadRustAddon, type RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { RUST_ENGINE_MEMBERS } from '../../src/core/rust-engine/members.ts';
import { STORE_MEMBERS } from '../../src/core/rust-engine/store-members/index.ts';
import { openRustEngine, RustEngine } from '../../src/core/rust-engine.ts';

export const RUST_ARM_FLAG = 'GBRAIN_TEST_RUST_ARM';

export function rustArmRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env[RUST_ARM_FLAG] === '1';
}

/** The capability a member needs (its row in the member table), or null for a lifecycle member or an unknown name. */
export function rustMemberCapability(method: string): string | null {
  const cls = (RUST_ENGINE_MEMBERS as Record<string, string>)[method];
  return cls === undefined || cls === 'implemented' ? null : cls;
}

/** The capability the Rust engine refuses `method` with, or null when it serves it (the store, or the lifecycle). */
export function rustRefusal(method: string): string | null {
  return Object.hasOwn(STORE_MEMBERS, method) ? null : rustMemberCapability(method);
}

let addon: RustAddon | undefined;

/**
 * The addon file for the arm. bunfig.toml's operator-env preload strips GBRAIN_RUST_ENGINE_ADDON from a test run, so the
 * arm reads GBRAIN_TEST_RUST_ENGINE_ADDON, or else the file `bun run rust:build` writes under rust/target/addon.
 */
export function rustArmAddonPath(env: Record<string, string | undefined> = process.env): string {
  if (env.GBRAIN_TEST_RUST_ENGINE_ADDON) return env.GBRAIN_TEST_RUST_ENGINE_ADDON;
  const target = detectAddonTarget();
  return join(import.meta.dir, '..', '..', 'rust', 'target', 'addon', `gbrain_engine.${target ?? 'unsupported'}.node`);
}

/** Loads the arm's addon, once; a missing addon fails the run (an arm that was asked for never skips). */
export async function loadRustArmAddon(): Promise<RustAddon> {
  const path = rustArmAddonPath();
  if (!existsSync(path)) throw new Error(`${RUST_ARM_FLAG}=1 needs the Rust addon, and ${path} does not exist; run bun run rust:build`);
  return (addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: path } }));
}

export interface RustBrainDir { engine: RustEngine; dir: string }

/** A Rust engine on a new brain directory, not connected. `loadRustArmAddon` has run. */
export function newRustBrain(): RustBrainDir {
  if (!addon) throw new Error('loadRustArmAddon has not run');
  const engine = openRustEngine({ addon, databasePath: mkdtempSync(join(tmpdir(), 'gbrain-rust-arm-')) });
  return { engine, dir: engine.databasePath };
}

/** A Rust engine on a new brain directory, connected. */
export async function openRustBrain(): Promise<RustBrainDir> {
  await loadRustArmAddon();
  const brain = newRustBrain();
  await brain.engine.connect({ engine: 'pglite', database_path: brain.dir } as never);
  return brain;
}

export function removeBrainDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Fixture: register a source on the Rust brain (BrainEngine has no typed "create source"). */
export async function createRustSource(engine: unknown, id: string, config: Record<string, unknown>): Promise<void> {
  await (engine as RustEngine).openStore('createSource').brain.upsertSource({ id, name: id, config });
}

export interface DivergenceRow { file: string; name: string; reason: string }

const DIVERGENCE_FILE = join(import.meta.dir, '..', 'rust-expected-divergence.tsv');

/** The rows of test/rust-expected-divergence.tsv: `file<TAB>case name<TAB>reason`; `#` starts a comment. */
export function readDivergences(path = DIVERGENCE_FILE): DivergenceRow[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')).map((line) => {
    const [file, name, reason] = line.split('\t');
    if (!file || !name || !reason) throw new Error(`${path}: a row needs file, case name and reason, tab separated: ${line}`);
    return { file, name, reason };
  });
}

/**
 * The engine a Rust-arm case runs on. The store keeps no chunk vectors, so `upsertChunks` and `sealChunks` refuse a chunk that
 * carries one. A case that declares `searchKeyword` reads text only, so its fixtures lose the vectors they seed (a keyword
 * search never reads them); every other case is untouched, and one that seeds a vector still stops on the refusal.
 */
export function rustFixtureEngine<E extends object>(engine: E, methods: readonly string[]): E {
  if (!methods.includes('searchKeyword')) return engine;
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop !== 'upsertChunks' && prop !== 'sealChunks') || typeof value !== 'function') return value;
      return (slug: string, chunks: Array<Record<string, unknown>>, ...rest: unknown[]) =>
        (value as (...a: unknown[]) => unknown).call(target, slug,
          chunks.map(({ embedding: _e, embedding_image: _i, ...text }) => text), ...rest);
    },
  });
}
