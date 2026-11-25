/**
 * The nightly shadow replay (docs/guides/shadow-replay.md), parent side: one call does, in order,
 *   1. take the replay lock and invalidate the current epoch when the purge log changed;
 *   2. seal the current epoch (when its copies were seeded) and start the next one while capture is on;
 *   3. replay the sealed epoch in the isolated child, killing it when the purge log changes or the budget runs out;
 *   4. delete the sealed epoch's recording and copies (the report stays);
 *   5. seed the new epoch's copies from one snapshot of the brain (Rust store, PGLite, optional local Postgres).
 * The first night only seeds. Nothing here writes to the brain.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { configDir } from '../core/config.ts';
import {
  basesDir, deleteAllCaptureData, deleteEpochData, epochDir, invalidateIfPurged, purgeLogChanged, readEpoch, scheduleScratchDrop, scratchCleared, scratchRecordPath,
  readScratchRecord, resumeInvalidatedCleanup, setEpochState, startEpoch, type EpochPointer,
} from './capture.ts';
import { captureDir, captureIsOn, writePrivateJson } from './capture-state.ts';
import { FanOutSeedTarget, markScratchPostgres, REPLAY_POSTGRES_ENV, resetScratchPostgres, SqlSeedTarget, checkLocalPostgresUrl, type ArmImport } from './replay-copy.ts';
import { ReplayError } from './replay-errors.ts';
import { childEnv, hmacKey, prepareRun, removeRun, type ReplayReport, type RunSpec } from './replay.ts';
import { runSeed, type SeedRecord, type SeedTarget } from './seed.ts';
import { readStoredEmbeddingIdentity } from '../core/stored-embedding-identity.ts';

export interface BaseManifest {
  version: 1;
  epoch: string;
  cut: { before: number; after: number | null };
  seed: SeedRecord;
  arms: Record<string, ArmImport>;
  postgres: boolean;
}

export interface NightlyDeps {
  shadowDir: string;
  brainKey: string;
  primaryEngine: 'pglite' | 'postgres';
  primaryUrl?: string | null;
  env: Record<string, string | undefined>;
  home?: string;
  openPrimary(): Promise<BrainEngine>;
  loadAddon(): Promise<RustEngineAddonLoad>;
  rustDir?: string;
  openStore(addon: object, path: string): Promise<SeedTarget & { close(): Promise<void> }>;
  /** A connected SQL brain, schema not yet created: PGLite at a path, or Postgres at a URL. */
  openSql(kind: 'pglite' | 'postgres', where: string): Promise<BrainEngine>;
  /** Runs the child on `runDir` with `env`; resolves its exit code. `kill` stops it. */
  spawnChild(runDir: string, env: Record<string, string>): { exited: Promise<number>; kill(): void };
  now?: () => Date;
}

export interface NightlyResult {
  schema_version: 1;
  status: 'replayed' | 'seeded_only' | 'purged' | 'off';
  replayed_epoch?: string;
  started_epoch?: string;
  coverage?: ReplayReport['coverage'];
  by_class?: ReplayReport['by_class'];
  report?: string;
  summary?: string;
}

/**
 * The replay lock: created exclusively (O_EXCL), so two runs starting together cannot both enter. A lock older than
 * the budget plus 30 minutes is stale and is replaced once. Unlock removes the lock only while it still holds this
 * run's token.
 */
export function acquireReplayLock(dir: string, budgetMs: number): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'lock');
  // The holder writes its own deadline: a contender with a shorter budget cannot cut a longer run short.
  const token = `${process.pid} ${Date.now() + budgetMs + 30 * 60_000} ${randomBytes(6).toString('hex')}\n`;
  const unlock = () => { if (lockHolder(path) === token) rmSync(path, { force: true }); };
  if (createLock(path, token)) return unlock;
  // A lock is never reclaimed automatically: two contenders could both judge it stale and both enter. A lock whose
  // holder is gone stays until an operator removes it (the error names the file).
  const [pid, deadline] = (lockHolder(path) ?? '').split(' ').map(Number);
  const stale = Date.now() >= (deadline ?? 0) && !processAlive(pid);
  throw new ReplayError('shadow_replay_busy', stale ? `stale lock ${path}: no replay holds it; remove it, then rerun` : `lock ${path}`);
}

/** Creates the lock file exclusively; false when it already exists. */
function createLock(path: string, token: string): boolean {
  // The token is written to a private file first and linked into place, so the lock is never seen empty.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, token); } finally { closeSync(fd); }
  try { linkSync(tmp, path); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally { rmSync(tmp, { force: true }); }
}

/** True while a process with this id runs on this machine. */
function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The lock file's content, or null when there is none. */
function lockHolder(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

async function seedEpoch(deps: NightlyDeps, cap: string, epoch: EpochPointer): Promise<BaseManifest> {
  const load = await deps.loadAddon();
  if (!load.ok) throw new ReplayError('shadow_replay_addon_unavailable', `${load.code} (${load.reason})`);
  const base = basesDir(cap, epoch.id);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const pgUrl = deps.env[REPLAY_POSTGRES_ENV];
  if (pgUrl) checkLocalPostgresUrl(pgUrl, deps.primaryUrl);
  // A scratch copy recorded at another URL is dropped before a new one is made, so no copy is ever forgotten.
  const previous = readScratchRecord(cap);
  if (previous && previous.url !== pgUrl && !await scheduleScratchDrop(cap)) {
    throw new ReplayError('shadow_replay_purged', 'the previous scratch Postgres copy could not be dropped yet');
  }
  // Scratch engines would follow GBRAIN_DIRECT_DATABASE_URL for schema work: with it set, that could be the brain.
  if (pgUrl && deps.env.GBRAIN_DIRECT_DATABASE_URL) {
    throw new ReplayError('shadow_replay_postgres_not_local', 'GBRAIN_DIRECT_DATABASE_URL is set in this environment, and scratch schema work would follow it; unset it for the replay run');
  }
  const store = await deps.openStore(load.addon, join(base, 'rust'));
  const sql: Record<string, SqlSeedTarget> = {};
  const opened: BrainEngine[] = [];
  let primary: BrainEngine | null = null;
  try {
    const plan = await store.seedPlan();
    primary = await deps.openPrimary();
    // Copies get the brain's own embedding layout (dimensions, model), not this process's defaults.
    const identity = await readStoredEmbeddingIdentity(primary);
    const init = identity?.model ? { embedding: { dimensions: identity.dimensions, model: identity.model } } : {};
    const initCopy = (e: BrainEngine) => (e.initSchema as (o?: object) => Promise<void>).call(e, init);
    const pglite = await deps.openSql('pglite', join(base, 'pglite'));
    opened.push(pglite);
    await initCopy(pglite);
    sql.pglite = new SqlSeedTarget(pglite, plan);
    if (pgUrl) {
      const pg = await deps.openSql('postgres', pgUrl);
      opened.push(pg);
      await resetScratchPostgres(pg, deps.brainKey);
      // The owner marker goes in before any other table, and the record right after it, so a purge from any process
      // can drop this copy (cleanup trusts only a live marker naming this brain).
      await markScratchPostgres(pg, deps.brainKey);
      writePrivateJson(scratchRecordPath(cap), { url: pgUrl, brain: deps.brainKey, verified: true });
      await initCopy(pg);
      sql.postgres = new SqlSeedTarget(pg, plan);
    }
    const fan = new FanOutSeedTarget(store, sql);
    const seed = await runSeed(primary, fan, { primaryEngine: deps.primaryEngine, now: deps.now });
    for (const t of Object.values(sql)) await t.finish(primary);
    const current = readEpoch(cap);
    if (current?.id !== epoch.id || current.state !== 'recording') throw new ReplayError('shadow_replay_purged', 'the epoch was invalidated while it was seeded');
    writePrivateJson(join(base, 'seeded-ids.json'), [...fan.seededIds].sort());
    const manifest: BaseManifest = { version: 1, epoch: epoch.id, cut: fan.cut, seed, arms: fan.arms, postgres: !!pgUrl };
    writePrivateJson(join(base, 'manifest.json'), manifest);
    return manifest;
  } finally {
    await primary?.disconnect().catch(() => undefined);
    for (const e of opened) await e.disconnect().catch(() => undefined);
    await store.close().catch(() => undefined); // silent-read-ok: closing the seed's Rust store after the seed finished or failed; the seed's own outcome is what counts
  }
}

function seedLosses(m: BaseManifest): boolean {
  const r = m.arms.rust;
  return m.seed.unseeded_gap_rows_total > 0 || m.seed.segmented_pages > 0 || !!r && (r.dropped > 0 || r.skipped > 0
    || r.unmapped_columns.length > 0 || Object.values(r.losses).some(n => n > 0));
}

async function replayEpoch(deps: NightlyDeps, cap: string, sealed: EpochPointer, budgetMs: number, retry = false, aliveAtSeal = 0): Promise<{ report: ReplayReport; dir: string }> {
  const manifest = JSON.parse(readFileSync(join(basesDir(cap, sealed.id), 'manifest.json'), 'utf8')) as BaseManifest;
  // The Postgres copy is one database, replayed in place and reseeded for the next epoch: a retry cannot start from
  // this epoch's snapshot there, so a retry runs on PGLite and Rust only.
  if (retry) manifest.postgres = false;
  const runDir = join(deps.shadowDir, 'replay', `run-${(deps.now?.() ?? new Date()).toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${sealed.id.slice(-8)}`);
  const paths = prepareRun(runDir, epochDir(cap, sealed.id), basesDir(cap, sealed.id));
  let scratchUrl: string | null = null;
  if (manifest.postgres) {
    // The Postgres arm is the copy the seed verified, never whatever the variable names tonight.
    const rec = readScratchRecord(cap);
    if (!rec?.verified) throw new ReplayError('shadow_replay_purged', 'the seeded scratch Postgres copy is gone');
    checkLocalPostgresUrl(rec.url, deps.primaryUrl);
    scratchUrl = rec.url;
  }
  const spec: RunSpec = {
    version: 1, epoch: sealed.id, brain_key: deps.brainKey, hmac_key: hmacKey(cap), seeded_ids: paths.seededIds,
    arms: { pglite: paths.pglite, rust: paths.rust, ...(manifest.postgres ? { postgres: { url_env: REPLAY_POSTGRES_ENV } } : {}) },
    ...(deps.rustDir ? { rust_dir: deps.rustDir } : {}),
    cut: manifest.cut, seed_losses_present: seedLosses(manifest), segments: paths.segments, ...(aliveAtSeal ? { tail_unverified: aliveAtSeal } : {}),
  };
  writePrivateJson(join(runDir, 'run.json'), spec);
  const child = deps.spawnChild(runDir, childEnv(deps.env, paths.home, scratchUrl ? { name: REPLAY_POSTGRES_ENV, url: scratchUrl } : null));
  let stopped: 'purged' | 'budget' | null = null;
  const started = Date.now();
  const watch = setInterval(() => {
    if (purgeLogChanged(sealed.purge_log, deps.home)) stopped = 'purged';
    else if (Date.now() - started > budgetMs) stopped = 'budget';
    if (stopped) child.kill();
  }, 2000);
  let code: number;
  try { code = await child.exited; } finally { clearInterval(watch); }
  rmSync(join(runDir, 'work'), { recursive: true, force: true });
  rmSync(join(runDir, 'segments'), { recursive: true, force: true });
  rmSync(join(runDir, 'home'), { recursive: true, force: true });
  if (stopped === 'purged' || purgeLogChanged(sealed.purge_log, deps.home)) { removeRun(runDir); await scheduleScratchDrop(cap); throw new ReplayError('shadow_replay_purged', 'during the replay'); }
  if (stopped === 'budget') throw new ReplayError('shadow_replay_budget', `${Math.round(budgetMs / 60_000)} minutes`);
  const reportPath = join(runDir, 'out', 'report.json');
  if (code !== 0 || !existsSync(reportPath)) throw new Error(`the replay child exited ${code} without a report (its stderr names the cause)`);
  return { report: JSON.parse(readFileSync(reportPath, 'utf8')) as ReplayReport, dir: join(runDir, 'out') };
}

/**
 * The barrier after a seed: when the purge log moved or the epoch is no longer the recording one (a purge in another
 * process invalidated it while the seed ran), everything is deleted again, the copies the seed went on writing
 * included, and the scratch copy dropped. Returns true only for an epoch still valid.
 */
export async function settleSeededEpoch(cap: string, next: EpochPointer, home: string): Promise<boolean> {
  const now = readEpoch(cap);
  if (now?.id === next.id && now.state === 'recording' && !purgeLogChanged(next.purge_log, home)) return true;
  invalidateIfPurged(cap, { home, force: 'purge' });
  deleteAllCaptureData(cap);
  await scheduleScratchDrop(cap);
  return false;
}

/**
 * Recording processes of an epoch still alive now (heartbeat files whose process runs): a call one of them finished
 * just before the seal may still sit in its buffer, so the sealed replay cannot claim complete coverage.
 */
export function liveRecorders(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir).filter(f => f.startsWith('proc-') && f.endsWith('.json'))) {
    try { if (processAlive((JSON.parse(readFileSync(join(dir, f), 'utf8')) as { pid?: number }).pid)) n++; } catch { n++; } // silent-read-ok: an unreadable heartbeat counts as alive (incomplete, never a false complete)
  }
  return n;
}

const retryPath = (cap: string) => join(cap, 'retry.json');
type Retained = { pointer: EpochPointer; attempts: number };

function readRetained(cap: string): Retained | null {
  try { return JSON.parse(readFileSync(retryPath(cap), 'utf8')) as Retained; } catch { return null; } // silent-read-ok: no retry file means no retained replay
}

/**
 * Replays one sealed epoch and retires it. A purge deletes it; any other failure keeps its recording and copies for
 * one retry the next night (retry.json), and a second failure retires it. Returns the report, or throws.
 */
async function replayAndRetire(deps: NightlyDeps, cap: string, sealed: EpochPointer, attempts: number, budgetMs: number, home: string, aliveAtSeal: number) {
  try {
    if (purgeLogChanged(sealed.purge_log, home)) throw new ReplayError('shadow_replay_purged', 'before the replay');
    const out = await replayEpoch(deps, cap, sealed, budgetMs, attempts > 0, aliveAtSeal);
    deleteEpochData(cap, sealed.id);
    rmSync(retryPath(cap), { force: true });
    return out;
  } catch (e) {
    if (e instanceof ReplayError && e.code === 'shadow_replay_purged') {
      deleteAllCaptureData(cap);
      await scheduleScratchDrop(cap);
    } else if (attempts < 1) {
      writePrivateJson(retryPath(cap), { pointer: sealed, attempts: attempts + 1 } satisfies Retained);
    } else {
      deleteEpochData(cap, sealed.id);
      rmSync(retryPath(cap), { force: true });
    }
    throw e;
  }
}

export async function runNightlyReplay(deps: NightlyDeps, opts: { budgetMinutes?: number } = {}): Promise<NightlyResult> {
  const budgetMs = (opts.budgetMinutes ?? 120) * 60_000;
  const cap = captureDir(deps.shadowDir);
  const home = deps.home ?? configDir();
  const unlock = acquireReplayLock(join(deps.shadowDir, 'replay'), budgetMs);
  const result: NightlyResult = { schema_version: 1, status: 'off' };
  try {
    const purged = invalidateIfPurged(cap, { home });
    // An interrupted cleanup of an invalidated epoch is finished before anything else may start.
    if (!await resumeInvalidatedCleanup(cap)) throw new ReplayError('shadow_replay_purged', 'the cleanup of a purged epoch could not finish yet (the scratch Postgres copy is unreachable)');
    let pointer = readEpoch(cap);
    if (pointer?.state === 'recording' && !existsSync(join(basesDir(cap, pointer.id), 'manifest.json'))) {
      invalidateIfPurged(cap, { home, force: 'unseeded' });
      pointer = readEpoch(cap);
    }
    const sealed = pointer && pointer.state !== 'invalidated' && existsSync(join(basesDir(cap, pointer.id), 'manifest.json')) ? pointer : null;
    const on = captureIsOn(cap, deps.env);
    // The next seed must be able to open the brain (a PGLite brain held by a running serve cannot be): check before
    // retiring anything, so a busy brain leaves tonight's recording in place for a later run.
    if (on) {
      try { const probe = await deps.openPrimary(); await probe.disconnect(); }
      catch (e) { throw new ReplayError('shadow_replay_seed_failed', `the brain cannot be opened for the seed (${(e as { code?: unknown }).code ?? (e as Error).name}); nothing was retired`); }
    }
    if (sealed) setEpochState(cap, sealed, 'sealed');
    const aliveAtSeal = sealed ? liveRecorders(epochDir(cap, sealed.id)) : 0;
    const next = on ? startEpoch(cap, home, deps.now?.()) : null;
    if (next) result.started_epoch = next.id;
    let failure: unknown = null;
    const retained = readRetained(cap);
    const queue: Retained[] = [
      ...(retained && retained.pointer.id !== sealed?.id && existsSync(join(basesDir(cap, retained.pointer.id), 'manifest.json')) ? [retained] : []),
      ...(sealed ? [{ pointer: sealed, attempts: retained?.pointer.id === sealed.id ? retained.attempts : 0 }] : []),
    ];
    for (const item of queue) {
      try {
        const { report, dir } = await replayAndRetire(deps, cap, item.pointer, item.attempts, budgetMs, home, item.pointer.id === sealed?.id ? aliveAtSeal : 1);
        Object.assign(result, { status: 'replayed', replayed_epoch: item.pointer.id, coverage: report.coverage, by_class: report.by_class, report: join(dir, 'report.md'), summary: join(dir, 'summary.json') });
      } catch (e) {
        if (e instanceof ReplayError && e.code === 'shadow_replay_purged') { result.status = 'purged'; break; }
        failure ??= e;
      }
    }
    if (!sealed && purged) result.status = 'purged';
    if (next && result.status !== 'purged') {
      try {
        await seedEpoch(deps, cap, next);
      } catch (e) {
        const purgedNow = purgeLogChanged(next.purge_log, home) || (e instanceof ReplayError && e.code === 'shadow_replay_purged');
        invalidateIfPurged(cap, { home, force: purgedNow ? 'purge' : 'seed_failed' });
        if (purgedNow) { await settleSeededEpoch(cap, next, home); result.status = 'purged'; return result; }
        await scheduleScratchDrop(cap);
        throw e instanceof ReplayError ? e : new ReplayError('shadow_replay_seed_failed', `error code ${(e as { code?: unknown }).code ?? (e as Error).name}`);
      }
      if (!await settleSeededEpoch(cap, next, home)) result.status = 'purged';
      else if (result.status === 'off') result.status = 'seeded_only';
    } else if (next) {
      await settleSeededEpoch(cap, next, home);
    }
    if (failure && result.status !== 'purged') throw failure;
    return result;
  } finally {
    unlock();
  }
}
