/**
 * `gbrain engine swap --to rust` (PRs S5a and S5b): the plan, the run, its status and its resume.
 *
 *   --plan [--json]            read only: the verdict, every criterion, the policy, the capability report, the write
 *                              pause, routes, disk and the plan hash (S5a);
 *   --yes --expect <hash>      runs the persisted states (src/core/engine-swap/run.ts) when the plan for the same brain
 *                              state has that hash and nothing refuses;
 *   --resume                   continues the recorded run from its last state;
 *   --status [--json]          prints the run record, without opening any engine.
 *
 * Dispatched before connectEngine() from `gbrain engine`. Without `--yes` the run gives `confirmation_required`
 * (exit 3) with the plan hash; it never prompts. Every refusal comes before the first write. A PGLite
 * or Postgres brain swaps; `--to pglite|postgres` is failback (src/commands/engine-swap-failback.ts).
 *
 * Exit codes: 0 done (plan shown, run succeeded, status shown); 1 refused or failed; 2 usage; 3 confirmation, a
 * topology decision, a mounted brain (`team_brain`), managed storage (`managed_storage`) or no shadow (`no_shadow`). `--json` prints one document on stdout; progress goes to stderr.
 */
import { swapSourceKind } from '../core/engine-swap/source.ts';
import { postgresCheckpointUnavailable, postgresSessionsInUse, type PgTools } from '../core/engine-swap/pg-checkpoint.ts';
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { writeCliError } from '../cli/cli-error.ts';
import { writeJsonDocument } from '../core/cli-force-exit.ts';
import { loadConfig, loadConfigFileOnly, toEngineConfig, type GBrainConfig } from '../core/config.ts';
import { getCliOptions } from '../core/cli-options.ts';
import type { BrainEngine } from '../core/engine.ts';
import { noBrainError } from '../core/engine-connect.ts';
import { opError, type OperationError } from '../core/ops/contract.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { localHostId } from '../core/persistence/identity.ts';
import { blockerRefusal } from '../core/engine-swap/gates.ts';
import { readSwapRecord, swapRecordPath, swapRunDir, type SwapRecord } from '../core/engine-swap/record.ts';
import { routeOverrideRefusal, subprocessProber } from '../core/engine-swap/route.ts';
import { runSwapStates, startRecord, type RustSide, type SwapRunDeps } from '../core/engine-swap/run.ts';
import { readConfiguredShadowStatus } from '../shadow/status-document.ts';
import type { ShadowStatus } from '../core/engine-swap/readiness.ts';
import { shadowBrainKey, shadowDirFor } from '../shadow/state.ts';
import { ENGINE_SELECTING_ENV, planEngineSwap, type ServiceDefinition, type SwapPlan, type SwapPlanInputs } from '../core/engine-swap/plan.ts';
import { mountedBrainError, swapRefusal, SWAP_RECOVERY } from '../core/engine-swap/refusals.ts';
import { HOST_BRAIN_ID } from '../core/brain-registry.ts';
import { failbackRecordPath, runEngineFailback, type FailbackCliDeps } from './engine-swap-failback.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';

export interface EngineSwapArgs {
  to?: string; brain?: string; plan: boolean; json: boolean; help: boolean; yes: boolean; expect?: string;
  resume: boolean; status: boolean; unsupported: string[];
}

export function parseEngineSwapArgs(args: readonly string[]): EngineSwapArgs {
  const out: EngineSwapArgs = { plan: false, json: false, help: false, yes: false, resume: false, status: false, unsupported: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === 'swap') continue;
    if (a === '--to') { out.to = args[++i]; continue; }
    if (a === '--plan' || a === '--dry-run') { out.plan = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--brain') { out.brain = args[++i]; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--yes') { out.yes = true; continue; }
    if (a === '--expect') { out.expect = args[++i]; continue; }
    if (a === '--resume') { out.resume = true; continue; }
    if (a === '--status') { out.status = true; continue; }
    out.unsupported.push(a);
  }
  return out;
}

const HELP = `gbrain engine swap — move this brain to the Rust engine, or back

  gbrain engine swap --to rust --plan [--json]            the plan and its hash; writes nothing
  gbrain engine swap --to rust --yes --expect <hash>     run the swap the plan describes
  gbrain engine swap --to rust --resume [--json]         continue a stopped run from its last state
  gbrain engine swap --status [--json]                   the recorded run, without opening the brain
  gbrain engine swap --to pglite|postgres --plan [--json]   failback: what is copied back and every loss; writes nothing
  gbrain engine swap --to pglite|postgres --yes --expect <hash>   copy Rust's writes back, verify, move authority back
  gbrain engine swap --to pglite|postgres --resume       finish a failback that stopped after its switch

A PGLite or Postgres brain swaps to rust; failback returns it to the engine it swapped from.
See docs/guides/engine-swap.md.
`;

function usage(message: string): ReturnType<typeof opError> {
  return opError('invalid_params', message, 'Run `gbrain engine swap --to rust --plan` to read the plan.',
    { docs: 'docs/guides/engine-swap.md#plan' });
}

export function renderPlanText(p: SwapPlan): string {
  const lines = [
    `Engine swap plan: ${p.from} -> ${p.to}   verdict: ${p.verdict}${p.reason ? ` (${p.reason})` : ''}   plan ${p.plan_hash}`,
    p.shadow ? '' : 'No shadow runs for this brain, so there is no readiness evidence yet. Seed one with `gbrain engine shadow seed`, then start it with `gbrain engine shadow start`.',
    'Worktree refreshes: none unfinished.',
    'Readiness:',
    `Readiness policy: ${p.policy.text} (hash ${p.policy.hash})`,
    ...p.criteria.map(c => `  ${String(c.n).padStart(2)}. [${c.state}] ${c.name}: ${c.detail}`),
    `Engine-selecting variables set (names only): ${p.routes.env.length ? p.routes.env.join(', ') : 'none'}`,
    `Service definitions: ${p.routes.services.length ? p.routes.services.map(s => `${s.name} (${s.kind}${s.unread ? '; unreadable, names unknown' : s.sets.length ? `; sets ${s.sets.join(', ')}` : ''})`).join('; ') : 'none found'}`,
    `Free disk at ${p.disk.path || '(unknown)'}: ${p.disk.free_bytes === null ? 'unknown' : `${(p.disk.free_bytes / 2 ** 30).toFixed(1)} GiB`}`,
    `Readiness policy: ${p.policy.text} (policy ${p.policy.hash})`,
    ...(p.policy.brain_ref ? [`Brain reference (binds a dated override): ${p.policy.brain_ref}`] : []),
    `Capability report: Rust serves ${p.capability_report.served.length} capabilities; ${p.capability_report.lost.length ? `not served: ${p.capability_report.lost.map(l => `${l.capability} (${l.members.length} member(s))`).join(', ')}` : 'nothing this brain uses is lost'}`,
    `Expected write pause: about ${p.write_pause.seconds} s (${p.write_pause.basis})`,
    ...p.blockers.map(b => `Blocked: ${b.reason} (${b.detail}): ${SWAP_RECOVERY[b.reason].blocker}`),
    p.reason ? `A run would refuse with engine_swap_refused (${p.reason}): ${SWAP_RECOVERY[p.reason].blocker}` : 'READY is evidence, not permission: the swap needs its own approval.',
    `Way back: ${p.way_back.statement}`,
    ...p.way_back.known_limits.map(l => `Known limit: ${l}`),
    ...p.way_back.remote_limits.map(l => `Named loss for remote callers: ${l}`),
    `Failback accepted losses (counted by its plan): ${p.way_back.accepted_losses.join(', ')}`,
    p.way_back.losses
      ? `Failback does not carry (no Rust read call returns it, or failback does not write it back), ${p.way_back.losses.not_carried_tables.length} table(s): ${p.way_back.losses.not_carried_tables.join(', ') || 'none'}; fields: ${Object.entries(p.way_back.losses.not_carried_fields).map(([t, c]) => c.map(x => `${t}.${x}`).join(', ')).join(', ') || 'none'}`
      : 'Failback does not carry: unknown (the schema of this brain could not be read).',
    p.way_back.fingerprint_rule,
    'Nothing was written.',
  ];
  return lines.filter(Boolean).join('\n');
}

/** launchd and systemd user definitions with gbrain in the name, and the engine-selecting names each one sets. */
export function serviceDefinitions(home: string): ServiceDefinition[] {
  const dirs: Array<[string, ServiceDefinition['kind']]> = [
    [join(home, 'Library', 'LaunchAgents'), 'launchd'],
    [join(home, '.config', 'systemd', 'user'), 'systemd'],
  ];
  const out: ServiceDefinition[] = [];
  for (const [dir, kind] of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names.filter(n => /gbrain/i.test(n)).sort()) {
      let text: string;
      try {
        text = readFileSync(join(dir, name), 'utf8');
      } catch {
        // Unreadable: the names it sets are unknown, so the plan says so instead of listing none.
        out.push({ name, kind, sets: [], unread: 'read_failed' });
        continue;
      }
      // Whole-word names only, by token set (no dynamic regular expression).
      const words = new Set(text.split(/[^A-Za-z0-9_]+/));
      out.push({ name, kind, sets: ENGINE_SELECTING_ENV.filter(v => words.has(v)) });
    }
  }
  return out;
}

function freeBytes(path: string): number | null {
  try { const s = statfsSync(path); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

export interface EngineSwapCliDeps extends Pick<SwapPlanInputs, 'readShadowStatus' | 'now' | 'policy' | 'rustServes'> {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  /** Directory whose file system the plan reports free space for (default: home). */
  dataDir?: string;
  /** Opens the brain without migrating it (default: the configured engine). */
  openEngine?: () => Promise<BrainEngine>;
  /** Resolves the selected brain id (default: resolveBrainId, which reads --brain, GBRAIN_BRAIN_ID and .gbrain-mount). */
  resolveBrain?: (explicit: string | null) => string;
  /** The global --brain value (default: getCliOptions().brain). */
  cliBrain?: string | null;
  out?: (text: string) => void;
  err?: (text: string) => void;
  writeError?: (e: unknown, opts: { json: boolean }) => number;
  /** The run's seams (tests): the Rust side of state 3, the route probe, the addon check, the lock check. */
  run?: Partial<Pick<SwapRunDeps, 'openRust' | 'prober' | 'fs' | 'beforeState' | 'intervalRows'>> & {
    addonCheck?: () => Promise<OperationError | null>;
    brainInUse?: (databasePath: string) => boolean;
    /** A Postgres brain: other gbrain sessions on its database (default: pg_stat_activity by application_name). */
    postgresSessions?: (engine: BrainEngine) => Promise<number>;
    /** A Postgres brain: the checkpoint precheck and pg_dump/pg_restore (default: the system tools). */
    pgTools?: PgTools;
    checkpointFreeBytes?: (dir: string) => number | null;
  };
  /** Failback's seams (`--to pglite|postgres`). */
  failback?: FailbackCliDeps;
}

function loadedConfig(): GBrainConfig {
  const config = loadConfig();
  if (!config) throw noBrainError();
  return config;
}

async function openConfiguredEngine(): Promise<BrainEngine> {
  const engineConfig = toEngineConfig(loadedConfig());
  // Read only: PGLite runs initdb on a directory with no PG_VERSION, so a missing store is refused, never made.
  if (!engineConfig.database_url && (!engineConfig.database_path || !existsSync(join(engineConfig.database_path, 'PG_VERSION')))) {
    throw opError('no_brain', `No brain exists at ${engineConfig.database_path ?? '(no path configured)'}; the swap plan creates nothing.`,
      'Check the configured path with `gbrain engine status --json`; nothing was created.', { docs: 'docs/guides/engine-swap.md#plan' });
  }
  const { createEngine } = await import('../core/engine-factory.ts');
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  return engine;
}

/** The brain key of the configured brain (the shadow directory name), without opening it. */
function brainKeyOf(config: GBrainConfig): string {
  const key = shadowBrainKey(toEngineConfig(config));
  if (!key) throw noBrainError();
  return key;
}

async function defaultAddonCheck(): Promise<OperationError | null> {
  const { loadRustEngineAddon } = await import('../core/rust-engine/addon-loader.ts');
  const load = await loadRustEngineAddon();
  return load.ok ? null : opError(load.code, load.message, 'Install the Rust engine addon for this gbrain release, then run the plan again.', { reason: load.reason });
}

/** Production Rust side of state 3: the shadow child owns the store, the read source reads the primary. */
function defaultOpenRust(primary: BrainEngine, dir: string): () => Promise<RustSide> {
  return async () => {
    const [{ ShadowSupervisor }, { shadowChildArgv }, { openReadSource }] = await Promise.all([
      import('../shadow/supervisor.ts'), import('../shadow/attach.ts'), import('../shadow/read-pool.ts'),
    ]);
    const supervisor = new ShadowSupervisor({ dir, argv: shadowChildArgv(dir), stillEnabled: () => true });
    const reads = openReadSource(primary);
    return {
      rpc: (method, args, timeoutMs) => supervisor.request(method, args, timeoutMs),
      reads,
      close: async () => { supervisor.stop(); await reads.close(); },
    };
  };
}

function renderStatus(r: SwapRecord | null): string {
  if (!r) return 'No engine swap run is recorded for this brain.';
  const lines = [
    `Engine swap run ${r.run_id}: ${r.state} (${r.brain.engine} -> rust), plan ${r.plan_hash}, policy ${r.policy_hash}`,
    `  started ${r.started_at}; updated ${r.updated_at}`,
    r.checkpoint ? `  checkpoint ${r.checkpoint.path} (${r.checkpoint.bytes} bytes, sha256 ${r.checkpoint.sha256.slice(0, 16)})` : '',
    r.fence ? `  write fence on ${r.fence.tables} table(s) since ${r.fence.at}; ${r.fence.drained} request(s) drained` : '',
    r.verify ? `  verified ${r.verify.digests.length} relation digest(s), ${r.verify.allocators.length} allocator(s), probe ${r.verify.probe}` : '',
    r.switch ? `  authority switched at ${r.switch.at} (was ${r.switch.previous.engine})` : '',
    r.probe ? `  route probe: ${r.probe.effective_engine ?? 'none'} ${r.probe.ok ? 'answered' : 'failed'}` : '',
    r.error ? `  stopped at ${r.error.state}: ${r.error.code}${r.error.reason ? ` (${r.error.reason})` : ''}, diagnostic ${r.error.diagnostic_id}. Continue with --resume.` : '',
    r.failback ? `  failback to ${r.failback.target} (plan ${r.failback.plan_hash}): ${r.failback.state}${r.failback.copy ? `; ${r.failback.copy.pages} page(s) and ${r.failback.copy.facts} fact(s) copied back` : ''}` : '',
    r.failback?.error ? `  failback stopped at ${r.failback.error.state}: ${r.failback.error.code}, diagnostic ${r.failback.error.diagnostic_id}.` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Runs the command; returns the exit code. */
export async function runEngineSwap(args: readonly string[], deps: EngineSwapCliDeps = {}): Promise<number> {
  const parsed = parseEngineSwapArgs(args);
  const out = deps.out ?? ((t: string) => { void writeJsonDocument(t, s => { process.stdout.write(`${s}\n`); }); });
  const err = deps.err ?? ((t: string) => { process.stderr.write(`${t}\n`); });
  const writeError = deps.writeError ?? ((e: unknown, o: { json: boolean }) => writeCliError(e, 'engine swap', o));
  if (parsed.help) { out(HELP.trimEnd()); return 0; }
  if (parsed.unsupported.length) return writeError(usage(`Not a flag of engine swap: ${parsed.unsupported.join(' ')}.`), parsed);
  const modes = [parsed.plan, parsed.yes || parsed.expect !== undefined, parsed.resume, parsed.status].filter(Boolean).length;
  if (modes > 1) return writeError(usage('Use one of --plan, --yes --expect <hash>, --resume or --status.'), parsed);
  if (!parsed.status && parsed.to !== 'rust' && parsed.to !== 'pglite' && parsed.to !== 'postgres') {
    return writeError(usage(`--to ${parsed.to ?? '(missing)'} is not an engine: use rust, or pglite / postgres to fail back.`), parsed);
  }
  if (parsed.yes && !parsed.expect) return writeError(usage('--yes needs --expect <plan hash>: read it with gbrain engine swap --to rust --plan.'), parsed);
  let brainId: string;
  // The global --brain flag is stripped into getCliOptions() before dispatch; a local one wins.
  const explicitBrain = parsed.brain ?? (deps.cliBrain !== undefined ? deps.cliBrain : getCliOptions().brain) ?? null;
  try { brainId = (deps.resolveBrain ?? resolveBrainId)(explicitBrain); } catch (e) { return writeError(e, parsed); }
  if (brainId !== HOST_BRAIN_ID) return writeError(mountedBrainError(brainId), parsed);
  if (parsed.status) {
    try {
      const statusPath = failbackRecordPath(loadConfigFileOnly() ?? loadedConfig()) ?? swapRecordPath(brainKeyOf(loadedConfig()));
      const record = readSwapRecord(statusPath);
      out(parsed.json ? JSON.stringify({ schema_version: 1, run: record }, null, 2) : renderStatus(record));
      return 0;
    } catch (e) { return writeError(e, parsed); }
  }
  if (parsed.to === 'pglite' || parsed.to === 'postgres') {
    const env = deps.env ?? process.env;
    const home = deps.home ?? env.HOME ?? '';
    try {
      return await runEngineFailback({ to: parsed.to, plan: parsed.plan, json: parsed.json, yes: parsed.yes, expect: parsed.expect, resume: parsed.resume },
        { out, err, envNames: ENGINE_SELECTING_ENV.filter(v => (env[v] ?? '') !== ''), services: home ? serviceDefinitions(home) : [] }, deps.failback);
    } catch (e) { return writeError(e, parsed); }
  }
  const running = parsed.yes || parsed.resume;
  let engine: BrainEngine | null = null;
  try {
    const config = running ? loadedConfig() : null;
    if (running && config) {
      const path = toEngineConfig(config).database_path;
      const kind = swapSourceKind(config);
      switch (kind) {
        case 'pglite': break;
        case 'postgres': break;
        case 'rust':
          throw usage('This brain already runs on the Rust engine.');
        default: {
          const unreachable: never = kind;
          throw usage(`Unknown engine ${String(unreachable)}.`);
        }
      }
      if (path && (deps.run?.brainInUse ?? ((p: string) => inspectLockHolder(p).held))(path)) {
        throw swapRefusal('brain_in_use', 'another process holds this brain (a gbrain serve, a shadow-serving process or a running command).',
          'The swap holds the brain for the whole run, so the writer must stop first. Stop it (gbrain serve stop, or end the command), then run the swap again.');
      }
    }
    engine = await (deps.openEngine ?? openConfiguredEngine)();
    const postgresSource = running && config && swapSourceKind(config) === 'postgres';
    if (postgresSource && (await (deps.run?.postgresSessions ?? postgresSessionsInUse)(engine)) > 0) {
      throw swapRefusal('brain_in_use', 'another gbrain process is connected to this brain\'s database (a gbrain serve, a worker, a shadow-serving process or a running command).',
        'The write fence refuses their writes for the whole run, so stop them first (gbrain serve, gbrain jobs work, autopilot), then run the swap again.');
    }
    const env = deps.env ?? process.env;
    const home = deps.home ?? env.HOME ?? '';
    const dataDir = deps.dataDir ?? home;
    const envNames = ENGINE_SELECTING_ENV.filter(v => (env[v] ?? '') !== '');
    const services = home ? serviceDefinitions(home) : [];
    const configured = config ?? loadConfig();
    const brainKey = configured ? shadowBrainKey(toEngineConfig(configured)) : null;
    const shadowDir = brainKey ? shadowDirFor(brainKey) : '';
    const plan = await planEngineSwap(engine, {
      // The one status builder `gbrain engine shadow status --json` prints (src/shadow/status-document.ts).
      readShadowStatus: deps.readShadowStatus ?? (async (primary) => (await readConfiguredShadowStatus(() => (configured ? toEngineConfig(configured) : null), deps.now, primary)) as ShadowStatus | null),
      now: deps.now, policy: deps.policy, rustServes: deps.rustServes,
      envNames, services,
      disk: { path: dataDir, free_bytes: dataDir ? freeBytes(dataDir) : null },
      remoteMcpConfigured: !!configured?.remote_mcp,
    });
    if (!running && parsed.plan) {
      out(parsed.json ? JSON.stringify(plan, null, 2) : renderPlanText(plan));
      return 0;
    }
    if (!running) {
      // No approval: the plan's hash and how to approve it; nothing ran (the graduation contract).
      throw opError('confirmation_required', `The swap needs your approval of plan ${plan.plan_hash} (verdict ${plan.verdict}). Nothing was written.`,
        `Read it with gbrain engine swap --to rust --plan, then run gbrain engine swap --to rust --yes --expect ${plan.plan_hash}.`,
        { docs: 'docs/guides/engine-swap.md#run', fix: { argv: ['gbrain', 'engine', 'swap', '--to', 'rust', '--yes', '--expect', plan.plan_hash], consent: [], actor: 'user', requires_exclusive: true,
          why: 'Moves this brain to the Rust engine under the plan the user read.', user_message: `Run the engine swap the plan describes (plan ${plan.plan_hash})?` } });
    }
    if (!brainKey || !config) throw noBrainError();
    const recordPath = swapRecordPath(brainKey);
    const runDeps: SwapRunDeps = {
      primary: engine, config, brainKey, shadowDir, rustStore: join(shadowDir, 'store'), hostId: localHostId(),
      ...(postgresSource && config?.database_url ? { postgres: { url: config.database_url, tools: deps.run?.pgTools } } : {}),
      openRust: deps.run?.openRust ?? defaultOpenRust(engine, shadowDir),
      prober: deps.run?.prober ?? subprocessProber(),
      routeCheck: () => routeOverrideRefusal(envNames, services),
      recordPath, fs: deps.run?.fs, now: deps.now ? () => deps.now! : undefined,
      progress: line => err(line), beforeState: deps.run?.beforeState, intervalRows: deps.run?.intervalRows,
    };
    let record: SwapRecord;
    if (parsed.resume) {
      const existing = readSwapRecord(recordPath);
      if (!existing) throw usage('No swap run of this brain is recorded; start one with --yes --expect <plan hash>.');
      record = existing;
    } else {
      // Every refusal comes before the first write: the hash, then what the Rust engine cannot serve, then readiness,
      // then routes and the addon.
      if (parsed.expect !== plan.plan_hash) {
        throw opError('preview_changed', `The plan changed: its hash is ${plan.plan_hash}, not ${parsed.expect}. Nothing was written.`,
          'Read the plan again and confirm the new hash.', { docs: 'docs/guides/engine-swap.md#plan',
            fix: { argv: ['gbrain', 'engine', 'swap', '--to', 'rust', '--plan', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Reads the current plan and its hash.' } });
      }
      if (plan.blockers.length) throw blockerRefusal(plan.blockers[0]!);
      if (plan.reason) {
        throw swapRefusal(plan.reason, `the readiness verdict is NOT READY (${plan.criteria.filter(c => c.gating && c.state !== 'pass').map(c => `criterion ${c.n} ${c.state}`).join(', ')}).`,
          'There is no override: keep the shadow running and read the report until the plan says READY.',
          plan.reason === 'not_ready' ? { argv: ['gbrain', 'engine', 'shadow', 'report', '--json'], consent: [], actor: 'agent', requires_exclusive: false, docs: SWAP_RECOVERY.not_ready.anchor, why: 'The shadow report lists what each criterion still needs.' } : undefined);
      }
      const override = runDeps.routeCheck();
      if (override) throw override;
      const addon = await (deps.run?.addonCheck ?? defaultAddonCheck)();
      if (addon) throw addon;
      if (postgresSource) {
        const short = await postgresCheckpointUnavailable(engine, swapRunDir(brainKey), { tools: deps.run?.pgTools, freeBytes: deps.run?.checkpointFreeBytes });
        if (short) throw short;
      }
      record = startRecord(runDeps, plan.plan_hash, plan.policy.hash);
    }
    const done = await runSwapStates(record, runDeps);
    out(parsed.json ? JSON.stringify({ schema_version: 1, run: done }, null, 2) : `${renderStatus(done)}\nThe brain now runs on the Rust engine; the old engine stays fenced as the way back.`);
    return 0;
  } catch (e) {
    return writeError(e, parsed);
  } finally {
    if (engine) await engine.disconnect().catch(() => undefined);
  }
}
