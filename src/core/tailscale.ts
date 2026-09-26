/**
 * Tailscale CLI seam for `gbrain mcp expose`.
 *
 * Everything here is either pure (parsers, argv builders, error classifier,
 * URL constants) or goes through the injectable `CommandRunner` exec seam,
 * so the command that drives a real tailnet can be tested against a fake
 * runner in a tmpdir with no `tailscale` binary present.
 *
 * Facts about the CLI this module encodes:
 *   - `tailscale status --json` → `BackendState` ('Running' | 'NeedsLogin' |
 *     'NeedsMachineAuth' | 'NoState' | 'Stopped' | 'Starting'), `Self.DNSName`
 *     (trailing dot), `Self.TailscaleIPs`, `Self.CapMap` (object keyed by
 *     capability URL) or `Self.Capabilities` (string array) — the Funnel node
 *     attribute shows up as `https://tailscale.com/cap/funnel`,
 *     `CurrentTailnet.MagicDNSEnabled`, `CertDomains` (non-empty when HTTPS
 *     certificates are enabled), `Version`. The `--json` form exits 0 in EVERY
 *     BackendState (only the human-readable form exits 1 when logged out), so
 *     callers read `BackendState`, never the exit code.
 *   - `tailscale serve status --json` → the ServeConfig:
 *     `{ TCP: { '443': { HTTPS: true } }, Web: { 'host.tailnet.ts.net:443':
 *     { Handlers: { '/': { Proxy: 'http://127.0.0.1:3131' } } } },
 *     AllowFunnel: { 'host.tailnet.ts.net:443': true } }` — every field may be
 *     absent. It may also carry `Foreground: { <sessionId>: { Web/TCP … } }`
 *     (other terminals' foreground serve sessions) and
 *     `TCP['443'].TCPForward` (a raw TCP forward on :443, no HTTPS handler).
 *   - Publish: `tailscale serve --bg <port>` / `tailscale funnel --bg <port>`.
 *     When HTTPS certificates (or the Funnel attribute) are NOT enabled these
 *     do not fail: the CLI prints an enablement URL and WAITS for the operator
 *     (interactive), so the caller pre-checks `CertDomains` / `funnelCapable`
 *     and never starts them blind. Turn OUR handler off with
 *     `tailscale serve --https=443 --set-path=/ off` /
 *     `tailscale funnel --https=443 --set-path=/ off` — the `--set-path=/`
 *     scopes `off` to the one mount; without it the CLI removes every mount
 *     under :443 and, when more than one exists, prompts interactively (with
 *     stdin ignored the prompt reads EOF and the command exits 0 having
 *     removed nothing). Never `serve reset` (it wipes every handler on the
 *     node, not just ours).
 *   - Login: Linux `sudo tailscale set --operator=<user>` (non-fatal; so the
 *     user can run `serve` without root afterwards) then a flagless
 *     `sudo tailscale up` — `up --operator=` trips the CLI's accidental-
 *     settings-revert check on a node with non-default prefs; macOS
 *     `tailscale up`. `sudo` is only ever put in front of a binary at one of
 *     the system install locations (`isSystemTailscaleBinary`).
 */

import { existsSync, realpathSync } from 'node:fs';
import { shellQuote } from './mcp-registration.ts';

export const TAILSCALE_ADMIN_DNS_URL = 'https://login.tailscale.com/admin/dns';
export const TAILSCALE_ADMIN_ACL_URL = 'https://login.tailscale.com/admin/acls';
export const TAILSCALE_FUNNEL_KB_URL = 'https://tailscale.com/kb/1223/funnel';
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
export const TAILSCALE_LINUX_INSTALL_URL = 'https://tailscale.com/install.sh';

// ---------------------------------------------------------------------------
// Exec seam
// ---------------------------------------------------------------------------

export interface CommandResult {
  /** Exit status; `null` when the process was killed (timeout) or never spawned. */
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  /** Inherit stdio so interactive prompts / auth URLs reach the terminal. */
  inherit?: boolean;
  /**
   * With `inherit`, route the child's stdout to OUR stderr (fd 2) so a
   * `--json` caller keeps stdout as exactly one document. stdin/stderr stay
   * inherited.
   */
  stdoutToStderr?: boolean;
  timeoutMs?: number;
}

/**
 * `argv[0]` is the program (a resolved path or a PATH name such as `sudo`).
 * Never throws for a missing binary — that surfaces as `status: null` with
 * the spawn error in `stderr`, so callers classify instead of crashing.
 */
export type CommandRunner = (argv: string[], opts?: CommandRunOptions) => Promise<CommandResult>;

/** After the SIGTERM at `timeoutMs`, a child that is still alive this much later is SIGKILLed so the caller never hangs on it. */
const SIGKILL_GRACE_MS = 3_000;

export const defaultCommandRunner: CommandRunner = async (argv, opts = {}) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const proc = Bun.spawn(argv, {
      stdin: opts.inherit ? 'inherit' : 'ignore',
      stdout: opts.inherit ? (opts.stdoutToStderr ? 2 : 'inherit') : 'pipe',
      stderr: opts.inherit ? 'inherit' : 'pipe',
      env: process.env,
    });
    let timedOut = false;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill(); } catch { /* already gone */ }
        killTimer = setTimeout(() => {
          // `exited` has not settled: the child ignored (or is still handling) SIGTERM.
          if (proc.exitCode === null && proc.signalCode === null) { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }
        }, SIGKILL_GRACE_MS);
      }, opts.timeoutMs);
    }
    const [stdout, stderr, status] = await Promise.all([
      opts.inherit ? Promise.resolve('') : new Response(proc.stdout as ReadableStream).text(),
      opts.inherit ? Promise.resolve('') : new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { status: timedOut ? null : status, stdout, stderr: timedOut ? `${stderr}\n(timed out after ${opts.timeoutMs}ms)` : stderr };
  } catch (error) {
    return { status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
};

// ---------------------------------------------------------------------------
// Binary discovery + install plan
// ---------------------------------------------------------------------------

/** Probed in order after a PATH lookup. The macOS app bundle ships its own CLI. */
export const TAILSCALE_BINARY_CANDIDATES: readonly string[] = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
];

export interface BinaryProbeDeps {
  which?: (name: string) => string | null;
  fileExists?: (path: string) => boolean;
}

export function findTailscaleBinary(deps: BinaryProbeDeps = {}): string | null {
  const which = deps.which ?? ((name: string) => { try { return Bun.which(name, { PATH: process.env.PATH ?? '' }); } catch { return null; } });
  const fileExists = deps.fileExists ?? ((p: string) => { try { return existsSync(p); } catch { return false; } });
  const onPath = which('tailscale');
  if (onPath) return onPath;
  for (const candidate of TAILSCALE_BINARY_CANDIDATES) if (fileExists(candidate)) return candidate;
  return null;
}

/**
 * Whether `binary` is (or resolves through symlinks to) one of the system
 * install locations. The login step puts `sudo` in front of the binary ONLY
 * when this holds — a user-writable `~/.local/bin/tailscale` found on PATH
 * must never be run as root.
 */
export function isSystemTailscaleBinary(binary: string, realpath: (p: string) => string = realpathSync): boolean {
  if (TAILSCALE_BINARY_CANDIDATES.includes(binary)) return true;
  try { return TAILSCALE_BINARY_CANDIDATES.includes(realpath(binary)); } catch { return false; }
}

export type TailscaleInstallKind = 'brew-cask' | 'linux-script' | 'unsupported';

export interface TailscaleInstallPlan {
  kind: TailscaleInstallKind;
  /** Full argv to run with inherited stdio, or null when unsupported. */
  argv: string[] | null;
  /** Copy-pasteable rendering of `argv` (or the download URL). */
  command: string;
  note: string;
}

export function tailscaleInstallPlan(platform: string, hasBrew: boolean): TailscaleInstallPlan {
  if (platform === 'darwin' && hasBrew) {
    return {
      kind: 'brew-cask',
      argv: ['brew', 'install', '--cask', 'tailscale-app'],
      command: 'brew install --cask tailscale-app',
      note: 'Installs the Tailscale app (its CLI lives in the app bundle). If `tailscale up` is not accepted by the app CLI, open Tailscale and sign in, then re-run.',
    };
  }
  if (platform === 'linux') {
    const script = `curl -fsSL ${TAILSCALE_LINUX_INSTALL_URL} | sh`;
    return {
      kind: 'linux-script',
      argv: ['sh', '-c', script],
      command: `sh -c '${script}'`,
      note: 'The official installer adds the tailscale package repository and calls sudo itself; its prompts stay visible.',
    };
  }
  return {
    kind: 'unsupported',
    argv: null,
    command: TAILSCALE_DOWNLOAD_URL,
    note: platform === 'darwin'
      ? `Homebrew not found. Install Tailscale from ${TAILSCALE_DOWNLOAD_URL}, sign in, then re-run.`
      : `Automatic install is not supported on ${platform}. Install Tailscale from ${TAILSCALE_DOWNLOAD_URL}, sign in, then re-run.`,
  };
}

// ---------------------------------------------------------------------------
// argv builders (subcommand args; the caller prepends the binary — except
// `tailscaleLoginArgv`, which may need `sudo` in front and so returns full argv)
// ---------------------------------------------------------------------------

export function tailscaleServeArgv(port: number, opts: { funnel?: boolean } = {}): string[] {
  return [opts.funnel ? 'funnel' : 'serve', '--bg', String(port)];
}

/** Turn OUR `/` mount on `:443` off — `--set-path=/` scopes `off` to that one mount (never `serve reset`). */
export function tailscaleServeOffArgv(opts: { funnel?: boolean } = {}): string[] {
  return [opts.funnel ? 'funnel' : 'serve', '--https=443', '--set-path=/', 'off'];
}

export const TAILSCALE_STATUS_ARGV: readonly string[] = ['status', '--json'];
export const TAILSCALE_SERVE_STATUS_ARGV: readonly string[] = ['serve', 'status', '--json'];

export interface TailscaleLoginArgv {
  /** Linux only: `sudo <bin> set --operator=<user>` — run first, non-fatal. */
  setOperator?: string[];
  /** The flagless `up` (Linux through `sudo`). */
  up: string[];
}

/**
 * Full argv pair for the login step. Linux sets the operator FIRST with
 * `tailscale set` (exists since 1.34; the caller ignores a failure with a
 * note) and then runs a flagless `sudo tailscale up` — passing `--operator`
 * to `up` trips the CLI's accidental-settings-revert check on a node that
 * already has non-default prefs. macOS: `<bin> up` (the app CLI, no sudo).
 */
export function tailscaleLoginArgv(platform: string, user: string, binary = 'tailscale'): TailscaleLoginArgv {
  if (platform === 'linux') return { setOperator: ['sudo', binary, 'set', `--operator=${user}`], up: ['sudo', binary, 'up'] };
  return { up: [binary, 'up'] };
}

export function tailscaleSetOperatorCommand(user: string): string {
  return `sudo tailscale set --operator=${user}`;
}

/**
 * What the operator runs themselves when gbrain refuses to `sudo` a
 * non-system binary: the DISCOVERED path, shell-quoted, because a binary
 * outside sudo's `secure_path` (`~/.local/bin`) is exactly the case that gets
 * here, and a bare `sudo tailscale` would then say "command not found"
 * (`$USER` expands in their shell). Owns the `--operator` literal so the
 * flag-registry scan of `mcp-expose.ts` never sees tailscale's flags.
 */
export function tailscaleManualLoginCommand(binary = 'tailscale'): string {
  const bin = shellQuote(binary);
  return `sudo ${bin} set --operator=$USER && sudo ${bin} up`;
}

/** Turns MagicDNS resolution on for THIS node — the fix when the host cannot resolve its own `*.ts.net` name. */
export const TAILSCALE_ACCEPT_DNS_COMMAND = 'tailscale set --accept-dns=true';

export function tailscaleDaemonStartHint(platform: string): string {
  return platform === 'darwin' ? 'open -a Tailscale' : 'sudo systemctl enable --now tailscaled';
}

// ---------------------------------------------------------------------------
// `tailscale status --json`
// ---------------------------------------------------------------------------

export type TailscaleBackendState = 'Running' | 'NeedsLogin' | 'NeedsMachineAuth' | 'NoState' | 'Stopped' | 'Starting' | string;

/** Node capability that Tailscale Funnel requires (the `funnel` node attribute in the tailnet policy). */
export const TAILSCALE_FUNNEL_CAPABILITY = 'https://tailscale.com/cap/funnel';

export interface TailscaleStatus {
  backendState: TailscaleBackendState;
  /** Lowercased, trailing dot stripped; null when MagicDNS has not named this node. */
  dnsName: string | null;
  tailscaleIps: string[];
  magicDnsEnabled: boolean | null;
  certDomains: string[];
  /**
   * Whether `Self.CapMap` / `Self.Capabilities` carries the Funnel capability.
   * `null` when neither field is present (older CLI) — the caller then lets the
   * publish command's own error decide.
   */
  funnelCapable: boolean | null;
  version: string | null;
}

export function normalizeDnsName(raw: string): string {
  return raw.trim().replace(/\.+$/, '').toLowerCase();
}

export function publicUrlFromDnsName(dnsName: string): string {
  return `https://${normalizeDnsName(dnsName)}`;
}

/** Returns null when `stdout` is not a JSON object (the caller classifies stderr). */
export function parseTailscaleStatus(stdout: string): TailscaleStatus | null {
  let doc: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    doc = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const self = (doc.Self && typeof doc.Self === 'object' ? doc.Self : {}) as Record<string, unknown>;
  const tailnet = (doc.CurrentTailnet && typeof doc.CurrentTailnet === 'object' ? doc.CurrentTailnet : {}) as Record<string, unknown>;
  const rawDns = typeof self.DNSName === 'string' ? normalizeDnsName(self.DNSName) : '';
  let funnelCapable: boolean | null = null;
  if (self.CapMap && typeof self.CapMap === 'object' && !Array.isArray(self.CapMap)) {
    funnelCapable = Object.keys(self.CapMap as Record<string, unknown>).includes(TAILSCALE_FUNNEL_CAPABILITY);
  }
  if (Array.isArray(self.Capabilities)) {
    funnelCapable = funnelCapable === true || self.Capabilities.includes(TAILSCALE_FUNNEL_CAPABILITY);
  }
  return {
    backendState: typeof doc.BackendState === 'string' ? doc.BackendState : 'NoState',
    dnsName: rawDns || null,
    tailscaleIps: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((v): v is string => typeof v === 'string') : [],
    magicDnsEnabled: typeof tailnet.MagicDNSEnabled === 'boolean' ? tailnet.MagicDNSEnabled : null,
    certDomains: Array.isArray(doc.CertDomains) ? doc.CertDomains.filter((v): v is string => typeof v === 'string') : [],
    funnelCapable,
    version: typeof doc.Version === 'string' ? doc.Version : null,
  };
}

// ---------------------------------------------------------------------------
// `tailscale serve status --json`
// ---------------------------------------------------------------------------

export interface ServeHandler {
  /** `host.tailnet.ts.net` (lowercased, no port). */
  host: string;
  /** Listening port parsed from the `Web` key (`443`). */
  port: number;
  /** Mount path (`/`). */
  path: string;
  /** Raw `Proxy` target (`http://127.0.0.1:3131`), null for non-proxy handlers. */
  proxy: string | null;
  /** Port of the proxy target, null when it cannot be parsed. */
  proxyPort: number | null;
  /** Whether `AllowFunnel` lists this `host:port`. */
  funnel: boolean;
  /**
   * True when the handler comes from `Foreground[<session>]` — another
   * terminal's live `tailscale serve` session. `--bg` cannot overwrite it; it
   * has to be stopped in that terminal.
   */
  foreground: boolean;
  /** Raw TCP forward target from `TCP['443'].TCPForward` (no HTTPS handler); null for Web handlers. */
  tcpForward: string | null;
}

export interface ServeStatusView {
  https443: boolean;
  handlers: ServeHandler[];
  funnelHosts: string[];
}

const EMPTY_SERVE_VIEW: ServeStatusView = { https443: false, handlers: [], funnelHosts: [] };

function proxyPortOf(proxy: string): number | null {
  const m = /:(\d{1,5})(?:\/|$)/.exec(proxy.trim());
  if (!m) return /^https:\/\//i.test(proxy) ? 443 : /^http:\/\//i.test(proxy) ? 80 : null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

interface ServeConfigLike {
  TCP?: Record<string, Record<string, unknown> | undefined>;
  Web?: Record<string, Record<string, unknown> | undefined>;
  AllowFunnel?: Record<string, unknown>;
  Foreground?: Record<string, ServeConfigLike | undefined>;
}

function asObject<T>(v: unknown): T | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null;
}

/** Fold one ServeConfig-shaped block (the root or a `Foreground[<session>]` entry) into `handlers`. */
function collectServeHandlers(block: ServeConfigLike, foreground: boolean, funnelHosts: string[], handlers: ServeHandler[]): boolean {
  const tcp = asObject<Record<string, Record<string, unknown> | undefined>>(block.TCP) ?? {};
  const web = asObject<Record<string, Record<string, unknown> | undefined>>(block.Web) ?? {};
  for (const [hostPort, entry] of Object.entries(web)) {
    const idx = hostPort.lastIndexOf(':');
    const host = (idx > 0 ? hostPort.slice(0, idx) : hostPort).toLowerCase();
    const port = idx > 0 ? Number(hostPort.slice(idx + 1)) : 443;
    const handlerMap = asObject<Record<string, Record<string, unknown> | undefined>>(entry?.Handlers) ?? {};
    for (const [path, h] of Object.entries(handlerMap)) {
      const proxy = typeof h?.Proxy === 'string' ? h.Proxy : null;
      handlers.push({
        host,
        port: Number.isInteger(port) ? port : 443,
        path,
        proxy,
        proxyPort: proxy ? proxyPortOf(proxy) : null,
        funnel: funnelHosts.includes(hostPort.toLowerCase()),
        foreground,
        tcpForward: null,
      });
    }
  }
  // A raw TCP forward on :443 owns the port outright (no HTTPS handler can
  // coexist), so it surfaces as a non-proxy root handler the caller treats as
  // foreign.
  const forward = tcp['443']?.TCPForward;
  if (typeof forward === 'string' && forward.trim()) {
    handlers.push({ host: '', port: 443, path: '/', proxy: null, proxyPort: null, funnel: false, foreground, tcpForward: forward.trim() });
  }
  return tcp['443']?.HTTPS === true;
}

/**
 * Fail-closed, for callers that act on the answer (publish / remove /
 * status): an empty document, `null` or `{}` from a successful exit is a
 * legitimately empty serve config and yields the empty view, but anything
 * that is not JSON or not a JSON object (a stderr-style error line on stdout,
 * an array, a scalar) yields null so the caller classifies stderr instead of
 * mistaking "could not read" for "nothing configured". Background handlers
 * come first, then every `Foreground[<session>]` block (marked
 * `foreground: true`).
 */
export function parseServeStatusStrict(stdout: string): ServeStatusView | null {
  const text = stdout.trim();
  if (!text) return EMPTY_SERVE_VIEW;
  let doc: ServeConfigLike;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null) return EMPTY_SERVE_VIEW;
    const obj = asObject<ServeConfigLike>(parsed);
    if (!obj) return null;
    doc = obj;
  } catch {
    return null;
  }
  const allow = asObject<Record<string, unknown>>(doc.AllowFunnel) ?? {};
  const funnelHosts = Object.entries(allow).filter(([, v]) => v === true).map(([k]) => k.toLowerCase());
  const handlers: ServeHandler[] = [];
  let https443 = collectServeHandlers(doc, false, funnelHosts, handlers);
  const foreground = asObject<Record<string, ServeConfigLike | undefined>>(doc.Foreground) ?? {};
  for (const session of Object.values(foreground)) {
    const block = asObject<ServeConfigLike>(session);
    if (!block) continue;
    const fgAllow = asObject<Record<string, unknown>>(block.AllowFunnel) ?? {};
    const fgFunnelHosts = [...funnelHosts, ...Object.entries(fgAllow).filter(([, v]) => v === true).map(([k]) => k.toLowerCase())];
    https443 = collectServeHandlers(block, true, fgFunnelHosts, handlers) || https443;
  }
  return { https443, handlers, funnelHosts };
}

/** Every `/` handler on `:443` (ours or someone else's). */
export function findRootHandlers(view: ServeStatusView): ServeHandler[] {
  return view.handlers.filter(h => h.port === 443 && h.path === '/');
}

/** The `/` handler on `:443` that proxies to `port`, or null. */
export function findProxiedHandler(view: ServeStatusView, port: number): ServeHandler | null {
  return findRootHandlers(view).find(h => h.proxyPort === port) ?? null;
}

// ---------------------------------------------------------------------------
// stderr classification
// ---------------------------------------------------------------------------

export type TailscaleErrorKind =
  | 'https_not_enabled'
  | 'funnel_not_enabled'
  | 'needs_operator'
  | 'needs_login'
  | 'daemon_not_running'
  | 'unknown';

export interface TailscaleErrorClass {
  kind: TailscaleErrorKind;
  /** One-line remedy the operator can act on. */
  fix: string;
  /** Raw stderr, trimmed (always carried so `unknown` stays diagnosable). */
  raw: string;
}

export function classifyTailscaleError(stderr: string, opts: { platform?: string; user?: string } = {}): TailscaleErrorClass {
  const raw = (stderr ?? '').trim();
  const text = raw.toLowerCase();
  const platform = opts.platform ?? process.platform;
  const user = opts.user ?? '$USER';
  // Funnel first: its messages often mention HTTPS too. The HTTPS rule needs
  // certificate vocabulary — a bare `https://…` URL in any message must not
  // trip it.
  if (/funnel/.test(text) && /not enabled|not available|policy|attr/.test(text)) {
    return { kind: 'funnel_not_enabled', raw, fix: `Enable the \`funnel\` node attribute in your tailnet policy at ${TAILSCALE_ADMIN_ACL_URL} (see ${TAILSCALE_FUNNEL_KB_URL}), then re-run.` };
  }
  if (/https (is )?not enabled/.test(text) || (/https certificates?|certificate/.test(text) && /enabl/.test(text))) {
    return { kind: 'https_not_enabled', raw, fix: `Enable MagicDNS and HTTPS Certificates for your tailnet at ${TAILSCALE_ADMIN_DNS_URL}, then re-run.` };
  }
  if (/operator|access denied|permission denied/.test(text)) {
    return { kind: 'needs_operator', raw, fix: platform === 'darwin' ? 'Open the Tailscale app, make sure it is signed in, then re-run.' : `Run \`${tailscaleSetOperatorCommand(user)}\` so your user may configure serve, then re-run.` };
  }
  if (/logged out|needslogin|not logged in/.test(text)) {
    return { kind: 'needs_login', raw, fix: `Sign in first: \`${tailscaleLoginArgv(platform, user).up.join(' ')}\`, then re-run.` };
  }
  if (/failed to connect to local tailscale|is tailscale running|connection refused/.test(text)) {
    return { kind: 'daemon_not_running', raw, fix: `Start the Tailscale daemon: \`${tailscaleDaemonStartHint(platform)}\`, then re-run.` };
  }
  return { kind: 'unknown', raw, fix: raw ? `Tailscale reported: ${raw}` : 'Tailscale failed without output; run the command by hand to see why.' };
}
