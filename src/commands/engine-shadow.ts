/**
 * `gbrain engine shadow start|status|stop|report|seed` (plan PR S1, the read half of S2 and the seed of S3).
 *
 * Shadow mode mirrors a sample of the host brain's reads to the Rust engine in a supervised child process and
 * records whether the answers agree. It is off by default and writes nothing to the brain database, its config
 * table or the brain repo: every file lives in `<gbrain home>/shadow/<brain>/`. `start` previews a plan with a hash
 * and needs `--yes --expect <hash>`; the installed addon is loaded then, in the foreground. The
 * hidden `__child <dir>` is the child the serving process spawns. `seed` copies the brain into the Rust store
 * once, in one read-only snapshot, and writes `seed.json` (src/shadow/seed.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../core/config.ts';
import type { EngineConfig } from '../core/types.ts';
import type { BrainEngine } from '../core/engine.ts';
import { OperationError } from '../core/ops/contract.ts';
import type { RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { buildBenchStatus, renderBenchStatus } from '../shadow/bench.ts';
import { BENCH_DOCS, importBenchReceipt, sanitizeText } from '../shadow/bench-receipt.ts';
import { shadowStatusDocument } from '../shadow/status-document.ts';
import { renderEvidenceStatus } from '../shadow/evidence.ts';
import { renderFollowStatus } from '../shadow/follow-status.ts';
import { readSeedRecord, runSeed, SeedBudgetError, writeSeedRecord, type SeedRecord, type SeedTarget } from '../shadow/seed.ts';
import { buildProvisionalReport, renderProvisionalMarkdown, writeProvisionalReport } from '../shadow/report.ts';
import {
  brainIdentity, DEFAULT_SHADOW_QUEUE_BOUND, DEFAULT_SHADOW_SAMPLE_RATE, readShadowState, shadowBrainKey, shadowDirFor, shadowStatePath,
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
  /** The connected primary brain `seed` reads; default the configured brain, opened without shadow mode. */
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
  gbrain engine shadow bench --import <receipt.json> [--json]

Shadow mode is off by default. When on, a sample of reads this brain answers is sent, after the answer, to a
supervised child process that runs the same read on the Rust engine and records match, diff or why it could not
compare. The primary answer never waits for the child. It writes nothing to the brain database, its config or the
brain repo; everything lives in <gbrain home>/shadow/<brain>/. stop --delete removes that directory.

seed copies this brain into the Rust store once, in one read-only snapshot, before shadow mode compares answers.
It writes nothing to the brain. A store is seeded once: to seed again, delete the shadow directory first.
A brain that uses managed storage is refused (exit 3): the Rust engine never holds managed storage, so seeding it
copies data nothing can use. seed checks that first and writes nothing when it refuses.

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

async function resolveBrain(deps: EngineShadowDeps): Promise<{ key: string; dir: string; engine: string }> {
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
  return { key, dir: shadowDirFor(key), engine: id.engine };
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
        const { runShadowChild } = await import('../shadow/child.ts');
        await runShadowChild(d, { input: process.stdin, writeControl: (s) => { process.stdout.write(s); } });
        return 0;
      });
      return await run(dir);
    }
    if (sub === 'bench') return await bench(rest, deps, out, err, now);
    const brain = await resolveBrain(deps);
    if (sub === 'start') return await start(brain, parseStart(rest), deps, out, err, now);
    if (sub === 'status') return status(brain, flags(rest, ['--json'], 'status').has('--json'), out, now);
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

async function start(
  brain: { key: string; dir: string; engine: string }, o: StartOpts, deps: EngineShadowDeps,
  out: (l: string) => void, err: (l: string) => void, now: () => Date,
): Promise<number> {
  const { plan, hash } = shadowPlan(brain.key, brain.engine, brain.dir, o);
  if (o.plan || !o.yes) {
    out(`Shadow mode plan for brain ${plan.brain} (${plan.primary_engine}):`);
    out(`  mirrors: ${plan.mirrors}`);
    out(`  sample rate ${plan.sample_rate}, serving-process queue bound ${plan.queue_bound}`);
    for (const w of plan.writes) out(`  writes: ${w}`);
    out(`  never writes: ${plan.never_writes.join(', ')}`);
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
  mkdirSync(brain.dir, { recursive: true, mode: 0o700 });
  const state: ShadowState = {
    version: SHADOW_STATE_VERSION, enabled: true, started_at: now().toISOString(), sample_rate: o.sampleRate,
    queue_bound: o.queueBound, plan_hash: hash, brain: brain.key, primary_engine: brain.engine,
  };
  writeShadowState(brain.dir, state);
  out(`Shadow mode is on for brain ${brain.key}. Processes that open this brain from now on mirror reads.`);
  if (!readSeedRecord(brain.dir)) err('engine shadow: warning: the Rust store is not seeded, so most comparisons will differ. Stop shadow mode and run gbrain engine shadow seed first.');
  out('gbrain engine shadow status shows the counts; gbrain engine shadow stop turns it off.');
  return 0;
}

function status(brain: { key: string; dir: string }, json: boolean, out: (l: string) => void, now: () => Date): number {
  const doc = shadowStatusDocument(brain, now());
  if (json) {
    out(JSON.stringify(doc, null, 2));
    return 0;
  }
  const { state, totals, recent_faults: faults } = doc;
  out(`Shadow mode: ${state?.enabled ? 'on' : 'off'} (brain ${brain.key})`);
  if (state) out(`  started ${state.started_at}${state.stopped_at ? `, stopped ${state.stopped_at}` : ''}; sample rate ${state.sample_rate}`);
  const compared = Object.values(totals).reduce((a, b) => a + b, 0);
  out(`  comparisons: ${compared}${compared ? ` (${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  if (doc.serving) {
    const p = doc.serving;
    out(`  serving: offered ${p.offered}, sent ${p.sent}, sampled out ${p.sampled_out}, shed ${p.shed_queue_full + p.shed_too_large + p.shed_transport + p.shed_unmirrorable}, in transaction ${p.skipped_in_transaction}`);
  }
  const seeded = readSeedRecord(brain.dir);
  out(seeded ? `  seed ${seeded.seed_id} finished ${seeded.finished_at}; unseeded gap rows ${seeded.unseeded_gap_rows_total}` : '  seed: none (gbrain engine shadow seed)');
  if (seeded) for (const line of [...renderFollowStatus(doc), ...renderEvidenceStatus(doc)]) out(line);
  for (const line of renderBenchStatus(doc.bench)) out(line);
  for (const f of faults) out(`  fault ${f.ts} ${f.kind}: ${f.detail}`);
  return 0;
}

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

const RESEED_STEP = 'A Rust store is seeded once. To seed again, start from a new shadow directory: '
  + 'gbrain engine shadow stop --delete (deletes the store, ledger and reports), then gbrain engine shadow seed.';

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
  // The managed-storage gate: the Rust engine never holds managed storage, so seeding it copies data nothing can use.
  // It runs before the addon loads, before the shadow directory exists, before the store opens and before the snapshot starts.
  const { managedStorageRefusal, unopenableBrainRefusal } = await import('../shadow/managed-gate.ts');
  let primary: BrainEngine;
  try {
    primary = await (deps.openPrimary ?? openConfiguredPrimary)();
  } catch (e) {
    return await refuseManaged(unopenableBrainRefusal(e), json, out, err);
  }
  try {
    const refusal = await managedStorageRefusal(primary);
    if (refusal) return await refuseManaged(refusal, json, out, err);
    return await seedFrom(primary, brain, json, deps, out, err, now);
  } finally {
    await primary.disconnect().catch(() => undefined);
  }
}

/** Renders the managed-storage refusal: one line, the why and the next step on stderr; with --json also the error envelope on stdout; exit 3 (consent). */
function renderManagedRefusal(e: OperationError, err: (l: string) => void): number {
  err(`engine shadow: ${e.code} (${e.reason}): ${e.message}`);
  if (e.why) err(e.why);
  if (e.detail && !e.why?.includes(e.detail)) err(`Detail: ${e.detail}`);
  err(e.suggestion ?? 'Ask the user; nothing was written.');
  return 3;
}

async function refuseManaged(e: OperationError, json: boolean, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  if (json) {
    const { renderCliError } = await import('../core/agent-output.ts');
    out(renderCliError(e, { json: true, command: 'engine shadow seed', tty: false }).stdout!.trimEnd());
  }
  return renderManagedRefusal(e, err);
}

/** The rest of `seed` once the primary is open and unmanaged: the addon, the shadow directory, the store, the snapshot. */
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
    const record = await runSeed(primary, store, {
      primaryEngine: brain.engine, now,
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
  if (!readSeedRecord(brain.dir)) { err('engine shadow: reconcile needs a seeded store. Run gbrain engine shadow seed first.'); return 1; }
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
  const engine = await constructEngine(config);
  await engine.connect(config);
  return engine;
}

function renderSeed(r: SeedRecord, path: string, out: (l: string) => void): void {
  const rows = Object.values(r.relations).reduce((a, x) => a + x.imported, 0);
  out(`Seeded the Rust store from brain ${r.primary_engine} (${r.seed_id}): ${rows} rows in ${Object.keys(r.relations).length} relations.`);
  out(`  finished ${r.finished_at}; wrote ${path}`);
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
