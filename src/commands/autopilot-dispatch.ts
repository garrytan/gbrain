/**
 * One Minions-dispatch tick of the `gbrain autopilot` daemon: per-source
 * freshness syncs, the extract_atoms auto-drain, then the remediation plan
 * routed to a sleep, a full per-source cycle fan-out or targeted handler
 * submits. Called by runAutopilotDaemon (src/commands/autopilot-daemon.ts).
 */
import type { BrainEngine } from '../core/engine.ts';
import type { BrainHealth } from '../core/types.ts';
import type { MinionQueue } from '../core/minions/queue.ts';
import { loadAllSources, parseSourceConfig, sourceConfigHasRemoteUrl, sourceLocalPathSkipWarning, type SourceRow } from '../core/sources-load.ts';
import { isConnectorSourceKind } from '../core/persistence/connector-identity.ts';
import { attemptedConnectorSourceIds, type ConnectorAccountMismatch } from '../core/persistence/connector-state.ts';
import { connectorAccountMismatches, connectorAccountMismatchSkipWarning } from '../core/persistence/connector-account-mismatch.ts';
import { AUTOPILOT_GIT_PULL_KEY, automaticGitPullDisabled, automaticSyncPull } from '../core/persistence/automatic-sync-policy.ts';
import { isSyncDisabledConfig } from '../core/sync-policy.ts';
import { automaticSyncSkip, loadActivationPendingSourceIds, reportAutomaticSyncSkip, skipActivationPendingSync } from '../core/sync-policy.ts';
import { resolveAutopilotAutoDrainBounds, resolveAutopilotDispatchTimeoutMs } from './autopilot-timeout.ts';
import {
  autopilotRemediationIdempotencyKey,
  autopilotTargetedSteps,
  shouldRunAutopilotFullCycle,
  shouldSleepHealthyAutopilot,
} from './autopilot-remediation-policy.ts';
import type { AutopilotDaemonState } from './autopilot-daemon.ts';
import { logError } from './autopilot.ts';
import { readTickHealth } from './autopilot-health.ts';
import { readCheckoutHead } from '../core/checkout-head.ts';
import { SYNC_ON_COMMIT_KEY } from '../core/sync-config-keys.ts';
import { autopilotPaused } from '../core/autopilot-paths.ts';
import { cooldownMinForCount, resolveFailureCooldownOpts } from './autopilot-fanout.ts';

/**
 * cycleOk is false only when the dispatch itself threw. health is the snapshot the plan routed on (null: the bounded
 * read timed out), for the daemon's adaptive interval (#7236); absent when the tick threw before reading it.
 */
export async function dispatchAutopilotTick(
  engine: BrainEngine,
  state: AutopilotDaemonState,
  { repoPath, baseInterval, jsonMode }: { repoPath: string; baseInterval: number; jsonMode: boolean },
): Promise<{ cycleOk: boolean; health?: BrainHealth | null }> {
  let cycleOk = true;
  let health: BrainHealth | null | undefined;
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

    await dispatchFreshnessSyncs(engine, queue, { baseInterval, slot, timeoutMs, jsonMode, freshnessHeads: state.freshnessHeads });
    await dispatchAutoDrain(engine, queue, { timeoutMs, jsonMode });
    const autopilotPlan = await computeAutopilotPlan(engine, repoPath, jsonMode);
    health = autopilotPlan.health;
    const { score, plan, estTotal } = autopilotPlan;

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
      // targeted small-plan steps), which have no such anchor and are meant
      // to stay interval-derived; auto-drains co-stamp their window and
      // deadline (resolveAutopilotAutoDrainBounds). Naming this
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
        // GBRA-130 C-6: the verdict `autopilot --status` reads without the database.
        try {
          const { recordGlobalMaintenanceStallStatus } = await import('../core/minions/global-maintenance-stall.ts');
          await recordGlobalMaintenanceStallStatus(engine);
        } catch (e) {
          if (jsonMode) process.stderr.write(JSON.stringify({ event: 'global_maintenance_verdict_failed', error: e instanceof Error ? e.message : String(e) }) + '\n');
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
      for (const step of autopilotTargetedSteps(plan)) {
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
  return { cycleOk, health };
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

/** What the freshness loop decided for one checkout source (connector sources are not reported). */
export interface FreshnessDecision {
  source_id: string;
  outcome: 'dispatched' | 'coalesced' | 'fresh' | 'live_job' | 'skipped' | 'failed';
  /** Why a sync was due: the checkout's HEAD differs from the last synced commit, or the wall-clock backstop. */
  trigger?: 'head' | 'interval';
  head?: string | null;
  job_id?: number;
}

/**
 * GBRA-133 2a.4: why a checkout source is due a freshness sync. HEAD-driven first: HEAD differs from the source's last
 * synced commit and this daemon has not already dispatched (or decided) for that HEAD; no ancestry assumption. The
 * wall-clock rule (last_sync_at older than the interval) stays as the backstop for retries, pulls and unreadable HEADs.
 * A HEAD in the middle of a rebase or merge waits for the operation to finish.
 */
export function freshnessTrigger(input: { head: { head: string; operation: string | null } | null; lastCommit: string | null;
  ageMs: number; intervalMs: number; decidedHead?: string }): 'head' | 'interval' | null {
  if (input.ageMs >= input.intervalMs) return 'interval';
  const head = input.head;
  if (!head || head.operation || head.head === input.lastCommit || head.head === input.decidedHead) return null;
  return 'head';
}

/** Whether a checkout source is due a freshness sync: its trigger and HEAD, or why not (fresh, or a live sync job). */
async function checkoutFreshness(engine: BrainEngine, src: SourceRow, root: string, input: { ageMs: number; intervalMs: number; decidedHead?: string }):
  Promise<{ trigger: 'head' | 'interval'; head: { head: string; operation: string | null } | null } | { decision: FreshnessDecision }> {
  const head = await readCheckoutHead(root);
  const trigger = freshnessTrigger({ head, lastCommit: src.last_commit, ...input });
  if (!trigger) return { decision: { source_id: src.id, outcome: 'fresh', head: head?.head ?? null } };
  // #6706: a live sync job (any submitter) is already draining this source; coalescing into another submitter's row is refused.
  if (await (await import('../core/persistence/sync-movement.ts')).liveSyncJob(engine, src.id) !== null) {
    return { decision: { source_id: src.id, outcome: 'live_job', trigger, head: head?.head ?? null } };
  }
  return { trigger, head };
}

/**
 * v0.40 D17 freshness: runs first each tick, independent of the score gate.
 * `freshnessHeads` (the daemon's per-source map of the HEAD it last dispatched or decided for) keeps a HEAD-driven
 * dispatch to one per HEAD; `onlySourceIds` narrows the pass to the sources the between-tick HEAD probe saw move.
 * A HEAD-driven job is keyed on its HEAD, never the wall-clock slot, so a new commit cannot coalesce into the slot's
 * completed job. A source with a live sync job keeps its HEAD undecided; the next tick or probe dispatches it.
 */
/** #7239: a source whose automatic sync keeps being refused, and until when its freshness sync waits. */
export interface SyncRefusalHold { code: string; job_id: number; count: number; retry_at: number }

const REFUSAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const reportedRefusalJobs = new Set<number>();

/**
 * #7239: a refused sync job (`job_outcome: 'refused'`, refusal.ts) fails the same way until someone fixes its cause, so
 * the freshness dispatch stops queueing a new one per slot and per commit. A source's refusals since its last completed
 * sync job (looking back a day) hold it for the autopilot failure cooldown of that count (10 minutes doubling to the
 * 2-hour cap; `autopilot.failure_cooldown_min` / `_cap_min`, 0 disables), counted from the newest refusal. A completed
 * sync job clears the hold; an explicit `gbrain sync --source <id>` is never held. Fails open (no holds) on a read error.
 */
export async function readSyncRefusalHolds(engine: BrainEngine, now = Date.now()): Promise<Map<string, SyncRefusalHold>> {
  const holds = new Map<string, SyncRefusalHold>();
  const opts = await resolveFailureCooldownOpts(engine);
  if (opts.baseMin <= 0) return holds;
  const rows = await engine.executeRaw<{ source_id: string | null; n: number; last_at: string | Date; job_id: number; code: string | null }>(
    `SELECT COALESCE(j.data->>'sourceId', j.data->>'source_id', 'default') AS source_id, count(*)::int AS n, max(j.finished_at) AS last_at,
            (array_agg(j.id ORDER BY j.finished_at DESC))[1] AS job_id,
            (array_agg(j.result->'refusal'->>'code' ORDER BY j.finished_at DESC))[1] AS code
       FROM minion_jobs j
      WHERE j.name = 'sync' AND j.status = 'dead' AND j.result->>'job_outcome' = 'refused' AND j.finished_at > $1
        AND NOT EXISTS (SELECT 1 FROM minion_jobs c
                         WHERE c.name = 'sync' AND c.status = 'completed' AND c.finished_at > j.finished_at
                           AND COALESCE(c.data->>'sourceId', c.data->>'source_id', 'default') = COALESCE(j.data->>'sourceId', j.data->>'source_id', 'default'))
      GROUP BY 1`,
    [new Date(now - REFUSAL_LOOKBACK_MS).toISOString()],
  );
  for (const r of rows) {
    const last = r.last_at instanceof Date ? r.last_at.getTime() : new Date(r.last_at).getTime();
    if (!r.source_id || !Number.isFinite(last)) continue;
    const retryAt = last + cooldownMinForCount(Number(r.n), opts) * 60_000;
    if (retryAt > now) holds.set(r.source_id, { code: r.code ?? 'refused', job_id: Number(r.job_id), count: Number(r.n), retry_at: retryAt });
  }
  return holds;
}

/** Whether a refusal hold skips this source's freshness sync now; reports the hold once per refused job. */
function skipRefusedSync(holds: ReadonlyMap<string, SyncRefusalHold>, sourceId: string, jsonMode: boolean): boolean {
  const hold = holds.get(sourceId);
  if (!hold) return false;
  if (!reportedRefusalJobs.has(hold.job_id)) {
    reportedRefusalJobs.add(hold.job_id);
    const retryAt = new Date(hold.retry_at).toISOString();
    process.stderr.write((jsonMode
      ? JSON.stringify({ event: 'freshness_sync_refused', source_id: sourceId, job_id: hold.job_id, code: hold.code, refusals: hold.count, retry_at: retryAt })
      : `[dispatch] sync of ${sourceId} waits until ${retryAt}: its last sync job #${hold.job_id} was refused (${hold.code}) and would be refused again. `
        + `gbrain jobs get ${hold.job_id} --json shows the fix; after fixing it, gbrain sync --source ${sourceId} runs now.`) + '\n');
  }
  return true;
}

export async function dispatchFreshnessSyncs(
  engine: BrainEngine,
  queue: MinionQueue,
  { baseInterval, slot, timeoutMs, jsonMode, freshnessHeads = new Map(), onlySourceIds }: { baseInterval: number; slot: string; timeoutMs: number; jsonMode: boolean;
    freshnessHeads?: Map<string, string>; onlySourceIds?: ReadonlySet<string> },
): Promise<FreshnessDecision[]> {
  const decisions: FreshnessDecision[] = [];
  // ── v0.40 D17: per-source freshness check ────────────────────
  // Runs first; independent of score gate. Submits a 'sync' job per
  // source whose last_sync_at is older than the interval. The sync
  // handler (T6/T7) auto-enqueues embed-backfill on completion if
  // pages changed.
  try {
    const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
    if (await isFederatedV2Enabled(engine)) {
      const attempted = await attemptedConnectorSourceIds(engine).catch(() => null);
      // #6803: unreadable mismatch records fail open; the connector sync refuses again on its own.
      const mismatched = await connectorAccountMismatches(engine).catch(() => new Map<string, ConnectorAccountMismatch>());
      const sources = await loadAllSources(engine);
      // #6451: one status line per tick when the operator turned automatic pulls off.
      if (await automaticGitPullDisabled(engine)) {
        process.stderr.write((jsonMode
          ? JSON.stringify({ event: 'git_pull_disabled', key: AUTOPILOT_GIT_PULL_KEY })
          : `[autopilot] git_pull: off (${AUTOPILOT_GIT_PULL_KEY}=false); remote sources sync their local checkout without pulling`) + '\n');
      }
      const activationPending = await loadActivationPendingSourceIds(engine);
      const intervalMs = baseInterval * 1000;
      const now = Date.now();
      const refusalHolds = await readSyncRefusalHolds(engine, now).catch(() => new Map<string, SyncRefusalHold>());
      for (const src of sources) {
        if (onlySourceIds && !onlySourceIds.has(src.id)) continue;
        if (skipRefusedSync(refusalHolds, src.id, jsonMode)) { decisions.push({ source_id: src.id, outcome: 'skipped' }); continue; }
        if (isConnectorSourceKind(parseSourceConfig(src.config).kind)) {
          await dispatchConnectorFreshnessSync(queue, src, attempted, activationPending, mismatched, { intervalMs, now, slot, timeoutMs, jsonMode });
          continue;
        }
        if (!src.local_path) continue;
        // #4399 / #5198 / P4.2 (supersedes #6465): one predicate decides whether AUTOMATIC sync runs for this source
        // (disabled config, claim awaiting activation, gbrain-owned content directory where sync does not apply); the
        // reason is stated once per source and reason, and an explicit `gbrain sync --source <id>` is unaffected.
        const skip = await automaticSyncSkip(engine, src, activationPending);
        if (skip?.reason !== 'sync_disabled') reportAutomaticSyncSkip(src.id, skip, 'freshness_sync_skipped', jsonMode, (l) => process.stderr.write(l + '\n'));
        if (skip) decisions.push({ source_id: src.id, outcome: 'skipped' });
        if (skip) continue;
        // A local_path this machine cannot use — relative (#3696, #7630: it
        // names whatever directory the daemon runs from) or absent on disk and
        // not a managed clone sync can re-create — would sync a phantom
        // path. Skip loudly (sourceLocalPathSkipWarning carries the
        // fix); under --json the skip is an NDJSON event like every
        // other daemon line on stderr, never bare prose in the stream.
        const skipWarn = sourceLocalPathSkipWarning(src.id, src.local_path, undefined, src.config);
        if (skipWarn) {
          process.stderr.write(
            (jsonMode ? JSON.stringify({ event: 'freshness_source_path_skipped', source_id: src.id, reason: skipWarn }) : skipWarn) + '\n',
          );
          decisions.push({ source_id: src.id, outcome: 'skipped' });
          continue;
        }
        const lastSyncMs = src.last_sync_at ? new Date(src.last_sync_at).getTime() : 0;
        const ageMs = now - lastSyncMs;
        const due = await checkoutFreshness(engine, src, src.local_path, { ageMs, intervalMs, decidedHead: freshnessHeads.get(src.id) });
        if ('decision' in due) { decisions.push(due.decision); continue; }
        const { trigger, head } = due;
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
              idempotency_key: `autopilot-sync:${src.id}:${trigger === 'head' ? `head:${head!.head}` : slot}`,
              max_attempts: 2,
              timeout_ms: timeoutMs,
              // #6706: single-flight per source. A sync job drains until synced or its deadline, so a tick while one runs
              // coalesces into it (waiting or live-lock active) instead of starting a second drainer on the same cursor.
              maxPending: 1,
            },
          );
          if (head) freshnessHeads.set(src.id, head.head);
          decisions.push({ source_id: src.id, outcome: job.coalesced ? 'coalesced' : 'dispatched', trigger, head: head?.head ?? null, job_id: job.id });
          if (jsonMode) {
            process.stderr.write(JSON.stringify({
              event: 'dispatched', job_id: job.id, mode: 'freshness',
              source_id: src.id, age_ms: ageMs, trigger, ...(head ? { head: head.head } : {}),
            }) + '\n');
          } else {
            console.log(`[dispatch] job #${job.id} sync (freshness: ${src.id}; ${trigger === 'head' ? `HEAD ${head!.head.slice(0, 8)} not synced` : `age=${Math.floor(ageMs / 60000)}min`})`);
          }
        } catch (e) {
          decisions.push({ source_id: src.id, outcome: 'failed', trigger, head: head?.head ?? null });
          logError('dispatch.freshness', e);
        }
      }
    }
  } catch (e) {
    logError('dispatch.freshness-gate', e);
  }
  return decisions;
}

export const HEAD_PROBE_MS_DEFAULT = 3_000;
const HEAD_PROBE_FLAG_EVERY_MS = 30_000;
const HEAD_PROBE_LIST_EVERY_MS = 60_000;

export interface HeadProbeDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readHead?: (root: string) => Promise<{ head: string; operation: string | null } | null>;
  dispatch?: typeof dispatchFreshnessSyncs;
  /** True while this process runs a resident commit notifier (lane 2a.1): it, or the host's notifier owner, syncs on commit, so the probe stands down. */
  notifierActive?: () => boolean;
}

/** One probe pass's record: the sources whose HEAD moved past what was synced or decided, and what the dispatch decided. */
export interface HeadProbeRecord { at: number; moved: string[]; decisions: FreshnessDecision[] }

/**
 * GBRA-133 2a.4: the daemon's wait between ticks, HEAD-driven. With `sync.on_commit` on, it reads every checkout's
 * HEAD every `GBRAIN_AUTOPILOT_HEAD_PROBE_MS` (default 3 s, 1 to 30 s; git only, no database read) and runs the freshness
 * dispatch for the sources whose HEAD moved past both their last synced commit and the HEAD this daemon last decided
 * for, so a commit is queued within seconds instead of at the next tick (150 to 600 s). The flag is re-read every 30 s
 * and the source list every 60 s. With the flag off, or while this process runs a resident commit notifier (which owns
 * on-commit syncs for the host), it only sleeps, and the tick's HEAD check stays the trigger.
 * Returns each pass that saw a move (the recorded decisions the tests read).
 */
export async function sleepWatchingHeads(
  engine: BrainEngine,
  state: Pick<AutopilotDaemonState, 'stopping' | 'freshnessHeads'>,
  { sleepMs, baseInterval, jsonMode }: { sleepMs: number; baseInterval: number; jsonMode: boolean },
  deps: HeadProbeDeps = {},
): Promise<HeadProbeRecord[]> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const readHead = deps.readHead ?? readCheckoutHead;
  const dispatch = deps.dispatch ?? dispatchFreshnessSyncs;
  const raw = Number(env.GBRAIN_AUTOPILOT_HEAD_PROBE_MS);
  const probeMs = env.GBRAIN_AUTOPILOT_HEAD_PROBE_MS?.trim() && Number.isFinite(raw) ? Math.min(30_000, Math.max(1_000, Math.round(raw))) : HEAD_PROBE_MS_DEFAULT;
  const records: HeadProbeRecord[] = [];
  const deadline = now() + sleepMs;
  let flagReadAt = -Infinity, enabled = false, listedAt = -Infinity;
  let sources: Array<{ id: string; local_path: string; last_commit: string | null }> = [];
  while (!state.stopping && now() < deadline) {
    await sleep(Math.max(0, Math.min(probeMs, deadline - now())));
    if (state.stopping || now() >= deadline) break;
    try {
      if (now() - flagReadAt >= HEAD_PROBE_FLAG_EVERY_MS) {
        flagReadAt = now();
        enabled = /^(1|true|on|yes)$/i.test((await engine.getConfig(SYNC_ON_COMMIT_KEY))?.trim() ?? '');
      }
      if (!enabled || autopilotPaused() || deps.notifierActive?.()) continue;
      if (now() - listedAt >= HEAD_PROBE_LIST_EVERY_MS) {
        listedAt = now();
        sources = (await loadAllSources(engine)).filter(s => !s.archived && s.local_path && !isConnectorSourceKind(parseSourceConfig(s.config).kind))
          .map(s => ({ id: s.id, local_path: s.local_path!, last_commit: s.last_commit }));
      }
      const moved = new Map<string, string>();
      for (const src of sources) {
        const head = await readHead(src.local_path);
        if (head && !head.operation && head.head !== src.last_commit && head.head !== state.freshnessHeads.get(src.id)) moved.set(src.id, head.head);
      }
      if (!moved.size) continue;
      const { MinionQueue } = await import('../core/minions/queue.ts');
      const slotMs = Math.floor(now() / (baseInterval * 1000)) * baseInterval * 1000;
      const decisions = await dispatch(engine, new MinionQueue(engine), { baseInterval, slot: new Date(slotMs).toISOString(),
        timeoutMs: resolveAutopilotDispatchTimeoutMs(baseInterval, false), jsonMode, freshnessHeads: state.freshnessHeads, onlySourceIds: new Set(moved.keys()) });
      // A source the dispatch skipped or found fresh keeps the HEAD decided, so a skipped source is not re-run every probe;
      // a live sync job or a failed submit leaves it undecided and the next probe tries again.
      for (const d of decisions) {
        const head = moved.get(d.source_id);
        if (head && d.outcome !== 'live_job' && d.outcome !== 'failed') state.freshnessHeads.set(d.source_id, d.head ?? head);
      }
      records.push({ at: now(), moved: [...moved.keys()], decisions });
    } catch (e) {
      logError('dispatch.head-probe', e);
    }
  }
  return records;
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
  mismatched: ReadonlyMap<string, ConnectorAccountMismatch>,
  { intervalMs, now, slot, timeoutMs, jsonMode }: { intervalMs: number; now: number; slot: string; timeoutMs: number; jsonMode: boolean },
): Promise<void> {
  if (isSyncDisabledConfig(src.config)) return;
  if (skipActivationPendingSync(activationPending, src.id, 'freshness_sync_skipped', jsonMode, (l) => process.stderr.write(l + '\n'))) return;
  if (connectorAwaitingFirstSync(src, attempted, jsonMode)) return;
  const mismatch = mismatched.get(src.id);
  if (mismatch) {
    const reason = connectorAccountMismatchSkipWarning(src.id, mismatch);
    process.stderr.write((jsonMode ? JSON.stringify({ event: 'freshness_source_path_skipped', source_id: src.id, code: 'connector_account_changed', reason }) : reason) + '\n');
    return;
  }
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
  const { AI_CHAT_TIMEOUT_MS } = await import('../core/ai/gateway.ts');
  const bounds = resolveAutopilotAutoDrainBounds(timeoutMs, parsePosInt(await engine.getConfig('autopilot.auto_drain.window_seconds'), 120), AI_CHAT_TIMEOUT_MS);
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
        { sourceId: src.id, window: bounds.windowSeconds, ...(kind === 'checkout' ? { repoPath: src.local_path } : {}) },
        {
          queue: 'default',
          idempotency_key: idemKey,
          // issue #3218: the handler now throws on an
          // all-provider-failed batch, so give the queue's
          // backoff a chance (was 1 — dead-lettered instantly).
          max_attempts: 3,
          timeout_ms: bounds.timeoutMs,
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

/** The remediation plan autopilot routes on (brain score + doctor/onboard recommendations); score null when health is degraded. */
async function computeAutopilotPlan(engine: BrainEngine, repoPath: string, jsonMode: boolean) {
  const { computeRecommendations, embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG, chatApiKeyConfigured } = await import('../core/brain-score-recommendations.ts');
  const health = await readTickHealth(engine, jsonMode);
  if (!health) return { health, score: null, plan: [], estTotal: 0 };
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
  return { health, score, plan, estTotal };
}
