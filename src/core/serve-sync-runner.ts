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
 *
 * #6317 (managed brains): a sync_start that carries the CLI's durable `cli`
 * writer registration is an authorization hand-off, not a lifted gate. The
 * shared-secret lane still runs under withLegacySyncDelegation, where
 * assertDurableSyncCaller refuses managed sync by design; the verified lane
 * runs under withVerifiedLocalRegistration instead, so managedSyncAuthority
 * sees the CLI's own principal and its revocation and grant checks apply to
 * every admission. A denied, revoked or stdio registration is refused at
 * sync_start with the OperationError envelope (`refusal`). On a managed brain
 * the verified job runs the managed drain (`performSync` with `drain: true`,
 * the CLI's own path) with the drain's human lines captured per job
 * (withHumanLineSink) for sync_status, where the CLI prints them verbatim.
 * The one-job-at-a-time guard, the per-job deadline, abort and shutdown
 * settle are shared by both lanes. Embeds on the managed lane follow the
 * CLI's effective flags (the managed cursor owns processing options).
 */

import { randomUUID } from 'node:crypto';
import { withLegacySyncDelegation } from './persistence/sync-authority.ts';
import { verifyLocalWriter, withVerifiedLocalRegistration } from './persistence/identity.ts';
import { OperationError } from './ops/contract.ts';
import { trustedCliRequired } from './ops/op-fix.ts';
import { withHumanLineSink } from './console-prefix.ts';
import type { BrainEngine } from './engine.ts';
import { registerBackgroundWorkDrainer } from './background-work.ts';
import {
  isSyncStartRegistration,
  toWireSyncResult,
  validateDelegatedSyncOptions,
  type DelegatedSyncOptions,
  type DelegatedSyncState,
  type SyncAbortResponse,
  type SyncStartRegistration,
  type SyncStartResponse,
  type SyncStatusLine,
  type SyncStatusResponse,
  type WireSyncResult,
} from './context/sync-ipc.ts';
import type { DrainNext, DrainReport } from './persistence/sync-drain.ts';

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
  /** #6317: the job's OperationError envelope, when its failure was one. */
  jobErrorEnvelope?: Record<string, unknown>;
  /** #6317: true when the job ran the managed drain as a verified CLI writer. */
  managed: boolean;
  drain?: DrainReport;
  next?: DrainNext | null;
  /** #6317: the human lines the job printed, numbered from 1; the oldest are dropped past LINE_BUFFER_MAX. */
  lines: SyncStatusLine[];
  lineSeq: number;
  controller: AbortController;
  /** Resolves when the job reaches done/error — the shutdown settle target. */
  settled: Promise<void>;
}

/** Lines retained per job and lines returned per sync_status poll (the response must fit the IPC message cap). */
const LINE_BUFFER_MAX = 2000;
export const LINES_PER_STATUS_MAX = 400;

/** Running job, or the retained last terminal job (replaced by the next start). */
let current: DelegatedSyncJob | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let drainerRegistered = false;

interface DeferredEmbeds {
  pending: Set<string | undefined>;
  controller: AbortController;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  unregister: () => void;
}
/** Each datastore owns its backlog and actual provider/SQL lifetime. */
const deferredEmbeds = new Map<BrainEngine, DeferredEmbeds>();

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
 * layer types it. `opts.registration` is the untrusted #6317 hand-off
 * payload; when present the start is asynchronous (one verification read).
 */
export function startDelegatedSync(engine: BrainEngine, rawOptions: unknown, clientToken: string, opts?: { boundSourceId?: string }): SyncStartResponse;
export function startDelegatedSync(engine: BrainEngine, rawOptions: unknown, clientToken: string, opts: { boundSourceId?: string; registration?: unknown }): SyncStartResponse | Promise<SyncStartResponse>;
export function startDelegatedSync(
  engine: BrainEngine,
  rawOptions: unknown,
  clientToken: string,
  opts: { boundSourceId?: string; registration?: unknown } = {},
): SyncStartResponse | Promise<SyncStartResponse> {
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
  if (opts.registration !== undefined && !isSyncStartRegistration(opts.registration)) {
    return { ok: false, protocol: 2, error: 'invalid_options:registration' };
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
    managed: false,
    lines: [],
    lineSeq: 0,
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
  const settle = (): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    job.finishedAt = Date.now();
  };
  const fail = (e: unknown): void => {
    job.jobError = e instanceof Error ? e.message : String(e);
    if (e instanceof OperationError) job.jobErrorEnvelope = e.toJSON();
    job.state = 'error';
    log(`error job=${job.id}: ${job.jobError}`);
  };

  if (opts.registration !== undefined) {
    return startVerifiedDelegatedSync(engine, job, options, opts.registration as SyncStartRegistration, { settle, fail });
  }

  job.settled = withLegacySyncDelegation(async () => {
    try {
      await (await import('./persistence/maintenance.ts')).assertUnmanagedCanonicalWriter(engine, 'shared-secret sync delegation');
      const { performSync } = await import('../commands/sync.ts');
      const sourceId = await resolveJobSource(engine, job);
      log(
        `start job=${job.id} source=${sourceId ?? 'default'} ` +
        `opts=${JSON.stringify({ ...options, timeoutSeconds: undefined })} deadline=${options.timeoutSeconds}s`,
      );
      const r = await performSync(engine, {
        ...classicSyncOpts(options, sourceId),
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
        scheduleDeferredSyncEmbeds(engine, sourceId);
      }
    } catch (e) {
      fail(e);
    } finally {
      settle();
    }
  });

  return { ok: true, protocol: 2, jobId: job.id };
}

async function resolveJobSource(engine: BrainEngine, job: DelegatedSyncJob): Promise<string | undefined> {
  if (job.sourceId) return job.sourceId;
  const { resolveSourceWithTier } = await import('./source-resolver.ts');
  job.sourceId = (await resolveSourceWithTier(engine, null)).source_id;
  return job.sourceId;
}

function classicSyncOpts(options: DelegatedSyncOptions, sourceId: string | undefined) {
  return {
    sourceId,
    dryRun: options.dryRun,
    full: options.full,
    noPull: options.noPull,
    noExtract: options.noExtract,
    noSchemaPack: options.noSchemaPack,
    skipFailed: options.skipFailed,
    retryFailed: options.retryFailed,
    includeGitignored: options.includeGitignored,
  };
}

/**
 * #6317: the verified lane. The registration is checked before the start is
 * acknowledged (a refusal answers sync_start itself, with the envelope); the
 * job then runs under withVerifiedLocalRegistration, which re-verifies at
 * entry, so a registration revoked between the two reads never runs either.
 * The job slot is already reserved (`current`), so a concurrent sync_start
 * answers `busy` while the verification read is in flight.
 */
async function startVerifiedDelegatedSync(
  engine: BrainEngine,
  job: DelegatedSyncJob,
  options: DelegatedSyncOptions,
  registration: SyncStartRegistration,
  hooks: { settle: () => void; fail: (e: unknown) => void },
): Promise<SyncStartResponse> {
  const refuse = (e: unknown): SyncStartResponse => {
    hooks.fail(e);
    hooks.settle();
    const envelope = e instanceof OperationError ? e.toJSON() : undefined;
    return { ok: false, protocol: 2, jobId: job.id, error: e instanceof OperationError ? e.code : 'permission_denied', ...(envelope ? { refusal: envelope } : {}) };
  };
  let verified: Awaited<ReturnType<typeof verifyLocalWriter>>;
  try { verified = await verifyLocalWriter(engine, registration); }
  catch (e) { return refuse(e); }
  if (verified.remote || verified.principal.kind !== 'local_cli') {
    return refuse(trustedCliRequired('Serve-delegated managed sync requires this host\'s trusted CLI registration; a stdio writer registration cannot run it.'));
  }
  job.managed = true;
  const push = (text: string): void => {
    job.lines.push({ seq: ++job.lineSeq, text });
    if (job.lines.length > LINE_BUFFER_MAX) job.lines.splice(0, job.lines.length - LINE_BUFFER_MAX);
  };
  job.settled = (async () => {
    try {
      await withVerifiedLocalRegistration(engine, registration, () => withHumanLineSink(push, async () => {
        const { performSync } = await import('../commands/sync.ts');
        const sourceId = await resolveJobSource(engine, job);
        const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
        const managed = brain?.enabled === true;
        log(
          `start job=${job.id} source=${sourceId ?? 'default'} writer=${verified.principal.id} managed=${managed} ` +
          `opts=${JSON.stringify({ ...options, timeoutSeconds: undefined })} deadline=${options.timeoutSeconds}s`,
        );
        const r = await performSync(engine, {
          ...classicSyncOpts(options, sourceId),
          // The managed drain is the CLI's own path: the cursor owns processing options, so the CLI's effective
          // flags ride through; the classic path keeps the always-deferred embed rule of the legacy lane.
          ...(managed
            ? { drain: true, noBulk: options.noBulk, lanes: options.lanes, noEmbed: options.noEmbed, explicitProcessing: options.explicitProcessing }
            : { noEmbed: true }),
          signal: job.controller.signal,
          onProgress: (p) => {
            job.phase = p.phase;
            if (p.bankedFiles !== undefined) job.bankedFiles = p.bankedFiles;
          },
        });
        job.result = toWireSyncResult(r);
        job.drain = r.drain;
        if (managed) {
          const { drainNext } = await import('./persistence/sync-drain.ts');
          const { managedSyncResumeArgs, syncResumeCommand } = await import('./sync-reconcile.ts');
          const id = sourceId ?? 'default';
          job.next = drainNext(r, syncResumeCommand(managedSyncResumeArgs({ sourceId: id, processingOptions: options })), id);
        }
        job.state = 'done';
        log(
          `done job=${job.id} status=${r.status} added=${r.added} modified=${r.modified} ` +
          `deleted=${r.deleted}${r.drain ? ` drain=${r.drain.outcome}` : ''} in=${Math.round((Date.now() - job.startedAt) / 1000)}s`,
        );
        if (!managed && !options.dryRun && !options.noEmbed && r.added + r.modified > 0) {
          scheduleDeferredSyncEmbeds(engine, sourceId);
        }
      }));
    } catch (e) {
      hooks.fail(e);
    } finally {
      hooks.settle();
    }
  })();
  return { ok: true, protocol: 2, jobId: job.id };
}

/** Handle a sync_status poll. `afterLine` is the client's line cursor (#6317); lines before it are not resent. */
export function getDelegatedSyncStatus(jobId: string, afterLine = 0): SyncStatusResponse {
  const job = current;
  if (!job || job.id !== jobId) {
    return { ok: false, protocol: 2, error: 'unknown_job' };
  }
  const since = Number.isFinite(afterLine) ? afterLine : 0;
  const lines = job.lines.filter(line => line.seq > since).slice(0, LINES_PER_STATUS_MAX);
  return {
    ok: true,
    protocol: 2,
    state: job.state,
    sourceId: job.sourceId,
    startedAt: job.startedAt,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    phase: job.phase,
    bankedFiles: job.bankedFiles,
    ...(job.managed ? { managed: true, lines, lineSeq: job.lineSeq } : {}),
    ...(job.drain ? { drain: job.drain } : {}),
    ...(job.next !== undefined ? { next: job.next } : {}),
    ...(job.state === 'done' && job.result ? { result: job.result } : {}),
    ...(job.state === 'error' && job.jobError ? { jobError: job.jobError } : {}),
    ...(job.state === 'error' && job.jobErrorEnvelope ? { jobErrorEnvelope: job.jobErrorEnvelope } : {}),
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
    for (const state of deferredEmbeds.values()) {
      state.stopped = true;
      state.controller.abort();
      if (state.timer) clearTimeout(state.timer);
    }
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
  const state = deferredEmbeds.get(engine);
  if (!state || state.stopped || shuttingDown) return;
  if (state.running) return state.running;
  if (!state.pending.size) return;
  if (isDelegatedSyncRunning()) return;
  const work = (async () => {
    const { companyBrainProfile, getCompanyBrainProfile } = await import('./company-brain/profile.ts');
    if (state.pending.has(undefined)) {
      state.pending.delete(undefined);
      const sources = await engine.executeRaw<{ id: string; config: unknown }>('SELECT id,config FROM sources WHERE NOT archived');
      for (const source of sources) if (!companyBrainProfile(source.config)) state.pending.add(source.id);
    }
    for (const source of [...state.pending]) if (source && await getCompanyBrainProfile(engine, source)) state.pending.delete(source);
    if (!state.pending.size) return;
    const { detectCapabilities } = await import('./capability.ts');
    if (!detectCapabilities().embeddings.available) return;
    const { runEmbedCore } = await import('../commands/embed.ts');
    // Snapshot one fair pass. A source queued again during its own provider
    // call stays pending, even when that earlier call reports no stale work.
    for (const sourceId of [...state.pending]) {
      if (state.stopped) break;
      state.pending.delete(sourceId);
      try {
        const r = await runEmbedCore(engine, { stale: true, sourceId, signal: state.controller.signal, quiet: true });
        log(`embed-drain embedded=${r.embedded} failures=${r.failures} source=${sourceId ?? 'all'}`);
        if (r.embedded !== 0 || r.failures !== 0) state.pending.add(sourceId);
      } catch (error) {
        state.pending.add(sourceId);
        log(`embed-drain failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })().catch(error => { log(`embed-drain failed: ${error instanceof Error ? error.message : String(error)}`); });
  state.running = work;
  try { await work; }
  finally { if (state.running === work) state.running = undefined; }
}

/** Shared post-import kick for legacy and authenticated owner delegation. */
export function scheduleDeferredSyncEmbeds(engine: BrainEngine, sourceId?: string): void {
  if (shuttingDown) return;
  let state = deferredEmbeds.get(engine);
  if (!state) {
    state = { pending: new Set(), controller: new AbortController(), stopped: false, unregister: () => {} };
    const owned = state;
    state.unregister = engine.registerBeforeDisconnect(async () => {
      owned.stopped = true;
      owned.controller.abort();
      if (owned.timer) clearTimeout(owned.timer);
      // A provider may ignore abort. The actual promise must settle before
      // disconnect closes the datastore or releases its native owner lock.
      await owned.running?.catch(() => {});
      owned.unregister();
      if (deferredEmbeds.get(engine) === owned) deferredEmbeds.delete(engine);
    });
    deferredEmbeds.set(engine, state);
  }
  if (state.stopped) return;
  state.pending.add(sourceId);
  if (state.timer) return;
  const owned = state;
  state.timer = setTimeout(() => {
    owned.timer = undefined;
    if (owned.stopped) return;
    void maybeDrainDeferredEmbeds(engine);
  }, 5_000);
  state.timer.unref?.();
}

/** Test seam: reset every module singleton (serial tests only). */
export function __resetDelegatedSyncForTests(): void {
  current = null;
  shuttingDown = false;
  shutdownPromise = null;
  for (const state of deferredEmbeds.values()) {
    state.stopped = true; state.controller.abort(); state.unregister();
    if (state.timer) clearTimeout(state.timer);
  }
  deferredEmbeds.clear();
}

/** Test seam: report whether the deferred-embed backlog is pending. */
export function __deferredEmbedsPendingForTests(engine?: BrainEngine): boolean {
  return engine ? !!deferredEmbeds.get(engine)?.pending.size : [...deferredEmbeds.values()].some(state => state.pending.size > 0);
}
