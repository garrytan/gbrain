/**
 * `gbrain engine shadow start|status|stop|report|seed` (plan PR S1, the read half of S2 and the seed of S3).
 *
 * Shadow mode mirrors a sample of the host brain's reads to the Rust engine in a supervised child process and
 * records whether the answers agree. It is off by default and writes nothing to the brain database, its config
 * table or the brain repo: every file lives in `<gbrain home>/shadow/<brain>/`. `start` previews a plan with a hash
 * and needs `--yes --expect <hash>`; the installed addon is loaded then, in the foreground. Shadow mode gathers evidence on
 * managed-storage brains too; only the swap refuses them. `start` opens the brain once, best-effort, to read its storage
 * mode, reports a brain that cannot swap, records the mode in state.json, and never refuses over it. The
 * hidden `__child <dir>` is the child the serving process spawns. `seed` copies the brain into the Rust store
 * once, in one read-only snapshot, and writes `seed.json` (src/shadow/seed.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../core/config.ts';
import type { EngineConfig } from '../core/types.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { readFaults, readShadowSummary } from '../shadow/ledger.ts';
import { buildFollowStatus, renderFollowStatus } from '../shadow/follow-status.ts';
import { readManagedStorage, storageLine, storageReport, type ManagedStorageRecord, type StorageReport } from '../shadow/managed-gate.ts';
import { readSeedRecord, RESEED_STEPS, runSeed, SeedBudgetError, writeSeedRecord, type SeedRecord, type SeedTarget } from '../shadow/seed.ts';
import { buildProvisionalReport, renderProvisionalMarkdown, writeProvisionalReport } from '../shadow/report.ts';
import {
  brainIdentity, DEFAULT_SHADOW_QUEUE_BOUND, DEFAULT_SHADOW_SAMPLE_RATE, readShadowState, shadowBrainKey, shadowDirFor,
  SHADOW_STATE_VERSION, writeShadowState, type ShadowState,
} from '../shadow/state.ts';

export interface EngineShadowDeps {
  /** The brain this command selects (`--brain`, GBRAIN_BRAIN_ID, a mount); default resolved the way every command does. */
  brainId?: () => string;
  /** The brain config; default loadConfig() (the host brain). */
  config?: () => Pick<EngineConfig, 'engine' | 'database_path' | 'database_url'> | null;
  /** The addon loader `start --yes` runs; default the real loader (installed addon only, no network). */
  loadAddon?: () => Promise<RustEngineAddonLoad>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => Date;
  /** The `__child` loop; default runShadowChild on stdin/stdout. */
  runChild?: (dir: string) => Promise<number>;
  /** The connected primary brain `seed` reads and `start` opens to read its storage mode (closed after); default the configured brain, opened without shadow mode. */
  openPrimary?: () => Promise<BrainEngine>;
  /** Test seam for `reconcile`: the supervisor options (argv, spawn) of the child that holds the Rust store. */
  reconcileSupervisor?: Partial<import('../shadow/supervisor.ts').ShadowSupervisorOptions>;
  /** Opens the Rust store `seed` writes; default openRustStore on the loaded addon at `<dir>/store`. */
  openStore?: (addon: object, storePath: string) => Promise<SeedTarget & { close(): Promise<void> }>;
}

const HELP = `gbrain engine shadow — compare the Rust engine against this brain's reads, off the request path

Usage:
  gbrain engine shadow start [--plan] [--sample-rate <0..1>] [--queue-bound <n>]
  gbrain engine shadow start --yes --expect <plan_hash> [--sample-rate <0..1>] [--queue-bound <n>]
  gbrain engine shadow status [--json]
  gbrain engine shadow stop [--delete]
  gbrain engine shadow report [--json]
  gbrain engine shadow seed [--json] [--reseed]
  gbrain engine shadow reconcile [--full] [--json]

Shadow mode is off by default. When on, a sample of reads this brain answers is sent, after the answer, to a
supervised child process that runs the same read on the Rust engine and records match, diff or why it could not
compare. The primary answer never waits for the child. It writes nothing to the brain database, its config or the
brain repo; everything lives in <gbrain home>/shadow/<brain>/. stop --delete removes that directory.

start runs on a brain that uses managed storage too; only the swap refuses such a brain. start opens the brain
database once to read its storage mode, even with --plan, prints a line when the brain cannot swap, and records the mode
in state.json. A brain whose mode cannot be read is not refused: the mode is recorded as unread.

seed copies this brain into the Rust store once, in one read-only snapshot, before shadow mode compares answers.
It writes no table row, source file, ownership marker or registry entry of the brain. Opening a PGLite brain still
takes its process lock, and PGLite rewrites its own control and log files. A brain with an open repair episode is not
opened. A store is seeded once: to seed again, delete the shadow directory first.
seed runs on a brain that uses managed storage too; only the swap refuses such a brain. seed reads the brain's storage
mode right before its snapshot and records it in seed.json; a mode it cannot read does not stop the seed.

A seeded brain is followed: each committed write is read back from the brain and applied to the Rust store. reconcile
compares the whole store with the brain (digests per 500-row interval) and repairs what differs; it needs the Rust
store to be free, so run it when no serving process holds it. Plain reconcile and --full both run a full pass. status
shows the follower's lag and coverage, the last pass, fingerprint checks and the allocator check; the fingerprint and
comparison counts are totals for the current seed.

The report is provisional and always says NOT READY.`;

class UsageError extends Error {}

interface StartOpts { plan: boolean; yes: boolean; expect: string | null; sampleRate: number; queueBound: number }

function parseStart(args: string[]): StartOpts {
  const o: StartOpts = { plan: false, yes: false, expect: null, sampleRate: DEFAULT_SHADOW_SAMPLE_RATE, queueBound: DEFAULT_SHADOW_QUEUE_BOUND };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (): string => {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === '--plan') o.plan = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--expect') o.expect = value();
    else if (a === '--sample-rate') {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0 || n > 1) throw new UsageError('--sample-rate must be a number above 0 and at most 1');
      o.sampleRate = n;
    } else if (a === '--queue-bound') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new UsageError('--queue-bound must be a whole number from 1 to 100000');
      o.queueBound = n;
    } else throw new UsageError(`Unknown flag for engine shadow start: ${a}`);
  }
  return o;
}

function flags(args: string[], allowed: string[], sub: string): Set<string> {
  const set = new Set<string>();
  for (const a of args) {
    if (!allowed.includes(a)) throw new UsageError(`Unknown flag for engine shadow ${sub}: ${a}`);
    set.add(a);
  }
  return set;
}

export interface ShadowPlan {
  brain: string;
  primary_engine: string;
  directory: string;
  sample_rate: number;
  queue_bound: number;
  mirrors: string;
  writes: string[];
  never_writes: string[];
}

export function shadowPlan(brain: string, primaryEngine: string, dir: string, o: Pick<StartOpts, 'sampleRate' | 'queueBound'>): { plan: ShadowPlan; hash: string } {
  const plan: ShadowPlan = {
    brain, primary_engine: primaryEngine, directory: dir, sample_rate: o.sampleRate, queue_bound: o.queueBound,
    mirrors: 'a sample of reads and searches this brain answers, after the answer; none inside a transaction',
    writes: [`${dir}/state.json`, `${dir}/store (the Rust engine's own store)`, `${dir}/ledger, summaries, faults.jsonl, reports, child.log`],
    never_writes: ['the brain database', 'the brain config table', 'the brain repo'],
  };
  const hash = createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
  return { plan, hash };
}

/** The brain this process resolved (--brain, GBRAIN_BRAIN_ID, .gbrain-mount, a mount path); 'unresolved' when resolution fails, so the command refuses. */
async function defaultBrainId(): Promise<() => string> {
  const { brainRoutingArgs } = await import('../core/brain-resolver.ts');
  return () => brainRoutingArgs()[1] ?? 'unresolved';
}

interface ResolvedBrain { key: string; dir: string; engine: string; config: Pick<EngineConfig, 'engine' | 'database_path' | 'database_url'> }

async function resolveBrain(deps: EngineShadowDeps): Promise<ResolvedBrain> {
  // Shadow state is keyed by the host brain's config. A selected mounted brain would silently read, start or delete the host's.
  // Loaded here, not at the top, so the command's flag table does not grow by everything the resolver imports.
  const { HOST_BRAIN_ID } = await import('../core/brain-registry.ts');
  const selected = (deps.brainId ?? (await defaultBrainId()))();
  if (selected !== HOST_BRAIN_ID) {
    throw new UsageError(`Shadow mode covers the host brain only, and this command selects the brain ${selected}, so nothing was changed. Run it without --brain (and with GBRAIN_BRAIN_ID unset) to use the host brain.`);
  }
  const config = (deps.config ?? (() => loadConfig()))();
  const id = config ? brainIdentity(config) : null;
  const key = config ? shadowBrainKey(config) : null;
  if (!config || !id || !key) throw new UsageError('No brain is configured here (gbrain init sets one up); shadow mode needs a brain to compare against.');
  return { key, dir: shadowDirFor(key), engine: id.engine, config };
}

export async function runEngineShadow(args: string[], deps: EngineShadowDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const now = deps.now ?? (() => new Date());
  const [sub, ...rest] = args;
  try {
    if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
      out(HELP);
      return sub ? 0 : 1;
    }
    if (sub === '__child') {
      const dir = rest[0];
      if (!dir) throw new UsageError('__child needs the shadow directory');
      const run = deps.runChild ?? (async (d: string) => {
        const { runShadowChild, pipeControlWriter } = await import('../shadow/child.ts');
        await runShadowChild(d, { input: process.stdin, writeControl: pipeControlWriter(process.stdout), exit: (code) => process.exit(code) });
        return 0;
      });
      return await run(dir);
    }
    const brain = await resolveBrain(deps);
    if (sub === 'start') return await start(brain, parseStart(rest), deps, out, err, now);
    if (sub === 'status') return status(brain, flags(rest, ['--json'], 'status').has('--json'), out);
    if (sub === 'stop') return stop(brain, flags(rest, ['--delete'], 'stop').has('--delete'), out, now);
    if (sub === 'report') return report(brain, flags(rest, ['--json'], 'report').has('--json'), out, now);
    if (sub === 'seed') return await seed(brain, flags(rest, ['--json', '--reseed'], 'seed'), deps, out, err, now);
    if (sub === 'reconcile') return await reconcileCommand(brain, flags(rest, ['--json', '--full'], 'reconcile').has('--json'), deps, out, err);
    throw new UsageError(`Unknown engine shadow subcommand: ${sub}`);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`engine shadow: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

/** Opens the configured brain the way the primary opens it, minus shadow mode (that attaches in createEngine only). */
async function openStartPrimary(config: ResolvedBrain['config']): Promise<BrainEngine> {
  const { constructEngine } = await import('../core/engine-construct.ts');
  const engineConfig: EngineConfig = { engine: config.engine, database_path: config.database_path, database_url: config.database_url };
  // PGLite runs initdb on a missing or uninitialized directory when it connects; a preview must not make a brain (engine swap refuses the same way).
  if (!engineConfig.database_url && (!engineConfig.database_path || !existsSync(join(engineConfig.database_path, 'PG_VERSION')))) {
    throw Object.assign(new Error(`no brain exists at ${engineConfig.database_path ?? '(no path configured)'}`), { code: 'no_brain' });
  }
  const engine = await constructEngine(engineConfig);
  // Only a local brain (PGLite) has this open: no recording of its managed roots (that writes ownership markers into the
  // datastore and source checkouts) and, with repair off, no repair of a damaged log (that renames the primary's files).
  const quiet = (engine as unknown as { connectForRestore?: (c: EngineConfig, o?: { keepRepairEpisode?: boolean }) => Promise<void> }).connectForRestore?.bind(engine);
  if (!quiet) {
    await engine.connect(engineConfig);
    return engine;
  }
  // A healthy open also closes an open repair episode and prunes older repair backups; a preview must not, so it leaves that brain unread.
  const { readRepairSidecar } = await import('../core/pglite-repair.ts');
  if (readRepairSidecar(engineConfig.database_path!).episodeStartedAt !== null) {
    throw Object.assign(new Error('a repair episode is open on this brain; opening it would close the episode and prune its backups'), { code: 'repair_episode_open' });
  }
  const savedRepair = process.env.GBRAIN_PGLITE_WAL_REPAIR;
  process.env.GBRAIN_PGLITE_WAL_REPAIR = 'off';
  try {
    // The check above runs before the open takes the datastore lock; an episode recorded while it waits is still kept.
    await quiet(engineConfig, { keepRepairEpisode: true });
  } finally {
    if (savedRepair === undefined) delete process.env.GBRAIN_PGLITE_WAL_REPAIR;
    else process.env.GBRAIN_PGLITE_WAL_REPAIR = savedRepair;
  }
  return engine;
}

/** The brain's storage mode, read best-effort: a brain that cannot be opened or read is `managed: null` with a reason, never a refusal. */
async function readStorage(brain: ResolvedBrain, deps: EngineShadowDeps, now: () => Date): Promise<ManagedStorageRecord> {
  const { readManagedStorage, unopenableManagedStorage } = await import('../shadow/managed-gate.ts');
  let primary: BrainEngine;
  try {
    primary = await (deps.openPrimary ?? (() => openStartPrimary(brain.config)))();
  } catch (e) {
    return unopenableManagedStorage(e, now());
  }
  try {
    return await readManagedStorage(primary, now());
  } finally {
    await primary.disconnect().catch(() => undefined);
  }
}

async function start(
  brain: ResolvedBrain, o: StartOpts, deps: EngineShadowDeps,
  out: (l: string) => void, err: (l: string) => void, now: () => Date,
): Promise<number> {
  const { plan, hash } = shadowPlan(brain.key, brain.engine, brain.dir, o);
  if (o.plan || !o.yes) {
    out(`Shadow mode plan for brain ${plan.brain} (${plan.primary_engine}):`);
    out(`  mirrors: ${plan.mirrors}`);
    out(`  sample rate ${plan.sample_rate}, serving-process queue bound ${plan.queue_bound}`);
    for (const w of plan.writes) out(`  writes: ${w}`);
    out(`  never writes: ${plan.never_writes.join(', ')}`);
    const line = storageLine(await readStorage(brain, deps, now));
    if (line) out(`  storage: ${line}`);
    out(`  the installed Rust engine addon is loaded and verified now`);
    out(`plan_hash: ${hash}`);
    out(`To turn it on: gbrain engine shadow start --yes --expect ${hash}${o.sampleRate !== DEFAULT_SHADOW_SAMPLE_RATE ? ` --sample-rate ${o.sampleRate}` : ''}${o.queueBound !== DEFAULT_SHADOW_QUEUE_BOUND ? ` --queue-bound ${o.queueBound}` : ''}`);
    return o.plan ? 0 : 3;
  }
  if (o.expect !== hash) {
    err(`engine shadow: preview_changed: the plan hash is ${hash}, not ${o.expect ?? '(none)'}. Run gbrain engine shadow start --plan and confirm again.`);
    return 3;
  }
  const load = await (deps.loadAddon ?? (async () => {
    const { loadRustEngineAddon } = await import('../core/rust-engine/addon-loader.ts');
    return loadRustEngineAddon();
  }))();
  if (!load.ok) {
    err(`engine shadow: ${load.code} (${load.reason}): ${load.message}`);
    err('Shadow mode stays off; nothing was written.');
    return 1;
  }
  const storage = await readStorage(brain, deps, now);
  mkdirSync(brain.dir, { recursive: true, mode: 0o700 });
  const state: ShadowState = {
    version: SHADOW_STATE_VERSION, enabled: true, started_at: now().toISOString(), sample_rate: o.sampleRate,
    queue_bound: o.queueBound, plan_hash: hash, brain: brain.key, primary_engine: brain.engine, storage,
  };
  writeShadowState(brain.dir, state);
  out(`Shadow mode is on for brain ${brain.key}. Processes that open this brain from now on mirror reads.`);
  const line = storageLine(storage);
  if (line) out(`storage: ${line}`);
  if (!readSeedRecord(brain.dir)) err('engine shadow: warning: the Rust store is not seeded, so most comparisons will differ. Stop shadow mode and run gbrain engine shadow seed first.');
  out('gbrain engine shadow status shows the counts; gbrain engine shadow stop turns it off.');
  return 0;
}

function status(brain: { key: string; dir: string }, json: boolean, out: (l: string) => void): number {
  const state = readShadowState(brain.dir);
  const summary = existsSync(brain.dir) ? readShadowSummary(brain.dir) : null;
  const faults = existsSync(brain.dir) ? readFaults(brain.dir, 5) : [];
  const totals: Record<string, number> = {};
  for (const counts of Object.values(summary?.by_op ?? {})) {
    for (const [outcome, n] of Object.entries(counts)) totals[outcome] = (totals[outcome] ?? 0) + (n ?? 0);
  }
  if (json) {
    out(JSON.stringify({
      schema_version: 1, brain: brain.key, enabled: state?.enabled === true, state, directory: brain.dir,
      totals, by_op: summary?.by_op ?? {}, serving: summary?.primary ?? null, child_shed: summary?.child_shed ?? 0,
      children: summary?.children ?? 0, recent_faults: faults, storage: storageReport(state?.storage),
      ...buildFollowStatus(brain.dir, state), seed: seedStatus(readSeedRecord(brain.dir)), // the seed block carries the recorded storage mode
    }, null, 2));
    return 0;
  }
  out(`Shadow mode: ${state?.enabled ? 'on' : 'off'} (brain ${brain.key})`);
  if (state) out(`  started ${state.started_at}${state.stopped_at ? `, stopped ${state.stopped_at}` : ''}; sample rate ${state.sample_rate}`);
  const line = storageLine(state?.storage);
  if (line) out(`  storage: ${line}`);
  const compared = Object.values(totals).reduce((a, b) => a + b, 0);
  out(`  comparisons: ${compared}${compared ? ` (${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  if (summary) {
    const p = summary.primary;
    out(`  serving: offered ${p.offered}, sent ${p.sent}, sampled out ${p.sampled_out}, shed ${p.shed_queue_full + p.shed_too_large + p.shed_transport + p.shed_unmirrorable}, in transaction ${p.skipped_in_transaction}`);
  }
  const seeded = readSeedRecord(brain.dir);
  out(seeded ? `  seed ${seeded.seed_id} finished ${seeded.finished_at}; unseeded gap rows ${seeded.unseeded_gap_rows_total}` : '  seed: none (gbrain engine shadow seed)');
  const seedStorage = storageLine(seeded?.storage);
  if (seedStorage) out(`  storage: ${seedStorage}`);
  if (seeded) for (const line of renderFollowStatus(buildFollowStatus(brain.dir, state))) out(line);
  for (const f of faults) out(`  fault ${f.ts} ${f.kind}: ${f.detail}`);
  return 0;
}

/** The `seed` block of `status --json`: null fields until a seed finished. */
export function seedStatus(record: SeedRecord | null): {
  seed_id: string | null; finished_at: string | null; unseeded_gap_rows_total: number | null; storage: StorageReport | null;
} {
  return {
    seed_id: record?.seed_id ?? null, finished_at: record?.finished_at ?? null, unseeded_gap_rows_total: record?.unseeded_gap_rows_total ?? null,
    storage: storageReport(record?.storage),
  };
}

const RESEED_STEP = `A Rust store is seeded once. To seed again, start from a new shadow directory: ${RESEED_STEPS}.`;

async function seed(
  brain: { key: string; dir: string; engine: string }, f: Set<string>, deps: EngineShadowDeps,
  out: (l: string) => void, err: (l: string) => void, now: () => Date,
): Promise<number> {
  const json = f.has('--json');
  const existing = readSeedRecord(brain.dir);
  if (f.has('--reseed') || existing) {
    err(`engine shadow: ${existing ? `already seeded (${existing.seed_id}, finished ${existing.finished_at}). ` : ''}${RESEED_STEP}`);
    return 1;
  }
  if (readShadowState(brain.dir)?.enabled) {
    err('engine shadow: stop shadow mode first (gbrain engine shadow stop): its child holds the Rust store. Nothing was written.');
    return 1;
  }
  // The brain must open to be read; a brain that cannot be opened is an error, not a mode (nothing is written, no store is opened).
  let primary: BrainEngine;
  try {
    primary = await (deps.openPrimary ?? openConfiguredPrimary)();
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    err(`engine shadow: could not open the brain (${typeof code === 'string' && /^[a-z0-9_]{1,64}$/i.test(code) ? code : 'open_failed'}). ${code === 'pglite_busy' ? 'Stop `gbrain serve` and any other process holding this brain, then run the command again. ' : ''}Nothing was written.`);
    return 1;
  }
  try {
    return await seedFrom(primary, brain, json, deps, out, err, now);
  } finally {
    await primary.disconnect().catch(() => undefined);
  }
}

/** The rest of `seed` once the primary is open: the addon, the shadow directory, the store, the storage mode, the snapshot. */
async function seedFrom(
  primary: BrainEngine, brain: { key: string; dir: string; engine: string }, json: boolean, deps: EngineShadowDeps,
  out: (l: string) => void, err: (l: string) => void, now: () => Date,
): Promise<number> {
  const load = await (deps.loadAddon ?? (async () => {
    const { loadRustEngineAddon } = await import('../core/rust-engine/addon-loader.ts');
    return loadRustEngineAddon();
  }))();
  if (!load.ok) {
    err(`engine shadow: ${load.code} (${load.reason}): ${load.message}`);
    return 1;
  }
  mkdirSync(brain.dir, { recursive: true, mode: 0o700 });
  let store: SeedTarget & { close(): Promise<void> };
  try {
    store = await (deps.openStore ?? (async (addon, path) => {
      const { openRustStore } = await import('../core/rust-engine/store.ts');
      return openRustStore(addon, path);
    }))(load.addon, join(brain.dir, 'store'));
  } catch (e) {
    if ((e as { code?: unknown }).code === 'rust_store_locked') {
      err('engine shadow: stop shadow mode first (gbrain engine shadow stop, then wait 30 seconds): another process holds the Rust store. Nothing was written.');
      return 1;
    }
    throw e;
  }
  try {
    // Read right before the snapshot, outside its transaction: a failed read there would abort the snapshot. Never throws.
    const storage = await readManagedStorage(primary, now());
    const record = await runSeed(primary, store, {
      primaryEngine: brain.engine, now, storage,
      onBatch: json ? undefined : (relation, rows) => err(`  seeding ${relation}: ${rows} rows`),
    });
    const path = writeSeedRecord(brain.dir, record);
    if (json) out(JSON.stringify(record, null, 2));
    else renderSeed(record, path, out);
    return 0;
  } catch (e) {
    if (e instanceof SeedBudgetError) {
      err(`engine shadow: ${e.message}. The store holds a partial seed. ${RESEED_STEP}`);
      return 1;
    }
    if (e instanceof Error && /^shadow_seed: the store (holds seed|is not empty)/.test(e.message)) {
      err(`engine shadow: the Rust store already holds data (${e.message}). ${RESEED_STEP}`);
      return 1;
    }
    throw e;
  } finally {
    await store.close().catch(() => undefined);
  }
}

/** One full reconcile pass from the CLI, through a child that holds the Rust store. */
async function reconcileCommand(
  brain: { key: string; dir: string }, json: boolean, deps: EngineShadowDeps, out: (l: string) => void, err: (l: string) => void,
): Promise<number> {
  const seeded = readSeedRecord(brain.dir);
  if (seeded?.digests !== true) { err(seeded ? `engine shadow: this seed was written before follow existed, so reconcile cannot guard its rows. Reseed: ${RESEED_STEPS}.` : 'engine shadow: reconcile needs a seeded store. Run gbrain engine shadow seed first.'); return 1; }
  const [{ Reconciler }, { ShadowSupervisor }, { shadowChildArgv }, { openReadSource }] = await Promise.all([
    import('../shadow/reconcile.ts'), import('../shadow/supervisor.ts'), import('../shadow/attach.ts'), import('../shadow/read-pool.ts'),
  ]);
  const primary = await (deps.openPrimary ?? openConfiguredPrimary)();
  const supervisor = new ShadowSupervisor({ dir: brain.dir, argv: shadowChildArgv(brain.dir), stillEnabled: () => true, ...deps.reconcileSupervisor });
  const reads = openReadSource(primary);
  try {
    const reconciler = new Reconciler({ dir: brain.dir, reads, rpc: (method, args, timeoutMs) => supervisor.request(method, args, timeoutMs) });
    const pass = await reconciler.run('full');
    if (json) out(JSON.stringify(pass, null, 2));
    else {
      out(`Reconcile ${pass.id}: ${pass.error ? `failed (${pass.error})` : `repaired ${pass.repaired_rows} rows, follower misses ${pass.follower_misses}`}.`);
      for (const [relation, n] of Object.entries(pass.repaired_by_relation)) out(`  ${relation}: ${n}`);
    }
    if (/not_owner|store_closed|rust_store_locked/.test(pass.error ?? '')) err('engine shadow: another process holds the Rust store. Stop it (or the serving process) and run reconcile again.');
    return pass.error ? 1 : 0;
  } finally {
    supervisor.stop();
    await reads.close();
    await primary.disconnect();
  }
}

async function openConfiguredPrimary(): Promise<BrainEngine> {
  const { toEngineConfig } = await import('../core/config.ts');
  const { constructEngine } = await import('../core/engine-construct.ts');
  const cfg = loadConfig();
  if (!cfg) throw new UsageError('No brain is configured here.');
  const config = toEngineConfig(cfg);
  // PGLite runs initdb on a missing or uninitialized directory when it connects; a seed must not make a brain.
  if (!config.database_url && (!config.database_path || !existsSync(join(config.database_path, 'PG_VERSION')))) {
    throw Object.assign(new Error(`no brain exists at ${config.database_path ?? '(no path configured)'}`), { code: 'no_brain' });
  }
  const engine = await constructEngine(config);
  // Only a local brain (PGLite) has this open: no recording of its managed roots (that writes ownership markers into the
  // datastore and source checkouts) and, with repair off, no repair of a damaged log (that renames the primary's files).
  const quiet = (engine as unknown as { connectForRestore?: (c: EngineConfig, o?: { keepRepairEpisode?: boolean }) => Promise<void> }).connectForRestore?.bind(engine);
  if (!quiet) {
    await engine.connect(config);
    return engine;
  }
  // A healthy open also closes an open repair episode and prunes older repair backups; a seed must not, so it leaves that brain unopened.
  const { readRepairSidecar } = await import('../core/pglite-repair.ts');
  if (readRepairSidecar(config.database_path!).episodeStartedAt !== null) {
    throw Object.assign(new Error('a repair episode is open on this brain; opening it would close the episode and prune its backups'), { code: 'repair_episode_open' });
  }
  const savedRepair = process.env.GBRAIN_PGLITE_WAL_REPAIR;
  process.env.GBRAIN_PGLITE_WAL_REPAIR = 'off';
  try {
    // The check above runs before the open takes the datastore lock; an episode recorded while it waits is still kept.
    await quiet(config, { keepRepairEpisode: true });
  } finally {
    if (savedRepair === undefined) delete process.env.GBRAIN_PGLITE_WAL_REPAIR;
    else process.env.GBRAIN_PGLITE_WAL_REPAIR = savedRepair;
  }
  return engine;
}

function renderSeed(r: SeedRecord, path: string, out: (l: string) => void): void {
  const rows = Object.values(r.relations).reduce((a, x) => a + x.imported, 0);
  out(`Seeded the Rust store from brain ${r.primary_engine} (${r.seed_id}): ${rows} rows in ${Object.keys(r.relations).length} relations.`);
  out(`  finished ${r.finished_at}; wrote ${path}`);
  const storage = storageLine(r.storage);
  if (storage) out(`  storage: ${storage}`);
  const values = Object.entries(r.losses.values);
  if (values.length) out(`  values not kept: ${values.map(([k, n]) => `${k} ${n}`).join(', ')}`);
  for (const [rel, x] of Object.entries(r.relations)) if (x.unmapped_columns.length) out(`  ${rel}: columns not kept: ${x.unmapped_columns.join(', ')}`);
  const lost = r.losses.not_copied.filter(n => n.rows > 0);
  for (const n of lost) out(`  not copied (${n.kind}): ${n.table} ${n.rows} rows; ${n.read}`);
  out(`  unfinished jobs not copied: ${r.non_terminal_jobs}; segmented pages read as shells: ${r.segmented_pages}`);
  const gaps = Object.entries(r.unseeded_gap_rows).filter(([, n]) => n > 0);
  out(gaps.length
    ? `  unseeded gap rows: ${r.unseeded_gap_rows_total} (${gaps.map(([g, n]) => `${g} ${n}`).join(', ')}); a swap is refused while any remain`
    : '  unseeded gap rows: 0');
}

function stop(brain: { key: string; dir: string }, del: boolean, out: (l: string) => void, now: () => Date): number {
  const state = readShadowState(brain.dir);
  if (state?.enabled) writeShadowState(brain.dir, { ...state, enabled: false, stopped_at: now().toISOString() });
  if (del) {
    rmSync(brain.dir, { recursive: true, force: true });
    out(`Shadow mode is off for brain ${brain.key}; ${brain.dir} is deleted.`);
  } else {
    out(state?.enabled ? `Shadow mode is off for brain ${brain.key}. Running processes stop mirroring within 30 seconds.` : `Shadow mode was already off for brain ${brain.key}.`);
  }
  return 0;
}

function report(brain: { key: string; dir: string }, json: boolean, out: (l: string) => void, now: () => Date): number {
  const r = buildProvisionalReport(brain.dir, brain.key, readShadowState(brain.dir), now());
  if (existsSync(brain.dir)) {
    const paths = writeProvisionalReport(brain.dir, r);
    if (!json) out(`Wrote ${paths.markdown} and ${paths.json}.\n`);
  }
  out(json ? JSON.stringify(r, null, 2) : renderProvisionalMarkdown(r));
  return 0;
}
