/**
 * GBRA-175: one upgrade restarts every gbrain process the brain runs on this
 * host, or refuses with the exact step for each process it cannot restart, and
 * then proves that every process reports one build and that the warm CLI
 * socket accepts it. A long-running process keeps the code it loaded at start
 * (#7245), so an upgrade that restarts nothing leaves serve, the jobs
 * supervisor and its worker, autopilot and every MCP server on the old build
 * while one-shot commands and job children run the new one.
 *
 * Three steps, each with its side effects behind an interface so tests drive
 * them with fakes:
 *
 * - `collectHostProcesses`: the processes this brain runs on this host. The
 *   process table is the authority on what runs (role by command line, every
 *   ancestor pid, start time, the version the process's install holds; on
 *   Linux only processes whose GBRAIN_HOME is this brain's); the consumer
 *   heartbeat rows (Postgres), the supervisor PID file and the worker registry
 *   add the build each pid loaded, and a record whose pid the table does not
 *   list as a gbrain process is stale and dropped. Read-only.
 * - `planRestart`: which processes are not on the installed build and how each
 *   restarts: serve and autopilot through their installed service, only when
 *   the service's own process runs them; the supervisor with `jobs supervisor
 *   stop` and `start --detach` with the options it was launched with (its
 *   worker restarts with it); an MCP stdio server by stopping it when
 *   `--stop-mcp` says so (its harness starts the new build on reconnect).
 *   Anything else is a manual step, and any manual step refuses the whole
 *   restart before anything changes.
 * - `runRestartSteps` then `verifyRestart`: run the steps in that order, then
 *   poll until no restarted pid is alive, every process reports the installed
 *   build (or, reporting none, started after the restart from an install that
 *   holds it), each restarted role and supervised worker came back, and the
 *   warm CLI socket, when serve had one, accepts this build.
 */
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { parseGlobalFlags } from './cli-options.ts';

export type ProcessRole = 'serve' | 'autopilot' | 'supervisor' | 'worker' | 'mcp' | 'sync';

export interface HostProcess {
  pid: number;
  /** The nearest gbrain process above it in the process table; null when none is. */
  ppid: number | null;
  role: ProcessRole;
  /** The build the process runs (in memory); null when it records none. */
  version: string | null;
  /** Epoch ms the process started; null when unknown. */
  started_ms: number | null;
  /** Every pid above it in the process table, nearest first (which service runs it). */
  ancestors?: number[];
  /** Its arguments after the gbrain entry point, from the process table; absent when the table did not list it. */
  args?: string[];
  /** The version the install it was started from holds now; null when unknown (a compiled binary). */
  install_version?: string | null;
  /** The package directory of the gbrain install it was started from (realpath); null when unknown (a compiled binary). */
  install_root?: string | null;
  /** A worker with no gbrain process above it: the process that started it, which was not recognised as gbrain. */
  unclassified_parent?: { pid: number; executable: string };
}

export interface ProcessTableRow { pid: number; ppid: number; command: string; started_ms: number | null; gbrain_home: string | null | undefined; cwd?: string | null }

export interface ProcessSources {
  /** Live consumer heartbeat rows on this host (Postgres only; PGLite keeps none). */
  heartbeats: () => Promise<Array<{ pid: number; kind: string; version: string | null }>>;
  supervisor: () => { pid: number; version: string | null } | null;
  workers: () => Array<{ pid: number; version: string | null }>;
  /** This user's processes, null when ps cannot run; `gbrain_home` is the GBRAIN_HOME (else HOME) from the process's environment, undefined when unreadable. */
  processTable: () => ProcessTableRow[] | null;
  /** The gbrain install a command line started in `cwd` runs from: its package directory and the version it holds now (null when unknown). */
  install?: (command: string, cwd?: string | null) => { root: string | null; version: string | null };
  /** The package name at a directory, undefined when unreadable: which `src/cli.ts` entry points are gbrain. */
  packageName?: (root: string) => string | null | undefined;
  /** This brain's GBRAIN_HOME (else HOME), resolved. */
  home: string;
  /** Pids never listed: this process and its parents (the upgrade that spawned it). */
  exclude: readonly number[];
}

const SERVE_SUBCOMMANDS_TRANSIENT = new Set(['status', 'install', 'uninstall', 'stop', 'logs', 'help']);
/** `gbrain autopilot` forms that report or change the service and exit; anything else is the daemon (`--repo <path>`, `start`). */
const AUTOPILOT_TRANSIENT = new Set(['status', 'install', 'uninstall', 'pause', 'resume', 'help']);
const INTERPRETERS = new Set(['bun', 'node']);
/** Interpreter flags whose value is the next token (gbrain's own sanitized re-run passes them this way: cli-preflight.ts PATH_RUNTIME_FLAGS). */
const VALUE_FLAGS = new Set(['--preload', '-r', '--require', '--import', '--config', '-c', '--env-file', '--tsconfig-override', '--cwd']);

/**
 * What decides whether a script entry point is gbrain: the process's working directory, which a relative entry
 * resolves against (null when unreadable), and the package name at a directory (undefined when unreadable).
 */
export interface EntryLookup { cwd?: string | null; packageName?: (root: string) => string | null | undefined }

/** A `src/cli.ts` entry is gbrain when the package two levels up is named gbrain; an unreadable package falls back to a gbrain path. */
function isGbrainCli(path: string, packageName: EntryLookup['packageName']): boolean {
  if (!/(^|\/)src\/cli\.ts$/.test(path)) return false;
  const name = packageName?.(dirname(dirname(path)));
  return name === undefined ? /gbrain[^\s]*\/src\/cli\.ts$/.test(path) : name === 'gbrain';
}

/**
 * The gbrain entry point of a command line and the arguments after it, or null when the command is not gbrain
 * itself: a wrapper that starts gbrain as its child (tini, a shell, `timeout`, `bunx`, `bun x`, `bun run <bin>`)
 * is not the gbrain process, while `bun run <file>` runs the file in its own process. The value of an interpreter
 * flag the walk does not list is skipped: after it, the entry is the next path. A relative entry is
 * returned resolved against the process's working directory; when that directory is unknown it stays relative and
 * only a gbrain path matches.
 */
export function gbrainEntry(command: string, lookup: EntryLookup = {}): { entry: string; args: string[] } | null {
  const tokens = command.trim().split(/\s+/);
  const isPath = (token: string) => token.includes('/') || /\.[cm]?[jt]s$/.test(token);
  let at = 0;
  if (INTERPRETERS.has(basename(tokens[0]!))) {
    for (at = 1; tokens[at]?.startsWith('-'); at++) if (VALUE_FLAGS.has(tokens[at]!)) at++;
    if (basename(tokens[0]!) === 'bun') {
      if (tokens[at] === 'x') return null;
      if (tokens[at] === 'run') for (at++; tokens[at]?.startsWith('-'); at++) if (VALUE_FLAGS.has(tokens[at]!)) at++;
    }
    if (tokens[at] !== undefined && !isPath(tokens[at]!)) {
      if (tokens[at - 1]!.startsWith('-')) at = tokens.findIndex((token, i) => i > at && isPath(token));
      else if (basename(tokens[0]!) === 'bun') return null;
    }
  }
  const token = tokens[at];
  if (token === undefined) return null;
  const unresolved = isPath(token) && !isAbsolute(token) && !lookup.cwd;
  const entry = isPath(token) && !isAbsolute(token) && lookup.cwd ? resolve(lookup.cwd, token) : token;
  if (basename(entry) !== 'gbrain' && !isGbrainCli(entry, unresolved ? undefined : lookup.packageName)) return null;
  return { entry, args: tokens.slice(at + 1) };
}

/** The role of a gbrain command line, or null when it is not a long-running gbrain process. */
export function classifyGbrainCommand(command: string, lookup: EntryLookup = {}): ProcessRole | null {
  const args = gbrainEntry(command, lookup)?.args;
  if (!args) return null;
  const [sub, second] = args.filter(arg => !arg.startsWith('-'));
  if (sub === 'serve') {
    if (second && SERVE_SUBCOMMANDS_TRANSIENT.has(second)) return null;
    return args.includes('--http') ? 'serve' : 'mcp';
  }
  if (sub === 'jobs' && second === 'work') return 'worker';
  if (sub === 'jobs' && second === 'supervisor') return args.some(arg => arg === 'stop' || arg === 'status') ? null : 'supervisor';
  if (sub === 'autopilot') return args.some(arg => AUTOPILOT_TRANSIENT.has(arg.replace(/^--/, ''))) ? null : 'autopilot';
  if (sub === 'sync') return 'sync';
  return null;
}

const installFields = (install: { root: string | null; version: string | null } | undefined) => ({ install_version: install?.version ?? null, install_root: install?.root ?? null });

const HEARTBEAT_ROLES: Record<string, ProcessRole> = { serve: 'serve', jobs: 'worker', autopilot: 'autopilot', mcp: 'mcp', sync: 'sync' };

/** Every gbrain process this brain runs on this host, one per pid. */
export async function collectHostProcesses(sources: ProcessSources): Promise<HostProcess[]> {
  const byPid = new Map<number, HostProcess>();
  const excluded = new Set(sources.exclude);
  const table = sources.processTable();
  const rows = new Map((table ?? []).map(row => [row.pid, row]));
  const ancestry = (ppid: number) => {
    const chain: number[] = [];
    for (let pid = ppid; pid > 1 && chain.length < 64 && !chain.includes(pid); pid = rows.get(pid)?.ppid ?? 0) chain.push(pid);
    return chain;
  };
  for (const row of table ?? []) {
    if (excluded.has(row.pid)) continue;
    if (row.gbrain_home !== undefined && row.gbrain_home !== null && resolve(row.gbrain_home) !== resolve(sources.home)) continue;
    const lookup = { cwd: row.cwd, packageName: sources.packageName };
    const role = classifyGbrainCommand(row.command, lookup);
    if (!role) continue;
    byPid.set(row.pid, { pid: row.pid, ppid: null, role, version: null, started_ms: row.started_ms, ancestors: ancestry(row.ppid),
      args: gbrainEntry(row.command, lookup)!.args, ...installFields(sources.install?.(row.command, row.cwd)) });
  }
  const merge = (pid: number, role: ProcessRole | null, version: string | null) => {
    if (excluded.has(pid)) return;
    const known = byPid.get(pid);
    if (known) {
      if (role === 'supervisor' || role === 'worker') known.role = role;
      known.version = version ?? known.version;
    } else if (role && table === null) {
      byPid.set(pid, { pid, ppid: null, role, version, started_ms: null });
    }
  };
  for (const row of await sources.heartbeats()) merge(row.pid, HEARTBEAT_ROLES[row.kind] ?? null, row.version || null);
  for (const worker of sources.workers()) merge(worker.pid, 'worker', worker.version);
  const supervisor = sources.supervisor();
  if (supervisor) merge(supervisor.pid, 'supervisor', supervisor.version);
  for (const p of byPid.values()) {
    p.ppid = p.ancestors?.find(pid => byPid.has(pid)) ?? null;
    const launcher = p.role === 'worker' && p.ppid === null && p.ancestors?.[0] !== undefined ? rows.get(p.ancestors[0]) : undefined;
    if (launcher) p.unclassified_parent = { pid: launcher.pid, executable: basename(launcher.command.trim().split(/\s+/)[0]!) };
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}

/** An installed service: its restart command and the pid its manager runs now (null when it is not running). */
export interface ServiceHandle { argv: string[]; pid: number | null }

export interface RestartContext {
  /** The installed build every process must run. */
  expected: string;
  /** The installed serve service; null when none is installed. */
  serveService: ServiceHandle | null;
  /** The installed autopilot service; null when none is installed. */
  autopilotService: ServiceHandle | null;
  /** Stop MCP stdio servers (their harness starts the new build on reconnect) instead of refusing. */
  stopMcp: boolean;
  /** The package directory of the install this upgrade replaces (realpath); null when unknown (a compiled binary). */
  ownInstallRoot?: string | null;
  /** What starts autopilot again when it exits, for an autopilot no installed service runs; null when nothing is known to. */
  autopilotLauncher?: AutopilotLauncher | null;
}

/**
 * #8776: a launcher outside launchd and systemd that starts autopilot again when it exits: this brain's own
 * gbrain cron line (the linux-cron install target), or a launcher the operator declared with
 * `self_upgrade.autopilot_launcher external` (a cron entry or wrapper of their own). The restart hands autopilot to
 * it: stop the daemon, then wait `wait_ms` for the launcher to start the installed build. Only the daemon this
 * brain's autopilot lock names (`pid`) is handed over, so another brain's autopilot is never signalled on a host
 * whose process environments cannot be read (macOS).
 */
export interface AutopilotLauncher { kind: 'cron' | 'declared'; wait_ms: number; pid: number | null }

export const launcherName = (launcher: AutopilotLauncher) => launcher.kind === 'cron'
  ? 'this brain\'s gbrain cron line' : 'the launcher self_upgrade.autopilot_launcher declares';

/** Before the swap the installed build is not known yet: every process is stale. */
export const PENDING_BUILD = 'pending';

/** A gbrain package directory inside a Bun global install (`<BUN_INSTALL>/install/global/node_modules/gbrain`): the BUN_INSTALL it belongs to. */
export function bunGlobalCopyOf(pkgDir: string): { bun_install: string } | null {
  const parts = pkgDir.replace(/\/+$/, '').split('/');
  if (parts.length < 6 || parts.slice(-4).join('/') !== 'install/global/node_modules/gbrain') return null;
  return { bun_install: parts.slice(0, -4).join('/') || '/' };
}

/** The steps that move another gbrain install onto the target build, as argv, plus the sentence that names them. */
export function copyFix(root: string, holds: string | null, expected: string): { argv: string[][]; env: Record<string, string>; instruction: string } {
  const release = expected === PENDING_BUILD ? 'the release being installed' : `v${expected}`;
  const copy = bunGlobalCopyOf(root);
  if (copy) {
    const argv = [['bun', 'remove', '-g', 'gbrain'], ['bun', 'add', '-g', `github:garrytan/gbrain#v${expected}`]];
    const shown = argv.map(a => `BUN_INSTALL=${copy.bun_install} ${a.join(' ')}`).join(' && ');
    return { argv, env: { BUN_INSTALL: copy.bun_install }, instruction: `replace the Bun global copy at ${root} (${holds ? `v${holds}` : 'version unknown'}; a pinned copy keeps its pin through bun add alone, so remove it first): \`${shown}\`` };
  }
  const argv = [['git', '-C', root, 'fetch', '--tags', 'origin'], ['git', '-C', root, 'checkout', `v${expected}`], ['bun', 'install', '--cwd', root]];
  return { argv, env: {}, instruction: `move the install at ${root} (${holds ? `v${holds}` : 'version unknown'}) to ${release}: for a git clone, \`${argv.map(a => a.join(' ')).join(' && ')}\`; otherwise start this process from the upgraded install instead` };
}

export type RestartStep =
  | { kind: 'service'; role: 'serve' | 'autopilot'; argv: string[]; pids: number[] }
  | { kind: 'supervisor'; pid: number; workers: number[]; stop: string[]; start: string[]; pid_file: string | null }
  | { kind: 'stop'; role: 'mcp'; pid: number; started_ms: number | null }
  | { kind: 'handoff'; role: 'autopilot'; pid: number; started_ms: number | null; launcher: AutopilotLauncher }
  | { kind: 'replace_copy'; root: string; bun_install: string; from: string | null; to: string; pids: number[] };

export interface ManualStep { role: ProcessRole; pid: number; version: string | null; argv: string[]; instruction: string }

export interface RestartPlan {
  expected: string;
  /** Processes already on the installed build; left running. */
  current: HostProcess[];
  /** Processes on another build, or reporting none. */
  stale: HostProcess[];
  steps: RestartStep[];
  manual: ManualStep[];
}

const label = (p: Pick<HostProcess, 'role' | 'pid' | 'version'>) => `${p.role} pid ${p.pid} (${p.version ? `v${p.version}` : 'build not recorded'})`;

/**
 * The supervisor's stop and start commands from the arguments it runs with, so the restart keeps its queue, concurrency and PID file.
 * A `--flag=value` token that is neither a global flag nor --job-isolation was ignored by the supervisor that holds it (an older release) and is refused by this one, so it is dropped: the restart runs what the supervisor applied.
 */
export function supervisorRestartArgv(args: readonly string[]): { stop: string[]; start: string[]; pid_file: string | null } {
  let local: ReadonlySet<string> = new Set();
  try { local = new Set(parseGlobalFlags([...args]).rest); } catch { /* an unparseable global flag: keep every token, as before */ }
  const rest = args.slice(args.indexOf('supervisor') + 1).filter(arg => arg !== 'start' && arg !== '--detach' && arg !== '--json' && !(/^--[^=]+=/.test(arg) && local.has(arg) && !arg.startsWith('--job-isolation=')));
  const at = rest.indexOf('--pid-file');
  const pidFile = at === -1 ? null : rest[at + 1] ?? null;
  return {
    stop: ['gbrain', 'jobs', 'supervisor', 'stop', ...(pidFile ? ['--pid-file', pidFile] : []), '--json'],
    start: ['gbrain', 'jobs', 'supervisor', 'start', '--detach', ...rest, '--json'],
    pid_file: pidFile,
  };
}

export function planRestart(processes: readonly HostProcess[], ctx: RestartContext): RestartPlan {
  const stale = processes.filter(p => p.version !== ctx.expected);
  const current = processes.filter(p => p.version === ctx.expected);
  const manual: ManualStep[] = [];
  const services = new Map<'serve' | 'autopilot', number[]>();
  const supervisors = new Map<number, number[]>();
  const stops: RestartStep[] = [];
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const addService = (role: 'serve' | 'autopilot', pid: number) => services.set(role, [...(services.get(role) ?? []), pid]);
  const handoffs = new Map<number, Extract<RestartStep, { kind: 'handoff' }>>();
  const launcherOf = (p: HostProcess) => (ctx.autopilotLauncher?.pid === p.pid && p.started_ms !== null && p.args ? ctx.autopilotLauncher : null);
  const addHandoff = (p: HostProcess, launcher: AutopilotLauncher) => handoffs.set(p.pid, { kind: 'handoff', role: 'autopilot', pid: p.pid, started_ms: p.started_ms, launcher });
  const runsUnder = (p: HostProcess, service: ServiceHandle | null) => !!service && service.pid !== null && (p.pid === service.pid || !!p.ancestors?.includes(service.pid));
  const kill = (p: HostProcess, instruction: string) => manual.push({ role: p.role, pid: p.pid, version: p.version, argv: ['kill', String(p.pid)], instruction });

  const copies = new Map<string, Extract<RestartStep, { kind: 'replace_copy' }>>();
  for (const p of stale) {
    const parent = p.ppid === null ? undefined : byPid.get(p.ppid);
    if (ctx.ownInstallRoot && p.install_root && p.install_root !== ctx.ownInstallRoot && p.install_version !== ctx.expected) {
      const copy = bunGlobalCopyOf(p.install_root);
      if (!copy) {
        const fix = copyFix(p.install_root, p.install_version ?? null, ctx.expected);
        manual.push({ role: p.role, pid: p.pid, version: p.version, argv: fix.argv[0]!,
          instruction: `${label(p)} runs from another gbrain install, which this upgrade does not change, so a restart brings it back on the old build: ${fix.instruction}; then run the upgrade again.` });
        continue;
      }
      const known = copies.get(p.install_root);
      if (known) known.pids.push(p.pid);
      else copies.set(p.install_root, { kind: 'replace_copy', root: p.install_root, bun_install: copy.bun_install, from: p.install_version ?? null, to: ctx.expected, pids: [p.pid] });
    }
    switch (p.role) {
      case 'serve':
        if (runsUnder(p, ctx.serveService)) addService('serve', p.pid);
        else kill(p, `${label(p)} was not started by the installed serve service${ctx.serveService ? (ctx.serveService.pid === null ? ' (the service is not running)' : ` (the service runs pid ${ctx.serveService.pid})`) : ''}: stop it (\`kill ${p.pid}\`, SIGTERM drains it) and start it again the way it was launched.`);
        break;
      case 'autopilot':
        if (runsUnder(p, ctx.autopilotService)) addService('autopilot', p.pid);
        else if (launcherOf(p)) addHandoff(p, launcherOf(p)!);
        else if (ctx.autopilotLauncher?.pid === p.pid) kill(p, `${label(p)} is known only from its heartbeat row (the process table could not be read), so the upgrade cannot confirm it is the process to stop before handing autopilot to its launcher: stop it (\`kill ${p.pid}\`) and let the launcher start it again, then run the upgrade.`);
        else if (ctx.autopilotLauncher) kill(p, `${label(p)} is not the daemon this brain's autopilot lock names (it names ${ctx.autopilotLauncher.pid === null ? 'no running autopilot' : `pid ${ctx.autopilotLauncher.pid}`}), so the upgrade does not hand it to ${launcherName(ctx.autopilotLauncher)}: if it is this brain's autopilot, stop it (\`kill ${p.pid}\`) and let the launcher start it again, then run the upgrade; if it serves another brain, upgrade from that brain.`);
        else manual.push({ role: p.role, pid: p.pid, version: p.version, argv: ['gbrain', 'autopilot', '--install'],
          instruction: `${label(p)} was started outside gbrain's autopilot service (by a cron entry, a wrapper or by hand), so the upgrade cannot restart it. `
            + 'Either run `gbrain autopilot --install`, which runs autopilot under launchd, systemd or a gbrain cron line so every upgrade restarts it (retire the launcher that starts it now first, or both race for the autopilot lock), '
            + `or, when that launcher starts autopilot again within 5 minutes of it exiting, \`gbrain config set self_upgrade.autopilot_launcher external\` lets the upgrade stop it and wait for the launcher. By hand: \`kill ${p.pid}\` and start it again the way it was launched.` });
        break;
      case 'supervisor':
        if (p.args) supervisors.set(p.pid, supervisors.get(p.pid) ?? []);
        else kill(p, `${label(p)}: its launch options could not be read from the process table, so it is not restarted with defaults: stop it (\`gbrain jobs supervisor stop\`) and start it again the way it was launched.`);
        break;
      case 'worker':
        if (parent?.role === 'supervisor' && parent.args) supervisors.set(parent.pid, [...(supervisors.get(parent.pid) ?? []), p.pid]);
        else if (parent?.role === 'autopilot' && runsUnder(parent, ctx.autopilotService)) addService('autopilot', parent.pid);
        else if (parent?.role === 'autopilot' && launcherOf(parent)) addHandoff(parent, launcherOf(parent)!);
        else kill(p, `${label(p)} is not run by a jobs supervisor this restart can relaunch${parent?.role === 'autopilot' ? ' (its autopilot runs under no installed service)' : ''}${p.unclassified_parent ? ` (its parent, pid ${p.unclassified_parent.pid} (\`${p.unclassified_parent.executable}\`), is not a process this restart recognises as gbrain)` : ''}: stop it (\`kill ${p.pid}\`, SIGTERM drains its jobs) and start \`gbrain jobs work\` again the way it was launched, or run workers under \`gbrain jobs supervisor start --detach\`.`);
        break;
      case 'mcp':
        if (ctx.stopMcp && p.args) stops.push({ kind: 'stop', role: 'mcp', pid: p.pid, started_ms: p.started_ms });
        else if (ctx.stopMcp) kill(p, `${label(p)} is known only from its heartbeat row (the process table could not be read), so it is not signalled: stop it yourself if it is a gbrain MCP server, and reconnect gbrain in its harness afterwards.`);
        else kill(p, `${label(p)} is an MCP server an agent harness started: rerun with --stop-mcp to stop it during the restart and reconnect gbrain in that harness afterwards (Claude Code: /mcp, then reconnect; other harnesses: start a new session).`);
        break;
      case 'sync':
        manual.push({ role: p.role, pid: p.pid, version: p.version, argv: ['gbrain', 'sync', 'status', '--json'],
          instruction: `${label(p)} is a running gbrain sync: let it finish (\`gbrain sync status --json\` shows its progress), then run the restart again.` });
        break;
    }
  }
  const steps: RestartStep[] = [...copies.values()];
  const serve = services.get('serve');
  if (serve && ctx.serveService) steps.push({ kind: 'service', role: 'serve', argv: ctx.serveService.argv, pids: [...new Set(serve)] });
  const autopilot = services.get('autopilot');
  if (autopilot && ctx.autopilotService) steps.push({ kind: 'service', role: 'autopilot', argv: ctx.autopilotService.argv, pids: [...new Set(autopilot)] });
  for (const [pid, workers] of supervisors) steps.push({ kind: 'supervisor', pid, workers, ...supervisorRestartArgv(byPid.get(pid)!.args!) });
  steps.push(...handoffs.values(), ...stops);
  return { expected: ctx.expected, current, stale, steps, manual };
}

export interface RestartExecutor {
  run: (argv: string[], env?: Record<string, string>) => { status: number | null; output: string };
  /** SIGTERM the MCP server or autopilot at pid only if it is still the process the plan saw: 'changed' when the pid now names another process. */
  terminate: (pid: number, startedMs: number | null, role: 'mcp' | 'autopilot') => 'stopped' | 'gone' | 'changed';
  /** The live supervisor's pid now (read from its PID file, the default one when null), or null. */
  supervisorPid: (pidFile: string | null) => number | null;
  sleep: (ms: number) => Promise<void>;
}

export interface StepResult { step: RestartStep; ok: boolean; detail: string }

const SUPERVISOR_RESPAWN_GRACE_MS = 3_000;
const failed = (argv: string[], r: { status: number | null; output: string }) => `\`${argv.join(' ')}\` exited ${r.status ?? 'without a status'}: ${r.output.trim().split('\n')[0] ?? ''}`;

export async function runRestartSteps(plan: RestartPlan, exec: RestartExecutor): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of plan.steps) {
    if (step.kind === 'replace_copy') {
      const env = { BUN_INSTALL: step.bun_install };
      const probe = ['git', 'ls-remote', '--exit-code', '--tags', 'https://github.com/garrytan/gbrain', `refs/tags/v${step.to}`];
      const add = ['bun', 'add', '-g', `github:garrytan/gbrain#v${step.to}`];
      const probed = exec.run(probe);
      if (probed.status !== 0) { results.push({ step, ok: false, detail: `v${step.to} has no release tag, so the copy at ${step.root} was left as it is (${failed(probe, probed)})` }); continue; }
      const removed = exec.run(['bun', 'remove', '-g', 'gbrain'], env);
      const added = removed.status === 0 ? exec.run(add, env) : removed;
      if (added.status === 0) { results.push({ step, ok: true, detail: `replaced the Bun global copy at ${step.root} with v${step.to}` }); continue; }
      const restored = removed.status === 0 && step.from ? exec.run(['bun', 'add', '-g', `github:garrytan/gbrain#v${step.from}`], env).status === 0 : false;
      results.push({ step, ok: false, detail: `could not replace the copy at ${step.root} (${failed(removed.status === 0 ? add : ['bun', 'remove', '-g', 'gbrain'], added)})${restored ? `; restored v${step.from}` : ''}` });
    } else if (step.kind === 'service') {
      const r = exec.run(step.argv);
      results.push({ step, ok: r.status === 0, detail: r.status === 0 ? `ran \`${step.argv.join(' ')}\`` : failed(step.argv, r) });
    } else if (step.kind === 'supervisor') {
      const stop = exec.run(step.stop);
      if (stop.status !== 0) { results.push({ step, ok: false, detail: failed(step.stop, stop) }); continue; }
      await exec.sleep(SUPERVISOR_RESPAWN_GRACE_MS);
      const respawned = exec.supervisorPid(step.pid_file);
      if (respawned !== null && respawned !== step.pid) {
        results.push({ step, ok: true, detail: `stopped supervisor pid ${step.pid}; its service manager started pid ${respawned}` });
        continue;
      }
      const start = exec.run(step.start);
      results.push({ step, ok: start.status === 0, detail: start.status === 0 ? `stopped supervisor pid ${step.pid} and started it again with \`${step.start.join(' ')}\`` : failed(step.start, start) });
    } else if (step.kind === 'handoff') {
      const outcome = exec.terminate(step.pid, step.started_ms, 'autopilot');
      results.push({ step, ok: outcome !== 'changed', detail: outcome === 'changed'
        ? `pid ${step.pid} is no longer the autopilot the plan saw, so it was not signalled`
        : `stopped autopilot pid ${step.pid}; ${launcherName(step.launcher)} starts it again` });
    } else {
      const outcome = exec.terminate(step.pid, step.started_ms, 'mcp');
      results.push({ step, ok: outcome !== 'changed', detail: outcome === 'changed'
        ? `pid ${step.pid} is no longer the MCP server the plan saw, so it was not signalled`
        : `stopped mcp pid ${step.pid}; reconnect gbrain in its harness` });
    }
  }
  return results;
}

/** `mismatch` names the identity part an `identity_mismatch` refusal differed on (`version`, `env GBRAIN_MODEL`, ...). */
export type WarmSocketState = { state: 'absent' } | { state: 'accepted' } | { state: 'refused'; reason: string; mismatch?: string };

/** A refusal for anything but a non-version identity part means serve does not accept this build; an env or config difference is this shell's, not the upgrade's. */
function refusesThisBuild(warm: WarmSocketState): boolean {
  return warm.state === 'refused' && !(warm.reason === 'identity_mismatch' && warm.mismatch && warm.mismatch !== 'version');
}

const restartedPids = (plan: RestartPlan) => new Set(plan.steps.flatMap(step => step.kind === 'service' ? step.pids : step.kind === 'supervisor' ? [step.pid, ...step.workers] : step.kind === 'stop' || step.kind === 'handoff' ? [step.pid] : []));

/** Processes that came back on a build other than the target, with the install each one runs from. */
export function mismatchedBuilds(plan: RestartPlan, processes: readonly HostProcess[]): HostProcess[] {
  const restarted = restartedPids(plan);
  return processes.filter(p => !restarted.has(p.pid) && (p.version ? p.version !== plan.expected : !!p.install_version && p.install_version !== plan.expected));
}

/** What still stands between the host and one build after a restart; empty when it is done. */
export function restartProblems(plan: RestartPlan, processes: readonly HostProcess[], restartStartedMs: number,
  warm: { before: WarmSocketState; after: WarmSocketState }, lockPid: number | null = null): string[] {
  const problems: string[] = [];
  const live = new Map(processes.map(p => [p.pid, p]));
  const restarted = restartedPids(plan);
  for (const pid of restarted) {
    const p = live.get(pid);
    if (p) problems.push(`${label(p)} is still running after the restart.`);
  }
  const fresh = processes.filter(p => !restarted.has(p.pid));
  const mismatched = new Set(mismatchedBuilds(plan, processes));
  for (const p of fresh) {
    const from = p.install_root ? `; it runs from ${p.install_root}, which holds ${p.install_version ? `v${p.install_version}` : 'an unknown version'}: ${copyFix(p.install_root, p.install_version ?? null, plan.expected).instruction}` : '';
    if (mismatched.has(p) && p.version) problems.push(`${label(p)} runs a build other than v${plan.expected}${from}.`);
    else if (mismatched.has(p)) problems.push(`${label(p)} reports no build and was started from an install that holds v${p.install_version}${from}.`);
    else if (!p.version && (p.started_ms === null || p.started_ms < restartStartedMs)) problems.push(`${label(p)} reports no build and started before the restart.`);
  }
  for (const step of plan.steps) {
    if (step.kind === 'stop' || step.kind === 'replace_copy') continue;
    if (step.kind === 'handoff') {
      if (!fresh.some(p => p.role === 'autopilot' && p.pid === lockPid && p.started_ms !== null && p.started_ms >= restartStartedMs)) {
        problems.push(`autopilot did not come back after it was stopped for ${launcherName(step.launcher)} to start again (this brain's autopilot lock names ${lockPid === null ? 'no autopilot' : `pid ${lockPid}, which is not an autopilot started after the restart`}).`);
      }
      continue;
    }
    const role = step.kind === 'supervisor' ? 'supervisor' : step.role;
    if (!fresh.some(p => p.role === role)) {
      problems.push(`${role} did not come back after ${step.kind === 'service' ? `\`${step.argv.join(' ')}\`` : 'the supervisor restart'}.`);
    } else if (step.kind === 'supervisor' && step.workers.length && !fresh.some(p => p.role === 'worker' && live.get(p.ppid ?? -1)?.role === 'supervisor' && !restarted.has(p.ppid!))) {
      problems.push(`the jobs worker did not come back under the restarted supervisor (\`${step.start.join(' ')}\`).`);
    }
  }
  if (warm.after.state === 'refused' && refusesThisBuild(warm.after)) problems.push(`The warm CLI socket refused this build (${warm.after.reason}${warm.after.mismatch ? `: ${warm.after.mismatch}` : ''}).`);
  else if (warm.before.state !== 'absent' && warm.after.state === 'absent') problems.push('The warm CLI socket serve had before the restart is gone.');
  return problems;
}

/** Processes that pass verification only by their start time: they record no build and their install's version is unknown (a compiled binary). */
export function unverifiedBuilds(plan: RestartPlan, processes: readonly HostProcess[]): string[] {
  const restarted = restartedPids(plan);
  return processes.filter(p => !restarted.has(p.pid) && !p.version && !p.install_version)
    .map(p => `${label(p)} started after the restart but records no build, so its build is inferred from its start time.`);
}

export interface VerifyDeps {
  collect: () => Promise<HostProcess[]>;
  probeWarmSocket: () => Promise<WarmSocketState>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** This brain's autopilot lock pid, re-read on every poll: a hand-off is done only when an autopilot started after the restart holds it. */
  autopilotLockPid?: () => number | null;
}

export interface VerifyResult { ok: boolean; processes: HostProcess[]; warm_socket: WarmSocketState; problems: string[]; unverified: string[] }

export async function verifyRestart(plan: RestartPlan, restartStartedMs: number, warmBefore: WarmSocketState, deps: VerifyDeps,
  opts: { timeoutMs: number; pollMs: number }): Promise<VerifyResult> {
  const deadline = deps.now() + opts.timeoutMs;
  for (;;) {
    const processes = await deps.collect();
    const warm = await deps.probeWarmSocket();
    let lockPid: number | null = null;
    try { lockPid = deps.autopilotLockPid?.() ?? null; } catch { lockPid = null; }
    const problems = restartProblems(plan, processes, restartStartedMs, { before: warmBefore, after: warm }, lockPid);
    if (!problems.length || deps.now() >= deadline) return { ok: !problems.length, processes, warm_socket: warm, problems, unverified: unverifiedBuilds(plan, processes) };
    await deps.sleep(opts.pollMs);
  }
}
