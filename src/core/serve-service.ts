/**
 * Persistent user service for `gbrain serve --http` — installed by
 * `gbrain mcp expose`, torn down by `--remove`.
 *
 * Mirrors the hardening of the autopilot installer (src/commands/autopilot.ts)
 * without importing it: single-quote-escaped paths in the wrapper, plist
 * normalized to 0644 (launchd rejects group-writable agents), domain-explicit
 * `launchctl bootout gui/<uid>` before `bootstrap gui/<uid>` (launchd; the
 * legacy `unload`/`load` pair only when the installed launchctl does not know
 * the modern verbs; a bootstrap that fails while launchd is still unloading
 * the old job is retried with a pause) / enable + restart (systemd) so a
 * reinstall relaunches the
 * job, the running bun's directory prepended to PATH (rc files bail early
 * under a supervisor), `~/.gbrain/env`
 * sourced with `set -a`, and the admin token read from its 0600 file at RUN
 * time — the secret never lands in the plist, unit, or wrapper.
 *
 * Every filesystem and exec effect goes through injectable paths / a
 * `CommandRunner`, so tests run in a tmpdir with a fake runner and never touch
 * `process.env`.
 *
 * Every file this module writes or reads under `~/.gbrain/serve` (token,
 * wrapper, receipt) refuses a symlink at the target path: a planted link could
 * otherwise redirect a 0600 secret or a 0755 executable somewhere else.
 */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { gbrainPath } from './config.ts';
import { shellQuote } from './mcp-registration.ts';
import type { ExecutionEnvironment } from './execution-env.ts';
import type { CommandResult, CommandRunner } from './tailscale.ts';

export const SERVE_LAUNCHD_LABEL = 'com.gbrain.serve';
export const SERVE_SYSTEMD_UNIT = 'gbrain-serve.service';

export type ServiceTarget = 'macos' | 'linux-systemd' | 'none';

// ---------------------------------------------------------------------------
// Paths (all under gbrainPath('serve') so GBRAIN_HOME is honored)
// ---------------------------------------------------------------------------

export function serveDir(): string { return gbrainPath('serve'); }
export function adminTokenPath(dir: string = serveDir()): string { return join(dir, 'admin-token'); }
export function wrapperPath(dir: string = serveDir()): string { return join(dir, 'gbrain-serve.sh'); }
export function receiptPath(dir: string = serveDir()): string { return join(dir, 'expose.json'); }
export function serveLogPath(dir: string = serveDir()): string { return join(dir, 'serve.log'); }
export function serveErrPath(dir: string = serveDir()): string { return join(dir, 'serve.err'); }
export function launchdPlistPath(home: string): string { return join(home, 'Library', 'LaunchAgents', `${SERVE_LAUNCHD_LABEL}.plist`); }
export function systemdUnitPath(home: string): string { return join(home, '.config', 'systemd', 'user', SERVE_SYSTEMD_UNIT); }

// ---------------------------------------------------------------------------
// Target detection (pure — probe results are passed in)
// ---------------------------------------------------------------------------

export interface ServiceTargetSignals {
  platform: string;
  executionEnv: ExecutionEnvironment;
  /** Result of `systemctl --user is-system-running` (null: not probed / no systemctl). */
  userBus?: { status: number | null; stdout: string } | null;
}

/**
 *   - darwin → launchd user agent, always.
 *   - anything that is not a normal machine (cloud sandbox, ephemeral
 *     container) → none: no supervisor survives there.
 *   - linux with a WORKING user bus (`is-system-running` exits 0 or reports
 *     running/degraded) → systemd user unit.
 *   - otherwise none (the caller prints the manual recipe).
 */
export function detectServiceTarget(signals: ServiceTargetSignals): ServiceTarget {
  if (signals.platform === 'darwin') return 'macos';
  if (signals.executionEnv !== 'local') return 'none';
  if (signals.platform !== 'linux') return 'none';
  const bus = signals.userBus;
  if (!bus) return 'none';
  if (bus.status === 0) return 'linux-systemd';
  if (/\b(running|degraded)\b/i.test(bus.stdout)) return 'linux-systemd';
  return 'none';
}

export const SYSTEMCTL_USER_BUS_PROBE_ARGV: readonly string[] = ['systemctl', '--user', 'is-system-running'];

// ---------------------------------------------------------------------------
// Symlink refusal (shared by every write/read under the serve dir)
// ---------------------------------------------------------------------------

/** Throws a clear error when `path` exists AND is a symlink; a missing path is fine. */
export function refuseSymlink(path: string, what: string): void {
  let link = false;
  try { link = lstatSync(path).isSymbolicLink(); } catch { return; }
  if (link) throw new Error(`refusing to use ${what} at ${path}: it is a symlink (remove it and re-run)`);
}

// ---------------------------------------------------------------------------
// gbrain CLI resolution for the wrapper
// ---------------------------------------------------------------------------

export interface ResolveGbrainCommandDeps {
  which?: (name: string) => string | null;
  execPath?: string;
  argv1?: string;
  /** `import.meta.url` of this module (a compiled binary reports a `/$bunfs/` path). */
  metaUrl?: string;
  fileExists?: (path: string) => boolean;
}

/** Bun's own runtime binary (`bun`, `bun-profile`, `bun.exe`), as opposed to a compiled gbrain. */
const BUN_RUNTIME_RE = /(^|[\\/])bun(-[a-z0-9-]+)?(\.exe)?$/i;
/** A compiled binary's embedded entrypoint: `/$bunfs/root/...` (POSIX) or `B:\~BUN\...` (Windows). */
const VIRTUAL_ENTRY_RE = /\$bunfs|~BUN/;

/**
 * argv prefix baked into the wrapper: `[<gbrain shim>]`, or `[<execPath>]`
 * when the running binary is a compiled gbrain (whatever its basename — a
 * compiled Bun binary reports its embedded sources under `/$bunfs/` and has
 * no real script in `argv[1]`), else `[<bun>, <abs cli.ts>]` when that
 * `cli.ts` exists on disk; without it, `[<execPath>]` again rather than a
 * path that cannot run. The wrapper falls back to `type -P gbrain` at run
 * time when argv[0] is gone.
 */
export function resolveServeGbrainCommand(deps: ResolveGbrainCommandDeps = {}): string[] {
  const which = deps.which ?? ((name: string) => { try { return Bun.which(name, { PATH: process.env.PATH ?? '' }); } catch { return null; } });
  const onPath = which('gbrain');
  if (onPath) return [onPath];
  const exec = deps.execPath ?? process.execPath ?? '';
  const arg1 = deps.argv1 ?? process.argv[1] ?? '';
  const metaUrl = deps.metaUrl ?? import.meta.url;
  const fileExists = deps.fileExists ?? ((p: string) => { try { return existsSync(p); } catch { return false; } });
  const compiled = VIRTUAL_ENTRY_RE.test(metaUrl) || (!!exec && !BUN_RUNTIME_RE.test(exec) && (!arg1 || VIRTUAL_ENTRY_RE.test(arg1)));
  if (compiled && exec) return [exec];
  if (exec.endsWith('/gbrain') || exec.endsWith('\\gbrain.exe')) return [exec];
  if (arg1.endsWith('/gbrain') || arg1.endsWith('\\gbrain.exe')) return [arg1];
  let cliTs: string | null = null;
  try { cliTs = resolvePath(dirname(fileURLToPath(metaUrl)), '..', 'cli.ts'); } catch { cliTs = null; }
  if (cliTs && fileExists(cliTs)) return [exec || 'bun', cliTs];
  return [exec || 'bun'];
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export interface ServeCommandParams {
  port: number;
  publicUrl: string;
  surface?: 'verbs' | 'starter' | 'full';
  enableDcr?: boolean;
}

/** `serve --http --port N --public-url URL [--surface X] [--enable-dcr]` as argv. */
export function serveCommandArgv(p: ServeCommandParams): string[] {
  const argv = ['serve', '--http', '--port', String(p.port), '--public-url', p.publicUrl];
  if (p.surface) argv.push('--surface', p.surface);
  if (p.enableDcr) argv.push('--enable-dcr');
  return argv;
}

export interface WrapperParams extends ServeCommandParams {
  /** From resolveServeGbrainCommand: `[gbrain]` or `[bun, cli.ts]`. */
  gbrainCommand: string[];
  adminTokenPath: string;
  /** `~/.gbrain/env` (absolute). */
  gbrainEnvFile: string;
  /** Installer's GBRAIN_HOME, baked when present (the supervisor passes no env). */
  gbrainHome?: string;
  /** Directory of the running bun (dirname(process.execPath)); '' skips the prefix. */
  runtimeDir?: string;
}

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export function renderServeWrapper(p: WrapperParams): string {
  const serveArgs = serveCommandArgv(p).map(shellQuote).join(' ');
  const [program, ...programArgs] = p.gbrainCommand;
  const programTail = programArgs.map(sq).join(' ');
  const runtimeDir = p.runtimeDir ?? '';
  const runtimePrefix = runtimeDir && runtimeDir !== '.' ? `${sq(runtimeDir)}:` : '';
  const homeLine = p.gbrainHome
    ? `# Baked at install: the supervisor does not pass the installer's env.\nexport GBRAIN_HOME=${sq(p.gbrainHome)}\n`
    : '';
  return `#!/bin/bash
# Auto-generated by \`gbrain mcp expose\` — runs the gbrain MCP server under the
# user service. Re-run \`gbrain mcp expose\` to regenerate; \`--remove\` deletes it.
# Shell profiles are sourced best-effort for API keys (zshenv first: it is the
# only zsh file non-interactive shells read).
[ -f ~/.zshenv ] && source ~/.zshenv 2>/dev/null
[ -f ~/.zshrc ] && source ~/.zshrc 2>/dev/null
[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null
# gbrain-owned env file (KEY=value lines, auto-exported), sourced last so it wins.
[ -f ${sq(p.gbrainEnvFile)} ] && { set -a; source ${sq(p.gbrainEnvFile)} 2>/dev/null; set +a; }
# rc files bail early under a supervisor, so put the running bun on PATH ourselves.
export PATH=${runtimePrefix}"$HOME/.bun/bin:$PATH"
${homeLine}# The admin token is read from its 0600 file at RUN time; it never lands in
# this wrapper, the plist, or the unit.
if [ ! -r ${sq(p.adminTokenPath)} ]; then
  echo "$(date -u +%FT%TZ) [gbrain-serve] admin token file missing or unreadable:" ${sq(p.adminTokenPath)} "- re-run: gbrain mcp expose" >&2
  exit 1
fi
GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$(cat ${sq(p.adminTokenPath)})"
export GBRAIN_ADMIN_BOOTSTRAP_TOKEN
cd "$HOME"
_gbrain=${sq(program)}
if [ ! -x "$_gbrain" ]; then
  _resolved=$(type -P gbrain 2>/dev/null)
  if [ -n "$_resolved" ]; then
    echo "$(date -u +%FT%TZ) [gbrain-serve] baked CLI path is gone:" ${sq(program)} "- using $_resolved"
    exec "$_resolved" ${serveArgs}
  fi
  echo "$(date -u +%FT%TZ) [gbrain-serve] gbrain CLI not found at" ${sq(program)} "nor on PATH; re-run: gbrain mcp expose" >&2
  exit 1
fi
exec "$_gbrain"${programTail ? ` ${programTail}` : ''} ${serveArgs}
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface LaunchdParams { wrapperPath: string; home: string; logPath: string; errPath: string }

export function renderServeLaunchdPlist(p: LaunchdParams): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(SERVE_LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(p.wrapperPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(p.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${escapeXml(p.logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(p.errPath)}</string>
</dict>
</plist>
`;
}

export interface SystemdParams { wrapperPath: string; logPath: string; errPath: string }

/** systemd specifier escaping (`%h` etc. expand in every path-like setting): `%` → `%%`. */
function systemdSpecifierEscape(s: string): string {
  return s.replace(/%/g, '%%');
}

/**
 * ExecStart quoting: `%` → `%%` (specifiers), `$` → `$$` (environment
 * expansion), then double-quote when the path carries whitespace or quotes.
 */
function systemdArg(s: string): string {
  const escaped = systemdSpecifierEscape(s).replace(/\$/g, '$$$$');
  return /[\s"'\\]/.test(escaped) ? `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : escaped;
}

export function renderServeSystemdUnit(p: SystemdParams): string {
  return `[Unit]
Description=GBrain MCP server (gbrain serve --http)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=${systemdArg(p.wrapperPath)}
Restart=always
RestartSec=10
StandardOutput=append:${systemdSpecifierEscape(p.logPath)}
StandardError=append:${systemdSpecifierEscape(p.errPath)}

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// Admin token
// ---------------------------------------------------------------------------

export const ADMIN_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,}$/;

export interface EnsureAdminTokenResult {
  path: string;
  /** 'created' (no file), 'reused' (valid file), 'regenerated' (file present but malformed). */
  action: 'created' | 'reused' | 'regenerated';
}

/** `openSync(path, 'wx', 0o600)`: the file is born 0600 and never exists briefly with looser bits. */
function writeTokenExclusive(path: string, token: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, `${token}\n`); } finally { closeSync(fd); }
  chmodSync(path, 0o600);
}

/**
 * Ensure `path` holds a token `resolveBootstrapToken` accepts (dir 0700,
 * file 0600, 64 hex chars from 32 random bytes). Reuses a valid file so the
 * dashboard session survives re-runs; regenerates a malformed one
 * (unlink + exclusive recreate). Refuses a symlink at `path`. Never returns
 * the token itself.
 */
export function ensureAdminToken(path: string, deps: { randomHex?: () => string } = {}): EnsureAdminTokenResult {
  const randomHex = deps.randomHex ?? (() => randomBytes(32).toString('hex'));
  refuseSymlink(path, 'the admin token file');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(path), 0o700); } catch { /* best effort */ }
  const readCurrent = (): string => { try { return readFileSync(path, 'utf-8').trim(); } catch { return ''; } };
  let action: EnsureAdminTokenResult['action'] = 'created';
  if (existsSync(path)) {
    if (ADMIN_TOKEN_SHAPE.test(readCurrent())) {
      try { chmodSync(path, 0o600); } catch { /* best effort */ }
      return { path, action: 'reused' };
    }
    action = 'regenerated';
    unlinkSync(path);
  }
  try {
    writeTokenExclusive(path, randomHex());
  } catch (error) {
    // Lost a race with a concurrent writer: a valid token that appeared in the
    // meantime is reused; anything else is replaced.
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST')) throw error;
    if (ADMIN_TOKEN_SHAPE.test(readCurrent())) return { path, action: 'reused' };
    unlinkSync(path);
    writeTokenExclusive(path, randomHex());
    action = 'regenerated';
  }
  return { path, action };
}

// ---------------------------------------------------------------------------
// Install / uninstall / state
// ---------------------------------------------------------------------------

export type ServiceState = 'running' | 'loaded' | 'stopped' | 'not-installed' | 'manual' | 'unknown';

export interface InstallServiceParams {
  target: ServiceTarget;
  wrapperPath: string;
  wrapperContent: string;
  home: string;
  logPath: string;
  errPath: string;
  run: CommandRunner;
  /** Override the launchd plist path (default `<home>/Library/LaunchAgents/<label>.plist`). */
  plistPath?: string;
  /** Override the systemd unit path (default `<home>/.config/systemd/user/<unit>`). */
  unitPath?: string;
  /** launchd domain owner for `bootout`/`bootstrap gui/<uid>` (default: the running process's uid, else 501). */
  uid?: number;
  /** Wait between launchd bootstrap settle retries (default `setTimeout`; tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export interface InstallServiceResult {
  target: ServiceTarget;
  wrapper_path: string;
  plist_path: string | null;
  unit_path: string | null;
  /** Non-fatal notes (linger hint, unload noise). */
  notes: string[];
  /** Set when the supervisor refused the job; the caller reports a failed check. */
  error?: string;
}

/** One-line reason for a failed supervisor call: its output, or the exit status when it printed nothing. */
function describeFailure(r: CommandResult): string {
  return (r.stderr || r.stdout).trim() || `exit ${r.status}`;
}

/** `launchctl bootstrap/bootout` (or legacy `load/unload`), `systemctl --user enable/restart/disable` may block on a wedged manager. */
const SUPERVISOR_CHANGE_TIMEOUT_MS = 60_000;
/** Read-only probes and reloads: `launchctl print`, `daemon-reload`, `is-active`, `loginctl enable-linger`. */
const SUPERVISOR_PROBE_TIMEOUT_MS = 15_000;

/** The launchctl on this Mac predates the domain-explicit verbs (macOS < 10.11 era, or a stripped build). */
const LAUNCHCTL_LEGACY_RE = /Unknown command|unrecognized|not found/i;
/**
 * `bootstrap` right after `bootout` can fail while launchd is still tearing
 * the old job down: "Bootstrap failed: 5: Input/output error", "37: Operation
 * already in progress". Transient — retried with a pause.
 */
const LAUNCHCTL_SETTLE_RE = /Input\/output error|already in progress|\b5\b|\b37\b/;
const LAUNCHCTL_SETTLE_RETRIES = 5;
const LAUNCHCTL_SETTLE_MS = 1_000;
/** A `bootout` of a job that is not loaded — expected on a fresh install or after a manual removal, never reported. */
const LAUNCHCTL_NOT_LOADED_RE = /No such process|not loaded|Could not find|not find service/i;

function defaultUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 501;
}

interface LaunchctlVerbs { modern: 'bootout' | 'bootstrap'; legacy: 'unload' | 'load' }

/**
 * `launchctl <modern> gui/<uid> <plist>` (domain-explicit), falling back to
 * the legacy `launchctl <legacy> <plist>` ONLY when launchctl itself does not
 * know the verb (non-zero exit whose stderr says so). `verb` names the call
 * whose result is returned. A "not loaded" bootout failure is returned as
 * is; callers ignore it.
 */
async function launchctl(run: CommandRunner, uid: number, plist: string, verbs: LaunchctlVerbs): Promise<{ result: CommandResult; verb: LaunchctlVerbs['modern'] | LaunchctlVerbs['legacy'] }> {
  const r = await run(['launchctl', verbs.modern, `gui/${uid}`, plist], { timeoutMs: SUPERVISOR_CHANGE_TIMEOUT_MS });
  if (typeof r.status === 'number' && r.status !== 0 && LAUNCHCTL_LEGACY_RE.test(r.stderr)) {
    return { result: await run(['launchctl', verbs.legacy, plist], { timeoutMs: SUPERVISOR_CHANGE_TIMEOUT_MS }), verb: verbs.legacy };
  }
  return { result: r, verb: verbs.modern };
}

function writeExecutable(path: string, content: string, mode: number, what: string): void {
  refuseSymlink(path, what);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

export async function installServeService(p: InstallServiceParams): Promise<InstallServiceResult> {
  const result: InstallServiceResult = { target: p.target, wrapper_path: p.wrapperPath, plist_path: null, unit_path: null, notes: [] };
  writeExecutable(p.wrapperPath, p.wrapperContent, 0o755, 'the serve wrapper');
  if (p.target === 'macos') {
    const plist = p.plistPath ?? launchdPlistPath(p.home);
    writeExecutable(plist, renderServeLaunchdPlist({ wrapperPath: p.wrapperPath, home: p.home, logPath: p.logPath, errPath: p.errPath }), 0o644, 'the launchd plist');
    result.plist_path = plist;
    // Bootout-before-bootstrap: `bootstrap` over a loaded agent errors, and a
    // running server must relaunch to pick up a regenerated wrapper anyway.
    // The bootout failure ("not loaded" on a fresh install) is ignored.
    const uid = p.uid ?? defaultUid();
    const sleep = p.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    await launchctl(p.run, uid, plist, { modern: 'bootout', legacy: 'unload' });
    let boot = await launchctl(p.run, uid, plist, { modern: 'bootstrap', legacy: 'load' });
    let retries = 0;
    while (boot.result.status !== 0 && retries < LAUNCHCTL_SETTLE_RETRIES && LAUNCHCTL_SETTLE_RE.test(boot.result.stderr)) {
      retries++;
      await sleep(LAUNCHCTL_SETTLE_MS);
      boot = await launchctl(p.run, uid, plist, { modern: 'bootstrap', legacy: 'load' });
    }
    if (boot.result.status !== 0) result.error = `launchctl ${boot.verb} failed: ${describeFailure(boot.result)}${retries ? ` (after ${retries} settle ${retries === 1 ? 'retry' : 'retries'})` : ''}`;
    else if (retries) result.notes.push(`launchctl ${boot.verb} succeeded after ${retries} settle ${retries === 1 ? 'retry' : 'retries'} (launchd was still unloading the previous job)`);
    return result;
  }
  if (p.target === 'linux-systemd') {
    const unit = p.unitPath ?? systemdUnitPath(p.home);
    writeExecutable(unit, renderServeSystemdUnit({ wrapperPath: p.wrapperPath, logPath: p.logPath, errPath: p.errPath }), 0o644, 'the systemd unit');
    result.unit_path = unit;
    const reload = await p.run(['systemctl', '--user', 'daemon-reload'], { timeoutMs: SUPERVISOR_PROBE_TIMEOUT_MS });
    if (reload.status !== 0) result.notes.push(`systemctl --user daemon-reload: ${describeFailure(reload)}`);
    const enable = await p.run(['systemctl', '--user', 'enable', SERVE_SYSTEMD_UNIT], { timeoutMs: SUPERVISOR_CHANGE_TIMEOUT_MS });
    if (enable.status !== 0) {
      result.error = `systemctl --user enable ${SERVE_SYSTEMD_UNIT} failed: ${describeFailure(enable)}`;
      return result;
    }
    // `restart` (not `enable --now`): a reinstall regenerates the wrapper and
    // the running server must relaunch to pick it up; on a fresh install
    // restart simply starts it.
    const restart = await p.run(['systemctl', '--user', 'restart', SERVE_SYSTEMD_UNIT], { timeoutMs: SUPERVISOR_CHANGE_TIMEOUT_MS });
    if (restart.status !== 0) {
      result.error = `systemctl --user restart ${SERVE_SYSTEMD_UNIT} failed: ${describeFailure(restart)}`;
      return result;
    }
    // Without linger the user manager stops at logout and takes the server with it.
    const linger = await p.run(['loginctl', 'enable-linger'], { timeoutMs: SUPERVISOR_PROBE_TIMEOUT_MS });
    if (linger.status !== 0) result.notes.push('loginctl enable-linger failed; the server stops when you log out. Fix: sudo loginctl enable-linger "$USER"');
    return result;
  }
  return result;
}

export interface UninstallServiceParams {
  target: ServiceTarget;
  home: string;
  run: CommandRunner;
  plistPath?: string | null;
  unitPath?: string | null;
  /** launchd domain owner for `bootout gui/<uid>` (default: the running process's uid, else 501). */
  uid?: number;
}

export interface UninstallServiceResult {
  removed: string[];
  /** Non-fatal notes; a `launchctl bootout failed: …` / `launchctl unload failed: …` line means the launchd job may still be loaded. */
  notes: string[];
}

/** True when `uninstallServeService` could not boot the launchd job out for a reason other than "not loaded". */
export function launchdBootoutFailed(r: UninstallServiceResult): boolean {
  return r.notes.some(n => /^launchctl (bootout|unload) failed:/.test(n));
}

export async function uninstallServeService(p: UninstallServiceParams): Promise<UninstallServiceResult> {
  const out: UninstallServiceResult = { removed: [], notes: [] };
  if (p.target === 'macos') {
    const plist = p.plistPath ?? launchdPlistPath(p.home);
    const boot = await launchctl(p.run, p.uid ?? defaultUid(), plist, { modern: 'bootout', legacy: 'unload' });
    // A job that was not loaded is the expected answer; anything else means
    // the job may still be running and the caller has to say so.
    if (boot.result.status !== 0 && !LAUNCHCTL_NOT_LOADED_RE.test(boot.result.stderr)) out.notes.push(`launchctl ${boot.verb} failed: ${describeFailure(boot.result)}`);
    if (existsSync(plist)) { unlinkSync(plist); out.removed.push(plist); }
    return out;
  }
  if (p.target === 'linux-systemd') {
    const unit = p.unitPath ?? systemdUnitPath(p.home);
    const disable = await p.run(['systemctl', '--user', 'disable', '--now', SERVE_SYSTEMD_UNIT], { timeoutMs: SUPERVISOR_CHANGE_TIMEOUT_MS });
    if (disable.status !== 0) out.notes.push(`systemctl --user disable --now: ${describeFailure(disable)}`);
    if (existsSync(unit)) { unlinkSync(unit); out.removed.push(unit); }
    await p.run(['systemctl', '--user', 'daemon-reload'], { timeoutMs: SUPERVISOR_PROBE_TIMEOUT_MS });
    return out;
  }
  return out;
}

export async function serveServiceState(p: { target: ServiceTarget; run: CommandRunner; uid?: number }): Promise<ServiceState> {
  if (p.target === 'macos') {
    const uid = p.uid ?? defaultUid();
    const r = await p.run(['launchctl', 'print', `gui/${uid}/${SERVE_LAUNCHD_LABEL}`], { timeoutMs: SUPERVISOR_PROBE_TIMEOUT_MS });
    if (r.status === null) return 'unknown';
    if (r.status !== 0) return 'not-installed';
    return /state\s*=\s*running/i.test(r.stdout) ? 'running' : 'loaded';
  }
  if (p.target === 'linux-systemd') {
    const r = await p.run(['systemctl', '--user', 'is-active', SERVE_SYSTEMD_UNIT], { timeoutMs: SUPERVISOR_PROBE_TIMEOUT_MS });
    if (r.status === null) return 'unknown';
    const word = r.stdout.trim().split(/\s+/)[0] ?? '';
    if (word === 'active' || word === 'activating' || word === 'reloading') return 'running';
    if (word === 'inactive' || word === 'failed' || word === 'deactivating') {
      return /could not be found|not-found|no such/i.test(r.stderr) ? 'not-installed' : 'stopped';
    }
    return r.status === 0 ? 'running' : 'unknown';
  }
  return 'manual';
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

export interface ExposeReceipt {
  version: 1;
  created_at: string;
  updated_at: string;
  port: number;
  public_url: string;
  mcp_url: string;
  admin_url: string;
  mode: 'tailnet' | 'funnel';
  surface: 'verbs' | 'starter' | 'full';
  enable_dcr: boolean;
  tailscale: { binary: string | null; dns_name: string | null; tailscale_version: string | null };
  service: { target: ServiceTarget; unit_path: string | null; plist_path: string | null; wrapper_path: string; state: ServiceState | 'skipped' };
  admin_token_file: string;
  engine: 'pglite' | 'postgres' | 'unknown';
}

const RECEIPT_MODES: readonly string[] = ['tailnet', 'funnel'];
const RECEIPT_TARGETS: readonly string[] = ['macos', 'linux-systemd', 'none'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/**
 * Structural guard for a parsed receipt. Every field `--status` / `--remove`
 * dereference without a null check must be present with the right type;
 * anything less is treated as "no receipt" rather than crashing mid-command.
 */
function isExposeReceipt(v: unknown): v is ExposeReceipt {
  if (!isRecord(v)) return false;
  if (v.version !== 1 || typeof v.port !== 'number' || typeof v.public_url !== 'string') return false;
  if (typeof v.mcp_url !== 'string' || typeof v.admin_url !== 'string' || typeof v.admin_token_file !== 'string') return false;
  if (typeof v.mode !== 'string' || !RECEIPT_MODES.includes(v.mode)) return false;
  const service = v.service;
  if (!isRecord(service) || typeof service.wrapper_path !== 'string' || typeof service.state !== 'string') return false;
  if (typeof service.target !== 'string' || !RECEIPT_TARGETS.includes(service.target)) return false;
  if (!isStringOrNull(service.plist_path) || !isStringOrNull(service.unit_path)) return false;
  const tailscale = v.tailscale;
  if (!isRecord(tailscale) || !isStringOrNull(tailscale.binary) || !isStringOrNull(tailscale.dns_name)) return false;
  return true;
}

/** Malformed, partial or missing → null; a symlink at `path` throws (never follow a planted link). */
export function readExposeReceipt(path: string): ExposeReceipt | null {
  refuseSymlink(path, 'the expose receipt');
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return isExposeReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeExposeReceipt(path: string, receipt: ExposeReceipt): void {
  refuseSymlink(path, 'the expose receipt');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
