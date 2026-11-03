/**
 * GBRA-175: the host side of the upgrade restart (src/core/upgrade-restart.ts
 * holds the pure planning and verification). `gbrain upgrade` calls
 * `preflightHostRestart` before it installs anything, so a process it could
 * not restart refuses the upgrade instead of leaving two builds running, and
 * the new build runs `gbrain upgrade --restart-only` after the swap, which
 * calls `runHostRestart`. `--restart-only` on its own restarts every process
 * onto the build already installed (doctor's `runtime_build_skew` fix);
 * `--dry-run` prints the plan and changes nothing.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from '../core/spawn.ts';
import { isThinClient, loadConfig, toEngineConfig } from '../core/config.ts';
import { opError } from '../core/ops/contract.ts';
import type { Action } from '../core/agent-output.ts';
import { writeCliError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { SERVE_LAUNCHD_LABEL, SERVE_SYSTEMD_UNIT, serveServiceRestartArgv } from '../core/serve-service.ts';
import { resolveAutopilotJob } from '../core/autopilot-paths.ts';
import { plistPath, systemdUnitPath } from './autopilot/jobs.ts';
import { readSupervisorBuild, readSupervisorPid } from '../core/minions/supervisor-pid.ts';
import { parseEtimeToMs, readWorkers } from '../core/minions/worker-registry.ts';
import { installedVersion, runtimeInstallRoot } from '../core/runtime-build.ts';
import { VERSION } from '../version.ts';
import { compareWriterVersions } from '../core/persistence/writer-versions.ts';
import { resolveQuietHoursWindow, resolveSelfUpgradeMode } from '../core/self-upgrade.ts';
import { evaluateQuietHours } from '../core/minions/quiet-hours.ts';
import { logSelfUpgrade } from '../core/audit/self-upgrade-audit.ts';
import {
  classifyGbrainCommand, collectHostProcesses, copyFix, gbrainEntry, mismatchedBuilds, PENDING_BUILD, planRestart, runRestartSteps, verifyRestart,
  type HostProcess, type ProcessSources, type ProcessTableRow, type RestartExecutor, type RestartPlan, type ServiceHandle, type WarmSocketState,
} from '../core/upgrade-restart.ts';

const DOCS = 'docs/guides/upgrades-auto-update.md#restart';
const DRY_RUN_VERIFY = ['gbrain', 'upgrade', '--restart-only', '--dry-run', '--json'];
const VERIFY_TIMEOUT_MS = 180_000;
const VERIFY_POLL_MS = 2_000;

const brainHome = () => process.env.GBRAIN_HOME?.trim() || homedir();

/** The GBRAIN_HOME (else HOME) in a process's environment; undefined when it cannot be read (only Linux exposes it). */
function processHome(pid: number): string | null | undefined {
  try {
    const vars = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const get = (name: string) => vars.find(v => v.startsWith(`${name}=`))?.slice(name.length + 1).trim() || null;
    return get('GBRAIN_HOME') ?? get('HOME');
  } catch {
    return undefined;
  }
}

/** This user's processes from `ps` (Linux and macOS), or the given pids; null when ps cannot run. */
function readProcessTable(uid: number | undefined, pids?: number[]): ProcessTableRow[] | null {
  const select = pids ? ['-p', pids.join(',')] : uid === undefined ? ['-x'] : ['-U', String(uid)];
  const run = spawnSync('ps', [...select, '-ww', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (typeof run.stdout !== 'string' || (run.status !== 0 && !(pids && run.status === 1))) return null;
  const now = Date.now();
  return run.stdout.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) return [];
    const elapsed = parseEtimeToMs(m[3]!);
    const pid = Number(m[1]);
    return [{ pid, ppid: Number(m[2]), command: m[4]!, started_ms: elapsed === null ? null : now - elapsed, gbrain_home: processHome(pid) }];
  });
}

/** The gbrain install a command line starts from: the package directory above its entry point and the version it holds now (null for a compiled binary). */
function installOf(command: string): { root: string | null; version: string | null } {
  const entry = gbrainEntry(command)?.entry;
  if (!entry) return { root: null, version: null };
  try {
    const found = entry.includes('/') ? entry : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, entry)).find(path => existsSync(path));
    if (!found) return { root: null, version: null };
    let dir = dirname(realpathSync(found));
    for (let i = 0; i < 4; i++, dir = dirname(dir)) {
      const version = installedVersion(dir);
      if (version) return { root: dir, version };
    }
  } catch { /* unknown */ }
  return { root: null, version: null };
}

/** The pid a service manager runs for a unit or label now; null when it is not running or cannot be read. */
function servicePid(platform: string, unit: string, launchdLabel: string): number | null {
  const r = platform === 'darwin' ? spawnSync('launchctl', ['list', launchdLabel], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
    : spawnSync('systemctl', ['--user', 'show', '-p', 'MainPID', unit], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const pid = Number((platform === 'darwin' ? /"PID"\s*=\s*(\d+)/ : /^MainPID=(\d+)/m).exec(r.stdout)?.[1]);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/** The services this brain installed on this host: each one's restart command and the pid its manager runs. */
export function hostServices(platform: string = process.platform, home: string = homedir(), uid: number = process.getuid?.() ?? 501): { serve: ServiceHandle | null; autopilot: ServiceHandle | null } {
  const job = resolveAutopilotJob();
  const autopilot = platform === 'darwin' && existsSync(plistPath(job.launchdLabel)) ? ['launchctl', 'kickstart', '-k', `gui/${uid}/${job.launchdLabel}`]
    : platform === 'linux' && existsSync(systemdUnitPath(job.systemdUnit)) ? ['systemctl', '--user', 'restart', job.systemdUnit] : null;
  const serve = serveServiceRestartArgv({ platform, home, uid });
  return {
    serve: serve ? { argv: serve, pid: servicePid(platform, SERVE_SYSTEMD_UNIT, SERVE_LAUNCHD_LABEL) } : null,
    autopilot: autopilot ? { argv: autopilot, pid: servicePid(platform, job.systemdUnit, job.launchdLabel) } : null,
  };
}

/** The real process sources; `close` releases the database connection the heartbeat read holds (Postgres only). */
async function hostSources(): Promise<{ sources: ProcessSources; notes: string[]; close: () => Promise<void>; pidFile: string }> {
  const notes: string[] = [];
  let heartbeats: ProcessSources['heartbeats'] = async () => [];
  let close = async () => {};
  const config = loadConfig();
  if (config?.engine === 'postgres' && !isThinClient(config)) {
    try {
      const { createEngine } = await import('../core/engine-factory.ts');
      const { listHostConsumers } = await import('../core/persistence/consumer-heartbeat.ts');
      const { localHostIdentity } = await import('../core/persistence/identity.ts');
      const engine = await createEngine(toEngineConfig(config));
      await engine.connect(toEngineConfig(config));
      const hostId = localHostIdentity().id;
      heartbeats = async () => (await listHostConsumers(engine, hostId)).filter(row => row.liveness === 'live' && !row.self)
        .map(row => ({ pid: row.pid, kind: row.kind, version: row.version || null }));
      close = () => engine.disconnect();
    } catch (error) {
      notes.push(`The consumer heartbeat rows could not be read (${(error as Error).message}); builds come from the PID file, the worker registry and process start times.`);
    }
  }
  const { DEFAULT_PID_FILE } = await import('../core/minions/supervisor.ts');
  const uid = process.getuid?.();
  if (readProcessTable(uid, [process.pid]) === null) notes.push('ps could not run, so processes come from the heartbeat rows, the PID file and the worker registry, and no MCP server is signalled.');
  const sources: ProcessSources = {
    heartbeats,
    supervisor: () => {
      const status = readSupervisorPid(DEFAULT_PID_FILE);
      return status.running && status.pid !== null ? { pid: status.pid, version: readSupervisorBuild(DEFAULT_PID_FILE)?.version ?? null } : null;
    },
    workers: () => { try { return readWorkers(() => null).map(w => ({ pid: w.pid, version: w.version ?? null })); } catch { return []; } },
    processTable: () => readProcessTable(uid),
    install: installOf,
    home: brainHome(),
    exclude: [process.pid, process.ppid],
  };
  return { sources, notes, close, pidFile: DEFAULT_PID_FILE };
}

/** The real executor for restart steps; `pidFile` is the default supervisor PID file. */
function hostExecutor(pidFile: string): RestartExecutor {
  return {
    run: (argv, env) => {
      const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
      return { status: r.error ? null : r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
    },
    terminate: terminateIfUnchanged,
    supervisorPid: file => { const status = readSupervisorPid(file ?? pidFile); return status.running ? status.pid : null; },
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  };
}

/** SIGTERM pid only while it is still the MCP server the plan saw: same role, same start time (ps reports it to the second). */
function terminateIfUnchanged(pid: number, startedMs: number | null): 'stopped' | 'gone' | 'changed' {
  const row = readProcessTable(undefined, [pid])?.find(r => r.pid === pid);
  if (!row) return 'gone';
  if (classifyGbrainCommand(row.command) !== 'mcp' || startedMs === null || row.started_ms === null || Math.abs(row.started_ms - startedMs) > 2_000) return 'changed';
  try { process.kill(pid, 'SIGTERM'); return 'stopped'; } catch { return 'gone'; }
}

const describe = (p: Pick<HostProcess, 'role' | 'pid' | 'version'>) => `${p.role} pid ${p.pid} (${p.version ? `v${p.version}` : 'build not recorded'})`;

function describeSteps(plan: RestartPlan): string[] {
  const byPid = new Map(plan.stale.map(p => [p.pid, p]));
  const name = (pid: number) => byPid.has(pid) ? describe(byPid.get(pid)!) : `pid ${pid}`;
  return plan.steps.map(step => step.kind === 'service' ? `${step.pids.map(name).join(', ')}: \`${step.argv.join(' ')}\``
    : step.kind === 'supervisor' ? `${[step.pid, ...step.workers].map(name).join(', ')}: \`${step.stop.join(' ')}\`, then \`${step.start.join(' ')}\``
    : step.kind === 'replace_copy' ? `${step.pids.map(name).join(', ')} run from the Bun global copy at ${step.root} (${step.from ? `v${step.from}` : 'version unknown'}): replace it with v${step.to} (BUN_INSTALL=${step.bun_install}: bun remove -g gbrain, then bun add -g the tag) before the restarts`
    : `${name(step.pid)}: stop it (reconnect gbrain in its harness afterwards)`);
}

/** The refusal for a plan with manual steps, or null when every process restarts on its own. */
export function restartRefusal(plan: RestartPlan, rerunArgv: readonly string[], installed: boolean) {
  if (!plan.manual.length) return null;
  const onlyMcp = plan.manual.every(m => m.role === 'mcp');
  const first = plan.manual.find(m => m.role !== 'mcp') ?? plan.manual[0]!;
  const fix: Action = onlyMcp
    ? { ask_user: true, argv: [...rerunArgv.filter(a => a !== '--stop-mcp'), '--stop-mcp'], consent: [], actor: 'agent', requires_exclusive: false, docs: DOCS,
      why: 'Stops each listed MCP server during the restart; its harness starts the installed build when gbrain is reconnected.',
      user_message: `${plan.manual.length} gbrain MCP server(s) started by agent harnesses run on this host (${plan.manual.map(m => `pid ${m.pid}`).join(', ')}). Upgrading leaves them on the old build unless they stop. May the upgrade stop them? Reconnect gbrain in each harness afterwards.`,
      verify: { argv: DRY_RUN_VERIFY } }
    : { argv: first.argv, consent: [], actor: 'user', requires_exclusive: false, docs: DOCS, why: first.instruction, verify: { argv: DRY_RUN_VERIFY } };
  return opError('restart_refused',
    `${plan.manual.length} gbrain process(es) on this host cannot be restarted automatically, so nothing was restarted${installed ? '' : ' and nothing was installed'}: ${plan.manual.map(m => m.instruction).join(' ')}`,
    `Handle each process as listed, then run \`${rerunArgv.join(' ')}\` again; \`gbrain upgrade --no-restart\` installs without restarting (doctor then reports runtime_build_skew).`,
    { fix, docs: DOCS });
}

export interface HostRestartOptions { stopMcp: boolean; json: boolean; rerunArgv: string[] }

/**
 * `gbrain upgrade --restart-only [--dry-run]`. `--dry-run` belongs to `--restart-only`: anywhere else it is refused,
 * never ignored while the upgrade installs for real (#2185). True when this handled the invocation.
 */
export async function handleRestartOnly(args: readonly string[], opts: HostRestartOptions): Promise<boolean> {
  const dryRun = args.includes('--dry-run');
  if (args.includes('--restart-only')) {
    await runHostRestart({ ...opts, rerunArgv: ['gbrain', 'upgrade', '--restart-only', ...(opts.stopMcp ? ['--stop-mcp'] : [])], dryRun });
    return true;
  }
  if (!dryRun) return false;
  setCliExitVerdict(writeCliError(opError('invalid_params', '--dry-run previews only a restart; nothing was installed.', 'Run gbrain upgrade --restart-only --dry-run to preview the restart.'), 'upgrade', { json: opts.json }));
  return true;
}

/** The package directory this process loaded its code from (realpath), the install the upgrade replaces. */
function ownInstallRoot(): string | null {
  const root = runtimeInstallRoot();
  try { return root ? realpathSync(root) : null; } catch { return root; }
}

/**
 * GBRA-175: the fix for a process that came back on another build: move the install it runs from onto the target
 * (a Bun global copy is removed and re-added, since a pinned copy keeps its pin through `bun add`), then restart again.
 */
export function mismatchFix(p: HostProcess, expected: string): Action {
  const restart: Action = { argv: ['gbrain', 'upgrade', '--restart-only'], consent: [], actor: 'agent', requires_exclusive: false, docs: DOCS,
    why: 'Restarts every gbrain process onto the installed build and verifies it.', verify: { argv: DRY_RUN_VERIFY } };
  if (!p.install_root) {
    return { argv: DRY_RUN_VERIFY, consent: [], actor: 'agent', requires_exclusive: false, docs: DOCS, verify: { argv: DRY_RUN_VERIFY },
      why: `${p.role} pid ${p.pid} runs another build from an install that could not be located (a compiled binary): reinstall that binary at v${expected} or start the process from this install, then run gbrain upgrade --restart-only.` };
  }
  const fix = copyFix(p.install_root, p.install_version ?? null, expected);
  const envPrefix = Object.entries(fix.env).map(([k, v]) => `${k}=${v}`);
  const chain = fix.argv.reduceRight<Action>((then, argv) => ({ argv: envPrefix.length ? ['env', ...envPrefix, ...argv] : argv, consent: [], actor: 'user', requires_exclusive: false, docs: DOCS,
    why: `${p.role} pid ${p.pid} came back on another build because it runs from ${p.install_root}: ${fix.instruction}.`, then }), restart);
  return { ...chain, ask_user: true, user_message: `${p.role} pid ${p.pid} still runs another gbrain build after the restart: it starts from ${p.install_root}, which holds ${p.install_version ? `v${p.install_version}` : 'an unknown version'}. May I ${fix.instruction}, then restart again?` };
}

/**
 * Before the swap: refuse (exit 3, nothing installed) when a running process could not be restarted afterwards.
 * Returns true when the upgrade may proceed.
 */
export async function preflightHostRestart(opts: HostRestartOptions): Promise<boolean> {
  const { sources, close } = await hostSources();
  try {
    const services = hostServices();
    const plan = planRestart(await collectHostProcesses(sources), { expected: PENDING_BUILD, serveService: services.serve, autopilotService: services.autopilot, stopMcp: opts.stopMcp, ownInstallRoot: ownInstallRoot() });
    const refusal = restartRefusal(plan, opts.rerunArgv, false);
    if (!refusal) return true;
    setCliExitVerdict(writeCliError(refusal, 'upgrade', { json: opts.json }));
    return false;
  } finally {
    await close();
  }
}

/** `gbrain upgrade --restart-only [--stop-mcp] [--dry-run] [--json]`: restart every process onto the installed build and verify. */
export async function runHostRestart(opts: HostRestartOptions & { dryRun: boolean }): Promise<void> {
  const { sources, notes, close, pidFile } = await hostSources();
  try {
    const services = hostServices();
    const before = await collectHostProcesses(sources);
    const plan = planRestart(before, { expected: VERSION, serveService: services.serve, autopilotService: services.autopilot, stopMcp: opts.stopMcp, ownInstallRoot: ownInstallRoot() });
    const { probeCliSocket } = await import('../core/cli-socket/probe.ts');
    const warmBefore = await probeCliSocket();
    const planDoc = { expected: VERSION, processes: before, steps: plan.steps, manual: plan.manual, warm_socket: warmBefore, notes };
    if (opts.dryRun) {
      if (opts.json) console.log(JSON.stringify({ status: plan.manual.length ? 'refused' : 'ok', dry_run: true, ...planDoc }, null, 2));
      else printPlan(plan, warmBefore, notes);
      return;
    }
    const refusal = restartRefusal(plan, opts.rerunArgv, true);
    if (refusal) { setCliExitVerdict(writeCliError(refusal, 'upgrade', { json: opts.json })); return; }
    if (!opts.json) printPlan(plan, warmBefore, notes);
    const startedMs = Date.now();
    const results = await runRestartSteps(plan, hostExecutor(pidFile));
    if (!opts.json) for (const r of results) console.log(`  ${r.ok ? 'ok' : 'FAILED'}: ${r.detail}`);
    const verified = await verifyRestart(plan, startedMs, warmBefore, {
      collect: () => collectHostProcesses(sources), probeWarmSocket: () => probeCliSocket(),
      sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now(),
    }, { timeoutMs: plan.steps.length ? VERIFY_TIMEOUT_MS : 0, pollMs: VERIFY_POLL_MS });
    const doc = { status: verified.ok ? 'ok' : 'unverified', ...planDoc, results, verified: { processes: verified.processes, warm_socket: verified.warm_socket, problems: verified.problems, unverified: verified.unverified } };
    if (!verified.ok) {
      const failed = results.find(r => !r.ok);
      const mismatch = mismatchedBuilds(plan, verified.processes)[0];
      setCliExitVerdict(writeCliError(opError('restart_unverified',
        `After the restart this host still runs more than one gbrain build, or a process did not come back: ${verified.problems.join(' ')}`,
        `${failed ? `${failed.detail}. ` : ''}${mismatch ? 'Move each listed install onto this build as named' : 'Restart what is listed with the command the plan printed'}, then run \`gbrain upgrade --restart-only\` again.`,
        { docs: DOCS, fix: mismatch ? mismatchFix(mismatch, VERSION) : { argv: DRY_RUN_VERIFY, consent: [], actor: 'agent', requires_exclusive: false, docs: DOCS, why: 'Read-only: lists every gbrain process on this host with its build and the restart each one needs.', verify: { argv: ['gbrain', 'doctor', '--only', 'runtime_build_skew', '--json'] } } }),
        'upgrade', { json: opts.json, extra: opts.json ? { restart: doc } : undefined }));
      return;
    }
    if (opts.json) { console.log(JSON.stringify(doc, null, 2)); return; }
    const running = verified.processes.map(p => `${p.role} pid ${p.pid}`).join(', ');
    console.log(`Verified: every gbrain process on this host runs v${VERSION}${running ? ` (${running})` : ' (none is running)'}; warm CLI socket: ${verified.warm_socket.state === 'refused' ? `refused for this shell (${verified.warm_socket.reason}${verified.warm_socket.mismatch ? `: ${verified.warm_socket.mismatch}` : ''})` : verified.warm_socket.state}.`);
    for (const line of verified.unverified) console.log(`Note: ${line}`);
    const stopped = plan.steps.filter(step => step.kind === 'stop');
    if (stopped.length) console.log(`Reconnect gbrain in the harness of each stopped MCP server (${stopped.map(s => `pid ${s.pid}`).join(', ')}): Claude Code /mcp, then reconnect; other harnesses: start a new session.`);
  } finally {
    await close();
  }
}

export type ServeRestartOutcome = { outcome: 'no_service' | 'current' } | { outcome: 'manual' | 'restarted' | 'unverified'; detail: string };

/**
 * #7475: the serve-only restart plan when the serve service can move every older serve onto `expected` by itself;
 * otherwise the outcome. A serve counts as older only on evidence: a recorded build below `expected`, or no recorded
 * build and a start before the install on disk was written (`installedMs`). A newer or unknown serve is left alone.
 */
export function planServeRestart(processes: readonly HostProcess[], serveService: ServiceHandle, expected: string, ownRoot: string | null, installedMs: number | null = null): RestartPlan | ServeRestartOutcome {
  const older = processes.filter(p => p.role === 'serve' && (p.version !== null
    ? (compareWriterVersions(p.version, expected) ?? 0) < 0
    : installedMs !== null && p.started_ms !== null && p.started_ms < installedMs));
  const plan = planRestart(older, { expected, serveService, autopilotService: null, stopMcp: false, ownInstallRoot: ownRoot });
  if (!plan.stale.length) return { outcome: 'current' };
  if (plan.manual.length || plan.steps.some(step => step.kind !== 'service')) {
    return { outcome: 'manual', detail: `run \`gbrain upgrade --restart-only\`: ${[...describeSteps(plan), ...plan.manual.map(m => m.instruction)].join(' ')}` };
  }
  return plan;
}

/**
 * #7475: the autopilot self-upgrade swaps and relaunches only itself. Once it runs the new build, it calls this to
 * restart the serve the installed serve service runs when that serve is on an older build, and to verify it came
 * back on this one. Serve only: a stale serve the service does not run (started by hand, or from another install)
 * is reported as `manual` and left to doctor's `runtime_build_skew` and `gbrain upgrade --restart-only`.
 */
export async function restartStaleServeService(): Promise<ServeRestartOutcome> {
  const services = hostServices();
  if (!services.serve) return { outcome: 'no_service' };
  const { sources, close, pidFile } = await hostSources();
  try {
    const collectServe = async () => (await collectHostProcesses(sources)).filter(p => p.role === 'serve');
    const root = ownInstallRoot();
    const onDisk = installedVersion(root);
    if (onDisk !== VERSION) return { outcome: 'manual', detail: `the install on disk holds ${onDisk ? `v${onDisk}` : 'an unknown build'}, not this autopilot's v${VERSION}; run \`gbrain upgrade --restart-only\`` };
    let installedMs: number | null = null;
    try { installedMs = statSync(join(root!, 'package.json')).mtimeMs; } catch { /* no install time: a serve with no recorded build stays as it is */ }
    const plan = planServeRestart(await collectServe(), services.serve, VERSION, root, installedMs);
    if (!('steps' in plan)) return plan;
    const { probeCliSocket } = await import('../core/cli-socket/probe.ts');
    const warmBefore = await probeCliSocket();
    const startedMs = Date.now();
    const results = await runRestartSteps(plan, hostExecutor(pidFile));
    const verified = await verifyRestart(plan, startedMs, warmBefore, {
      collect: collectServe, probeWarmSocket: () => probeCliSocket(),
      sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now(),
    }, { timeoutMs: VERIFY_TIMEOUT_MS, pollMs: VERIFY_POLL_MS });
    const problems = [...results.filter(r => !r.ok).map(r => r.detail), ...verified.problems];
    return { outcome: verified.ok ? 'restarted' : 'unverified', detail: `${describeSteps(plan).join(' ')}${problems.length ? `; ${problems.join(' ')}` : ''}` };
  } finally {
    await close();
  }
}

export type ServeRestartDeps = { state: { tried: boolean }; restart: () => Promise<ServeRestartOutcome> };
const SERVE_RESTART_DEPS: ServeRestartDeps = { state: { tried: false }, restart: restartStaleServeService };

/**
 * #7475: the autopilot daemon calls this each tick. In auto mode, under the self-upgrade swap's own quiet-hours and
 * idle gates, the autopilot (relaunched on the new build after its swap) restarts the stale serve the serve service
 * runs, and audits the outcome as `restart_serve`. One attempt per autopilot process; the relaunch after the next
 * swap tries again. Never throws.
 */
export async function restartServeAfterSelfUpgrade(isIdle: () => Promise<boolean>, deps: ServeRestartDeps = SERVE_RESTART_DEPS): Promise<void> {
  if (deps.state.tried) return;
  try {
    const cfg = loadConfig();
    if (!cfg || resolveSelfUpgradeMode(cfg) !== 'auto') return;
    if (evaluateQuietHours(resolveQuietHoursWindow(cfg.self_upgrade?.quiet_hours), new Date()) === 'allow') return;
    if (!await isIdle()) return;
    deps.state.tried = true;
    const result = await deps.restart();
    if (!('detail' in result)) return;
    logSelfUpgrade({ channel: 'autopilot', action: 'restart_serve', current: VERSION, outcome: result.outcome === 'restarted' ? 'applied' : 'skipped', reason: result.outcome });
    console.log(`[autopilot] serve ${result.outcome === 'restarted' ? `restarted onto v${VERSION}` : `still on another build (${result.outcome})`}: ${result.detail}`);
  } catch {
    /* the serve restart must never break the autopilot tick */
  }
}

function printPlan(plan: RestartPlan, warm: WarmSocketState, notes: string[]): void {
  for (const note of notes) console.log(note);
  if (!plan.stale.length) console.log(`Every gbrain process on this host already runs v${plan.expected}${plan.current.length ? ` (${plan.current.map(describe).join(', ')})` : ' (none is running)'}.`);
  else {
    console.log(`Restarting onto v${plan.expected}:`);
    for (const line of describeSteps(plan)) console.log(`  ${line}`);
    for (const m of plan.manual) console.log(`  manual: ${m.instruction}`);
    if (plan.current.length) console.log(`Already on v${plan.expected}: ${plan.current.map(describe).join(', ')}.`);
  }
  console.log(`Warm CLI socket: ${warm.state}${warm.state === 'refused' ? ` (${warm.reason}${warm.mismatch ? `: ${warm.mismatch}` : ''})` : ''}.`);
}
