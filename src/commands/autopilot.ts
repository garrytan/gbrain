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

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, chmodSync, statSync } from 'fs';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { detectExecutionEnvironment } from '../core/execution-env.ts';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'path';
import { execSync } from '../core/spawn.ts';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, saveConfig, gbrainPath as gbrainHomePath } from '../core/config.ts';
import {
  classifyAutopilotLockHolder,
  type AutopilotLockProbeDeps,
  isPidAlive,
} from '../core/autopilot-lock.ts';
import { OwnerProcessingState, readAutopilotProcessingStatus } from '../core/minions/processing-state.ts';
import { VERSION } from '../version.ts';
import {
  canSelfUpdate,
  decideSelfUpgrade,
  gateOnTargetRuntime,
  isCacheFresh,
  readUpdateCache,
  reconcileBreadcrumb,
  resolveQuietHoursWindow,
  resolveSelfUpgradeMode,
} from '../core/self-upgrade.ts';
import { logSelfUpgrade } from '../core/audit/self-upgrade-audit.ts';
import { BUN_FLOOR_EXIT_CODE, BUN_FLOOR_FIX, readHostBun } from '../core/bun-floor.ts';
import { detectInstallMethod, readInstallTargetFloor } from './upgrade.ts';
import { evaluateQuietHours } from '../core/minions/quiet-hours.ts';
import { inspectLock } from '../core/db-lock.ts';
import { relativeSourceLocalPathSkipWarning } from '../core/sources-load.ts';
// Path helpers live in a LEAF core module so other commands (gbrain migrate)
// can read the daemon's state files without importing this one — a dynamic
// import of a command module drags its whole flag surface into the importer's
// CLI allowlist. Re-exported here so existing importers keep working.
import {
  autopilotLockPath,
  autopilotDisabledMarkerPath,
  autopilotPausedMarkerPath,
  autopilotPauseReason,
  autopilotDisableStrikesPath,
  autopilotLaunchdLabel,
  autopilotWrapperOwner,
  resolveAutopilotJob,
  DEFAULT_AUTOPILOT_SYSTEMD_UNIT,
  type AutopilotJob,
} from '../core/autopilot-paths.ts';
import {
  BOOTSTRAP_MARKER,
  brainCommand,
  cronLineBelongsToBrain,
  crontabIndicatesAutopilotInstall,
  autopilotJobStatus,
  detectOpenClaw,
  legacyStartScriptPath,
  plistPath,
  plistWrapperPath,
  readIfExists,
  refuseForeignJob,
  replaceLegacySharedJob,
  scriptWrapperPath,
  shellQuote,
  stripBootstrapLines,
  systemdUnitPath,
  unitWrapperPath,
} from './autopilot/jobs.ts';
import { autopilotInstallConsent, renderInstallDryRun } from './autopilot/install-consent.ts';
export { cronLineBelongsToBrain, crontabIndicatesAutopilotInstall, plistWrapperPath, scriptWrapperPath, unitWrapperPath };
export { autopilotLockPath, autopilotDisabledMarkerPath, autopilotPausedMarkerPath, autopilotLaunchdLabel };
export { relativeSourceLocalPathSkipWarning as relativeLocalPathSkipWarning };

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

export function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export function logError(phase: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const ts = new Date().toISOString().slice(0, 19);
  const line = `[${ts}] [${phase}] ERROR: ${msg}`;
  console.error(line);
  try {
    const logDir = gbrainHomePath();
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
 * gate). If we're running the version we attempted or a newer one, the
 * swap+relaunch worked; if not, the new binary failed to launch and we record
 * it as a known-bad version so the auto channel never retries it. Best-effort.
 */
export function reconcileSelfUpgradeAtBoot(): void {
  try {
    const cfg = loadConfig();
    if (!cfg) return;
    const attempted = cfg.self_upgrade?.attempting_version;
    const { state, transition } = reconcileBreadcrumb(cfg.self_upgrade, VERSION);
    if (!transition) return;
    cfg.self_upgrade = state;
    saveConfig(cfg);
    logSelfUpgrade({
      channel: 'autopilot',
      action: 'apply',
      current: VERSION,
      latest: attempted,
      outcome: transition === 'applied' ? 'applied' : 'failed',
      reason:
        transition === 'applied'
          ? 'running version is at or past the attempted version'
          : 'crash-on-launch: running version is not at or past the attempted version (recorded known-bad)',
    });
    if (transition === 'applied') {
      console.log(`[autopilot] self-upgrade confirmed: attempted ${attempted}, now running ${VERSION}.`);
    } else {
      console.error(`[autopilot] self-upgrade did not take: attempted ${attempted}, still running ${VERSION}; recorded ${attempted} known-bad.`);
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

export function guardAutopilotEngine(engine: BrainEngine, state: OwnerProcessingState): BrainEngine {
  const refuse = (): never => {
    throw new Error('Autopilot processing is configuration-blocked; repair and restart the owner.');
  };
  return new Proxy(engine, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (property !== 'disconnect' && state.blocked) refuse();
        if (property === 'transaction' || property === 'transactionDirect') {
          const fn = args[0] as (tx: BrainEngine) => Promise<unknown>;
          return Reflect.apply(value, target, [async (tx: BrainEngine) => {
            const result = await fn(guardAutopilotEngine(tx, state));
            if (state.blocked) refuse();
            return result;
          }]);
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/**
 * The autopilot silent self-upgrade channel. Opt-in (`self_upgrade.mode=auto`).
 * Fires only when behind + idle + in quiet hours + the install can self-update
 * and the target isn't known-bad. On apply: write the breadcrumb, run
 * `gbrain upgrade --swap-only` (fast; defers post-upgrade to the relaunch),
 * then unlink the autopilot lock and exit(0) so the supervisor relaunches the
 * new binary (no in-process re-exec — Bun has no execve). Never throws.
 */
export async function attemptAutopilotSelfUpgrade(
  engine: BrainEngine,
  engineType: string,
  lockPath: string,
  mayContinue: () => boolean = () => true,
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
    const verdict = evaluateQuietHours(resolveQuietHoursWindow(cfg.self_upgrade?.quiet_hours), new Date());
    const installMethod = detectInstallMethod();

    let decision = decideSelfUpgrade({
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
    // #5855: never swap in a release the host's Bun cannot start (a binary carries its own Bun).
    if (decision.action === 'apply' && installMethod !== 'binary') {
      decision = gateOnTargetRuntime(decision, await readInstallTargetFloor(installMethod), readHostBun());
    }

    if (decision.action !== 'apply') {
      if (['unsupported_install', 'known_bad', 'unsupported_runtime'].includes(decision.action)) {
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

    if (!mayContinue()) return;
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
      // #5855: the swap's own floor re-check refused; hold, never known-bad.
      const held = (e as { status?: number }).status === BUN_FLOOR_EXIT_CODE;
      if (fresh) {
        const failed = new Set(fresh.self_upgrade?.failed_versions ?? []);
        if (!held) failed.add(latestVersion);
        fresh.self_upgrade = { ...(fresh.self_upgrade ?? {}), failed_versions: [...failed] };
        delete fresh.self_upgrade.attempting_version;
        saveConfig(fresh);
      }
      logSelfUpgrade(held
        ? { channel: 'autopilot', action: 'unsupported_runtime', current: VERSION, latest: latestVersion, outcome: 'skipped', reason: `gbrain upgrade refused the swap: the Bun floor of ${latestVersion} is not met or unreadable. ${BUN_FLOOR_FIX}` }
        : { channel: 'autopilot', action: 'apply', current: VERSION, latest: latestVersion, outcome: 'failed', error: e instanceof Error ? e.message : String(e) });
      console.error(`[autopilot] self-upgrade swap failed; staying on ${VERSION}.`);
      return;
    }

    if (!mayContinue()) return;
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
const AUTOPILOT_VALUE_FLAGS = new Set(['--repo', '--interval', '--target', '--reason']);

/** Positional spellings → their canonical flags. A Map (not a plain object)
 * so prototype-chain words like `constructor` stay unknown positionals. */
const AUTOPILOT_POSITIONAL_ALIASES = new Map<string, string>([
  ['status', '--status'],
  ['install', '--install'],
  ['uninstall', '--uninstall'],
  ['pause', '--pause'],
  ['resume', '--resume'],
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
      `Unknown autopilot argument '${a}'. Expected one of: status, install, uninstall, pause, resume, start, help.\n` +
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

/**
 * `gbrain autopilot` mode flags, checked in order (first match wins, the
 * precedence of the old if-chain). No mode flag runs the daemon.
 */
const AUTOPILOT_MODES: Array<{ flags: string[]; run: (engine: BrainEngine, args: string[]) => unknown }> = [
  { flags: ['--install'], run: async (engine, args) => { await installDaemon(engine, args); } },
  { flags: ['--uninstall'], run: () => { uninstallDaemon(); } },
  { flags: ['--status'], run: (_engine, args) => { runAutopilotStatus(args); } },
  { flags: ['--pause', '--resume'], run: async (_engine, args) => (await import('./autopilot-pause.ts')).runAutopilotPauseCommand(args) },
];

export async function runAutopilot(engine: BrainEngine, args: string[]) {
  args = resolveAutopilotPositionals(args);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: gbrain autopilot [--repo <path>] [--interval N] [--json] [--no-worker]\n' +
      '       gbrain autopilot --install [--repo <path>]\n' +
      '       gbrain autopilot --uninstall\n' +
      '       gbrain autopilot --status [--json]\n' +
      '       gbrain autopilot pause [--reason <text>] | resume   (operator hold; upgrade and --install keep it)\n\n' +
      'Self-maintaining brain daemon. Runs the full maintenance cycle\n' +
      '(lint + backlinks + sync + extract + embed + orphans) on an interval.\n\n' +
      'For a one-shot cron-triggered cycle, see `gbrain dream`.',
    );
    return;
  }

  const mode = AUTOPILOT_MODES.find((m) => m.flags.some((f) => args.includes(f)));
  if (mode) return mode.run(engine, args);
  return (await import('./autopilot-daemon.ts')).runAutopilotDaemon(engine, args);
}

// --- Install/Uninstall ---

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

/** systemd unit name. The launchd label lives in `autopilotLaunchdLabel()`
 *  (core/autopilot-paths.ts) so installer, uninstaller, status, and the
 *  wrapper's self-disable can never name different jobs. */
export const AUTOPILOT_SYSTEMD_UNIT = DEFAULT_AUTOPILOT_SYSTEMD_UNIT;


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
export function generateSelfDisableGuard(repoPath: string, target: InstallTarget, job: AutopilotJob = resolveAutopilotJob()): string {
  const q = (s: string) => s.replace(/'/g, "'\\''");
  const marker = autopilotDisabledMarkerPath();
  const disableCmd =
    target === 'macos'
      ? `  launchctl bootout "gui/$(id -u)/${job.launchdLabel}" 2>/dev/null || true\n`
      : target === 'linux-systemd'
        ? `  systemctl --user disable --now ${job.systemdUnit} 2>/dev/null || true\n`
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

export function writeWrapperScript(repoPath: string, target: InstallTarget, job: AutopilotJob = resolveAutopilotJob()): string {
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
${generateSelfDisableGuard(repoPath, target, job)}# #3696: daemon cwd = the repo, so any legacy RELATIVE sources.local_path /
# sync.repo_path row resolves against it instead of a phantom path under the
# supervisor's cwd. Done HERE — after the guard has proven the repo exists —
# and NOT via launchd's plist WorkingDirectory: launchd chdir()s before exec,
# so a deleted repo would fail every respawn and the self-disable guard above
# could never run. Fail-open (|| true): a repo deleted between the guard and
# this line still starts the daemon, and the dispatch loops skip relative
# paths loudly.
cd '${safeRepoPath}' 2>/dev/null || true
# #4728: the CLI path below was resolved ONCE at --install. On the
# ephemeral-container target the container layer is wiped on every deploy, so
# a CLI that lived there vanishes while this wrapper (on the volume) survives,
# and bash's bare "No such file or directory" named no remedy. The baked path
# stays primary; only once it is gone do we fall back to PATH — the same
# resolution the daemon already applies at run time when it spawns its worker
# child (resolveGbrainCliPath -> which gbrain), so this adds no lookup
# semantics the install did not already rely on. \`type -P\` only returns an
# executable file on PATH, ignoring any \`gbrain\` shell function or alias the
# rc files sourced above may have defined. Logs go to stdout: that is the
# autopilot.log sink on all four targets (same choice as the boot warning).
if [ ! -x '${safeGbrainPath}' ]; then
  _resolved=$(type -P gbrain 2>/dev/null)
  if [ -n "$_resolved" ]; then
    echo "$(date -u +%FT%TZ) [autopilot] baked CLI path is gone:" '${safeGbrainPath}' "- using $_resolved"
    exec "$_resolved" autopilot --repo '${safeRepoPath}'
  fi
  echo "$(date -u +%FT%TZ) [autopilot] gbrain CLI not found at" '${safeGbrainPath}' "nor on PATH; re-run: gbrain autopilot --install"
  exit 1
fi
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

  // #5195: every name this brain's job uses (minting the install id on a
  // non-default brain's first install), and a refusal before anything is
  // written when the job under that name runs another live brain.
  const job = resolveAutopilotJob({ mint: true });
  try {
    if (target === 'macos') refuseForeignJob(job.launchdLabel, plistWrapperPath(readIfExists(plistPath(job.launchdLabel)) ?? ''), job);
    if (target === 'linux-systemd') refuseForeignJob(job.systemdUnit, unitWrapperPath(readIfExists(systemdUnitPath(job.systemdUnit)) ?? ''), job);
    if (target === 'ephemeral-container') refuseForeignJob(job.startScriptPath, scriptWrapperPath(readIfExists(job.startScriptPath) ?? ''), job);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  if (args.includes('--dry-run')) { console.log(renderInstallDryRun({ target, repoPath, job })); return; }
  if (!await autopilotInstallConsent(engine, args, { target, repoPath, job })) return;
  const wrapperPath = writeWrapperScript(repoPath, target, job);
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
      installLaunchd(wrapperPath, home, repoPath, job);
      break;
    case 'linux-systemd':
      installSystemd(wrapperPath, repoPath, job);
      break;
    case 'ephemeral-container':
      installEphemeralContainer(wrapperPath, home, repoPath, { injectBootstrap, noInject }, job);
      break;
    case 'linux-cron':
      installCrontab(wrapperPath, home, job);
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
export function generateLaunchdPlist(wrapperPath: string, home: string, job?: AutopilotJob): string {
  const logPath = job?.logPath ?? `${home}/.gbrain/autopilot.log`;
  const errPath = job?.errPath ?? `${home}/.gbrain/autopilot.err`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(job?.launchdLabel ?? autopilotLaunchdLabel())}</string>
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
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(errPath)}</string>
</dict>
</plist>`;
}

function installLaunchd(wrapperPath: string, home: string, repoPath: string, job: AutopilotJob) {
  const plist = generateLaunchdPlist(wrapperPath, home, job);

  try {
    const agentsDir = join(home, 'Library', 'LaunchAgents');
    mkdirSync(agentsDir, { recursive: true });
    replaceLegacySharedJob(job, 'macos');
    writeFileSync(plistPath(job.launchdLabel), plist, { mode: 0o644 });
    // launchd rejects group/world-writable agent plists: bootstrap/load fails
    // with the opaque "Bootstrap failed: 5: Input/output error" and the login
    // scan skips the file silently. writeFileSync's mode only applies on
    // create — a reinstall over an existing plist keeps the old bits (a 0666
    // plist written under an umask-0 parent stays 0666 forever) — so
    // normalize unconditionally.
    chmodSync(plistPath(job.launchdLabel), 0o644);
    // Unload-before-load (same pattern as uninstall): bare `launchctl load`
    // on an already-loaded agent errors and aborted every reinstall — and a
    // running daemon must be relaunched anyway to pick up a regenerated
    // wrapper / env file (#2608: the boot warning tells users to re-run
    // --install to reload; this line is what makes that true on macOS).
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- launchdLabel comes from autopilotLaunchdLabel(), which rejects anything outside [A-Za-z0-9._-] and '..'; trusted local CLI only
    execSync(`launchctl unload "${plistPath(job.launchdLabel)}" 2>/dev/null || true`, { stdio: 'pipe' });
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- same grammar-checked label
    execSync(`launchctl load "${plistPath(job.launchdLabel)}"`, { stdio: 'pipe' });
    console.log(`Installed launchd service: ${job.launchdLabel}`);
    console.log(`  Repo: ${repoPath}`);
    console.log(`  Log: ${job.logPath}`);
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
export function generateSystemdUnit(wrapperPath: string, job?: AutopilotJob): string {
  const logPath = job && job.kind !== 'default' ? job.logPath : '%h/.gbrain/autopilot.log';
  const errPath = job && job.kind !== 'default' ? job.errPath : '%h/.gbrain/autopilot.err';
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
StandardOutput=append:${logPath}
StandardError=append:${errPath}

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

function installSystemd(wrapperPath: string, repoPath: string, job: AutopilotJob) {
  const unit = generateSystemdUnit(wrapperPath, job);
  try {
    const unitPath = systemdUnitPath(job.systemdUnit);
    mkdirSync(join(process.env.HOME || '', '.config', 'systemd', 'user'), { recursive: true });
    replaceLegacySharedJob(job, 'linux-systemd');
    writeFileSync(unitPath, unit, { mode: 0o644 });
    // Same umask-0 hardening as the launchd path (systemd warns on
    // world-writable units); mode only applies on create, so normalize.
    chmodSync(unitPath, 0o644);
    execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 10_000 });
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- systemdUnit is a constant or gbrain-autopilot-<8 hex chars>.service from the install id; trusted local CLI only
    execSync(`systemctl --user enable --now ${job.systemdUnit}`, { stdio: 'pipe', timeout: 15_000 });
    // enable --now does NOT restart an already-active unit, so a reinstall
    // over a running daemon would keep the old process (and its stale env)
    // alive indefinitely (#2608: the boot warning tells users to re-run
    // --install to reload; this line is what makes that true on systemd).
    // try-restart only bounces a running unit — a fresh install just started
    // above is restarted at worst, never left stopped.
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- same derived unit name
    execSync(`systemctl --user try-restart ${job.systemdUnit}`, { stdio: 'pipe', timeout: 15_000 });
    console.log(`Installed systemd user service: ${job.systemdUnit}`);
    console.log(`  Repo: ${repoPath}`);
    console.log(`  Log: ${job.logPath}`);
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
  job: AutopilotJob,
) {
  // Write a start script the agent's bootstrap can source on every container start.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- homeDir is configDir() of the local operator's own brain
  const pidPath = join(job.homeDir, 'autopilot.pid');
  const script = `#!/bin/bash
# Auto-generated by gbrain autopilot --install (ephemeral-container target)
# Ephemeral filesystems lose crontab on every deploy; source this from
# your agent's bootstrap instead.
nohup ${shellQuote(wrapperPath)} > ${shellQuote(job.logPath)} 2>&1 &
echo \$! > ${shellQuote(pidPath)}
`;
  const scriptPath = job.startScriptPath;
  mkdirSync(job.homeDir, { recursive: true });
  replaceLegacySharedJob(job, 'ephemeral-container');
  writeFileSync(scriptPath, script, { mode: 0o755 });

  console.log('Ephemeral container detected (Render / Railway / Fly / Docker).');
  console.log(`Repo: ${repoPath}`);
  console.log(`Start script: ${scriptPath}`);
  // Rewriting the start script cannot reload an autopilot already launched
  // from it — that process keeps its old environment until the container
  // restarts. Never auto-kill; say how (#2608, same honesty as the cron path).
  console.log('  An already-running autopilot keeps its old environment until the container');
  console.log(`  restarts (or: kill $(cat ${shellQuote(pidPath)}), then re-run the start script).`);
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
        const marker = BOOTSTRAP_MARKER;
        if (existing.includes(`${marker}\nbash ${scriptPath}`)) {
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

function installCrontab(wrapperPath: string, home: string, job: AutopilotJob) {
  // Linux/WSL without systemd — crontab runs the wrapper every 5 minutes.
  // #5195: a non-default brain's line carries its marker; the default brain's
  // line is unchanged.
  const cronLine = `*/5 * * * * ${shellQuote(wrapperPath)} >> ${shellQuote(job.logPath)} 2>&1${job.cronMarker ? ` ${job.cronMarker}` : ''}`;
  try {
    let existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
    // A line of this brain is stale when it predates the brain's marker (a
    // pre-#5195 shared line) or runs a wrapper that is not this brain's
    // current one (the brain moved): either is replaced, never duplicated.
    const ownLines = existing.split('\n').filter(l => cronLineBelongsToBrain(l, job));
    const staleLines = ownLines.filter(l =>
      (job.cronMarker !== null && !l.includes(job.cronMarker)) || (scriptWrapperPath(l) !== null && scriptWrapperPath(l) !== wrapperPath));
    if (staleLines.length > 0) {
      existing = existing.split('\n').filter(l => !staleLines.includes(l)).join('\n');
      console.log(`Replacing ${staleLines.length} crontab line(s) that ran this brain from an older install with its current line.`);
    } else if (ownLines.length > 0) {
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
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- homeDir is configDir() of the local operator's own brain
    const tmpFile = join(job.homeDir, 'crontab.tmp');
    mkdirSync(job.homeDir, { recursive: true });
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
  // #5195: only this brain's job is removed — its own named job (checked to
  // run this brain's wrapper before removal), plus, for a non-default brain,
  // a pre-#5195 shared-name job whose wrapper names this brain. A shared job
  // that runs another live brain is left alone and named.
  const job = resolveAutopilotJob();
  const wrapperPath = job.wrapperPath;
  const ownsDefinition = (name: string, wrapper: string | null): boolean => {
    const owner = autopilotWrapperOwner(wrapper, job.homeDir);
    if (owner.owner !== 'other') return true;
    console.log(`Left ${name} in place: it runs the brain at ${owner.home}. To remove it: ${brainCommand(owner.home, '--uninstall')}`);
    return false;
  };
  const legacyOnly = (wrapper: string | null) => autopilotWrapperOwner(wrapper, job.homeDir).owner === 'own';
  const assigned = job.kind !== 'unassigned';

  // Always try all four targets — the user might have run `--install` under
  // one target earlier and moved hosts (e.g. macOS laptop → Linux server).
  // Each path is idempotent (missing files = skip silently).

  let removed = 0;

  // macOS launchd
  const labels: Array<{ label: string; legacy: boolean }> = [];
  if (assigned) labels.push({ label: job.launchdLabel, legacy: false });
  if (job.kind !== 'default' && (!assigned || autopilotLaunchdLabel(null) !== job.launchdLabel)) labels.push({ label: autopilotLaunchdLabel(null), legacy: true });
  for (const { label, legacy } of labels) {
    const path = plistPath(label);
    if (!existsSync(path)) continue;
    const wrapper = plistWrapperPath(readIfExists(path) ?? '');
    if (legacy ? !legacyOnly(wrapper) : !ownsDefinition(label, wrapper)) continue;
    try {
      execSync(`launchctl unload "${path}" 2>/dev/null || true`, { stdio: 'pipe' });
      unlinkSync(path);
      console.log(`Removed launchd service: ${label}`);
      removed++;
    } catch (e) {
      console.error(`  [warn] launchd: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Linux systemd user unit
  const units: Array<{ unit: string; legacy: boolean }> = [];
  if (assigned) units.push({ unit: job.systemdUnit, legacy: false });
  if (job.kind !== 'default') units.push({ unit: DEFAULT_AUTOPILOT_SYSTEMD_UNIT, legacy: true });
  for (const { unit, legacy } of units) {
    const path = systemdUnitPath(unit);
    if (!existsSync(path)) continue;
    const wrapper = unitWrapperPath(readIfExists(path) ?? '');
    if (legacy ? !legacyOnly(wrapper) : !ownsDefinition(unit, wrapper)) continue;
    try {
      execSync(`systemctl --user disable --now ${unit} 2>/dev/null || true`, { stdio: 'pipe', timeout: 10_000 });
      unlinkSync(path);
      try { execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 5_000 }); } catch { /* best-effort */ }
      console.log(`Removed systemd user service: ${unit}`);
      removed++;
    } catch (e) {
      console.error(`  [warn] systemd: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Ephemeral container start script + bootstrap marker injection
  const scripts: Array<{ path: string; legacy: boolean }> = [];
  if (assigned) scripts.push({ path: job.startScriptPath, legacy: false });
  if (job.kind !== 'default') scripts.push({ path: legacyStartScriptPath(), legacy: true });
  for (const { path, legacy } of scripts) {
    if (!existsSync(path)) continue;
    const wrapper = scriptWrapperPath(readIfExists(path) ?? '');
    if (legacy ? !legacyOnly(wrapper) : !ownsDefinition(path, wrapper)) continue;
    try {
      unlinkSync(path);
      console.log(`Removed ephemeral start script: ${path}`);
      removed++;
    } catch (e) {
      console.error(`  [warn] start script: ${e instanceof Error ? e.message : e}`);
    }
    // Remove marker-lines from any OpenClaw bootstrap we previously injected.
    removed += stripBootstrapLines(path);
  }

  // Linux crontab (don't gate on platform — the user may have run `--install
  // --target linux-cron` on a different machine that now has the crontab).
  try {
    const existing = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
    const lines = existing.split('\n');
    const filtered = lines.filter(l => !cronLineBelongsToBrain(l, job));
    if (filtered.length !== lines.length) {
      const tmpFile = join(job.homeDir, 'crontab.tmp');
      mkdirSync(job.homeDir, { recursive: true });
      writeFileSync(tmpFile, filtered.join('\n'));
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
    console.log('No autopilot install found for this brain. Nothing to uninstall.');
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

function showStatus(json: boolean, intervalSeconds: number) {
  // gbrainHomePath, not raw HOME: the daemon writes its lock through
  // gbrainHomePath() (#1226), so a GBRAIN_HOME install had status reading one
  // directory while the daemon wrote another — a permanent false "stale".
  // #5195: every log sink writes under the brain's own home, so the log is
  // read only there (a raw-$HOME fallback would show another brain's log).
  const job = resolveAutopilotJob();
  let lastLine = '';
  try {
    const content = readFileSync(job.logPath, 'utf-8');
    const lines = content.trim().split('\n');
    lastLine = lines[lines.length - 1] || '';
  } catch { /* no log yet */ }

  let disabledReason: string | null = null;
  try {
    disabledReason = readFileSync(autopilotDisabledMarkerPath(), 'utf-8').trim() || null;
  } catch { /* not self-disabled */ }

  const pausedReason = autopilotPauseReason();

  let heartbeatAgeSeconds: number | null = null;
  try {
    const { mtimeMs } = statSync(autopilotLockPath());
    heartbeatAgeSeconds = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  } catch { /* never ran, or already cleaned up */ }

  const jobStatus = autopilotJobStatus(job);
  const installTarget = jobStatus.installTarget;
  const report = classifyAutopilotStatus({
    installed: installTarget !== null,
    installTarget,
    disabledReason,
    pausedReason,
    heartbeatAgeSeconds,
    intervalSeconds,
    lastLog: lastLine,
  });
  const processing = readAutopilotProcessingStatus();

  if (json) {
    console.log(JSON.stringify({ ...report, ...processing, job: jobStatus.report }));
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
        if (report.paused_reason?.startsWith('operator pause')) { console.log('  Operator pause on this host. Resume with: gbrain autopilot resume'); break; }
        console.log('  A pause marker is parked at ' + autopilotPausedMarkerPath() + '. Normal while `gbrain migrate` runs. A marker orphaned by a dead migration');
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
    if (processing) {
      console.log(`Processing: ${processing.processing_state}${processing.reason_code ? ` (${processing.reason_code})` : ''}`);
      console.log(`Stage: ${processing.processing_stage}${processing.retry_at ? `; next retry ${processing.retry_at}` : ''}`);
      if (processing.processing_state === 'configuration_blocked') console.log('Repair the worker and selected child installation, then explicitly restart autopilot.');
    }
    for (const line of jobStatus.lines) console.log(line);
    if (lastLine) console.log(`Last log: ${lastLine}`);
  }

  setCliExitVerdict(autopilotStatusExitCode(report.state));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
