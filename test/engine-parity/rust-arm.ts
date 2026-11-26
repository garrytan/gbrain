/**
 * The opt-in Rust arm of the parity suite.
 *
 * `GBRAIN_TEST_RUST_ARM=1` adds a Rust engine to every parity file's arms, loading the addon `bun run rust:build` wrote
 * (or the file GBRAIN_TEST_RUST_ENGINE_ADDON names). With the flag set and no addon the run fails: an arm that was asked for never skips.
 * Without the flag nothing here runs and the parity files compare PGLite (and Postgres) exactly as before.
 *
 * What the Rust arm owes each case:
 *  - A case that only calls members the store serves must return what PGLite returns, unless its row in
 *    `test/rust-expected-divergence/` names how it differs: Rust must still return a value, both answers must be equal
 *    after the row's normaliser, and the raw answers must still differ (when the case starts to match, the row must go).
 *  - A case that reaches a member or an option the Rust engine refuses must END on the typed `engine_capability_missing`
 *    refusal naming that capability. A refusal the case caught on the way to another outcome does not count.
 *  - A case with a `rustStop` pin must END on an Error with the pin's code whose message carries the pin, after calling
 *    every member in `methods`; it counts as stopped. Returning, or ending on a capability refusal, fails (harness.ts).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadRustAddon, type RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { RUST_ENGINE_MEMBERS } from '../../src/core/rust-engine/members.ts';
import { STORE_MEMBERS } from '../../src/core/rust-engine/store-members/index.ts';
import { openRustEngine, RustEngine } from '../../src/core/rust-engine.ts';
import { liftManagedHoldWhenRequested } from './rust-managed.ts';

export const RUST_ARM_FLAG = 'GBRAIN_TEST_RUST_ARM';

export function rustArmRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env[RUST_ARM_FLAG] === '1';
}

/**
 * `GBRAIN_TEST_RUST_MU_ARM` runs the Rust arm as the `rust-mu` view: the same arm (backend `rust`) with multi-user mode on,
 * by one of the two routes the store resolves at open (interface I-0.v2). It implies the Rust arm.
 *  - `env` (and `1`, an alias): the harness sets `GBRAIN_RUST_MULTIUSER=1` inside the test process before the arm opens (the
 *    operator-env preload strips GBRAIN_* variables, so the switch cannot come from the caller's environment).
 *  - `config`: the environment variable stays unset, and on every fresh Rust brain the arm opens (the first open and each
 *    reset) the harness writes the brain's own config row `engine.rust.multiuser` = `true` through the typed `setConfig`, then
 *    disconnects and reconnects so the store resolves it at open.
 * With the flag unset nothing here or in the harness changes.
 */
export const RUST_MU_ARM_FLAG = 'GBRAIN_TEST_RUST_MU_ARM';
export type RustMuRoute = 'env' | 'config';

/** The route the flag names, or null when the view is off. An unknown value is an error: an arm that was asked for never silently runs as something else. */
export function rustMuRoute(env: Record<string, string | undefined> = process.env): RustMuRoute | null {
  const value = env[RUST_MU_ARM_FLAG];
  if (value === undefined || value === '' || value === '0') return null;
  if (value === '1' || value === 'env') return 'env';
  if (value === 'config') return 'config';
  throw new Error(`${RUST_MU_ARM_FLAG}=${value} is not a route; use env (or 1) or config`);
}

export function rustMuArmRequested(env: Record<string, string | undefined> = process.env): boolean {
  return rustMuRoute(env) !== null;
}

/** The brain's own config row of the multi-user switch (`gbrain_store::MULTIUSER_CONFIG_KEY`). */
export const RUST_MULTIUSER_CONFIG_KEY = 'engine.rust.multiuser';

/** What the store of an engine resolved for multi-user mode (`RustStore.multiuser`, the open info's `multiuser`). */
export type MuResolution = 'on' | 'off' | 'unexposed' | 'client' | 'closed';

/** What the store resolved: true or false, or undefined when the build does not expose it or no store is open here. (Kept for callers that only read it; the rust-mu arm itself requires it, assertRustMultiuserResolved.) */
export function resolvedMultiuser(engine: unknown): boolean | undefined {
  const r = rustMultiuserResolution(engine);
  return r === 'on' ? true : r === 'off' ? false : undefined;
}

export function rustMultiuserResolution(engine: unknown): MuResolution {
  const e = engine as { ownerRole?: unknown; openStoreIfOpen?: (member: string) => unknown };
  if (e.ownerRole === 'client') return 'client';
  const store = e.openStoreIfOpen?.('multiuserSwitch') as { multiuser?: unknown } | null | undefined;
  if (store === null || store === undefined) return 'closed';
  if (typeof store.multiuser !== 'boolean') return 'unexposed';
  return store.multiuser ? 'on' : 'off';
}

/**
 * Assert that the Rust brain `engine` runs in multi-user mode, on the `route` the `rust-mu` view turned it on by. A pass on the
 * view must prove the brain it ran on resolved the switch, so this FAILS when the store resolved it off, and when the build does
 * not expose the resolution at all (no notice-and-pass). A client engine (it reaches a brain another engine owns) has no store of
 * its own and is accepted: the owner's brain is the one that was checked. Call it on any brain a scenario opens itself (a child
 * process brain, a reopened brain) after it connected.
 */
export function assertRustMultiuserResolved(engine: unknown, route: RustMuRoute): void {
  const how = route === 'env' ? 'the environment variable GBRAIN_RUST_MULTIUSER=1' : `the config row ${RUST_MULTIUSER_CONFIG_KEY}`;
  switch (rustMultiuserResolution(engine)) {
    case 'on': case 'client': return;
    case 'off': throw new Error(`[rust-mu-${route}] the store did not resolve multi-user mode although the arm turned it on by ${how}`);
    case 'unexposed': throw new Error(`[rust-mu-${route}] this build does not expose the resolved multi-user switch (RustStore.multiuser), so a rust-mu pass would prove nothing; ${how} was set`);
    case 'closed': throw new Error(`[rust-mu-${route}] no open store to read the multi-user switch from; assert it after connect`);
  }
}

/**
 * Assert that the Rust brain `engine` keeps a commit log on the `rust-mu` view, which turns the sub-switch on
 * (GBRAIN_RUST_COMMIT_LOG=1) for the arm's lifetime: the open store must report `commitLog` and the engine must report the
 * capability `commit_log`. A row that needs the log (C22) would otherwise be refused `engine_capability_missing` at its first
 * member, or worse, pass on a brain that kept none. A client engine has no store of its own and is accepted (the owner was checked).
 */
export function assertRustCommitLogResolved(engine: unknown): void {
  const e = engine as { ownerRole?: unknown; capabilities?: ReadonlySet<string>; openStoreIfOpen?: (member: string) => unknown };
  if (e.ownerRole === 'client') return;
  const store = e.openStoreIfOpen?.('commitLogSwitch') as { commitLog?: unknown } | null | undefined;
  if (store === null || store === undefined) throw new Error('[rust-mu] no open store to read the commit log switch from; assert it after connect');
  if (store.commitLog !== true) throw new Error('[rust-mu] the store keeps no commit log although the arm set GBRAIN_RUST_COMMIT_LOG=1 (the sub-switch is read only while the store is multi-user)');
  if (e.capabilities?.has('commit_log') !== true) throw new Error('[rust-mu] the engine does not report the capability commit_log although its store keeps a commit log');
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
  // GBRAIN_TEST_RUST_MANAGED=1 lifts the managed_persistence hold on this engine only (rust-managed.ts).
  const engine = liftManagedHoldWhenRequested(openRustEngine({ addon, databasePath: mkdtempSync(join(tmpdir(), 'gbrain-rust-arm-')) }));
  return { engine, dir: engine.databasePath };
}

/** The parts of an engine the multi-user connect needs (a Rust engine, or a fake in a test). */
export interface MuConnectable {
  connect(config: never): Promise<void>;
  disconnect(): Promise<void>;
  setConfig(key: string, value: string): Promise<void>;
}

/**
 * Make `engine.connect` bring the engine up in multi-user mode by `route`, and prove it did. The `env` route needs nothing
 * before connect (the variable is set in the process). The `config` route seeds the brain's own config row first (connect,
 * setConfig through the typed member, disconnect), then connects again so the store resolves it at open. After the connect
 * the resolution is asserted; when it fails the engine is disconnected and `removeDir` removes the brain's directory before the
 * error reaches the caller, who has no other handle to clean up with. Every connect of the engine goes through this, so a spare
 * the scenario connects itself (`unconnectedEngine()`) is seeded and checked like the arm's own brain.
 */
export function installMuConnect(engine: MuConnectable, route: RustMuRoute, removeDir: () => void): void {
  const connect = engine.connect.bind(engine);
  engine.connect = async (config: never): Promise<void> => {
    try {
      await connect(config);
      if (route === 'config') {
        await engine.setConfig(RUST_MULTIUSER_CONFIG_KEY, 'true');
        await engine.disconnect();
        await connect(config);
      }
      assertRustMultiuserResolved(engine, route);
      assertRustCommitLogResolved(engine);
    } catch (error) {
      await engine.disconnect().catch(() => undefined);
      removeDir();
      throw error;
    }
  };
}

/**
 * A Rust engine on a new brain directory, connected. With a `route` (the `rust-mu` view) it runs in multi-user mode by that
 * route and the resolution is required (installMuConnect): a brain that did not resolve it is disconnected and removed before
 * the error is thrown.
 */
export async function openRustBrain(route?: RustMuRoute): Promise<RustBrainDir> {
  await loadRustArmAddon();
  const brain = newRustBrain();
  if (route !== undefined) installMuConnect(brain.engine as unknown as MuConnectable, route, () => removeBrainDir(brain.dir));
  await brain.engine.connect({ engine: 'pglite', database_path: brain.dir } as never);
  return brain;
}

/**
 * A second connected Rust engine on an existing brain directory. While the directory's first engine is open, connect
 * elects the first as the owner and this one becomes its client over the owner socket (test/rust-engine-store.test.ts,
 * "a second engine on an open brain directory becomes a client of the first"). The caller disconnects it and never removes
 * the directory.
 */
export async function openRustBrainAt(dir: string, route?: RustMuRoute): Promise<RustEngine> {
  const loaded = await loadRustArmAddon();
  const engine = openRustEngine({ addon: loaded, databasePath: dir });
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  if (route !== undefined) {
    // The brain was seeded by the arm that created it; a client reaches that owner, an owner resolves it from the brain itself.
    try { assertRustMultiuserResolved(engine, route); assertRustCommitLogResolved(engine); } catch (error) { await engine.disconnect().catch(() => undefined); throw error; }
  }
  return engine;
}

export function removeBrainDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Fixture: register a source on the Rust brain (BrainEngine has no typed "create source"). */
export async function createRustSource(engine: unknown, id: string, config: Record<string, unknown>, localPath?: string, lastSyncAt?: string): Promise<void> {
  await (engine as RustEngine).openStore('createSource').brain.upsertSource({ id, name: id, config, local_path: localPath ?? null, ...(lastSyncAt ? { last_sync_at: lastSyncAt } : {}) });
}

/** Fixture: archive a source on the Rust brain (BrainEngine has no typed "archive source"). */
export async function archiveRustSource(engine: unknown, id: string): Promise<void> {
  await (engine as RustEngine).openStore('archiveSource').brain.setSourceArchived(id, true);
}

/** Fixture: put a whole op checkpoint row on the Rust brain (the identity-downgrade recorder writes it through executeRaw). */
export async function putRustOpCheckpointRow(engine: unknown, op: string, fingerprint: string, completedKeys: unknown[]): Promise<void> {
  await (engine as RustEngine).openStore('putOpCheckpointRow').brain.putOpCheckpointRow(op, fingerprint, completedKeys);
}

/** Fixture: a page's `deleted_at` as the Rust store keeps it (ISO with microseconds; the engine member hands back a Date). */
export async function rustPageDeletedAt(engine: unknown, sourceId: string, slug: string): Promise<string | null> {
  const row = await (engine as RustEngine).openStore('readPageOrigin').brain.readPageOrigin({ sourceId, slug }) as { deleted_at: string | null } | null;
  return row?.deleted_at ?? null;
}

/** Fixture: the Rust brain's access-rule store (the policy writes have no typed BrainEngine member). */
export function rustAccessBrain(engine: unknown) {
  return (engine as RustEngine).openStore('accessRules').brain;
}

/** Fixture: record a page purge on the Rust brain (the store's `page_purges` ledger has no typed BrainEngine writer). */
export async function recordRustPagePurge(engine: unknown, sourceId: string, hashes: string[], slug: string, requestId: string | null): Promise<void> {
  await (engine as RustEngine).openStore('recordPagePurge').brain.recordPagePurge(sourceId, hashes, slug, requestId);
}

/** A member the fixture seeds: an id, an optional email, a kind and groups, enabled unless `state` says otherwise. */
export interface MemberSeed { id: string; email?: string; kind?: 'person' | 'audience'; groups?: readonly string[]; state?: 'disabled' | 'removed' }

/** Fixture: seed an access member on the Rust brain through the store's typed member writes (BrainEngine has no typed member write here). */
export async function createRustMember(engine: unknown, seed: MemberSeed): Promise<void> {
  const brain = (engine as RustEngine).openStore('createMember').brain;
  await brain.insertAccessMember({ id: seed.id, displayName: null, email: seed.email ?? null, kind: seed.kind ?? 'person', groups: [...(seed.groups ?? [])] });
  if (seed.state === 'disabled') await brain.setAccessMemberDisabled(seed.id, true);
  if (seed.state === 'removed') await brain.tombstoneAccessMember(seed.id);
}

export interface DivergenceRow { file: string; name: string; normalizer: string; reason: string }

/**
 * What a divergence row may set aside, by name. The Rust arm accepts a differing answer only when both sides are equal
 * after the row's normaliser, so a row states exactly how the engines differ and nothing else.
 */
export const DIVERGENCE_NORMALIZERS: Record<string, (value: unknown) => unknown> = {
  // Keyword ranking is BM25 (design D5): scores differ and ties order differently. Set aside the score and the order
  // of the rows; the same pages must still be found.
  'ranking-order-and-score': (value) => {
    if (Array.isArray(value)) {
      const items = value.map((item) => DIVERGENCE_NORMALIZERS['ranking-order-and-score']!(item));
      return items.every((item) => item !== null && typeof item === 'object' && 'slug' in (item as object))
        ? [...items].sort((a, b) => String((a as { slug: unknown }).slug).localeCompare(String((b as { slug: unknown }).slug)))
        : items;
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'score').map(([key, item]) => [key, DIVERGENCE_NORMALIZERS['ranking-order-and-score']!(item)]));
    }
    return value;
  },
};

const DIVERGENCE_DIR = join(import.meta.dir, '..', 'rust-expected-divergence');

/**
 * The rows of every `test/rust-expected-divergence/<family>.tsv` (one file per family, so families never edit the same
 * file): `file<TAB>case name<TAB>normaliser<TAB>reason`; `#` starts a comment.
 */
export function readDivergences(dir = DIVERGENCE_DIR): DivergenceRow[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tsv')).sort().flatMap((name) => {
    const path = join(dir, name);
    return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')).map((line) => {
      const [file, caseName, normalizer, reason] = line.split('\t');
      if (!file || !caseName || !normalizer || !reason) throw new Error(`${path}: a row needs file, case name, normaliser and reason, tab separated: ${line}`);
      return { file, name: caseName, normalizer, reason };
    });
  });
}
