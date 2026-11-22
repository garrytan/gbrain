/**
 * `gbrain engine shadow start|status|stop|report` (plan PR S1 and the read half of S2).
 *
 * Shadow mode mirrors a sample of the host brain's reads to the Rust engine in a supervised child process and
 * records whether the answers agree. It is off by default and writes nothing to the brain database, its config
 * table or the brain repo: every file lives in `<gbrain home>/shadow/<brain>/`. `start` previews a plan with a hash
 * and needs `--yes --expect <hash>`; the installed addon is loaded then, in the foreground. `start` first opens the brain
 * to read its storage mode and refuses a managed-storage brain (the Rust engine never holds one). The
 * hidden `__child <dir>` is the child the serving process spawns.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { loadConfig } from '../core/config.ts';
import type { EngineConfig } from '../core/types.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { OperationError } from '../core/ops/contract.ts';
import type { RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { readFaults, readShadowSummary } from '../shadow/ledger.ts';
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
  /** Opens the configured brain to read its storage mode (never with shadow mode attached; closed after); default the real engine. */
  openPrimary?: () => Promise<BrainEngine>;
  /** The addon loader `start --yes` runs; default the real loader (installed addon only, no network). */
  loadAddon?: () => Promise<RustEngineAddonLoad>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => Date;
  /** The `__child` loop; default runShadowChild on stdin/stdout. */
  runChild?: (dir: string) => Promise<number>;
}

const HELP = `gbrain engine shadow — compare the Rust engine against this brain's reads, off the request path

Usage:
  gbrain engine shadow start [--plan] [--sample-rate <0..1>] [--queue-bound <n>]
  gbrain engine shadow start --yes --expect <plan_hash> [--sample-rate <0..1>] [--queue-bound <n>]
  gbrain engine shadow status [--json]
  gbrain engine shadow stop [--delete]
  gbrain engine shadow report [--json]

Shadow mode is off by default. When on, a sample of reads this brain answers is sent, after the answer, to a
supervised child process that runs the same read on the Rust engine and records match, diff or why it could not
compare. The primary answer never waits for the child. It writes nothing to the brain database, its config or the
brain repo; everything lives in <gbrain home>/shadow/<brain>/. stop --delete removes that directory.

A brain that uses managed storage is refused (exit 3): the Rust engine never holds managed storage, so a shadow on it
measures nothing it could use. start opens the brain database to read that, even with --plan.

The report is provisional and always says NOT READY: the Rust store is not seeded until a later release.`;

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
        const { runShadowChild } = await import('../shadow/child.ts');
        await runShadowChild(d, { input: process.stdin, writeControl: (s) => { process.stdout.write(s); } });
        return 0;
      });
      return await run(dir);
    }
    const brain = await resolveBrain(deps);
    if (sub === 'start') return await start(brain, parseStart(rest), deps, out, err, now);
    if (sub === 'status') return status(brain, flags(rest, ['--json'], 'status').has('--json'), out);
    if (sub === 'stop') return stop(brain, flags(rest, ['--delete'], 'stop').has('--delete'), out, now);
    if (sub === 'report') return report(brain, flags(rest, ['--json'], 'report').has('--json'), out, now);
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
async function openConfiguredPrimary(config: ResolvedBrain['config']): Promise<BrainEngine> {
  const { constructEngine } = await import('../core/engine-construct.ts');
  const engineConfig: EngineConfig = { engine: config.engine, database_path: config.database_path, database_url: config.database_url };
  const engine = await constructEngine(engineConfig);
  await engine.connect(engineConfig);
  return engine;
}

/** The managed-storage refusal for this brain, or null. A brain that cannot be opened is refused too (the mode is unknown). */
async function managedRefusal(brain: ResolvedBrain, deps: EngineShadowDeps): Promise<OperationError | null> {
  const { managedStorageRefusal, unopenableBrainRefusal } = await import('../shadow/managed-gate.ts');
  let primary: BrainEngine;
  try {
    primary = await (deps.openPrimary ?? (() => openConfiguredPrimary(brain.config)))();
  } catch (e) {
    return unopenableBrainRefusal(e);
  }
  try {
    return await managedStorageRefusal(primary);
  } finally {
    await primary.disconnect().catch(() => undefined);
  }
}

/** Renders the managed-storage refusal: one line, the why and the next step on stderr; exit 3 (consent). */
function renderManagedRefusal(e: OperationError, err: (l: string) => void): number {
  err(`engine shadow: ${e.code} (${e.reason}): ${e.message}`);
  if (e.why) err(e.why);
  if (e.detail) err(`Detail: ${e.detail}`);
  err(e.suggestion ?? 'Ask the user; nothing was written.');
  return 3;
}

async function start(
  brain: ResolvedBrain, o: StartOpts, deps: EngineShadowDeps,
  out: (l: string) => void, err: (l: string) => void, now: () => Date,
): Promise<number> {
  const { plan, hash } = shadowPlan(brain.key, brain.engine, brain.dir, o);
  const refusal = await managedRefusal(brain, deps);
  if (refusal) return renderManagedRefusal(refusal, err);
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
      children: summary?.children ?? 0, recent_faults: faults,
    }, null, 2));
    return 0;
  }
  out(`Shadow mode: ${state?.enabled ? 'on' : 'off'} (brain ${brain.key})`);
  if (state) out(`  started ${state.started_at}${state.stopped_at ? `, stopped ${state.stopped_at}` : ''}; sample rate ${state.sample_rate}`);
  const compared = Object.values(totals).reduce((a, b) => a + b, 0);
  out(`  comparisons: ${compared}${compared ? ` (${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  if (summary) {
    const p = summary.primary;
    out(`  serving: offered ${p.offered}, sent ${p.sent}, sampled out ${p.sampled_out}, shed ${p.shed_queue_full + p.shed_too_large + p.shed_transport + p.shed_unmirrorable}, in transaction ${p.skipped_in_transaction}`);
  }
  for (const f of faults) out(`  fault ${f.ts} ${f.kind}: ${f.detail}`);
  return 0;
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
