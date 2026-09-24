/**
 * `gbrain mcp expose` — publish `gbrain serve --http` on the user's Tailscale
 * tailnet (or, with `--funnel`, on the public internet through Tailscale
 * Funnel) and keep it running as a user service.
 *
 * Engine-free: never opens the database. Local CLI only (a `mcp`
 * subcommand). Every step is a named check in `--json`; prose goes to stderr
 * when `--json` is set so stdout carries exactly one document.
 *
 * Exit codes: 0 done · 1 failed · 2 needs confirmation (`--yes`) or a step is
 * pending (Tailscale login not completed, tailnet health still pending).
 *
 * Every side effect (exec, fetch, resolver, prompt, clock, paths) is
 * injectable through `McpExposeDeps` so the command is testable against a
 * fake runner in a tmpdir. Never mutate process.env here — read it through
 * `deps.env`. The health / occupancy probes live in `mcp-expose-probe.ts`.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { promptLineStderr } from '../core/cli-util.ts';
import { gbrainPath, isThinClient, loadConfig, type GBrainConfig } from '../core/config.ts';
import { detectExecutionEnvironment, type ExecutionEnvironment } from '../core/execution-env.ts';
import { validateHarnessArguments } from '../core/harness/arguments.ts';
import { probeLivePgliteHolder } from '../core/bootstrap/uninstall.ts';
import {
  classifyTailscaleError, defaultCommandRunner, findProxiedHandler, findRootHandlers, findTailscaleBinary, isSystemTailscaleBinary,
  parseServeStatusStrict, parseTailscaleStatus, publicUrlFromDnsName, tailscaleDaemonStartHint, tailscaleInstallPlan,
  tailscaleLoginArgv, tailscaleManualLoginCommand, tailscaleServeArgv, tailscaleServeOffArgv, tailscaleSetOperatorCommand,
  TAILSCALE_ADMIN_ACL_URL, TAILSCALE_ADMIN_DNS_URL, TAILSCALE_BINARY_CANDIDATES, TAILSCALE_DOWNLOAD_URL, TAILSCALE_FUNNEL_KB_URL,
  TAILSCALE_SERVE_STATUS_ARGV, TAILSCALE_STATUS_ARGV,
  type CommandResult, type CommandRunner, type ServeHandler, type ServeStatusView, type TailscaleStatus,
} from '../core/tailscale.ts';
import {
  defaultLookup, defaultTcpProbe, pollHealth, probeHealth, probeOccupied, tryFetch, unresolvedDetail,
  type FetchOutcome, type HostLookup, type ProbeFetch, type TcpProbe,
} from './mcp-expose-probe.ts';
// The probes were peeled into `mcp-expose-probe.ts`; the default TCP probe keeps its import site here.
export { defaultTcpProbe };
import {
  adminTokenPath as adminTokenPathFor, detectServiceTarget, ensureAdminToken, installServeService, launchdBootoutFailed, launchdPlistPath,
  readExposeReceipt, receiptPath as receiptPathFor, renderServeWrapper, resolveServeGbrainCommand, serveCommandArgv,
  serveDir as defaultServeDir, serveErrPath, serveLogPath, serveServiceState, systemdUnitPath, SYSTEMCTL_USER_BUS_PROBE_ARGV,
  SERVE_LAUNCHD_LABEL, SERVE_SYSTEMD_UNIT, uninstallServeService, wrapperPath as wrapperPathFor, writeExposeReceipt,
  type ExposeReceipt, type ServiceState, type ServiceTarget, type UninstallServiceResult,
} from '../core/serve-service.ts';
import { shellQuote } from '../core/mcp-registration.ts';

export const MCP_EXPOSE_HELP = `gbrain mcp expose — publish the MCP server on your Tailscale tailnet and keep it running

gbrain mcp expose [--port N] [--funnel] [--surface verbs|starter|full] [--enable-dcr]
                  [--no-tailscale] [--no-service] [--no-install] [--force]
                  [--dry-run] [--yes] [--json]
gbrain mcp expose --status [--json]
gbrain mcp expose --remove [--yes] [--json]

Steps (each a named check in --json): plan, consent, tailscale.binary, tailscale.login,
tailscale.identity, tailscale.publish, admin_token, service, verify.local, verify.tailnet, receipt.
Nothing is published until Tailscale reports HTTPS certificates (and, with --funnel, the Funnel
node attribute) enabled — otherwise exit 2 with the admin URL to fix it.

--port N          Local port for the gbrain HTTP server (default: 3131)
--funnel          Publish on the public internet via Tailscale Funnel (cloud agents:
                  Grok Bot, Muse, ChatGPT). Default is tailnet-only — your own devices.
--surface X       MCP tool surface: verbs | starter | full (default: full)
--enable-dcr      Allow OAuth Dynamic Client Registration on the server
--no-tailscale    Skip every Tailscale step (you publish the port yourself)
--no-service      Publish only; do not install or start the user service
--no-install      Never install Tailscale; exit 1 with the install plan when it is missing
--force           Take over a foreign tailscale serve handler on :443; with --remove also
                  delete the admin token file, and (without a receipt) turn off a :443 handler
                  for --port that no wrapper, unit or service of gbrain's corroborates
--dry-run         Print the plan and stop (exit 0, no changes)
--yes             Skip the confirmation prompt (required when not on a TTY)
--status          Re-probe the published server, the service and both health URLs. Without a
                  receipt it looks for leftovers of an interrupted run (exit 1 when any are found)
--remove          Stop the service, clear our serve/funnel handler, delete wrapper + receipt.
                  Without a receipt (an interrupted run) it recovers from what is on disk:
                  the wrapper, the launchd/systemd unit and the :443 handler for --port (the
                  handler only when the wrapper, unit or service corroborates it, or --force).
--json            One JSON document on stdout; prose moves to stderr

A host with no brain config is refused (no_brain_config) unless --no-service: a service there
would only crash-loop. Anything listening on 127.0.0.1:<port> — a TCP connect that is accepted,
or any HTTP answer — counts as occupied. --no-tailscale is refused while a receipt says the brain
is published on the tailnet (tailscale_receipt_present): --remove first.

Exit codes: 0 done · 1 failed · 2 confirmation needed or a step is pending (re-run).
Env: GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS bounds the wait for \`tailscale up\` (default 300000).

Next: gbrain mcp grant NAME --harness ID --profile memory-writer --source default --url URL/mcp \\
        --admin-token-file ~/.gbrain/serve/admin-token --credentials-out /private/NAME.json
`;

export const MCP_EXPOSE_ARGUMENTS = {
  values: ['--port', '--surface'],
  flags: ['--funnel', '--enable-dcr', '--no-tailscale', '--no-service', '--no-install', '--force', '--dry-run', '--yes', '--json', '--status', '--remove', '--help', '-h'],
  exclusive: [['--status', '--remove'], ['--funnel', '--no-tailscale'], ['--dry-run', '--status'], ['--dry-run', '--remove']],
} as const;

export const DEFAULT_EXPOSE_PORT = 3131;
/** `tailscale serve|funnel --bg` is killed after this long — it blocks (waiting for an enablement step) rather than failing. */
const PUBLISH_TIMEOUT_MS = 60_000;
/** `tailscale serve|funnel --https=443 --set-path=/ off`. */
const SERVE_OFF_TIMEOUT_MS = 30_000;
/** `tailscale status --json` and `tailscale serve status --json` (read-only). */
const STATUS_READ_TIMEOUT_MS = 15_000;
/** After `open -a Tailscale` on a fresh brew install: poll `status --json` this many times, this far apart, until the app's daemon answers. */
const APP_DAEMON_POLL_ATTEMPTS = 20;
const APP_DAEMON_POLL_INTERVAL_MS = 1_000;
const SURFACES = ['verbs', 'starter', 'full'] as const;
type Surface = (typeof SURFACES)[number];

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface McpExposeDeps {
  platform?: string;
  /** Read-only view of the environment (USER, HOME, GBRAIN_HOME, GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS). */
  env?: Record<string, string | undefined>;
  home?: string;
  user?: string;
  uid?: number;
  serveDir?: string;
  gbrainEnvFile?: string;
  plistPath?: string;
  unitPath?: string;
  loadConfig?: () => GBrainConfig | null;
  executionEnv?: ExecutionEnvironment;
  run?: CommandRunner;
  which?: (name: string) => string | null;
  fileExists?: (path: string) => boolean;
  fetch?: ProbeFetch;
  /** Bounded TCP connect to `host:port` (true on connect, false on refusal / timeout); default `node:net`. Tests inject a fake. */
  tcpProbe?: TcpProbe;
  /**
   * Resolver consulted after a tailnet `/health` fetch REJECTS (Bun's fetch
   * reports an unresolvable name and a refused connection identically);
   * default `dns.promises.lookup`. Tests inject a fake — never the real one.
   */
  lookup?: HostLookup;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string | null>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  gbrainCommand?: string[];
  runtimeDir?: string;
  randomHex?: () => string;
  /** Health polling budget (ms). Tests shrink these. */
  localHealthMs?: number;
  tailnetHealthMs?: number;
  healthIntervalMs?: number;
  /** Milliseconds the login step waits for `tailscale up` (default GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS or 300000). */
  loginTimeoutMs?: number;
  /** Read-only PGLite lock probe (default `probeLivePgliteHolder`; never opens the engine). */
  pgliteHolder?: PgliteHolderProbe;
}

/** Matches `probeLivePgliteHolder`'s `LiveHolder | null` (`serve` is what the lock file recorded; `command` is optional detail). */
export type PgliteHolderProbe = (dbPath: string) => { pid: number; serve?: boolean; command?: string } | null;

interface Check { name: string; status: 'ok' | 'warn' | 'fail' | 'skipped' | 'pending' | 'planned'; detail: string }

type ExposeStatus = 'exposed' | 'pending' | 'planned' | 'error' | 'removed' | 'not_exposed';

interface Resolved {
  platform: string;
  env: Record<string, string | undefined>;
  home: string;
  user: string;
  uid: number | undefined;
  serveDir: string;
  gbrainEnvFile: string;
  plistPath: string;
  unitPath: string;
  run: CommandRunner;
  which: (name: string) => string | null;
  fileExists: (path: string) => boolean;
  fetch: ProbeFetch;
  tcpProbe: TcpProbe;
  lookup: HostLookup;
  isTTY: boolean;
  prompt: (question: string) => Promise<string | null>;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  executionEnv: ExecutionEnvironment;
  loadConfig: () => GBrainConfig | null;
  gbrainCommand: () => string[];
  runtimeDir: string;
  randomHex?: () => string;
  localHealthMs: number;
  tailnetHealthMs: number;
  healthIntervalMs: number;
  loginTimeoutMs: number;
  pgliteHolder: PgliteHolderProbe;
}

function resolveDeps(deps: McpExposeDeps): Resolved {
  const env = deps.env ?? process.env;
  const home = deps.home ?? env.HOME ?? homedir();
  const which = deps.which ?? ((name: string) => { try { return Bun.which(name, { PATH: env.PATH ?? process.env.PATH ?? '' }); } catch { return null; } });
  const loginEnv = Number(env.GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS);
  return {
    platform: deps.platform ?? process.platform,
    env,
    home,
    user: deps.user ?? env.USER ?? (() => { try { return userInfo().username; } catch { return 'user'; } })(),
    uid: deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined),
    serveDir: deps.serveDir ?? defaultServeDir(),
    gbrainEnvFile: deps.gbrainEnvFile ?? gbrainPath('env'),
    plistPath: deps.plistPath ?? launchdPlistPath(home),
    unitPath: deps.unitPath ?? systemdUnitPath(home),
    run: deps.run ?? defaultCommandRunner,
    which,
    fileExists: deps.fileExists ?? existsSync,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init as RequestInit)),
    tcpProbe: deps.tcpProbe ?? defaultTcpProbe,
    lookup: deps.lookup ?? defaultLookup,
    isTTY: deps.isTTY ?? (process.stdin.isTTY === true && process.stderr.isTTY === true),
    prompt: deps.prompt ?? ((q: string) => promptLineStderr(q)),
    out: deps.stdout ?? ((line: string) => { process.stdout.write(`${line}\n`); }),
    err: deps.stderr ?? ((line: string) => { process.stderr.write(`${line}\n`); }),
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms))),
    executionEnv: deps.executionEnv ?? detectExecutionEnvironment({ env }),
    loadConfig: deps.loadConfig ?? loadConfig,
    gbrainCommand: () => deps.gbrainCommand ?? resolveServeGbrainCommand({ which, fileExists: deps.fileExists }),
    runtimeDir: deps.runtimeDir ?? dirname(process.execPath || ''),
    randomHex: deps.randomHex,
    localHealthMs: deps.localHealthMs ?? 20_000,
    tailnetHealthMs: deps.tailnetHealthMs ?? 30_000,
    healthIntervalMs: deps.healthIntervalMs ?? 1_000,
    loginTimeoutMs: deps.loginTimeoutMs ?? (Number.isFinite(loginEnv) && loginEnv > 0 ? loginEnv : 300_000),
    pgliteHolder: deps.pgliteHolder ?? ((dbPath: string) => { try { return probeLivePgliteHolder(dbPath); } catch { return null; } }),
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ExposeOptions {
  port: number;
  funnel: boolean;
  surface: Surface;
  enableDcr: boolean;
  noTailscale: boolean;
  noService: boolean;
  noInstall: boolean;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  status: boolean;
  remove: boolean;
  help: boolean;
}

/** Throws with a one-line message on any shape error (unknown flag, bad value, conflict). */
export function parseExposeArgs(args: string[]): ExposeOptions {
  validateHarnessArguments(args, MCP_EXPOSE_ARGUMENTS);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const rawPort = value('--port');
  let port = DEFAULT_EXPOSE_PORT;
  if (rawPort !== undefined) {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`invalid --port '${rawPort}' (1-65535)`);
    port = n;
  }
  const rawSurface = value('--surface');
  if (rawSurface !== undefined && !(SURFACES as readonly string[]).includes(rawSurface)) throw new Error(`invalid --surface '${rawSurface}' — pass verbs, starter or full`);
  return {
    port,
    funnel: args.includes('--funnel'),
    surface: (rawSurface as Surface | undefined) ?? 'full',
    enableDcr: args.includes('--enable-dcr'),
    noTailscale: args.includes('--no-tailscale'),
    noService: args.includes('--no-service'),
    noInstall: args.includes('--no-install'),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
    yes: args.includes('--yes'),
    json: args.includes('--json'),
    status: args.includes('--status'),
    remove: args.includes('--remove'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

// ---------------------------------------------------------------------------
// Session: check ledger + output routing
// ---------------------------------------------------------------------------

class Session {
  readonly checks: Check[] = [];
  readonly nextActions: string[] = [];
  constructor(private readonly d: Resolved, readonly json: boolean) {}
  /** Prose: stderr under --json, stdout otherwise. */
  say(line = ''): void { (this.json ? this.d.err : this.d.out)(line); }
  check(name: string, status: Check['status'], detail: string): Check {
    const c = { name, status, detail };
    this.checks.push(c);
    return c;
  }
  finish(status: ExposeStatus, code: number, extra: { receipt?: ExposeReceipt | null; reason?: string; message?: string; plan?: string[] } = {}): number {
    if (extra.message) this.say(`${status}: ${extra.message}`);
    if (this.json) {
      this.d.out(JSON.stringify({
        status, receipt: extra.receipt ?? null, checks: this.checks, next_actions: this.nextActions,
        ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.message ? { message: extra.message } : {}), ...(extra.plan ? { plan: extra.plan } : {}),
      }));
    }
    return code;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function engineKind(cfg: GBrainConfig | null): ExposeReceipt['engine'] {
  if (!cfg) return 'unknown';
  if (cfg.database_path && !cfg.database_url) return 'pglite';
  if (cfg.database_url || cfg.engine === 'postgres') return 'postgres';
  if (cfg.engine === 'pglite') return 'pglite';
  return 'unknown';
}

interface ServeRead {
  /** null when the read FAILED (non-zero / killed exit, or stdout that is not a JSON object) — never mistaken for an empty config. */
  view: ServeStatusView | null;
  stderr: string;
  status: number | null;
}

/**
 * `tailscale serve status --json`, fail-closed: a non-zero (or killed) exit,
 * or output that is not a JSON object, yields `view: null` so callers refuse
 * to publish over, remove from, or report on a config they could not read.
 * An empty document / `{}` / `null` from exit 0 is the legitimately empty view.
 */
async function readServeView(d: Resolved, binary: string): Promise<ServeRead> {
  const r = await d.run([binary, ...TAILSCALE_SERVE_STATUS_ARGV], { timeoutMs: STATUS_READ_TIMEOUT_MS });
  const view = r.status === 0 ? parseServeStatusStrict(r.stdout) : null;
  return { view, stderr: r.stderr || (r.status !== 0 ? r.stdout : ''), status: r.status };
}

/** A failed serve-status read, classified: the error kind, one detail line (kind + raw stderr + exit status) and the operator fix. */
function describeServeReadFailure(d: Resolved, r: ServeRead): { kind: string; detail: string; fix: string } {
  const cls = classifyTailscaleError(r.stderr, { platform: d.platform, user: d.user });
  const why = r.status === null ? 'killed or not spawned' : r.status === 0 ? 'exit 0 but stdout was not a JSON object' : `exit ${r.status}`;
  return { kind: cls.kind, detail: `could not read tailscale serve status (${why}): ${cls.kind}${cls.raw ? `: ${cls.raw}` : ''}`, fix: cls.fix };
}

async function readStatus(d: Resolved, binary: string): Promise<{ status: TailscaleStatus | null; stderr: string; exit: number | null }> {
  const r = await d.run([binary, ...TAILSCALE_STATUS_ARGV], { timeoutMs: STATUS_READ_TIMEOUT_MS });
  return { status: parseTailscaleStatus(r.stdout), stderr: r.stderr, exit: r.status };
}

async function probeServiceTarget(d: Resolved): Promise<ServiceTarget> {
  let userBus: { status: number | null; stdout: string } | null = null;
  if (d.platform === 'linux' && d.executionEnv === 'local' && d.which('systemctl')) {
    const r = await d.run([...SYSTEMCTL_USER_BUS_PROBE_ARGV], { timeoutMs: 3_000 });
    userBus = { status: r.status, stdout: `${r.stdout}\n${r.stderr}` };
  }
  return detectServiceTarget({ platform: d.platform, executionEnv: d.executionEnv, userBus });
}

function tildify(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A supervisor reports our service as present when it is running or loaded (installed but not up yet). */
const isLiveService = (s: ServiceState | 'skipped' | null | undefined) => s === 'running' || s === 'loaded';

function serviceKindLabel(target: ServiceTarget): string {
  return target === 'macos' ? `launchd ${SERVE_LAUNCHD_LABEL}` : target === 'linux-systemd' ? `systemd (user) ${SERVE_SYSTEMD_UNIT}` : 'manual wrapper';
}

function serviceLabel(target: ServiceTarget, state: ServiceState | 'skipped', d: Resolved): string {
  if (target === 'none') return `manual (no supervisor here) — wrapper: ${tildify(wrapperPathFor(d.serveDir), d.home)}`;
  return `${serviceKindLabel(target)}, ${state}   (log: ${tildify(serveLogPath(d.serveDir), d.home)})`;
}

function manualCommands(d: Resolved, wrapper: string): { foreground: string; background: string } {
  const w = shellQuote(wrapper);
  return { foreground: w, background: `nohup ${w} >> ${shellQuote(serveLogPath(d.serveDir))} 2>> ${shellQuote(serveErrPath(d.serveDir))} &` };
}

function describeHandler(h: ServeHandler): string {
  const target = h.proxy ?? (h.tcpForward ? `raw TCP forward ${h.tcpForward}` : '(non-proxy handler)');
  return `${h.host || '*'}:443/ -> ${target}${h.foreground ? ' (foreground session in another terminal)' : ''}`;
}

/**
 * How LOCAL agents (Claude Code / Codex / opencode on this machine) get wired.
 * Postgres mints fine while the serve runs. PGLite is single-writer: a live
 * serve holds the lock, so `bootstrap harness` refuses to mint (`live_serve`)
 * unless the operator pre-minted a token or provisions a scoped client
 * through the running server's admin API.
 */
function localAgentGuidance(engine: ExposeReceipt['engine'], port: number, tokenHint: string): { lines: string[]; nextActions: string[] } {
  const plain = `gbrain bootstrap harness --yes --port ${port}`;
  if (engine !== 'pglite') return { lines: [plain], nextActions: [plain] };
  const localUrl = `http://127.0.0.1:${port}/mcp`;
  const grant = `gbrain mcp grant local-agents --harness <id> --profile memory-writer --source default --url ${localUrl} --admin-token-file ${tokenHint} --credentials-out /private/local-agents.json`;
  const connect = `gbrain connect ${localUrl} --harness <id> --credentials-file /private/local-agents.json --install`;
  return {
    lines: [
      'PGLite is single-writer, so `gbrain bootstrap harness` cannot mint while this server runs. Either:',
      `(a) mint while the service is stopped — \`gbrain auth create local-agents --scopes read,write\` — then`,
      `    ${plain} --token <value>`,
      `(b) or grant a scoped client through the running server: ${grant}`,
      `    then ${connect}`,
    ],
    nextActions: [
      'gbrain auth create local-agents --scopes read,write   # PGLite: run while the service is stopped, then pass --token',
      `${plain} --token <value>`,
      grant,
      connect,
    ],
  };
}

/** Re-run hint: the user's publish flags + `--yes` (+ `extra`, e.g. ` --no-service`). */
function rerunCommand(opts: ExposeOptions, extra = ''): string {
  return `gbrain mcp expose${args2(opts)} --yes${extra}`;
}

interface ConsentExtra {
  yes: boolean;
  /** Carried into the `pending` document (the `--remove` receipt). */
  receipt?: ExposeReceipt | null;
  /** Message for a non-TTY run without `--yes`. */
  confirmationMessage: string;
  /** Pushed to `next_actions` on a non-TTY run without `--yes`. */
  nextAction?: string;
}

/**
 * The `consent` check. Returns the exit code to hand back when the run must
 * stop (non-TTY without `--yes` → `pending` / 2 / `confirmation_required`;
 * declined at the prompt → `pending` / 2 / `declined`), or null to proceed.
 */
async function confirmOrFinish(d: Resolved, s: Session, question: string, extra: ConsentExtra): Promise<number | null> {
  if (extra.yes) {
    s.check('consent', 'ok', '--yes');
    return null;
  }
  if (!d.isTTY) {
    s.check('consent', 'pending', 'not a TTY and --yes not passed');
    if (extra.nextAction) s.nextActions.push(extra.nextAction);
    return s.finish('pending', 2, { receipt: extra.receipt, reason: 'confirmation_required', message: extra.confirmationMessage });
  }
  const answer = await d.prompt(question);
  if (!answer || !/^y(es)?$/i.test(answer.trim())) {
    s.check('consent', 'pending', 'declined');
    return s.finish('pending', 2, { receipt: extra.receipt, reason: 'declined', message: 'Nothing changed. Re-run with --yes to confirm.' });
  }
  s.check('consent', 'ok', 'confirmed interactively');
  return null;
}

/**
 * The tailscale binary `--status` / `--remove` execute. The receipt's recorded
 * path is honored only when it still exists AND is either what discovery finds
 * now or one of the known install locations — a receipt is 0600 but it is
 * still a file on disk, and an arbitrary path in it must never be run.
 */
function resolveReceiptBinary(d: Resolved, receipt: ExposeReceipt): string | null {
  const found = findTailscaleBinary({ which: d.which, fileExists: d.fileExists });
  const recorded = receipt.tailscale.binary;
  if (recorded && d.fileExists(recorded) && (recorded === found || TAILSCALE_BINARY_CANDIDATES.includes(recorded))) return recorded;
  return found;
}

interface PublishedThisRun { binary: string; hadHandlerBefore: boolean }

/**
 * A throw in the admin-token / service steps after THIS run's
 * `tailscale serve|funnel --bg` succeeded would leave a live handler with no
 * receipt to find it by. Turn it off again — but only when no handler for our
 * port existed before this run (a pre-existing one is the operator's and
 * stays). No receipt is written in that case. Once the early receipt is on
 * disk (`receiptWritten`), nothing is torn down: `--remove` can find it all.
 * Returns the error to re-throw, its message naming the handler state.
 */
async function rollbackAfterThrow(d: Resolved, s: Session, opts: ExposeOptions, published: PublishedThisRun | null, error: unknown, receiptWritten: boolean): Promise<Error> {
  const message = error instanceof Error ? error.message : String(error);
  if (receiptWritten) {
    // The early receipt is on disk: the handler and service are findable, so
    // nothing is torn down here — `--remove` is the operator's clean path.
    s.check('rollback', 'skipped', 'receipt already written; the handler and service stay — run `gbrain mcp expose --remove --yes` to undo, or `--status` to inspect');
    s.nextActions.push('gbrain mcp expose --status', 'gbrain mcp expose --remove --yes');
    return new Error(`${message} — the receipt was already written, so the published handler and the service were left in place (gbrain mcp expose --status / --remove --yes)`);
  }
  if (!published) return error instanceof Error ? error : new Error(message);
  if (published.hadHandlerBefore) {
    s.check('rollback', 'skipped', `a :443 handler for port ${opts.port} existed before this run; left in place, no receipt written`);
    return new Error(`${message} — the tailscale handler for port ${opts.port} was left in place (it existed before this run); no receipt written`);
  }
  const offArgv = tailscaleServeOffArgv({ funnel: opts.funnel });
  let outcome: string;
  try {
    const off = await d.run([published.binary, ...offArgv], { timeoutMs: SERVE_OFF_TIMEOUT_MS });
    // "turned off again" is claimed only when a re-read no longer shows our
    // port: an `off` that exits 0 can still leave the mount in place.
    const re = off.status === 0 ? await readServeView(d, published.binary) : null;
    outcome = off.status !== 0 ? `NOT turned off (exit ${off.status ?? 'null'}; run \`tailscale serve status\`)`
      : !re?.view ? 'state unknown (off exited 0 but tailscale serve status could not be re-read; run `tailscale serve status`)'
        : findProxiedHandler(re.view, opts.port) ? 'NOT turned off (off exited 0 but the handler is still present; run `tailscale serve status`)'
          : 'turned off again';
    s.check('rollback', outcome === 'turned off again' ? 'ok' : 'warn', `tailscale ${offArgv.join(' ')}: ${outcome}; no receipt written`);
  } catch (offError) {
    outcome = `NOT turned off (${offError instanceof Error ? offError.message : String(offError)}; run \`tailscale serve status\`)`;
    s.check('rollback', 'warn', `tailscale ${offArgv.join(' ')}: ${outcome}; no receipt written`);
  }
  return new Error(`${message} — the tailscale handler published by this run was ${outcome}; no receipt written`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runMcpExpose(args: string[], deps: McpExposeDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  let opts: ExposeOptions;
  try {
    opts = parseExposeArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) d.out(JSON.stringify({ status: 'error', reason: 'invalid_arguments', message, checks: [], next_actions: [], receipt: null }));
    d.err(`gbrain mcp expose: ${message}`);
    d.err('Run: gbrain mcp expose --help');
    return 1;
  }
  if (opts.help) { d.out(MCP_EXPOSE_HELP); return 0; }
  const s = new Session(d, opts.json);
  try {
    if (opts.status) return await runStatus(d, s, opts);
    if (opts.remove) return await runRemove(d, s, opts);
    return await runPublish(d, s, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.check('internal', 'fail', message);
    return s.finish('error', 1, { reason: 'mcp_expose_failed', message });
  }
}

// ---------------------------------------------------------------------------
// Publish (the default path)
// ---------------------------------------------------------------------------

async function runPublish(d: Resolved, s: Session, opts: ExposeOptions): Promise<number> {
  // 1. plan ------------------------------------------------------------------
  let cfg: GBrainConfig | null = null;
  try { cfg = d.loadConfig(); } catch { cfg = null; }
  if (isThinClient(cfg)) {
    s.check('plan', 'fail', 'this machine is a thin client (remote_mcp configured); run gbrain mcp expose on the brain host');
    return s.finish('error', 1, { reason: 'thin_client', message: 'This is a thin client. Run `gbrain mcp expose` on the machine that hosts the brain.' });
  }
  const engine = engineKind(cfg);
  const receiptPath = receiptPathFor(d.serveDir);
  const existing = readExposeReceipt(receiptPath);
  const tailscaleBinary = opts.noTailscale ? null : findTailscaleBinary({ which: d.which, fileExists: d.fileExists });
  const hasBrew = !!d.which('brew');
  const installPlan = tailscaleInstallPlan(d.platform, hasBrew);
  const target = opts.noService ? 'none' : await probeServiceTarget(d);
  const mode: ExposeReceipt['mode'] = opts.funnel ? 'funnel' : 'tailnet';
  // A service block from an earlier full run survives a `--no-service` re-run
  // untouched (the wrapper is not rewritten either).
  const keptService = opts.noService && existing && existing.service.state !== 'skipped' ? existing.service : null;
  const localHealthUrl = `http://127.0.0.1:${opts.port}/health`;
  // `--no-tailscale` over a receipt that says the brain is published on the
  // tailnet would rewrite the receipt to loopback while the Serve/Funnel
  // mapping stays live and unfindable. Refused before consent; `--remove` first.
  const tailscaleReceipt = opts.noTailscale && existing?.tailscale.dns_name ? existing : null;
  const plan: string[] = [];
  plan.push(`Server    gbrain serve (HTTP) on 127.0.0.1:${opts.port} (surface ${opts.surface}${opts.enableDcr ? ', DCR on' : ''}); engine ${engine}`);
  if (tailscaleReceipt) plan.push(`Tailscale ${opts.dryRun ? 'WOULD BE REFUSED' : 'REFUSED'} (--no-tailscale): this brain is already published on your tailnet at ${tailscaleReceipt.public_url} — run \`gbrain mcp expose --remove --yes\` first, or re-run without --no-tailscale`);
  else if (opts.noTailscale) plan.push('Tailscale skipped (--no-tailscale): you publish the port yourself');
  else if (tailscaleBinary) plan.push(`Tailscale ${tailscaleBinary} — sign in if needed, then \`tailscale ${tailscaleServeArgv(opts.port, { funnel: opts.funnel }).join(' ')}\``);
  else if (opts.noInstall) plan.push(`Tailscale NOT installed and --no-install set — would stop with: ${installPlan.command}`);
  else plan.push(`Tailscale not installed — would run: ${installPlan.command}`);
  plan.push(`Reach     ${mode === 'funnel' ? 'PUBLIC internet via Tailscale Funnel (cloud agents); gbrain OAuth/bearer + grants protect it' : 'tailnet only — your devices; cloud agents need --funnel'}`);
  plan.push(`Token     ${tildify(adminTokenPathFor(d.serveDir), d.home)} (0600; created or reused; never printed)`);
  if (keptService) plan.push(`Service   kept as is (--no-service): ${serviceLabel(keptService.target, keptService.state, d)}`);
  else if (opts.noService) plan.push('Service   skipped (--no-service): publish only');
  else if (target === 'macos') plan.push(`Service   launchd user agent ${tildify(d.plistPath, d.home)} (RunAtLoad, KeepAlive)`);
  else if (target === 'linux-systemd') plan.push(`Service   systemd user unit ${tildify(d.unitPath, d.home)} (enabled + started, linger)`);
  else plan.push(`Service   manual — no user supervisor in this ${d.executionEnv === 'local' ? 'environment (no user bus)' : d.executionEnv}; you get a foreground command + nohup line`);
  plan.push(`Receipt   ${tildify(receiptPath, d.home)}${existing ? ' (updates the existing receipt)' : ''}`);
  // No brain config → the service would only crash-loop (`gbrain serve` has
  // nothing to open). Refused here, before consent; `--no-service` publishes a
  // server the operator runs themselves and is still allowed.
  const noBrain = engine === 'unknown' && !opts.noService;
  if (noBrain) plan.push(`Brain     ${opts.dryRun ? 'WOULD BE REFUSED' : 'REFUSED'}: no brain is configured on this host (gbrain init first) — a service would only crash-loop; pass --no-service to publish a server you run yourself`);
  // PGLite is single-writer: a live holder that is not our own managed service
  // keeps the service from starting. A warning, not a stop — the operator may
  // be about to stop that process.
  const lockHolder = engine === 'pglite' && cfg?.database_path ? d.pgliteHolder(cfg.database_path) : null;
  const ownService = existing !== null && isLiveService(existing.service.state);
  const lockWarning = lockHolder && !ownService
    ? `a live process holds this PGLite brain (pid ${lockHolder.pid}, ${lockHolder.command ?? (lockHolder.serve ? 'gbrain serve' : 'gbrain')}): the service cannot start until it exits — stop it, or move to Postgres`
    : null;
  if (lockWarning) plan.push(`Lock      ${lockWarning}`);
  s.check('plan', opts.dryRun ? 'planned' : noBrain || tailscaleReceipt ? 'fail' : 'ok', plan.join(' | '));
  if (lockWarning) s.check('pglite_lock', 'warn', lockWarning);
  s.say('Plan');
  for (const line of plan) s.say(`  ${line}`);
  if (opts.dryRun) {
    s.say('');
    s.say('Dry run: nothing changed. Re-run without --dry-run (add --yes to skip the prompt).');
    return s.finish('planned', 0, { receipt: existing, plan });
  }
  if (noBrain) {
    s.nextActions.push('gbrain init', rerunCommand(opts, ' --no-service'));
    return s.finish('error', 1, { receipt: existing, reason: 'no_brain_config', message: 'No brain is configured on this host (gbrain init first), so a service would only crash-loop; pass --no-service to publish a server you run yourself.' });
  }
  if (tailscaleReceipt) {
    s.nextActions.push('gbrain mcp expose --remove --yes', rerunCommand({ ...opts, noTailscale: false }));
    return s.finish('error', 1, { receipt: existing, reason: 'tailscale_receipt_present', message: `This brain is already published on your tailnet at ${tailscaleReceipt.public_url}; run \`gbrain mcp expose --remove --yes\` first, or re-run without --no-tailscale.` });
  }
  // Probe the local port NOW so a foreign listener is refused before anything
  // is published or installed (never after `tailscale serve --bg`). ANY
  // listener counts as occupied — an accepted TCP connect (a non-HTTP
  // service too) or an HTTP answer of any status (a 404 or 500 still owns the
  // port). A receipt for the same port claims the listener (it is our own server).
  const listeningBefore = await probeOccupied(d, opts.port, localHealthUrl);
  if (listeningBefore && !opts.noService && (!existing || existing.port !== opts.port)) {
    s.check('service', 'fail', `something already answers on 127.0.0.1:${opts.port} (a TCP connect was accepted or ${localHealthUrl} answered) and no expose receipt claims it`);
    s.nextActions.push('gbrain mcp expose --remove --yes', rerunCommand(opts, ' --no-service'));
    return s.finish('error', 1, {
      reason: 'foreign_listener',
      message: `Something already answers on 127.0.0.1:${opts.port} and no expose receipt claims it. Stop it, pick another --port, or pass --no-service to only publish it. If this is a gbrain server left behind by an interrupted \`gbrain mcp expose\`, run \`gbrain mcp expose --remove --yes\` first.`,
    });
  }

  // 2. consent -------------------------------------------------------------
  const consent = await confirmOrFinish(d, s, 'Proceed with the plan above? [y/N] ', {
    yes: opts.yes, nextAction: rerunCommand(opts),
    confirmationMessage: 'These are system-state changes (Tailscale, serve config, a user service). Pass --yes to confirm.',
  });
  if (consent !== null) return consent;

  // 3-6. tailscale ---------------------------------------------------------
  let publicUrl: string | null = null;
  let binary = tailscaleBinary;
  let tsStatus: TailscaleStatus | null = null;
  /** Set once THIS run's `--bg` succeeded, so a later throw can roll it back. */
  let published: PublishedThisRun | null = null;
  if (opts.noTailscale) {
    for (const name of ['tailscale.binary', 'tailscale.login', 'tailscale.identity', 'tailscale.publish']) s.check(name, 'skipped', '--no-tailscale');
    publicUrl = `http://127.0.0.1:${opts.port}`;
    s.say('Tailscale skipped: the server stays on loopback until you publish it yourself.');
  } else {
    if (!binary) {
      if (opts.noInstall || !installPlan.argv) {
        s.check('tailscale.binary', 'fail', `not installed; ${installPlan.command}`);
        s.say('Tailscale is not installed.');
        s.say(`  Install: ${installPlan.command}`);
        s.say(`  ${installPlan.note}`);
        s.nextActions.push(installPlan.command);
        return s.finish('error', 1, { reason: opts.noInstall ? 'tailscale_missing' : 'tailscale_unsupported_platform', message: opts.noInstall ? 'Tailscale is missing and --no-install was set.' : installPlan.note });
      }
      s.say(`Installing Tailscale: ${installPlan.command}`);
      const inst = await d.run(installPlan.argv, { inherit: true, stdoutToStderr: opts.json, timeoutMs: 15 * 60_000 });
      binary = findTailscaleBinary({ which: d.which, fileExists: d.fileExists });
      if (inst.status !== 0 || !binary) {
        s.check('tailscale.binary', 'fail', `install ${inst.status === 0 ? 'finished but no binary was found' : `exited ${inst.status ?? 'null'}`}`);
        return s.finish('error', 1, { reason: 'tailscale_install_failed', message: `Tailscale install did not complete. Install it from ${TAILSCALE_DOWNLOAD_URL} and re-run.` });
      }
      if (installPlan.kind === 'brew-cask') {
        // The app bundle's CLI talks to the app's daemon, which only runs once
        // the app has been opened. Best effort: poll until `status --json`
        // answers; if the budget runs out the login step below reports the
        // daemon as not running.
        await d.run(['open', '-a', 'Tailscale'], { inherit: true, stdoutToStderr: opts.json, timeoutMs: 30_000 });
        for (let attempt = 0; attempt < APP_DAEMON_POLL_ATTEMPTS; attempt++) {
          await d.sleep(APP_DAEMON_POLL_INTERVAL_MS);
          if ((await readStatus(d, binary)).status) break;
        }
      }
      s.check('tailscale.binary', 'ok', `installed: ${binary}`);
    } else {
      s.check('tailscale.binary', 'ok', binary);
    }

    // 4. login
    let st = await readStatus(d, binary);
    if (!st.status) {
      const cls = classifyTailscaleError(st.stderr, { platform: d.platform, user: d.user });
      if (cls.kind === 'daemon_not_running' || st.exit === null) {
        s.check('tailscale.login', 'pending', `daemon not running: ${cls.raw || 'no output'}`);
        s.nextActions.push(tailscaleDaemonStartHint(d.platform), rerunCommand(opts));
        return s.finish('pending', 2, { reason: 'tailscale_daemon_not_running', message: `The Tailscale daemon is not running. ${cls.fix}` });
      }
      s.check('tailscale.login', 'fail', cls.raw || 'tailscale status printed no JSON');
      return s.finish('error', 1, { reason: `tailscale_${cls.kind}`, message: cls.fix });
    }
    if (st.status.backendState !== 'Running') {
      const login = tailscaleLoginArgv(d.platform, d.user, binary);
      if (login.setOperator && !isSystemTailscaleBinary(binary)) {
        // Linux login runs `sudo <binary> …`: never hand root to a binary
        // outside the system install locations (a user-writable PATH entry).
        const rerun = rerunCommand(opts);
        const manual = tailscaleManualLoginCommand(binary);
        s.check('tailscale.login', 'pending', `${st.status.backendState}; ${binary} is not a system install, so gbrain will not run it with sudo — sign in yourself if you trust that binary`);
        s.nextActions.push(manual, rerun);
        return s.finish('pending', 2, { reason: 'tailscale_login_manual', message: `tailscale at ${binary} is not a system install, so gbrain will not run it with sudo. If you trust that binary, sign in yourself (this runs it as root): \`${manual}\`, then re-run: ${rerun}` });
      }
      if (login.setOperator) {
        // Set the operator FIRST (so `serve` works without sudo later); a
        // failure is a note, not a stop — `up --operator=` is avoided because
        // it trips the CLI's settings-revert check on a node with custom prefs.
        s.say(`Tailscale is ${st.status.backendState}. Letting ${d.user} manage serve: ${login.setOperator.join(' ')}`);
        const so = await d.run(login.setOperator, { inherit: true, stdoutToStderr: opts.json, timeoutMs: 120_000 });
        if (so.status !== 0) s.say(`Note: ${login.setOperator.join(' ')} exited ${so.status ?? 'null'}; run \`${tailscaleSetOperatorCommand(d.user)}\` later so \`tailscale serve\` works without sudo.`);
      }
      s.say(`Signing in: ${login.up.join(' ')}`);
      s.say('  Open the URL it prints, approve the device, and come back.');
      const upResult = await d.run(login.up, { inherit: true, stdoutToStderr: opts.json, timeoutMs: d.loginTimeoutMs });
      st = await readStatus(d, binary);
      if (!st.status || st.status.backendState !== 'Running') {
        s.check('tailscale.login', 'pending', `BackendState ${st.status?.backendState ?? 'unknown'} after tailscale up (exit ${upResult.status ?? 'null'})`);
        const rerun = rerunCommand(opts);
        s.nextActions.push(d.platform === 'darwin' ? 'Open the Tailscale app and sign in' : login.up.join(' '), rerun);
        return s.finish('pending', 2, { reason: 'tailscale_login_pending', message: d.platform === 'darwin' ? `Open the Tailscale app and sign in, then re-run: ${rerun}` : `Complete the login, then re-run: ${rerun}` });
      }
      s.check('tailscale.login', 'ok', 'Running (signed in just now)');
    } else {
      s.check('tailscale.login', 'ok', 'Running');
    }
    tsStatus = st.status;

    // 5. identity
    if (!tsStatus.dnsName) {
      s.check('tailscale.identity', 'fail', 'Self.DNSName is empty — MagicDNS is off for this tailnet');
      s.nextActions.push(`Enable MagicDNS + HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}`);
      return s.finish('error', 1, { reason: 'tailscale_no_dns_name', message: `Your node has no MagicDNS name. Enable MagicDNS and HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}, then re-run.` });
    }
    publicUrl = publicUrlFromDnsName(tsStatus.dnsName);
    // Pre-checks. `tailscale serve/funnel --bg` do NOT fail when the feature
    // is off — they print an enablement URL and wait for the operator — so
    // never start them blind.
    const rerun = rerunCommand(opts);
    if (tsStatus.certDomains.length === 0) {
      s.check('tailscale.identity', 'pending', `${tsStatus.dnsName}; CertDomains empty — HTTPS certificates are not enabled for this tailnet (${TAILSCALE_ADMIN_DNS_URL})`);
      s.nextActions.push(`Enable MagicDNS + HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}`, rerun);
      return s.finish('pending', 2, { reason: 'tailscale_https_not_enabled', message: `HTTPS certificates are not enabled for your tailnet, so nothing was published. Enable MagicDNS + HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}, then re-run: ${rerun}` });
    }
    if (opts.funnel && tsStatus.funnelCapable === false) {
      s.check('tailscale.identity', 'pending', `${tsStatus.dnsName}; this node lacks the Funnel capability (${TAILSCALE_ADMIN_ACL_URL})`);
      s.nextActions.push(`Enable the funnel node attribute at ${TAILSCALE_ADMIN_ACL_URL} (see ${TAILSCALE_FUNNEL_KB_URL})`, rerun);
      return s.finish('pending', 2, { reason: 'tailscale_funnel_not_enabled', message: `Tailscale Funnel is not enabled for this node, so nothing was published. Enable the \`funnel\` node attribute in your tailnet policy at ${TAILSCALE_ADMIN_ACL_URL} (see ${TAILSCALE_FUNNEL_KB_URL}), then re-run: ${rerun}` });
    }
    s.check('tailscale.identity', 'ok', `${tsStatus.dnsName}${opts.funnel && tsStatus.funnelCapable === null ? ' (Funnel capability not reported by this CLI; the publish step decides)' : ''}`);

    // 6. publish
    const beforeRead = await readServeView(d, binary);
    if (!beforeRead.view) {
      // Fail closed: never publish over a serve config that could not be read.
      const failure = describeServeReadFailure(d, beforeRead);
      s.check('tailscale.publish', 'fail', failure.detail);
      s.nextActions.push('tailscale serve status --json', failure.fix);
      return s.finish('error', 1, { reason: `tailscale_${failure.kind}`, message: `Could not read the current \`tailscale serve status\`, so nothing was published. ${failure.fix}` });
    }
    const before = beforeRead.view;
    const ours = findProxiedHandler(before, opts.port);
    const foreign = findRootHandlers(before).filter(h => h.proxyPort !== opts.port);
    const claimed = existing !== null && foreign.some(h => h.proxyPort === existing.port);
    const foregroundForeign = foreign.filter(h => h.foreground);
    if (foreign.length > 0 && !claimed && (!opts.force || foregroundForeign.length > 0)) {
      const desc = foreign.map(describeHandler).join(', ');
      s.check('tailscale.publish', 'fail', `someone else's serve config on :443: ${desc}`);
      s.nextActions.push('tailscale serve status');
      const message = foregroundForeign.length > 0
        ? `tailscale serve already proxies :443 to ${desc}. A foreground \`tailscale serve\` session in another terminal owns it — --force cannot overwrite it; stop it there (Ctrl-C), then re-run.`
        : `tailscale serve already proxies :443 to ${desc}. Re-run with --force to take it over, or pick another local port for that service.`;
      return s.finish('error', 1, { reason: 'foreign_serve_config', message });
    }
    // Switching our own handler funnel -> tailnet needs Funnel turned off
    // first (`serve --bg` over a Funnel mount keeps AllowFunnel); the other
    // direction is one atomic `funnel --bg`, so nothing is pre-cleared there.
    const preOff = ours !== null && ours.funnel && !opts.funnel;
    if (preOff) await d.run([binary, ...tailscaleServeOffArgv({ funnel: true })], { timeoutMs: SERVE_OFF_TIMEOUT_MS });
    /** After a failed publish that followed the pre-off: best-effort re-publish of the previous (funnel) shape so the switch never strands the handler. Returns the detail suffix. */
    const restorePrevious = async (): Promise<string> => {
      if (!preOff) return '';
      const argv = tailscaleServeArgv(opts.port, { funnel: true });
      let r: CommandResult | null = null;
      try { r = await d.run([binary!, ...argv], { timeoutMs: PUBLISH_TIMEOUT_MS }); } catch { r = null; }
      const re = r?.status === 0 ? await readServeView(d, binary!) : null;
      const restored = re?.view ? findProxiedHandler(re.view, opts.port)?.funnel === true : false;
      return restored
        ? `; the previous funnel handler was restored (tailscale ${argv.join(' ')}) and the existing receipt kept`
        : `; the previous funnel handler could NOT be restored (tailscale ${argv.join(' ')}: ${r ? `exit ${r.status ?? 'null'}` : 'runner threw'}) — run \`tailscale serve status\`; the existing receipt was kept`;
    };
    const publishArgv = tailscaleServeArgv(opts.port, { funnel: opts.funnel });
    const pub = await d.run([binary, ...publishArgv], { timeoutMs: PUBLISH_TIMEOUT_MS });
    if (pub.status !== 0) {
      const restored = await restorePrevious();
      if (pub.status === null) {
        // Killed at the deadline: most likely the CLI was waiting for an
        // enablement step the pre-checks could not see. Say so, never guess.
        const hint = `\`tailscale ${publishArgv.join(' ')}\` did not finish within ${PUBLISH_TIMEOUT_MS / 1000}s (it may be waiting for you to enable a feature). Run it by hand to see what it prints, then re-run: ${rerun}`;
        s.check('tailscale.publish', 'fail', `unknown: timed out after ${PUBLISH_TIMEOUT_MS / 1000}s${restored}`);
        s.nextActions.push(`tailscale ${publishArgv.join(' ')}`);
        return s.finish('error', 1, { reason: 'tailscale_unknown', message: hint });
      }
      const cls = classifyTailscaleError(pub.stderr || pub.stdout, { platform: d.platform, user: d.user });
      s.check('tailscale.publish', 'fail', `${cls.kind}: ${cls.raw || `exit ${pub.status}`}${restored}`);
      s.nextActions.push(cls.fix);
      return s.finish('error', 1, { reason: `tailscale_${cls.kind}`, message: cls.fix });
    }
    published = { binary, hadHandlerBefore: ours !== null };
    const afterRead = await readServeView(d, binary);
    const confirmed = afterRead.view ? findProxiedHandler(afterRead.view, opts.port) : null;
    if (!confirmed) {
      const why = afterRead.view ? `serve status shows no / handler for port ${opts.port}` : describeServeReadFailure(d, afterRead).detail;
      s.check('tailscale.publish', 'fail', `tailscale ${publishArgv.join(' ')} exited 0 but ${why}${await restorePrevious()}`);
      s.nextActions.push('tailscale serve status', 'gbrain mcp expose --remove --yes');
      return s.finish('error', 1, { reason: 'tailscale_publish_unconfirmed', message: `Tailscale accepted the command but ${afterRead.view ? 'does not show the handler' : 'its serve status could not be read afterwards'}. Run \`tailscale serve status\` to inspect; \`gbrain mcp expose --remove --yes\` clears a handler for port ${opts.port} without a receipt (add --force when no wrapper or service of gbrain's is on this host yet).` });
    }
    if (confirmed.funnel !== opts.funnel) {
      s.check('tailscale.publish', 'warn', `handler present but funnel=${confirmed.funnel} (wanted ${opts.funnel})`);
      s.say(`Warning: Funnel is ${confirmed.funnel ? 'ON' : 'OFF'} for this handler but you asked for ${opts.funnel ? 'Funnel' : 'tailnet-only'}. Fix: tailscale ${tailscaleServeOffArgv({ funnel: confirmed.funnel }).join(' ')}, then re-run.`);
    } else {
      s.check('tailscale.publish', 'ok', `${confirmed.host}:443/ -> ${confirmed.proxy}${opts.funnel ? ' (funnel)' : ''}`);
    }
  }

  // 7-9. admin token, service, verify ----------------------------------------
  // Wrapped so a throw after THIS run's `--bg` succeeded rolls the handler
  // back (rollbackAfterThrow) instead of leaving it live with no receipt.
  const tokenPath = adminTokenPathFor(d.serveDir);
  const wrapper = wrapperPathFor(d.serveDir);
  let serviceReceipt: ExposeReceipt['service'] = { target, unit_path: null, plist_path: null, wrapper_path: wrapper, state: 'skipped' };
  const buildReceipt = (): ExposeReceipt => {
    const nowIso = d.now().toISOString();
    return {
      version: 1,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
      port: opts.port,
      public_url: publicUrl!,
      mcp_url: `${publicUrl}/mcp`,
      admin_url: `${publicUrl}/admin`,
      mode,
      surface: opts.surface,
      enable_dcr: opts.enableDcr,
      tailscale: { binary, dns_name: tsStatus?.dnsName ?? null, tailscale_version: tsStatus?.version ?? null },
      service: serviceReceipt,
      admin_token_file: tokenPath,
      engine,
    };
  };
  let localHealth: 'ok' | 'timeout' | 'skipped' = 'skipped';
  let tailnetHealth: 'ok' | 'pending' | 'unresolved' | 'skipped' = 'skipped';
  /** Set once the early receipt (right after the service step) is on disk: from then on `--remove` can find everything. */
  let receiptWritten = false;
  try {
    // 7. admin token
    const token = ensureAdminToken(tokenPath, { randomHex: d.randomHex });
    s.check('admin_token', 'ok', `${token.action}: ${tokenPath}`);
    if (token.action === 'regenerated') s.say(`Note: ${tildify(tokenPath, d.home)} did not look like a valid admin token and was regenerated.`);

    // 8. service
    if (keptService) {
      serviceReceipt = keptService;
      s.check('service', 'skipped', `--no-service: existing ${serviceLabel(keptService.target, keptService.state, d)} kept as is`);
    } else if (opts.noService) {
      s.check('service', 'skipped', '--no-service');
    } else {
      // (a foreign listener was already refused in the plan step, before publishing)
      const content = renderServeWrapper({
        gbrainCommand: d.gbrainCommand(), adminTokenPath: tokenPath, gbrainEnvFile: d.gbrainEnvFile, gbrainHome: d.env.GBRAIN_HOME,
        runtimeDir: d.runtimeDir, port: opts.port, publicUrl: publicUrl!, surface: opts.surface, enableDcr: opts.enableDcr,
      });
      const installed = await installServeService({
        target, wrapperPath: wrapper, wrapperContent: content, home: d.home, logPath: serveLogPath(d.serveDir), errPath: serveErrPath(d.serveDir),
        run: d.run, uid: d.uid, plistPath: d.plistPath, unitPath: d.unitPath, sleep: d.sleep,
      });
      serviceReceipt.plist_path = installed.plist_path;
      serviceReceipt.unit_path = installed.unit_path;
      for (const note of installed.notes) s.say(`Note: ${note}`);
      if (installed.error) {
        s.check('service', 'fail', installed.error);
        // Keep a receipt so `--status` / `--remove` can still see and clean up
        // the handler that WAS published.
        serviceReceipt.state = 'stopped';
        const partial = buildReceipt();
        writeExposeReceipt(receiptPath, partial);
        s.check('receipt', 'ok', `${receiptPath} (service stopped)`);
        s.nextActions.push('gbrain mcp expose --status', 'gbrain mcp expose --remove --yes');
        return s.finish('error', 1, { receipt: partial, reason: 'service_install_failed', message: installed.error });
      }
      if (target === 'none') {
        serviceReceipt.state = 'manual';
        const cmds = manualCommands(d, wrapper);
        s.check('service', 'ok', `manual: wrapper written to ${wrapper}`);
        s.say('No user supervisor is available here, so the server is not auto-started. Run it yourself:');
        s.say(`  Foreground   ${cmds.foreground}`);
        s.say(`  Background   ${cmds.background}`);
        s.nextActions.push(cmds.foreground);
      } else {
        serviceReceipt.state = await serveServiceState({ target, run: d.run, uid: d.uid });
        s.check('service', isLiveService(serviceReceipt.state) ? 'ok' : 'warn', serviceLabel(target, serviceReceipt.state, d));
      }
    }

    // Early receipt: the handler is live and the service is installed, so a
    // kill / crash during verify must leave `--status` / `--remove` something
    // to find. Rewritten below with the settled state (created_at kept).
    writeExposeReceipt(receiptPath, buildReceipt());
    receiptWritten = true;

    // 9. verify
    if (opts.noService && !listeningBefore && !keptService) {
      s.check('verify.local', 'skipped', `--no-service and nothing listens on ${localHealthUrl} yet`);
      s.say(`Nothing listens on 127.0.0.1:${opts.port} yet — start the server: ${['gbrain', ...serveCommandArgv({ port: opts.port, publicUrl: publicUrl!, surface: opts.surface, enableDcr: opts.enableDcr })].join(' ')}`);
    } else if (target === 'none' && !opts.noService && !listeningBefore) {
      s.check('verify.local', 'skipped', 'manual service: start the wrapper, then run --status');
    } else {
      localHealth = (await pollHealth(d, localHealthUrl, d.localHealthMs)).ok ? 'ok' : 'timeout';
      s.check('verify.local', localHealth === 'ok' ? 'ok' : 'warn', `${localHealthUrl}: ${localHealth}`);
    }
    if (!opts.noTailscale && localHealth === 'ok') {
      const tn = await pollHealth(d, `${publicUrl}/health`, d.tailnetHealthMs);
      tailnetHealth = tn.ok ? 'ok' : tn.unresolved ? 'unresolved' : 'pending';
      // A name this host cannot resolve is a warn (MagicDNS off HERE), never
      // `pending`: the server may already be reachable from devices that do.
      if (tailnetHealth === 'unresolved') s.check('verify.tailnet', 'warn', `${publicUrl}/health: ${unresolvedDetail(tsStatus!.dnsName!)}`);
      else s.check('verify.tailnet', tailnetHealth === 'ok' ? 'ok' : 'pending', `${publicUrl}/health: ${tailnetHealth}${tailnetHealth === 'pending' ? ' (first certificate issuance can take a minute)' : ''}`);
    } else {
      s.check('verify.tailnet', 'skipped', opts.noTailscale ? '--no-tailscale' : 'local server not confirmed yet');
    }
  } catch (error) {
    throw await rollbackAfterThrow(d, s, opts, published, error, receiptWritten);
  }

  // 10. receipt — the settled state (created_at kept; a supervisor that was
  // still `loaded` when first probed is re-read now that /health had its say).
  if (!keptService && !opts.noService && target !== 'none' && localHealth !== 'skipped') {
    serviceReceipt.state = await serveServiceState({ target, run: d.run, uid: d.uid });
  }
  const receipt = buildReceipt();
  writeExposeReceipt(receiptPath, receipt);
  s.check('receipt', 'ok', receiptPath);

  // Human summary -----------------------------------------------------------
  const tokenHint = tildify(tokenPath, d.home);
  const ownerCredential = opts.noService && !keptService ? '<existing-server-admin-token-file>' : shellQuote(tokenPath);
  const ownerLogin = `gbrain mcp admin login-link --url ${receipt.mcp_url} --admin-token-file ${ownerCredential}`;
  s.say('');
  s.say(opts.noTailscale ? 'GBrain MCP server configured (not published — --no-tailscale)' : `GBrain MCP server published on ${mode === 'funnel' ? 'the public internet via Tailscale Funnel' : 'your tailnet'}`);
  s.say(`  MCP URL   ${receipt.mcp_url}`);
  s.say(`  Admin     ${receipt.admin_url}   (owner session required)`);
  s.say(opts.noService && !keptService
    ? '  Owner     use the credential configured for your existing server; --no-service does not change it.'
    : `  Owner     ${tokenHint} (protected service credential)`);
  s.say(`  Reach     ${mode === 'funnel' ? 'public (Funnel) — cloud agents can connect; gbrain OAuth/bearer + scoped grants protect it.' : 'tailnet only — your devices. Cloud agents (Grok Bot, Muse, ChatGPT) need `--funnel`.'}`);
  s.say(`  Service   ${keptService ? `${serviceLabel(keptService.target, keptService.state, d)} (kept, --no-service)` : opts.noService ? 'skipped (--no-service)' : serviceLabel(target, serviceReceipt.state, d)}`);
  if (engine === 'pglite') {
    s.say('  Engine    PGLite (single-writer): host-side commands that open the database fail with `live_serve` —');
    s.say('            administer through the running server (--admin-token-file; `gbrain sync` delegates to it),');
    s.say('            or move to Postgres for concurrent local use.');
  } else {
    s.say(`  Engine    ${engine === 'postgres' ? 'Postgres' : 'unknown (no brain config found — run gbrain init on this host)'}`);
  }
  if (localHealth === 'timeout') s.say(`  Health    local ${localHealthUrl} did not answer within ${Math.round(d.localHealthMs / 1000)}s — check ${tildify(serveErrPath(d.serveDir), d.home)}`);
  if (tailnetHealth === 'pending') s.say(`  Health    ${publicUrl}/health still pending — re-run \`gbrain mcp expose --status\` in a minute.`);
  if (tailnetHealth === 'unresolved') s.say(`  Health    ${publicUrl}/health: ${unresolvedDetail(tsStatus!.dnsName!)}`);
  s.say('');
  s.say('Next — choose the connection method supported by the intended client');
  s.say(`  Owner login      ${ownerLogin}`);
  s.say('  Native OAuth     gbrain mcp admin register --help (public/confidential PKCE; exact client redirect URIs)');
  s.say('                   The native client starts authorization; the owner separately reviews consent.');
  s.say(`  Machine client   gbrain mcp grant <name> --harness <id> --profile memory-writer --source default \\`);
  s.say(`                     --url ${receipt.mcp_url} \\`);
  s.say(`                     --admin-token-file ${ownerCredential} --credentials-out /private/<name>.json`);
  s.say(`  Machine install  gbrain connect ${receipt.mcp_url} --harness <id> --credentials-file /private/<name>.json --install`);
  const local = localAgentGuidance(engine, opts.port, ownerCredential);
  s.say(`  Local agents     ${local.lines[0]}`);
  for (const line of local.lines.slice(1)) s.say(`                   ${line}`);
  s.say('  Check            gbrain mcp expose --status');
  s.nextActions.push(
    `gbrain mcp grant <name> --harness <id> --profile memory-writer --source default --url ${receipt.mcp_url} --admin-token-file ${ownerCredential} --credentials-out /private/<name>.json`,
    ownerLogin,
    'gbrain mcp admin register --help',
    ...local.nextActions,
    'gbrain mcp expose --status',
  );
  const pending = tailnetHealth === 'pending' || localHealth === 'timeout';
  return s.finish(pending ? 'pending' : 'exposed', pending ? 2 : 0, { receipt, ...(pending ? { reason: tailnetHealth === 'pending' ? 'tailnet_health_pending' : 'local_health_timeout' } : {}) });
}

/** Re-render the user's publish flags for a re-run hint (never --yes/--json/--dry-run). */
function args2(opts: ExposeOptions): string {
  const parts: string[] = [];
  if (opts.port !== DEFAULT_EXPOSE_PORT) parts.push(`--port ${opts.port}`);
  if (opts.funnel) parts.push('--funnel');
  if (opts.surface !== 'full') parts.push(`--surface ${opts.surface}`);
  if (opts.enableDcr) parts.push('--enable-dcr');
  if (opts.noTailscale) parts.push('--no-tailscale');
  if (opts.noService) parts.push('--no-service');
  if (opts.noInstall) parts.push('--no-install');
  return parts.length ? ` ${parts.join(' ')}` : '';
}

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------

async function runStatus(d: Resolved, s: Session, opts: ExposeOptions): Promise<number> {
  const receipt = readExposeReceipt(receiptPathFor(d.serveDir));
  if (!receipt) return runStatusWithoutReceipt(d, s, opts);
  s.check('receipt', 'ok', `${receipt.mode} on port ${receipt.port} since ${receipt.created_at}`);
  let allOk = true;
  let pending = false;
  // The four probes (serve config, supervisor, local + tailnet /health) are
  // independent: run them together, then report in the fixed check order.
  const viaTailscale = !!(receipt.tailscale.binary || receipt.tailscale.dns_name);
  const binary = viaTailscale ? resolveReceiptBinary(d, receipt) : null;
  const localUrl = `http://127.0.0.1:${receipt.port}/health`;
  const tailnetUrl = receipt.public_url.startsWith('https://') ? `${receipt.public_url}/health` : null;
  const [serveRead, state, localOk, tailnet] = await Promise.all([
    binary ? readServeView(d, binary) : Promise.resolve<ServeRead | null>(null),
    receipt.service.state !== 'skipped' ? serveServiceState({ target: receipt.service.target, run: d.run, uid: d.uid }) : Promise.resolve<ServiceState | 'skipped'>('skipped'),
    probeHealth(d, localUrl, 3_000),
    tailnetUrl ? tryFetch(d, tailnetUrl, 8_000) : Promise.resolve<FetchOutcome | null>(null),
  ]);
  // tailscale
  if (!viaTailscale) {
    s.check('tailscale.publish', 'skipped', 'published without Tailscale');
  } else if (!serveRead) {
    allOk = false;
    s.check('tailscale.publish', 'fail', 'tailscale binary not found');
  } else if (!serveRead.view) {
    // Fail closed: an unreadable serve config is not "handler present".
    allOk = false;
    s.check('tailscale.publish', 'fail', describeServeReadFailure(d, serveRead).detail);
    s.nextActions.push('tailscale serve status --json');
  } else {
    const view = serveRead.view;
    const ours = findProxiedHandler(view, receipt.port);
    if (!ours) { allOk = false; s.check('tailscale.publish', 'fail', `no :443 handler proxies to port ${receipt.port}`); }
    else if (ours.funnel !== (receipt.mode === 'funnel')) { allOk = false; s.check('tailscale.publish', 'warn', `handler present but funnel=${ours.funnel}; receipt says ${receipt.mode}`); }
    else s.check('tailscale.publish', 'ok', `${ours.host}:443/ -> ${ours.proxy}${ours.funnel ? ' (funnel)' : ''}`);
  }
  // service
  if (receipt.service.state !== 'skipped') {
    const good = isLiveService(state) || state === 'manual';
    if (!good) allOk = false;
    s.check('service', good ? 'ok' : 'fail', serviceLabel(receipt.service.target, state, d));
  } else {
    s.check('service', 'skipped', 'installed with --no-service');
  }
  // health
  if (!localOk) allOk = false;
  s.check('verify.local', localOk ? 'ok' : 'fail', `${localUrl}: ${localOk ? 'ok' : 'no answer'}`);
  if (tailnetUrl && tailnet) {
    if (tailnet.res?.ok) s.check('verify.tailnet', 'ok', `${tailnetUrl}: ok`);
    else if (tailnet.unresolved) s.check('verify.tailnet', 'warn', `${tailnetUrl}: ${unresolvedDetail(receipt.tailscale.dns_name ?? receipt.public_url.slice('https://'.length))}`);
    else { pending = true; s.check('verify.tailnet', 'pending', `${tailnetUrl}: pending`); }
  } else {
    s.check('verify.tailnet', 'skipped', 'no https public URL');
  }
  s.say(`GBrain MCP server (${receipt.mode}) — ${receipt.mcp_url}`);
  for (const c of s.checks) s.say(`  ${c.status.padEnd(8)} ${c.name.padEnd(18)} ${c.detail}`);
  if (!allOk) s.nextActions.push('gbrain mcp expose --yes');
  if (!allOk) return s.finish('error', 1, { receipt, reason: 'status_unhealthy' });
  // Spec: --status exits 0 only when EVERYTHING verifies. A pending tailnet
  // certificate is reported as `pending` (not `error`) so callers can tell
  // "wait a minute" from "broken", but it is still a non-zero exit.
  if (pending) { s.nextActions.push('gbrain mcp expose --status'); return s.finish('pending', 1, { receipt, reason: 'tailnet_health_pending', message: 'tailnet health still pending (first certificate issuance can take a minute) — re-run --status shortly.' }); }
  return s.finish('exposed', 0, { receipt });
}

interface Leftovers {
  wrapper: string;
  wrapperExists: boolean;
  binary: string | null;
  target: ServiceTarget;
  serviceState: ServiceState | null;
  /** The launchd plist / systemd unit is present, or the supervisor reports our service live. */
  serviceFound: boolean;
  /** The `/` handler on `:443` proxying `port`, when the serve config could be read. */
  handler: ServeHandler | null;
  /** The serve-status read that FAILED (null view), for the caveat line. */
  serveUnreadable: ServeRead | null;
  /** Something of gbrain's besides a handler: the wrapper or the service. */
  evidence: boolean;
}

/**
 * What an interrupted `gbrain mcp expose` (no receipt) can leave behind:
 * `wrapperPath(serveDir)`, the launchd plist / systemd unit or a live
 * service, and a `/` handler on `:443` proxying `port`. Read-only; shared by
 * `--status` and `--remove` without a receipt. The supervisor chain and the
 * serve-status read are independent probes.
 */
async function probeLeftovers(d: Resolved, port: number): Promise<Leftovers> {
  const wrapper = wrapperPathFor(d.serveDir);
  const binary = findTailscaleBinary({ which: d.which, fileExists: d.fileExists });
  const [[target, serviceState], read] = await Promise.all([
    probeServiceTarget(d).then(async (t): Promise<[ServiceTarget, ServiceState | null]> => [t, t !== 'none' ? await serveServiceState({ target: t, run: d.run, uid: d.uid }) : null]),
    binary ? readServeView(d, binary) : Promise.resolve<ServeRead | null>(null),
  ]);
  const unitFile = target === 'macos' ? d.plistPath : target === 'linux-systemd' ? d.unitPath : null;
  const wrapperExists = existsSync(wrapper);
  const serviceFound = target !== 'none' && ((unitFile !== null && existsSync(unitFile)) || isLiveService(serviceState));
  return {
    wrapper, wrapperExists, binary, target, serviceState, serviceFound,
    handler: read?.view ? findProxiedHandler(read.view, port) : null,
    serveUnreadable: read && !read.view ? read : null,
    evidence: wrapperExists || serviceFound,
  };
}

/** `--remove --yes [--force] [--port N]` for the receipt-less recovery. */
function recoveryCommand(port: number, force: boolean): string {
  return `gbrain mcp expose --remove --yes${force ? ' --force' : ''}${port !== DEFAULT_EXPOSE_PORT ? ` --port ${port}` : ''}`;
}

/**
 * `--status` with NO receipt: not simply "not exposed" — an interrupted run
 * may have left the wrapper, the unit / service or a `:443` handler behind.
 * Any of them found → one warn check per artifact, the recovery command in
 * `next_actions` (`--force` when only a handler stands, since nothing else of
 * gbrain's corroborates it), reason `leftovers_without_receipt`, exit 1.
 */
async function runStatusWithoutReceipt(d: Resolved, s: Session, opts: ExposeOptions): Promise<number> {
  const lo = await probeLeftovers(d, opts.port);
  const found: string[] = [];
  if (lo.wrapperExists || lo.serviceFound || lo.handler) s.check('receipt', 'warn', `no expose receipt, but leftovers of an interrupted publish are on this host (port ${opts.port})`);
  else s.check('receipt', 'skipped', 'no expose receipt');
  if (lo.serviceFound) { s.check('service', 'warn', `${serviceKindLabel(lo.target)} is installed${lo.serviceState ? ` (${lo.serviceState})` : ''} without a receipt`); found.push(`the ${serviceKindLabel(lo.target)} service`); }
  if (lo.handler) { s.check('tailscale.publish', 'warn', `a :443 handler proxies ${lo.handler.proxy}${lo.handler.funnel ? ' (funnel)' : ''} without a receipt`); found.push(`the :443 handler proxying ${lo.handler.proxy}`); }
  else if (lo.serveUnreadable) s.check('tailscale.publish', 'warn', `${describeServeReadFailure(d, lo.serveUnreadable).detail}; a handler for port ${opts.port} could not be checked`);
  if (lo.wrapperExists) { s.check('files', 'warn', `wrapper ${tildify(lo.wrapper, d.home)} exists without a receipt`); found.push(`the wrapper ${tildify(lo.wrapper, d.home)}`); }
  if (found.length === 0) {
    s.say('not exposed — run: gbrain mcp expose');
    s.nextActions.push('gbrain mcp expose');
    return s.finish('not_exposed', s.json ? 2 : 0, { reason: 'not_exposed' });
  }
  const rerun = recoveryCommand(opts.port, !lo.evidence);
  s.say(`not exposed, but an interrupted \`gbrain mcp expose\` left these behind (port ${opts.port}): ${found.join('; ')}`);
  s.say(`  Clean up: ${rerun}`);
  s.nextActions.push(rerun);
  return s.finish('error', 1, { reason: 'leftovers_without_receipt', message: `leftovers without a receipt: ${found.join('; ')} — run ${rerun}` });
}

// ---------------------------------------------------------------------------
// --remove
// ---------------------------------------------------------------------------

interface HandlerOffOutcome {
  /** `funnel off: exit 0, serve off: exit 0` style ledger. */
  results: string[];
  /** The handler that survived, `'unknown'` when the re-read failed, null when it is gone. */
  remaining: ServeHandler | 'unknown' | null;
}

/**
 * Turn OUR `/` handler on `:443` (the one proxying `port`) off: Funnel first
 * when it is on, then the plain serve handler if it is still there. The serve
 * config is re-read only after a command could have changed it; a failed
 * re-read is reported as `unknown` (fail closed), never as "gone".
 */
async function turnOffOurHandler(d: Resolved, binary: string, port: number, ours: ServeHandler, funnelFirst: boolean): Promise<HandlerOffOutcome> {
  const results: string[] = [];
  if (funnelFirst || ours.funnel) {
    const off = await d.run([binary, ...tailscaleServeOffArgv({ funnel: true })], { timeoutMs: SERVE_OFF_TIMEOUT_MS });
    results.push(`funnel off: exit ${off.status ?? 'null'}`);
  }
  let stillThere: ServeHandler | 'unknown' | null = ours;
  if (results.length) {
    const re = await readServeView(d, binary);
    stillThere = re.view ? findProxiedHandler(re.view, port) : 'unknown';
  }
  if (stillThere) {
    const off = await d.run([binary, ...tailscaleServeOffArgv({ funnel: false })], { timeoutMs: SERVE_OFF_TIMEOUT_MS });
    results.push(`serve off: exit ${off.status ?? 'null'}`);
    const re = await readServeView(d, binary);
    return { results, remaining: re.view ? findProxiedHandler(re.view, port) : 'unknown' };
  }
  return { results, remaining: null };
}

function recordHandlerOff(s: Session, outcome: HandlerOffOutcome, left: string[]): void {
  const { results, remaining } = outcome;
  if (remaining === 'unknown') {
    s.check('tailscale.publish', 'warn', `${results.join(', ')} — could not re-read tailscale serve status afterwards; run \`tailscale serve status\``);
    left.push('the tailscale serve handler (state unknown: serve status could not be re-read)');
    return;
  }
  s.check('tailscale.publish', remaining ? 'fail' : 'ok', `${results.join(', ')}${remaining ? ' — handler still present; run `tailscale serve status`' : ''}`);
  if (remaining) left.push('the tailscale serve handler');
}

/**
 * `--remove` never reports success while our handler survives: when the off
 * attempt leaves it present (or its state unreadable) the receipt and the
 * wrapper are kept — exactly as on an unreadable serve status — so a re-run
 * finds everything again, and the exit is 1 / `handler_not_removed`. The
 * service was already uninstalled by then; `serviceNote` says so.
 */
function finishHandlerNotRemoved(s: Session, p: { receipt: ExposeReceipt | null; port: number; remaining: ServeHandler | 'unknown'; serviceNote: string; kept: string; rerun: string }): number {
  const why = p.remaining === 'unknown' ? 'could not be confirmed gone (tailscale serve status could not be re-read)' : 'is still present';
  s.check(p.receipt ? 'receipt' : 'files', 'skipped', `kept: ${p.kept} — the :443 handler for port ${p.port} ${why}; re-run --remove once it can be turned off`);
  s.nextActions.push('tailscale serve status', p.rerun);
  s.say('');
  s.say(`Stopped here: ${p.serviceNote}, but the tailscale handler for port ${p.port} ${why}. Left in place: ${p.kept}. Run \`tailscale serve status\`, then re-run \`${p.rerun}\`.`);
  return s.finish('error', 1, { receipt: p.receipt, reason: 'handler_not_removed', message: `the tailscale handler for port ${p.port} ${why}; left in place: ${p.kept}` });
}

/**
 * The `service` check after `uninstallServeService`: notes as prose; a launchd
 * bootout that failed for a non-benign reason is a warn and the job is named
 * as left. Returns the one-line summary `finishHandlerNotRemoved` quotes.
 */
function recordServiceUninstall(s: Session, r: UninstallServiceResult, left: string[]): string {
  for (const note of r.notes) s.say(`Note: ${note}`);
  const files = r.removed.length ? `removed ${r.removed.join(', ')}` : 'no unit file to delete';
  if (launchdBootoutFailed(r)) {
    left.push('the launchd job (bootout failed)');
    s.check('service', 'warn', `${files}; launchctl bootout failed, so the job may still be loaded — check \`launchctl print gui/$(id -u)/${SERVE_LAUNCHD_LABEL}\``);
    return 'the service files were removed but the launchd bootout failed';
  }
  s.check('service', 'ok', r.removed.length ? files : 'stopped (no unit file to delete)');
  return 'the service was stopped and removed';
}

/**
 * A path in a receipt is data, never a licence to delete elsewhere: the
 * wrapper, receipt and admin token are unlinked only inside the serve
 * directory; the plist and unit are only ever the computed paths
 * (`d.plistPath` / `d.unitPath`), whatever the receipt recorded.
 */
function serveDirGuard(d: Resolved): (p: string) => boolean {
  const serveDir = resolvePath(d.serveDir);
  return (p: string) => dirname(resolvePath(p)) === serveDir;
}

const OUTSIDE_NOTE = 'outside the serve directory; not touched';
const RECORDED_ELSEWHERE_NOTE = 'recorded in the receipt but not the expected location; not touched';

function unlinkQuietly(s: Session, p: string, removed: string[]): void {
  try { if (existsSync(p)) { unlinkSync(p); removed.push(p); } } catch (error) { s.say(`Note: could not delete ${p}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function runRemove(d: Resolved, s: Session, opts: ExposeOptions): Promise<number> {
  const receiptPath = receiptPathFor(d.serveDir);
  const receipt = readExposeReceipt(receiptPath);
  if (!receipt) return runRemoveWithoutReceipt(d, s, opts);
  const inServeDir = serveDirGuard(d);
  const wrapperFile = receipt.service.wrapper_path;
  const tokenFile = receipt.admin_token_file;
  const plan = [
    receipt.service.state === 'skipped' ? 'Service   none installed' : receipt.service.target === 'none' ? 'Service   manual — nothing to stop here (stop the wrapper process yourself); the wrapper file is deleted below' : `Service   stop + remove ${serviceKindLabel(receipt.service.target)}`,
    receipt.tailscale.binary ? `Tailscale turn off OUR :443 handler${receipt.mode === 'funnel' ? ' (funnel first)' : ''} — Tailscale stays installed and signed in` : 'Tailscale nothing to undo',
    inServeDir(wrapperFile)
      ? `Files     delete ${tildify(wrapperFile, d.home)} and ${tildify(receiptPath, d.home)}`
      : `Files     delete ${tildify(receiptPath, d.home)}; leave ${tildify(wrapperFile, d.home)} (${OUTSIDE_NOTE})`,
    !inServeDir(tokenFile)
      ? `Token     leave ${tildify(tokenFile, d.home)} (${OUTSIDE_NOTE})`
      : opts.force ? `Token     delete ${tildify(tokenFile, d.home)} (--force)` : `Token     keep ${tildify(tokenFile, d.home)} (dashboard session may still use it; --force deletes)`,
  ];
  s.check('plan', 'ok', plan.join(' | '));
  s.say('Remove plan');
  for (const line of plan) s.say(`  ${line}`);
  const consent = await confirmOrFinish(d, s, 'Remove the published server? [y/N] ', { yes: opts.yes, receipt, confirmationMessage: 'Pass --yes to confirm the removal.' });
  if (consent !== null) return consent;
  const left: string[] = [];
  // service — the receipt may say `skipped` (a `--no-service` run) while a
  // service from an earlier run still exists; probe the supervisor too.
  let serviceTarget: ServiceTarget = receipt.service.target;
  let serviceKnown = receipt.service.state !== 'skipped';
  if (!serviceKnown) {
    serviceTarget = await probeServiceTarget(d);
    if (serviceTarget !== 'none') {
      const unitFile = serviceTarget === 'macos' ? d.plistPath : d.unitPath;
      const state = await serveServiceState({ target: serviceTarget, run: d.run, uid: d.uid });
      serviceKnown = isLiveService(state) || existsSync(unitFile);
      if (serviceKnown) s.say(`Note: the receipt says no service was installed, but a ${serviceLabel(serviceTarget, state, d)} exists — removing it too.`);
    }
  }
  // The plist / unit paths the receipt recorded are never handed to the
  // supervisor step: only the computed paths are touched, and a recorded path
  // that differs is named as left in place.
  for (const [recorded, computed] of [[receipt.service.plist_path, d.plistPath], [receipt.service.unit_path, d.unitPath]] as const) {
    if (recorded !== null && recorded !== computed) left.push(`${tildify(recorded, d.home)} (${RECORDED_ELSEWHERE_NOTE})`);
  }
  let serviceNote = 'there was no service to stop';
  if (serviceKnown && serviceTarget !== 'none') {
    serviceNote = recordServiceUninstall(s, await uninstallServeService({ target: serviceTarget, home: d.home, run: d.run, uid: d.uid, plistPath: d.plistPath, unitPath: d.unitPath }), left);
  } else {
    const manualLeft = receipt.service.target === 'none' && receipt.service.state !== 'skipped';
    s.check('service', 'skipped', manualLeft ? 'manual service: stop the wrapper process yourself if it is running' : 'none installed');
    if (manualLeft) left.push('a manually started server process (if any)');
  }
  // tailscale handler
  if (receipt.tailscale.binary || receipt.tailscale.dns_name) {
    const binary = resolveReceiptBinary(d, receipt);
    if (!binary) {
      s.check('tailscale.publish', 'warn', 'tailscale binary not found; serve handler left as is');
      left.push('the tailscale serve handler (binary not found)');
    } else {
      const read = await readServeView(d, binary);
      if (!read.view) {
        // Fail closed: do not guess which handler is ours, and keep the
        // receipt + wrapper so a re-run can finish the job.
        s.check('tailscale.publish', 'fail', `${describeServeReadFailure(d, read).detail}; handler left as is`);
        s.check('receipt', 'skipped', 'kept (the tailscale serve status could not be read; re-run --remove once it can)');
        s.nextActions.push('tailscale serve status --json', 'gbrain mcp expose --remove --yes');
        s.say('');
        s.say('Stopped here: could not read `tailscale serve status`, so the handler, the wrapper and the receipt were left in place. Fix Tailscale, then re-run `gbrain mcp expose --remove --yes`.');
        return s.finish('error', 1, { receipt, reason: 'tailscale_serve_status_unreadable', message: 'could not read tailscale serve status; handler left as is' });
      }
      const ours = findProxiedHandler(read.view, receipt.port);
      if (!ours) {
        s.check('tailscale.publish', 'ok', `no :443 handler proxies to port ${receipt.port}; nothing to turn off`);
      } else {
        const outcome = await turnOffOurHandler(d, binary, receipt.port, ours, receipt.mode === 'funnel');
        recordHandlerOff(s, outcome, left);
        if (outcome.remaining !== null) {
          return finishHandlerNotRemoved(s, { receipt, port: receipt.port, remaining: outcome.remaining, kept: 'the wrapper and the receipt', rerun: 'gbrain mcp expose --remove --yes', serviceNote });
        }
      }
    }
    left.push('Tailscale itself (installed and signed in)');
  } else {
    s.check('tailscale.publish', 'skipped', 'published without Tailscale');
  }
  // files
  const removed: string[] = [];
  for (const p of [wrapperFile, receiptPath]) {
    if (!inServeDir(p)) { left.push(`${tildify(p, d.home)} (${OUTSIDE_NOTE})`); continue; }
    unlinkQuietly(s, p, removed);
  }
  if (!inServeDir(tokenFile)) {
    left.push(`${tildify(tokenFile, d.home)} (admin token ${OUTSIDE_NOTE})`);
  } else if (opts.force) {
    unlinkQuietly(s, tokenFile, removed);
  } else if (existsSync(tokenFile)) {
    left.push(`${tildify(tokenFile, d.home)} (admin token; pass --force to delete)`);
  }
  s.check('receipt', 'ok', `removed ${removed.map(p => tildify(p, d.home)).join(', ') || 'nothing'}`);
  s.say('');
  s.say('Removed the published MCP server.');
  s.say(`  Left in place: ${left.length ? left.join('; ') : 'nothing'}`);
  s.say(`  Log files: ${tildify(serveLogPath(d.serveDir), d.home)}, ${tildify(serveErrPath(d.serveDir), d.home)} (kept)`);
  return s.finish('removed', 0, { receipt: null });
}

/**
 * `--remove` with NO receipt: an interrupted `gbrain mcp expose` (killed
 * between `tailscale serve --bg` and the receipt write) can leave the
 * wrapper, a launchd/systemd unit and a `:443` handler behind. Recover from
 * what is on disk: remove exactly those artifacts (for `--port`, default
 * 3131), leave the admin token, and say so. A `:443` handler proxying the
 * port is turned off only when something else of gbrain's corroborates it
 * (the wrapper, our unit/plist, or the supervisor reporting our service) —
 * another tool may proxy the same port — or with `--force`. Nothing of ours
 * found → today's "not exposed — nothing to remove", exit 0.
 */
async function runRemoveWithoutReceipt(d: Resolved, s: Session, opts: ExposeOptions): Promise<number> {
  const { wrapper, wrapperExists, binary, target, serviceState, serviceFound, handler, serveUnreadable, evidence } = await probeLeftovers(d, opts.port);
  /** The handler we will turn off: only with corroborating evidence or `--force`. */
  const handlerOff = handler && (evidence || opts.force) ? handler : null;
  const forceRerun = recoveryCommand(opts.port, true);
  if (!evidence && !handlerOff) {
    s.check('receipt', 'skipped', 'no expose receipt; nothing to remove');
    if (serveUnreadable) s.check('tailscale.publish', 'warn', `${describeServeReadFailure(d, serveUnreadable).detail}; a handler for port ${opts.port} could not be checked`);
    if (handler) {
      const note = `a :443 handler proxies ${handler.proxy} but nothing else of gbrain's is here (no wrapper, unit or service), so it is not proven to be ours; left as is — pass --force to turn it off`;
      s.check('tailscale.publish', 'warn', note);
      s.nextActions.push(forceRerun);
      s.say(`Note: ${note}`);
    }
    s.say('not exposed — nothing to remove');
    return s.finish('not_exposed', 0, { reason: 'not_exposed' });
  }
  const plan = [
    serviceFound ? `Service   stop + remove ${serviceKindLabel(target)}${serviceState ? ` (${serviceState})` : ''}` : 'Service   none found',
    handlerOff ? `Tailscale turn off the :443 handler proxying ${handlerOff.proxy}${handlerOff.funnel ? ' (funnel first)' : ''}${evidence ? '' : ' (--force: no wrapper, unit or service corroborates it)'} — Tailscale stays installed and signed in` : serveUnreadable ? `Tailscale could not read serve status; a handler for port ${opts.port} cannot be checked — stops after the service step (exit 1)` : `Tailscale no :443 handler proxies to port ${opts.port}`,
    wrapperExists ? (serveUnreadable ? `Files     keep ${tildify(wrapper, d.home)} (the corroboration a re-run needs while serve status cannot be read)` : `Files     delete ${tildify(wrapper, d.home)}`) : 'Files     no wrapper found',
    `Token     leave ${tildify(adminTokenPathFor(d.serveDir), d.home)} (no receipt names it)`,
  ];
  s.check('receipt', 'warn', `no expose receipt — recovering from what is on disk (port ${opts.port})`);
  s.check('plan', 'ok', plan.join(' | '));
  s.say(`Recovering without a receipt (an interrupted \`gbrain mcp expose\` left these behind; port ${opts.port}):`);
  for (const line of plan) s.say(`  ${line}`);
  const rerun = recoveryCommand(opts.port, opts.force);
  const consent = await confirmOrFinish(d, s, 'Remove these leftovers? [y/N] ', { yes: opts.yes, receipt: null, confirmationMessage: 'Pass --yes to confirm the removal.', nextAction: rerun });
  if (consent !== null) return consent;
  const left: string[] = [];
  let serviceNote = 'no service was found';
  if (serviceFound) {
    serviceNote = recordServiceUninstall(s, await uninstallServeService({ target, home: d.home, run: d.run, uid: d.uid, plistPath: d.plistPath, unitPath: d.unitPath }), left);
  } else {
    s.check('service', 'skipped', 'none found');
  }
  if (handlerOff && binary) {
    const outcome = await turnOffOurHandler(d, binary, opts.port, handlerOff, handlerOff.funnel);
    recordHandlerOff(s, outcome, left);
    // The wrapper stays as corroborating evidence for the re-run (without it
    // a handler standing alone would need `--force`).
    if (outcome.remaining !== null) {
      return finishHandlerNotRemoved(s, { receipt: null, port: opts.port, remaining: outcome.remaining, kept: wrapperExists ? 'the wrapper' : 'nothing (no wrapper was found)', rerun: recoveryCommand(opts.port, opts.force || !wrapperExists), serviceNote });
    }
    left.push('Tailscale itself (installed and signed in)');
  } else if (serveUnreadable) {
    // Fail closed, as with a receipt: the handler cannot be checked, so the
    // wrapper stays as the corroboration the re-run needs (the service, when
    // found, is already gone) and the exit says the job is not finished.
    const kept = wrapperExists ? 'the wrapper' : 'nothing (no wrapper was found)';
    const unreadableRerun = recoveryCommand(opts.port, opts.force || !wrapperExists);
    s.check('tailscale.publish', 'fail', `${describeServeReadFailure(d, serveUnreadable).detail}; handler state unknown`);
    s.check('files', 'skipped', `kept: ${kept} — the :443 handler for port ${opts.port} could not be checked; re-run --remove once tailscale serve status can be read`);
    s.nextActions.push('tailscale serve status --json', unreadableRerun);
    s.say('');
    s.say(`Stopped here: ${serviceNote}, but \`tailscale serve status\` could not be read, so the handler state for port ${opts.port} is unknown. Left in place: ${kept}. Fix Tailscale, then re-run \`${unreadableRerun}\`.`);
    return s.finish('error', 1, { receipt: null, reason: 'tailscale_serve_status_unreadable', message: 'could not read tailscale serve status; handler state unknown' });
  } else {
    s.check('tailscale.publish', 'ok', binary ? `no :443 handler proxies to port ${opts.port}; nothing to turn off` : 'tailscale binary not found; nothing to turn off');
  }
  const removed: string[] = [];
  if (wrapperExists) unlinkQuietly(s, wrapper, removed);
  const tokenFile = adminTokenPathFor(d.serveDir);
  if (existsSync(tokenFile)) left.push(`${tildify(tokenFile, d.home)} (admin token; left without a receipt)`);
  s.check('files', 'ok', `removed ${removed.map(p => tildify(p, d.home)).join(', ') || 'nothing'}`);
  s.say('');
  s.say('Removed the leftovers of an interrupted publish.');
  s.say(`  Left in place: ${left.length ? left.join('; ') : 'nothing'}`);
  return s.finish('removed', 0, { receipt: null, reason: 'recovered_without_receipt' });
}
