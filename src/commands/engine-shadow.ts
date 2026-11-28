/**
 * `gbrain engine shadow start|status|stop|report|seed` (plan PR S1, the read half of S2 and the seed of S3).
 *
 * Shadow mode mirrors a sample of the host brain's reads to the Rust engine in a supervised child process and
 * records whether the answers agree. It is off by default. Its only writes to the brain database are the swap-eligibility
 * writer evidence (engine_writer_observations, and on Postgres the hooks and engine_writer_sessions / _coverage_gaps);
 * it never writes brain content, the config table or the brain repo, and every other file lives in `<gbrain home>/shadow/<brain>/`. `start` previews a plan with a hash
 * and needs `--yes --expect <hash>`; the installed addon is loaded then, in the foreground. Shadow mode gathers evidence on
 * managed-storage brains too; only the swap refuses them. `start` opens the brain once, best-effort, to read its storage
 * mode, reports a brain that cannot swap, records the mode in state.json, and never refuses over it. The
 * hidden `__child <dir>` is the child the serving process spawns. `seed` copies the brain into the Rust store
 * once, in one read-only snapshot, and writes `seed.json` (src/shadow/seed.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../core/config.ts';
import type { EngineConfig } from '../core/types.ts';
import type { BrainEngine } from '../core/engine.ts';
import { OperationError } from '../core/ops/contract.ts';
import type { RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { buildBenchStatus, renderBenchStatus } from '../shadow/bench.ts';
import { BENCH_DOCS, importBenchReceipt, sanitizeText } from '../shadow/bench-receipt.ts';
import type { DrillDeps, DrillReason } from '../shadow/drill.ts';
import type { FetchDeps } from '../shadow/eval-gates.ts';
import { renderEvidenceStatus } from '../shadow/evidence.ts';
import { renderFollowStatus } from '../shadow/follow-status.ts';
import { readManagedStorage, storageLine, type ManagedStorageRecord } from '../shadow/managed-gate.ts';
import { readSeedRecord, RESEED_STEPS, runSeed, SeedBudgetError, writeSeedRecord, type SeedRecord, type SeedTarget } from '../shadow/seed.ts';
import { seedStatus, shadowStatusDocument } from '../shadow/status-document.ts';
import { installWriterHooks, primaryTakesWriterHooks, removeWriterHooks } from '../shadow/writer-hooks.ts';
import { buildProvisionalReport, renderProvisionalMarkdown, writeProvisionalReport } from '../shadow/report.ts';
import {
  brainIdentity, DEFAULT_SHADOW_QUEUE_BOUND, DEFAULT_SHADOW_SAMPLE_RATE, DEFAULT_SHADOW_WRITE_SAMPLE_RATE, readShadowState, writeSampleRate, shadowBrainKey, shadowDirFor, shadowStatePath,
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
  /** Test seam: runs after the writer hooks are installed and before the new state is written. */
  afterHooks?: () => void;
  now?: () => Date;
  /** The `__child` loop; default runShadowChild on stdin/stdout. */
  runChild?: (dir: string) => Promise<number>;
  /** The connected primary brain `seed` reads and `start` opens to read its storage mode (closed after); default the configured brain, opened without shadow mode. */
  openPrimary?: () => Promise<BrainEngine>;
  /** Test seam for `reconcile`: the supervisor options (argv, spawn) of the child that holds the Rust store. */
  reconcileSupervisor?: Partial<import('../shadow/supervisor.ts').ShadowSupervisorOptions>;
  /** Opens the Rust store `seed` writes; default openRustStore on the loaded addon at `<dir>/store`. */
  openStore?: (addon: object, storePath: string) => Promise<SeedTarget & { close(): Promise<void> }>;
  /** Test seams for `drill`: the owner, verifier and clock of the restore drill, and the HTTP of the eval-gates fetch. */
  drill?: DrillDeps;
  fetchEvals?: Partial<FetchDeps>;
}

const HELP = `gbrain engine shadow — compare the Rust engine against this brain's reads, off the request path

Usage:
  gbrain engine shadow start [--plan] [--sample-rate <0..1>] [--write-sample-rate <0..1>] [--queue-bound <n>]
  gbrain engine shadow start --yes --expect <plan_hash> [--sample-rate <0..1>] [--write-sample-rate <0..1>] [--queue-bound <n>]
  gbrain engine shadow status [--json]
  gbrain engine shadow stop [--delete]
  gbrain engine shadow report [--json]
  gbrain engine shadow seed [--json] [--reseed]
  gbrain engine shadow reconcile [--full] [--json]
  gbrain engine shadow capture on --yes | off | status [--json] | delete --yes
  gbrain engine shadow replay [--json] [--budget-minutes <n>]
  gbrain engine shadow bench --import <receipt.json> [--json]
  gbrain engine shadow drill [--backup] [--evals] [--json]

Shadow mode is off by default. When on, a sample of reads this brain answers is sent, after the answer, to a
supervised child process that runs the same read on the Rust engine and records match, diff or why it could not
compare. The primary answer never waits for the child. Its only write to the brain database is one row per writing
process in engine_writer_observations (host id, connection name, command kind, version, first and last write time), at
most every 10 minutes, which the swap's eligibility check reads. On a Postgres brain, start also adds one trigger to
every brain table that notes which connections write (engine_writer_sessions; it never fails a write and waits at most 50 ms on its own tables), and
stop removes them. It writes nothing to the brain config or the brain repo; everything else lives in
<gbrain home>/shadow/<brain>/. stop --delete removes that directory.

start runs on a brain that uses managed storage too; only the swap refuses such a brain. start opens the brain
database once to read its storage mode, even with --plan, prints a line when the brain cannot swap, and records the mode
in state.json. A brain whose mode cannot be read is not refused: the mode is recorded as unread.

seed copies this brain into the Rust store once, in one read-only snapshot, before shadow mode compares answers.
It writes no table row, source file, ownership marker or registry entry of the brain. Opening a PGLite brain still
takes its process lock, and PGLite rewrites its own control and log files. A brain with an open repair episode is not
opened. A store is seeded once: to seed again, delete the shadow directory first.
seed runs on a brain that uses managed storage too; only the swap refuses such a brain. seed reads the brain's storage
mode right before its snapshot and records it in seed.json; a mode it cannot read does not stop the seed.
A brain that cannot be opened stops the seed: exit 1, \`could not open the brain (pglite_busy)\` while another process
holds a PGLite brain, and nothing is written.

A seeded brain is followed: each committed write is read back from the brain and applied to the Rust store. reconcile
compares the whole store with the brain (digests per 500-row interval) and repairs what differs; it needs the Rust
store to be free, so run it when no serving process holds it. Plain reconcile and --full both run a full pass. status
shows the follower's lag and coverage, the last pass, fingerprint checks and the allocator check; the fingerprint and
comparison counts are totals for the current seed.

capture records every engine call (reads and writes) into owner-only files on this machine; it is off by default
(docs/guides/shadow-capture.md). replay plays each night's recording on private PGLite and Rust copies and compares
them (docs/guides/shadow-replay.md).

drill copies the shadow's own Rust store at one moment through its owner, checks the copy without opening it normally, opens
it once, deletes the copy and records the result (swap criterion 10, restore drill). It never pauses the shadow. --evals
instead downloads the eval-gates file pinned to this shadow's release, checks its SHA-256 and keeps a copy; status and the
swap only read that copy and never fetch. With neither flag both run.

The report is provisional and always says NOT READY.`;

class UsageError extends Error {}

interface StartOpts { plan: boolean; yes: boolean; expect: string | null; sampleRate: number; writeSampleRate: number; queueBound: number }

function parseStart(args: string[]): StartOpts {
  const o: StartOpts = { plan: false, yes: false, expect: null, sampleRate: DEFAULT_SHADOW_SAMPLE_RATE, writeSampleRate: DEFAULT_SHADOW_WRITE_SAMPLE_RATE, queueBound: DEFAULT_SHADOW_QUEUE_BOUND };
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
    } else if (a === '--write-sample-rate') {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0 || n > 1) throw new UsageError('--write-sample-rate must be a number above 0 and at most 1');
      o.writeSampleRate = n;
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
  /** Share of page and link writes compared on a scratch Rust store (write-compare.ts). */
  write_sample_rate: number;
  queue_bound: number;
  mirrors: string;
  writes: string[];
  never_writes: string[];
}

export function shadowPlan(brain: string, primaryEngine: string, dir: string, o: Pick<StartOpts, 'sampleRate' | 'queueBound'> & Partial<Pick<StartOpts, 'writeSampleRate'>>): { plan: ShadowPlan; hash: string } {
  const plan: ShadowPlan = {
    brain, primary_engine: primaryEngine, directory: dir, sample_rate: o.sampleRate, write_sample_rate: o.writeSampleRate ?? DEFAULT_SHADOW_WRITE_SAMPLE_RATE, queue_bound: o.queueBound,
    mirrors: 'a sample of reads and searches this brain answers, after the answer; none inside a transaction',
    writes: [`${dir}/state.json`, `${dir}/store (the Rust engine's own store)`, `${dir}/ledger, summaries, faults.jsonl, reports, child.log`,
      'the brain database: one row per writing process in engine_writer_observations, at most every 10 minutes (swap eligibility)',
      ...(primaryTakesWriterHooks(primaryEngine) ? [
        'the brain database: one statement-level trigger (gbrain_writer_note) on every brain table while shadow mode is on, removed by stop; each records the writing connection in engine_writer_sessions at most every 10 minutes per connection, never fails the write and waits at most 50 ms on its own tables (an error becomes a row in engine_writer_coverage_gaps), and takes a short lock on each table when it is added or removed',
        `${dir}/writer-hooks.json (which tables were hooked, written before the first trigger)`,
      ] : [])],
    never_writes: ['brain content (pages, chunks, facts, links)', 'the brain config table', 'the brain repo'],
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
    if (sub === 'capture') {
      const { runShadowCaptureCommand } = await import('./engine-shadow-capture.ts');
      return await runShadowCaptureCommand(rest, { out, err, now, brain: await resolveBrain(deps) });
    }
    if (sub === 'replay' || sub === '__replay-child') {
      const { runShadowReplayCommand } = await import('./engine-shadow-replay.ts');
      const brain = sub === '__replay-child' ? { key: '', dir: '', engine: '' } : await resolveBrain(deps);
      return await runShadowReplayCommand(sub, rest, { out, err, now, brain, config: deps.config ?? (() => loadConfig()), openPrimary: deps.openPrimary ?? openConfiguredPrimary });
    }
    if (sub === 'bench') return await bench(rest, deps, out, err, now);
    const brain = await resolveBrain(deps);
    if (sub === 'start') return await start(brain, parseStart(rest), deps, out, err, now);
    if (sub === 'status') return await status(brain, flags(rest, ['--json'], 'status').has('--json'), out, now);
    if (sub === 'stop') return await stopWithDrillLock(brain, flags(rest, ['--delete'], 'stop').has('--delete'), deps, out, err, now);
    if (sub === 'report') return report(brain, flags(rest, ['--json'], 'report').has('--json'), out, now);
    if (sub === 'seed') return await seed(brain, flags(rest, ['--json', '--reseed'], 'seed'), deps, out, err, now);
    if (sub === 'drill') return await drillCommand(brain, flags(rest, ['--json', '--backup', '--evals'], 'drill'), deps, out, err);
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
    out(`  write sample rate ${plan.write_sample_rate}: that share of page and link writes is checked on a throwaway Rust store (a write inside a transaction is not checked, and a PGLite brain samples no writes); a checked write first waits (at most 2 s) for one read of the rows it touches`);
    for (const w of plan.writes) out(`  writes: ${w}`);
    out(`  never writes: ${plan.never_writes.join(', ')}`);
    const line = storageLine(await readStorage(brain, deps, now));
    if (line) out(`  storage: ${line}`);
    out(`  the installed Rust engine addon is loaded and verified now`);
    out(`plan_hash: ${hash}`);
    out(`To turn it on: gbrain engine shadow start --yes --expect ${hash}${o.sampleRate !== DEFAULT_SHADOW_SAMPLE_RATE ? ` --sample-rate ${o.sampleRate}` : ''}${o.writeSampleRate !== DEFAULT_SHADOW_WRITE_SAMPLE_RATE ? ` --write-sample-rate ${o.writeSampleRate}` : ''}${o.queueBound !== DEFAULT_SHADOW_QUEUE_BOUND ? ` --queue-bound ${o.queueBound}` : ''}`);
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
  // The writer-evidence epoch: this seed's first start. A restart keeps it, so evidence already gathered stays in the window.
  // `stop` records a gap row when it removes the hooks (nothing recorded writers after that), so a restart after it still refuses.
  const prior = readShadowState(brain.dir);
  const seed = readSeedRecord(brain.dir);
  const seedId = seed?.seed_id ?? null;
  const sameEpoch = prior?.writer_evidence_since !== undefined && (prior.writer_evidence_seed ?? null) === seedId;
  // A state file written before the epoch fields existed names no seed: it is the same seed when that seed finished before
  // the state's own start (a reseed needs shadow mode off, so a later seed would have finished after it). Adopt its start as the
  // earliest known one, and treat a stopped legacy state as hooks that were off (an older stop recorded no gap).
  const priorStart = prior ? Date.parse(prior.started_at) : Number.NaN;
  const legacySame = prior !== null && prior.writer_evidence_since === undefined && Number.isFinite(priorStart)
    && (seed === null || (Number.isFinite(Date.parse(seed.finished_at)) && Date.parse(seed.finished_at) <= priorStart));
  const evidenceSince = sameEpoch ? prior!.writer_evidence_since! : legacySame ? prior!.started_at : now().toISOString();
  // A stop that ran with this code recorded its own gap in the removal transaction; a legacy stop did not.
  const hooksWereOff = legacySame && prior!.enabled === false;
  // Continuing an epoch is a coverage break criterion 11 cannot see inside (hooks were replaced or off), so it fails closed for the window.
  const continuing = sameEpoch || legacySame;
  if (continuing && prior) {
    // The restart marker goes into the state file BEFORE any hook is touched, so a start that dies after the hooks change cannot
    // leave a healthy-looking catalog with no trace. If it cannot be written, nothing was changed and the start stops.
    try { writeShadowState(brain.dir, { ...prior, writer_coverage_restarted_at: now().toISOString() }); } catch (e) {
      err(`engine shadow: state_unwritable (${typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'unknown'}): could not record the restart, so no hook was touched.`);
      return 3;
    }
  }
  if (primaryTakesWriterHooks(brain.engine)) {
    let primary: BrainEngine | null = null;
    try {
      primary = await (deps.openPrimary ?? openConfiguredPrimary)();
      const tables = await installWriterHooks(primary, brain.dir, hooksWereOff ? { gap: 'hooks_off_interval' } : {});
      out(`Hooked ${tables.length} brain tables to record which connections write (swap eligibility).`);
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      err(`engine shadow: writer_hooks_failed (${typeof code === 'string' ? code : 'unknown'}): could not hook the brain tables, so shadow mode stays off.`);
      err('Fix: run it again when no long transaction holds a brain table, as the database role that owns the brain tables. gbrain engine shadow stop removes any hook a failed start left.');
      return 3;
    } finally {
      await primary?.disconnect().catch(() => undefined);
    }
  }
  deps.afterHooks?.(); // test seam: a throw here stands for a start killed after the hooks changed and before the state is published
  const state: ShadowState = {
    version: SHADOW_STATE_VERSION, enabled: true, started_at: now().toISOString(), sample_rate: o.sampleRate, write_sample_rate: o.writeSampleRate,
    queue_bound: o.queueBound, plan_hash: hash, brain: brain.key, primary_engine: brain.engine, storage,
    writer_evidence_since: evidenceSince, writer_evidence_seed: seedId,
    ...(continuing ? { writer_coverage_restarted_at: now().toISOString() } : {}),
    ...(continuing && prior?.writer_coverage_stopped_at ? { writer_coverage_stopped_at: prior.writer_coverage_stopped_at } : {}),
  };
  writeShadowState(brain.dir, state);
  out(`Shadow mode is on for brain ${brain.key}. Processes that open this brain from now on mirror reads.`);
  const line = storageLine(storage);
  if (line) out(`storage: ${line}`);
  if (!readSeedRecord(brain.dir)) err('engine shadow: warning: the Rust store is not seeded, so most comparisons will differ. Stop shadow mode and run gbrain engine shadow seed first.');
  out('gbrain engine shadow status shows the counts; gbrain engine shadow stop turns it off.');
  return 0;
}

async function status(brain: { key: string; dir: string }, json: boolean, out: (l: string) => void, now: () => Date): Promise<number> {
  // No engine: status never opens the database, so the eligibility writer fields stay out (the swap passes its primary).
  const doc = await shadowStatusDocument(brain, now());
  if (json) {
    out(JSON.stringify(doc, null, 2));
    return 0;
  }
  const { state, totals, recent_faults: faults } = doc;
  out(`Shadow mode: ${state?.enabled ? 'on' : 'off'} (brain ${brain.key})`);
  if (state) out(`  started ${state.started_at}${state.stopped_at ? `, stopped ${state.stopped_at}` : ''}; sample rate ${state.sample_rate}, write sample rate ${writeSampleRate(state)}`);
  const line = storageLine(state?.storage);
  if (line) out(`  storage: ${line}`);
  const compared = Object.values(totals).reduce((a, b) => a + b, 0);
  out(`  comparisons: ${compared}${compared ? ` (${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  if (doc.serving) {
    const p = doc.serving;
    out(`  serving: offered ${p.offered}, sent ${p.sent}, sampled out ${p.sampled_out}, shed ${p.shed_queue_full + p.shed_too_large + p.shed_transport + p.shed_unmirrorable}, in transaction ${p.skipped_in_transaction}`);
  }
  const seeded = readSeedRecord(brain.dir);
  out(seeded ? `  seed ${seeded.seed_id} finished ${seeded.finished_at}; unseeded gap rows ${seeded.unseeded_gap_rows_total}` : '  seed: none (gbrain engine shadow seed)');
  const seedStorage = storageLine(seeded?.storage);
  if (seedStorage) out(`  storage: ${seedStorage}`);
  if (seeded) for (const line of [...renderFollowStatus(doc), ...renderEvidenceStatus(doc)]) out(line);
  if (doc.evidence_epoch_unstable) out('  evidence epoch: it changed while this status was read, so the epoch-bound evidence is left out; run the status again');
  for (const line of renderBenchStatus(doc.bench)) out(line);
  for (const f of faults) out(`  fault ${f.ts} ${f.kind}: ${f.detail}`);
  return 0;
}

/** The `seed` block of `status --json` (src/shadow/status-document.ts). */
export { seedStatus };

const RESEED_STEP = `A Rust store is seeded once. To seed again, start from a new shadow directory: ${RESEED_STEPS}.`;

const BENCH_IMPORT_FIX = 'gbrain engine shadow bench --import <receipt.json> [--json]';

function benchRefusal(code: 'invalid_params' | 'not_found' | 'internal_error', message: string, fix: string): OperationError {
  return new OperationError(code, message, fix, BENCH_DOCS);
}

/** The refusal of `bench`: stderr text with the safe fix, and with --json the error envelope on stdout; the exit code is the registered code's. */
async function refuseBench(e: OperationError, json: boolean, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const { renderCliError } = await import('../core/agent-output.ts');
  const r = renderCliError(e, { json: true, command: 'engine shadow bench', tty: false });
  if (json) out(r.stdout!.trimEnd());
  err(`engine shadow bench: ${e.message} [${e.code}${e.docs ? `; ${e.docs}` : ''}]`);
  if (e.suggestion) err(`Fix: ${e.suggestion}`);
  return r.exitCode;
}

/**
 * `bench --import <receipt>`: loads an engine-bench speed receipt into the shadow's swap-readiness evidence (criterion 8,
 * reported and never gating). Replaying paired samples on this brain is not built, so plain `bench` refuses and says so.
 * The import never starts a shadow and never opens the brain; with no shadow for this brain nothing is written.
 */
async function bench(args: string[], deps: EngineShadowDeps, out: (l: string) => void, err: (l: string) => void, now: () => Date): Promise<number> {
  const json = args.includes('--json');
  try {
    let path: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--json') continue;
      if (a !== '--import') return await refuseBench(benchRefusal('invalid_params', `unknown argument for engine shadow bench: ${sanitizeText(a, 60)}`, BENCH_IMPORT_FIX), json, out, err);
      path = args[i + 1];
      if (!path || path.startsWith('--')) return await refuseBench(benchRefusal('invalid_params', '--import needs the path of an engine-bench speed receipt', BENCH_IMPORT_FIX), json, out, err);
      i++;
    }
    if (!path) {
      return await refuseBench(benchRefusal('invalid_params', 'nothing to import: the owner-brain bench (gbrain engine shadow bench replaying paired samples on this brain) is not built, and --import loads an engine-bench speed receipt', BENCH_IMPORT_FIX), json, out, err);
    }
    let brain: { key: string; dir: string; engine: string };
    try {
      brain = await resolveBrain(deps);
    } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      return await refuseBench(benchRefusal('invalid_params', `${sanitizeText(e.message, 300)} Nothing was written.`, 'Run it without --brain (and with GBRAIN_BRAIN_ID unset) on a host with a configured brain.'), json, out, err);
    }
    if (!existsSync(shadowStatePath(brain.dir))) {
      return await refuseBench(benchRefusal('not_found', 'no shadow for this brain, so there is nowhere to keep bench evidence; nothing was written', 'Ask the brain owner whether to start a shadow (gbrain engine shadow start --plan shows the plan). A bench import never starts one; once the owner has one, rerun the same import.'), json, out, err);
    }
    const res = importBenchReceipt(brain.dir, path, { now: now() });
    if (!res.ok) return await refuseBench(res.error, json, out, err);
    const { bench: block } = buildBenchStatus({ dir: brain.dir, primaryEngine: readShadowState(brain.dir)?.primary_engine ?? null });
    if (json) out(JSON.stringify(block, null, 2));
    else {
      out(`Imported ${res.summary.source_file} (receipt ${res.summary.receipt_sha256.slice(0, 12)}) as the bench corpus evidence for brain ${brain.key}. Nothing else was changed.`);
      for (const line of renderBenchStatus(block)) out(line);
    }
    return 0;
  } catch (e) {
    if (e instanceof OperationError) return await refuseBench(e, json, out, err);
    const name = e instanceof Error ? e.name : 'Error';
    return await refuseBench(benchRefusal('internal_error', `unexpected ${name} while importing the receipt: ${sanitizeText(e instanceof Error ? e.message : e, 160)}; nothing else was changed`, 'Rerun the same command once with --json; if it fails again, report it with the command and this message.'), json, out, err);
  }
}

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

const DRILL_FIX: Partial<Record<DrillReason, string>> = {
  no_seed: 'Run gbrain engine shadow seed first.',
  no_epoch: 'Start shadow mode (gbrain engine shadow start) and let its child run once, so the evidence epoch exists.',
  no_store: 'The shadow has no Rust store; run gbrain engine shadow seed.',
  addon_unavailable: 'The Rust engine addon is not installed; run gbrain doctor.',
  disk_space: 'Free disk space: the drill needs twice the store file plus 2 GiB.',
  drill_running: 'Another drill is running; wait for it to end. If none is, remove drills/drill.lock (one that cannot be read) or drills/drill.lock.takeover (left by a crash).',
  addon_mismatch: 'The addon this command loaded is not the one the evidence epoch started on; run the drill with the same addon the shadow child runs (the installed addon, or the same GBRAIN_RUST_ENGINE_ADDON).',
  no_probe_term: 'No stored word got a keyword hit on the copy; check gbrain doctor and the shadow store, then run the drill again.',
  shadow_gone: 'The shadow directory was deleted or replaced while the drill ran; nothing was recorded.',
  cleanup_pending: 'A copy from an earlier drill is still ending; run the drill again in a minute.',
};

/** `drill`: the restore drill on the shadow store (`--backup`) and the eval-gates fetch (`--evals`); both without a flag. */
async function drillCommand(
  brain: { key: string; dir: string }, f: Set<string>, deps: EngineShadowDeps, out: (l: string) => void, err: (l: string) => void,
): Promise<number> {
  const [{ renderDrill, runBackupDrill }, { fetchEvalGates }, { readEpoch }] = await Promise.all([
    import('../shadow/drill.ts'), import('../shadow/eval-gates.ts'), import('../shadow/evidence-epoch.ts'),
  ]);
  const json = f.has('--json');
  const both = !f.has('--backup') && !f.has('--evals');
  const result: Record<string, unknown> = {};
  let ok = true;
  if (both || f.has('--backup')) {
    const abort = new AbortController();
    const onSignal = (): void => abort.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      const record = await runBackupDrill(brain.dir, { signal: abort.signal, ...deps.drill });
      result.backup = record;
      ok = ok && record.pass;
      if (record.op_id === null && record.reason) err(`engine shadow: shadow_drill_failed (${record.reason}): ${DRILL_FIX[record.reason] ?? 'see gbrain doctor'}`);
      else if (!json) for (const line of renderDrill(record)) out(line);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
  if (both || f.has('--evals')) {
    const { detectAddonTarget } = await import('../core/rust-engine/addon-target.ts');
    const fetched = await fetchEvalGates(brain.dir, readEpoch(brain.dir), { hostTarget: detectAddonTarget(), ...deps.fetchEvals });
    result.evals = fetched;
    ok = ok && fetched.passed;
    if (!json) out(fetched.passed ? 'Eval gates E1 to E3: pass (cached under drills/)' : `Eval gates E1 to E3: not a pass (${fetched.reason ?? 'unknown'})${fetched.cached ? '; the file was cached' : '; nothing was cached'}`);
  }
  if (json) out(JSON.stringify(result, null, 2));
  return ok ? 0 : 1;
}

/** One full reconcile pass from the CLI, through a child that holds the Rust store. */
async function reconcileCommand(
  brain: { key: string; dir: string }, json: boolean, deps: EngineShadowDeps, out: (l: string) => void, err: (l: string) => void,
): Promise<number> {
  const seeded = readSeedRecord(brain.dir);
  if (seeded?.digests !== true) { err(seeded ? `engine shadow: this seed was written before follow existed, so reconcile cannot guard its rows. Reseed: ${RESEED_STEPS}.` : 'engine shadow: reconcile needs a seeded store. Run gbrain engine shadow seed first.'); return 1; }
  const [{ Reconciler }, { ShadowSupervisor }, { shadowChildArgv }, { openReadSource }, { sealMark, readBasis }, { primaryTakesWriterHooks }] = await Promise.all([
    import('../shadow/reconcile.ts'), import('../shadow/supervisor.ts'), import('../shadow/attach.ts'), import('../shadow/read-pool.ts'),
    import('../shadow/seal.ts'), import('../shadow/writer-hooks.ts'),
  ]);
  const primary = await (deps.openPrimary ?? openConfiguredPrimary)();
  const supervisor = new ShadowSupervisor({ dir: brain.dir, argv: shadowChildArgv(brain.dir), stillEnabled: () => true, ...deps.reconcileSupervisor });
  const reads = openReadSource(primary);
  try {
    const sealDeps = { dir: brain.dir, reads, postgres: primaryTakesWriterHooks(readShadowState(brain.dir)?.primary_engine) };
    // The pass's basis (seal.ts): handed over only once its watermark restore was acknowledged; it is what the seal carries.
    let basis: string | null = null;
    const reconciler = new Reconciler({
      dir: brain.dir, reads, rpc: (method, args, timeoutMs) => supervisor.request(method, args, timeoutMs),
      basis: () => readBasis(sealDeps), onBasis: (token) => { basis = token; },
    });
    const pass = await reconciler.run('full');
    if (json) out(JSON.stringify(pass, null, 2));
    else {
      out(`Reconcile ${pass.id}: ${pass.error ? `failed (${pass.error})` : `repaired ${pass.repaired_rows} rows, follower misses ${pass.follower_misses}`}.`);
      for (const [relation, n] of Object.entries(pass.repaired_by_relation)) out(`  ${relation}: ${n}`);
    }
    if (/not_owner|store_closed|rust_store_locked/.test(pass.error ?? '')) err('engine shadow: another process holds the Rust store. Stop it (or the serving process) and run reconcile again.');
    // A clean pass is sealed like a serving process's close (seal.ts), so the next session carries it on. This process
    // writes nothing to the primary; the child refuses the seal if its watermark or continuity does not hold.
    if (!pass.error && supervisor.childPid !== null) {
      const mark = await sealMark(sealDeps, basis).catch(() => ({ refused: 'read_failed' })); // silent-read-ok: a refusal means no seal, so the next session starts invalid
      if (supervisor.send(JSON.stringify('token' in mark ? { t: 'seal', db_at: mark.token } : { t: 'seal', db_at: null, refused: mark.refused }) + '\n')) await supervisor.drain();
    }
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

/** `stop`; with `--delete` it first takes the drill lock (made if no drill has run yet), so a delete never runs under a restore drill and no first drill starts under it: it refuses (exit 1) and changes nothing. The lock is held until the shadow is gone. */
async function stopWithDrillLock(brain: { key: string; dir: string; engine: string }, del: boolean, deps: EngineShadowDeps, out: (l: string) => void, err: (l: string) => void, now: () => Date): Promise<number> {
  if (!del) return stop(brain, del, deps, out, err, now);
  const done = (await import('../shadow/drill.ts')).takeDrillLockForDelete(brain.dir);
  if (!done) { err(`engine shadow: drill_running: ${DRILL_FIX.drill_running} Nothing was stopped or deleted.`); return 1; }
  let deleted = false;
  try { const code = await stop(brain, del, deps, out, err, now); deleted = true; return code; } finally { done(deleted); }
}

async function stop(brain: { key: string; dir: string; engine: string }, del: boolean, deps: EngineShadowDeps, out: (l: string) => void, err: (l: string) => void, now: () => Date): Promise<number> {
  const state = readShadowState(brain.dir);
  // The stop time is written before the hooks go: from here on nothing is proven to record writers (a file, so it cannot fail like a gap insert).
  if (state?.enabled) writeShadowState(brain.dir, { ...state, enabled: false, stopped_at: now().toISOString(), writer_coverage_stopped_at: now().toISOString() });
  else if (state && state.writer_coverage_stopped_at === undefined) writeShadowState(brain.dir, { ...state, writer_coverage_stopped_at: now().toISOString() });
  let hooksLeft = false;
  if (primaryTakesWriterHooks(brain.engine)) {
    let primary: BrainEngine | null = null;
    try {
      primary = await (deps.openPrimary ?? openConfiguredPrimary)();
      const removed = await removeWriterHooks(primary, brain.dir);
      if (removed > 0) out(`Removed the writer hooks from ${removed} brain tables.`);
    } catch (e) {
      hooksLeft = true;
      const code = (e as { code?: unknown })?.code;
      err(`engine shadow: writer_hooks_left (${typeof code === 'string' ? code : 'unknown'}): shadow mode is off, but the writer hooks could not be removed yet; they keep noting writers until they are.`);
      err('Fix: run gbrain engine shadow stop again when the brain database is reachable.');
    } finally {
      await primary?.disconnect().catch(() => undefined);
    }
  }
  if (del) {
    // One destructive-delete path with `capture delete`: the replay lock first, then the folder.
    const { deleteReplayState } = await import('../shadow/capture-lock.ts');
    deleteReplayState(brain.dir, { whole: true, keep: ['drills'] }); // the drill lock lives in drills/: `stopWithDrillLock` removes it last
    out(`Shadow mode is off for brain ${brain.key}; ${brain.dir} is deleted.`);
  } else {
    out(state?.enabled ? `Shadow mode is off for brain ${brain.key}. Running processes stop mirroring within 30 seconds.` : `Shadow mode was already off for brain ${brain.key}.`);
  }
  return hooksLeft ? 1 : 0;
}
/** Test seam: `stop` with no primary (a PGLite brain takes no writer hooks). */
export const __stopForTests = (brain: { key: string; dir: string; engine: string }, del: boolean, out: (l: string) => void) => stopWithDrillLock(brain, del, {}, out, out, () => new Date());

function report(brain: { key: string; dir: string }, json: boolean, out: (l: string) => void, now: () => Date): number {
  const r = buildProvisionalReport(brain.dir, brain.key, readShadowState(brain.dir), now());
  if (existsSync(brain.dir)) {
    const paths = writeProvisionalReport(brain.dir, r);
    if (!json) out(`Wrote ${paths.markdown} and ${paths.json}.\n`);
  }
  out(json ? JSON.stringify(r, null, 2) : renderProvisionalMarkdown(r));
  return 0;
}
