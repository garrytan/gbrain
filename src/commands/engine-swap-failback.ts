/**
 * `gbrain engine swap --to pglite|postgres` (failback, docs/guides/engine-swap.md#failback): moves a swapped brain
 * back to the engine it swapped from. Dispatched by `runEngineSwap` (src/commands/engine-swap.ts) when `--to` is not
 * `rust`; the states live in src/core/engine-swap/failback.ts.
 *
 *   --plan [--json]          read only: what would be copied, every accepted loss with its count, the closed list of
 *                            what is not carried, the known limits and the plan hash;
 *   --yes --expect <hash>    runs failback when the plan for the same state of both engines has that hash;
 *   --resume                 finishes a failback that stopped after its switch.
 */
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfigFileOnly, toEngineConfig, type GBrainConfig } from '../core/config.ts';
import { noBrainError } from '../core/engine-connect.ts';
import { opError } from '../core/ops/contract.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { registerGraduationRunInProcess } from '../core/persistence/graduation-custody.ts';
import { postgresSessionsInUse } from '../core/engine-swap/pg-checkpoint.ts';
import { findSwapRecordPath, readSwapRecord, swapRunDir, type SwapRecord } from '../core/engine-swap/record.ts';
import { swapRefusal } from '../core/engine-swap/refusals.ts';
import { routeOverrideRefusal, savedDatabaseUrl, subprocessProber, type RouteProber } from '../core/engine-swap/route.ts';
import { FINGERPRINT_RULE_TEXT, planFailback, runFailback, type FailbackDeps, type FailbackPlan } from '../core/engine-swap/failback.ts';
import { shadowBrainKey } from '../shadow/state.ts';
import type { ServiceDefinition } from '../core/engine-swap/plan.ts';

export interface FailbackCliDeps {
  /** Opens the old primary as the swap run (default: the recorded engine, path and saved database_url). */
  openPrimary?: (record: SwapRecord) => Promise<BrainEngine>;
  /** Opens the Rust engine at the swap's store (default: the engine factory). */
  openRust?: (record: SwapRecord) => Promise<BrainEngine>;
  prober?: RouteProber;
  /** Names another process using the old primary, or null (default: its lock holder, or other gbrain sessions on Postgres). */
  primaryInUse?: (record: SwapRecord, primary: BrainEngine) => Promise<string | null>;
  /** Tests: the opened engines belong to the caller and stay connected. */
  keepOpen?: boolean;
}

export interface FailbackArgs { to: string; plan: boolean; json: boolean; yes: boolean; expect?: string; resume: boolean }

export interface FailbackIo {
  out: (text: string) => void;
  err: (text: string) => void;
  envNames: readonly string[];
  services: readonly ServiceDefinition[];
}

/** The record of the swap this config came from: under the brain's key, or by the Rust store it names. */
export function failbackRecordPath(config: GBrainConfig): string | null {
  const engineConfig = toEngineConfig(config);
  return findSwapRecordPath(shadowBrainKey(engineConfig), engineConfig.engine === 'rust' ? engineConfig.database_path ?? null : null);
}

async function defaultOpenPrimary(record: SwapRecord): Promise<BrainEngine> {
  const previous = record.switch!.previous;
  // The old primary records this run at cutover, so its connect gate refuses every connection but the run's own.
  registerGraduationRunInProcess(record.run_id);
  const url = previous.database_url_saved ? savedDatabaseUrl({ runDir: swapRunDir(record.brain.key), runId: record.run_id }) : null;
  if (previous.database_url_saved && !url) throw swapRefusal('failback_unavailable', 'the database_url the swap saved for the old primary is missing.', 'Failback cannot open the old Postgres primary without it. Nothing was written.');
  const config = { engine: previous.engine, ...(url ? { database_url: url } : { database_path: previous.database_path }) } as GBrainConfig;
  const { createEngine } = await import('../core/engine-factory.ts');
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));
  return engine;
}

async function defaultOpenRust(record: SwapRecord): Promise<BrainEngine> {
  const config = toEngineConfig({ engine: 'rust', database_path: record.rust_store } as GBrainConfig);
  const { createEngine } = await import('../core/engine-factory.ts');
  const engine = await createEngine(config);
  await engine.connect(config);
  return engine;
}

async function defaultPrimaryInUse(record: SwapRecord, primary: BrainEngine): Promise<string | null> {
  const previous = record.switch!.previous;
  if (previous.engine === 'postgres') {
    const n = await postgresSessionsInUse(primary);
    return n > 0 ? `${n} other gbrain session(s) are connected to the old primary's database` : null;
  }
  const holder = inspectLockHolder(previous.database_path);
  return holder.held && holder.pid !== undefined && holder.pid !== process.pid ? `process ${holder.pid} holds the old primary` : null;
}

/** Another writer of either engine, or null: a second owner of the Rust store, clients of ours, or users of the old primary. */
function writersOf(rust: BrainEngine, primary: BrainEngine, record: SwapRecord, deps: FailbackCliDeps): () => Promise<string | null> {
  return async () => {
    const owner = rust as unknown as { ownerRole?: 'owner' | 'client' | null; ownerStats?: () => { connections: number } | null };
    if (owner.ownerRole === 'client') return 'another process owns the Rust store and serves the brain from it';
    const stats = owner.ownerStats?.();
    if (stats && stats.connections > 0) return `${stats.connections} process(es) are connected to the Rust store through this one`;
    return (deps.primaryInUse ?? defaultPrimaryInUse)(record, primary);
  };
}


export function renderFailbackPlan(p: FailbackPlan): string {
  const kd = (d: { add: number; change: number; remove: number }) => `${d.add} added, ${d.change} changed, ${d.remove} removed`;
  const fields = Object.entries(p.losses.not_carried_fields).map(([t, cols]) => `${t}.${cols.join(`, ${t}.`)}`);
  return [
    `Failback plan: rust -> ${p.target}   plan ${p.plan_hash}   (swap run ${p.run_id})`,
    `Pages: ${p.pages.changed} changed, ${p.pages.added} added, ${p.pages.removed} removed, ${p.pages.unchanged} unchanged`,
    `Facts: ${kd(p.facts)}. Open loops: ${kd(p.open_loops)}. Config keys: ${kd(p.config)}. Sources: ${kd(p.sources)}.`,
    ...p.losses.accepted.map(l => `Accepted loss ${l.name}: ${l.count} (${l.detail})`),
    `Not carried by failback (no Rust read call returns it, or failback does not write it back), ${p.losses.not_carried_tables.length} table(s), kept as they were at the swap: ${p.losses.not_carried_tables.join(', ') || 'none'}`,
    `Not carried fields (the pre-swap value is kept; a row made on Rust gets the column default): ${fields.join(', ') || 'none'}`,
    ...p.known_limits.map(l => `Known limit: ${l}`),
    FINGERPRINT_RULE_TEXT,
    'Writes go only to the fenced old primary, as the swap run; the Rust store is not changed and stays as a recovery point.',
    'Nothing was written.',
  ].join('\n');
}

function usage(message: string) {
  return opError('invalid_params', message, 'Read the swap record with gbrain engine swap --status.', { docs: 'docs/guides/engine-swap.md#failback' });
}

/** Runs failback; throws typed errors for the caller's writeError. Returns the exit code on success. */
export async function runEngineFailback(args: FailbackArgs, io: FailbackIo, deps: FailbackCliDeps = {}): Promise<number> {
  // The config file, not the environment: the file is what the swap switched, and an environment override of the
  // route is refused separately (route_override) before any write.
  const config = loadConfigFileOnly();
  if (!config) throw noBrainError();
  const recordPath = failbackRecordPath(config);
  const record = recordPath ? readSwapRecord(recordPath) : null;
  if (!record || !recordPath || !record.switch) {
    throw swapRefusal('failback_unavailable', record ? `the swap run ${record.run_id} never switched authority.` : 'no swap run of this brain is recorded.',
      'Failback undoes a finished swap only. Nothing was written.');
  }
  const previous = record.switch.previous;
  if (previous.engine !== args.to) throw usage(`This brain swapped from ${previous.engine}, not ${args.to}: run gbrain engine swap --to ${previous.engine}.`);
  if (args.yes && !args.expect) throw usage(`--yes needs --expect <plan hash>: read it with gbrain engine swap --to ${args.to} --plan.`);
  let primary: BrainEngine | null = null;
  let rust: BrainEngine | null = null;
  const close = async () => {
    if (deps.keepOpen) return;
    const [p, r] = [primary, rust];
    primary = null; rust = null;
    await Promise.all([p?.disconnect().catch(() => undefined), r?.disconnect().catch(() => undefined)]);
  };
  try {
    rust = await (deps.openRust ?? defaultOpenRust)(record);
    primary = await (deps.openPrimary ?? defaultOpenPrimary)(record);
    const fb: FailbackDeps = {
      primary, rust, recordPath, brainKey: record.brain.key, runDir: swapRunDir(record.brain.key),
      writers: writersOf(rust, primary, record, deps),
      prober: deps.prober ?? subprocessProber(),
      routeCheck: () => routeOverrideRefusal(io.envNames, io.services),
      progress: line => io.err(line),
      beforeProbe: close,
    };
    if (args.resume) {
      const done = await runFailback(fb, record.failback?.plan_hash ?? '');
      io.out(args.json ? JSON.stringify({ schema_version: 1, run: done }, null, 2) : `The brain runs on the ${previous.engine} engine again.`);
      return 0;
    }
    const plan = await planFailback(fb);
    if (args.plan) {
      io.out(args.json ? JSON.stringify(plan, null, 2) : renderFailbackPlan(plan));
      return 0;
    }
    if (!args.yes) {
      if (!args.json) io.err(renderFailbackPlan(plan));
      throw opError('confirmation_required', `Failback needs your approval of plan ${plan.plan_hash}. Nothing was written.`,
        `Read it with gbrain engine swap --to ${args.to} --plan, then run gbrain engine swap --to ${args.to} --yes --expect ${plan.plan_hash}.`,
        { docs: 'docs/guides/engine-swap.md#failback', fix: { argv: ['gbrain', 'engine', 'swap', '--to', args.to, '--yes', '--expect', plan.plan_hash], consent: [], actor: 'user', requires_exclusive: true,
          why: `Moves this brain back to the ${args.to} engine under the plan the user read.`, user_message: `Move this brain back to the ${args.to} engine (plan ${plan.plan_hash})? Every write made on the Rust engine is copied back first.` } });
    }
    const done = await runFailback(fb, args.expect!);
    io.out(args.json ? JSON.stringify({ schema_version: 1, run: done }, null, 2)
      : `Failback ${done.failback!.plan_hash}: ${done.failback!.copy?.pages ?? 0} page(s), ${done.failback!.copy?.facts ?? 0} fact(s) copied back and verified.\nThe brain runs on the ${previous.engine} engine again; the Rust store at ${join(record.rust_store)} is kept unchanged as a recovery point.`);
    return 0;
  } finally {
    await close();
  }
}
