/**
 * `gbrain autopilot` daemon: boot, the managed worker, shutdown and the tick
 * loop. runAutopilot (src/commands/autopilot.ts) dispatches here when no
 * install/uninstall/status/pause mode flag is present.
 */
import type { BrainEngine } from '../core/engine.ts';
import { ChildWorkerSupervisor } from '../core/minions/child-worker-supervisor.ts';
import { MIGRATE_PAUSE_MARKER_PREFIX, autopilotLockPath, autopilotPaused, autopilotPausedMarkerPath, markerHolderAlive } from '../core/autopilot-paths.ts';
import { OwnerProcessingState } from '../core/minions/processing-state.ts';
import { mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { gbrainPath as gbrainHomePath, loadConfig, loadConfigFileOnly } from '../core/config.ts';
import { join } from 'path';
import { loadPreferences } from '../core/preferences.ts';
import { registerCleanup } from '../core/process-cleanup.ts';
import { dispatchAutopilotTick } from './autopilot-dispatch.ts';
import { runNightlyQualityProbeStep, runParserProbeStep } from './autopilot-probes.ts';
import { resolveChildCliInvocation } from '../core/minions/job-isolation.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import {
  attemptAutopilotSelfUpgrade,
  autopilotEngineIdentity,
  chatBootWarning,
  classifyReconnectError,
  decideLockAcquisition,
  guardAutopilotEngine,
  logError,
  parseArg,
  reconcileSelfUpgradeAtBoot,
  resolveGbrainCliPath,
  shouldSpawnAutopilotWorker,
} from './autopilot.ts';

/**
 * Mutable daemon state shared by the tick loop, the shutdown path and the tick
 * steps. Each field keeps the name of the closure variable it replaced.
 */
export interface AutopilotDaemonState {
  stopping: boolean;
  /** #1872: the in-flight inline runCycle, drained by closeEngine on shutdown. */
  inflightInlineCycle: Promise<unknown> | null;
  consecutiveErrors: number;
  /**
   * #2608: once-per-process no-chat-provider warning. A keyless daemon used
   * to run every cycle "green" while all LLM phases silently no-op'd
   * (chronicle reported no_events, propose_takes skipped, …) — the operator
   * had no signal that shell-profile keys never reached launchd/systemd.
   */
  noChatProviderWarned: boolean;
  /**
   * v0.37.7.0 #1162 — counter for consecutive reconnect failures.
   * Reset on every successful health probe or reconnect. Threshold
   * controlled by GBRAIN_AUTOPILOT_MAX_RECONNECT_FAILS env (default 30).
   */
  autopilotReconnectFails: number;
  /** Consecutive --no-worker ticks with no live worker signal (see NO_WORKER_WARN_TICKS). */
  noWorkerConsecutiveIdle: number;
  /**
   * v0.36+ T8: track time since last full cycle for the 60-min floor.
   * Initialized to "long ago" (0) so the first tick on a healthy brain still
   * runs the full cycle (phase-coupling exercise) before settling into
   * targeted-submit mode.
   */
  lastFullCycleAt: number;
  /** Log the pause/resume transition once each, not every poll. */
  pausedAnnounced: boolean;
}

export async function runAutopilotDaemon(engine: BrainEngine, args: string[]): Promise<void> {
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
  acquireAutopilotLock(lockPath);

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

  const state: AutopilotDaemonState = {
    stopping: false,
    inflightInlineCycle: null,
    consecutiveErrors: 0,
    noChatProviderWarned: false,
    autopilotReconnectFails: 0,
    noWorkerConsecutiveIdle: 0,
    lastFullCycleAt: 0,
    pausedAnnounced: false,
  };
  let childSupervisor: ChildWorkerSupervisor | null = null;
  const processingState = spawnManagedWorker ? new OwnerProcessingState('autopilot', 'default') : null;
  const configurationBlocked = () => processingState?.blocked ?? false;
  if (processingState) engine = guardAutopilotEngine(engine, processingState);

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
  const closeEngine = async () => {
    shutdownAbort.abort(new Error('autopilot shutdown'));
    if (state.inflightInlineCycle) {
      // ponytail: 2s cap keeps us inside process-cleanup's 3s deadline; a
      // between-phase abort resolves instantly, a mid-phase one may not.
      await Promise.race([
        state.inflightInlineCycle.catch(() => { /* cycle errors already logged by the loop */ }),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
    }
    try { await engine.disconnect(); } catch { /* best-effort */ }
  };
  const deregisterEngineClose = registerCleanup('autopilot-engine-close', closeEngine);

  if (spawnManagedWorker) {
    // Lazy: `shutdown` is declared below; the worker only calls it after the loop starts.
    childSupervisor = await startAutopilotWorker(processingState, state, (sig) => shutdown(sig));
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
    if (configurationBlocked() && sig !== 'SIGTERM' && sig !== 'SIGINT') return;
    if (state.stopping) return;
    state.stopping = true;
    console.log(`Autopilot stopping (${sig}).`);
    if (childSupervisor) {
      childSupervisor.killChild('SIGTERM');
      await childSupervisor.awaitChildExit(35_000);
      if (childSupervisor.childAlive) {
        childSupervisor.killChild('SIGKILL');
      }
    }
    if (configurationBlocked() && sig !== 'SIGTERM' && sig !== 'SIGINT') {
      state.stopping = false;
      return;
    }
    // #1872: abort the in-flight inline cycle and close the engine BEFORE
    // process.exit — a hard exit mid-write corrupts PGLite's WASM Postgres.
    await closeEngine();
    deregisterEngineClose();
    processingState?.close();
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    process.exit(sig === 'max_crashes' || sig === 'cycle-failure-cap' ? 1 : 0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });

  const AUTOPILOT_MAX_RECONNECT_FAILS = Math.max(
    1,
    Number(process.env.GBRAIN_AUTOPILOT_MAX_RECONNECT_FAILS) || 30,
  );

  while (!state.stopping) {
    const cycleStart = Date.now();

    // Refresh the lock mtime so another cron-fired autopilot doesn't
    // declare the instance stale after 10 minutes (Codex C).
    try { utimesSync(lockPath, new Date(), new Date()); } catch { /* best-effort */ }

    if (processingState && !processingState.snapshot.processing_ready) {
      await new Promise(r => setTimeout(r, 250));
      continue;
    }

    await warnNoChatProviderOnce(state);

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
    if (autopilotPaused()) {
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
      }
      if (autopilotPaused()) {
        if (!state.pausedAnnounced) {
          console.log('[autopilot] paused (autopilot-paused marker present) — skipping cycles until it clears.');
          state.pausedAnnounced = true;
        }
        // Poll faster than a normal tick so a migration's quiesce window is short.
        await new Promise((r) => setTimeout(r, Math.min(baseInterval, 30) * 1000));
        continue;
      }
    }
    if (state.pausedAnnounced) {
      console.log('[autopilot] resumed — pause marker cleared.');
      state.pausedAnnounced = false;
    }

    // DB health check (reconnect if needed); see probeDatabaseOrReconnect.
    const dbProbe = await probeDatabaseOrReconnect(engine, state, configurationBlocked, AUTOPILOT_MAX_RECONNECT_FAILS);
    if (dbProbe === 'skip') continue;
    if (dbProbe === 'fatal') break;

    // v0.42 self-upgrade silent channel (opt-in self_upgrade.mode=auto). Runs
    // each tick; cache TTL throttles the actual GitHub fetch. On apply it swaps
    // + exits for supervisor relaunch (never returns). No-op unless mode=auto.
    if (configurationBlocked()) continue;
    await attemptAutopilotSelfUpgrade(engine, engineType, lockPath, () => !configurationBlocked());
    if (configurationBlocked()) continue;

    // --no-worker peer-liveness probe (v0.19.1). Runs every cycle, cheap
    // (single SELECT). See the NO_WORKER_WARN_TICKS comment for caveats.
    if (noWorker && useMinionsDispatch) await probeNoWorkerPeer(engine, state, baseInterval);

    const cycleOk = useMinionsDispatch
      ? await dispatchAutopilotTick(engine, state, { repoPath, baseInterval, jsonMode })
      : await runInlineCycle(engine, state, repoPath, shutdownAbort, jsonMode);

    if (configurationBlocked()) continue;
    // 4. Health check + adaptive interval (same for both paths)
    const interval = await adaptiveInterval(engine, baseInterval, cycleStart, jsonMode);

    if (configurationBlocked()) continue;
    if (cycleOk) {
      state.consecutiveErrors = 0;
    } else {
      state.consecutiveErrors++;
      if (state.consecutiveErrors >= 5) {
        console.error('5 consecutive cycle failures. Stopping autopilot.');
        await shutdown('cycle-failure-cap');
        if (!state.stopping) continue;
        break;
      }
    }

    await runNightlyQualityProbeStep(engine, cfg);
    await runParserProbeStep(engine, cfg);

    // Wait for next cycle
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

/** Take the single-instance lock file (#14): exit when a live holder owns it, take over a stale one. Best-effort. */
function acquireAutopilotLock(lockPath: string): void {
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
}

/** Spawn the managed `gbrain jobs work` child under ChildWorkerSupervisor (Minions dispatch mode). */
async function startAutopilotWorker(
  processingState: OwnerProcessingState | null,
  state: AutopilotDaemonState,
  shutdown: (sig: string) => Promise<void>,
): Promise<ChildWorkerSupervisor> {
  const invocation = resolveChildCliInvocation({}, process.execPath, process.argv[1], resolveGbrainCliPath);
  if (!invocation) throw new Error('Could not resolve the worker CLI. Repair the current GBrain installation.');
  // Cgroup-aware auto-sized RSS watchdog cap (issue #1678). The old flat
  // 2048MB killed legit embed work (~10GB) on every cycle → silent
  // ~400×/24h respawn loop. resolveDefaultMaxRssMb clamps 0.5×min(cgroup,
  // RAM) to [4096,16384]. Bare `gbrain jobs work` resolves the same default;
  // we pass it explicitly so the spawn log + child agree.
  const { resolveDefaultMaxRssMb } = await import('../core/minions/rss-default.ts');
  const autopilotMaxRssMb = resolveDefaultMaxRssMb();
  const childSupervisor = new ChildWorkerSupervisor({
    processingState: processingState ?? undefined,
    onConfigurationBlocked: (status) => {
      console.error(`[autopilot] processing configuration-blocked (${status?.reason_code ?? 'unknown'}); repair the worker/child installation and explicitly restart autopilot.`);
    },
    cliPath: invocation.cmd,
    args: [...invocation.argsPrefix, 'jobs', 'work', '--max-rss', String(autopilotMaxRssMb)],
    env: { ...process.env, GBRAIN_SUPERVISED: undefined } as Record<string, string | undefined>,
    maxCrashes: 5,
    isStopping: () => state.stopping,
    onMaxCrashesExceeded: (count, max) => {
      console.error(`[autopilot] ${count}/${max} consecutive worker crashes, giving up.`);
      void shutdown('max_crashes');
    },
    onEvent: (event) => {
      // Route ChildWorkerSupervisor events to autopilot's stderr log.
      // Matches the prior console output shape so operators reading
      // existing logs see the same lines.
      if (event.kind === 'worker_startup_timeout') {
        console.error(`[autopilot] worker readiness was not confirmed within ${event.timeoutMs}ms; stopping this worker and retrying with bounded backoff.`);
      } else if (event.kind === 'worker_spawned') {
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
  return childSupervisor;
}

/** Once per process: warn when no chat provider is available to the daemon. */
async function warnNoChatProviderOnce(state: AutopilotDaemonState): Promise<void> {
  // #2608: loud once-per-process signal when no chat provider is servable.
  // Without this a keyless daemon looks healthy forever while every LLM
  // phase quietly skips.
  if (!state.noChatProviderWarned) {
    state.noChatProviderWarned = true;
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
}

/**
 * One tick's DB liveness probe: 'ok' when the engine answers (directly or
 * after a reconnect), 'skip' when processing is configuration-blocked, and
 * 'fatal' after it set state.stopping on an unrecoverable error or the
 * consecutive-failure cap.
 */
async function probeDatabaseOrReconnect(
  engine: BrainEngine,
  state: AutopilotDaemonState,
  configurationBlocked: () => boolean,
  AUTOPILOT_MAX_RECONNECT_FAILS: number,
): Promise<'ok' | 'skip' | 'fatal'> {
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
    state.autopilotReconnectFails = 0; // reset on success
  } catch (probeErr) {
    if (configurationBlocked()) return 'skip';
    try {
      // #2034: use reconnect() — it restores the config captured at connect()
      // and avoids the null-connection window. The previous
      // `disconnect()` + bare `connect()` lost the config (throwing
      // `database_url undefined` on every retry → FATAL restart-loop on any
      // transient DB blip) AND tore down the pool postgres.js can otherwise
      // self-heal.
      await engine.reconnect({ error: probeErr });
      state.autopilotReconnectFails = 0;
    } catch (e) {
      if (configurationBlocked()) return 'skip';
      logError('reconnect', e);
      state.autopilotReconnectFails++;
      const klass = classifyReconnectError(e);
      if (klass === 'crash') {
        // A gbrain BUG, not an operator misconfiguration. Say so plainly
        // instead of blaming the config, and keep retrying: a code defect must
        // not permanently disable the daemon. The consecutive-failure cap below
        // still bounds it.
        console.error(
          `[autopilot] BUG: internal error during reconnect (${(e as Error).message ?? 'unknown'}). ` +
          `This is a gbrain defect, not a configuration problem — please report it. ` +
          `Retrying (${state.autopilotReconnectFails}/${AUTOPILOT_MAX_RECONNECT_FAILS}).`,
        );
      } else if (klass === 'unrecoverable') {
        console.error(
          `[autopilot] FATAL: unrecoverable DB error (${(e as Error).message ?? 'unknown'}). ` +
          `Exiting so launchd ThrottleInterval can apply backoff.`,
        );
        state.stopping = true;
        setCliExitVerdict(1);
        return 'fatal';
      }
      if (state.autopilotReconnectFails >= AUTOPILOT_MAX_RECONNECT_FAILS) {
        console.error(
          `[autopilot] FATAL: ${state.autopilotReconnectFails} consecutive reconnect failures. ` +
          `Last error: ${(e as Error).message ?? 'unknown'}. Exiting.`,
        );
        state.stopping = true;
        setCliExitVerdict(1);
        return 'fatal';
      }
    }
  }
  return 'ok';
}

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

/** --no-worker peer-liveness probe (v0.19.1); see NO_WORKER_WARN_TICKS. */
async function probeNoWorkerPeer(engine: BrainEngine, state: AutopilotDaemonState, baseInterval: number): Promise<void> {
    try {
      const rows = await (engine as any).executeRaw?.(
        `SELECT count(*)::int AS n FROM minion_jobs
             WHERE status = 'active'
               AND lock_until IS NOT NULL
               AND lock_until > now() - interval '2 minutes'`,
      );
      const liveWorkerSignal = Number((rows as Array<{ n: number }>)?.[0]?.n ?? 0);
      if (liveWorkerSignal === 0) {
        state.noWorkerConsecutiveIdle++;
        if (state.noWorkerConsecutiveIdle === NO_WORKER_WARN_TICKS) {
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
        if (state.noWorkerConsecutiveIdle >= NO_WORKER_WARN_TICKS) {
          console.log('[autopilot] --no-worker probe: live worker signal detected; warning re-armed.');
        }
        state.noWorkerConsecutiveIdle = 0;
      }
    } catch (e) {
      // Probe failures never block the main dispatch loop. Log once per
      // failure class; ignore repeated errors (common shape: DB reconnect
      // blip between ticks).
      logError('no-worker-probe', e);
    }
}

/** Inline fallback cycle (minion_mode=off, PGLite or --inline); returns cycleOk. */
async function runInlineCycle(
  engine: BrainEngine,
  state: AutopilotDaemonState,
  repoPath: string,
  shutdownAbort: AbortController,
  jsonMode: boolean,
): Promise<boolean> {
  let cycleOk = true;
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
      state.inflightInlineCycle = cyclePromise;
      const report = await cyclePromise.finally(() => { state.inflightInlineCycle = null; });
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
  return cycleOk;
}

/** 4. Health check + adaptive interval (same for both paths); returns the next interval in seconds. */
async function adaptiveInterval(engine: BrainEngine, baseInterval: number, cycleStart: number, jsonMode: boolean): Promise<number> {
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
  return interval;
}
