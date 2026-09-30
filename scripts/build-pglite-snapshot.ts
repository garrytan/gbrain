#!/usr/bin/env bun
/** Build validated schema fixtures; legacy is the unit-test shape, default the bare CLI shape. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as fsModule from 'node:fs';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../src/core/ai/defaults.ts';
import { PGLiteEngine, computeSnapshotSchemaHash } from '../src/core/pglite-engine.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../test/helpers/legacy-embedding-config.ts';

export type SnapshotProfile = 'legacy' | 'default';

export function parseSnapshotProfile(args: string[]): SnapshotProfile {
  if (args.length === 0) return 'legacy';
  if (args.length === 2 && args[0] === '--profile' && (args[1] === 'legacy' || args[1] === 'default')) return args[1];
  throw new Error('Usage: build-pglite-snapshot.ts [--profile legacy|default]');
}

export function snapshotProfile(profile: SnapshotProfile, fixtureDir = 'test/fixtures') {
  const stem = profile === 'legacy' ? 'pglite-snapshot' : 'pglite-snapshot-default';
  return {
    shape: profile === 'legacy' ? LEGACY_EMBEDDING_CONFIG : {
      embedding_model: DEFAULT_EMBEDDING_MODEL,
      embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    },
    tar: join(fixtureDir, `${stem}.tar`),
    version: join(fixtureDir, `${stem}.version`),
    lock: join(fixtureDir, `.${stem}.lock`),
  };
}

type LockIdentity = { platform: NodeJS.Platform; hostname: string; pidNamespace: string | null };
type LockOwner = { pid: number; token: string; protocol?: number } & Partial<LockIdentity>;

export function snapshotLockIdentity(): LockIdentity {
  let pidNamespace: string | null = null;
  if (process.platform === 'linux') {
    try { pidNamespace = readlinkSync('/proc/self/ns/pid'); } catch { /* unknown, never reclaim */ }
  }
  return { platform: process.platform, hostname: hostname(), pidNamespace };
}

function readOwner(lock: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === 'string' && value.token ? value : null;
  } catch { return null; }
}

function isConfirmedDead(owner: LockOwner): boolean {
  const here = snapshotLockIdentity();
  // Older builders removed their lock on normal release. A delayed observer
  // cannot safely reclaim those records after another owner acquires the path.
  if (owner.protocol !== 1) return false;
  // Host and container share the checkout, but their PIDs need not refer to
  // the same processes. Missing/foreign identities are unknown, never dead.
  if (!here.hostname || (here.platform === 'linux' && !here.pidNamespace) ||
      owner.platform !== here.platform || owner.hostname !== here.hostname || owner.pidNamespace !== here.pidNamespace) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/** An observed owner may be stale: concurrent reapers must never move its replacement. */
export function reclaimDeadSnapshotOwner(lock: string, owner: LockOwner | null = readOwner(lock)): boolean {
  if (!owner || !isConfirmedDead(owner)) return false;
  return retireSnapshotOwner(lock, owner);
}

function retireSnapshotOwner(lock: string, owner: LockOwner): boolean {
  // Normal release and every reaper target the SAME tombstone. It remains
  // nonempty forever, so atomic directory rename cannot overwrite it. A late
  // observer cannot move a new live lock after either release or recovery.
  // No separate reaper mutex exists to become stranded by cancellation. These
  // tiny ownership records are gitignored; do not delete them while builders run.
  const tokenHash = crypto.createHash('sha256').update(owner.token).digest('hex');
  const tombstone = `${lock}.dead-${tokenHash}`;
  try {
    renameSync(lock, tombstone);
    return true;
  } catch (err) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}

async function bakeData(shape: ReturnType<typeof snapshotProfile>['shape']): Promise<Uint8Array> {
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-snapshot-hermetic-'));
  const saved = { home: process.env.GBRAIN_HOME, snapshot: process.env.GBRAIN_PGLITE_SNAPSHOT, tz: process.env.TZ };
  const engine = new PGLiteEngine();
  try {
    process.env.GBRAIN_HOME = scratch;
    process.env.TZ = 'UTC';
    delete process.env.GBRAIN_PGLITE_SNAPSHOT;
    configureGateway({ ...shape, env: {} });
    await engine.connect({});
    await engine.initSchema();
    return new Uint8Array(await (await engine.db.dumpDataDir('none')).arrayBuffer());
  } finally {
    try { await engine.disconnect(); }
    finally {
      for (const [key, value] of [['GBRAIN_HOME', saved.home], ['GBRAIN_PGLITE_SNAPSHOT', saved.snapshot], ['TZ', saved.tz]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** The byte-producing seam lets lock/publication tests run without booting WASM. */
export async function buildPgliteSnapshot(profile: SnapshotProfile, opts: {
  fixtureDir?: string;
  lockTimeoutMs?: number;
  buildData?: typeof bakeData;
  log?: (line: string) => void;
} = {}): Promise<'fresh' | 'built'> {
  const paths = snapshotProfile(profile, opts.fixtureDir);
  const log = opts.log ?? console.log;
  const hash = computeSnapshotSchemaHash(crypto, fsModule);
  if (!hash) throw new Error('Cannot read snapshot schema dependencies; run from a source checkout.');
  const version = `${hash}\ndims=${paths.shape.embedding_dimensions}\nmodel=${paths.shape.embedding_model}\n`;
  const fresh = () => {
    try { return existsSync(paths.tar) && readFileSync(paths.version, 'utf8') === version; }
    catch { return false; }
  };
  mkdirSync(opts.fixtureDir ?? 'test/fixtures', { recursive: true });
  if (fresh()) { log(`[build-pglite-snapshot] ${profile} up to date`); return 'fresh'; }

  const owner: LockOwner = { ...snapshotLockIdentity(), pid: process.pid, token: crypto.randomUUID(), protocol: 1 };
  const configuredTimeout = opts.lockTimeoutMs ?? Number(process.env.GBRAIN_SNAPSHOT_LOCK_TIMEOUT_MS ?? 120_000);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout >= 0 ? configuredTimeout : 120_000;
  const deadline = Date.now() + timeout;
  while (true) {
    try { mkdirSync(paths.lock); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (fresh()) { log(`[build-pglite-snapshot] ${profile} concurrent builder finished`); return 'fresh'; }
      reclaimDeadSnapshotOwner(paths.lock);
      if (!existsSync(paths.lock)) continue;
      if (Date.now() >= deadline) throw new Error(`Snapshot lock timeout: ${paths.lock}; refusing to build without ownership.`);
      await Bun.sleep(Math.min(50, Math.max(1, deadline - Date.now())));
      continue;
    }
    try { writeFileSync(join(paths.lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx' }); }
    catch (err) { rmSync(paths.lock, { recursive: true, force: true }); throw err; }
    break;
  }

  const tarTemp = `${paths.tar}.${owner.token}.tmp`;
  const versionTemp = `${paths.version}.${owner.token}.tmp`;
  try {
    if (fresh()) return 'fresh';
    log(`[build-pglite-snapshot] building ${profile} (${paths.shape.embedding_model}@${paths.shape.embedding_dimensions})`);
    const data = await (opts.buildData ?? bakeData)(paths.shape);
    writeFileSync(tarTemp, data, { flag: 'wx' });
    writeFileSync(versionTemp, version, { flag: 'wx' });
    if (readOwner(paths.lock)?.token !== owner.token) throw new Error('Snapshot lock ownership lost; refusing publication.');
    // Same-filesystem atomic renames; the sidecar is the last commit point.
    // A crash cannot expose a partially written tar or a fresh-looking new version.
    renameSync(tarTemp, paths.tar);
    renameSync(versionTemp, paths.version);
    log(`[build-pglite-snapshot] wrote ${paths.tar} (${data.byteLength} bytes)`);
    return 'built';
  } finally {
    rmSync(tarTemp, { force: true });
    rmSync(versionTemp, { force: true });
    if (readOwner(paths.lock)?.token === owner.token) retireSnapshotOwner(paths.lock, owner);
  }
}

if (import.meta.main) {
  try { await buildPgliteSnapshot(parseSnapshotProfile(process.argv.slice(2))); }
  catch (err) {
    console.error(`[build-pglite-snapshot] ${(err as Error).message}`);
    // PGLite can overwrite process.exitCode asynchronously; make a failed
    // build unambiguously nonzero so runners select their cold-init fallback.
    process.exit(1);
  }
}
