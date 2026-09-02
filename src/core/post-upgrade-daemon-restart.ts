/**
 * Post-upgrade daemon restart — keep background processes on the same code
 * the freshly-swapped CLI is running.
 *
 * Failure mode this closes: `gbrain self-upgrade` / `gbrain upgrade` swaps the
 * installed package, but launchd/systemd KeepAlive daemons keep the OLD code
 * in memory. A later CLI (new chunker / schema assumptions) then fights the
 * still-running workers — e.g. chunker_version gate force-rechunking the
 * entire brain and nulling embeddings on every cycle until someone manually
 * restarts the daemons.
 *
 * Called from `runPostUpgrade` (and the `--swap-only` early-return path) as a
 * best-effort phase: a restart failure is recorded loudly via
 * `recordUpgradeError` but NEVER fails the upgrade itself.
 *
 * Detection (macOS):
 *   1. Label allow-pattern: label matches /gbrain/i (covers upstream
 *      `com.gbrain.autopilot` / `com.gbrain.brain-pull.*` AND user-created
 *      labels like `com.example.gbrain-http` without hardcoding them).
 *   2. Program/arguments reference the gbrain binary OR a wrapper script
 *      whose contents invoke gbrain (autopilot-run.sh pattern).
 *   3. Long-running only: KeepAlive OR a live PID in `launchctl list`.
 *      Calendar/interval one-shots spawn fresh and pick up new code alone.
 *
 * Interactive `gbrain serve` sessions (no supervisor to bring them back) are
 * NEVER killed — they are listed in a loud warning with PIDs.
 *
 * Non-macOS: try-restart the known autopilot systemd user unit when present;
 * otherwise print an actionable warning naming live gbrain daemon PIDs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Upstream autopilot systemd unit (see src/commands/autopilot.ts). */
export const AUTOPILOT_SYSTEMD_UNIT = 'gbrain-autopilot.service';

export interface LaunchctlListRow {
  /** null when launchctl shows `-` (loaded but not currently running). */
  pid: number | null;
  lastExitStatus: number;
  label: string;
}

export interface LaunchdJobSnapshot {
  label: string;
  pid: number | null;
  programArgs: string[];
  keepAlive: boolean;
}

export interface LiveGbrainProcess {
  pid: number;
  cmdline: string;
}

export type DaemonRestartKind =
  | 'launchd-kickstart'
  | 'systemd-try-restart'
  | 'warn-unmanaged'
  | 'warn-platform';

export interface DaemonRestartAction {
  kind: DaemonRestartKind;
  target: string;
  ok: boolean;
  detail?: string;
}

export interface DaemonRestartReport {
  platform: NodeJS.Platform;
  actions: DaemonRestartAction[];
  /** PIDs of interactive/unmanaged gbrain processes the user should restart. */
  unmanagedWarnings: LiveGbrainProcess[];
}

export interface DaemonRestartDeps {
  platform?: NodeJS.Platform;
  uid?: number;
  home?: string;
  /** `launchctl list` stdout. */
  launchctlList?: () => string;
  /** Read ProgramArguments + KeepAlive for a label (plist or launchctl print). */
  readLaunchdJob?: (label: string) => { programArgs: string[]; keepAlive: boolean } | null;
  /** Run `launchctl kickstart -k gui/<uid>/<label>`. Throws on failure. */
  kickstart?: (label: string, uid: number) => void;
  /** `systemctl --user try-restart <unit>`. Throws on failure. */
  systemctlTryRestart?: (unit: string) => void;
  /** True when the systemd user unit is loaded/available. */
  systemdUnitPresent?: (unit: string) => boolean;
  /** Snapshot of live processes whose cmdline mentions gbrain. */
  listGbrainProcesses?: () => LiveGbrainProcess[];
  /** Optional file reader for wrapper-script sniffing (injectable). */
  readFile?: (path: string) => string;
  /** Log sink (defaults to console). */
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

// ── Pure predicates ──────────────────────────────────────────────────────────

/**
 * Label allow-pattern: any launchd label that names gbrain. Covers upstream
 * installer labels (`com.gbrain.autopilot`) and user-created ones
 * (`com.phullcutz.gbrain-http`) without hardcoding either set.
 */
export function looksLikeGbrainOwnedLaunchdLabel(label: string): boolean {
  if (!label) return false;
  // Skip the local WatchPaths workaround some installs use to restart daemons
  // after upgrade — kickstarting THAT job from inside post-upgrade is a loop.
  if (/postupgrade-restart/i.test(label)) return false;
  return /gbrain/i.test(label);
}

/**
 * Does this ProgramArguments vector run the gbrain binary (directly or via a
 * wrapper script whose body invokes gbrain)?
 */
export function programArgsReferenceGbrain(
  programArgs: string[],
  opts: { readFile?: (path: string) => string; maxScriptBytes?: number } = {},
): boolean {
  if (!programArgs.length) return false;
  for (const arg of programArgs) {
    if (argReferencesGbrainBinary(arg)) return true;
    // Upstream autopilot wrapper basename — even before we sniff contents.
    if (/(^|\/)autopilot-run\.sh$/i.test(arg.replace(/\\/g, '/'))) return true;
  }
  // Sniff wrapper scripts: ProgramArguments often point at a shell script
  // under ~/.gbrain/ that `exec`s gbrain (autopilot-run.sh, serve-http.sh).
  const read = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const maxBytes = opts.maxScriptBytes ?? 64_000;
  for (const arg of programArgs) {
    if (!arg || arg.startsWith('-')) continue;
    // Only sniff paths that look like files we can read.
    if (!/[\/\\]/.test(arg) && !arg.endsWith('.sh')) continue;
    try {
      const body = read(arg).slice(0, maxBytes);
      if (/\bgbrain\b/.test(body)) return true;
      if (/cli\.(?:ts|js|mjs)/i.test(body) && /autopilot|serve|supervisor|jobs\s+work/i.test(body)) {
        return true;
      }
    } catch {
      /* unreadable — fall through */
    }
  }
  return false;
}

/** Path or bare token that is the gbrain CLI binary / entrypoint. */
export function argReferencesGbrainBinary(arg: string): boolean {
  const normalized = arg.replace(/\\/g, '/').trim();
  if (!normalized) return false;
  // bare `gbrain` / `gbrain.exe`
  if (/^gbrain(?:\.exe)?$/i.test(normalized)) return true;
  // /path/to/gbrain or .../bin/gbrain
  if (/(?:^|\/)gbrain(?:\.exe)?$/i.test(normalized)) return true;
  // bun-run of src/cli.ts (dev / bun-link installs inside a wrapper)
  if (/(?:^|\/)(?:src\/)?cli\.(?:ts|js|mjs)$/i.test(normalized)) return true;
  return false;
}

/**
 * Long-running = currently has a live PID, OR KeepAlive so launchd will keep
 * a process around. Interval/calendar jobs spawn fresh per fire and do not
 * hold old code in memory between runs.
 */
export function isLongRunningLaunchdJob(job: Pick<LaunchdJobSnapshot, 'pid' | 'keepAlive'>): boolean {
  if (job.keepAlive) return true;
  return typeof job.pid === 'number' && job.pid > 0;
}

export function shouldRestartLaunchdJob(job: LaunchdJobSnapshot, opts?: { readFile?: (path: string) => string }): boolean {
  if (!looksLikeGbrainOwnedLaunchdLabel(job.label)) return false;
  if (!isLongRunningLaunchdJob(job)) return false;
  return programArgsReferenceGbrain(job.programArgs, opts);
}

/**
 * Classify a live process cmdline for the unmanaged-warning path.
 * Returns null when the process is transient CLI noise (upgrade itself, doctor, …).
 */
export function classifyLiveGbrainProcess(cmdline: string): 'daemon' | 'serve' | 'transient' | null {
  const c = cmdline.replace(/\s+/g, ' ').trim();
  if (!/\bgbrain\b/i.test(c) && !/cli\.(?:ts|js|mjs)/i.test(c)) return null;
  // Self / one-shot CLI — never warn about the upgrade process itself.
  if (/\b(self-upgrade|post-upgrade|upgrade|check-update)\b/i.test(c)) return 'transient';
  if (/\b(doctor|features|apply-migrations|init|config|version|--help)\b/i.test(c) && !/\b(serve|autopilot|supervisor|jobs\s+work)\b/i.test(c)) {
    return 'transient';
  }
  if (/\bserve\b/i.test(c)) return 'serve';
  if (/\bautopilot\b/i.test(c) && !/\bautopilot\s+--(?:install|uninstall|status|help)\b/i.test(c)) return 'daemon';
  if (/\bjobs\s+supervisor\b/i.test(c)) return 'daemon';
  if (/\bjobs\s+work\b/i.test(c)) return 'daemon';
  return null;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/**
 * Parse `launchctl list` output. Header row `PID Status Label` is skipped.
 * PID column is `-` when the job is loaded but not running.
 */
export function parseLaunchctlList(output: string): LaunchctlListRow[] {
  const rows: LaunchctlListRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^PID\b/i.test(trimmed)) continue;
    // PID may be `-` or an integer; Status is an integer (possibly negative);
    // Label is the remainder (may contain spaces in theory — launchd labels don't).
    const m = /^(-|\d+)\s+(-?\d+)\s+(\S+)\s*$/.exec(trimmed);
    if (!m) continue;
    rows.push({
      pid: m[1] === '-' ? null : Number(m[1]),
      lastExitStatus: Number(m[2]),
      label: m[3],
    });
  }
  return rows;
}

/**
 * Minimal plist reader for ProgramArguments + KeepAlive. Avoids a plutil
 * dependency so tests can feed fixture XML and Linux CI never needs one.
 * Handles the XML shape `generateLaunchdPlist` emits.
 */
export function parseLaunchdPlistXml(xml: string): { programArgs: string[]; keepAlive: boolean } {
  const programArgs: string[] = [];
  const argsBlock = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(xml);
  if (argsBlock) {
    const re = /<string>([\s\S]*?)<\/string>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(argsBlock[1])) !== null) {
      programArgs.push(decodeXmlEntities(m[1].trim()));
    }
  }
  // Single-string Program= form (rare for us, but legal).
  if (programArgs.length === 0) {
    const prog = /<key>\s*Program\s*<\/key>\s*<string>([\s\S]*?)<\/string>/i.exec(xml);
    if (prog) programArgs.push(decodeXmlEntities(prog[1].trim()));
  }
  const keepAlive = /<key>\s*KeepAlive\s*<\/key>\s*<true\s*\/>/i.test(xml);
  return { programArgs, keepAlive };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse `ps -ax -o pid= -o args=` style lines into LiveGbrainProcess rows. */
export function parsePsGbrainLines(output: string): LiveGbrainProcess[] {
  const out: LiveGbrainProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const cmdline = m[2];
    if (!/\bgbrain\b/i.test(cmdline) && !/cli\.(?:ts|js|mjs)/i.test(cmdline)) continue;
    out.push({ pid: Number(m[1]), cmdline });
  }
  return out;
}

// ── Default I/O ──────────────────────────────────────────────────────────────

function defaultLaunchctlList(): string {
  return execFileSync('launchctl', ['list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function defaultReadLaunchdJob(
  label: string,
  home: string,
  readFile: (path: string) => string,
): { programArgs: string[]; keepAlive: boolean } | null {
  // Prefer the on-disk plist (stable, no launchctl print parse).
  const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  if (existsSync(plistPath)) {
    try {
      return parseLaunchdPlistXml(readFile(plistPath));
    } catch {
      /* fall through to launchctl print */
    }
  }
  try {
    const printed = execFileSync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return parseLaunchctlPrintProgram(printed);
  } catch {
    return null;
  }
}

/**
 * Best-effort parse of `launchctl print gui/UID/label` for arguments +
 * keepalive. The print format is not XML; we look for known keys.
 */
export function parseLaunchctlPrintProgram(printed: string): { programArgs: string[]; keepAlive: boolean } {
  const programArgs: string[] = [];
  // arguments = { ... } block with quoted or bare tokens, one per line
  const argsBlock = /arguments\s*=\s*\{([\s\S]*?)\n\s*\}/i.exec(printed);
  if (argsBlock) {
    for (const line of argsBlock[1].split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t === '}') continue;
      // " /path/to/bin " or bare
      const q = /^"(.*)"$/.exec(t);
      programArgs.push(q ? q[1] : t.replace(/,$/, ''));
    }
  }
  const keepAlive =
    /keep alive\s*=\s*(true|1|\{)/i.test(printed) ||
    /"KeepAlive"\s*=>\s*true/i.test(printed);
  return { programArgs, keepAlive };
}

function defaultKickstart(label: string, uid: number): void {
  // -k kills the existing instance then starts a new one (required so the
  // KeepAlive job actually reloads the swapped binary).
  execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

function defaultSystemctlTryRestart(unit: string): void {
  execFileSync('systemctl', ['--user', 'try-restart', unit], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
}

function defaultSystemdUnitPresent(unit: string): boolean {
  try {
    execFileSync('systemctl', ['--user', 'status', unit], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    return true;
  } catch (e: unknown) {
    // status exits non-zero for inactive-but-loaded units too; "not-found" is
    // the only hard miss. Treat any output that isn't not-found as present.
    const msg = e instanceof Error ? e.message : String(e);
    const stderr = (e as { stderr?: string })?.stderr ?? '';
    if (/not-found|could not be found/i.test(msg + stderr)) return false;
    // exit code 3 = loaded but inactive — still present / restartable
    return !/No such file|Unit .* not found/i.test(msg + stderr);
  }
}

function defaultListGbrainProcesses(): LiveGbrainProcess[] {
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return parsePsGbrainLines(out);
  } catch {
    return [];
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Detect gbrain-owned long-running daemons and restart the ones we can
 * (launchd kickstart / systemd try-restart). Unmanaged interactive serves
 * get a loud warning with PIDs. Never throws — callers treat the report as
 * advisory and record failures via recordUpgradeError.
 */
export function restartGbrainDaemonsAfterUpgrade(deps: DaemonRestartDeps = {}): DaemonRestartReport {
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const report: DaemonRestartReport = {
    platform,
    actions: [],
    unmanagedWarnings: [],
  };

  try {
    if (platform === 'darwin') {
      runDarwinRestart(report, deps, log, warn, readFile);
    } else if (platform === 'linux') {
      runLinuxRestart(report, deps, log, warn);
    } else {
      warnPlatform(report, deps, warn);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`[gbrain] post-upgrade daemon restart failed unexpectedly: ${msg}`);
    report.actions.push({
      kind: 'warn-platform',
      target: platform,
      ok: false,
      detail: msg,
    });
  }

  return report;
}

function runDarwinRestart(
  report: DaemonRestartReport,
  deps: DaemonRestartDeps,
  log: (s: string) => void,
  warn: (s: string) => void,
  readFile: (p: string) => string,
): void {
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const home = deps.home ?? process.env.HOME ?? '';
  const listFn = deps.launchctlList ?? defaultLaunchctlList;
  const readJob =
    deps.readLaunchdJob ??
    ((label: string) => defaultReadLaunchdJob(label, home, readFile));
  const kick = deps.kickstart ?? defaultKickstart;
  const listProcs = deps.listGbrainProcesses ?? defaultListGbrainProcesses;

  let listOut = '';
  try {
    listOut = listFn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`[gbrain] could not enumerate launchd jobs after upgrade: ${msg}`);
    report.actions.push({ kind: 'warn-platform', target: 'launchctl list', ok: false, detail: msg });
    // Still try to warn about live processes.
    collectUnmanagedWarnings(report, listProcs(), new Set(), warn);
    return;
  }

  const rows = parseLaunchctlList(listOut);
  const candidates: LaunchdJobSnapshot[] = [];
  for (const row of rows) {
    if (!looksLikeGbrainOwnedLaunchdLabel(row.label)) continue;
    const meta = readJob(row.label);
    if (!meta) continue;
    candidates.push({
      label: row.label,
      pid: row.pid,
      programArgs: meta.programArgs,
      keepAlive: meta.keepAlive,
    });
  }

  const toRestart = candidates.filter((j) => shouldRestartLaunchdJob(j, { readFile }));
  const supervisedPids = new Set(
    toRestart.map((j) => j.pid).filter((p): p is number => typeof p === 'number' && p > 0),
  );

  // Warn about unmanaged processes BEFORE kickstart so we still see the old
  // supervised PIDs in the exclusion set.
  collectUnmanagedWarnings(report, listProcs(), supervisedPids, warn);

  if (toRestart.length === 0) {
    log('[gbrain] No long-running gbrain launchd daemons to restart after upgrade.');
    return;
  }

  log(`[gbrain] Restarting ${toRestart.length} gbrain launchd daemon(s) onto the new binary…`);
  for (const job of toRestart) {
    try {
      kick(job.label, uid);
      log(`[gbrain]   kickstart -k gui/${uid}/${job.label}`);
      report.actions.push({ kind: 'launchd-kickstart', target: job.label, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`[gbrain]   FAILED to restart ${job.label}: ${msg}`);
      warn(`[gbrain]   Manual: launchctl kickstart -k gui/${uid}/${job.label}`);
      report.actions.push({ kind: 'launchd-kickstart', target: job.label, ok: false, detail: msg });
    }
  }
}

function runLinuxRestart(
  report: DaemonRestartReport,
  deps: DaemonRestartDeps,
  log: (s: string) => void,
  warn: (s: string) => void,
): void {
  const tryRestart = deps.systemctlTryRestart ?? defaultSystemctlTryRestart;
  const unitPresent = deps.systemdUnitPresent ?? defaultSystemdUnitPresent;
  const listProcs = deps.listGbrainProcesses ?? defaultListGbrainProcesses;

  let restartedUnit = false;
  try {
    if (unitPresent(AUTOPILOT_SYSTEMD_UNIT)) {
      tryRestart(AUTOPILOT_SYSTEMD_UNIT);
      log(`[gbrain] systemctl --user try-restart ${AUTOPILOT_SYSTEMD_UNIT}`);
      report.actions.push({ kind: 'systemd-try-restart', target: AUTOPILOT_SYSTEMD_UNIT, ok: true });
      restartedUnit = true;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warn(`[gbrain] FAILED to restart ${AUTOPILOT_SYSTEMD_UNIT}: ${msg}`);
    warn(`[gbrain] Manual: systemctl --user try-restart ${AUTOPILOT_SYSTEMD_UNIT}`);
    report.actions.push({
      kind: 'systemd-try-restart',
      target: AUTOPILOT_SYSTEMD_UNIT,
      ok: false,
      detail: msg,
    });
  }

  // Always surface other live gbrain daemons — we only know how to bounce the
  // upstream autopilot unit automatically.
  const procs = listProcs().filter((p) => {
    const kind = classifyLiveGbrainProcess(p.cmdline);
    return kind === 'daemon' || kind === 'serve';
  });
  if (procs.length === 0) {
    if (!restartedUnit) {
      log('[gbrain] No long-running gbrain daemons detected after upgrade.');
    }
    return;
  }
  warn('');
  warn('[gbrain] ⚠ Long-running gbrain process(es) may still be running OLD code after upgrade.');
  warn('[gbrain] Restart them so background workers match the new CLI (chunker/schema drift is destructive):');
  for (const p of procs) {
    warn(`[gbrain]   pid ${p.pid}: ${truncateCmd(p.cmdline)}`);
    report.unmanagedWarnings.push(p);
    report.actions.push({
      kind: 'warn-unmanaged',
      target: `pid:${p.pid}`,
      ok: true,
      detail: p.cmdline,
    });
  }
  if (!restartedUnit) {
    warn('[gbrain] If you use a systemd user unit, restart it (e.g. systemctl --user try-restart gbrain-autopilot.service).');
  }
  warn('');
}

function warnPlatform(
  report: DaemonRestartReport,
  deps: DaemonRestartDeps,
  warn: (s: string) => void,
): void {
  const listProcs = deps.listGbrainProcesses ?? defaultListGbrainProcesses;
  const procs = listProcs().filter((p) => {
    const kind = classifyLiveGbrainProcess(p.cmdline);
    return kind === 'daemon' || kind === 'serve';
  });
  if (procs.length === 0) return;
  warn('');
  warn(`[gbrain] ⚠ Platform ${report.platform}: cannot auto-restart gbrain daemons after upgrade.`);
  warn('[gbrain] These process(es) may still run OLD code — restart them manually:');
  for (const p of procs) {
    warn(`[gbrain]   pid ${p.pid}: ${truncateCmd(p.cmdline)}`);
    report.unmanagedWarnings.push(p);
    report.actions.push({
      kind: 'warn-platform',
      target: `pid:${p.pid}`,
      ok: true,
      detail: p.cmdline,
    });
  }
  warn('');
}

function collectUnmanagedWarnings(
  report: DaemonRestartReport,
  procs: LiveGbrainProcess[],
  supervisedPids: Set<number>,
  warn: (s: string) => void,
): void {
  // Interactive serve (and any other daemon we did not kickstart) — warn, never kill.
  const unmanaged = procs.filter((p) => {
    if (supervisedPids.has(p.pid)) return false;
    if (p.pid === process.pid) return false;
    const kind = classifyLiveGbrainProcess(p.cmdline);
    return kind === 'serve' || kind === 'daemon';
  });
  if (unmanaged.length === 0) return;
  warn('');
  warn('[gbrain] ⚠ gbrain process(es) are running outside a restartable supervisor.');
  warn('[gbrain] They were NOT killed (no supervisor would bring them back). Restart manually if they should use the new binary:');
  for (const p of unmanaged) {
    warn(`[gbrain]   pid ${p.pid}: ${truncateCmd(p.cmdline)}`);
    report.unmanagedWarnings.push(p);
    report.actions.push({
      kind: 'warn-unmanaged',
      target: `pid:${p.pid}`,
      ok: true,
      detail: p.cmdline,
    });
  }
  warn('');
}

function truncateCmd(cmd: string, max = 160): string {
  const one = cmd.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

/**
 * Format a short upgrade-errors hint from a report (paste-ready recovery).
 */
export function formatDaemonRestartHint(report: DaemonRestartReport): string {
  const failed = report.actions.filter((a) => !a.ok);
  if (failed.length === 0 && report.unmanagedWarnings.length === 0) {
    return 'No daemon restart action needed';
  }
  const parts: string[] = [];
  for (const a of failed) {
    if (a.kind === 'launchd-kickstart') {
      parts.push(`launchctl kickstart -k gui/$(id -u)/${a.target}`);
    } else if (a.kind === 'systemd-try-restart') {
      parts.push(`systemctl --user try-restart ${a.target}`);
    }
  }
  for (const p of report.unmanagedWarnings) {
    parts.push(`restart pid ${p.pid} manually`);
  }
  return parts.join('; ') || 'Review gbrain daemon processes and restart them onto the new binary';
}

/** Basename helper exported for tests. */
export function launchdPlistBasename(label: string): string {
  return `${basename(label)}.plist`;
}
