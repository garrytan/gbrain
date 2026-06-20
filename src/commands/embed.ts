import type { BrainEngine } from '../core/engine.ts';
import { embedBatch, currentEmbeddingSignature } from '../core/embedding.ts';
import type { ChunkInput } from '../core/types.ts';
import { chunkText } from '../core/chunkers/recursive.ts';
import { createProgress, type ProgressReporter } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { assertEmbeddingEnabled } from '../core/embedding-dim-check.ts';
import { loadConfig } from '../core/config.ts';
import { slog, serr } from '../core/console-prefix.ts';
import { filterOutEmbedSkipped } from '../core/embed-skip.ts';
import { runSlidingPool } from '../core/worker-pool.ts';
import { isAborted, anySignal, AbortError } from '../core/abort-check.ts';
import { type DbPacer, createDbPacer, createNoopPacer, observed } from '../core/db-pacer.ts';
import {
  resolvePaceMode,
  loadPaceModeConfig,
  readPaceEnv,
  type PaceKeyOverrides,
} from '../core/pace-mode.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../core/db-lock.ts';
import { embedBackfillLockId } from '../core/embed-backfill-lock.ts';

export interface EmbedOpts {
  /** Embed ALL pages (every chunk). */
  all?: boolean;
  /** Embed only stale chunks (missing embedding). */
  stale?: boolean;
  /** Embed specific pages by slug. */
  slugs?: string[];
  /** Embed a single page. */
  slug?: string;
  /**
   * v0.31.12: scope to a specific source. When set, only pages from this
   * source are embedded. When omitted, all sources are processed (but
   * source_id is still threaded correctly per-page via Page.source_id).
   */
  sourceId?: string;
  /**
   * Dry run: enumerate what WOULD be embedded (stale chunk counts)
   * without calling the embedding model or writing to the engine.
   * Safe to call with no API key. Used by runCycle's dryRun propagation.
   */
  dryRun?: boolean;
  /**
   * Optional progress callback. Called after each page. CLI wrappers
   * supply a reporter.tick()-backed implementation; Minion handlers
   * supply a job.updateProgress()-backed one so per-job progress lives
   * in the DB where `gbrain jobs get` can read it.
   */
  onProgress?: (done: number, total: number, embedded: number) => void;
  /**
   * v0.41.18.0 (A13): override the hardcoded PAGE_SIZE=2000 page-batch.
   * Smaller batches give finer progress granularity; larger batches
   * reduce per-batch coordination cost. Caps internally to 10K to
   * keep memory bounded.
   */
  batchSize?: number;
  /**
   * v0.41.18.0 (A13): when 'recent', walks the stale-chunk pool in
   * page.updated_at DESC order (recent-modified pages first) instead
   * of the legacy stable (page_id, chunk_index) order. Threads through
   * to listStaleChunks orderBy='updated_desc'. Backed by the
   * content_chunks_stale_idx partial + idx_pages_updated_at_desc indexes
   * (v100).
   */
  priority?: 'recent';
  /**
   * v0.41.18.0 (A13): catch-up mode removes the wall-clock cap and loops
   * until countStaleChunks() returns 0. Used by `gbrain embed --stale
   * --catch-up` and by the embed-catch-up Minion handler that the onboard
   * remediation submits on big stale backlogs.
   */
  catchUp?: boolean;
  /**
   * #1737: cooperative-abort signal from the Minions worker (wall-clock
   * timeout, lock loss, SIGTERM). When it fires, the embed loops break
   * cleanly with partial progress preserved so the autopilot cycle's
   * finally can release `gbrain_cycle_locks` instead of running for the
   * full 10-15 min embed phase after the job was already killed. Composed
   * with the internal wall-clock budget timer via `anySignal`.
   */
  signal?: AbortSignal;
  /**
   * DB-contention pacing (paced-backfill). Raw inputs resolved in
   * runEmbedCore via env > config > bundle (env beats config = incident
   * escape hatch). `perCallMode` is from `--pace[=mode]`; `perCall` from
   * `--pace-max-concurrency` etc. Absent ⇒ resolves from env/config (so a
   * queued job paced by config alone still throttles). Mode `off` ⇒ no-op.
   */
  pace?: {
    perCallMode?: string;
    perCall?: PaceKeyOverrides;
  };
  /**
   * When the pace overrides were SERIALIZED from a background-job payload (not
   * typed at an interactive CLI), resolve them at the config tier so
   * `GBRAIN_PACE_*` on the worker still overrides at execution (Codex P2). Set
   * by the `embed` job handler; unset for interactive CLI runs.
   */
  paceFromBackground?: boolean;
  /**
   * E-2 (paced-backfill): single-flight the stale run by taking the SAME
   * per-source lock the `embed-backfill` minion handler uses, so a hand-run CLI
   * backfill and a queued job can't grind the same source at once (closing the
   * NULL→non-NULL upsert race window that paced — longer — runs widen). Set
   * ONLY by the CLI (`runEmbed`); the minion path already locks. All-source
   * runs lock every source in sorted order. dryRun skips it.
   */
  singleFlight?: boolean;
}

/**
 * Structured result from a library-level embed run.
 *
 * In dryRun mode, `embedded = 0` and `would_embed` holds the count of
 * stale chunks that WOULD have been sent to the embedding model. In
 * non-dryRun mode, `embedded` holds the real count and `would_embed = 0`.
 * `skipped` counts chunks that already had embeddings (nothing to do).
 */
export interface EmbedResult {
  /** Chunks newly embedded in this run (0 in dryRun). */
  embedded: number;
  /** Chunks with pre-existing embeddings, skipped. */
  skipped: number;
  /** Chunks that would be embedded if not for dryRun (0 in non-dryRun). */
  would_embed: number;
  /** Total chunks considered across all processed pages. */
  total_chunks: number;
  /** Number of pages processed (whether or not they had stale chunks). */
  pages_processed: number;
  /** True if this run was a dry-run. */
  dryRun: boolean;
  /**
   * E1 (paced-backfill): end-of-run pacing telemetry. Present ONLY when pacing
   * was active (enabled bundle). The number the operator could not get from an
   * external wrapper ("zero pauses" ≠ "queue safe").
   */
  pacing?: {
    maxConcurrency: number;
    /** In-band latency samples folded into the EWMA. */
    samples: number;
    /** Final EWMA of observed DB-op latency (ms), or null if no samples. */
    ewmaMs: number | null;
    /** Cumulative cooperative-sleep time (ms). */
    totalSleptMs: number;
    /** Number of cooperative sleeps. */
    sleeps: number;
    /** High-water mark of acquirers blocked on the permit (sync path). */
    maxWaiters: number;
  };
}

/**
 * Library-level embed. Throws on validation errors; per-page embed failures
 * are logged to stderr but do not throw (matches the existing CLI semantics
 * for batch runs). Safe to call from Minions handlers — no process.exit.
 *
 * Returns EmbedResult with accurate counts so callers (runCycle, sync
 * auto-embed step) can report embeddings in their own structured output.
 */
/**
 * Tagged error class thrown when the schema column dim disagrees with
 * the gateway's resolved dim. Caught by `runEmbed` (the CLI wrapper) to
 * emit a paste-ready recipe instead of raw Postgres errors page by page.
 *
 * v0.37 fix wave (Lane D.2 + CDX2-9). Pre-fix the worker pool ran the
 * whole queue past the first dim mismatch because per-page errors were
 * silently logged + skipped. Now `runEmbedCore` pre-flights at entry +
 * the worker pool catches per-page mismatches and surfaces them.
 */
export class EmbeddingDimMismatchError extends Error {
  readonly kind = 'embedding_dim_mismatch' as const;
  constructor(public readonly recipeMessage: string) {
    super(recipeMessage);
    this.name = 'EmbeddingDimMismatchError';
  }
}

/**
 * Pre-flight check: read the actual schema column dim and compare to the
 * gateway's resolved dim. Throws `EmbeddingDimMismatchError` on mismatch
 * so the entry-point catch surfaces the recipe. Catches the headline
 * fresh-install bug class at the very first invocation instead of letting
 * the worker pool hammer N pages with raw 22000 errors.
 */
async function preflightDimMismatch(engine: BrainEngine, dryRun: boolean): Promise<void> {
  if (dryRun) return; // dry-run never embeds, no risk
  const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
  const { getEmbeddingDimensions, getEmbeddingModel } = await import('../core/ai/gateway.ts');
  let existing;
  try {
    existing = await readContentChunksEmbeddingDim(engine);
  } catch {
    return; // probe failure shouldn't block embed; the worker pool will surface real errors
  }
  if (!existing.exists || existing.dims === null) return;
  let resolvedDims: number;
  let resolvedModel: string;
  try {
    resolvedDims = getEmbeddingDimensions();
    resolvedModel = getEmbeddingModel();
  } catch {
    return; // gateway unconfigured — worker pool will error informatively
  }
  if (existing.dims === resolvedDims) return;
  const databasePath = (engine as { _savedConfig?: { database_path?: string } })._savedConfig?.database_path;
  const recipe = embeddingMismatchMessage({
    currentDims: existing.dims,
    requestedDims: resolvedDims,
    requestedModel: resolvedModel,
    source: 'embed',
    engineKind: engine.kind,
    databasePath,
  });
  throw new EmbeddingDimMismatchError(recipe);
}

export async function runEmbedCore(engine: BrainEngine, opts: EmbedOpts): Promise<EmbedResult> {
  // v0.37.10.0 T7 (D9): refuse cleanly when init persisted the deferred-setup
  // sentinel. Skipped in dryRun mode so plan-mode introspection still works.
  if (!opts.dryRun) {
    assertEmbeddingEnabled(loadConfig());
  }

  // v0.41.6.0 D1: preflight embedding credentials. Skipped in dryRun mode
  // so plan-mode introspection still works (no provider calls needed).
  //
  // runEmbedCore is a LIBRARY function called from both the CLI (runEmbed)
  // and the cycle (runCycle's embed phase + autopilot-cycle handler). THROW
  // EmbeddingCredentialError so the cycle's per-phase try/catch can
  // gracefully fail-the-phase without killing the worker process. The CLI
  // wrapper at src/commands/embed.ts:runEmbed catches and exits.
  if (!opts.dryRun) {
    const { validateEmbeddingCreds } = await import('../core/embed-preflight.ts');
    validateEmbeddingCreds();
  }

  // v0.37.11.0 (Lane D.2): pre-flight dim-mismatch check. Catches the headline
  // fresh-install bug class before the worker pool spends 20 parallel calls
  // hitting raw Postgres dimension errors.
  await preflightDimMismatch(engine, !!opts.dryRun);

  const result: EmbedResult = {
    embedded: 0,
    skipped: 0,
    would_embed: 0,
    total_chunks: 0,
    pages_processed: 0,
    dryRun: !!opts.dryRun,
  };

  if (opts.slugs && opts.slugs.length > 0) {
    for (const s of opts.slugs) {
      if (isAborted(opts.signal)) break; // #1737: stop the per-slug loop on abort
      try {
        await embedPage(engine, s, !!opts.dryRun, result, opts.sourceId, opts.signal);
      } catch (e: unknown) {
        serr(`  Error embedding ${s}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return result;
  }
  if (opts.all || opts.stale) {
    // E-2 (paced-backfill): CLI single-flight. Take the SAME per-source lock as
    // the embed-backfill minion handler so a hand-run backfill and a queued job
    // are mutually exclusive per source. All-source runs lock every source in
    // sorted (deterministic) order to avoid acquire-order deadlock. Released in
    // the finally below. Skipped for dryRun and when the caller didn't opt in
    // (cycle / catch-up / sync-auto-embed callers never single-flight).
    const sfLocks: DbLockHandle[] = [];
    if (opts.singleFlight && opts.stale && !opts.dryRun) {
      let lockSourceIds: string[];
      if (opts.sourceId) {
        lockSourceIds = [opts.sourceId];
      } else {
        try {
          const rows = await engine.listAllSources();
          lockSourceIds = rows.map((r) => r.id).sort();
        } catch {
          lockSourceIds = [];
        }
      }
      for (const sid of lockSourceIds) {
        let lock: DbLockHandle | null = null;
        try {
          lock = await tryAcquireDbLock(engine, embedBackfillLockId(sid), 60);
        } catch {
          // Fail-open: a lock-subsystem error must not crash a backfill. Drop
          // single-flight for this run (release what we took) and proceed.
          for (const h of sfLocks) {
            try { await h.release(); } catch { /* best-effort */ }
          }
          sfLocks.length = 0;
          break;
        }
        if (!lock) {
          // Another backfill (CLI or job) holds this source. Release what we
          // took and bail cleanly rather than racing the upsert path.
          for (const h of sfLocks) {
            try { await h.release(); } catch { /* best-effort */ }
          }
          serr(`  [embed] another backfill is already running for source "${sid}"; skipping (single-flight).`);
          return result;
        }
        sfLocks.push(lock);
      }
    }

    // Resolve DB-contention pacing (env > config > bundle; env is the
    // incident escape hatch). dryRun skips it — no writes to pace. A
    // disabled bundle yields a no-op pacer (zero overhead on the hot path).
    let pacer: DbPacer = createNoopPacer();
    let paceMaxConcurrency: number | undefined;
    if (!opts.dryRun) {
      try {
        const cfg = await loadPaceModeConfig(engine);
        const { envMode, envOverrides } = readPaceEnv();
        // Codex P2: an interactive CLI flag (--pace) is the most immediate
        // intent and sits at the per-call tier (beats env). But a flag
        // SERIALIZED into a background job payload must sit at the CONFIG tier
        // so GBRAIN_PACE_* on the worker can still override it at execution
        // (incident escape hatch). paceFromBackground distinguishes the two.
        const fromBg = !!opts.paceFromBackground;
        const knobs = resolvePaceMode({
          mode: fromBg ? (opts.pace?.perCallMode ?? cfg.mode) : cfg.mode,
          configOverrides: fromBg
            ? { ...cfg.configOverrides, ...(opts.pace?.perCall ?? {}) }
            : cfg.configOverrides,
          envMode,
          envOverrides,
          perCallMode: fromBg ? undefined : opts.pace?.perCallMode,
          perCall: fromBg ? undefined : opts.pace?.perCall,
        });
        if (knobs.enabled) {
          pacer = createDbPacer({ bundle: knobs });
          paceMaxConcurrency = knobs.maxConcurrency;
        }
      } catch {
        // Fail-open: pacing must never break a backfill.
        pacer = createNoopPacer();
      }
    }
    try {
      await embedAll(engine, !!opts.stale, !!opts.dryRun, result, opts.onProgress, opts.sourceId, {
        batchSize: opts.batchSize,
        priority: opts.priority,
        catchUp: opts.catchUp,
        pacer,
        paceMaxConcurrency,
      }, opts.signal);
    } finally {
      // E1: surface pacing telemetry (human + structured) when pacing was on.
      const snap = pacer.snapshot();
      if (snap.enabled) {
        result.pacing = {
          maxConcurrency: snap.maxConcurrency,
          samples: snap.sampleCount,
          ewmaMs: snap.ewmaMs,
          totalSleptMs: snap.totalSleptMs,
          sleeps: snap.sleepCount,
          maxWaiters: snap.maxWaiters,
        };
        serr(
          `  [embed] pacing: cap=${snap.maxConcurrency} samples=${snap.sampleCount} ` +
            `ewma=${snap.ewmaMs === null ? 'n/a' : Math.round(snap.ewmaMs) + 'ms'} ` +
            `slept=${snap.totalSleptMs}ms/${snap.sleepCount}`,
        );
      }
      pacer.dispose();
      // E-2: release single-flight locks (reverse order). Best-effort; the
      // lock TTL is the backstop if a release fails.
      for (const h of sfLocks.reverse()) {
        try { await h.release(); } catch { /* best-effort; TTL covers it */ }
      }
    }
    return result;
  }
  if (opts.slug) {
    await embedPage(engine, opts.slug, !!opts.dryRun, result, opts.sourceId, opts.signal);
    return result;
  }
  throw new Error('No embed target specified. Pass { slug }, { slugs }, { all }, or { stale }.');
}

/**
 * Parse the `--pace` family from a CLI arg list. Returns ONLY the explicit
 * overrides (CX5: never the full resolved bundle) so they can be serialized
 * into a background-job payload and re-resolved (env > config > bundle) at
 * execution. Returns undefined when no pace flag is present.
 *
 * Recognized: `--pace` (bare ⇒ balanced), `--pace=<mode>`,
 * `--pace-max-concurrency=<n>` / `--pace-max-concurrency <n>`.
 */
export function parsePaceArgs(
  args: string[],
): { perCallMode?: string; perCall?: PaceKeyOverrides } | undefined {
  let perCallMode: string | undefined;
  let perCall: PaceKeyOverrides | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pace') {
      perCallMode = 'balanced';
    } else if (a.startsWith('--pace=')) {
      perCallMode = a.slice('--pace='.length) || 'balanced';
    } else if (a.startsWith('--pace-max-concurrency=')) {
      const n = parseInt(a.slice('--pace-max-concurrency='.length), 10);
      if (Number.isFinite(n) && n >= 1) (perCall ??= {}).maxConcurrency = n;
    } else if (a === '--pace-max-concurrency') {
      const n = parseInt(args[i + 1] ?? '', 10);
      if (Number.isFinite(n) && n >= 1) (perCall ??= {}).maxConcurrency = n;
      i++; // consume the value token so positional parsing can't read it as a slug (Codex P2)
    }
  }
  if (perCallMode === undefined && perCall === undefined) return undefined;
  return { ...(perCallMode !== undefined && { perCallMode }), ...(perCall && { perCall }) };
}

export async function runEmbed(engine: BrainEngine, args: string[]): Promise<EmbedResult | undefined> {
  // v0.36+ T7: --background submits via Minion queue, returns job_id to
  // stdout, exits. Same semantics in TTY and cron (D9).
  if (args.includes('--background')) {
    const { maybeBackground } = await import('../core/cli-options.ts');
    const backgrounded = await maybeBackground({
      engine,
      args,
      jobName: 'embed',
      paramBuilder: (cleanArgs) => {
        const slugsI = cleanArgs.indexOf('--slugs');
        const srcI = cleanArgs.indexOf('--source');
        return {
          all: cleanArgs.includes('--all'),
          stale: cleanArgs.includes('--stale'),
          dryRun: cleanArgs.includes('--dry-run'),
          slugs: slugsI >= 0 ? cleanArgs.slice(slugsI + 1).filter(a => !a.startsWith('--')) : undefined,
          sourceId: srcI >= 0 ? cleanArgs[srcI + 1] : undefined,
          // CX1+CX5: carry explicit pace overrides into the `embed` job payload
          // (the job name CLI --background actually submits). The handler
          // re-resolves env > config > bundle at execution.
          ...(parsePaceArgs(cleanArgs) && { pace: parsePaceArgs(cleanArgs) }),
        };
      },
      source: 'cli',
    });
    if (backgrounded) return;
    // PGLite degraded to inline — fall through.
  }

  const slugsIdx = args.indexOf('--slugs');
  const all = args.includes('--all');
  const stale = args.includes('--stale');
  const dryRun = args.includes('--dry-run');
  // v0.31.12: --source <id> scopes to a single source.
  const sourceIdx = args.indexOf('--source');
  const sourceId = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;
  // v0.41.18.0 (A13): --batch-size N, --priority recent, --catch-up flags.
  const batchSizeIdx = args.indexOf('--batch-size');
  const batchSizeRaw = batchSizeIdx >= 0 ? args[batchSizeIdx + 1] : undefined;
  const batchSize = batchSizeRaw ? Math.max(1, Math.min(10_000, parseInt(batchSizeRaw, 10) || 0)) : undefined;
  const priorityIdx = args.indexOf('--priority');
  const priorityRaw = priorityIdx >= 0 ? args[priorityIdx + 1] : undefined;
  const priority = priorityRaw === 'recent' ? 'recent' as const : undefined;
  const catchUp = args.includes('--catch-up');
  const pace = parsePaceArgs(args);

  let opts: EmbedOpts;
  if (slugsIdx >= 0) {
    opts = { slugs: args.slice(slugsIdx + 1).filter(a => !a.startsWith('--')), dryRun, sourceId, batchSize, priority, catchUp };
  } else if (all || stale) {
    // E-2: CLI-only single-flight for stale runs (the minion path locks itself).
    opts = { all, stale, dryRun, sourceId, batchSize, priority, catchUp, ...(pace && { pace }), ...(stale && { singleFlight: true }) };
  } else {
    const slug = args.find(a => !a.startsWith('--'));
    if (!slug) {
      serr('Usage: gbrain embed [<slug>|--all|--stale|--slugs s1 s2 ...] [--dry-run] [--batch-size N] [--priority recent] [--catch-up]');
      process.exit(1);
    }
    opts = { slug, dryRun, sourceId, batchSize, priority, catchUp };
  }

  // CLI path: wire a reporter so --progress-json / --quiet / TTY rendering
  // all work. Minion handlers call runEmbedCore directly with their own
  // onProgress (see jobs.ts).
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  let progressStarted = false;
  opts.onProgress = (done, total, _embedded) => {
    if (!progressStarted) {
      progress.start('embed.pages', total);
      progressStarted = true;
    }
    progress.tick(1);
  };

  try {
    const result = await runEmbedCore(engine, opts);
    if (progressStarted) progress.finish();
    return result;
  } catch (e) {
    if (progressStarted) progress.finish();
    // v0.41.6.0 D1: preflight throws EmbeddingCredentialError; surface the
    // paste-ready userMessage instead of the bare exception text.
    const { EmbeddingCredentialError } = await import('../core/embed-preflight.ts');
    if (e instanceof EmbeddingCredentialError) {
      serr('');
      serr(e.userMessage);
      serr('');
    } else if (e instanceof EmbeddingDimMismatchError) {
      // D.2: surface dim-mismatch failures with the paste-ready recipe
      // instead of the raw Postgres error message.
      serr('\n' + e.recipeMessage + '\n');
    } else {
      serr(e instanceof Error ? e.message : String(e));
    }
    process.exit(1);
  }
}

async function embedPage(
  engine: BrainEngine,
  slug: string,
  dryRun: boolean,
  result: EmbedResult,
  sourceId?: string,
  signal?: AbortSignal,
) {
  const opts = sourceId ? { sourceId } : undefined;
  const page = await engine.getPage(slug, opts);
  if (!page) {
    throw new Error(`Page not found: ${slug}`);
  }

  // Get existing chunks or create new ones.
  // In dryRun, we still chunk the text locally to count what WOULD be
  // embedded — but we never write chunks or call the embedding model.
  let chunks = await engine.getChunks(slug, opts);
  if (chunks.length === 0) {
    const inputs: ChunkInput[] = [];
    if (page.compiled_truth.trim()) {
      for (const c of chunkText(page.compiled_truth)) {
        inputs.push({ chunk_index: inputs.length, chunk_text: c.text, chunk_source: 'compiled_truth' });
      }
    }
    if (page.timeline.trim()) {
      for (const c of chunkText(page.timeline)) {
        inputs.push({ chunk_index: inputs.length, chunk_text: c.text, chunk_source: 'timeline' });
      }
    }

    if (dryRun) {
      // Count what chunking WOULD produce, without writing.
      result.total_chunks += inputs.length;
      result.would_embed += inputs.length;
      result.pages_processed++;
      return;
    }

    if (inputs.length > 0) {
      await engine.upsertChunks(slug, inputs, opts);
      chunks = await engine.getChunks(slug, opts);
    }
  }

  // Embed chunks without embeddings
  const toEmbed = chunks.filter(c => !c.embedded_at);
  result.total_chunks += chunks.length;
  result.skipped += chunks.length - toEmbed.length;

  if (toEmbed.length === 0) {
    slog(`${slug}: all ${chunks.length} chunks already embedded`);
    result.pages_processed++;
    return;
  }

  if (dryRun) {
    result.would_embed += toEmbed.length;
    result.pages_processed++;
    return;
  }

  const embeddings = await embedBatch(toEmbed.map(c => c.chunk_text), { abortSignal: signal });
  const embeddingMap = new Map<number, Float32Array>();
  for (let j = 0; j < toEmbed.length; j++) {
    embeddingMap.set(toEmbed[j].chunk_index, embeddings[j]);
  }
  const updated: ChunkInput[] = chunks.map(c => ({
    chunk_index: c.chunk_index,
    chunk_text: c.chunk_text,
    chunk_source: c.chunk_source,
    embedding: embeddingMap.get(c.chunk_index),
    token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
  }));

  await engine.upsertChunks(slug, updated, opts);
  // v0.41.31: stamp provenance so a later model/dims swap is detectable as
  // stale. embedPage is the per-slug path used by `gbrain embed <slug>` AND
  // by `gbrain sync`'s post-import embed step (runEmbedCore({slugs})).
  // Guard: only stamp when EVERY chunk was (re)embedded this pass. If some
  // chunks were preserved from a prior embed (unknown/old provenance), the
  // page is mixed — don't claim it's current. `embed --all` fully re-embeds
  // such a page and then stamps it.
  if (toEmbed.length === chunks.length) {
    await engine.setPageEmbeddingSignature(slug, { sourceId, signature: currentEmbeddingSignature() });
  }
  result.embedded += toEmbed.length;
  result.pages_processed++;
  slog(`${slug}: embedded ${toEmbed.length} chunks`);
}

async function embedAll(
  engine: BrainEngine,
  staleOnly: boolean,
  dryRun: boolean,
  result: EmbedResult,
  onProgress?: (done: number, total: number, embedded: number) => void,
  sourceId?: string,
  staleOpts?: {
    batchSize?: number;
    priority?: 'recent';
    catchUp?: boolean;
    /** DB-contention pacer (paced-backfill); no-op when pacing is off. */
    pacer?: DbPacer;
    /** Resolved concurrency cap (E-1: the worker count, no separate permit). */
    paceMaxConcurrency?: number;
  },
  signal?: AbortSignal,
) {
  // v0.41.31: current embedding provenance signature. Stamped onto pages
  // when their chunks are (re)embedded so a later model/dimension swap is
  // detectable as stale.
  const signature = currentEmbeddingSignature();
  // ─────────────────────────────────────────────────────────────
  // Stale-only fast path: avoid the listPages + per-page getChunks
  // bomb that pulled every page row + every chunk's embedding column
  // (~76 MB on a 1.5K-page brain) only to client-side-filter for
  // chunks where embedding IS NULL. The new path issues one SQL
  // pre-check + at most one slug-grouped SELECT excluding the
  // (always-null on stale rows) embedding column. On a 100%-embedded
  // brain (the autopilot common case) we exit after ~50 bytes wire.
  //
  // For --all (staleOnly=false) we keep the original behavior — the
  // user is explicitly asking to re-embed everything, including
  // chunks that already have embeddings.
  // ─────────────────────────────────────────────────────────────
  if (staleOnly) {
    // D7: thread sourceId so `gbrain embed --stale --source X` actually scopes.
    // v0.41.18.0 (A13): thread batchSize/priority/catchUp into the stale path.
    // #1737: thread the external abort signal so the cycle embed phase bails.
    return await embedAllStale(engine, sourceId, dryRun, result, onProgress, staleOpts, signature, signal);
  }

  // --all path: pacer (no-op when off). E-1: lower the worker count to the
  // resolved cap instead of adding a separate permit.
  const pacer = staleOpts?.pacer ?? createNoopPacer();

  // v0.31.12: when sourceId is set, scope listPages to that source.
  // v0.41 (D8 + Codex r2 #11): apply embed-skip filter via the shared
  // helper so the `--all` path honors `frontmatter.embed_skip` the same
  // way the `--stale` path does. Without this filter, `gbrain embed --all`
  // (common after model swaps) re-embeds every soft-blocked page,
  // defeating the soft-block. Filtering JS-side here mirrors the SQL-side
  // filter that listStaleChunks/countStaleChunks apply on --stale.
  const allPages = await engine.listPages({ limit: 100000, ...(sourceId && { sourceId }) });
  const pages = filterOutEmbedSkipped(allPages);
  const skippedByEmbedSkip = allPages.length - pages.length;
  if (skippedByEmbedSkip > 0) {
    serr(`[embed] skipped ${skippedByEmbedSkip} page(s) with frontmatter.embed_skip set`);
  }
  let processed = 0;

  // Concurrency limit for parallel page embedding.
  // Each worker pulls pages from a shared queue and makes independent
  // embedBatch calls to OpenAI + upsertChunks to the engine.
  //
  // Default 20: keeps us well under OpenAI's embedding RPM limit
  // (3000+/min for tier 1 = 50+/sec, 20 parallel is safely below) and
  // avoids overwhelming postgres connection pools. Users can tune via
  // GBRAIN_EMBED_CONCURRENCY env var based on their tier/infra.
  // Paced runs lower this to the resolved cap (the real lever vs pooler-slot
  // starvation); unpaced keeps the env/default 20. Codex P2: only ever LOWER —
  // never raise above an operator's existing env cap.
  const BASE_CONCURRENCY = parseInt(process.env.GBRAIN_EMBED_CONCURRENCY || '20', 10);
  const CONCURRENCY = staleOpts?.paceMaxConcurrency
    ? Math.min(BASE_CONCURRENCY, staleOpts.paceMaxConcurrency)
    : BASE_CONCURRENCY;

  async function embedOnePage(page: typeof pages[number]) {
    // #1737: bail before doing any work for this page if the run was aborted.
    if (isAborted(signal)) return;
    // v0.31.12: thread source_id from the page row so getChunks/upsertChunks
    // target the correct (source_id, slug) row, not the 'default' source.
    const pageSourceId = page.source_id;
    const pageOpts = pageSourceId ? { sourceId: pageSourceId } : undefined;
    const chunks = await observed(pacer, () => engine.getChunks(page.slug, pageOpts));
    const toEmbed = chunks; // staleOnly path handled above via embedAllStale

    result.total_chunks += chunks.length;
    result.skipped += chunks.length - toEmbed.length;

    if (toEmbed.length === 0) {
      processed++;
      result.pages_processed++;
      onProgress?.(processed, pages.length, result.embedded);
      return;
    }

    if (dryRun) {
      result.would_embed += toEmbed.length;
      processed++;
      result.pages_processed++;
      onProgress?.(processed, pages.length, result.embedded);
      return;
    }

    try {
      const embeddings = await embedBatch(toEmbed.map(c => c.chunk_text));
      // Build a map of new embeddings by chunk_index
      const embeddingMap = new Map<number, Float32Array>();
      for (let j = 0; j < toEmbed.length; j++) {
        embeddingMap.set(toEmbed[j].chunk_index, embeddings[j]);
      }
      // Preserve ALL chunks, only update embeddings for stale ones
      const updated: ChunkInput[] = chunks.map(c => ({
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: embeddingMap.get(c.chunk_index) ?? undefined,
        token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
      }));
      await observed(pacer, () => engine.upsertChunks(page.slug, updated, pageOpts));
      // v0.41.31: stamp embedding provenance so a later model swap is
      // detectable as stale.
      await observed(pacer, () =>
        engine.setPageEmbeddingSignature(page.slug, { sourceId: pageSourceId, signature }),
      );
      result.embedded += toEmbed.length;
    } catch (e: unknown) {
      serr(`\n  Error embedding ${page.slug}: ${e instanceof Error ? e.message : e}`);
    }

    processed++;
    result.pages_processed++;
    onProgress?.(processed, pages.length, result.embedded);
    // Cooperative DB-contention pace between pages (no-op when unpaced).
    try {
      await pacer.pace(signal);
    } catch (e) {
      if (!(e instanceof AbortError)) throw e;
    }
  }

  // v0.41.15.0: sliding worker pool extracted into src/core/worker-pool.ts.
  // Throughput characteristics unchanged from the prior inline pool — N
  // workers atomically claim the next page; the helper is the canonical
  // primitive. embedOnePage handles its own per-page errors via try/catch
  // and stderr log (no rethrow), so we don't need failures[] here and
  // omitting onError means the default 'continue' policy applies cleanly
  // even though no errors should reach the pool's catch.
  await runSlidingPool({
    items: pages,
    workers: CONCURRENCY,
    ...(signal && { signal }), // #1737: pool stops claiming pages once aborted
    onItem: (page) => embedOnePage(page),
    failureLabel: (page) => page.slug,
  });

  // Stdout summary preserved for scripts/tests that grep for counts.
  if (dryRun) {
    slog(`[dry-run] Would embed ${result.would_embed} chunks across ${pages.length} pages`);
  } else {
    slog(`Embedded ${result.embedded} chunks across ${pages.length} pages`);
  }
}

/**
 * SQL-side stale path: replaces the listPages + per-page getChunks
 * walk with a count + slug-grouped SELECT. Preserves the existing
 * functional contract (every chunk where embedding IS NULL gets
 * embedded; nothing else is touched) without paying egress on
 * already-embedded chunks.
 *
 * Why a separate function: the staleOnly path doesn't need
 * listPages at all and groups by slug differently. Forking the
 * function makes the read-bytes path explicit and keeps the --all
 * path verbatim from prior behavior.
 *
 * Staleness predicate: `embedding IS NULL`. We deliberately do NOT
 * use `embedded_at IS NULL` here — the bulk-import path can leave
 * embedded_at populated while embedding is NULL (see upsertChunks
 * consistency notes), and `embedding IS NULL` is the truth source
 * for "this chunk needs an embedding".
 */
async function embedAllStale(
  engine: BrainEngine,
  sourceId: string | undefined,
  dryRun: boolean,
  result: EmbedResult,
  onProgress?: (done: number, total: number, embedded: number) => void,
  staleOpts?: {
    batchSize?: number;
    priority?: 'recent';
    catchUp?: boolean;
    /** DB-contention pacer (paced-backfill); no-op when pacing is off. */
    pacer?: DbPacer;
    /** Resolved concurrency cap (E-1: the worker count, no separate permit). */
    paceMaxConcurrency?: number;
  },
  signature?: string,
  externalSignal?: AbortSignal,
) {
  // D7: thread sourceId so source-scoped runs only count + visit
  // that source's NULL embeddings.
  const sourceOpt = sourceId ? { sourceId } : undefined;

  // v0.41.31: re-embed pages whose embedding_signature drifted (model/dims
  // swap). dry-run must NOT mutate, so it counts signature-stale via the
  // widened predicate; a live run NULLs them first so the existing
  // NULL-embedding cursor (listStaleChunks) picks them up unchanged.
  if (!dryRun && signature) {
    const invalidated = await engine.invalidateStaleSignatureEmbeddings({
      signature,
      ...(sourceId && { sourceId }),
    });
    if (invalidated > 0) {
      slog(`[embed] invalidated ${invalidated} chunk(s) embedded under a prior model signature`);
    }
  }

  // Pre-flight: 0 stale chunks → nothing to do, no further DB reads.
  // dry-run includes signature-drift in the count without mutating.
  const staleCount = await engine.countStaleChunks(
    dryRun && signature ? { ...sourceOpt, signature } : sourceOpt,
  );
  if (staleCount === 0) {
    if (dryRun) {
      slog('[dry-run] Would embed 0 chunks (0 stale found)');
    } else {
      slog('Embedded 0 chunks (0 stale found)');
    }
    return;
  }

  if (dryRun) {
    result.would_embed += staleCount;
    result.total_chunks += staleCount;
    if (onProgress) onProgress(1, 1, 0);
    slog(`[dry-run] Would embed ${staleCount} stale chunks`);
    return;
  }

  // v0.33.3: cursor-paginated stale loading. Instead of pulling all 48K+
  // rows in one query (which times out on Supabase's 2-min pooler timeout),
  // we page through 2000 rows at a time via keyset pagination on
  // (page_id, chunk_index). Each query finishes in <1s.
  // v0.41.18.0 (A13): --batch-size N CLI flag overrides hardcoded 2000 default.
  const PAGE_SIZE = staleOpts?.batchSize ?? 2000;
  // Paced runs lower concurrency to the resolved cap (E-1: worker count IS the
  // lever on this single pool, no separate permit). Codex P2: pacing only ever
  // LOWERS concurrency — never raise above an operator's existing env cap.
  const BASE_CONCURRENCY = parseInt(process.env.GBRAIN_EMBED_CONCURRENCY || '20', 10);
  const CONCURRENCY = staleOpts?.paceMaxConcurrency
    ? Math.min(BASE_CONCURRENCY, staleOpts.paceMaxConcurrency)
    : BASE_CONCURRENCY;
  const pacer = staleOpts?.pacer ?? createNoopPacer();

  // D3 + D3a + D8: wall-clock budget. 30 min default; env override.
  // #1946: --catch-up removes the wall-clock cap. The prior code set BUDGET_MS =
  // Number.MAX_SAFE_INTEGER and passed it to setTimeout — but setTimeout's delay
  // is a 32-bit signed int, so MAX_SAFE_INTEGER (9e15) overflows and the timer
  // fires almost immediately, aborting catch-up after a single batch. The fix is
  // to NOT arm the timer in catch-up at all: the keyset pass below terminates on
  // its own (the (page_id, chunk_index) cursor advances monotonically), and
  // SIGINT / worker-abort still propagate via externalSignal.
  const BUDGET_MS: number | null = staleOpts?.catchUp
    ? null
    : parseInt(process.env.GBRAIN_EMBED_TIME_BUDGET_MS || `${30 * 60 * 1000}`, 10);
  const budgetController = new AbortController();
  const budgetStart = Date.now();
  let budgetTimer = BUDGET_MS != null
    ? setTimeout(() => budgetController.abort(), BUDGET_MS)
    : undefined;
  // E-4 (paced-backfill): the budget measures WORK, not waiting. After each
  // batch, re-arm the timer to fire at start + BUDGET + total-paced-sleep, so a
  // contended DB that spends time in pace() sleeps converges instead of exiting
  // having embedded little. No-op when unpaced (totalSleptMs stays 0) or in
  // catch-up (no budget timer).
  const rearmBudgetForPacing = (): void => {
    if (BUDGET_MS == null) return;
    const slept = pacer.snapshot().totalSleptMs;
    if (budgetTimer) clearTimeout(budgetTimer);
    const fireInMs = budgetStart + BUDGET_MS + slept - Date.now();
    budgetTimer = setTimeout(() => budgetController.abort(), Math.max(0, fireInMs));
  };
  const budgetSignal = budgetController.signal;
  // #1737: the effective signal fires when EITHER the internal wall-clock
  // budget OR the caller's abort (worker timeout / lock loss / SIGTERM) fires.
  // Replaces bare budgetSignal at every loop/pool/embed check below so the
  // autopilot cycle's embed phase stops within one batch (~2s) of being
  // killed instead of running the full 10-15 min and wedging the cycle lock.
  const effectiveSignal = anySignal(budgetSignal, externalSignal);

  // v0.41.18.0 (A13): --priority recent threads orderBy='updated_desc' to
  // listStaleChunks. Composite cursor tracks (updated_at, page_id, chunk_index)
  // instead of just (page_id, chunk_index); first-page cursor is sentinel
  // (null, 0, -1).
  const orderBy: 'page_id' | 'updated_desc' = staleOpts?.priority === 'recent'
    ? 'updated_desc'
    : 'page_id';

  let totalProcessedPages = 0;
  let afterPageId = 0;
  let afterChunkIndex = -1;
  let afterUpdatedAt: string | null = null;
  let totalChunksLoaded = 0;
  let budgetExitNotified = false;
  // #1946 (OV2a): track chunks that errored out so a catch-up pass that finishes
  // with stale chunks still remaining (un-embeddable for a non-transient reason)
  // surfaces that loudly instead of looking like a clean run.
  let embedFailures = 0;

  // E-3 (paced-backfill): bounded end-of-run re-entry. A longer paced run gives
  // a live writer (sync / put_page) more time to insert NEW stale rows BEHIND
  // the keyset cursor (TODOS:2301). When the cursor exhausts, re-scan from the
  // start — capped at MAX_REENTRIES AND requiring forward progress (a pass that
  // embeds 0 while count>0 stops) so a writer outrunning embed can't spin
  // forever.
  const MAX_REENTRIES = 3;
  let reentries = 0;
  let lastReentryEmbedded = 0;
  const maybeReenter = async (): Promise<boolean> => {
    // Scoped to PACED runs: pacing lengthens the run, which is what widens the
    // behind-cursor window. Unpaced runs keep prior (single-pass) behavior.
    if (!pacer.snapshot().enabled) return false;
    if (effectiveSignal.aborted) return false;
    if (reentries >= MAX_REENTRIES) return false;
    const remaining = await engine.countStaleChunks(sourceOpt);
    if (remaining === 0) return false;
    if (result.embedded === lastReentryEmbedded) return false; // no forward progress
    lastReentryEmbedded = result.embedded;
    reentries++;
    afterPageId = 0;
    afterChunkIndex = -1;
    afterUpdatedAt = null;
    serr(`\n  [embed] re-entry ${reentries}/${MAX_REENTRIES}: ${remaining} stale chunk(s) appeared during the run; rescanning from start.`);
    return true;
  };

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (effectiveSignal.aborted) {
        if (!budgetExitNotified) {
          const why = budgetSignal.aborted
            ? `wall-clock budget (${BUDGET_MS}ms) exceeded`
            : 'aborted by caller (job timeout / lock loss / shutdown)';
          serr(`\n  [embed] ${why}; exiting cleanly. Re-run picks up via partial index.`);
          budgetExitNotified = true;
        }
        break;
      }

      const batch = await observed(pacer, () =>
        engine.listStaleChunks({
          batchSize: PAGE_SIZE,
          afterPageId,
          afterChunkIndex,
          ...(orderBy === 'updated_desc' && {
            orderBy,
            afterUpdatedAt,
          }),
          ...(sourceId && { sourceId }),
        }),
      );
      if (batch.length === 0) {
        if (await maybeReenter()) continue;
        break;
      }
      totalChunksLoaded += batch.length;

      // Advance cursor to last row in this batch.
      const last = batch[batch.length - 1];
      afterPageId = last.page_id;
      afterChunkIndex = last.chunk_index;
      if (orderBy === 'updated_desc') {
        // engine returns `updated_at` as Date or ISO string; normalize to ISO.
        const lastRow = last as unknown as { updated_at?: string | Date | null };
        const u = lastRow.updated_at;
        afterUpdatedAt = u instanceof Date ? u.toISOString()
          : typeof u === 'string' ? u
          : null;
      }

      // Group by composite key (source_id::slug).
      const byKey = new Map<string, typeof batch>();
      for (const row of batch) {
        const key = `${row.source_id}::${row.slug}`;
        const list = byKey.get(key);
        if (list) list.push(row);
        else byKey.set(key, [row]);
      }

      const keys = Array.from(byKey.keys());
      result.total_chunks += batch.length;

      async function embedOneKey(key: string) {
        const stale = byKey.get(key)!;
        const keySourceId = stale[0]?.source_id ?? 'default';
        const slug = stale[0].slug;
        try {
          const embeddings = await embedBatchWithBackoff(stale.map(c => c.chunk_text), { abortSignal: effectiveSignal });
          // Re-fetch existing chunks and merge to avoid deleting non-stale chunks.
          const existing = await observed(pacer, () => engine.getChunks(slug, { sourceId: keySourceId }));
          const staleIdxToEmbedding = new Map<number, Float32Array>();
          for (let j = 0; j < stale.length; j++) {
            staleIdxToEmbedding.set(stale[j].chunk_index, embeddings[j]);
          }
          const merged: ChunkInput[] = existing.map(c => ({
            chunk_index: c.chunk_index,
            chunk_text: c.chunk_text,
            chunk_source: c.chunk_source,
            embedding: staleIdxToEmbedding.get(c.chunk_index) ?? undefined,
            token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
          }));
          await observed(pacer, () => engine.upsertChunks(slug, merged, { sourceId: keySourceId }));
          // v0.41.31: stamp provenance after the page's chunks are embedded —
          // but only when EVERY chunk was stale (fully re-embedded this pass).
          // A partially-stale page keeps preserved chunks of unknown/old
          // provenance, so don't claim it's current. (After invalidate, a
          // signature-drifted page IS fully stale → this stamps it.)
          if (signature && stale.length === existing.length) {
            await observed(pacer, () =>
              engine.setPageEmbeddingSignature(slug, { sourceId: keySourceId, signature }),
            );
          }
          result.embedded += stale.length;
        } catch (e: unknown) {
          // Budget/abort-fired cancellations are expected on the way out; don't
          // spam per-page "Error embedding" lines when we're shutting down.
          if (effectiveSignal.aborted) return;
          embedFailures++;
          serr(`\n  Error embedding ${slug}: ${e instanceof Error ? e.message : e}`);
        }
        totalProcessedPages++;
        result.pages_processed++;
        // Use staleCount as the estimated total for progress (not exact after
        // pagination starts, but directionally correct).
        onProgress?.(totalProcessedPages, Math.ceil(staleCount / PAGE_SIZE) * keys.length, result.embedded);
        // Cooperative DB-contention pace between keys (no-op when unpaced).
        // E-4 (Codex P1): pace() is subject to the EXTERNAL abort only, NOT the
        // wall-clock budget — a contended DB's sleep must not be cut by the
        // budget timer before its time is credited. Re-arm the budget right
        // after each sleep so accrued sleep never eats into work time.
        try {
          await pacer.pace(externalSignal);
          rearmBudgetForPacing();
        } catch (e) {
          if (!(e instanceof AbortError)) throw e;
        }
      }

      // v0.41.15.0: migrated to shared runSlidingPool. The pool checks
      // its `signal` argument before each claim (mirrors the pre-migration
      // `!budgetSignal.aborted` gate) AND threads abort into in-flight
      // onItem via the local-abort composition for D13. embedOneKey
      // already handles its own per-key errors via try/catch + stderr.
      await runSlidingPool({
        items: keys,
        workers: CONCURRENCY,
        signal: effectiveSignal,
        onItem: (key) => embedOneKey(key),
        failureLabel: (key) => key,
      });

      // E-4: extend the work budget by any paced-sleep time accrued this batch.
      rearmBudgetForPacing();

      // If we got fewer rows than PAGE_SIZE, we've reached the end.
      if (batch.length < PAGE_SIZE) {
        if (await maybeReenter()) continue;
        break;
      }
    }
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }

  slog(`Embedded ${result.embedded} chunks across ${totalProcessedPages} pages`);

  // #1946 (OV2a): a catch-up pass that completed without being aborted but left
  // chunks unembedded means those chunks are stuck (a non-transient embed
  // failure), not that we ran out of time. Surface it loudly so it doesn't read
  // as a clean run — re-running won't help until the underlying failure is fixed.
  if (staleOpts?.catchUp && !effectiveSignal.aborted && embedFailures > 0) {
    const remaining = await engine.countStaleChunks(
      signature ? { signature, ...(sourceId ? { sourceId } : {}) } : (sourceId ? { sourceId } : undefined),
    );
    if (remaining > 0) {
      serr(`\n  [embed] catch-up finished but ${remaining} chunk(s) remain stale after ${embedFailures} embed failure(s). These are not embeddable as-is; re-running won't clear them until the underlying error is resolved.`);
    }
  }
}

/**
 * v0.33.3: rate-limit-aware embedBatch wrapper.
 *
 * The OpenAI SDK has built-in retry with exponential backoff, but its
 * backoff window (max ~4s) is too short for TPM (tokens-per-minute)
 * rate limits on large pages (~90K tokens).  This wrapper catches
 * 429-shaped errors, parses the retry delay from the error message
 * (e.g. "Please try again in 248ms"), and sleeps before retrying.
 *
 * v0.33.4 hardening (codex + re-review findings):
 *   - D4: detect 429 via the wrapped error's `cause.status` (the gateway's
 *     normalizeAIError stores the original error there). Bare `e.status`
 *     never fires against an `AITransientError` wrap. Message-match stays
 *     as a fallback.
 *   - D4a: pass `maxRetries: 0` through `embedBatch` so the AI SDK's
 *     default 2-retry stack doesn't multiply this wrapper's 5 attempts.
 *   - D2: jitter the parsed delay ±30% so 20 concurrent workers don't
 *     resynchronize on the next 429 wave.
 *   - D3a/D8: when an external AbortSignal fires (wall-clock budget), the
 *     sleep wakes up early AND the abortSignal is threaded into the gateway
 *     embed call so an in-flight HTTP request cancels too.
 *
 * Up to MAX_RATE_LIMIT_RETRIES attempts with the parsed (jittered) delay
 * (or a 60s fallback when the message can't be parsed).
 *
 * @internal Exported for unit tests; not part of the public surface.
 */
export const MAX_RATE_LIMIT_RETRIES = 5;
export const RATE_LIMIT_FALLBACK_MS = 60_000;
export const RATE_LIMIT_PAD_MS = 500;
export const RATE_LIMIT_JITTER = 0.3;

export interface EmbedBatchWithBackoffOpts {
  abortSignal?: AbortSignal;
}

/**
 * Walk the cause chain looking for a 429 status. The current
 * `normalizeAIError` wraps once into `AITransientError` with `cause = original`,
 * so one level is sufficient — but iterate to handle future wrap layers
 * defensively (max 5 levels to bound a malformed cyclic chain).
 *
 * @internal exported for unit tests.
 */
export function detect429FromCause(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (obj.status === 429 || obj.statusCode === 429) return true;
    cur = obj.cause;
  }
  return false;
}

/**
 * Parse a Retry-After hint out of an OpenAI-style 429 message. Falls back
 * to `RATE_LIMIT_FALLBACK_MS` when the message can't be parsed. Adds
 * `RATE_LIMIT_PAD_MS` padding and `RATE_LIMIT_JITTER` randomization so
 * concurrent workers don't resynchronize.
 *
 * @internal exported for unit tests.
 */
export function parseRetryDelayMs(msg: string, rng: () => number = Math.random): number {
  let delayMs = RATE_LIMIT_FALLBACK_MS;
  const msMatch = msg.match(/try again in (\d+)ms/i);
  const secMatch = msg.match(/try again in ([\d.]+)s/i);
  if (msMatch) delayMs = parseInt(msMatch[1], 10) + RATE_LIMIT_PAD_MS;
  else if (secMatch) delayMs = Math.ceil(parseFloat(secMatch[1]) * 1000) + RATE_LIMIT_PAD_MS;
  // D2: ±30% jitter to decorrelate the herd of 20 workers.
  const jitterFactor = 1 + (rng() * 2 - 1) * RATE_LIMIT_JITTER;
  return Math.max(1, Math.floor(delayMs * jitterFactor));
}

/**
 * Sleep for `ms` milliseconds. Resolves early (not rejects) when `signal`
 * fires, so the retry loop's caller can re-check `signal.aborted` and
 * exit cleanly without an unhandled rejection.
 *
 * @internal exported for unit tests.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function embedBatchWithBackoff(
  texts: string[],
  opts: EmbedBatchWithBackoffOpts = {},
): Promise<Float32Array[]> {
  const signal = opts.abortSignal;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('embed budget aborted');
    try {
      // D4a + D8: maxRetries:0 disables the SDK's stacked retries (so this
      // wrapper is the single source of truth) and abortSignal threads
      // through to the gateway so an in-flight HTTP request cancels mid-fetch.
      return await embedBatch(texts, { maxRetries: 0, ...(signal && { abortSignal: signal }) });
    } catch (e: unknown) {
      // If the budget fired we may have been aborted mid-fetch; bubble out.
      if (signal?.aborted) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      // D4: structured detection first (handles gateway-wrapped errors via
      // cause chain); message-match as fallback for providers whose wrappers
      // strip `cause.status`.
      const isRateLimit = detect429FromCause(e)
        || /rate.?limit|429/i.test(msg);
      if (!isRateLimit || attempt === MAX_RATE_LIMIT_RETRIES) throw e;

      const delayMs = parseRetryDelayMs(msg);
      serr(`  [rate-limit] attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}, waiting ${delayMs}ms...`);
      await abortableSleep(delayMs, signal);
    }
  }
  // Unreachable, but TypeScript needs it.
  return embedBatch(texts);
}
