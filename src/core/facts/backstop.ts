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
   */
  source: 'sync:import' | 'mcp:put_page' | 'mcp:extract_facts' | 'file_upload' | 'code_import';
  /** Execution mode — D8. Default 'queue' (fire-and-forget). */
  mode?: 'queue' | 'inline';
  /** Notability filter — D4. Default 'all'; sync uses 'high-only'. */
  notabilityFilter?: 'all' | 'high-only';
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
}

/** Discriminated return shape based on FactsBackstopCtx.mode. */
export type FactsBackstopResult =
  | {
      mode: 'queue';
      enqueued: boolean;
      queueDepth: number;
      skipped?: 'extraction_disabled' | 'queue_overflow' | 'queue_shutdown' | `eligibility_failed:${string}`;
    }
  | {
      mode: 'inline';
      inserted: number;
      duplicate: number;
      superseded: number;
      fact_ids: number[];
      skipped?: 'extraction_disabled' | `eligibility_failed:${string}`;
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

  // --- Mode dispatch ---
  if (mode === 'queue') {
    const { getFactsQueue } = await import('./queue.ts');
    const queue = getFactsQueue();
    const enqueued = queue.enqueue(async (signal) => {
      // Inside the queue worker, run the full pipeline. Errors here are
      // absorbed (the queue counter increments) and PR1 commit 13 will
      // route them to ingest_log for cross-process visibility.
      await runPipeline(parsedPage, ctx, signal);
    }, ctx.sessionId ?? parsedPage.slug);

    if (enqueued < 0) {
      // -1 means the queue is shutting down OR cap-overflow drop fired.
      // Caller can disambiguate via getCounters() if they care; for now
      // collapse to a single skipped reason.
      return { mode: 'queue', enqueued: false, queueDepth: 0, skipped: 'queue_overflow' };
    }
    return { mode: 'queue', enqueued: true, queueDepth: enqueued };
  }

  // 'inline' mode: caller awaits the full pipeline.
  const r = await runPipeline(parsedPage, ctx, ctx.abortSignal);
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
): Promise<{ inserted: number; duplicate: number; superseded: number; fact_ids: number[] }> {
  return runPipelineWithBody({
    turnText,
    isDreamGenerated: false,
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
): Promise<{ inserted: number; duplicate: number; superseded: number; fact_ids: number[] }> {
  return runPipelineWithBody(
    {
      turnText: parsedPage.compiled_truth,
      isDreamGenerated: false,  // eligibility check already rejected dream pages
    },
    ctx,
    abortSignal,
  );
}

/**
 * Inner pipeline body. Shared between runFactsBackstop (page-shape entry)
 * and runFactsPipeline (raw turn-text entry). Eligibility + kill-switch
 * are upstream of this; we just extract → resolve → dedup → insert.
 */
async function runPipelineWithBody(
  input: { turnText: string; isDreamGenerated: boolean },
  ctx: FactsBackstopCtx,
  abortSignal?: AbortSignal,
): Promise<{ inserted: number; duplicate: number; superseded: number; fact_ids: number[] }> {
  const { extractFactsFromTurn } = await import('./extract.ts');
  const { resolveEntitySlug } = await import('../entities/resolve.ts');
  const { cosineSimilarity } = await import('./classify.ts');

  if (abortSignal?.aborted) {
    return { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [] };
  }

  const facts = await extractFactsFromTurn({
    turnText: input.turnText,
    sessionId: ctx.sessionId,
    entityHints: ctx.entityHints,
    source: ctx.source,
    isDreamGenerated: input.isDreamGenerated,
    engine: ctx.engine,
    abortSignal,
    model: ctx.model,
  });

  const filter = ctx.notabilityFilter ?? 'all';
  const visibility = ctx.visibility ?? 'private';

  let inserted = 0;
  let duplicate = 0;
  let superseded = 0;
  const fact_ids: number[] = [];

  for (const f of facts) {
    if (abortSignal?.aborted) break;

    // D4: notability filter applied post-extraction, pre-insert. Saves
    // the insert work but not the LLM call (filtering pre-LLM would need
    // a second LLM call to predict notability — the very thing we're
    // calling Sonnet to do).
    if (filter === 'high-only' && f.notability !== 'high') continue;

    // Resolve entity ref to canonical slug (per source).
    const resolvedSlug = f.entity_slug
      ? await resolveEntitySlug(ctx.engine, ctx.sourceId, f.entity_slug)
      : null;

    // Dedup: find candidates within the entity bucket; cosine fast-path
    // at threshold 0.95 (matches extract_facts op precedent).
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

    // Insert (no supersede in the backstop path; supersede is the
    // explicit extract_facts MCP op responsibility).
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
    };
    const result = await ctx.engine.insertFact(newFact, { source_id: ctx.sourceId });
    fact_ids.push(result.id);
    if (result.status === 'inserted') inserted += 1;
    else if ((result.status as FactInsertStatus) === 'duplicate') duplicate += 1;
    else superseded += 1;
  }

  return { inserted, duplicate, superseded, fact_ids };
}
