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

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, utimesSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { BrainEngine } from '../core/engine.ts';
import { loadPreferences } from '../core/preferences.ts';
import { loadConfig, saveConfig, gbrainPath as gbrainHomePath } from '../core/config.ts';
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
 * Exported (string-based signature) so tests drive it without needing
 * a real reconnect error.
 */
export function classifyReconnectError(err: unknown): 'recoverable' | 'unrecoverable' {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
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
 * Resolve the gbrain CLI entrypoint for spawning the worker child.
 *
 * A .ts source path is never a valid spawn target — spawning it fails with
 * EACCES because TypeScript source isn't executable. The canonical install
 * puts a shim at `/usr/local/bin/gbrain` (or wherever `which gbrain`
 * resolves to) that already wraps the right runtime+entrypoint; prefer it.
 *
 * Order of resolution:
 *   1. `which gbrain` — the shim on PATH, canonical for installed builds.
 *   2. process.execPath if it ends with /gbrain (compiled binary, no shim).
 *   3. argv[1] if it ends with /gbrain (e.g., direct invocation of compiled
 *      binary without PATH). Never .ts source paths.
 *   4. Throw with a clear install hint.
 */
export function resolveGbrainCliPath(): string {
  try {
    const which = execSync('which gbrain', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which) return which;
  } catch { /* not on $PATH — fall through */ }

  const exec = process.execPath ?? '';
  if (exec.endsWith('/gbrain') || exec.endsWith('\\gbrain.exe')) {
    return exec;
  }

  const arg1 = process.argv[1] ?? '';
  if (arg1.endsWith('/gbrain') || arg1.endsWith('\\gbrain.exe')) {
    return arg1;
  }

  throw new Error('Could not resolve the gbrain CLI path. Install gbrain so it is on $PATH (e.g. /usr/local/bin/gbrain), or run autopilot from the compiled binary directly.');
}

export function shouldSpawnAutopilotWorker(args: string[]): boolean {
  return !args.includes('--no-worker');
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

export async function runAutopilot(engine: BrainEngine, args: string[]) {
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
    showStatus(args.includes('--json'));
    return;
  }

  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  const baseInterval = parseInt(parseArg(args, '--interval') || '300', 10);
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
  const lockPath = gbrainHomePath('autopilot.lock');
  try {
    mkdirSync(gbrainHomePath(), { recursive: true });
    if (existsSync(lockPath)) {
      const stat = require('fs').statSync(lockPath);
      const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
      if (ageMinutes < 10) {
        console.error('Another autopilot instance is running (lock file is fresh). Exiting.');
        process.exit(0);
      }
      console.log('Stale lock file found (>10 min). Taking over.');
    }
    writeFileSync(lockPath, String(process.pid));
  } catch { /* best-effort */ }

  console.log(`Autopilot starting. Repo: ${repoPath}, interval: ${baseInterval}s`);

  // Mode resolution: Minions dispatch when the user has opted in AND the
  // worker daemon can actually run (Postgres only; PGLite's exclusive file
  // lock blocks a separate worker process).
  const mode = loadPreferences().minion_mode ?? 'pain_triggered';
  const cfg = loadConfig();
  const engineType = cfg?.engine ?? 'pglite';
  const useMinionsDispatch = mode !== 'off' && engineType === 'postgres' && !forceInline;
  const spawnManagedWorker = useMinionsDispatch && !noWorker;

  // v0.42 self-upgrade: if a prior tick swapped the binary and exited for
  // relaunch, we're now the relaunched process — reconcile the breadcrumb so a
  // crash-on-launch is recorded known-bad and a success is confirmed.
  reconcileSelfUpgradeAtBoot();

  let stopping = false;
  let childSupervisor: ChildWorkerSupervisor | null = null;

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
      args: ['jobs', 'work', '--max-rss', String(autopilotMaxRssMb)],
      // process.env clone; autopilot doesn't gate shell jobs the way the
      // standalone supervisor does (autopilot is the operator-trust path).
      env: { ...process.env },
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
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });

  let consecutiveErrors = 0;
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

  while (!stopping) {
    const cycleStart = Date.now();
    let cycleOk = true;

    // Refresh the lock mtime so another cron-fired autopilot doesn't
    // declare the instance stale after 10 minutes (Codex C).
    try { utimesSync(lockPath, new Date(), new Date()); } catch { /* best-effort */ }

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
        await engine.disconnect();
        await (engine as any).connect?.();
        autopilotReconnectFails = 0;
      } catch (e) {
        logError('reconnect', e);
        autopilotReconnectFails++;
        const klass = classifyReconnectError(e);
        if (klass === 'unrecoverable') {
          console.error(
            `[autopilot] FATAL: unrecoverable DB error (${(e as Error).message ?? 'unknown'}). ` +
            `Exiting so launchd ThrottleInterval can apply backoff.`,
          );
          stopping = true;
          process.exitCode = 1;
          break;
        }
        if (autopilotReconnectFails >= AUTOPILOT_MAX_RECONNECT_FAILS) {
          console.error(
            `[autopilot] FATAL: ${autopilotReconnectFails} consecutive reconnect failures. ` +
            `Last error: ${(e as Error).message ?? 'unknown'}. Exiting.`,
          );
          stopping = true;
          process.exitCode = 1;
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
      //   - Score >= 95 + empty plan: full cycle every 60min (phase-
      //     coupling exercise), otherwise sleep.
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
        const { computeRecommendations, embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG } = await import('../core/brain-score-recommendations.ts');
        const queue = new MinionQueue(engine);
        const slotMs = Math.floor(Date.now() / (baseInterval * 1000)) * baseInterval * 1000;
        const slot = new Date(slotMs).toISOString();
        const timeoutMs = Math.max(baseInterval * 2 * 1000, 300_000);

        // ── v0.40 D17: per-source freshness check ────────────────────
        // Runs first; independent of score gate. Submits a 'sync' job per
        // source whose last_sync_at is older than the interval. The sync
        // handler (T6/T7) auto-enqueues embed-backfill on completion if
        // pages changed.
        try {
          const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
          if (await isFederatedV2Enabled(engine)) {
            const { loadAllSources } = await import('../core/sources-load.ts');
            const sources = await loadAllSources(engine);
            const intervalMs = baseInterval * 1000;
            const now = Date.now();
            for (const src of sources) {
              if (!src.local_path) continue;
              const lastSyncMs = src.last_sync_at ? new Date(src.last_sync_at).getTime() : 0;
              const ageMs = now - lastSyncMs;
              if (ageMs < intervalMs) continue; // fresh enough
              try {
                const job = await queue.add(
                  'sync',
                  {
                    sourceId: src.id,
                    repoPath: src.local_path,
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
                          max_attempts: 1,
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
        const embedKeyCfg: Record<string, string | null> = {};
        for (const field of Object.values(HOSTED_EMBED_KEY_CONFIG)) {
          embedKeyCfg[field] = await engine.getConfig(field);
        }
        const ctx = {
          repoPath,
          embeddingModel,
          embeddingProviderConfigured: embeddingProviderConfigured(embeddingModel, (envVar) => {
            const cfgField = HOSTED_EMBED_KEY_CONFIG[envVar];
            return !!(process.env[envVar] || (cfgField ? embedKeyCfg[cfgField] : undefined));
          }),
          hasChatApiKey: !!(process.env.ANTHROPIC_API_KEY || await engine.getConfig('anthropic_api_key')),
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
        const FULL_CYCLE_FLOOR_MIN = 60;
        const minutesSinceLastFull = (Date.now() - lastFullCycleAt) / 60000;

        const shouldFullCycle =
          (score >= 95 && plan.length === 0 && minutesSinceLastFull >= FULL_CYCLE_FLOOR_MIN) ||
          plan.length > 3 ||
          estTotal >= 300 ||
          score < 70;

        const shouldSleep = score >= 95 && plan.length === 0 && minutesSinceLastFull < FULL_CYCLE_FLOOR_MIN;

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
          const { dispatchPerSource, resolveFanoutMax } = await import('./autopilot-fanout.ts');
          const fanoutMax = await resolveFanoutMax(engine);
          const result = await dispatchPerSource(engine, queue, {
            repoPath,
            slot,
            timeoutMs,
            fanoutMax,
            jsonMode,
          });
          if (result.dispatched.length > 0 || result.legacy_fallback) {
            lastFullCycleAt = Date.now();
          }
          if (jsonMode) {
            process.stderr.write(JSON.stringify({
              event: 'fanout_summary',
              dispatched: result.dispatched,
              skipped_fresh: result.skipped_fresh,
              skipped_cap: result.skipped_cap,
              legacy_fallback: result.legacy_fallback,
              fanout_max: fanoutMax,
              score,
            }) + '\n');
          } else if (!result.legacy_fallback) {
            console.log(
              `[dispatch] fanout: ${result.dispatched.length} dispatched, ` +
              `${result.skipped_fresh.length} fresh, ${result.skipped_cap.length} capped ` +
              `(score=${score}, max=${fanoutMax})`,
            );
          }
        } else {
          // Small targeted plan — submit individual handlers per step.
          // D9 content-hash idempotency keys (from computeRecommendations).
          // maxWaiting:1 per submit per codex #17 (closes the backpressure
          // gap the prior implementation had for targeted submits).
          for (const step of plan) {
            try {
              const isProtected = !!step.protected;
              const submitOpts = {
                queue: 'default',
                idempotency_key: step.idempotency_key,
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
              if (jsonMode) {
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
        const report = await runCycle(engine, {
          brainDir: repoPath,
          // Autopilot daemon path: pulls by default (matches
          // pre-v0.17 autopilot behavior). CLI dream defaults false
          // for cron safety; that choice is scoped to dream only.
          pull: true,
          yieldBetweenPhases: async () => {
            await new Promise(r => setImmediate(r));
          },
        });
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
      const probeEnabled = cfg?.autopilot?.nightly_quality_probe?.enabled === true;
      if (probeEnabled) {
        const { runNightlyQualityProbe } = await import('../core/cycle/nightly-quality-probe.ts');
        const { runLongMemEvalForProbe, runCrossModalBatchForProbe } = await import('../core/cycle/nightly-probe-adapters.ts');
        const { isAvailable } = await import('../core/ai/gateway.ts');
        const maxUsd = Number(cfg?.autopilot?.nightly_quality_probe?.max_usd ?? 5);
        await runNightlyQualityProbe({
          isEnabled: () => true, // already gated above; phase re-checks for defense-in-depth
          hasEmbeddingProvider: () => isAvailable('embedding'),
          resolveMaxUsd: () => maxUsd,
          resolveRepoRoot: () => repoPath ?? gbrainHomePath('.'),
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

    // Wait for next cycle
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

// --- Install/Uninstall ---

function plistPath(): string {
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.gbrain.autopilot.plist');
}

function systemdUnitPath(): string {
  return join(process.env.HOME || '', '.config', 'systemd', 'user', 'gbrain-autopilot.service');
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

  const ephemeral = !!(
    process.env.RENDER
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.FLY_APP_NAME
    || existsSync('/.dockerenv')
  );
  if (ephemeral) return 'ephemeral-container';

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

function writeWrapperScript(repoPath: string): string {
  const home = process.env.HOME || '';
  const gbrainDir = join(home, '.gbrain');
  mkdirSync(gbrainDir, { recursive: true });

  // Wrapper sources the user's shell profile for API keys so nothing is
  // baked into plist/crontab/systemd unit files (#2).
  const wrapperPath = join(gbrainDir, 'autopilot-run.sh');
  const gbrainPath = resolveGbrainCliPath();
  const safeRepoPath = repoPath.replace(/'/g, "'\\''");
  const safeGbrainPath = gbrainPath.replace(/'/g, "'\\''");
  const wrapper = `#!/bin/bash
# Auto-generated by gbrain autopilot --install
# Sources shell profile for API keys, then runs autopilot.
# zshenv is the canonical place for env vars in zsh on macOS (zshrc is for
# interactive shells only — vars defined there don't reach this non-interactive
# subprocess). Source it first so secrets like GBRAIN_DATABASE_URL or any
# OPENAI/ANTHROPIC keys exported in zshenv reach autopilot.
[ -f ~/.zshenv ] && source ~/.zshenv 2>/dev/null
source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null || true
exec '${safeGbrainPath}' autopilot --repo '${safeRepoPath}'
`;
  writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  return wrapperPath;
}

async function installDaemon(engine: BrainEngine, args: string[]) {
  const repoPath = parseArg(args, '--repo') || await engine.getConfig('sync.repo_path');
  if (!repoPath) {
    console.error('No repo path. Use --repo or run gbrain sync --repo first.');
    process.exit(1);
  }

  const forcedTarget = parseArg(args, '--target') as InstallTarget | undefined;
  const target: InstallTarget = forcedTarget ?? detectInstallTarget();

  const injectBootstrap = args.includes('--inject-bootstrap');
  const noInject = args.includes('--no-inject');

  const wrapperPath = writeWrapperScript(repoPath);
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

// v0.37.7.0 #1162 — pure function for plist generation so tests can
// assert ThrottleInterval/KeepAlive shape without an installed daemon.
export function generateLaunchdPlist(wrapperPath: string, home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gbrain.autopilot</string>
  <key>ProgramArguments</key><array>
    <string>${escapeXml(wrapperPath)}</string>
  </array>
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
    writeFileSync(plistPath(), plist);
    execSync(`launchctl load "${plistPath()}"`, { stdio: 'pipe' });
    console.log('Installed launchd service: com.gbrain.autopilot');
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
    writeFileSync(unitPath, generateSystemdUnit(execMatch![1]));
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
    writeFileSync(unitPath, unit);
    execSync('systemctl --user daemon-reload', { stdio: 'pipe', timeout: 10_000 });
    execSync('systemctl --user enable --now gbrain-autopilot.service', { stdio: 'pipe', timeout: 15_000 });
    console.log('Installed systemd user service: gbrain-autopilot.service');
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

function uninstallDaemon() {
  const home = process.env.HOME || '';
  const wrapperPath = join(home, '.gbrain', 'autopilot-run.sh');

  // Always try all four targets — the user might have run `--install` under
  // one target earlier and moved hosts (e.g. macOS laptop → Linux server).
  // Each path is idempotent (missing files = skip silently).

  let removed = 0;

  // macOS launchd
  if (existsSync(plistPath())) {
    try {
      execSync(`launchctl unload "${plistPath()}" 2>/dev/null || true`, { stdio: 'pipe' });
      unlinkSync(plistPath());
      console.log('Removed launchd service: com.gbrain.autopilot');
      removed++;
    } catch (e) {
      console.error(`  [warn] launchd: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Linux systemd user unit
  if (existsSync(systemdUnitPath())) {
    try {
      execSync('systemctl --user disable --now gbrain-autopilot.service 2>/dev/null || true', { stdio: 'pipe', timeout: 10_000 });
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
}

function showStatus(json: boolean) {
  const logFile = join(process.env.HOME || '', '.gbrain', 'autopilot.log');
  let lastLine = '';
  try {
    const content = readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    lastLine = lines[lines.length - 1] || '';
  } catch { /* no log */ }

  let installed = false;
  if (process.platform === 'darwin') {
    installed = existsSync(plistPath());
  } else {
    try {
      const crontab = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8' });
      installed = crontab.includes('gbrain autopilot');
    } catch { /* no crontab */ }
  }

  if (json) {
    console.log(JSON.stringify({ installed, last_log: lastLine }));
  } else {
    console.log(`Autopilot: ${installed ? 'installed' : 'not installed'}`);
    if (lastLine) console.log(`Last log: ${lastLine}`);
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
