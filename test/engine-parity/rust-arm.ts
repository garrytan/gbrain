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
import { listenServed } from '../../src/core/rust-engine/served/listener.ts';
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

/** A Rust engine on a new brain directory, connected; with GBRAIN_TEST_RUST_SERVED=1, a served client of one. */
export async function openRustBrain(): Promise<RustBrainDir> {
  await loadRustArmAddon();
  // The operator-env preload drops GBRAIN_ switches; the served arm sets the ones it needs from its GBRAIN_TEST_ flags,
  // before the owner opens (its election reads them).
  if (rustServedRequested()) {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    if (process.env.GBRAIN_TEST_RUST_SERVED_SERIAL_TXN === '1') process.env.GBRAIN_RUST_SERVED_SERIAL_TXN = '1';
  }
  const brain = rustServedRequested() ? newServedOwnerBrain() : newRustBrain();
  await brain.engine.connect({ engine: 'pglite', database_path: brain.dir } as never);
  if (rustServedRequested()) return serveRustBrain(brain);
  return brain;
}

/**
 * The served variant of the Rust arm (`GBRAIN_TEST_RUST_SERVED=1`, which turns multi-user Rust on for the run; add
 * `GBRAIN_TEST_RUST_SERVED_SERIAL_TXN=1` for transactions over the wire before lane L1): the brain's owner
 * runs in this process with a loopback TLS listener (rust-engine/served/listener.ts) and an owner server token, and
 * the engine each case receives is a served client of it (rust-engine/served/engine.ts) that reaches it over protocol
 * v3. The same tally pins and divergence rows apply, so a case that answers differently served fails. Fixtures that
 * write the store directly (`openStore`) use the owner; every case member call goes over the wire.
 */
export const RUST_SERVED_FLAG = 'GBRAIN_TEST_RUST_SERVED';

export function rustServedRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env[RUST_SERVED_FLAG] === '1';
}

let servedTls: { cert: Buffer; key: Buffer } | undefined;

/**
 * The arm's owner server token. The served arm must not write a token row or a config row into the brain each case
 * reads (token and config listings would then differ from PGLite), so the owner checks this one token through the
 * served/auth.ts `verify` and `ownerIds` seams, shaped as the real bearer check answers for an owner server token
 * (test/rust-served-cli.serial.test.ts and test/rust-served-wire.test.ts cover the real token path).
 */
const SERVED_ARM_TOKEN = `gbrain_served_arm_${process.pid}`;
const SERVED_ARM_OWNER = { principal: { kind: 'legacy_token', id: 'served-arm' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null };

function newServedOwnerBrain(): RustBrainDir {
  if (!addon) throw new Error('loadRustArmAddon has not run');
  const engine = openRustEngine({ addon, databasePath: mkdtempSync(join(tmpdir(), 'gbrain-rust-arm-')), servedOptions: {
    verify: {
      verify: async (_engine, token) => { if (token !== SERVED_ARM_TOKEN) throw new Error('Invalid token'); return { ...SERVED_ARM_OWNER }; },
      ownerIds: async () => new Set(['served-arm']),
    },
  } });
  return { engine, dir: engine.databasePath };
}

/** A self-signed certificate for `localhost`, made once per process with openssl (test-only, never kept). */
function servedArmTls(): { cert: Buffer; key: Buffer } {
  if (servedTls) return servedTls;
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-served-tls-'));
  try {
    const run = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stderr: 'pipe' });
    if (run.exitCode !== 0) throw new Error(`openssl could not make the served arm's test certificate: ${run.stderr.toString()}`);
    servedTls = { cert: readFileSync(join(dir, 'cert.pem')), key: readFileSync(join(dir, 'key.pem')) };
    return servedTls;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function serveRustBrain(owned: RustBrainDir): Promise<RustBrainDir> {
  const owner = owned.engine;
  const server = owner.ownerServer();
  if (!server?.attachServed) throw new Error('served arm: the Rust owner did not start with protocol v3');
  const tls = servedArmTls();
  const token = SERVED_ARM_TOKEN;
  const listener = await listenServed(server, { host: '127.0.0.1', port: 0, tls });
  const client = openRustEngine({ addon: addon!, databasePath: owned.dir, served: { url: `gbrain+tls://localhost:${listener.port}`, token, ca: tls.cert } });
  await client.connect({ engine: 'rust', database_path: owned.dir } as never);
  Object.defineProperty(client, 'openStore', { value: (member: string) => owner.openStore(member), configurable: true, writable: true });
  Object.defineProperty(client, 'servedOwner', { value: owner, configurable: true });
  const leave = client.disconnect.bind(client);
  Object.defineProperty(client, 'disconnect', {
    value: async () => { await leave(); await listener.close(); await owner.disconnect(); }, configurable: true, writable: true,
  });
  return { engine: client, dir: owned.dir };
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
