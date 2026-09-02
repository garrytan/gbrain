/**
 * v0.31.2 — runFactsBackstop: shared facts pipeline used by every brain
 * write surface that wants real-time hot memory extraction.
 *
 * Encapsulates the v0.31 smart pipeline:
 *
 *   extract (extractFactsFromTurn — sanitize + LLM + parser fixed in B1)
 *     ↓
 *   resolve (resolveEntitySlug — canonicalize free-form entity refs)
 *     ↓
 *   dedup   (findCandidateDuplicates + cosineSimilarity @ 0.95)
 *     ↓
 *   insert  (engine.insertFact with supersede support)
 *
 * Replaces five divergent implementations (put_page hook, extract_facts
 * MCP op, sync.ts post-import block, file_upload, code_import) with one
 * choke point. Eligibility runs through `isFactsBackstopEligible` from
 * src/core/facts/eligibility.ts; kill-switch via `isFactsExtractionEnabled`.
 *
 * Two execution modes (D8 from /plan-eng-review):
 *
 *   - 'queue' (default): fire-and-forget via `getFactsQueue().enqueue`.
 *     Caller's await is ~zero (just the enqueue + microtask schedule).
 *     Used by sync, put_page, file_upload, code_import. Sync stays fast
 *     even on a 50-page batch.
 *
 *   - 'inline': await the full pipeline; return real {inserted, duplicate,
 *     superseded, fact_ids} counts. Used by the explicit extract_facts
 *     MCP op so tool-call responses carry truthful numbers.
 *
 * Notability filter (D4): per-caller policy via FactsBackstopCtx.notabilityFilter.
 * Sync passes 'high-only' (HIGH lands now, MEDIUM waits for the dream
 * cycle, LOW dropped at LLM layer). Other surfaces default to 'all'.
 *
 * Failure modes route to ingest_log (D5) via writeFactsAbsorbLog (lands
 * in PR1 commit 13). For PR1 commit 6 the absorb writer is a placeholder;
 * commit 13 wires it.
 */

import type { BrainEngine, FactInsertStatus, NewFact } from '../engine.ts';
import type { ResolutionSource } from '../entities/resolve.ts';
import { isFactsBackstopEligible } from './eligibility.ts';
import type { PageType } from '../types.ts';

export interface FactsBackstopCtx {
  engine: BrainEngine;
  /** Brain source identifier; default 'default'. */
  sourceId: string;
  /** source_session for provenance; null if absent. */
  sessionId: string | null;
  /**
   * Provenance source string written into facts.source. Stable values:
   *   - 'sync:import'        — git sync post-import hook
   *   - 'mcp:put_page'       — MCP put_page backstop
   *   - 'mcp:extract_facts'  — explicit MCP op (inline mode)
   *   - 'file_upload'        — file_upload import path
   *   - 'code_import'        — code import path
   *   - 'hook:compact'       — compaction-boundary checkpoint harvest (cathedral 5)
   *   - 'hook:writeback'     — ambient-writeback Stop-hook backstop (WP4)
   */
  source: 'sync:import' | 'mcp:put_page' | 'mcp:extract_facts' | 'file_upload' | 'code_import' | 'hook:compact' | 'hook:writeback';
  /** Execution mode — D8. Default 'queue' (fire-and-forget). */
  mode?: 'queue' | 'inline';
  /** Notability filter — D4. Default 'all'; sync uses 'high-only'; the
   * ambient-writeback lane uses 'medium-and-up' in salient mode. */
  notabilityFilter?: 'all' | 'high-only' | 'medium-and-up';
  /** Abort signal for shutdown propagation. */
  abortSignal?: AbortSignal;
  /** Mirrors OperationContext.remote for trust-aware logging paths. */
  remote?: boolean;
  /** Optional entity hints (extract_facts MCP op forwards these). */
  entityHints?: string[];
  /** Optional visibility tier (default 'private'). extract_facts forwards `world` when caller asks. */
  visibility?: 'private' | 'world';
  /** Override the chat model (extract_facts forwards user's model param when set). */
  model?: string;
  /**
   * #4206: caller-supplied event time. Fallback ONLY — a valid_from the
   * extractor derives from the turn itself wins; absent both, now(). Lets
   * historical imports (old transcripts) avoid import-time stamping.
   */
  validFrom?: Date;
  /**
   * #4206: slug of the page/transcript the turn came from (e.g.
   * 'meetings/2026-04-03'). Written to facts.context so the recall /
   * context_pack / delta projections surface the provenance.
   */
  sourceSlug?: string;
}

/** Discriminated return shape based on FactsBackstopCtx.mode. */
export type FactsBackstopResult =
  | {
      mode: 'queue';
      enqueued: boolean;
      queueDepth: number;
      skipped?: 'extraction_disabled' | 'extraction_unavailable' | 'queue_overflow' | 'queue_shutdown' | `eligibility_failed:${string}`;
    }
  | {
      mode: 'inline';
      inserted: number;
      duplicate: number;
      superseded: number;
      fact_ids: number[];
      skipped?: 'extraction_disabled' | 'extraction_unavailable' | `eligibility_failed:${string}`;
      /** Set when the LLM extraction step failed non-transport-fatally (see runPipelineWithBody). */
      skipped_reason?: import('./extract.ts').ExtractFailureReason;
    };

interface ParsedPageInput {
  slug: string;
  type: PageType;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Cosine similarity threshold for the dedup fast-path. Matches the existing
 * extract_facts op behavior at operations.ts:2460. Higher = stricter
 * dedup (more rows kept distinct); lower = looser (more rows treated as
 * duplicates of older ones).
 */
const DEDUP_THRESHOLD = 0.95;

/** k for findCandidateDuplicates — ceiling on candidates considered. */
const DEDUP_CANDIDATE_LIMIT = 5;

/**
 * Once-per-process stderr warning memo. v0.32.2 uses this to surface
 * the thin-client / no-local_path fallback without spamming a warning
 * on every put_page in a long-running brain.
 */
const _warnedKeys = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  // eslint-disable-next-line no-console
  console.warn(msg);
}
/** Test-only: reset the once-per-process warning memo. */
export function __resetBackstopWarningsForTests(): void {
  _warnedKeys.clear();
}

/**
 * ONE sentence for every keyless-extraction surface (backstop note, doctor's
 * facts_extraction_health) — a future provider addition edits it here only.
 */
export const KEYLESS_EXTRACTION_GUIDANCE =
  'memory comes from agent-authored `## Facts` fences and the `remember` verb. ' +
  'One optional key enables automatic extraction (OpenAI or Anthropic).';

const KEYLESS_NOTE =
  `[facts] keyless: automatic fact extraction off — ${KEYLESS_EXTRACTION_GUIDANCE}`;

/**
 * Classify a chat_unavailable extraction failure: an EXPECTED keyless state
 * (calm — one stderr note, no ingest_log row) vs a keyed-but-failing state
 * (visible — absorb-log row + fix hint). Keyless means: the resolved model's
 * provider has no usable key AND no chat-capable provider key exists at all
 * (merged file-plane + process env). Computed from the RESOLVED model, never
 * the engine-blind detectCapabilities() — a servable DB-plane override must
 * never classify as keyless (CX1).
 */
export async function classifyUnavailable(model: string | undefined): Promise<'keyless' | 'keyed'> {
  const { mergedProviderEnv } = await import('../ai/provider-env.ts');
  const { providerKeyReady, PROVIDER_TIER_DEFAULTS } = await import('../model-config.ts');
  let cfg = null;
  try {
    const { loadConfig } = await import('../config.ts');
    cfg = loadConfig();
  } catch {
    // Fail toward RETRY, not calm consumption (loadConfig swallows file
    // errors itself, so this only fires on pathological import failures).
    return 'keyed';
  }
  const merged = mergedProviderEnv(cfg, process.env);
  if (model && providerKeyReady(model, merged)) return 'keyed';
  const anyChatKey = PROVIDER_TIER_DEFAULTS.some((e) => !!merged[e.envKey]);
  if (!anyChatKey) {
    // Before declaring keyless, check for a config file that EXISTS but
    // yielded nothing (EACCES, disk error, corrupt JSON — loadConfig returns
    // null for all of them, indistinguishable from "no config"). That file
    // may hold the only key this worker has; classifying it keyless would
    // calmly consume a job that a retry after repair would have served.
    try {
      const { loadConfigFileOnly, configPath } = await import('../config.ts');
      const { existsSync } = await import('node:fs');
      if (loadConfigFileOnly() === null && existsSync(configPath())) return 'keyed';
    } catch {
      return 'keyed';
    }
  }
  return anyChatKey ? 'keyed' : 'keyless';
}

/**
 * Shared visibility for a non-transport extraction failure: keyless stays a
 * calm one-line note with NO log row (expected state); keyed-but-failing
 * writes one ingest_log row (doctor's facts_extraction_health reads it) plus
 * a once-per-process fix hint.
 */
async function surfaceExtractionFailure(
  engine: BrainEngine,
  ref: string,
  reason: import('./absorb-log.ts').FactsAbsorbReason,
  model: string | undefined,
  sourceId: string,
): Promise<void> {
  if (reason === 'chat_unavailable' && (await classifyUnavailable(model)) === 'keyless') {
    warnOnce('facts-keyless', KEYLESS_NOTE);
    return;
  }
  const { writeFactsAbsorbLog } = await import('./absorb-log.ts');
  await writeFactsAbsorbLog(
    engine,
    ref,
    reason,
    `extraction ${reason}${model ? ` (model=${model})` : ''}`,
    sourceId,
  );
  warnOnce(
    `facts-extract-fail-${reason}`,
    `[facts] extraction ${reason}${model ? ` (model=${model})` : ''}. ` +
    `Fix: set the provider's API key, or \`gbrain config set facts.extraction_model <provider:model>\`.`,
  );
}

/**
 * Run the facts pipeline for one page write. See module docstring for
 * the full lifecycle and mode semantics.
 *
 * Re-throws AbortError; absorbs gateway/parse/queue errors as
 * `skipped: '...'` envelope (operator visibility lands via PR1 commit 13's
 * ingest_log writer).
 */
export async function runFactsBackstop(
  parsedPage: ParsedPageInput,
  ctx: FactsBackstopCtx,
): Promise<FactsBackstopResult> {
  const mode = ctx.mode ?? 'queue';

  // --- Eligibility + kill-switch gates (run before any LLM cost) ---
  const { isFactsExtractionEnabled } = await import('./extract.ts');
  const enabled = await isFactsExtractionEnabled(ctx.engine);
  if (!enabled) {
    return mode === 'queue'
      ? { mode: 'queue', enqueued: false, queueDepth: 0, skipped: 'extraction_disabled' }
      : { mode: 'inline', inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'extraction_disabled' };
  }

  const eligible = isFactsBackstopEligible(parsedPage.slug, parsedPage);
  if (!eligible.ok) {
    const skipped = `eligibility_failed:${eligible.reason}` as const;
    return mode === 'queue'
      ? { mode: 'queue', enqueued: false, queueDepth: 0, skipped }
      : { mode: 'inline', inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped };
  }

  // --- Extraction availability gate (engine-aware, EXECUTION-process only) ---
  // Resolves the ACTUAL extraction model (facts.extraction_model /
  // models.default / tier config / GBRAIN_MODEL / key-aware tier default) and
  // asks the gateway whether it's servable. Deliberately NOT
  // detectCapabilities(): that probe is engine-blind and would permanently
  // drop work for installs whose DB-plane override IS servable.
  //
  // CRITICAL placement rule: this gate only fires in the process that will
  // EXECUTE the extraction — the in-process queue lane and the inline lane
  // (which includes the durable facts-absorb handler running in the jobs
  // worker). It must NOT fire before the short-lived-CLI durable submit: the
  // submitting process's env can differ from the worker's (launchers neuter
  // keys in hook subprocesses — the #1249 class — while the worker holds the
  // real key and even re-folds file-plane keys per job), so an enqueue-time
  // skip there would silently drop work a keyed worker could execute.
  // Returns the resolved model on pass (threaded into the pipeline so
  // extraction does NOT re-resolve it — the resolve is up to 3 sequential
  // engine.getConfig round-trips per page write), or null on gate failure.
  const availabilityGate = async (): Promise<string | null> => {
    const { getFactsExtractionModel } = await import('./extract.ts');
    const { isAvailable } = await import('../ai/gateway.ts');
    const extractionModel = ctx.model ?? (await getFactsExtractionModel(ctx.engine));
    if (isAvailable('chat', extractionModel)) return extractionModel;
    await surfaceExtractionFailure(
      ctx.engine, parsedPage.slug, 'chat_unavailable', extractionModel, ctx.sourceId,
    );
    return null;
  };

  // --- Mode dispatch ---
  if (mode === 'queue') {
    // Local patch 2026-06-11: in a one-shot CLI process the in-process queue
    // is doomed — cli.ts's exit drain aborts the in-flight chat after ~1-2s,
    // so every CLI capture logged `pipeline_error: [chat(...)] The operation
    // was aborted.` and extracted nothing. Submit a durable facts-absorb
    // minion job for the long-lived jobs worker instead. Falls through to
    // the in-process queue if durable submission fails (old schema, no
    // minions infra), preserving prior behavior + absorb-log visibility.
    const { isShortLivedCliProcess } = await import('./cli-process-mode.ts');
    if (isShortLivedCliProcess()) {
      try {
        const { MinionQueue } = await import('../minions/queue.ts');
        const { createHash } = await import('node:crypto');
        const contentHash = createHash('sha256')
          .update(parsedPage.compiled_truth)
          .digest('hex')
          .slice(0, 16);
        const minions = new MinionQueue(ctx.engine);
        // [ENG-8] Caller-unset visibility resolves the brain default HERE
        // (not in the long-lived worker) so the durable payload carries the
        // visibility that was in force at write time.
        const { resolveDefaultVisibility } = await import('./visibility.ts');
        await minions.add(
          'facts-absorb',
          {
            slug: parsedPage.slug,
            sourceId: ctx.sourceId,
            source: ctx.source,
            sessionId: ctx.sessionId,
            notabilityFilter: ctx.notabilityFilter ?? 'all',
            visibility: ctx.visibility ?? (await resolveDefaultVisibility(ctx.engine)),
            ...(ctx.model ? { model: ctx.model } : {}),
          },
          {
            queue: 'default',
            // Content-hash key: re-submits after edits, dedups rapid
            // identical writes (idempotent ON CONFLICT returns existing row).
            idempotency_key: `facts-absorb:${ctx.sourceId}:${parsedPage.slug}:${contentHash}`,
            // 5 attempts at a 60s exponential base (not the 3×1s default):
            // execution-time chat_unavailable is config drift the operator
            // fixes on a human timescale — 3 attempts in ~seconds would
            // exhaust before any fix lands. On exhaustion the job parks as a
            // VISIBLE failure (`gbrain jobs list --status failed`,
            // re-runnable), never a silent consume.
            max_attempts: 5,
            backoff_delay: 60_000,
            timeout_ms: 180_000,
          },
        );
        return { mode: 'queue', enqueued: true, queueDepth: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnOnce(
          'facts-absorb-job-submit',
          `[facts] durable facts-absorb submit failed (${msg}); falling back to in-process queue`,
        );
      }
    }
    // In-process queue lane: THIS process executes the extraction — gate here.
    const queueModel = await availabilityGate();
    if (!queueModel) {
      return { mode: 'queue', enqueued: false, queueDepth: 0, skipped: 'extraction_unavailable' };
    }
    ctx = { ...ctx, model: queueModel };
    const { getFactsQueue } = await import('./queue.ts');
    const queue = getFactsQueue();
    const enqueued = queue.enqueue(async (signal) => {
      // v0.31.2 (PR1 commit 13): facts:absorb writer wired here. Errors
      // inside the queue worker were previously invisible (queue counter
      // increments only). Now they land in ingest_log so doctor +
      // dashboard surface failure modes per source.
      try {
        await runPipeline(parsedPage, ctx, signal);
      } catch (err) {
        const { writeFactsAbsorbFailure } = await import('./absorb-log.ts');
        await writeFactsAbsorbFailure(ctx.engine, parsedPage.slug, err, ctx.sourceId);
      }
    }, ctx.sessionId ?? parsedPage.slug);

    if (enqueued < 0) {
      // -1 means the queue is shutting down OR cap-overflow drop fired.
      // Caller can disambiguate via getCounters() if they care; for now
      // collapse to a single skipped reason and record the absorb event.
      const { writeFactsAbsorbLog } = await import('./absorb-log.ts');
      await writeFactsAbsorbLog(
        ctx.engine,
        parsedPage.slug,
        'queue_overflow',
        `queue capacity hit; enqueue dropped (sessionId=${ctx.sessionId ?? parsedPage.slug})`,
        ctx.sourceId,
      );
      return { mode: 'queue', enqueued: false, queueDepth: 0, skipped: 'queue_overflow' };
    }
    return { mode: 'queue', enqueued: true, queueDepth: enqueued };
  }

  // 'inline' mode: caller awaits the full pipeline. Errors bubble to the
  // caller — extract_facts MCP op surfaces them as op-error responses
  // (the explicit-call contract). Unlike queue mode, we don't absorb-log
  // here because the caller decides whether the failure is interesting
  // enough to record (vs. retry, vs. surface directly to the user).
  // Inline executes in THIS process — gate here (this is also the durable
  // facts-absorb handler's execution-time gate in the jobs worker; the
  // handler converts a keyed skip into a retryable failure).
  const inlineModel = await availabilityGate();
  if (!inlineModel) {
    return { mode: 'inline', inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], skipped: 'extraction_unavailable' };
  }
  const r = await runPipeline(parsedPage, { ...ctx, model: inlineModel }, ctx.abortSignal);
  return { mode: 'inline', ...r };
}

/**
 * Public pipeline entry-point — extract → resolve → dedup → insert.
 *
 * Used by:
 *   - runFactsBackstop (above) — wraps with eligibility + kill-switch
 *     gates and queue-mode dispatch.
 *   - extract_facts MCP op — calls directly with raw turn_text. The op
 *     is an explicit user request, not a page-write hook, so eligibility
 *     doesn't apply (no slug, no PageType, no frontmatter). Operator-
 *     level visibility filter (private vs world) and kill-switch gating
 *     are the op's responsibility.
 *
 * Inputs come from extractFactsFromTurn — the LLM extractor — but this
 * function itself is shape-agnostic: it takes a `turnText` and the same
 * FactsBackstopCtx used elsewhere. AbortError re-thrown; gateway / parse
 * / DB errors bubble (caller decides whether to absorb).
 */
export async function runFactsPipeline(
  turnText: string,
  ctx: FactsBackstopCtx,
): Promise<{
  inserted: number;
  duplicate: number;
  superseded: number;
  fact_ids: number[];
  /**
   * Cathedral 5 (additive): DISTINCT resolved entity slugs of facts that were
   * INSERTED via the fence-write path this run — i.e. slugs whose entity page
   * is known to exist with the new fact fenced onto it. Duplicates (old
   * provenance), legacy DB-only inserts (no fenceable page), and
   * stub-guard-blocked facts are EXCLUDED — a checkpoint manifest link built
   * from this list is truthful by construction (link candidates only; the
   * harvest re-verifies each via source-scoped getPage before banking).
   */
  entity_slugs: string[];
  /** Set when the LLM extraction step failed non-transport-fatally (see runPipelineWithBody). */
  skipped_reason?: import('./extract.ts').ExtractFailureReason;
}> {
  return runPipelineWithBody({
    turnText,
    isDreamGenerated: false,
    ref: ctx.sessionId ?? 'inline',
  }, ctx, ctx.abortSignal);
}

/**
 * Internal pipeline: extract → resolve → dedup → insert. Pure work
 * (no eligibility/kill-switch gates — those run upstream in the
 * exported entry point).
 *
 * Returns count envelope for inline-mode callers; queue-mode callers
 * discard the return value (the queue worker only cares that the
 * promise settled).
 */
async function runPipeline(
  parsedPage: ParsedPageInput,
  ctx: FactsBackstopCtx,
  abortSignal?: AbortSignal,
): Promise<{ inserted: number; duplicate: number; superseded: number; fact_ids: number[]; entity_slugs: string[]; skipped_reason?: import('./extract.ts').ExtractFailureReason }> {
  return runPipelineWithBody(
    {
      turnText: parsedPage.compiled_truth,
      isDreamGenerated: false,  // eligibility check already rejected dream pages
      ref: parsedPage.slug,
    },
    ctx,
    abortSignal,
  );
}

/**
 * Inner pipeline body. Shared between runFactsBackstop (page-shape entry)
 * and runFactsPipeline (raw turn-text entry). Eligibility + kill-switch
 * are upstream of this; we just extract → resolve → dedup → write fence
 * → stamp DB.
 *
 * v0.32.2 (Codex R2-#2): markdown-first rewrite. Both this function's
 * callers route through here, so making the write path fence-first here
 * makes BOTH runFactsBackstop AND runFactsPipeline canonical without
 * changing either entry-point signature.
 *
 * Pipeline:
 *   1. extract (extractFactsFromTurn — sanitize + LLM + parser)
 *   2. resolve (resolveEntitySlugWithSource — canonicalize free-form entity
 *      refs, provenance-tagged for the #4108 stub guard)
 *   3. dedup   (findCandidateDuplicates + cosineSimilarity @ 0.95)
 *   4. write   (writeFactsToFence → markdown atomic write + engine.insertFacts)
 *
 * Step 4 falls through to legacy single-row engine.insertFact when the
 * brain has no sources.local_path configured (thin-client install). A
 * once-per-process stderr warning names the missing config so operators
 * see the degraded mode at boot.
 *
 * Facts with no resolved entity_slug structurally can't be fenced (no
 * entity page to fence them on), so they take the same legacy DB-only
 * fallback regardless of local_path.
 */
async function runPipelineWithBody(
  input: { turnText: string; isDreamGenerated: boolean; ref?: string },
  ctx: FactsBackstopCtx,
  abortSignal?: AbortSignal,
): Promise<{ inserted: number; duplicate: number; superseded: number; fact_ids: number[]; entity_slugs: string[]; skipped_reason?: import('./extract.ts').ExtractFailureReason }> {
  // #4210: outside a withBudgetTracker scope (extract_facts op, sweep,
  // put_page backstop, checkpoint harvest, file/code import) the gateway's
  // chat/embed calls were budget no-ops — real spend, zero audit rows.
  // Install a record-only fallback tracker labeled by the entry point so
  // every pipeline invocation is visible to accounting. Uncapped, so it can
  // never throw BudgetExhausted (cost/runtime gates need a cap); the
  // pipeline's failure surface is unchanged. An ambient tracker (cycle
  // phases, transcripts ingest) wins — no double scope, labels preserved.
  const { getCurrentBudgetTracker, withBudgetTracker } = await import('../ai/gateway.ts');
  if (!getCurrentBudgetTracker()) {
    const { BudgetTracker } = await import('../budget/budget-tracker.ts');
    const fallback = new BudgetTracker({ label: `facts:${ctx.source}` });
    return withBudgetTracker(fallback, () => runPipelineBodyInner(input, ctx, abortSignal));
  }
  return runPipelineBodyInner(input, ctx, abortSignal);
}

/** The actual pipeline body — always runs inside a BudgetTracker scope (#4210). */
async function runPipelineBodyInner(
  input: { turnText: string; isDreamGenerated: boolean; ref?: string },
  ctx: FactsBackstopCtx,
  abortSignal?: AbortSignal,
): Promise<{ inserted: number; duplicate: number; superseded: number; fact_ids: number[]; entity_slugs: string[]; skipped_reason?: import('./extract.ts').ExtractFailureReason }> {
  const { extractFactsFromTurnWithOutcome, FactsExtractionError } = await import('./extract.ts');
  const { resolveEntitySlugWithSource } = await import('../entities/resolve.ts');
  const { cosineSimilarity } = await import('./classify.ts');
  const { writeFactsToFence, lookupSourceLocalPath } = await import('./fence-write.ts');

  if (abortSignal?.aborted) {
    return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [] };
  }

  const filter = ctx.notabilityFilter ?? 'all';
  // `all` means ALL TIERS — a pinned contract (test/facts-backstop.test.ts
  // "notabilityFilter=all embeds and persists every tier"), so no admission
  // is passed and the extractor labels low honestly instead of withholding
  // it. Behavior note for the eval fix wave: pre-wave the extractor prompt
  // told the model to skip low rows entirely, so `all` under-delivered on
  // its own promise; it now really does capture them. Callers that want
  // suppression pass 'high-only' (sync does).
  const notabilityAdmission = filter === 'high-only'
    ? { allowed: ['high'] as const, invalid: 'drop' as const }
    : filter === 'medium-and-up'
      ? { allowed: ['high', 'medium'] as const, invalid: 'drop' as const }
      : undefined;
  const outcome = await extractFactsFromTurnWithOutcome({
    turnText: input.turnText,
    sessionId: ctx.sessionId,
    entityHints: ctx.entityHints,
    source: ctx.source,
    isDreamGenerated: input.isDreamGenerated,
    engine: ctx.engine,
    abortSignal,
    model: ctx.model,
    notabilityAdmission,
  });

  if (!outcome.ok) {
    // Transport-class failures PROPAGATE as a typed error: the queue-mode
    // catch maps them to precise absorb-log codes, the durable facts-absorb
    // minion gets retry/backoff, and the inline extract_facts op surfaces a
    // real error instead of lying `inserted: 0`.
    if (outcome.reason === 'provider_error' || outcome.reason === 'truncated_output') {
      throw new FactsExtractionError(outcome.reason, outcome.model, outcome.error);
    }
    // Everything else (chat_unavailable / refusal / content_filter /
    // malformed_output / non_terminal_stop) returns zero counts with the
    // reason attached — keyless stays a calm expected state, keyed failures
    // land one ingest_log row + a once-per-process fix hint.
    await surfaceExtractionFailure(
      ctx.engine,
      input.ref ?? ctx.sessionId ?? 'turn',
      outcome.reason,
      outcome.model,
      ctx.sourceId,
    );
    return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [], skipped_reason: outcome.reason };
  }

  const facts = outcome.facts;

  // [ENG-8] Explicit ctx.visibility wins; unset resolves the operator-set
  // facts.default_visibility (fail-closed to 'private').
  const { resolveDefaultVisibility } = await import('./visibility.ts');
  const visibility = ctx.visibility ?? (await resolveDefaultVisibility(ctx.engine));

  let inserted = 0;
  let duplicate = 0;
  let superseded = 0;
  const fact_ids: number[] = [];
  // Cathedral 5: slugs whose fence-write actually inserted a fact this run.
  const fencedSlugs = new Set<string>();

  // Phase 1: per-fact filter + dedup. Surviving facts (no dedup hit)
  // get grouped by entity_slug for the fence-write phase below.
  type SurvivedFact = {
    f: typeof facts[number];
    resolvedSlug: string | null;
    // #4108: resolution provenance threaded to the fence writer's stub guard.
    resolutionSource: ResolutionSource | null;
  };
  const survived: SurvivedFact[] = [];

  for (const f of facts) {
    if (abortSignal?.aborted) break;

    // D4: notability filter applied post-extraction, pre-insert.
    if (filter === 'high-only' && f.notability !== 'high') continue;

    const resolved = f.entity_slug
      ? await resolveEntitySlugWithSource(ctx.engine, ctx.sourceId, f.entity_slug)
      : null;
    const resolvedSlug = resolved?.slug ?? null;
    const resolutionSource = resolved?.source ?? null;

    // Dedup against DB candidates (correct per Codex Q7: fence rows
    // have no embeddings; FS lock + sync invariant means DB == fence
    // at write time). Threshold 0.95 unchanged.
    let matchedExistingId: number | null = null;
    if (resolvedSlug && f.embedding) {
      const candidates = await ctx.engine.findCandidateDuplicates(
        ctx.sourceId,
        resolvedSlug,
        f.fact,
        { embedding: f.embedding, k: DEDUP_CANDIDATE_LIMIT },
      );
      let topId: number | null = null;
      let topScore = -1;
      for (const c of candidates) {
        if (!c.embedding) continue;
        const s = cosineSimilarity(f.embedding, c.embedding);
        if (s > topScore) { topScore = s; topId = c.id; }
      }
      if (topId !== null && topScore >= DEDUP_THRESHOLD) {
        matchedExistingId = topId;
      }
    }

    if (matchedExistingId !== null) {
      duplicate += 1;
      fact_ids.push(matchedExistingId);
      continue;
    }

    survived.push({ f, resolvedSlug, resolutionSource });
  }

  if (survived.length === 0) {
    return { inserted, duplicate, superseded, fact_ids, entity_slugs: [] };
  }

  // Phase 2: group survived facts by resolved entity_slug. Facts with
  // no resolved slug go to a special legacy bucket.
  const byEntity = new Map<string, SurvivedFact[]>();
  const unparented: SurvivedFact[] = [];
  for (const s of survived) {
    if (s.resolvedSlug === null) {
      unparented.push(s);
    } else {
      const list = byEntity.get(s.resolvedSlug) ?? [];
      list.push(s);
      byEntity.set(s.resolvedSlug, list);
    }
  }

  // Phase 3: look up source.local_path once for the fence path. Null
  // means thin-client / no FS — fall through to legacy DB-only for
  // every fact. The `sync.write_through` opt-out takes the same DB-only
  // route (no fence file, no stub page, no commit) without the
  // thin-client warning — the operator chose it.
  const { isWriteThroughDisabled } = await import('../write-through.ts');
  const writeThroughDisabled = await isWriteThroughDisabled(ctx.engine);
  const localPath = writeThroughDisabled
    ? null
    : await lookupSourceLocalPath(ctx.engine, ctx.sourceId);

  // Phase 4: legacy DB-only fallback for unparented + thin-client.
  // Single-row engine.insertFact preserves the v0.31 semantics for
  // these structurally-unfenceable cases.
  const legacyBucket: SurvivedFact[] = [];
  if (localPath === null) {
    if (!writeThroughDisabled) {
      // #4489: name the REAL remedy. The sources dispatcher has no
      // "update" verb — attaching a working tree to a path-less source goes
      // through `gbrain sources add <id> --path <dir>` (the #3903
      // non-destructive attach path in sources-ops.ts). Pinned by
      // test/facts-backstop-remedy-verb.test.ts.
      warnOnce(
        'facts:thin-client-fallback',
        '[facts] sources.local_path unset for source_id=' + ctx.sourceId +
        ' — falling through to DB-only inserts. Attach a working tree via `gbrain sources add ' + ctx.sourceId +
        ' --path <dir>` to enable system-of-record fence writes.',
      );
    }
    for (const s of survived) legacyBucket.push(s);
  } else {
    for (const s of unparented) legacyBucket.push(s);
  }

  for (const { f, resolvedSlug } of legacyBucket) {
    const newFact: NewFact = {
      fact: f.fact,
      kind: f.kind,
      entity_slug: resolvedSlug,
      visibility,
      notability: f.notability,
      source: f.source,
      source_session: f.source_session ?? null,
      confidence: f.confidence,
      embedding: f.embedding ?? null,
      // #4206: caller event-time fallback + provenance context.
      valid_from: f.valid_from ?? ctx.validFrom,
      context: ctx.sourceSlug ?? null,
    };
    const result = await ctx.engine.insertFact(newFact, { source_id: ctx.sourceId }); // gbrain-allow-direct-insert: legacy DB-only fallback for unparented / thin-client facts (no entity page to fence onto)
    fact_ids.push(result.id);
    if (result.status === 'inserted') inserted += 1;
    else if ((result.status as FactInsertStatus) === 'duplicate') duplicate += 1;
    else superseded += 1;
  }

  if (localPath === null) {
    // All went through legacy bucket; nothing left to fence — DB-only
    // inserts have no fence-written page, so entity_slugs stays empty.
    return { inserted, duplicate, superseded, fact_ids, entity_slugs: [] };
  }

  // Phase 5: fence-write per entity. writeFactsToFence handles the
  // page lock, stub-create, atomic .tmp+parse+rename, and the
  // engine.insertFacts batch.
  for (const [slug, group] of byEntity) {
    if (abortSignal?.aborted) break;

    const inputFacts = group.map(({ f }) => ({
      fact: f.fact,
      kind: f.kind,
      notability: f.notability,
      source: f.source,
      // #4206: the caller's source_slug (which page/transcript the turn came
      // from) lands in the fence context cell — visible in recall projections.
      context: ctx.sourceSlug ?? null,
      visibility,
      confidence: f.confidence,
      // #4206: extractor-derived date wins; then the caller's event time
      // (historical imports); then import time.
      validFrom: f.valid_from ?? ctx.validFrom ?? new Date(),
      embedding: f.embedding ?? null,
      sessionId: f.source_session ?? null,
    }));

    // #4108 fail-closed on mixed provenance: one fallback-minted ref in the
    // group means the slug's existence is unproven — block the whole group.
    // (byEntity members always resolved non-null, so null here is defensive.)
    const groupResolutionSource: ResolutionSource = group.some(
      (s) => s.resolutionSource === 'fallback_slugify' || s.resolutionSource == null,
    )
      ? 'fallback_slugify'
      : group[0].resolutionSource!;

    const result = await writeFactsToFence(
      ctx.engine,
      { sourceId: ctx.sourceId, localPath, slug, resolutionSource: groupResolutionSource },
      inputFacts,
    );

    if (result.fenceWriteFailed) {
      // Fence parse-validate rejected the .tmp; .tmp stays as
      // quarantine. The JSONL log is the operator surface. Treat
      // every fact in this entity group as not-inserted (no fact_id
      // returned). Do NOT fall through to legacy DB-only — that
      // would write rows to a DB index whose fence is broken.
      continue;
    }
    if (result.stubGuardBlocked || result.targetUnresolvable) {
      // v0.34.5: writeFactsToFence refused to spawn a phantom
      // unprefixed entity page (e.g. `jared.md` at brain root) —
      // or, #4108, a page for a fallback-resolved slug no live page
      // backs. #4204: or the shared page-target resolver found the
      // source tree unusable (deleted dir / hostile source_path row).
      // Route these facts to the legacy DB-only path so they
      // aren't dropped — the slug stays attached but no markdown
      // file is created. This also keeps blocked slugs out of
      // fencedSlugs, so fallback-minted slugs never reach the
      // entity_slugs checkpoint/link manifests downstream.
      for (const { f } of group) {
        const newFact: NewFact = {
          fact: f.fact,
          kind: f.kind,
          entity_slug: slug,
          visibility,
          notability: f.notability,
          source: f.source,
          source_session: f.source_session ?? null,
          confidence: f.confidence,
          embedding: f.embedding ?? null,
          // #4206: caller event-time fallback + provenance context.
          valid_from: f.valid_from ?? ctx.validFrom,
          context: ctx.sourceSlug ?? null,
        };
        const legacyResult = await ctx.engine.insertFact(newFact, { source_id: ctx.sourceId }); // gbrain-allow-direct-insert: stub-guard / unresolvable-target fallback for unprefixed or fallback-resolved entity slugs (no fenceable page or usable tree)
        fact_ids.push(legacyResult.id);
        if (legacyResult.status === 'inserted') inserted += 1;
        else if ((legacyResult.status as FactInsertStatus) === 'duplicate') duplicate += 1;
        else superseded += 1;
      }
      continue;
    }
    if (result.legacyFallback) {
      // writeFactsToFence saw the brain as DB-only even though phase 3
      // didn't (null-localPath echo, or the write_through flag flipped
      // mid-pipeline across the config-cache TTL). Route the group to the
      // legacy DB-only path — never drop facts.
      warnOnce(
        'facts:fence-write-unexpected-fallback',
        `[facts] writeFactsToFence returned legacyFallback for slug=${slug} despite localPath being set — routing to DB-only inserts.`,
      );
      for (const { f } of group) {
        const newFact: NewFact = {
          fact: f.fact,
          kind: f.kind,
          entity_slug: slug,
          visibility,
          notability: f.notability,
          source: f.source,
          source_session: f.source_session ?? null,
          confidence: f.confidence,
          embedding: f.embedding ?? null,
          // #4206: caller event-time fallback + provenance context.
          valid_from: f.valid_from ?? ctx.validFrom,
          context: ctx.sourceSlug ?? null,
        };
        const legacyResult = await ctx.engine.insertFact(newFact, { source_id: ctx.sourceId }); // gbrain-allow-direct-insert: DB-only fallback when the fence lane declined the write (write_through opt-out race / localPath echo)
        fact_ids.push(legacyResult.id);
        if (legacyResult.status === 'inserted') inserted += 1;
        else if ((legacyResult.status as FactInsertStatus) === 'duplicate') duplicate += 1;
        else superseded += 1;
      }
      continue;
    }

    inserted += result.inserted;
    fact_ids.push(...result.ids);
    if (result.inserted > 0) fencedSlugs.add(slug);
  }

  return { inserted, duplicate, superseded, fact_ids, entity_slugs: [...fencedSlugs] };
}
