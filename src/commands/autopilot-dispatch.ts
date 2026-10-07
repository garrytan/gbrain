/**
 * One Minions-dispatch tick of the `gbrain autopilot` daemon: per-source
 * freshness syncs, the extract_atoms auto-drain, then the remediation plan
 * routed to a sleep, a full per-source cycle fan-out or targeted handler
 * submits. Called by runAutopilotDaemon (src/commands/autopilot-daemon.ts).
 */
import type { BrainEngine } from '../core/engine.ts';
import type { MinionQueue } from '../core/minions/queue.ts';
import { loadAllSources, parseSourceConfig, sourceConfigHasRemoteUrl, sourceLocalPathSkipWarning, type SourceRow } from '../core/sources-load.ts';
import { isConnectorSourceKind } from '../core/persistence/connector-identity.ts';
import { attemptedConnectorSourceIds } from '../core/persistence/connector-state.ts';
import { automaticSyncPull } from '../core/persistence/automatic-sync-policy.ts';
import { isSyncDisabledConfig } from '../core/sync-policy.ts';
import { loadActivationPendingSourceIds, skipActivationPendingSync } from '../core/sync-policy.ts';
import { resolveAutopilotDispatchTimeoutMs } from './autopilot-timeout.ts';
import {
  autopilotRemediationIdempotencyKey,
  shouldRunAutopilotFullCycle,
  shouldSleepHealthyAutopilot,
} from './autopilot-remediation-policy.ts';
import type { AutopilotDaemonState } from './autopilot-daemon.ts';
import { logError } from './autopilot.ts';

/** Returns cycleOk: false only when the dispatch itself threw. */
export async function dispatchAutopilotTick(
  engine: BrainEngine,
  state: AutopilotDaemonState,
  { repoPath, baseInterval, jsonMode }: { repoPath: string; baseInterval: number; jsonMode: boolean },
): Promise<boolean> {
  let cycleOk = true;
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
    const queue = new MinionQueue(engine);
    const slotMs = Math.floor(Date.now() / (baseInterval * 1000)) * baseInterval * 1000;
    const slot = new Date(slotMs).toISOString();
    const timeoutMs = resolveAutopilotDispatchTimeoutMs(baseInterval, false);

    await dispatchFreshnessSyncs(engine, queue, { baseInterval, slot, timeoutMs, jsonMode });
    await dispatchAutoDrain(engine, queue, { timeoutMs, jsonMode });
    const { score, plan, estTotal } = await computeAutopilotPlan(engine, repoPath);

    // Track time since last full cycle for the 60-min floor.
    const minutesSinceLastFull = (Date.now() - state.lastFullCycleAt) / 60000;

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
      // (all_sources_handled subsumes all_sources_fresh: fresh + locally
      // skipped === every source.)
      if (
        result.dispatched.length > 0 ||
        result.coalesced.length > 0 ||
        result.legacy_fallback ||
        result.all_sources_handled
      ) {
        state.lastFullCycleAt = Date.now();
      }
      if (jsonMode) {
        process.stderr.write(JSON.stringify({
          event: 'fanout_summary',
          dispatched: result.dispatched,
          coalesced: result.coalesced,
          skipped_fresh: result.skipped_fresh,
          skipped_cap: result.skipped_cap,
          skipped_cooldown: result.skipped_cooldown,
          skipped_unavailable_path: result.skipped_unavailable_path,
          legacy_fallback: result.legacy_fallback,
          fanout_max: fanoutMax,
          score,
        }) + '\n');
      } else if (!result.legacy_fallback) {
        console.log(
          `[dispatch] fanout: ${result.dispatched.length} dispatched` +
          `${result.coalesced.length > 0 ? ` (${result.coalesced.length} coalesced onto in-flight)` : ''}, ` +
          `${result.skipped_fresh.length} fresh, ${result.skipped_cap.length} capped, ` +
          `${result.skipped_cooldown.length} cooldown, ` +
          `${result.skipped_unavailable_path.length} unavailable-path ` +
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
  return cycleOk;
}

const connectorNoticePrinted = new Set<string>();

/**
 * DX O1 (fix wave 4) dispatch gate, shared by the freshness loop and the
 * per-source fan-out: a connector source with no recorded sync attempt stays
 * idle, spends nothing, and gets a one-time notice naming the enable command.
 * An unreadable gate fails closed for connectors only.
 */
export function connectorAwaitingFirstSync(src: { id: string; config: unknown }, attempted: Set<string> | null, jsonMode: boolean,
  write: (line: string) => void = (line) => process.stderr.write(line + '\n')): boolean {
  const kind = parseSourceConfig(src.config).kind;
  if (!isConnectorSourceKind(kind)) return false;
  if (attempted?.has(src.id)) return false;
  if (!connectorNoticePrinted.has(src.id)) {
    connectorNoticePrinted.add(src.id);
    const command = `gbrain sync --source ${src.id}`;
    write(jsonMode ? JSON.stringify({ event: 'connector_awaiting_first_sync', source_id: src.id, command })
      : `[dispatch] ${src.id}: ${kind} source has never synced; autopilot keeps it synced after its first sync. Enable it with: ${command}`);
  }
  return true;
}

/**
 * v0.40 D17 freshness: runs first each tick, independent of the score gate.
 */
export async function dispatchFreshnessSyncs(
  engine: BrainEngine,
  queue: MinionQueue,
  { baseInterval, slot, timeoutMs, jsonMode }: { baseInterval: number; slot: string; timeoutMs: number; jsonMode: boolean },
): Promise<void> {
  // ── v0.40 D17: per-source freshness check ────────────────────
  // Runs first; independent of score gate. Submits a 'sync' job per
  // source whose last_sync_at is older than the interval. The sync
  // handler (T6/T7) auto-enqueues embed-backfill on completion if
  // pages changed.
  try {
    const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
    if (await isFederatedV2Enabled(engine)) {
      const attempted = await attemptedConnectorSourceIds(engine).catch(() => null);
      const sources = await loadAllSources(engine);
      const activationPending = await loadActivationPendingSourceIds(engine);
      const intervalMs = baseInterval * 1000;
      const now = Date.now();
      for (const src of sources) {
        if (isConnectorSourceKind(parseSourceConfig(src.config).kind)) {
          await dispatchConnectorFreshnessSync(queue, src, attempted, activationPending, { intervalMs, now, slot, timeoutMs, jsonMode });
          continue;
        }
        if (!src.local_path) continue;
        // #4399: config.syncEnabled=false excludes a source from AUTOMATIC
        // sync (this loop, the full-cycle fan-out, `sync --all`); an
        // explicit `gbrain sync --source <id>` is unaffected.
        if (isSyncDisabledConfig(src.config)) continue;
        if (skipActivationPendingSync(activationPending, src.id, 'freshness_sync_skipped', jsonMode, (l) => process.stderr.write(l + '\n'))) continue; // #5198
        // A local_path this machine cannot use — relative (#3696: cwd is
        // launchd's, not the registering shell's) or absent on disk and
        // not a managed clone sync can re-create — would sync a phantom
        // path. Skip loudly (sourceLocalPathSkipWarning carries the
        // fix); under --json the skip is an NDJSON event like every
        // other daemon line on stderr, never bare prose in the stream.
        const skipWarn = sourceLocalPathSkipWarning(src.id, src.local_path, undefined, src.config);
        if (skipWarn) {
          process.stderr.write(
            (jsonMode ? JSON.stringify({ event: 'freshness_source_path_skipped', source_id: src.id, reason: skipWarn }) : skipWarn) + '\n',
          );
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
              pull: await automaticSyncPull(engine, src),
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
}

/**
 * #5673: a connector source (google, github) syncs from its provider, so its
 * `local_path` is irrelevant and its sync job carries no repoPath. Automatic
 * capture is opt-in: the DX O1 gate (`connectorAwaitingFirstSync`) keeps a
 * connector with no recorded sync attempt idle and prints the enable command once.
 */
async function dispatchConnectorFreshnessSync(
  queue: MinionQueue,
  src: SourceRow,
  attempted: Set<string> | null,
  activationPending: Awaited<ReturnType<typeof loadActivationPendingSourceIds>>,
  { intervalMs, now, slot, timeoutMs, jsonMode }: { intervalMs: number; now: number; slot: string; timeoutMs: number; jsonMode: boolean },
): Promise<void> {
  if (isSyncDisabledConfig(src.config)) return;
  if (skipActivationPendingSync(activationPending, src.id, 'freshness_sync_skipped', jsonMode, (l) => process.stderr.write(l + '\n'))) return;
  if (connectorAwaitingFirstSync(src, attempted, jsonMode)) return;
  const ageMs = now - (src.last_sync_at ? new Date(src.last_sync_at).getTime() : 0);
  if (ageMs < intervalMs) return;
  try {
    const job = await queue.add(
      'sync',
      { sourceId: src.id, pull: sourceConfigHasRemoteUrl(src.config), auto_embed_backfill: true, embed_reason: 'autopilot_freshness' },
      { queue: 'default', idempotency_key: `autopilot-sync:${src.id}:${slot}`, max_attempts: 2, timeout_ms: timeoutMs, maxWaiting: 1 },
    );
    if (jsonMode) {
      process.stderr.write(JSON.stringify({ event: 'dispatched', job_id: job.id, mode: 'freshness', source_id: src.id, age_ms: ageMs }) + '\n');
    } else {
      console.log(`[dispatch] job #${job.id} sync (freshness: ${src.id}; age=${Math.floor(ageMs / 60000)}min)`);
    }
  } catch (e) {
    logError('dispatch.freshness', e);
  }
}

/** #1685 GAP D: bounded, daily-capped extract_atoms drain per source (Postgres only). */
async function dispatchAutoDrain(
  engine: BrainEngine,
  queue: MinionQueue,
  opts: { timeoutMs: number; jsonMode: boolean },
): Promise<void> {
  // Postgres-only — PGLite has no multi-process worker to run the job.
  if (engine.kind === 'postgres') {
    try {
      if ((await engine.getConfig('autopilot.auto_drain.enabled')) !== 'false') await submitAutoDrains(engine, queue, opts);
    } catch (e) {
      logError('dispatch.auto-drain-gate', e);
    }
  }
}

/** #5856: the source kind the auto-drain offers the next free slot to; alternates across ticks and days. */
export const AUTO_DRAIN_NEXT_KIND_KEY = 'autopilot.auto_drain.next_kind';
type AutoDrainKind = 'checkout' | 'connector';

/**
 * #5856: units of today's drain jobs against the daily cap. Every started
 * attempt costs one (a waiting job one), so retried provider failures still
 * count; a job whose only attempt was a structural refusal spent nothing and
 * costs none.
 */
async function autoDrainUnitsToday(engine: BrainEngine, utcDay: string): Promise<number> {
  const { STRUCTURAL_REFUSAL_PREFIX } = await import('../core/cycle/extract-atoms-drain.ts');
  const rows = await engine.executeRaw<{ cnt: number }>(
    `SELECT COALESCE(sum(CASE WHEN status = 'dead' AND attempts_started <= 1
         AND left(COALESCE(error_text, ''), length($2::text)) = $2::text THEN 0 ELSE GREATEST(attempts_started, 1) END), 0)::int AS cnt
       FROM minion_jobs WHERE name = 'extract-atoms-drain' AND created_at >= $1::timestamptz`,
    [`${utcDay}T00:00:00Z`, STRUCTURAL_REFUSAL_PREFIX],
  );
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * The auto-drain submission pass behind dispatchAutoDrain's Postgres and
 * `autopilot.auto_drain.enabled` gates; exported so tests drive it on either engine. `now` is the clock seam for
 * the UTC-day slot.
 */
export async function submitAutoDrains(
  engine: BrainEngine,
  queue: MinionQueue,
  { timeoutMs, jsonMode, now = Date.now }: { timeoutMs: number; jsonMode: boolean; now?: () => number },
): Promise<void> {
  // ── #1685 GAP D: per-source extract_atoms auto-drain ───────────────
  // The silent-backlog incident: the atom backlog grows invisibly when
  // nothing runs extract_atoms. Auto-submit a bounded, PROTECTED drain per
  // source when the backlog exceeds the threshold. Default-ON, daily-capped,
  // time-sloted key so a new slot opens each UTC day (CODEX #1/#2/#3,
  // DECISION 3C). #5028: this runs whether or not the active pack declares
  // extract_atoms. The daemon's per-source cycles run only
  // SOURCE_FRESHNESS_PHASES and the maintenance job runs no source phase, so
  // a declaring pack does not make the routine cycle drain it; skipping here
  // left this drain as the only runner switched off.
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
  // Each drain attempt runs under one BudgetTracker capped at ~$0.30
  // (cycle.extract_atoms.budget_usd); bound the brain-wide daily attempt
  // count instead of a real-time spend ledger.
  const PER_RUN_USD = 0.3;
  const maxJobsToday = Math.max(0, Math.floor(maxUsdPerDay / PER_RUN_USD));
  const utcDay = new Date(now()).toISOString().slice(0, 10);

  let submittedToday = 0;
  try {
    submittedToday = await autoDrainUnitsToday(engine, utcDay);
  } catch {
    // count is best-effort; treat as 0 (cap still bounds submits this tick).
  }
  if (submittedToday >= maxJobsToday) return;

  const { countExtractAtomsBacklog } = await import('../core/cycle/extract-atoms.ts');
  const { atomDrainOwnerRefusal } = await import('../core/persistence/atom-maintenance.ts');
  // #5856 fairness: checkout-backed and connector sources alternate for the
  // daily slots, starting with the kind the persisted pointer names, so a
  // large connector backlog cannot starve a git source's atoms (or the reverse).
  const byKind: Record<AutoDrainKind, SourceRow[]> = { checkout: [], connector: [] };
  for (const src of await loadAllSources(engine)) {
    byKind[isConnectorSourceKind(parseSourceConfig(src.config).kind) ? 'connector' : 'checkout'].push(src);
  }
  const pointer: AutoDrainKind = (await engine.getConfig(AUTO_DRAIN_NEXT_KIND_KEY)) === 'connector' ? 'connector' : 'checkout';
  let next = pointer;
  while (submittedToday < maxJobsToday) { // brain-wide daily cap (fairness)
    const kind: AutoDrainKind = byKind[next].length ? next : next === 'checkout' ? 'connector' : 'checkout';
    const src = byKind[kind].shift();
    if (!src) break;
    // A connector source syncs from its provider: its local_path is a state
    // directory, so it needs none and its job carries no repoPath.
    if (kind === 'checkout') {
      if (!src.local_path) continue;
      // Same unavailable-path skip (relative / missing on this
      // machine) as the freshness loop above, same --json shape.
      const skipWarn = sourceLocalPathSkipWarning(src.id, src.local_path, undefined, src.config);
      if (skipWarn) {
        process.stderr.write(
          (jsonMode ? JSON.stringify({ event: 'freshness_source_path_skipped', source_id: src.id, reason: skipWarn }) : skipWarn) + '\n',
        );
        continue;
      }
    }
    // Time-sloted key (CODEX #2): a static key would block the
    // source FOREVER once the first job completes. A new UTC-day
    // slot reopens it each day; it also bounds a structural refusal
    // to one dead job per source per day.
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
      const backlog = await countExtractAtomsBacklog(engine, src.id);
      if (backlog === null || backlog <= threshold) continue;
      // #5856: the drain's writer preflight would refuse this source (no
      // active local owner); submitting it would only dead-letter.
      const refusal = await atomDrainOwnerRefusal(engine, src.id);
      if (refusal) {
        const reason = `[autopilot] skipping atom auto-drain for '${src.id}': ${refusal}`;
        process.stderr.write((jsonMode ? JSON.stringify({ event: 'auto_drain_source_skipped', source_id: src.id, reason }) : reason) + '\n');
        continue;
      }
      const job = await queue.add(
        'extract-atoms-drain',
        { sourceId: src.id, window: windowSeconds, ...(kind === 'checkout' ? { repoPath: src.local_path } : {}) },
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
      next = kind === 'checkout' ? 'connector' : 'checkout';
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
  if (next !== pointer) await engine.setConfig(AUTO_DRAIN_NEXT_KIND_KEY, next);
}

/** The remediation plan autopilot routes on (brain score + doctor/onboard recommendations). */
async function computeAutopilotPlan(engine: BrainEngine, repoPath: string) {
  const { computeRecommendations, embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG, chatApiKeyConfigured } = await import('../core/brain-score-recommendations.ts');
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
    staleExtractionBlocked: await (await import('../core/remediation/context.ts')).staleExtractionBlocked(engine).catch(() => undefined),
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
  return { score, plan, estTotal };
}
