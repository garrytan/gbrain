/**
 * The nightly shadow replay (docs/guides/shadow-replay.md), parent side: one call does, in order,
 *   1. take the replay lock and invalidate the current epoch when the purge log changed;
 *   2. seal the current epoch (when its copies were seeded): the recording processes write out its calls and
 *      acknowledge (sealEpoch), and the next epoch starts; it stays only while capture is on;
 *   3. replay the sealed epoch in the isolated child, killing it when the purge log changes or the budget runs out;
 *   4. delete the sealed epoch's recording and copies (the report stays);
 *   5. seed the new epoch's copies from one snapshot of the brain (Rust store and PGLite).
 * The first night only seeds. Nothing here writes to the brain.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { configDir } from '../core/config.ts';
import {
  basesDir, deleteEpochData, epochDir, purgeCapture, purgeIfLogChanged, purgeLogChanged, purgePending, readEpoch, retireEpoch,
  sealEpoch, setEpochState, startEpoch, type EpochPointer,
} from './capture.ts';
import { acquireReplayLock } from './capture-lock.ts';
import { captureDir, captureIsOn, writePrivateJson } from './capture-state.ts';
import { FanOutSeedTarget, refusePostgresArm, SqlSeedTarget, type ArmImport } from './replay-copy.ts';
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
}

export interface NightlyDeps {
  shadowDir: string;
  brainKey: string;
  primaryEngine: 'pglite' | 'postgres';
  env: Record<string, string | undefined>;
  home?: string;
  openPrimary(): Promise<BrainEngine>;
  loadAddon(): Promise<RustEngineAddonLoad>;
  rustDir?: string;
  openStore(addon: object, path: string): Promise<SeedTarget & { close(): Promise<void> }>;
  /** A connected PGLite brain at a path, schema not yet created. */
  openSql(kind: 'pglite', where: string): Promise<BrainEngine>;
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

async function seedEpoch(deps: NightlyDeps, cap: string, epoch: EpochPointer): Promise<BaseManifest> {
  const load = await deps.loadAddon();
  if (!load.ok) throw new ReplayError('shadow_replay_addon_unavailable', `${load.code} (${load.reason})`);
  const base = basesDir(cap, epoch.id);
  mkdirSync(base, { recursive: true, mode: 0o700 });
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
    const fan = new FanOutSeedTarget(store, sql);
    const seed = await runSeed(primary, fan, { primaryEngine: deps.primaryEngine, now: deps.now });
    for (const t of Object.values(sql)) await t.finish(primary);
    const current = readEpoch(cap);
    if (current?.id !== epoch.id || current.state !== 'recording') throw new ReplayError('shadow_replay_purged', 'the epoch was invalidated while it was seeded');
    writePrivateJson(join(base, 'seeded-ids.json'), [...fan.seededIds].sort());
    const manifest: BaseManifest = { version: 1, epoch: epoch.id, cut: fan.cut, seed, arms: fan.arms };
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

async function replayEpoch(deps: NightlyDeps, cap: string, sealed: EpochPointer, budgetMs: number, retry = false, unverified = 0): Promise<{ report: ReplayReport; dir: string }> {
  const manifest = JSON.parse(readFileSync(join(basesDir(cap, sealed.id), 'manifest.json'), 'utf8')) as BaseManifest;
  void retry; // a retry starts from the same kept copies
  const runDir = join(deps.shadowDir, 'replay', `run-${(deps.now?.() ?? new Date()).toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${sealed.id.slice(-8)}`);
  const paths = prepareRun(runDir, epochDir(cap, sealed.id), basesDir(cap, sealed.id));
  const spec: RunSpec = {
    version: 1, epoch: sealed.id, brain_key: deps.brainKey, hmac_key: hmacKey(cap), seeded_ids: paths.seededIds,
    arms: { pglite: paths.pglite, rust: paths.rust },
    ...(deps.rustDir ? { rust_dir: deps.rustDir } : {}),
    cut: manifest.cut, seed_losses_present: seedLosses(manifest), segments: paths.segments, ...(unverified ? { tail_unverified: unverified } : {}),
  };
  writePrivateJson(join(runDir, 'run.json'), spec);
  const child = deps.spawnChild(runDir, childEnv(deps.env, paths.home));
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
  rmSync(join(runDir, 'cwd'), { recursive: true, force: true });
  if (stopped === 'purged' || purgeLogChanged(sealed.purge_log, deps.home)) { removeRun(runDir); purgeCapture(cap); throw new ReplayError('shadow_replay_purged', 'during the replay'); }
  if (stopped === 'budget') throw new ReplayError('shadow_replay_budget', `${Math.round(budgetMs / 60_000)} minutes`);
  const reportPath = join(runDir, 'out', 'report.json');
  if (code !== 0 || !existsSync(reportPath)) throw new Error(`the replay child exited ${code} without a report (its stderr names the cause)`);
  return { report: JSON.parse(readFileSync(reportPath, 'utf8')) as ReplayReport, dir: join(runDir, 'out') };
}

/**
 * The barrier after a seed: when the purge log moved or the epoch is no longer the recording one (a purge in another
 * process invalidated it while the seed ran), everything is deleted again, the copies the seed went on writing
 * included. Returns true only for an epoch still valid.
 */
export async function settleSeededEpoch(cap: string, next: EpochPointer, home: string): Promise<boolean> {
  const now = readEpoch(cap);
  if (now?.id === next.id && now.state === 'recording' && !purgeLogChanged(next.purge_log, home)) return true;
  purgeCapture(cap);
  return false;
}

const retryPath = (cap: string) => join(cap, 'retry.json');
type Retained = { pointer: EpochPointer; attempts: number };
const MAX_ATTEMPTS = 2;

/** The sealed epochs still owed a replay (retry.json). An old single-record file reads as a list of one. */
function readRetained(cap: string): Retained[] {
  let v: unknown;
  try { v = JSON.parse(readFileSync(retryPath(cap), 'utf8')); } catch { return []; } // silent-read-ok: no retry file means no retained replay
  return (Array.isArray(v) ? v : [v]).filter((r): r is Retained => !!r && typeof (r as Retained).pointer?.id === 'string');
}

function writeRetained(cap: string, list: Retained[]): void {
  if (list.length) writePrivateJson(retryPath(cap), list); else rmSync(retryPath(cap), { force: true });
}

/**
 * Deletes recordings and copies that neither the current epoch nor a retry record names: what a run left behind when
 * it died between a seal and the end of its replay. Returns how many epochs it deleted.
 */
export function retireOrphanEpochs(cap: string, keep: ReadonlySet<string>): number {
  const ids = new Set<string>();
  if (existsSync(cap)) for (const f of readdirSync(cap)) if (f.startsWith('epoch-') && f !== 'epoch.json') ids.add(f.slice('epoch-'.length));
  if (existsSync(join(cap, 'bases'))) for (const f of readdirSync(join(cap, 'bases'))) ids.add(f);
  let n = 0;
  for (const id of ids) if (!keep.has(id)) { deleteEpochData(cap, id); n++; }
  return n;
}

/**
 * Replays one sealed epoch and retires it. The attempt is counted in retry.json before the child starts, so a run
 * that dies mid-replay still counts it. A purge deletes it; any other failure keeps its recording and copies for one
 * more attempt the next night, and a second failed attempt retires it. Returns the report, or throws.
 */
async function replayAndRetire(deps: NightlyDeps, cap: string, item: Retained, budgetMs: number, home: string, unverified: number) {
  const started = item.attempts + 1;
  const others = () => readRetained(cap).filter(r => r.pointer.id !== item.pointer.id);
  writeRetained(cap, [...others(), { pointer: item.pointer, attempts: started }]);
  try {
    if (purgeLogChanged(item.pointer.purge_log, home)) throw new ReplayError('shadow_replay_purged', 'before the replay');
    const out = await replayEpoch(deps, cap, item.pointer, budgetMs, item.attempts > 0, unverified);
    deleteEpochData(cap, item.pointer.id);
    writeRetained(cap, others());
    return out;
  } catch (e) {
    if (e instanceof ReplayError && e.code === 'shadow_replay_purged') {
      purgeCapture(cap);
    } else if (started >= MAX_ATTEMPTS) {
      deleteEpochData(cap, item.pointer.id);
      writeRetained(cap, others());
    }
    throw e;
  }
}

export async function runNightlyReplay(deps: NightlyDeps, opts: { budgetMinutes?: number } = {}): Promise<NightlyResult> {
  const budgetMs = (opts.budgetMinutes ?? 120) * 60_000;
  const cap = captureDir(deps.shadowDir);
  const home = deps.home ?? configDir();
  refusePostgresArm(deps.env); // named refusal before anything runs; never a silent skip
  const unlock = acquireReplayLock(join(deps.shadowDir, 'replay'), budgetMs);
  const result: NightlyResult = { schema_version: 1, status: 'off' };
  try {
    // A purge since the epoch began, or one whose deletion did not finish, is carried out before anything else.
    const purged = purgeIfLogChanged(cap, home);
    if (purgePending(cap)) throw new ReplayError('shadow_replay_purged', 'a purge could not delete every recording yet; nothing was replayed');
    let pointer = readEpoch(cap);
    if (pointer?.state === 'recording' && !existsSync(join(basesDir(cap, pointer.id), 'manifest.json'))) {
      retireEpoch(cap, 'unseeded');
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
    // The seal: every recording process writes out its calls of the sealed epoch and acknowledges, and the next epoch
    // starts at the same moment. A process that could not acknowledge (or died first) makes the replay incomplete.
    let unverified = 0;
    let next: EpochPointer | null = null;
    let retained = readRetained(cap).filter(r => existsSync(join(basesDir(cap, r.pointer.id), 'manifest.json')));
    // A run that died after its seal left epochs nothing names any more: they are retired before anything else.
    retireOrphanEpochs(cap, new Set([...(pointer ? [pointer.id] : []), ...retained.map(r => r.pointer.id)]));
    if (sealed) {
      // The sealed epoch is owed a replay before the pointer moves past it, so a crash after the seal keeps it in the
      // retry rules instead of stranding its copies.
      const prior = retained.find(r => r.pointer.id === sealed.id);
      retained = [...retained.filter(r => r.pointer.id !== sealed.id), { pointer: sealed, attempts: prior?.attempts ?? 0 }];
      writeRetained(cap, retained);
      if (sealed.state === 'recording') {
        const seal = await sealEpoch(cap, { home, now: deps.now });
        if (!seal) { purgeCapture(cap); result.status = 'purged'; return result; } // a purge invalidated it during the seal
        unverified = seal.unacked + (sealed.unverified ?? 0);
        Object.assign(sealed, seal.sealed);
        next = seal.next;
      } else {
        // A run died during or after this epoch's seal: what its recorders acknowledged cannot be told now.
        setEpochState(cap, sealed, 'sealed');
        Object.assign(sealed, { state: 'sealed' });
        unverified = 1 + (sealed.unverified ?? 0);
        next = startEpoch(cap, home, deps.now?.(), { after: sealed.id });
      }
      if (!on) { retireEpoch(cap, 'unseeded'); next = null; } // capture is off: nothing records into it
    } else if (on) {
      next = startEpoch(cap, home, deps.now?.());
    }
    if (next) result.started_epoch = next.id;
    let failure: unknown = null;
    // Older owed epochs first, then tonight's; the sealed pointer replaces its pre-seal record.
    const queue: Retained[] = retained.map(r => (r.pointer.id === sealed?.id ? { ...r, pointer: sealed } : r));
    for (const item of queue) {
      try {
        const { report, dir } = await replayAndRetire(deps, cap, item, budgetMs, home, item.pointer.id === sealed?.id ? unverified : 1);
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
        if (purgedNow) { purgeCapture(cap); result.status = 'purged'; return result; }
        retireEpoch(cap, 'seed_failed');
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
