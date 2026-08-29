/**
 * Serve-delegated sync job runner — the serve process's execution half of the
 * sync_start / sync_status / sync_abort IPC kinds (wire shapes + validation in
 * context/sync-ipc.ts; socket plumbing in context/resolve-ipc.ts; CLI half in
 * commands/sync-delegate.ts).
 *
 * One job at a time, in-memory, module-singleton. Correctness does NOT rest on
 * the single-flight guard — performSync still takes the `gbrain-sync:<source>`
 * DB row lock — the guard just answers `busy` fast and keeps the event-loop
 * load bounded. The last TERMINAL job is retained (keyed by clientToken) so a
 * client that lost the start ack can attach to its own finished run instead of
 * starting a duplicate.
 *
 *   sync_start(valid, idle, not shutting down)
 *        │
 *   ┌────▼────┐  abort()/deadline/shutdown  ┌──────────┐
 *   │ running │────────────────────────────▶│ aborting │
 *   └──┬───┬──┘                             └────┬─────┘
 *      │   │ performSync throws                  │ settles (typed partial)
 *      ▼   ▼                                     ▼
 *   ┌──────┐ ┌───────┐        done │ error (retained until next start)
 *   │ done │ │ error │
 *   └──────┘ └───────┘
 *
 * Shutdown contract: shutdownDelegatedSync() is an IDEMPOTENT SHARED promise —
 * serve.ts's beginShutdown and mcp/server.ts's shutdown both race here on
 * every signal, and the second caller must await the first, never double-run.
 * It must be awaited BEFORE engine.disconnect(): the disconnect-mode drain
 * passes allowAbort:false and runs after `_db` is early-nulled, so a job's
 * settle writes (final checkpoint flush, row-lock release) only succeed
 * against the still-live engine. The registered BackgroundWorkDrainer is a
 * BACKSTOP for disconnect paths that never called us, not the primary path.
 *
 * Embeds: delegated jobs ALWAYS run with noEmbed (the #2139 inline cost gate
 * lives in runSync, which a delegated run never passes through) and this
 * module drains them afterwards via maybeDrainDeferredEmbeds — the lock owner
 * closes its own embedding loop. NOT submitEmbedBackfill: on PGLite nothing
 * drains minion_jobs (workers refuse the engine) and a stuck `waiting` row
 * cooldown-blocks every later submit.
 */

import { randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { registerBackgroundWorkDrainer } from './background-work.ts';
import {
  toWireSyncResult,
  validateDelegatedSyncOptions,
  type DelegatedSyncState,
  type SyncAbortResponse,
  type SyncStartResponse,
  type SyncStatusResponse,
  type WireSyncResult,
} from './context/sync-ipc.ts';

interface DelegatedSyncJob {
  id: string;
  clientToken: string;
  state: DelegatedSyncState;
  sourceId?: string;
  startedAt: number;
  finishedAt?: number;
  phase?: string;
  bankedFiles?: number;
  result?: WireSyncResult;
  jobError?: string;
  controller: AbortController;
  /** Resolves when the job reaches done/error — the shutdown settle target. */
  settled: Promise<void>;
}

/** Running job, or the retained last terminal job (replaced by the next start). */
let current: DelegatedSyncJob | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let drainerRegistered = false;

/** Deferred-embed drain state (see maybeDrainDeferredEmbeds). */
let deferredEmbedsPending = false;
let deferredEmbedSourceId: string | undefined;
let embedDrainRunning = false;
let embedDrainController = new AbortController();

const isTerminal = (s: DelegatedSyncState): boolean => s === 'done' || s === 'error';

function log(msg: string): void {
  process.stderr.write(`[serve-sync] ${msg}\n`);
}

/**
 * Bound on the shutdown settle wait (ms). serve.ts extends its cleanup
 * deadline by exactly this much while a job is running, so the settle always
 * fits inside the deadline that would otherwise force-exit at 5s.
 */
export function delegatedSyncSettleMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.GBRAIN_SERVE_SYNC_SETTLE_MS ?? '3000');
  if (!Number.isFinite(raw) || raw < 0) return 3000;
  return Math.min(raw, 60_000);
}

/** True while a delegated job occupies the event loop (sweep ticks skip). */
export function isDelegatedSyncRunning(): boolean {
  return current !== null && !isTerminal(current.state);
}

/**
 * Handle a sync_start request. `rawOptions` is the untrusted wire payload —
 * validated here (the runner is the single authority) even though the IPC
 * layer types it.
 */
export function startDelegatedSync(
  engine: BrainEngine,
  rawOptions: unknown,
  clientToken: string,
  opts: { boundSourceId?: string } = {},
): SyncStartResponse {
  if (typeof clientToken !== 'string' || clientToken.length === 0 || clientToken.length > 128) {
    return { ok: false, protocol: 2, error: 'invalid_options:clientToken' };
  }
  // Token attach: a retry after a lost ack finds its own job — running
  // (attach and keep polling) or retained-terminal (fetch the result) —
  // instead of erroring or duplicate-running.
  if (current && current.clientToken === clientToken) {
    return isTerminal(current.state)
      ? { ok: true, protocol: 2, jobId: current.id, completed: true }
      : { ok: true, protocol: 2, jobId: current.id };
  }
  if (shuttingDown) {
    return { ok: false, protocol: 2, error: 'shutting_down' };
  }
  if (current && !isTerminal(current.state)) {
    return { ok: false, protocol: 2, error: 'busy', jobId: current.id };
  }
  const v = validateDelegatedSyncOptions(rawOptions);
  if (!v.ok) return { ok: false, protocol: 2, error: v.error };
  const options = v.options;
  if (options.sourceId && opts.boundSourceId && options.sourceId !== opts.boundSourceId) {
    return { ok: false, protocol: 2, error: 'source_mismatch' };
  }

  const controller = new AbortController();
  const job: DelegatedSyncJob = {
    id: randomUUID(),
    clientToken,
    state: 'running',
    sourceId: options.sourceId ?? opts.boundSourceId,
    startedAt: Date.now(),
    controller,
    settled: Promise.resolve(),
  };
  current = job;
  ensureDrainerRegistered();

  // Per-job hard deadline: 0 is the single unbounded encoding (an explicit
  // --no-hard-deadline); every other value keeps the job bounded even when
  // the polling client died.
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (options.timeoutSeconds > 0) {
    deadlineTimer = setTimeout(() => {
      if (!isTerminal(job.state)) {
        log(`abort job=${job.id} reason=deadline after ${options.timeoutSeconds}s`);
        job.state = 'aborting';
        controller.abort();
      }
    }, options.timeoutSeconds * 1000);
    deadlineTimer.unref?.();
  }

  job.settled = (async () => {
    try {
      const { performSync } = await import('../commands/sync.ts');
      let sourceId = job.sourceId;
      if (!sourceId) {
        const { resolveSourceWithTier } = await import('./source-resolver.ts');
        sourceId = (await resolveSourceWithTier(engine, null)).source_id;
        job.sourceId = sourceId;
      }
      log(
        `start job=${job.id} source=${sourceId ?? 'default'} ` +
        `opts=${JSON.stringify({ ...options, timeoutSeconds: undefined })} deadline=${options.timeoutSeconds}s`,
      );
      const r = await performSync(engine, {
        sourceId,
        dryRun: options.dryRun,
        full: options.full,
        noPull: options.noPull,
        noExtract: options.noExtract,
        noSchemaPack: options.noSchemaPack,
        skipFailed: options.skipFailed,
        retryFailed: options.retryFailed,
        includeGitignored: options.includeGitignored,
        // ALWAYS deferred — see module header. Drained by maybeDrainDeferredEmbeds.
        noEmbed: true,
        signal: controller.signal,
        onProgress: (p) => {
          job.phase = p.phase;
          if (p.bankedFiles !== undefined) job.bankedFiles = p.bankedFiles;
        },
      });
      job.result = toWireSyncResult(r);
      job.state = 'done';
      log(
        `done job=${job.id} status=${r.status} added=${r.added} modified=${r.modified} ` +
        `deleted=${r.deleted} in=${Math.round((Date.now() - job.startedAt) / 1000)}s`,
      );
      // Wire noEmbed means the USER declined embeds — honor it by skipping
      // the drain too (performSync above always ran noEmbed regardless).
      if (!options.dryRun && !options.noEmbed && r.added + r.modified > 0) {
        deferredEmbedsPending = true;
        deferredEmbedSourceId = sourceId;
        scheduleEmbedDrain(engine);
      }
    } catch (e) {
      job.jobError = e instanceof Error ? e.message : String(e);
      job.state = 'error';
      log(`error job=${job.id}: ${job.jobError}`);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      job.finishedAt = Date.now();
    }
  })();

  return { ok: true, protocol: 2, jobId: job.id };
}

/** Handle a sync_status poll. */
export function getDelegatedSyncStatus(jobId: string): SyncStatusResponse {
  const job = current;
  if (!job || job.id !== jobId) {
    return { ok: false, protocol: 2, error: 'unknown_job' };
  }
  return {
    ok: true,
    protocol: 2,
    state: job.state,
    sourceId: job.sourceId,
    startedAt: job.startedAt,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    phase: job.phase,
    bankedFiles: job.bankedFiles,
    ...(job.state === 'done' && job.result ? { result: job.result } : {}),
    ...(job.state === 'error' && job.jobError ? { jobError: job.jobError } : {}),
  };
}

/** Handle a sync_abort request — cooperative; the client keeps polling to settle. */
export function abortDelegatedSync(jobId: string): SyncAbortResponse {
  const job = current;
  if (!job || job.id !== jobId) {
    return { ok: false, protocol: 2, error: 'unknown_job' };
  }
  if (!isTerminal(job.state)) {
    log(`abort job=${job.id} reason=client`);
    job.state = 'aborting';
    job.controller.abort();
  }
  return { ok: true, protocol: 2, state: job.state };
}

/**
 * Idempotent shutdown settle: abort the running job and wait (bounded) for its
 * settle writes to land against the still-live engine. Both serve shutdown
 * paths call this BEFORE engine.disconnect(); the second caller awaits the
 * first run. New sync_start requests refuse with 'shutting_down' from the
 * first call onward. Never throws.
 */
export function shutdownDelegatedSync(timeoutMs?: number): Promise<void> {
  shuttingDown = true;
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    try { embedDrainController.abort(); } catch { /* noop */ }
    const job = current;
    if (!job || isTerminal(job.state)) return;
    log(`abort job=${job.id} reason=shutdown`);
    job.state = 'aborting';
    job.controller.abort();
    const bound = timeoutMs ?? delegatedSyncSettleMs();
    await Promise.race([
      job.settled,
      new Promise<void>((r) => { const t = setTimeout(r, bound); t.unref?.(); }),
    ]);
    if (!isTerminal(job.state)) {
      log(`shutdown settle bound (${timeoutMs ?? delegatedSyncSettleMs()}ms) elapsed with job=${job.id} unsettled; proceeding (checkpoint resume covers the tail)`);
    }
  })().catch(() => { /* never throws */ });
  return shutdownPromise;
}

/**
 * BACKSTOP for disconnect paths that never awaited shutdownDelegatedSync().
 * The disconnect-mode drain runs with allowAbort:false after `_db` is nulled,
 * so this drain aborts inline and waits within the registry's bound; settle
 * writes may fail 'not connected' there — intended, resume covers it.
 */
function ensureDrainerRegistered(): void {
  if (drainerRegistered) return;
  drainerRegistered = true;
  registerBackgroundWorkDrainer({
    name: 'serve-delegated-sync',
    order: 40,
    async drain(timeoutMs: number): Promise<{ unfinished: number }> {
      const job = current;
      if (!job || isTerminal(job.state)) return { unfinished: 0 };
      job.state = 'aborting';
      job.controller.abort();
      await Promise.race([
        job.settled,
        new Promise<void>((r) => { const t = setTimeout(r, timeoutMs); t.unref?.(); }),
      ]);
      return { unfinished: isTerminal(job.state) ? 0 : 1 };
    },
  });
}

/**
 * Deferred-embed drain — the lock owner's replacement for the inline embed
 * step delegated jobs skip. Bounded per invocation by runEmbedCore's internal
 * wall clock; `pending` clears only when a run finds nothing left to embed,
 * so successive idle ticks converge on a fully-embedded brain. Keyless rule:
 * no embedding provider ⇒ leave pending (a later keyed serve drains it).
 * Never throws.
 */
export async function maybeDrainDeferredEmbeds(engine: BrainEngine): Promise<void> {
  if (!deferredEmbedsPending || embedDrainRunning || shuttingDown) return;
  if (isDelegatedSyncRunning()) return;
  embedDrainRunning = true;
  try {
    const { detectCapabilities } = await import('./capability.ts');
    if (!detectCapabilities().embeddings.available) return;
    const { runEmbedCore } = await import('../commands/embed.ts');
    const r = await runEmbedCore(engine, {
      stale: true,
      sourceId: deferredEmbedSourceId,
      signal: embedDrainController.signal,
    });
    log(`embed-drain embedded=${r.embedded} failures=${r.failures} source=${deferredEmbedSourceId ?? 'all'}`);
    // Nothing left to embed and nothing failing ⇒ the deferred backlog is done.
    if (r.embedded === 0 && r.failures === 0) {
      deferredEmbedsPending = false;
      deferredEmbedSourceId = undefined;
    }
  } catch (e) {
    log(`embed-drain failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    embedDrainRunning = false;
  }
}

/** One-shot post-job kick so embeds don't wait for the next 10-min idle tick. */
function scheduleEmbedDrain(engine: BrainEngine): void {
  const t = setTimeout(() => {
    void maybeDrainDeferredEmbeds(engine);
  }, 5_000);
  t.unref?.();
}

/** Test seam: reset every module singleton (serial tests only). */
export function __resetDelegatedSyncForTests(): void {
  current = null;
  shuttingDown = false;
  shutdownPromise = null;
  deferredEmbedsPending = false;
  deferredEmbedSourceId = undefined;
  embedDrainRunning = false;
  embedDrainController = new AbortController();
}

/** Test seam: report whether the deferred-embed backlog is pending. */
export function __deferredEmbedsPendingForTests(): boolean {
  return deferredEmbedsPending;
}
