/**
 * gbrain autopilot — Self-maintaining brain daemon.
 *
 * v0.11.1 shape:
 *   - Default path (minion_mode != off AND engine == postgres): spawn a
 *     `gbrain jobs work` child process, submit ONE `autopilot-cycle` job
 *     per interval with an idempotency_key so slow cycles don't stack up.
 *     The forked worker drains the queue durably; restart with 10s backoff
 *     on crash (5-crash cap → autopilot stops with a clear error).
 *   - Fallback (minion_mode=off, PGLite, or `--inline`): run sync →
 *     extract → embed inline, same as pre-v0.11.1 behavior.
 *
 * Usage:
 *   gbrain autopilot [--repo <path>] [--interval N] [--json] [--inline]
 *   gbrain autopilot --install [--repo <path>]
 *   gbrain autopilot --uninstall
 *   gbrain autopilot --status [--json]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, utimesSync, unlinkSync, chmodSync, statSync } from 'fs';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { detectExecutionEnvironment } from '../core/execution-env.ts';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'path';
import { execSync } from 'child_process';
import type { BrainEngine } from '../core/engine.ts';
import { loadPreferences } from '../core/preferences.ts';
import { loadConfig, loadConfigFileOnly, saveConfig, gbrainPath as gbrainHomePath } from '../core/config.ts';
import {
  classifyAutopilotLockHolder,
  type AutopilotLockProbeDeps,
  isPidAlive,
} from '../core/autopilot-lock.ts';
import { ChildWorkerSupervisor } from '../core/minions/child-worker-supervisor.ts';
import { VERSION } from '../version.ts';
import {
  canSelfUpdate,
  decideSelfUpgrade,
  isCacheFresh,
  readUpdateCache,
  reconcileBreadcrumb,
  resolveSelfUpgradeMode,
} from '../core/self-upgrade.ts';
import { logSelfUpgrade } from '../core/audit/self-upgrade-audit.ts';
import { detectInstallMethod } from './upgrade.ts';
import { evaluateQuietHours } from '../core/minions/quiet-hours.ts';
import { inspectLock } from '../core/db-lock.ts';
import { registerCleanup } from '../core/process-cleanup.ts';
import { resolveAutopilotDispatchTimeoutMs } from './autopilot-timeout.ts';
import {
  autopilotRemediationIdempotencyKey,
  shouldRunAutopilotFullCycle,
  shouldSleepHealthyAutopilot,
} from './autopilot-remediation-policy.ts';
// Path helpers live in a LEAF core module so other commands (gbrain migrate)
// can read the daemon's state files without importing this one — a dynamic
// import of a command module drags its whole flag surface into the importer's
// CLI allowlist. Re-exported here so existing importers keep working.
import {
  autopilotLockPath,
  autopilotDisabledMarkerPath,
  autopilotPausedMarkerPath,
  autopilotDisableStrikesPath,
  autopilotLaunchdLabel,
  markerHolderAlive,
  MIGRATE_PAUSE_MARKER_PREFIX,
} from '../core/autopilot-paths.ts';
export { autopilotLockPath, autopilotDisabledMarkerPath, autopilotPausedMarkerPath, autopilotLaunchdLabel };

/**
 * v0.37.7.0 #1162 — classify autopilot reconnect-loop errors.
 *
 * `recoverable` (network blip, Supabase 503, pool saturated, connection
 * refused on a port that may be coming up): retry with backoff up to
 * `GBRAIN_AUTOPILOT_MAX_RECONNECT_FAILS` (default 30).
 *
 * `unrecoverable` (`database_url` unset/empty/malformed, auth failure,
 * config file unreadable): exit immediately so launchd's 60s
 * `ThrottleInterval` backs off the relaunch instead of thrashing.
 *
 * `crash` (a JS TypeError from dereferencing an undefined object): a BUG, not a
 * verdict about the operator's configuration. Treated as recoverable so a code
 * defect cannot permanently kill the daemon, but logged distinctly so it is not
 * silently misfiled as "you forgot to set a URL."
 *
 * Exported (string-based signature preserved) so tests drive it without needing
 * a real reconnect error.
 */
export function classifyReconnectError(err: unknown): 'recoverable' | 'unrecoverable' | 'crash' {
  // Type check FIRST. Bun/V8 renders a null-deref as
  //   "undefined is not an object (evaluating 'config.database_url')"
  // which, lowercased, contains BOTH "database_url" and "undefined" — so the
  // substring rule below classified a crash as a config verdict and exited the
  // daemon permanently. That is exactly how a 71-day outage started: an engine
  // migration rewrote config.json, the running daemon crashed on a stale object,
  // and the crash was reported as "database_url not set".
  const earlyMsg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  // Invalid-URL errors ARE TypeErrors in JS (`new URL('garbage')`), but they
  // are an operator-config verdict, not a code defect — test the message
  // pattern BEFORE the blanket TypeError-means-crash rule, or a malformed
  // database_url spends the whole reconnect budget before exiting.
  if (earlyMsg.includes('invalid url') || earlyMsg.includes('malformed') || earlyMsg.includes('parse url')) {
    return 'unrecoverable';
  }
  if (err instanceof Error && err.name === 'TypeError') return 'crash';
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  // Same shape, for hosts where the error arrives as a plain string/serialized
  // object and the `name` is gone.
  if (
    msg.includes('is not an object')
    || msg.includes('is not a function')
    || msg.includes('cannot read propert')
    || msg.includes('undefined is not')
  ) {
    return 'crash';
  }
  if (msg.includes('database_url') && (msg.includes('undefined') || msg.includes('missing') || msg.includes('empty') || msg.includes('not set'))) {
    return 'unrecoverable';
  }
  if (msg.includes('invalid url') || msg.includes('malformed') || msg.includes('parse url')) {
    return 'unrecoverable';
  }
  // Auth failures: postgres prints `role "name" does not exist` (with the
  // role name in quotes between role and does), so use a skeleton match.
  if (msg.includes('password authentication failed') || msg.includes('authentication failed')) {
    return 'unrecoverable';
  }
  if (msg.includes('role') && msg.includes('does not exist')) {
    return 'unrecoverable';
  }
  if (msg.includes('no brain configured') || msg.includes('config not found')) {
    return 'unrecoverable';
  }
  return 'recoverable';
}

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function logError(phase: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const ts = new Date().toISOString().slice(0, 19);
  const line = `[${ts}] [${phase}] ERROR: ${msg}`;
  console.error(line);
  try {
    const logDir = join(process.env.HOME || '', '.gbrain');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'autopilot.log'), line + '\n');
  } catch { /* best-effort */ }
}

/**
 * Enumerate %PATH% (Windows) for the gbrain CLI shim, honoring PATHEXT.
 *
 * On win32 this is the FIRST resolution path (`which` does not exist in
 * cmd/PowerShell); resolveGbrainCliPath calls it before the execPath and
 * argv[1] fallbacks. Unlike `where`, this NEVER looks at the current
 * directory, so a stray gbrain.exe in cwd cannot hijack resolution. Only
 * directly spawnable extensions (.exe/.com/.cmd/.bat) are accepted, and
 * only regular files - a directory named gbrain.exe cannot shadow a real
 * binary. Returns the first existing candidate, or '' when none exists.
 */
export function resolveWindowsCliPath(): string {
  const pathext = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
  const pathDirs = (process.env.PATH ?? '').split(';');
  for (const dir of pathDirs) {
    // Skip empty and relative entries: '.' or 'bin' resolve against the
    // current directory, which would reintroduce the cwd-hijack `where`
    // has. Only absolute %PATH% entries are trusted.
    if (!dir || !isAbsolute(dir)) continue;
    for (const ext of pathext) {
      // Only directly spawnable types: PATHEXT can also carry .JS/.VBS
      // (Windows Script Host), which Bun cannot exec - spawning them fails
      // EFTYPE. .CMD/.BAT spawn through the shell; .COM/.EXE direct.
      const type = ext.toLowerCase();
      if (type !== '.exe' && type !== '.com' && type !== '.cmd' && type !== '.bat') continue;
      const candidate = join(dir, 'gbrain' + type);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* missing or unreadable - keep looking */ }
    }
  }
  return '';
}

/**
 * Resolve the gbrain CLI entrypoint for spawning the worker child.
 *
 * A .ts source path is never a valid spawn target - spawning it fails with
 * EACCES because TypeScript source isn't executable. The canonical install
 * puts a shim at `/usr/local/bin/gbrain` (or wherever `which gbrain`
 * resolves to) that already wraps the right runtime+entrypoint; prefer it.
 *
 * Order of resolution:
 *   1. Platform PATH lookup - `which gbrain` on POSIX; explicit %PATH%
 *      enumeration (resolveWindowsCliPath) on win32, where `which` does
 *      not exist (#3793).
 *   2. process.execPath if it ends with /gbrain (compiled binary, no shim).
 *   3. argv[1] if it ends with /gbrain (e.g., direct invocation of compiled
 *      binary without PATH). Never .ts source paths.
 *   4. Throw with a clear install hint.
 */
export function resolveGbrainCliPath(): string {
  // #3793: `which` does not exist in cmd or PowerShell on Windows, so the
  // bun-installed gbrain.exe shim on %PATH% was never found and autopilot
  // died with "Could not resolve the gbrain CLI path". `where` would find
  // it but has a cwd-hijack; use explicit %PATH% enumeration on win32.
  if (process.platform === 'win32') {
    const win = resolveWindowsCliPath();
    if (win) return win;
  } else {
    try {
      // #2747: `env: process.env` is required under Bun. Bun's execSync
      // snapshots process.env at Bun's OWN startup, not at call time - a
      // runtime PATH mutation (dotenv/config loading, shell-profile sourcing
      // in a wrapper, etc.) happening between Bun boot and this call is
      // invisible to `which` without explicitly forwarding the current env.
      // This is why "which gbrain" succeeds when run standalone (fresh Bun
      // process, no prior mutation) but can fail from inside autopilot's own
      // process at this exact call site. Same fix already applied to
      // detectTini() in spawn-helpers.ts (see its comment) - this call site
      // was missed.
      const which = execSync('which gbrain', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      })
        .trim()
        .split(/\r?\n/, 1)[0];
      if (which) return which;
    } catch { /* not on $PATH - fall through */ }
  }
  const exec = process.execPath ?? '';
  if (exec.endsWith('/gbrain') || exec.endsWith('\\gbrain.exe')) {
    return exec;
  }

  const arg1 = process.argv[1] ?? '';
  if (arg1.endsWith('/gbrain') || arg1.endsWith('\\gbrain.exe')) {
    return arg1;
  }

  // #2747: include what we actually saw so an operator (or a future bug
  // report) doesn't have to guess whether PATH/execPath/argv[1] looked
  // sane at the moment of failure.
  throw new Error(
    'Could not resolve the gbrain CLI path. Install gbrain so it is on $PATH ' +
      '(e.g. /usr/local/bin/gbrain), or run autopilot from the compiled binary directly. ' +
      `Debug: PATH=${JSON.stringify(process.env.PATH ?? '')} execPath=${JSON.stringify(exec)} argv1=${JSON.stringify(arg1)}`,
  );
}
export function shouldSpawnAutopilotWorker(args: string[]): boolean {
  return !args.includes('--no-worker');
}

export { isPidAlive };

export const AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS = 10 * 60 * 1000;

function autopilotLockAgeMs(lockPath: string): number | null {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

export function decideLockAcquisition(
  lockPath: string,
  currentPid: number,
  deps: AutopilotLockProbeDeps = {},
):
  | { action: 'acquire' }
  | { action: 'exit'; holderPid: number; holderState: 'alive-autopilot' | 'alive-foreign' | 'alive-unknown' }
  | { action: 'takeover'; reason: string } {
  if (!existsSync(lockPath)) return { action: 'acquire' };

  let raw = '';
  try {
    raw = readFileSync(lockPath, 'utf-8').trim();
  } catch {
    // An unreadable lock cannot prove another process is alive.
  }

  const holderPid = Number.parseInt(raw, 10);
  const holder = classifyAutopilotLockHolder(holderPid, currentPid, deps);

  if (holder.state === 'alive-autopilot') {
    return { action: 'exit', holderPid, holderState: holder.state };
  }
  if (holder.state === 'alive-foreign' || holder.state === 'alive-unknown') {
    // #4300: an alive PID whose command we can't identify as gbrain autopilot
    // (recycled PID after reboot, or a /proc-less + ps-restricted host) gets
    // the same age-gated takeover as a known-foreign holder. A fresh lock is
    // still respected; only a stale one (past the grace window) is stolen —
    // otherwise a single recycled PID bricks the daemon forever.
    const lockAgeMs = autopilotLockAgeMs(lockPath);
    if (lockAgeMs !== null && lockAgeMs >= AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS) {
      const kind = holder.state === 'alive-foreign' ? 'foreign' : 'unidentifiable';
      return { action: 'takeover', reason: `${kind} pid ${raw || '<empty>'} with stale lock` };
    }
    return { action: 'exit', holderPid, holderState: holder.state };
  }
  if (holder.state === 'self') {
    return { action: 'takeover', reason: `own pid ${raw || '<empty>'}` };
  }
  return { action: 'takeover', reason: `dead pid ${raw || '<empty>'}` };
}

// ── Self-upgrade silent channel (v0.42; opt-in, supervisor-relaunch) ─────────

/**
 * Reconcile the pre-swap breadcrumb at daemon boot (the post-swap attribution
 * gate). If we're running the version we attempted, the swap+relaunch worked;
 * if not, the new binary failed to launch and we record it as a known-bad
 * version so the auto channel never retries it. Best-effort.
 */
function reconcileSelfUpgradeAtBoot(): void {
  try {
    const cfg = loadConfig();
    if (!cfg) return;
    const { state, transition } = reconcileBreadcrumb(cfg.self_upgrade, VERSION);
    if (!transition) return;
    cfg.self_upgrade = state;
    saveConfig(cfg);
    logSelfUpgrade({
      channel: 'autopilot',
      action: 'apply',
      current: VERSION,
      outcome: transition === 'applied' ? 'applied' : 'failed',
      reason:
        transition === 'applied'
          ? 'breadcrumb matched running version'
          : 'crash-on-launch: attempted version != running version (recorded known-bad)',
    });
    if (transition === 'applied') {
      console.log(`[autopilot] self-upgrade confirmed: now running ${VERSION}.`);
    } else {
      console.error('[autopilot] self-upgrade did not take (running an older version); recorded known-bad.');
    }
  } catch {
    /* best-effort */
  }
}

/** Conservative idle: no cycle running AND (Postgres) no active/waiting jobs.
 * Any ambiguity / error → NOT idle (we'd rather skip an upgrade window). */
async function computeAutopilotIdle(engine: BrainEngine, engineType: string): Promise<boolean> {
  try {
    const cycle = await inspectLock(engine, 'gbrain-cycle');
    if (cycle) return false; // a cycle (sync/extract/embed/...) is running
    if (engineType === 'postgres') {
      const rows = await (engine as any).executeRaw?.(
        `SELECT count(*)::int AS n FROM minion_jobs WHERE status IN ('active','waiting')`,
      );
      const busy = Number((rows as Array<{ n: number }>)?.[0]?.n ?? 0);
      return busy === 0;
    }
    return true; // pglite: no separate worker queue; cycle-lock-free is the signal
  } catch {
    return false;
  }
}

/**
 * The autopilot silent self-upgrade channel. Opt-in (`self_upgrade.mode=auto`).
 * Fires only when behind + idle + in quiet hours + the install can self-update
 * and the target isn't known-bad. On apply: write the breadcrumb, run
 * `gbrain upgrade --swap-only` (fast; defers post-upgrade to the relaunch),
 * then unlink the autopilot lock and exit(0) so the supervisor relaunches the
 * new binary (no in-process re-exec — Bun has no execve). Never throws.
 */
async function attemptAutopilotSelfUpgrade(
  engine: BrainEngine,
  engineType: string,
  lockPath: string,
): Promise<void> {
  try {
    const cfg = loadConfig();
    if (!cfg) return;
    if (resolveSelfUpgradeMode(cfg) !== 'auto') return;

    // latestVersion from the shared cache; refresh when stale (TTL throttles fetch).
    let entry = readUpdateCache();
    if (!entry || !isCacheFresh(entry, Date.now())) {
      try {
        const { refreshUpdateCache } = await import('./check-update.ts');
        await refreshUpdateCache();
        entry = readUpdateCache();
      } catch {
        /* fail-open */
      }
    }
    if (!entry || entry.marker.kind !== 'upgrade_available' || !entry.marker.latest) return;
    const latestVersion = entry.marker.latest;

    const idle = await computeAutopilotIdle(engine, engineType);
    const qh = cfg.self_upgrade?.quiet_hours;
    const tz = qh?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const verdict = evaluateQuietHours({ start: qh?.start ?? 23, end: qh?.end ?? 8, tz }, new Date());
    const installMethod = detectInstallMethod();

    const decision = decideSelfUpgrade({
      mode: 'auto',
      channel: 'autopilot',
      currentVersion: VERSION,
      latestVersion,
      failedVersions: cfg.self_upgrade?.failed_versions ?? [],
      idle,
      inQuietHours: verdict !== 'allow',
      canSelfUpdate: canSelfUpdate(installMethod),
      throttledByInterval: false, // cache TTL is the fetch throttle
    });

    if (decision.action !== 'apply') {
      if (['unsupported_install', 'known_bad'].includes(decision.action)) {
        logSelfUpgrade({
          channel: 'autopilot',
          action: decision.action,
          current: VERSION,
          latest: latestVersion,
          outcome: 'skipped',
          reason: decision.reason,
        });
      }
      return;
    }

    // Apply. Breadcrumb first so a crash-on-launch is attributable.
    cfg.self_upgrade = { ...(cfg.self_upgrade ?? {}), attempting_version: latestVersion };
    saveConfig(cfg);
    logSelfUpgrade({ channel: 'autopilot', action: 'apply', current: VERSION, latest: latestVersion, reason: decision.reason });
    console.log(`[autopilot] self-upgrade: applying ${VERSION} -> ${latestVersion} (idle, quiet hours).`);

    try {
      execSync('gbrain upgrade --swap-only', {
        stdio: 'inherit',
        timeout: 300_000,
        env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
      });
    } catch (e) {
      const fresh = loadConfig();
      if (fresh) {
        const failed = new Set(fresh.self_upgrade?.failed_versions ?? []);
        failed.add(latestVersion);
        fresh.self_upgrade = { ...(fresh.self_upgrade ?? {}), failed_versions: [...failed] };
        delete fresh.self_upgrade.attempting_version;
        saveConfig(fresh);
      }
      logSelfUpgrade({
        channel: 'autopilot',
        action: 'apply',
        current: VERSION,
        latest: latestVersion,
        outcome: 'failed',
        error: e instanceof Error ? e.message : String(e),
      });
      console.error(`[autopilot] self-upgrade swap failed; staying on ${VERSION}.`);
      return;
    }

    // Swap done + smoke-verified by `upgrade --swap-only`. Exit cleanly so the
    // supervisor relaunches the NEW binary, which reconciles the breadcrumb.
    logSelfUpgrade({
      channel: 'autopilot',
      action: 'apply',
      current: VERSION,
      latest: latestVersion,
      outcome: 'applied',
      reason: 'swapped; exiting for supervisor relaunch',
    });
    console.log('[autopilot] self-upgrade swapped; exiting for relaunch.');
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
    process.exit(0);
  } catch {
    /* the self-upgrade channel must never break the tick */
  }
}

/** Flags that consume the following argv token as their value (#1525). */
const AUTOPILOT_VALUE_FLAGS = new Set(['--repo', '--interval', '--target']);

/** Positional spellings → their canonical flags. A Map (not a plain object)
 * so prototype-chain words like `constructor` stay unknown positionals. */
const AUTOPILOT_POSITIONAL_ALIASES = new Map<string, string>([
  ['status', '--status'],
  ['install', '--install'],
  ['uninstall', '--uninstall'],
  ['help', '--help'],
]);

/**
 * #1525 — positional args were never validated, so `gbrain autopilot status`
 * fell through every flag branch and STARTED the daemon in the foreground: a
 * status CHECK silently became a daemon LAUNCH. Map the natural subcommand
 * spellings onto their canonical flags, drop the redundant `start` (daemon
 * start is already the default action), and refuse anything unrecognized
 * with exit 2 before any engine or daemon work happens. Value-taking flags
 * keep their argument verbatim (`--repo status` names a directory, not a
 * subcommand). cli.ts resolves BEFORE connectEngine so `autopilot status`
 * rides the same engine-free short-circuit as `--status`; the call in
 * runAutopilot keeps direct callers safe and is a no-op on resolved argv.
 */
export function resolveAutopilotPositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      out.push(a);
      if (AUTOPILOT_VALUE_FLAGS.has(a) && i + 1 < args.length) out.push(args[++i]);
      continue;
    }
    const alias = AUTOPILOT_POSITIONAL_ALIASES.get(a);
    if (alias) {
      out.push(alias);
      continue;
    }
    if (a === 'start') continue; // daemon start is the default action
    console.error(
      `Unknown autopilot argument '${a}'. Expected one of: status, install, uninstall, start, help.\n` +
      `Run 'gbrain autopilot --help' for usage.`,
    );
    process.exit(2);
  }
  return out;
}

/**
 * #2608 — pure function (test seam, same pattern as generateLaunchdPlist):
 * the boot-time warning emitted when no chat provider is available, so the
 * silent no-op of every LLM phase (chronicle, dream, enrich) is visible in
 * the daemon log instead of manifesting as "autopilot runs green but
 * nothing gets extracted".
 *
 * gbrainDir is a param (not resolved here) to keep the function pure AND so
 * both remediation paths honor GBRAIN_HOME — a literal `~/.gbrain` lies on
 * custom-home installs. `gbrain config set` is deliberately NOT named: the
 * canonical key guidance (INSTALL_FOR_AGENTS.md Step 2) tells users not to
 * use it for API keys. The reload instruction is load-bearing: the wrapper
 * sources the env file only at exec and the gateway folds env once
 * pre-dispatch, so a key written after boot changes nothing until
 * `--install` regenerates the wrapper and reloads the daemon.
 */
export function chatBootWarning(chatAvailable: boolean, gbrainDir: string): string | null {
  if (chatAvailable) return null;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- warning-message hint construction, no fs operation; gbrainDir is configDir()-validated (absolute, no ..), same pattern as import.ts:43
  const envFile = join(gbrainDir, 'env');
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- same: log-string construction only
  const configJson = join(gbrainDir, 'config.json');
  return (
    '[autopilot] WARNING: no chat provider available — LLM phases (chronicle, dream, enrich) will no-op. ' +
    `Put an API key (ANTHROPIC_API_KEY or OPENAI_API_KEY) in ${envFile} (sourced by the daemon wrapper) ` +
    `or in ${configJson} (file plane), then re-run \`gbrain autopilot --install\` to reload the daemon.`
  );
}

export async function runAutopilot(engine: BrainEngine, args: string[]) {
  args = resolveAutopilotPositionals(args);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: gbrain autopilot [--repo <path>] [--interval N] [--json] [--no-worker]\n' +
      '       gbrain autopilot --install [--repo <path>]\n' +
      '       gbrain autopilot --uninstall\n' +
      '       gbrain autopilot --status [--json]\n\n' +
      'Self-maintaining brain daemon. Runs the full maintenance cycle\n' +
      '(lint + backlinks + sync + extract + embed + orphans) on an interval.\n\n' +
      'For a one-shot cron-triggered cycle, see `gbrain dream`.',
    );
    return;
  }

  if (args.includes('--install')) {
    await installDaemon(engine, args);
    return;
  }
  if (args.includes('--uninstall')) {
    uninstallDaemon();
    return;
  }
  if (args.includes('--status')) {
    runAutopilotStatus(args);
    return;
  }

  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  // Same NaN guard as the status path: a typo'd interval would otherwise
  // reach setTimeout(NaN) → 0ms and busy-loop the daemon against the DB.
  const rawBaseInterval = parseInt(parseArg(args, '--interval') || '300', 10);
  const baseInterval = Number.isFinite(rawBaseInterval) && rawBaseInterval > 0 ? rawBaseInterval : 300;
  const jsonMode = args.includes('--json');
  const forceInline = args.includes('--inline');
  const noWorker = !shouldSpawnAutopilotWorker(args);

  if (!repoPath) {
    console.error('No repo path. Use --repo or run gbrain sync --repo first.');
    process.exit(1);
  }

  // Lock file to prevent concurrent instances (#14).
  // v0.37.7.0 #1226: route through gbrainPath() so the lockfile lives
  // under GBRAIN_HOME when set, not the hardcoded ~/.gbrain. Pre-fix,
  // two brains sharing GBRAIN_HOME=different-paths still wrote to the
  // same global lockfile and one would silently respawn the other
  // forever.
  const lockPath = autopilotLockPath();
  try {
    mkdirSync(gbrainHomePath(), { recursive: true });
    const decision = decideLockAcquisition(lockPath, process.pid);
    if (decision.action === 'exit') {
      // #4300: say WHY we refused, loudly, so a bricked daemon is diagnosable
      // from launchd/systemd logs without strace-ing the lock probe.
      const detail =
        decision.holderState === 'alive-autopilot'
          ? 'a live gbrain autopilot process'
          : decision.holderState === 'alive-unknown'
            ? 'a live process whose command line could not be inspected (fresh lock — will become stealable once stale)'
            : 'a live non-gbrain process holding a fresh lock (will become stealable once stale)';
      console.error(
        `[autopilot] refusing to start: lock ${lockPath} is held by pid ${decision.holderPid} — ${detail}. Exiting.`,
      );
      process.exit(0);
    }
    if (decision.action === 'takeover') {
      console.log(`Stale autopilot lock found (${decision.reason}). Taking over.`);
    }
    writeFileSync(lockPath, String(process.pid));
  } catch { /* best-effort */ }

  console.log(`Autopilot starting. Repo: ${repoPath}, interval: ${baseInterval}s`);

  // #2608: LLM phases (chronicle extract, dream synthesis, enrich) gate on
  // isAvailable('chat') and silently no-op when no chat provider resolves —
  // the classic symptom of a daemon shell that never sourced the API keys
  // (see writeWrapperScript below). One loud boot-time line makes that
  // failure mode visible in the daemon log instead of manifesting as
  // "autopilot runs green but nothing gets extracted".
  // console.log, NOT console.error: launchd/systemd route stderr to
  // autopilot.err, which install output and showStatus never reference —
  // stdout is the autopilot.log sink on all four install targets.
  // Bare isAvailable('chat') probes the GLOBAL chat model on purpose — it
  // mirrors the phases named above; facts extraction gates model-aware
  // (core/facts/extract.ts) and doctor owns that diagnosis.
  try {
    const { isAvailable } = await import('../core/ai/gateway.ts');
    const warn = chatBootWarning(isAvailable('chat'), gbrainHomePath());
    if (warn) console.log(warn);
  } catch { /* diagnostic only — never blocks the loop */ }

  // Mode resolution: Minions dispatch when the user has opted in AND the
  // worker daemon can actually run (Postgres only; PGLite's exclusive file
  // lock blocks a separate worker process).
  const mode = loadPreferences().minion_mode ?? 'pain_triggered';
  const cfg = loadConfig();
  const engineType = cfg?.engine ?? 'pglite';
  const useMinionsDispatch = mode !== 'off' && engineType === 'postgres' && !forceInline;
  const spawnManagedWorker = useMinionsDispatch && !noWorker;

  // Engine identity at boot, re-checked every tick. A cross-engine migration
  // flips config.json at the END of its copy; this long-lived process would
  // otherwise keep syncing into the ABANDONED source engine indefinitely —
  // the health probe keeps succeeding (the old engine stays alive as the
  // preserved backup) and reconnect() deliberately restores the config
  // captured at connect() (#2034), never the new file. Same silent-divergence
  // class as the dead-daemon incident, moved to after the flip.
  const engineIdentityAtBoot = autopilotEngineIdentity(loadConfigFileOnly());

  // v0.42 self-upgrade: if a prior tick swapped the binary and exited for
  // relaunch, we're now the relaunched process — reconcile the breadcrumb so a
  // crash-on-launch is recorded known-bad and a success is confirmed.
  reconcileSelfUpgradeAtBoot();

  let stopping = false;
  let childSupervisor: ChildWorkerSupervisor | null = null;

  // #1872: graceful engine shutdown. On PGLite the cycle steps run INLINE in
  // this process, so a hard `process.exit` mid-write (systemctl stop →
  // SIGTERM) kills WASM Postgres with the WAL dirty and can corrupt the
  // brain. Two exit paths must both close the engine:
  //   - autopilot's own shutdown() below (owns SIGINT + internal stops like
  //     max_crashes / cycle-failure-cap), and
  //   - process-cleanup's SIGTERM handler (installed inside cli.ts's
  //     import.meta.main seam before main() dispatches; it runs the cleanup
  //     registry with a 3s deadline and then exits) —
  //     which is why closeEngine is ALSO registered there.
  // closeEngine aborts the in-flight inline cycle (runCycle checks the
  // signal between phases and threads it into phase sub-work), gives it a
  // short bounded window to wind down, then disconnects. PGLite's
  // disconnect() drains the pending query and checkpoints before closing;
  // a second call is a no-op (disconnect snapshots + nulls the handle), so
  // both paths firing is safe.
  const shutdownAbort = new AbortController();
  let inflightInlineCycle: Promise<unknown> | null = null;
  const closeEngine = async () => {
    shutdownAbort.abort(new Error('autopilot shutdown'));
    if (inflightInlineCycle) {
      // ponytail: 2s cap keeps us inside process-cleanup's 3s deadline; a
      // between-phase abort resolves instantly, a mid-phase one may not.
      await Promise.race([
        inflightInlineCycle.catch(() => { /* cycle errors already logged by the loop */ }),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
    }
    try { await engine.disconnect(); } catch { /* best-effort */ }
  };
  const deregisterEngineClose = registerCleanup('autopilot-engine-close', closeEngine);

  if (spawnManagedWorker) {
    const cliPath = resolveGbrainCliPath();
    // Cgroup-aware auto-sized RSS watchdog cap (issue #1678). The old flat
    // 2048MB killed legit embed work (~10GB) on every cycle → silent
    // ~400×/24h respawn loop. resolveDefaultMaxRssMb clamps 0.5×min(cgroup,
    // RAM) to [4096,16384]. Bare `gbrain jobs work` resolves the same default;
    // we pass it explicitly so the spawn log + child agree.
    const { resolveDefaultMaxRssMb } = await import('../core/minions/rss-default.ts');
    const autopilotMaxRssMb = resolveDefaultMaxRssMb();
    childSupervisor = new ChildWorkerSupervisor({
      cliPath,
      // Orphaned-private-queue recovery runs INSIDE each spawned worker's
      // startup (jobs.ts 'work', gated on GBRAIN_SUPERVISED !== '1', which
      // autopilot children never set) — so every spawn AND crash-respawn
      // recovers without a parent-side beforeSpawn double-running the scan.
      args: ['jobs', 'work', '--max-rss', String(autopilotMaxRssMb)],
      // process.env clone; autopilot doesn't gate shell jobs the way the
      // standalone supervisor does (autopilot is the operator-trust path).
      // GBRAIN_SUPERVISED is stripped explicitly: worker-startup recovery is
      // autopilot's ONLY private-queue recovery lane, and an inherited =1
      // (operator export, nested supervision) would silently disable it.
      env: { ...process.env, GBRAIN_SUPERVISED: undefined } as Record<string, string | undefined>,
      maxCrashes: 5,
      isStopping: () => stopping,
      onMaxCrashesExceeded: (count, max) => {
        console.error(`[autopilot] ${count}/${max} consecutive worker crashes, giving up.`);
        void shutdown('max_crashes');
      },
      onEvent: (event) => {
        // Route ChildWorkerSupervisor events to autopilot's stderr log.
        // Matches the prior console output shape so operators reading
        // existing logs see the same lines.
        if (event.kind === 'worker_spawned') {
          console.log(
            `[autopilot] Minions worker spawned (pid: ${event.pid}, watchdog: ${autopilotMaxRssMb}MB${event.tini ? ', tini: active' : ''})`,
          );
        } else if (event.kind === 'worker_spawn_failed') {
          console.error(
            `[autopilot] worker spawn failed (${event.phase}): ${event.error}${event.errnoCode ? ` (code=${event.errnoCode})` : ''}`,
          );
        } else if (event.kind === 'worker_exited') {
          console.error(
            `[autopilot] worker exited code=${event.code} signal=${event.signal} after ${event.runDurationMs}ms, crashCount=${event.crashCount}, cause=${event.likelyCause}`,
          );
        } else if (event.kind === 'backoff') {
          if (event.reason === 'budget_exceeded') {
            console.error(
              `[autopilot] clean-restart budget exceeded; backing off ${event.ms}ms before next spawn`,
            );
          } else if (event.reason === 'crash') {
            console.error(
              `[autopilot] crash backoff ${event.ms}ms (crashCount=${event.crashCount})`,
            );
          }
          // reason='clean_exit' with ms:0 is the steady-state watchdog drain;
          // logging every iteration would be noisy. Keep silent (the
          // worker_exited line already covers the user-visible signal).
        } else if (event.kind === 'health_warn') {
          console.error(
            `[autopilot] health_warn: ${event.reason} count=${event.count} window=${event.windowMs}ms`,
          );
        }
      },
    });
    // Fire-and-forget; runs alongside the dispatch loop. shutdown() drives
    // the child-supervisor's isStopping accessor + drain.
    void childSupervisor.run();
  } else if (!useMinionsDispatch) {
    const why = mode === 'off'
      ? 'minion_mode=off'
      : (engineType !== 'postgres' ? 'engine=pglite' : 'flag=--inline');
    console.log(`[autopilot] running steps inline (${why})`);
  } else {
    console.log('[autopilot] --no-worker set: dispatch loop only (worker managed externally)');
  }

  // Async shutdown with 35s drain window for the worker child. The worker
  // has its own SIGTERM handler (minions/worker.ts:79-85) that drains
  // in-flight jobs for up to 30s before exit. We give it 35s here to
  // account for signal-delivery latency, then SIGKILL as a last resort.
  //
  // No `process.on('exit')` handler — its callback runs synchronously and
  // cannot await the worker's drain.
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Autopilot stopping (${sig}).`);
    if (childSupervisor) {
      childSupervisor.killChild('SIGTERM');
      await childSupervisor.awaitChildExit(35_000);
      if (childSupervisor.childAlive) {
        childSupervisor.killChild('SIGKILL');
      }
    }
    // #1872: abort the in-flight inline cycle and close the engine BEFORE
    // process.exit — a hard exit mid-write corrupts PGLite's WASM Postgres.
    await closeEngine();
    deregisterEngineClose();
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    process.exit(sig === 'max_crashes' || sig === 'cycle-failure-cap' ? 1 : 0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });

  let consecutiveErrors = 0;
  // Parser-probe fixture warning is once-per-process, not once-per-cycle
  // (compiled-binary installs have no source tree; don't spam the log).
  let parserProbeFixtureWarned = false;
  // #2608: once-per-process no-chat-provider warning. A keyless daemon used
  // to run every cycle "green" while all LLM phases silently no-op'd
  // (chronicle reported no_events, propose_takes skipped, …) — the operator
  // had no signal that shell-profile keys never reached launchd/systemd.
  let noChatProviderWarned = false;
  // v0.37.7.0 #1162 — counter for consecutive reconnect failures.
  // Reset on every successful health probe or reconnect. Threshold
  // controlled by GBRAIN_AUTOPILOT_MAX_RECONNECT_FAILS env (default 30).
  let autopilotReconnectFails = 0;
  const AUTOPILOT_MAX_RECONNECT_FAILS = Math.max(
    1,
    Number(process.env.GBRAIN_AUTOPILOT_MAX_RECONNECT_FAILS) || 30,
  );
  // Peer-worker liveness for --no-worker mode. The probe is a proxy, not
  // ground truth: SELECT count(*) of active jobs with a recent lock_until
  // refresh. A queue with only waiting jobs and a healthy idle worker
  // reads as "no worker" (false positive); a worker that died 110s ago
  // while holding a lock reads as "alive" until lock_until expires.
  // Good enough for V1 — a ground-truth minion_workers heartbeat table
  // is tracked as v0.19.1 follow-up B7. When the probe sees no signal
  // for NO_WORKER_WARN_TICKS consecutive cycles, log a loud warning so
  // the operator can spot "I set --no-worker but forgot to start one"
  // before the queue piles up.
  const NO_WORKER_WARN_TICKS = 3;
  let noWorkerConsecutiveIdle = 0;
  // v0.36+ T8: track time since last full cycle for the 60-min floor.
  // Initialized to "long ago" so the first tick on a healthy brain still
  // runs the full cycle (phase-coupling exercise) before settling into
  // targeted-submit mode.
  let lastFullCycleAt = 0;
  // Log the pause/resume transition once each, not every poll.
  let pausedAnnounced = false;

  while (!stopping) {
    const cycleStart = Date.now();
    let cycleOk = true;

    // Refresh the lock mtime so another cron-fired autopilot doesn't
    // declare the instance stale after 10 minutes (Codex C).
    try { utimesSync(lockPath, new Date(), new Date()); } catch { /* best-effort */ }

    // #2608: loud once-per-process signal when no chat provider is servable.
    // Without this a keyless daemon looks healthy forever while every LLM
    // phase quietly skips.
    if (!noChatProviderWarned) {
      noChatProviderWarned = true;
      try {
        const { isAvailable } = await import('../core/ai/gateway.ts');
        if (!isAvailable('chat')) {
          console.error(
            `[autopilot] WARN: no chat provider is available to this daemon — LLM-dependent ` +
            `phases (chronicle event extraction, propose_takes, synthesize, …) will skip. ` +
            `Shell-profile exports often do not reach launchd/systemd: put KEY=value lines in ` +
            `${join(gbrainHomePath(), 'env')} (sourced by the wrapper), then re-run ` +
            '`gbrain autopilot --install` to reload the daemon.',
          );
        }
      } catch { /* gateway unconfigured — the cycle surfaces its own errors */ }
    }

    // Post-migration convergence: if the file-plane engine identity changed
    // since boot, this process is connected to the wrong engine. Exit through
    // the clean shutdown path (engine close matters for PGLite WAL) so the
    // supervisor relaunches on the new config; the same relaunch contract the
    // self-upgrade swap relies on. Cron and one-shot targets simply pick up
    // the new config on their next run.
    // A torn or failed read (concurrent config write, transient EACCES) must
    // not restart the daemon: skip the comparison unless the file read
    // actually produced a config — a genuine migration flip never yields null.
    let identityNow: string | null = null;
    try {
      const fileCfg = loadConfigFileOnly();
      identityNow = fileCfg ? autopilotEngineIdentity(fileCfg) : null;
    } catch { /* torn read mid-write; check again next tick */ }
    if (identityNow !== null && identityNow !== engineIdentityAtBoot) {
      console.log('[autopilot] engine config changed on disk (migration?) — exiting for relaunch on the new engine.');
      await shutdown('engine-config-changed');
      return;
    }

    // Cooperative pause (see autopilotPausedMarkerPath). Checked AFTER the
    // heartbeat so a paused daemon still reads as alive, and BEFORE any DB
    // work so a cross-engine migration is not racing our writes into an
    // engine that is about to stop being the configured one.
    if (existsSync(autopilotPausedMarkerPath())) {
      // Self-heal an orphan: a migrate-owned marker whose recorded pid is dead
      // was leaked by a killed migration (SIGKILL, power loss — anything its
      // own cleanup could not catch). Nothing else ever deletes it, and an
      // orphan parks this daemon forever. An operator's manual hold (no
      // migrate signature) is never touched, and a live migrate's marker
      // reads alive and is honored.
      let orphaned = false;
      try {
        const body = readFileSync(autopilotPausedMarkerPath(), 'utf-8');
        orphaned = body.startsWith(MIGRATE_PAUSE_MARKER_PREFIX) && markerHolderAlive(body) === 'dead';
      } catch { /* vanished or unreadable: fall through to the normal pause */ }
      if (orphaned) {
        console.log('[autopilot] clearing an orphaned pause marker (its migrate process is dead); resuming.');
        try { unlinkSync(autopilotPausedMarkerPath()); } catch { /* already gone */ }
      } else {
        if (!pausedAnnounced) {
          console.log('[autopilot] paused (autopilot-paused marker present) — skipping cycles until it clears.');
          pausedAnnounced = true;
        }
        // Poll faster than a normal tick so a migration's quiesce window is short.
        await new Promise((r) => setTimeout(r, Math.min(baseInterval, 30) * 1000));
        continue;
      }
    }
    if (pausedAnnounced) {
      console.log('[autopilot] resumed — pause marker cleared.');
      pausedAnnounced = false;
    }

    // DB health check (reconnect if needed).
    //
    // v0.37.7.0 #1162: classify reconnect failures. Pre-fix, the
    // catch logged the error and looped forever — when `database_url`
    // was unset/malformed the loop spammed `config.database_url
    // undefined` until launchd was killed manually. Now:
    //   - Recoverable transient (network blip, pool saturated, 503) →
    //     log + retry next tick. Up to GBRAIN_AUTOPILOT_MAX_RECONNECT_FAILS
    //     consecutive failures before exit (default 30 = ~5min at
    //     10s ticks).
    //   - Unrecoverable (database_url unset, malformed URL, auth
    //     failure) → exit immediately with a clear stderr line.
    //     ThrottleInterval=60 in the launchd plist (v0.37.7.0) ensures
    //     launchd's KeepAlive backoff actually backs off instead of
    //     thrashing.
    try {
      await engine.getConfig('version');
      autopilotReconnectFails = 0; // reset on success
    } catch (probeErr) {
      try {
        // #2034: use reconnect() — it restores the config captured at connect()
        // and avoids the null-connection window. The previous
        // `disconnect()` + bare `connect()` lost the config (throwing
        // `database_url undefined` on every retry → FATAL restart-loop on any
        // transient DB blip) AND tore down the pool postgres.js can otherwise
        // self-heal.
        await engine.reconnect({ error: probeErr });
        autopilotReconnectFails = 0;
      } catch (e) {
        logError('reconnect', e);
        autopilotReconnectFails++;
        const klass = classifyReconnectError(e);
        if (klass === 'crash') {
          // A gbrain BUG, not an operator misconfiguration. Say so plainly
          // instead of blaming the config, and keep retrying: a code defect must
          // not permanently disable the daemon. The consecutive-failure cap below
          // still bounds it.
          console.error(
            `[autopilot] BUG: internal error during reconnect (${(e as Error).message ?? 'unknown'}). ` +
            `This is a gbrain defect, not a configuration problem — please report it. ` +
            `Retrying (${autopilotReconnectFails}/${AUTOPILOT_MAX_RECONNECT_FAILS}).`,
          );
        } else if (klass === 'unrecoverable') {
          console.error(
            `[autopilot] FATAL: unrecoverable DB error (${(e as Error).message ?? 'unknown'}). ` +
            `Exiting so launchd ThrottleInterval can apply backoff.`,
          );
          stopping = true;
          setCliExitVerdict(1);
          break;
        }
        if (autopilotReconnectFails >= AUTOPILOT_MAX_RECONNECT_FAILS) {
          console.error(
            `[autopilot] FATAL: ${autopilotReconnectFails} consecutive reconnect failures. ` +
            `Last error: ${(e as Error).message ?? 'unknown'}. Exiting.`,
          );
          stopping = true;
          setCliExitVerdict(1);
          break;
        }
      }
    }

    // v0.42 self-upgrade silent channel (opt-in self_upgrade.mode=auto). Runs
    // each tick; cache TTL throttles the actual GitHub fetch. On apply it swaps
    // + exits for supervisor relaunch (never returns). No-op unless mode=auto.
    await attemptAutopilotSelfUpgrade(engine, engineType, lockPath);

    // --no-worker peer-liveness probe (v0.19.1). Runs every cycle, cheap
    // (single SELECT). See NO_WORKER_WARN_TICKS comment above for caveats.
    if (noWorker && useMinionsDispatch) {
      try {
        const rows = await (engine as any).executeRaw?.(
          `SELECT count(*)::int AS n FROM minion_jobs
             WHERE status = 'active'
               AND lock_until IS NOT NULL
               AND lock_until > now() - interval '2 minutes'`,
        );
        const liveWorkerSignal = Number((rows as Array<{ n: number }>)?.[0]?.n ?? 0);
        if (liveWorkerSignal === 0) {
          noWorkerConsecutiveIdle++;
          if (noWorkerConsecutiveIdle === NO_WORKER_WARN_TICKS) {
            // Fire loud on the Nth consecutive idle tick; don't repeat on every
            // subsequent cycle (the operator already saw it), re-arm once a
            // live worker is seen again.
            console.error(
              `[autopilot] WARNING: --no-worker set and no worker has claimed a job in ~${NO_WORKER_WARN_TICKS * baseInterval}s. ` +
              `Jobs will pile up in 'waiting' until a worker starts. ` +
              `Probe is a proxy (lock_until refresh) and can false-positive on idle queues — see B7 for ground-truth follow-up.`,
            );
          }
        } else {
          if (noWorkerConsecutiveIdle >= NO_WORKER_WARN_TICKS) {
            console.log('[autopilot] --no-worker probe: live worker signal detected; warning re-armed.');
          }
          noWorkerConsecutiveIdle = 0;
        }
      } catch (e) {
        // Probe failures never block the main dispatch loop. Log once per
        // failure class; ignore repeated errors (common shape: DB reconnect
        // blip between ticks).
        logError('no-worker-probe', e);
      }
    }

    if (useMinionsDispatch) {
      // v0.36+ brain-health-100 wave (T8): targeted-submit loop.
      //
      // Pre-fix: every tick submitted ONE autopilot-cycle job, full phase
      // set, regardless of brain state. On a healthy brain this was pure
      // overhead. On a degraded brain it bundled fast wins (embed) with
      // slow phases (synthesize) so the user waited for the slowest.
      //
      // New logic: compute the remediation plan (cheap; no full doctor
      // walk), then route to the right level of intervention:
      //   - Full cycle every 60min regardless of score/plan (phase-
      //     coupling + freshness invariant); healthy brains sleep before it.
      //   - Small plan (<=3 steps, <5min): submit individual handlers.
      //   - Large plan or low score: full autopilot-cycle (the hammer).
      //
      // D10 cycle-lock invariant ensures targeted-submit and
      // autopilot-cycle can never run concurrently (both acquire
      // gbrain-cycle), so the "60-min floor double-processes queued
      // targeted jobs" failure mode is closed by the lock.
      //
      // v0.40 D17 layered on top: per-source freshness check fires BEFORE
      // the score gate so a healthy brain that happens to have a stale
      // federated source still picks up new commits. brain_score reflects
      // internal data quality (embed coverage, link density, orphans),
      // NOT whether GitHub has new commits on the source repo. Decoupling
      // the two closes the silent-stale-source bug class on
      // poll-only deployments.
      try {
        const { MinionQueue } = await import('../core/minions/queue.ts');
        const { computeRecommendations, embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG, chatApiKeyConfigured } = await import('../core/brain-score-recommendations.ts');
        const queue = new MinionQueue(engine);
        const slotMs = Math.floor(Date.now() / (baseInterval * 1000)) * baseInterval * 1000;
        const slot = new Date(slotMs).toISOString();
        const timeoutMs = resolveAutopilotDispatchTimeoutMs(baseInterval, false);

        // ── v0.40 D17: per-source freshness check ────────────────────
        // Runs first; independent of score gate. Submits a 'sync' job per
        // source whose last_sync_at is older than the interval. The sync
        // handler (T6/T7) auto-enqueues embed-backfill on completion if
        // pages changed.
        try {
          const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
          if (await isFederatedV2Enabled(engine)) {
            const { loadAllSources, sourceConfigHasRemoteUrl } = await import('../core/sources-load.ts');
            const sources = await loadAllSources(engine);
            const intervalMs = baseInterval * 1000;
            const now = Date.now();
            for (const src of sources) {
              if (!src.local_path) continue;
              // #3696: a RELATIVE local_path is meaningless in the daemon
              // (cwd is launchd's, not the registering shell's) — dispatching
              // it would sync a phantom path. Skip loudly; the fix is
              // re-registering with an absolute path (sources add now
              // resolves) or one successful `gbrain sync` (anchor self-heal).
              const relWarn = relativeLocalPathSkipWarning(src.id, src.local_path);
              if (relWarn) {
                process.stderr.write(relWarn + '\n');
                continue;
              }
              const lastSyncMs = src.last_sync_at ? new Date(src.last_sync_at).getTime() : 0;
              const ageMs = now - lastSyncMs;
              if (ageMs < intervalMs) continue; // fresh enough
              try {
                const job = await queue.add(
                  'sync',
                  {
                    sourceId: src.id,
                    repoPath: src.local_path,
                    pull: sourceConfigHasRemoteUrl(src.config),
                    auto_embed_backfill: true,
                    embed_reason: 'autopilot_freshness',
                  },
                  {
                    queue: 'default',
                    idempotency_key: `autopilot-sync:${src.id}:${slot}`,
                    max_attempts: 2,
                    timeout_ms: timeoutMs,
                    maxWaiting: 1,
                  },
                );
                if (jsonMode) {
                  process.stderr.write(JSON.stringify({
                    event: 'dispatched', job_id: job.id, mode: 'freshness',
                    source_id: src.id, age_ms: ageMs,
                  }) + '\n');
                } else {
                  console.log(`[dispatch] job #${job.id} sync (freshness: ${src.id}; age=${Math.floor(ageMs / 60000)}min)`);
                }
              } catch (e) {
                logError('dispatch.freshness', e);
              }
            }
          }
        } catch (e) {
          logError('dispatch.freshness-gate', e);
        }

        // ── #1685 GAP D: per-source extract_atoms auto-drain ───────────────
        // The silent-backlog incident: a pack that doesn't declare extract_atoms
        // never runs the phase in the routine cycle, so the atom backlog grows
        // invisibly. Auto-submit a bounded, PROTECTED drain per source when the
        // backlog exceeds the threshold AND the active pack doesn't declare the
        // phase. Default-ON, daily-spend-capped, time-sloted key so a new slot
        // opens each UTC day (CODEX #1/#2/#3, DECISION 3C). Postgres-only —
        // PGLite has no multi-process worker to run the job.
        if (engine.kind === 'postgres') {
          try {
            const enabled = (await engine.getConfig('autopilot.auto_drain.enabled')) !== 'false';
            if (enabled) {
              const { packDeclaresPhase } = await import('../core/cycle.ts');
              // packDeclaresPhase reads the active pack (brain-wide, not
              // per-source). If the pack declares extract_atoms the routine
              // cycle already drains it for every source — nothing to do.
              const declares = await packDeclaresPhase(engine, 'extract_atoms');
              if (!declares) {
                const parsePosInt = (v: string | null, d: number): number => {
                  if (v == null) return d;
                  const n = parseInt(v, 10);
                  return Number.isFinite(n) && n > 0 ? n : d;
                };
                const parseNonNegFloat = (v: string | null, d: number): number => {
                  if (v == null) return d;
                  const n = parseFloat(v);
                  return Number.isFinite(n) && n >= 0 ? n : d;
                };
                const threshold = parsePosInt(await engine.getConfig('autopilot.auto_drain.threshold'), 25);
                const windowSeconds = parsePosInt(await engine.getConfig('autopilot.auto_drain.window_seconds'), 120);
                const maxUsdPerDay = parseNonNegFloat(await engine.getConfig('autopilot.auto_drain.max_usd_per_day'), 2.0);
                // Each drain run is BudgetTracker-capped at ~$0.30; bound the
                // brain-wide daily count instead of a real-time spend ledger.
                const PER_RUN_USD = 0.3;
                const maxJobsToday = Math.max(0, Math.floor(maxUsdPerDay / PER_RUN_USD));
                const utcDay = new Date().toISOString().slice(0, 10);

                let submittedToday = 0;
                try {
                  const rows = await engine.executeRaw<{ cnt: number }>(
                    `SELECT count(*)::int AS cnt FROM minion_jobs WHERE name = 'extract-atoms-drain' AND created_at >= $1::timestamptz`,
                    [`${utcDay}T00:00:00Z`],
                  );
                  submittedToday = rows[0]?.cnt ?? 0;
                } catch {
                  // count is best-effort; treat as 0 (cap still bounds submits this tick).
                }

                if (submittedToday < maxJobsToday) {
                  const { loadAllSources } = await import('../core/sources-load.ts');
                  const { countExtractAtomsBacklog } = await import('../core/cycle/extract-atoms.ts');
                  const sources = await loadAllSources(engine);
                  for (const src of sources) {
                    if (submittedToday >= maxJobsToday) break; // brain-wide daily cap (fairness)
                    if (!src.local_path) continue;
                    // #3696: same relative-path skip as the freshness loop.
                    const relWarn = relativeLocalPathSkipWarning(src.id, src.local_path);
                    if (relWarn) {
                      process.stderr.write(relWarn + '\n');
                      continue;
                    }
                    const backlog = await countExtractAtomsBacklog(engine, src.id);
                    if (backlog === null || backlog <= threshold) continue;
                    // Time-sloted key (CODEX #2): a static key would block the
                    // source FOREVER once the first job completes. A new UTC-day
                    // slot reopens it each day.
                    const idemKey = `autopilot-extract-atoms-drain:${src.id}:${utcDay}`;
                    try {
                      // CODEX (impl review #4): DO NOT use maxWaiting here — it
                      // coalesces by (name, queue), NOT by source, so source B's
                      // submit would return source A's waiting row, B would never
                      // queue, and the cap counter would over-count. The per-source
                      // idempotency key is the correct dedup. Pre-check it so we
                      // submit + count only genuinely-new sources (queue.add returns
                      // the existing row on an idempotency hit with no created flag,
                      // which would otherwise over-count the daily cap). The
                      // single-instance autopilot lock + the unique idempotency
                      // index make this pre-check race-free.
                      const dupe = await engine.executeRaw<{ one: number }>(
                        `SELECT 1 AS one FROM minion_jobs WHERE idempotency_key = $1 LIMIT 1`,
                        [idemKey],
                      );
                      if (dupe.length > 0) continue; // already queued/drained for this source today
                      const job = await queue.add(
                        'extract-atoms-drain',
                        { sourceId: src.id, window: windowSeconds, repoPath: src.local_path },
                        {
                          queue: 'default',
                          idempotency_key: idemKey,
                          // issue #3218: the handler now throws on an
                          // all-provider-failed batch, so give the queue's
                          // backoff a chance (was 1 — dead-lettered instantly).
                          max_attempts: 3,
                          timeout_ms: timeoutMs,
                        },
                        { allowProtectedSubmit: true },
                      );
                      submittedToday++;
                      if (jsonMode) {
                        process.stderr.write(JSON.stringify({
                          event: 'dispatched', job_id: job.id, mode: 'auto-drain',
                          source_id: src.id, backlog,
                        }) + '\n');
                      } else {
                        console.log(`[dispatch] job #${job.id} extract-atoms-drain (auto-drain: ${src.id}; backlog=${backlog})`);
                      }
                    } catch (e) {
                      logError('dispatch.auto-drain', e);
                    }
                  }
                }
              }
            }
          } catch (e) {
            logError('dispatch.auto-drain-gate', e);
          }
        }

        // Cheap path: engine.getHealth() is a single SQL count query.
        const health = await engine.getHealth();
        const score = health.brain_score;
        // v0.40.x: recipe-aware embedding-provider check shared with doctor.ts.
        // Resolve the configured model (gateway → DB fallback), then pre-await
        // the handful of hosted-key config values so the resolveKey closure
        // passed to embeddingProviderConfigured() can stay synchronous.
        let embeddingModel: string | undefined;
        try {
          const gw = await import('../core/ai/gateway.ts');
          embeddingModel = gw.getEmbeddingModel();
        } catch {
          embeddingModel = (await engine.getConfig('embedding_model')) ?? undefined;
        }
        // #2662 (codex round-3): HOSTED_EMBED_KEY_CONFIG entries are keys
        // buildGatewayConfig folds from the FILE plane only — `gbrain config
        // set <key> X` writes the DB plane, which never reaches the gateway
        // for these fields. Reading via engine.getConfig() here (DB plane)
        // would report a provider "configured" from a DB-only key that the
        // gateway can never actually use, dispatching a doomed embed job.
        // Read the same file-plane source context.ts (doctor) reads instead,
        // so autopilot and doctor agree with what the gateway can see.
        const { loadConfigFileOnly } = await import('../core/config.ts');
        const fileCfg = loadConfigFileOnly() as Record<string, unknown> | null;
        const embedKeyCfg: Record<string, unknown> = {};
        for (const field of Object.values(HOSTED_EMBED_KEY_CONFIG)) {
          embedKeyCfg[field] = fileCfg?.[field];
        }
        const ctx = {
          repoPath,
          embeddingModel,
          embeddingProviderConfigured: embeddingProviderConfigured(embeddingModel, (envVar) => {
            const cfgField = HOSTED_EMBED_KEY_CONFIG[envVar];
            return !!(process.env[envVar] || (cfgField ? embedKeyCfg[cfgField] : undefined));
          }),
          // #3944: env + FILE plane via the shared helper — the same probe
          // doctor's loadRecommendationContext uses. Reading the DB plane
          // here (engine.getConfig) reported a chat key "configured" that
          // doctor's planner (file plane, per the #2662 rule above) said was
          // missing, so autopilot dispatched chat jobs doctor called blocked.
          hasChatApiKey: chatApiKeyConfigured(fileCfg),
        };
        // v0.41.18.0 (A5 + A19 + A22, T15): consult onboard recommendations
        // ALONGSIDE doctor's brain-score recommendations. Onboard's 4 new
        // checks (embed_staleness, link_coverage, timeline_coverage,
        // takes_count) supply extraRemediations into computeRecommendations.
        // Per A19 fail-open: any throw in the onboard path falls through
        // to legacy doctor-only plan (no crash).
        let extraRemediations: ReturnType<typeof computeRecommendations> = [];
        try {
          const { runAllOnboardChecks } = await import('../core/onboard/checks.ts');
          const onboardResults = await runAllOnboardChecks(engine);
          extraRemediations = onboardResults.flatMap((r) => r.remediations);
        } catch (err) {
          process.stderr.write(
            `[autopilot] onboard checks failed (fail-open per A19): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        const plan = computeRecommendations(health, ctx, extraRemediations).filter((r) => r.status === 'remediable');
        const estTotal = plan.reduce((s, r) => s + r.est_seconds, 0);

        // Track time since last full cycle for the 60-min floor.
        const minutesSinceLastFull = (Date.now() - lastFullCycleAt) / 60000;

        const shouldFullCycle = shouldRunAutopilotFullCycle({
          score,
          planLength: plan.length,
          estimatedSeconds: estTotal,
          minutesSinceLastFull,
        });

        const shouldSleep = shouldSleepHealthyAutopilot(score, plan.length, minutesSinceLastFull);

        if (shouldSleep) {
          if (jsonMode) {
            process.stderr.write(JSON.stringify({ event: 'skip_healthy', score, plan_size: 0 }) + '\n');
          }
        } else if (shouldFullCycle) {
          // v0.38: per-source fan-out replaces the single-job dispatch.
          // dispatchPerSource enumerates sources via listAllSources
          // ({ localPathOnly: true }), gates each on per-source
          // `last_full_cycle_at` from sources.config JSONB, and fans out
          // up to `fanoutMax` per tick (default 4 Postgres, 1 PGLite per
          // codex P1-3). Fresh-install brains with no sources rows fall
          // back to the legacy single autopilot-cycle so existing
          // behavior is preserved.
          const { dispatchPerSource, dispatchGlobalMaintenance, maybeDispatchConnectorSyncs, resolveEffectiveFanoutMax } = await import('./autopilot-fanout.ts');
          // #2194 fix #1: clamp fan-out to the worker's effective concurrency
          // (reserve ≥1 slot), gated on a LIVE supervisor so a stale audit row
          // can't shrink throughput (codex #9/D5). autopilot-cycle jobs run on
          // the 'default' queue, so that's the concurrency we compare against.
          const fanoutMax = await resolveEffectiveFanoutMax(engine, 'default');
          // #2781: both 'autopilot-cycle' (per-source) and 'autopilot-global-
          // maintenance' carry a 30-min handler anchor (handler-timeouts.ts)
          // because a full cycle can outlive short daemon intervals — unlike
          // the lighter interval-derived `timeoutMs` above (sync/freshness,
          // extract-atoms-drain, targeted small-plan steps), which have no
          // such anchor and are meant to stay interval-derived. Naming this
          // separately (rather than reusing the outer `timeoutMs`) avoids
          // the #2781 bug class: dispatchGlobalMaintenance previously reused
          // the outer non-full-cycle `timeoutMs` by shorthand, silently
          // dropping its own handler anchor.
          const fullCycleTimeoutMs = resolveAutopilotDispatchTimeoutMs(baseInterval, true);
          const result = await dispatchPerSource(engine, queue, {
            repoPath,
            slot,
            timeoutMs: fullCycleTimeoutMs,
            fanoutMax,
            jsonMode,
          });
          // #2194 fix #3 / #2227 bug #3: dispatch the single brain-wide
          // maintenance job (embed/orphans/purge/…) once per window — the per-
          // source cycles above no longer run global phases, so this is where
          // the brain-wide work happens (single-flight, no RSS blowout). Only on
          // the per-source path (legacy single-source still runs everything).
          if (!result.legacy_fallback) {
            try {
              await dispatchGlobalMaintenance(engine, queue, { repoPath, slot, timeoutMs: fullCycleTimeoutMs, jsonMode });
            } catch (e) {
              if (jsonMode) process.stderr.write(JSON.stringify({ event: 'global_maintenance_dispatch_failed', error: e instanceof Error ? e.message : String(e) }) + '\n');
            }
          }
          // Opt-in scheduled chat-connector sync (OV#4). Credential-gated +
          // auto_sync-gated: fires for nobody who hasn't explicitly enabled it.
          try {
            await maybeDispatchConnectorSyncs(engine, queue, { slot, timeoutMs: fullCycleTimeoutMs, jsonMode });
          } catch (e) {
            if (jsonMode) process.stderr.write(JSON.stringify({ event: 'connector_sync_dispatch_failed', error: e instanceof Error ? e.message : String(e) }) + '\n');
          }
          // On restart the process-local clock starts overdue. If persisted
          // source timestamps say every source is fresh, advance the local
          // clock too; otherwise a non-empty targeted plan would be skipped
          // on every tick until the persisted 60-minute window elapsed.
          // Coalesced counts as work-in-flight: before dispatched/coalesced
          // split, a coalesced submission advanced this clock via dispatched —
          // keep that behavior, or an all-coalesced tick (single-flight
          // suppression) would retake the full-cycle branch every tick and
          // starve the targeted-plan path for the whole in-flight window.
          if (result.dispatched.length > 0 || result.coalesced.length > 0 || result.legacy_fallback || result.all_sources_fresh) {
            lastFullCycleAt = Date.now();
          }
          if (jsonMode) {
            process.stderr.write(JSON.stringify({
              event: 'fanout_summary',
              dispatched: result.dispatched,
              coalesced: result.coalesced,
              skipped_fresh: result.skipped_fresh,
              skipped_cap: result.skipped_cap,
              skipped_cooldown: result.skipped_cooldown,
              legacy_fallback: result.legacy_fallback,
              fanout_max: fanoutMax,
              score,
            }) + '\n');
          } else if (!result.legacy_fallback) {
            console.log(
              `[dispatch] fanout: ${result.dispatched.length} dispatched` +
              `${result.coalesced.length > 0 ? ` (${result.coalesced.length} coalesced onto in-flight)` : ''}, ` +
              `${result.skipped_fresh.length} fresh, ${result.skipped_cap.length} capped, ` +
              `${result.skipped_cooldown.length} cooldown ` +
              `(score=${score}, max=${fanoutMax})`,
            );
          }
        } else {
          // Small targeted plan — submit individual handlers per step.
          // Recommendation keys stay stable for doctor/remediate checkpoints;
          // Autopilot adds the dispatch interval so completed rows cannot hold
          // the remediation slot forever (#4046).
          // maxWaiting:1 per submit per codex #17 bounds the cross-window
          // backlog if a targeted handler runs longer than one interval.
          for (const step of plan) {
            try {
              const isProtected = !!step.protected;
              const submitOpts = {
                queue: 'default',
                idempotency_key: autopilotRemediationIdempotencyKey(step.idempotency_key, slot),
                max_attempts: 2,
                timeout_ms: timeoutMs,
                maxWaiting: 1,
              };
              const job = await queue.add(
                step.job,
                step.params,
                submitOpts,
                isProtected ? { allowProtectedSubmit: true } : undefined,
              );
              // Honest-dispatch contract (same as the fanout paths): a
              // coalesced submission never claims a dispatch that didn't
              // insert a row.
              if (job.coalesced) {
                if (jsonMode) {
                  process.stderr.write(JSON.stringify({ event: 'dispatch_coalesced', job_id: job.id, mode: 'targeted', step: step.id, score, plan_size: plan.length }) + '\n');
                } else {
                  console.log(`[dispatch] coalesced onto job #${job.id} ${step.job} (targeted: ${step.id}; already in flight)`);
                }
              } else if (jsonMode) {
                process.stderr.write(JSON.stringify({ event: 'dispatched', job_id: job.id, mode: 'targeted', step: step.id, score, plan_size: plan.length }) + '\n');
              } else {
                console.log(`[dispatch] job #${job.id} ${step.job} (targeted: ${step.id}; score=${score})`);
              }
            } catch (e) {
              logError('dispatch.step', e);
            }
          }
        }
      } catch (e) { logError('dispatch', e); cycleOk = false; }
    } else {
      // Inline fallback — delegate to runCycle so lint + backlinks +
      // orphan sweep run too (previously this path only did sync +
      // extract + embed, which didn't match the Minions-dispatch
      // path's phase set). Now both converge on the same primitive.
      try {
        const { runCycle } = await import('../core/cycle.ts');
        // #1872: track the promise so closeEngine can drain it on shutdown,
        // and pass the abort signal so the cycle winds down between phases.
        const cyclePromise = runCycle(engine, {
          brainDir: repoPath,
          // Autopilot daemon path: pulls by default (matches
          // pre-v0.17 autopilot behavior). CLI dream defaults false
          // for cron safety; that choice is scoped to dream only.
          pull: true,
          signal: shutdownAbort.signal,
          yieldBetweenPhases: async () => {
            await new Promise(r => setImmediate(r));
          },
        });
        inflightInlineCycle = cyclePromise;
        const report = await cyclePromise.finally(() => { inflightInlineCycle = null; });
        // Only 'failed' (every attempted phase failed) trips the autopilot
        // circuit breaker. 'partial' means at least one phase warned or
        // failed while others ran — that's a soft signal, not a fatal
        // condition. Treating 'partial' as failure here caused respawn
        // storms under KeepAlive=true on brains where a single phase
        // (typically `orphans`) emits a 'warn' every cycle in steady state.
        if (report.status === 'failed') {
          cycleOk = false;
        }
        if (jsonMode) {
          process.stderr.write(JSON.stringify({ event: 'cycle-inline', status: report.status, duration_ms: report.duration_ms, totals: report.totals }) + '\n');
        } else {
          const t = report.totals;
          console.log(`[cycle-inline ${report.status}] lint=${t.lint_fixes} backlinks=${t.backlinks_added} synced=${t.pages_synced} extracted=${t.pages_extracted} embedded=${t.pages_embedded} orphans=${t.orphans_found}`);
        }
      } catch (e) { logError('cycle-inline', e); cycleOk = false; }
    }

    // 4. Health check + adaptive interval (same for both paths)
    let interval = baseInterval;
    try {
      const health = await engine.getHealth();
      const score = (health as any).brain_score ?? 50;
      interval = score >= 90 ? baseInterval * 2
               : score < 70 ? Math.max(Math.floor(baseInterval / 2), 60)
               : baseInterval;

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0);
      const line = `[cycle] score=${score} elapsed=${elapsed}s next=${interval}s`;
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'cycle', brain_score: score, elapsed_s: Number(elapsed), next_s: interval }) + '\n');
      } else {
        console.log(line);
      }
    } catch (e) { logError('health', e); }

    if (cycleOk) {
      consecutiveErrors = 0;
    } else {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        console.error('5 consecutive cycle failures. Stopping autopilot.');
        void shutdown('cycle-failure-cap');
        break;
      }
    }

    // 4.5 — Nightly quality probe (v0.41).
    // Per D10: trust the phase's internal 24h rate-limit (via shouldRunNightly
    // reading the audit JSONL). No scheduler-side precheck — one source of
    // truth for the rate-limit. Feature flag gates the probe entirely.
    // Wrapped in try/catch — a probe failure NEVER crashes the autopilot
    // loop. Probe runs even when cycleOk=false (probe may surface signal
    // explaining why the cycle is failing).
    try {
      const { resolveProbeEnabled, resolveProbeMaxUsd, runNightlyQualityProbe } =
        await import('../core/cycle/nightly-quality-probe.ts');
      const { resolveNightlyProbeSearchConfigSnapshot } =
        await import('../core/cycle/nightly-probe-search-config.ts');
      // Dual-plane read: `gbrain config set` (what the doctor enable hint
      // prints) writes the DB plane; ~/.gbrain/config.json is the fallback.
      let dbEnabled: string | null = null;
      let dbMaxUsd: string | null = null;
      try {
        dbEnabled = await engine.getConfig('autopilot.nightly_quality_probe.enabled');
        dbMaxUsd = await engine.getConfig('autopilot.nightly_quality_probe.max_usd');
      } catch { /* DB unavailable → file plane only */ }
      const probeEnabled = resolveProbeEnabled(dbEnabled, cfg?.autopilot?.nightly_quality_probe?.enabled);
      if (probeEnabled) {
        const { runLongMemEvalForProbe, runCrossModalBatchForProbe } = await import('../core/cycle/nightly-probe-adapters.ts');
        const { isAvailable } = await import('../core/ai/gateway.ts');
        const { existsSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const { join } = await import('node:path');
        const maxUsd = resolveProbeMaxUsd(dbMaxUsd, cfg?.autopilot?.nightly_quality_probe?.max_usd);
        // The fixture lives in the package, not usually in the user's brain repo.
        const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
        const fixtureAtPkgRoot = existsSync(join(pkgRoot, 'test', 'fixtures', 'longmemeval-nightly.jsonl'));
        await runNightlyQualityProbe({
          isEnabled: () => true, // already gated above; phase re-checks for defense-in-depth
          hasEmbeddingProvider: () => isAvailable('embedding'),
          resolveMaxUsd: () => maxUsd,
          resolveRepoRoot: () => (fixtureAtPkgRoot ? pkgRoot : repoPath ?? gbrainHomePath('.')),
          resolveSearchConfigSnapshot: () => resolveNightlyProbeSearchConfigSnapshot(engine),
          runLongMemEval: runLongMemEvalForProbe,
          runCrossModalBatch: runCrossModalBatchForProbe,
          now: () => new Date(),
        });
      }
    } catch (e) {
      logError('autopilot.nightly_probe', e);
      // Intentional: do NOT bump consecutiveErrors. Probe failure is
      // informational; autopilot loop continues.
    }

    // 4.6 — Nightly conversation-parser probe (v0.41.16.0 phase module;
    // the scheduler wire-up was deferred at ship and is added here). Same
    // posture as 4.5: the phase owns its gates (enabled/mode-gate, LLM
    // key), the wiring owns invocation + the audit row, and a probe
    // failure NEVER crashes the autopilot loop. Per D10 the probe is
    // default-ON for search.mode=tokenmax, opt-in otherwise.
    try {
      const { runConversationParserNightlyProbe } = await import('../core/conversation-parser/nightly-probe.ts');
      const { logParserProbeEvent, parserProbeRanWithin } = await import('../core/audit-parser-probe.ts');
      const { isAvailable } = await import('../core/ai/gateway.ts');
      const { existsSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const { join } = await import('node:path');
      // Flag reads dual-plane: the DB row (`gbrain config set …`) wins,
      // ~/.gbrain/config.json is the fallback. search.mode lives on the
      // DB plane only (mode.ts owns it).
      let parserDbEnabled: string | null = null;
      let dbSearchMode: string | null = null;
      try {
        parserDbEnabled = await engine.getConfig('autopilot.conversation_parser_probe.enabled');
        dbSearchMode = await engine.getConfig('search.mode');
      } catch { /* DB unavailable → file plane only */ }
      const parserEnabled = parserDbEnabled != null
        ? parserDbEnabled === 'true'
        : cfg?.autopilot?.conversation_parser_probe?.enabled === true;
      const searchMode = dbSearchMode ?? '';
      // Fixtures are committed in the gbrain package (test/fixtures/…),
      // NOT the brain repo — resolve from the module location. Compiled
      // binaries carry no source tree: skip quietly instead of writing
      // failure rows that would flip doctor to WARN on every binary install.
      const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
      const fixturePath = join(pkgRoot, 'test', 'fixtures', 'conversation-formats', 'all.jsonl');
      const adversarialPath = join(pkgRoot, 'test', 'fixtures', 'conversation-formats', 'adversarial.jsonl');
      const shouldInvoke = parserEnabled || searchMode === 'tokenmax';
      if (shouldInvoke && existsSync(fixturePath) && existsSync(adversarialPath)) {
        const result = await runConversationParserNightlyProbe({
          isEnabled: () => parserEnabled,
          searchMode: () => searchMode,
          hasLlmKey: () => isAvailable('chat'),
          resolveFixturePath: () => fixturePath,
          resolveAdversarialPath: () => adversarialPath,
          now: () => new Date(),
          shouldSkipForRateLimit: () => parserProbeRanWithin(24 * 60 * 60 * 1000),
        });
        // rate_limited is a non-run: the loop ticks every few minutes, so
        // logging every skip would flood the audit file with no-signal rows.
        if (result.outcome !== 'rate_limited') logParserProbeEvent(result);
      } else if (shouldInvoke && !parserProbeFixtureWarned) {
        parserProbeFixtureWarned = true;
        console.error(`[parser-probe] fixtures not found under ${pkgRoot}; skipping (probe needs a source-checkout install)`);
      }
    } catch (e) {
      logError('autopilot.parser_probe', e);
      // Informational, like 4.5: do NOT bump consecutiveErrors.
    }

    // Wait for next cycle
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

// --- Install/Uninstall ---

function plistPath(): string {
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', `${autopilotLaunchdLabel()}.plist`);
}

function systemdUnitPath(): string {
  return join(process.env.HOME || '', '.config', 'systemd', 'user', AUTOPILOT_SYSTEMD_UNIT);
}

function ephemeralStartScriptPath(): string {
  return join(process.env.HOME || '', '.gbrain', 'start-autopilot.sh');
}

export type InstallTarget = 'macos' | 'linux-systemd' | 'ephemeral-container' | 'linux-cron';

/**
 * Detect the right supervisor for this host.
 *
 *   - macos   → launchd (always, when platform === 'darwin').
 *   - ephemeral-container → Render / Railway / Fly / Docker. Crontab is
 *                           unreliable here (wiped on deploy); we hand
 *                           the user a start script instead.
 *   - linux-systemd → systemd user scope actually works (is-system-running
 *                     probe succeeds). Codex hardened from the naive
 *                     /run/systemd/system check.
 *   - linux-cron  → fallback.
 */
export function detectInstallTarget(): InstallTarget {
  if (process.platform === 'darwin') return 'macos';

  // Shared detector (execution-env.ts): covers the original Render/Railway/
  // Fly//.dockerenv signals AND the cloud-sandbox signature — both get the
  // start-script treatment here (no reliable scheduler in either).
  if (detectExecutionEnvironment() !== 'local') return 'ephemeral-container';

  if (existsSync('/run/systemd/system')) {
    try {
      execSync('systemctl --user is-system-running', { stdio: 'pipe', timeout: 3000 });
      return 'linux-systemd';
    } catch {
      // user bus not available → fall through to cron.
    }
  }

  return 'linux-cron';
}

function detectOpenClaw(): { detected: boolean; bootstrapCandidates: string[] } {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.OPENCLAW_HOME ? join(process.env.OPENCLAW_HOME, 'hooks', 'bootstrap', 'ensure-services.sh') : '',
    join(process.cwd(), 'hooks', 'bootstrap', 'ensure-services.sh'),
    join(home, '.claude', 'hooks', 'bootstrap', 'ensure-services.sh'),
  ].filter(Boolean) as string[];
  const existing = candidates.filter(p => existsSync(p));
  const signal = !!process.env.OPENCLAW_HOME
    || existsSync(join(process.cwd(), 'openclaw.json'))
    || existsSync(join(home, 'openclaw.json'))
    || existing.length > 0;
  return { detected: signal, bootstrapCandidates: existing };
}

/** systemd unit name. The launchd label lives in `autopilotLaunchdLabel()`
 *  (core/autopilot-paths.ts) so installer, uninstaller, status, and the
 *  wrapper's self-disable can never name different jobs. */
export const AUTOPILOT_SYSTEMD_UNIT = 'gbrain-autopilot.service';


/**
 * Bash block that stops the daemon for good when its captured `--repo` is gone.
 *
 * Two things this must get right, both learned the hard way:
 *
 * 1. PREDICATE. Test the repo DIRECTORY, not `$repo/.git`. `--repo` may be a
 *    subdirectory of the checkout (sync resolves the root itself by walking up
 *    with `git rev-parse` show-toplevel), and in worktrees and submodules
 *    `.git` is a FILE, not a directory. Testing `.git/` would self-disable a
 *    perfectly healthy install in both shapes.
 *
 * 2. MECHANISM. `exit 0` is the right answer for the sibling cron wrapper in
 *    `brain-repo-durability.ts` because launchd fires that one on StartInterval —
 *    one shot, so exiting ends it. Autopilot runs under `KeepAlive=true` +
 *    `ThrottleInterval=60` (and systemd `Restart=always` / `RestartSec=30`),
 *    where exiting 0 disables NOTHING: it converts a dead install into a silent
 *    respawn-every-60s log-append loop that runs forever. On those two targets
 *    the wrapper has to actually take the job out of rotation.
 *
 *    `linux-cron` and `ephemeral-container` are periodic/one-shot, so a plain
 *    exit is correct and sufficient there.
 *
 * Exported pure so tests can assert the emitted shape per target without
 * installing a daemon.
 */
export function generateSelfDisableGuard(repoPath: string, target: InstallTarget): string {
  const q = (s: string) => s.replace(/'/g, "'\\''");
  const marker = autopilotDisabledMarkerPath();
  const disableCmd =
    target === 'macos'
      ? `  launchctl bootout "gui/$(id -u)/${autopilotLaunchdLabel()}" 2>/dev/null || true\n`
      : target === 'linux-systemd'
        ? `  systemctl --user disable --now ${AUTOPILOT_SYSTEMD_UNIT} 2>/dev/null || true\n`
        : '';
  const strikes = autopilotDisableStrikesPath();
  return `# Self-disable if the captured checkout is gone (rename / relocation / deletion).
# Tests the repo DIRECTORY: --repo may be a subdirectory of the checkout, and
# .git is a FILE in worktrees and submodules, so [ ! -d "$repo/.git" ] would
# false-positive on healthy installs.
# THREE consecutive misses before disabling: repos on external volumes, NFS,
# or cloud-synced folders are routinely absent for the first launch after
# login, and one transient miss must not permanently kill the install. Any
# successful probe resets the strike counter.
if [ ! -d '${q(repoPath)}' ]; then
  _strikes=$(($(cat '${q(strikes)}' 2>/dev/null || echo 0) + 1))
  echo "$_strikes" > '${q(strikes)}' 2>/dev/null || true
  if [ "$_strikes" -lt 3 ]; then
    echo "$(date -u +%FT%TZ) [autopilot] repo path missing (strike $_strikes of 3, disabling at 3):" '${q(repoPath)}'
    exit 0
  fi
  echo "$(date -u +%FT%TZ) [autopilot] repo path gone, disabling:" '${q(repoPath)}'
  printf '%s\\n' 'repo path gone: ${q(repoPath)}' > '${q(marker)}' 2>/dev/null || true
  rm -f '${q(strikes)}' 2>/dev/null || true
${disableCmd}  exit 0
fi
rm -f '${q(strikes)}' 2>/dev/null || true
`;
}

// Exported for tests (#2608): the emitted wrapper text is the contract —
// key-channel regressions (rc-file || chains, missing env-file sourcing)
// must be pinnable without installing a daemon.
/**
 * #2608: contents of the install-time `<gbrainDir>/env` template. All lines
 * commented — the install must never ship a live secret. GBRAIN_HOME is
 * deliberately absent: the wrapper bakes it at install time AFTER sourcing
 * this file, so setting it here would be clobbered (or diverge the daemon's
 * home from the file's own location).
 */
const GBRAIN_ENV_TEMPLATE = `# gbrain daemon environment — sourced by autopilot-run.sh before the daemon
# starts (set -a: plain KEY=value lines are exported too). Created once by
# \`gbrain autopilot --install\`; gbrain never overwrites or deletes it.
# Interactive shell rc files do NOT reach daemon shells — put anything the
# daemon needs here, then re-run \`gbrain autopilot --install\` to reload.
#
# API keys (~/.gbrain/config.json file plane works too):
# export ANTHROPIC_API_KEY=sk-ant-...
# export OPENAI_API_KEY=sk-...
# export VOYAGE_API_KEY=pa-...
#
# Process-level env that must exist before the daemon boots:
# export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem
# export HTTPS_PROXY=http://proxy:3128
# export GBRAIN_DATABASE_URL=postgres://...
#
# Do NOT set GBRAIN_HOME here — --install bakes it into the wrapper after
# this file is sourced, so a value here is clobbered or diverges the
# daemon's home from this file's own location.
`;

export function writeWrapperScript(repoPath: string, target: InstallTarget): string {
  // gbrainHomePath, not raw $HOME: the daemon writes its lock/markers through
  // it and the status command reads through it, so a GBRAIN_HOME install must
  // keep its wrapper (and the start-script detection that looks for it) in
  // the same directory. Identical to the old behavior when GBRAIN_HOME is
  // unset. The env var is also baked into the wrapper below — launchd does
  // not pass the installer's environment to the spawned job.
  const gbrainDir = gbrainHomePath();
  mkdirSync(gbrainDir, { recursive: true });

  // Wrapper sources the user's shell profile for API keys so nothing is
  // baked into plist/crontab/systemd unit files (#2).
  const wrapperPath = join(gbrainDir, 'autopilot-run.sh');
  const gbrainPath = resolveGbrainCliPath();
  const safeRepoPath = repoPath.replace(/'/g, "'\\''");
  const safeGbrainPath = gbrainPath.replace(/'/g, "'\\''");
  // #2608: same gbrain home the daemon itself uses (honors GBRAIN_HOME),
  // baked as an absolute path so the sourcing below never depends on a
  // literal ~/.gbrain guess drifting from a custom install.
  const gbrainEnvFile = join(gbrainDir, 'env');
  const safeGbrainEnvFile = gbrainEnvFile.replace(/'/g, "'\\''");
  // #2608: install-time template so the boot warning points at a file that
  // exists, secret-safe (0600) from birth. Never overwrite — it may hold
  // user secrets — and never chmod a pre-existing file (warn instead). A
  // failed template write must not abort an otherwise-working install
  // (untested by design: dir-permission tricks don't bite under root CI).
  try {
    if (!existsSync(gbrainEnvFile)) {
      writeFileSync(gbrainEnvFile, GBRAIN_ENV_TEMPLATE, { mode: 0o600 });
    } else if ((statSync(gbrainEnvFile).mode & 0o077) !== 0) {
      console.error(`[autopilot] warning: ${gbrainEnvFile} is group/world-readable and may hold API keys — consider: chmod 600 '${safeGbrainEnvFile}'`);
    }
  } catch (e) {
    console.error(`[autopilot] warning: could not create env template at ${gbrainEnvFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Bake the dir of the bun runtime actually executing this install onto PATH,
  // so the wrapper finds bun wherever it lives — Homebrew (/opt/homebrew/bin),
  // npm -g, Docker (/usr/local/bin), a custom BUN_INSTALL, or nix — not just
  // ~/.bun/bin (which #3305 hardcoded, covering only the default bun.sh installer).
  // dirname('') === '.', so guard the degenerate/empty case — otherwise a missing
  // execPath would prepend '.' (cwd) onto a cron PATH. Empty prefix falls back to
  // the #3305 behavior exactly.
  const runtimeDir = dirname(process.execPath || '');
  const runtimePathPrefix = runtimeDir && runtimeDir !== '.'
    ? `'${runtimeDir.replace(/'/g, "'\\''")}':`
    : '';
  const wrapper = `#!/bin/bash
# Auto-generated by gbrain autopilot --install
# Sources shell profile for API keys, then runs autopilot.
# zshenv is the canonical place for env vars in zsh on macOS (zshrc is for
# interactive shells only — vars defined there don't reach this non-interactive
# subprocess). Source it first so secrets like GBRAIN_DATABASE_URL or any
# OPENAI/ANTHROPIC keys exported in zshenv reach autopilot.
[ -f ~/.zshenv ] && source ~/.zshenv 2>/dev/null
# #2608: source zshrc AND bashrc independently. The old \`zshrc || bashrc\`
# chain only reached bashrc when sourcing zshrc FAILED — on a machine with
# both files (default macOS + a bash-managed key setup) the bashrc keys
# never loaded and every LLM phase silently no-op'd.
[ -f ~/.zshrc ] && source ~/.zshrc 2>/dev/null
[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null
# gbrain-owned env file (#2608), additive to the profiles above: daemon
# shells are non-interactive, so exports that live only in an interactive
# rc file never reach them — and the ~/.bashrc guard below means even
# ~/.bashrc-only exports can be lost on a common Linux config. This is the
# deterministic place for API keys AND process-level env the daemon needs
# before boot (NODE_EXTRA_CA_CERTS, proxy vars, GBRAIN_DATABASE_URL) —
# things an in-process config read could never deliver. Created 0600 by
# --install. Sourced AFTER the profiles so it wins on conflicts; a missing
# file is a normal no-op, not an error. set -a exports dotenv-style
# KEY=value lines too — without it a plain assignment never reaches the
# exec'd daemon.
[ -f '${safeGbrainEnvFile}' ] && { set -a; source '${safeGbrainEnvFile}' 2>/dev/null; set +a; }
# Belt-and-suspenders PATH fix. ~/.bashrc ships with a non-interactive guard
# (\`case $- in *i*) ;; *) return;; esac\`) that exits early when launched from
# cron/systemd/launchd — so its PATH exports never reach this subprocess.
# Without bun on PATH, the exec'd gbrain (a \`#!/usr/bin/env bun\` script) fails
# silently with "env: bun: No such file or directory" and leaves a stale
# lockfile that blocks every subsequent tick. Prepending the running bun's own
# dir (derived from process.execPath at install time), with ~/.bun/bin kept as a
# fallback, keeps the wrapper self-contained regardless of where bun is installed
# or which init file the OS loaded.
export PATH=${runtimePathPrefix}"$HOME/.bun/bin:$PATH"
${process.env.GBRAIN_HOME ? `# Baked at install: the supervisor does not pass the installer's env, and\n# without this the daemon would read/write a different home than the\n# install that configured it.\nexport GBRAIN_HOME='${(process.env.GBRAIN_HOME).replace(/'/g, "'\\''")}'\n` : ''}
${generateSelfDisableGuard(repoPath, target)}# #3696: daemon cwd = the repo, so any legacy RELATIVE sources.local_path /
# sync.repo_path row resolves against it instead of a phantom path under the
# supervisor's cwd. Done HERE — after the guard has proven the repo exists —
# and NOT via launchd's plist WorkingDirectory: launchd chdir()s before exec,
# so a deleted repo would fail every respawn and the self-disable guard above
# could never run. Fail-open (|| true): a repo deleted between the guard and
# this line still starts the daemon, and the dispatch loops skip relative
# paths loudly.
cd '${safeRepoPath}' 2>/dev/null || true
exec '${safeGbrainPath}' autopilot --repo '${safeRepoPath}'
`;
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  return wrapperPath;
}

async function installDaemon(engine: BrainEngine, args: string[]) {
  // #677: on a PGLite brain the autopilot daemon would hold the single-writer
  // DB lock for its lifetime — every other gbrain process (serve, search,
  // sweep, embed) then fails to connect. Refuse with guidance; --force for
  // operators who genuinely want a daemon-owned brain.
  const guardMsg = pgliteDaemonGuardMessage(engine.kind, args.includes('--force'));
  if (guardMsg) {
    console.error(guardMsg);
    process.exit(1);
  }
  const rawRepoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  if (!rawRepoPath) {
    console.error('No repo path. Use --repo or run gbrain sync --repo first.');
    process.exit(1);
  }
  // #3696: the daemon runs with an arbitrary cwd (launchd: `/`), so a
  // relative `--repo .` baked into the wrapper script resolves to a phantom
  // path at daemon runtime. Resolve NOW, against the installer's cwd.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- rawRepoPath is the local operator's own --repo CLI arg or the operator-written sync.repo_path config row; installDaemon is reachable only via `gbrain autopilot --install` on the trusted local CLI (never MCP/remote), and absolutizing it here IS the #3696 fix
  const repoPath = resolvePath(rawRepoPath);

  const forcedTarget = parseArg(args, '--target') as InstallTarget | undefined;
  const target: InstallTarget = forcedTarget ?? detectInstallTarget();

  const injectBootstrap = args.includes('--inject-bootstrap');
  const noInject = args.includes('--no-inject');

  const wrapperPath = writeWrapperScript(repoPath, target);
  // #2608: tell the operator about the deterministic key channel — launchd/
  // systemd don't inherit the login shell env, and rc-file interactive guards
  // routinely swallow exports, so "it works in my terminal" keys often never
  // reach the daemon.
  console.log(
    `API keys: the daemon sources ${join(gbrainHomePath(), 'env')} (plain KEY=value lines, ` +
    `auto-exported) in addition to your shell profile. If LLM phases report no provider, put ` +
    'ANTHROPIC_API_KEY=... (or your provider\'s key) there and re-run `gbrain autopilot --install`.',
  );
  // A fresh install clears any prior self-disable AND any leaked pause, so a
  // reinstall does not report "disabled" forever or park itself from day one
  // on a marker some dead migration left behind.
  try { unlinkSync(autopilotDisabledMarkerPath()); } catch { /* not disabled */ }
  try { unlinkSync(autopilotPausedMarkerPath()); } catch { /* not paused */ }
  const home = process.env.HOME || '';

  switch (target) {
    case 'macos':
      installLaunchd(wrapperPath, home, repoPath);
      break;
    case 'linux-systemd':
      installSystemd(wrapperPath, repoPath);
      break;
    case 'ephemeral-container':
      installEphemeralContainer(wrapperPath, home, repoPath, { injectBootstrap, noInject });
      break;
    case 'linux-cron':
      installCrontab(wrapperPath, home);
      break;
    default: {
      console.error(`Unknown --target "${forcedTarget}". Allowed: macos, linux-systemd, ephemeral-container, linux-cron.`);
      process.exit(2);
    }
  }
}

/**
 * #677 — PGLite install guard, pure (the unit-test surface). A PGLite brain
 * is single-writer: a daemonized autopilot holds the exclusive DB lock 24/7,
 * so every OTHER gbrain process (`serve`, `search`, `sweep --once`,
 * `embed --stale`) fails to connect for as long as the daemon lives. The
 * supported PGLite background story is `gbrain serve` (resident sweep +
 * serve-delegated sync/sweep over IPC). Returns the refusal message, or null
 * when the install may proceed (postgres engine, or explicit --force).
 */
export function pgliteDaemonGuardMessage(engineKind: string, force: boolean): string | null {
  if (engineKind !== 'pglite' || force) return null;
  return (
    `gbrain autopilot --install: this brain runs on PGLite (single-writer). A daemonized ` +
    `autopilot would hold the exclusive DB lock 24/7 and block every other gbrain ` +
    `process (serve, search, sweep, embed) for as long as it runs.\n` +
    `  Recommended: run \`gbrain serve\` instead — it owns the lock, runs the resident ` +
    `maintenance sweep, and delegates \`gbrain sync\`/\`gbrain sweep --once\` through its ` +
    `IPC socket.\n` +
    `  To install the daemon anyway (dedicated-brain setups), re-run with --force.`
  );
}

/**
 * #3696 — the autopilot dispatch loops refuse to enqueue work for a source
 * whose local_path is RELATIVE: the daemon's cwd is launchd's (typically `/`),
 * not the shell that registered the source, so the path would resolve to a
 * phantom directory and the sync/extract job would fail (or worse, walk the
 * wrong tree). Returns the stderr warning line when the path must be skipped,
 * or null when it is dispatchable. Pure — the unit-test surface.
 */
export function relativeLocalPathSkipWarning(sourceId: string, localPath: string): string | null {
  if (isAbsolute(localPath)) return null;
  return (
    `[autopilot] skipping source '${sourceId}': relative local_path ` +
    `'${localPath}' cannot be resolved from a daemon. Re-register with an ` +
    `absolute --path or run 'gbrain sync --source ${sourceId}' once to self-heal.`
  );
}

// v0.37.7.0 #1162 — pure function for plist generation so tests can
// assert ThrottleInterval/KeepAlive shape without an installed daemon.
// #3696: WorkingDirectory pins the daemon's cwd away from launchd's `/`
// default — but it MUST be a spawn-safe path, NEVER the repo. launchd
// chdir()s before exec, so a WorkingDirectory that stops existing makes
// every (re)spawn fail: after a repo deletion the wrapper — and its
// self-disable guard — would never run again, leaving a zombie KeepAlive
// job that can never take itself out of rotation. $HOME exists for the
// job's whole lifetime; the WRAPPER cd's into the repo AFTER the guard has
// proven it exists (writeWrapperScript), which is what makes legacy
// RELATIVE sources.local_path / sync.repo_path rows resolve against the
// repo instead of a phantom path.
export function generateLaunchdPlist(wrapperPath: string, home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(autopilotLaunchdLabel())}</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(wrapperPath)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!--
    v0.37.7.0 #1162: ThrottleInterval=60 forces launchd to wait at
    least 60s between relaunches. Combined with the in-process
    classifier (recoverable vs unrecoverable in the supervisor loop),
    this prevents the spinning respawn pattern where an unrecoverable
    error (missing database_url, malformed config) immediately
    relaunched and re-hit the same error. ThrottleInterval is a hard
    floor; launchd would have applied a default of 10s if unset.
  -->
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${escapeXml(home)}/.gbrain/autopilot.log</string>
  <key>StandardErrorPath</key><string>${escapeXml(home)}/.gbrain/autopilot.err</string>
</dict>
</plist>`;
}

function installLaunchd(wrapperPath: string, home: string, repoPath: string) {
  const plist = generateLaunchdPlist(wrapperPath, home);

  try {
    const agentsDir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(plistPath(), plist, { mode: 0o644 });
    // launchd rejects group/world-writable agent plists: bootstrap/load fails
    // with the opaque "Bootstrap failed: 5: Input/output error" and the login
    // scan skips the file silently. writeFileSync's mode only applies on
    // create — a reinstall over an existing plist keeps the old bits (a 0666
    // plist written under an umask-0 parent stays 0666 forever) — so
    // normalize unconditionally.
    chmodSync(plistPath(), 0o644);
    // Unload-before-load (same pattern as uninstall): bare `launchctl load`
    // on an already-loaded agent errors and aborted every reinstall — and a
    // running daemon must be relaunched anyway to pick up a regenerated
    // wrapper / env file (#2608: the boot warning tells users to re-run
    // --install to reload; this line is what makes that true on macOS).
    execSync(`launchctl unload "${plistPath()}" 2>/dev/null || true`, { stdio: 'pipe' });
    execSync(`launchctl load "${plistPath()}"`, { stdio: 'pipe' });
    console.log(`Installed launchd service: ${autopilotLaunchdLabel()}`);
    console.log(`  Repo: ${repoPath}`);
    console.log(`  Log: ~/.gbrain/autopilot.log`);
    console.log('  Uninstall: gbrain autopilot --uninstall');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('EACCES') || msg.includes('Permission')) {
      console.error('Permission denied writing plist. Try: mkdir -p ~/Library/LaunchAgents');
    } else {
      console.error(`Failed to install: ${msg}`);
    }
    process.exit(1);
  }
}

/**
 * Generate the gbrain-autopilot systemd user unit.
 *
 * v0.42: `Restart=always` (was `on-failure`). The self-upgrade silent channel
 * does swap-only + `exit(0)` and relies on the supervisor to relaunch the new
 * binary — there is no in-process re-exec (Bun has no `execve`). `on-failure`
 * would NOT relaunch on a clean exit, silently killing the daemon after it
 * upgraded itself. `StartLimitIntervalSec`/`StartLimitBurst` cap a clean-exit
 * respawn storm (systemd's analog to the launchd `ThrottleInterval=60`).
 *
 * Exported so the v0.42 migration can recognize the prior generated shape and
 * rewrite existing `on-failure` units in place.
 */
export function generateSystemdUnit(wrapperPath: string): string {
  return `[Unit]
Description=GBrain Autopilot
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=${wrapperPath}
Restart=always
RestartSec=30
StandardOutput=append:%h/.gbrain/autopilot.log
StandardError=append:%h/.gbrain/autopilot.err

[Install]
WantedBy=default.target
`;
}

/**
 * v0.42 migration: rewrite an existing `Restart=on-failure` autopilot systemd
 * unit to `Restart=always` so the self-upgrade silent channel's clean
 * exit-for-relaunch actually respawns. HARD-GUARDED: only rewrites a unit that
 * matches the known gbrain-generated shape (never a hand-edited one), only
 * user-level units (never system, never needs root), Linux only. Idempotent:
 * a no-op once already `Restart=always`. Best-effort; called from runPostUpgrade.
 */
export function migrateSystemdUnitToRestartAlways(): { rewritten: boolean; reason: string } {
  if (process.platform !== 'linux') return { rewritten: false, reason: 'not-linux' };
  let unitPath: string;
  try {
    unitPath = systemdUnitPath();
  } catch {
    return { rewritten: false, reason: 'no-unit-path' };
  }
  if (!existsSync(unitPath)) return { rewritten: false, reason: 'no-unit' };
  let content: string;
  try {
    content = readFileSync(unitPath, 'utf8');
  } catch {
    return { rewritten: false, reason: 'unreadable' };
  }
  if (!content.includes('Restart=on-failure')) {
    return { rewritten: false, reason: 'already-migrated' };
  }
  // Hard guard: must look like OUR generated unit, not a hand-edited one.
  const execMatch = content.match(/ExecStart=(\S+)/);
  const looksGenerated =
    content.includes('Description=GBrain Autopilot') &&
    content.includes('StandardOutput=append:%h/.gbrain/autopilot.log') &&
    !!execMatch;
  if (!looksGenerated) {
    process.stderr.write(
      '[gbrain] autopilot systemd unit looks hand-edited; NOT rewriting Restart=on-failure. ' +
        'Set Restart=always manually so self-upgrade relaunch works.\n',
    );
    return { rewritten: false, reason: 'hand-edited' };
  }
  try {
    writeFileSync(unitPath, generateSystemdUnit(execMatch![1]), { mode: 0o644 });
    // This path always rewrites an EXISTING unit, so writeFileSync's mode
    // never applies — chmod is the only thing that normalizes a unit born
    // 0666 under a umask-0 parent (systemd warns on world-writable units).
    chmodSync(unitPath, 0o644);
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 10_000 });
    } catch {
      /* daemon-reload best-effort */
    }
    return { rewritten: true, reason: 'rewritten' };
  } catch (e) {
    return { rewritten: false, reason: e instanceof Error ? e.message : 'write-failed' };
  }
}

function installSystemd(wrapperPath: string, repoPath: string) {
  const unit = generateSystemdUnit(wrapperPath);
  try {
    const unitPath = systemdUnitPath();
    mkdirSync(join(process.env.HOME || '', '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unitPath, unit, { mode: 0o644 });
    // Same umask-0 hardening as the launchd path (systemd warns on
    // world-writable units); mode only applies on create, so normalize.
    chmodSync(unitPath, 0o644);
    execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 10_000 });
    execSync(`systemctl --user enable --now ${AUTOPILOT_SYSTEMD_UNIT}`, { stdio: 'pipe', timeout: 15_000 });
    // enable --now does NOT restart an already-active unit, so a reinstall
    // over a running daemon would keep the old process (and its stale env)
    // alive indefinitely (#2608: the boot warning tells users to re-run
    // --install to reload; this line is what makes that true on systemd).
    // try-restart only bounces a running unit — a fresh install just started
    // above is restarted at worst, never left stopped.
    execSync(`systemctl --user try-restart ${AUTOPILOT_SYSTEMD_UNIT}`, { stdio: 'pipe', timeout: 15_000 });
    console.log(`Installed systemd user service: ${AUTOPILOT_SYSTEMD_UNIT}`);
    console.log(`  Repo: ${repoPath}`);
    console.log('  Log: ~/.gbrain/autopilot.log');
    console.log('  Uninstall: gbrain autopilot --uninstall');
  } catch (e: unknown) {
    console.error(`Failed to install systemd unit: ${e instanceof Error ? e.message : e}`);
    console.error('You may need: `loginctl enable-linger $USER` so the unit runs without a login session.');
    process.exit(1);
  }
}

function installEphemeralContainer(
  wrapperPath: string,
  home: string,
  repoPath: string,
  opts: { injectBootstrap: boolean; noInject: boolean },
) {
  // Write a start script the agent's bootstrap can source on every container start.
  const safeWrapperPath = wrapperPath.replace(/'/g, "'\\''");
  const script = `#!/bin/bash
# Auto-generated by gbrain autopilot --install (ephemeral-container target)
# Ephemeral filesystems lose crontab on every deploy; source this from
# your agent's bootstrap instead.
nohup '${safeWrapperPath}' > ~/.gbrain/autopilot.log 2>&1 &
echo \$! > ~/.gbrain/autopilot.pid
`;
  const scriptPath = ephemeralStartScriptPath();
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(scriptPath, script, { mode: 0o755 });

  console.log('Ephemeral container detected (Render / Railway / Fly / Docker).');
  console.log(`Repo: ${repoPath}`);
  console.log(`Start script: ${scriptPath}`);
  // Rewriting the start script cannot reload an autopilot already launched
  // from it — that process keeps its old environment until the container
  // restarts. Never auto-kill; say how (#2608, same honesty as the cron path).
  console.log('  An already-running autopilot keeps its old environment until the container');
  console.log('  restarts (or: kill $(cat ~/.gbrain/autopilot.pid), then re-run the start script).');
  console.log('');
  console.log('Crontab is unreliable here (wiped on deploy). Add ONE LINE to your');
  console.log('agent bootstrap to launch autopilot on every start:');
  console.log('');
  console.log(`  bash ${scriptPath}`);
  console.log('');

  // OpenClaw detection + optional auto-injection into ensure-services.sh.
  const { detected, bootstrapCandidates } = detectOpenClaw();
  if (detected) {
    console.log(`OpenClaw detected. Bootstrap candidates found:`);
    for (const p of bootstrapCandidates) console.log(`  - ${p}`);
    console.log('');
  }

  const shouldInject = (injectOpts: { detected: boolean; injectBootstrap: boolean; noInject: boolean }) => {
    if (injectOpts.noInject) return false;
    // Auto-inject by default when OpenClaw is detected + at least one
    // candidate exists. Users can explicitly opt in with --inject-bootstrap
    // on other hosts (uncommon).
    if (injectOpts.detected && bootstrapCandidates.length > 0) return true;
    return injectOpts.injectBootstrap;
  };

  if (shouldInject({ detected, injectBootstrap: opts.injectBootstrap, noInject: opts.noInject })) {
    for (const candidate of bootstrapCandidates) {
      try {
        const existing = readFileSync(candidate, 'utf-8');
        const marker = '# gbrain:autopilot v0.11.0';
        if (existing.includes(marker)) {
          console.log(`  [skip] ${candidate} already has the gbrain marker`);
          continue;
        }
        // Backup before edit
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const bakPath = `${candidate}.bak.${stamp}`;
        writeFileSync(bakPath, existing);
        const snippet = `\n${marker}\nbash ${scriptPath}\n`;
        writeFileSync(candidate, existing.trimEnd() + snippet);
        console.log(`  [injected] ${candidate} (.bak at ${bakPath})`);
      } catch (e) {
        console.error(`  [warn] failed to inject ${candidate}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  console.log('  Uninstall: gbrain autopilot --uninstall');
}

function installCrontab(wrapperPath: string, home: string) {
  // Linux/WSL without systemd — crontab runs the wrapper every 5 minutes.
  const safeWrapperPath = wrapperPath.replace(/'/g, "'\\''");
  const cronLine = `*/5 * * * * '${safeWrapperPath}' >> '${home.replace(/'/g, "'\\''")}/.gbrain/autopilot.log' 2>&1`;
  try {
    const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
    if (existing.includes('gbrain autopilot') || existing.includes('autopilot-run.sh')) {
      console.log('Crontab entry already exists. Remove with: gbrain autopilot --uninstall');
      // The wrapper (and env template) were regenerated above, but cron
      // cannot reload a loop that is already running — it keeps its old
      // environment until it exits. Never auto-kill a user process; tell
      // them exactly how (#2608: makes the boot warning's re-run---install
      // remediation honest on the cron target).
      console.log(`  A running autopilot loop keeps its old environment until it exits — end it with: kill $(cat '${autopilotLockPath().replace(/'/g, "'\\''")}')`);
      console.log('  The next cron tick relaunches it with the refreshed wrapper and env file.');
      return;
    }
    // Use a temp file instead of echo pipe to avoid shell escaping issues (#1)
    const tmpFile = join(home, '.gbrain', 'crontab.tmp');
    writeFileSync(tmpFile, existing.trimEnd() + '\n' + cronLine + '\n');
    execSync(`crontab '${tmpFile.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
    try { unlinkSync(tmpFile); } catch { /* best-effort */ }
    console.log('Installed crontab entry for gbrain autopilot (every 5 minutes)');
    console.log('  Uninstall: gbrain autopilot --uninstall');
  } catch (e: unknown) {
    console.error(`Failed to install crontab: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

/**
 * The status verdict, engine-free. Dispatched BEFORE connectEngine in cli.ts:
 * a running PGLite daemon holds the exclusive DB lock, so an engine-bound
 * status could not run against a healthy live install — and a DB outage would
 * take down the very alarm meant to diagnose it. Everything it reads is
 * filesystem (lock mtime, markers, plist/unit/crontab, log tail).
 */
export function runAutopilotStatus(args: string[]): void {
  // An INSTALLED daemon always runs the default interval — the generated
  // wrapper execs `autopilot --repo <path>` with no --interval. The flag is
  // honored here for the manual foreground case. Garbage input must not
  // become NaN: staleAfter = NaN makes every age comparison false, which
  // reads a 71-day-dead daemon as 'fresh' with exit 0 — a typo'd flag would
  // silently disable the very alarm this exit code exists to be.
  const rawInterval = parseInt(parseArg(args, '--interval') || '300', 10);
  showStatus(args.includes('--json'), Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 300);
}

export function uninstallDaemon() {
  const home = process.env.HOME || '';
  // Same resolution as writeWrapperScript — a GBRAIN_HOME install must
  // uninstall the wrapper it actually wrote, not a sibling under raw $HOME.
  const wrapperPath = join(gbrainHomePath(), 'autopilot-run.sh');

  // Always try all four targets — the user might have run `--install` under
  // one target earlier and moved hosts (e.g. macOS laptop → Linux server).
  // Each path is idempotent (missing files = skip silently).

  let removed = 0;

  // macOS launchd
  if (existsSync(plistPath())) {
    try {
      execSync(`launchctl unload "${plistPath()}" 2>/dev/null || true`, { stdio: 'pipe' });
      unlinkSync(plistPath());
      console.log(`Removed launchd service: ${autopilotLaunchdLabel()}`);
      removed++;
    } catch (e) {
      console.error(`  [warn] launchd: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Linux systemd user unit
  if (existsSync(systemdUnitPath())) {
    try {
      execSync(`systemctl --user disable --now ${AUTOPILOT_SYSTEMD_UNIT} 2>/dev/null || true`, { stdio: 'pipe', timeout: 10_000 });
      unlinkSync(systemdUnitPath());
      try { execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 5_000 }); } catch { /* best-effort */ }
      console.log('Removed systemd user service: gbrain-autopilot.service');
      removed++;
    } catch (e) {
      console.error(`  [warn] systemd: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Ephemeral container start script + bootstrap marker injection
  if (existsSync(ephemeralStartScriptPath())) {
    try {
      unlinkSync(ephemeralStartScriptPath());
      console.log('Removed ephemeral start script: ~/.gbrain/start-autopilot.sh');
      removed++;
    } catch (e) {
      console.error(`  [warn] start script: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Remove marker-line from any OpenClaw bootstrap we previously injected.
  try {
    const { bootstrapCandidates } = detectOpenClaw();
    for (const candidate of bootstrapCandidates) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        if (!content.includes('# gbrain:autopilot v0.11.0')) continue;
        const lines = content.split('\n');
        const cleaned: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('# gbrain:autopilot v0.11.0')) {
            // Skip this marker line AND the next line (the bash start-script call).
            i++;
            continue;
          }
          cleaned.push(lines[i]);
        }
        // Backup before edit
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        writeFileSync(`${candidate}.bak.${stamp}`, content);
        writeFileSync(candidate, cleaned.join('\n'));
        console.log(`Removed bootstrap marker from: ${candidate}`);
        removed++;
      } catch (e) {
        console.error(`  [warn] bootstrap ${candidate}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch { /* OpenClaw detection best-effort */ }

  // Linux crontab (don't gate on platform — the user may have run `--install
  // --target linux-cron` on a different machine that now has the crontab).
  try {
    const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
    if (existing.includes('gbrain autopilot') || existing.includes('autopilot-run.sh')) {
      const filtered = existing.split('\n').filter(l =>
        !l.includes('gbrain autopilot') && !l.includes('autopilot-run.sh'),
      ).join('\n');
      const tmpFile = join(home, '.gbrain', 'crontab.tmp');
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(tmpFile, filtered);
      execSync(`crontab '${tmpFile.replace(/'/g, "'\\''")}' 2>/dev/null || true`, { stdio: 'pipe' });
      try { unlinkSync(tmpFile); } catch { /* best-effort */ }
      console.log('Removed crontab entry for gbrain autopilot');
      removed++;
    }
  } catch (e) {
    console.error(`  [warn] crontab: ${e instanceof Error ? e.message : e}`);
  }

  // Wrapper script — shared by all targets
  if (existsSync(wrapperPath)) {
    try {
      unlinkSync(wrapperPath);
    } catch { /* best-effort */ }
  }

  if (removed === 0) {
    console.log('No autopilot install found on this host. Nothing to uninstall.');
  }

  // A deliberate uninstall ends the disabled/paused story: without this, a
  // self-disabled install that is then uninstalled keeps reporting
  // "DISABLED — repo path gone" with exit 2 forever on a machine with nothing
  // installed ('disabled' outranks 'not_installed' in the classifier).
  try { unlinkSync(autopilotDisabledMarkerPath()); } catch { /* not present */ }
  try { unlinkSync(autopilotPausedMarkerPath()); } catch { /* not present */ }
}

/**
 * The daemon's view of WHICH engine the file-plane config points at. Pure and
 * deliberately narrow: only the fields an engine migration flips participate,
 * so unrelated config edits (models, search knobs, spend gates) never trigger
 * a restart. Compared at boot vs every tick by the daemon loop.
 */
export function autopilotEngineIdentity(
  cfg: { engine?: string; database_url?: string; database_path?: string } | null,
): string {
  return JSON.stringify({
    engine: cfg?.engine ?? 'pglite',
    url: cfg?.database_url ?? null,
    path: cfg?.database_path ?? null,
  });
}

export type AutopilotState = 'not_installed' | 'disabled' | 'paused' | 'never_run' | 'stale' | 'fresh';

export interface AutopilotStatusReport {
  installed: boolean;
  install_target: InstallTarget | null;
  state: AutopilotState;
  disabled_reason: string | null;
  paused_reason: string | null;
  heartbeat_age_seconds: number | null;
  stale_after_seconds: number;
  last_log: string;
}

/**
 * Exit codes for `gbrain autopilot --status`, so cron and CI can gate on it.
 *   0 — fresh, or nothing installed (nothing claimed, nothing broken)
 *   1 — installed but not syncing (stale heartbeat, never ran, or parked on a
 *       cooperative pause marker — a live migrate, or one that died without
 *       cleaning up; either way the brain is not being kept current)
 *   2 — the daemon took itself out of rotation (repo gone)
 */
export function autopilotStatusExitCode(state: AutopilotState): number {
  if (state === 'disabled') return 2;
  if (state === 'stale' || state === 'never_run' || state === 'paused') return 1;
  return 0;
}

/**
 * Pure classifier so the tri-state is testable without an installed daemon.
 *
 * The heartbeat is the lock mtime, which the tick loop already refreshes every
 * pass (`utimesSync(lockPath, ...)`). Deliberately NOT a new artifact: a second
 * one could disagree with the first, and a daemon still running a pre-upgrade
 * binary would never write it, so a healthy install would report stale until it
 * happened to relaunch.
 */
export function classifyAutopilotStatus(input: {
  installed: boolean;
  installTarget: InstallTarget | null;
  disabledReason: string | null;
  pausedReason?: string | null;
  heartbeatAgeSeconds: number | null;
  intervalSeconds: number;
  lastLog: string;
}): AutopilotStatusReport {
  // Tolerance = 6 intervals. The adaptive scheduler sleeps TWO intervals
  // between ticks on the healthiest brains (score >= 90), and the heartbeat
  // only refreshes at tick top — so a healthy gap is cycle_duration + 2x
  // interval, and a 3x tolerance would flap 'stale' exit-1 alarms on exactly
  // the installs doing best. 6x still catches the dead-daemon incident in
  // 30 minutes at the default interval instead of 71 days. A non-finite or
  // non-positive interval (a typo'd flag upstream) would make staleAfter NaN
  // and every age comparison false — reading a long-dead daemon as 'fresh' —
  // so the pure layer defends itself too.
  const staleAfter = Number.isFinite(input.intervalSeconds) && input.intervalSeconds > 0
    ? input.intervalSeconds * 6
    : 1800;
  const pausedReason = input.pausedReason ?? null;
  let state: AutopilotState;
  if (input.disabledReason !== null) state = 'disabled';
  else if (!input.installed) state = 'not_installed';
  // Paused outranks the heartbeat states: the tick loop refreshes its
  // heartbeat BEFORE honoring the pause marker, so a parked daemon looks
  // 'fresh' by mtime while doing no work. Without this state a pause marker
  // orphaned by a dead migrate is invisible — the daemon idles forever and
  // status swears everything is fine (the 71-day incident's shape again).
  else if (pausedReason !== null) state = 'paused';
  else if (input.heartbeatAgeSeconds === null) state = 'never_run';
  else state = input.heartbeatAgeSeconds > staleAfter ? 'stale' : 'fresh';

  return {
    installed: input.installed,
    install_target: input.installTarget,
    state,
    disabled_reason: input.disabledReason,
    paused_reason: pausedReason,
    heartbeat_age_seconds: input.heartbeatAgeSeconds,
    stale_after_seconds: staleAfter,
    last_log: input.lastLog,
  };
}

/**
 * Which supervisor, if any, currently holds an autopilot install.
 *
 * Checks every target `installDaemon` can produce. The prior version grepped
 * crontab ONLY on non-darwin, so systemd-user and ephemeral-container installs
 * read as "not installed" — cosmetic while status always exited 0, but a hard
 * false failure once the exit code became load-bearing.
 */
function detectInstalledTarget(): InstallTarget | null {
  if (process.platform === 'darwin' && existsSync(plistPath())) return 'macos';
  if (existsSync(systemdUnitPath())) return 'linux-systemd';
  if (existsSync(join(gbrainHomePath(), 'start-autopilot.sh'))) return 'ephemeral-container';
  try {
    const crontab = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
    if (crontabIndicatesAutopilotInstall(crontab)) {
      return 'linux-cron';
    }
  } catch { /* no crontab */ }
  return null;
}

/**
 * Does this crontab contain an autopilot INSTALL line? The installed line
 * invokes the generated wrapper (autopilot-run.sh); older installs called
 * `gbrain autopilot` directly — match either. But the docs also recommend
 * cron-ing `gbrain autopilot --status` as a health monitor, and counting THAT
 * line as an install makes a monitor-only machine report installed/never_run
 * with exit 1 forever. Comments never count. Pure and exported for tests.
 */
export function crontabIndicatesAutopilotInstall(crontab: string): boolean {
  return crontab.split('\n').some((line) => {
    if (line.trimStart().startsWith('#')) return false;
    if (line.includes('autopilot-run.sh')) return true;
    return line.includes('gbrain autopilot') && !line.includes('--status');
  });
}

function showStatus(json: boolean, intervalSeconds: number) {
  // gbrainHomePath, not raw HOME: the daemon writes its lock through
  // gbrainHomePath() (#1226), so a GBRAIN_HOME install had status reading one
  // directory while the daemon wrote another — a permanent false "stale".
  const home = gbrainHomePath();
  let lastLine = '';
  for (const logPath of [join(home, 'autopilot.log'), join(process.env.HOME || '', '.gbrain', 'autopilot.log')]) {
    try {
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      lastLine = lines[lines.length - 1] || '';
      break;
    } catch { /* try the next home; supervisor log redirects bake raw $HOME */ }
  }

  let disabledReason: string | null = null;
  try {
    disabledReason = readFileSync(autopilotDisabledMarkerPath(), 'utf-8').trim() || null;
  } catch { /* not self-disabled */ }

  let pausedReason: string | null = null;
  try {
    pausedReason = readFileSync(autopilotPausedMarkerPath(), 'utf-8').trim() || 'pause marker present (no reason recorded)';
  } catch { /* not paused */ }

  let heartbeatAgeSeconds: number | null = null;
  try {
    const { mtimeMs } = statSync(autopilotLockPath());
    heartbeatAgeSeconds = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  } catch { /* never ran, or already cleaned up */ }

  const installTarget = detectInstalledTarget();
  const report = classifyAutopilotStatus({
    installed: installTarget !== null,
    installTarget,
    disabledReason,
    pausedReason,
    heartbeatAgeSeconds,
    intervalSeconds,
    lastLog: lastLine,
  });

  if (json) {
    console.log(JSON.stringify(report));
  } else {
    switch (report.state) {
      case 'not_installed':
        console.log('Autopilot: not installed. Install with `gbrain autopilot --install`.');
        break;
      case 'disabled':
        console.log(`Autopilot: DISABLED — ${report.disabled_reason}`);
        console.log('  It stopped itself. Fix the path, then `gbrain autopilot --install --repo <path>`.');
        break;
      case 'paused':
        console.log(`Autopilot: PAUSED — ${report.paused_reason}`);
        console.log('  A pause marker is parked at ' + autopilotPausedMarkerPath() + '.');
        console.log('  Normal while `gbrain migrate` runs. A marker orphaned by a dead migration');
        console.log('  clears itself on the daemon\'s next poll; only remove it by hand if the');
        console.log('  pid it names is dead and no daemon is running to clean it up.');
        break;
      case 'never_run':
        console.log(`Autopilot: installed (${report.install_target}) but has NEVER run.`);
        break;
      case 'stale':
        console.log(
          `Autopilot: installed (${report.install_target}) but NOT ticking — last heartbeat ` +
          `${report.heartbeat_age_seconds}s ago (stale after ${report.stale_after_seconds}s).`,
        );
        break;
      case 'fresh':
        console.log(
          `Autopilot: running (${report.install_target}) — last heartbeat ` +
          `${report.heartbeat_age_seconds}s ago.`,
        );
        break;
    }
    if (lastLine) console.log(`Last log: ${lastLine}`);
  }

  setCliExitVerdict(autopilotStatusExitCode(report.state));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
