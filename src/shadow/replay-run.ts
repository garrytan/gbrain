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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { configDir } from '../core/config.ts';
import {
  basesDir, deleteAllCaptureData, deleteEpochData, epochDir, invalidateIfPurged, purgeLogChanged, readEpoch, scheduleScratchDrop, scratchCleared, scratchRecordPath,
  readScratchRecord, setEpochState, startEpoch, type EpochPointer,
} from './capture.ts';
import { captureDir, captureIsOn, writePrivateJson } from './capture-state.ts';
import { FanOutSeedTarget, markScratchPostgres, REPLAY_POSTGRES_ENV, resetScratchPostgres, SqlSeedTarget, checkLocalPostgresUrl, type ArmImport } from './replay-copy.ts';
import { ReplayError } from './replay-errors.ts';
import { childEnv, hmacKey, prepareRun, removeRun, type ReplayReport, type RunSpec } from './replay.ts';
import { runSeed, type SeedRecord, type SeedTarget } from './seed.ts';

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
  const token = `${process.pid} ${Date.now()} ${randomBytes(6).toString('hex')}\n`;
  const unlock = () => { if (lockHolder(path) === token) rmSync(path, { force: true }); };
  if (createLock(path, token)) return unlock;
  const since = Number(lockHolder(path)?.split(' ')[1] ?? 0);
  if (Date.now() - since < budgetMs + 30 * 60_000) throw new ReplayError('shadow_replay_busy', `lock ${path}`);
  rmSync(path, { force: true });
  if (createLock(path, token)) return unlock;
  throw new ReplayError('shadow_replay_busy', `lock ${path}`);
}

/** Creates the lock file exclusively; false when it already exists. */
function createLock(path: string, token: string): boolean {
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try { writeSync(fd, token); } finally { closeSync(fd); }
  return true;
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
  const store = await deps.openStore(load.addon, join(base, 'rust'));
  const sql: Record<string, SqlSeedTarget> = {};
  const opened: BrainEngine[] = [];
  let primary: BrainEngine | null = null;
  try {
    const plan = await store.seedPlan();
    const pglite = await deps.openSql('pglite', join(base, 'pglite'));
    opened.push(pglite);
    await pglite.initSchema();
    sql.pglite = new SqlSeedTarget(pglite, plan);
    if (pgUrl) {
      const pg = await deps.openSql('postgres', pgUrl);
      opened.push(pg);
      await resetScratchPostgres(pg, deps.brainKey);
      // Recorded once ownership is verified and before the first row lands, so a purge from any process can drop it.
      writePrivateJson(scratchRecordPath(cap), { url: pgUrl, brain: deps.brainKey, verified: true });
      await pg.initSchema();
      await markScratchPostgres(pg, deps.brainKey);
      sql.postgres = new SqlSeedTarget(pg, plan);
    }
    primary = await deps.openPrimary();
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

async function replayEpoch(deps: NightlyDeps, cap: string, sealed: EpochPointer, budgetMs: number): Promise<{ report: ReplayReport; dir: string }> {
  const manifest = JSON.parse(readFileSync(join(basesDir(cap, sealed.id), 'manifest.json'), 'utf8')) as BaseManifest;
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
    cut: manifest.cut, seed_losses_present: seedLosses(manifest), segments: paths.segments,
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

export async function runNightlyReplay(deps: NightlyDeps, opts: { budgetMinutes?: number } = {}): Promise<NightlyResult> {
  const budgetMs = (opts.budgetMinutes ?? 120) * 60_000;
  const cap = captureDir(deps.shadowDir);
  const home = deps.home ?? configDir();
  const unlock = acquireReplayLock(join(deps.shadowDir, 'replay'), budgetMs);
  const result: NightlyResult = { schema_version: 1, status: 'off' };
  try {
    const purged = invalidateIfPurged(cap, { home });
    if (!await scratchCleared(cap)) throw new ReplayError('shadow_replay_purged', 'the scratch Postgres copy of a purged epoch could not be dropped yet');
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
    const next = on ? startEpoch(cap, home, deps.now?.()) : null;
    if (next) result.started_epoch = next.id;
    if (sealed) {
      try {
        if (purgeLogChanged(sealed.purge_log, home)) { await scheduleScratchDrop(cap); throw new ReplayError('shadow_replay_purged', 'before the replay'); }
        const { report, dir } = await replayEpoch(deps, cap, sealed, budgetMs);
        Object.assign(result, { status: 'replayed', replayed_epoch: sealed.id, coverage: report.coverage, by_class: report.by_class, report: join(dir, 'report.md'), summary: join(dir, 'summary.json') });
      } catch (e) {
        if (!(e instanceof ReplayError && e.code === 'shadow_replay_purged')) throw e;
        result.status = 'purged';
      } finally {
        deleteEpochData(cap, sealed.id);
      }
    } else if (purged) result.status = 'purged';
    if (next) {
      try {
        await seedEpoch(deps, cap, next);
      } catch (e) {
        invalidateIfPurged(cap, { home, force: 'seed_failed' });
        if (!await settleSeededEpoch(cap, next, home)) { result.status = 'purged'; return result; }
        if (e instanceof ReplayError) throw e;
        throw new ReplayError('shadow_replay_seed_failed', `error code ${(e as { code?: unknown }).code ?? (e as Error).name}`);
      }
      if (!await settleSeededEpoch(cap, next, home)) result.status = 'purged';
      else if (result.status === 'off') result.status = 'seeded_only';
    }
    return result;
  } finally {
    unlock();
  }
}
