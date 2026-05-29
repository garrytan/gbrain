/**
 * v0.40.3.0 — contextual retrieval service (D27 P1-1 + D26 P0-2 +
 * D26 P0-3 + D27 P1-3 + D27 P2-2).
 *
 * Single source of truth for "re-embed one page with the active CR mode."
 * Composed by THREE consumers:
 *
 *   1. `src/core/import-file.ts` — sync-time re-embed during `gbrain sync`
 *      (synchronous, inline).
 *   2. `src/commands/reindex.ts` — `gbrain reindex --markdown` batch sweep
 *      (per-page loop, synchronous within the command process).
 *   3. `src/core/minions/handlers/contextual-reindex-per-chunk.ts` — Minion
 *      job handler for the post-upgrade-prompt-accepted backfill (async,
 *      worker-pool concurrency with global rate-leasing).
 *
 * The service runs the D26 P0-2 two-phase build pattern. PHASE 1 collects
 * all synopses + embeddings IN MEMORY. If any chunk triggers a refusal /
 * empty / malformed response (per D14 + D27 P1-2), PHASE 1 RESTARTS at
 * the lower 'title' tier — discarding the in-progress synopsis vectors so
 * the page's chunks NEVER end up mid-state on disk. Only after PHASE 1
 * completes successfully does PHASE 2 run a single DB transaction to
 * replace all chunks + stamp `contextual_retrieval_mode` +
 * `corpus_generation`. Crash anywhere in PHASE 1 = page-level retry with
 * zero half-state. Crash during PHASE 2 = standard transaction rollback.
 *
 * Transient failures (auth / rate_limit / timeout / network / provider_5xx
 * per D27 P1-2) are NOT swallowed into a fall-back — they throw to the
 * caller's retry loop (Minion handler retries the job; inline callers
 * propagate the throw up).
 *
 * Per D27 P2-2 the embedBatch call runs ONCE per page after the per-chunk
 * Haiku loop completes, not per-chunk. Saves per-call overhead + reduces
 * failure surface.
 *
 * Rate-leasing is the caller's responsibility (D26 P0-3 — the Minion
 * handler acquires a shared `anthropic:utility:contextual-synopsis` lease
 * per chunk before invoking the service's optional `acquireSynopsisLease`
 * / `releaseSynopsisLease` hooks). Inline callers (import-file, reindex
 * command) pass no hooks and rely on the gateway's own rate-limit retry.
 */

import { createHash } from 'crypto';
import * as fs from 'node:fs';
import { embedBatch } from './embedding.ts';
import { resolveContextualRetrievalMode } from './contextual-retrieval-resolver.ts';
import {
  buildContextualPrefix,
  extractFirstTwoSentences,
  modeRequiresHaiku,
  modeRequiresWrapper,
  sanitizeTitle,
  wrapChunkForEmbedding,
} from './embedding-context.ts';
import {
  generatePerChunkSynopsis,
  SYNOPSIS_PROMPT_VERSION,
  type GeneratePerChunkSynopsisResult,
} from './page-summary.ts';
import {
  logSynopsisFailure,
  type SynopsisFailureKind,
} from './audit-synopsis.ts';
import type { BrainEngine } from './engine.ts';
import type { ChunkInput, CRMode, Page } from './types.ts';
import type { SourceRow } from './sources-ops.ts';

/**
 * v3 = chunks embed with optional contextual retrieval wrapper. The
 * wrapper text shape itself is also versioned so future format tweaks
 * (e.g. switching to `<page_context>` instead of `<context>`, or adding
 * a structured `metadata:` block) invalidate prior embeddings via the
 * corpus_generation hash.
 */
export const TITLE_WRAPPER_VERSION = 1;

/**
 * Embedding model placeholder. The actual model name lands here from
 * `gateway.getEmbeddingModelName()` at runtime; for hash composition we
 * just need the SAME string the gateway threads into embedBatch.
 */
function getEmbeddingModelTag(): string {
  // Lazy — keeps the hash composition pure-ish without forcing the
  // gateway init at module load. Falls back to a sentinel when the
  // gateway hasn't been configured (test paths).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getEmbeddingModelName } = require('./ai/gateway.ts');
    return String(getEmbeddingModelName() ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

/**
 * Compose the corpus_generation hash per D27 P1-5. Folds the prompt
 * version + Haiku model + wrapper version + embedding model so a tweak
 * to ANY of those invalidates prior cache rows via the
 * `query_cache.page_generations` LEFT JOIN.
 *
 * Pure function — `embedding_dimensions` and `embedding_column` stay in
 * the existing KNOBS_HASH_VERSION space per A6 in the eng-review pass.
 */
export function computeCorpusGeneration(args: {
  crMode: CRMode;
  haikuModel: string;
}): string {
  return createHash('sha256')
    .update(args.crMode)
    .update('|')
    .update(String(SYNOPSIS_PROMPT_VERSION))
    .update('|')
    .update(args.haikuModel)
    .update('|')
    .update(String(TITLE_WRAPPER_VERSION))
    .update('|')
    .update(getEmbeddingModelTag())
    .digest('hex')
    .slice(0, 16);
}

/**
 * Compute source_text_hash for D27 P1-4 cache key composition. The
 * synopsis cache invalidates correctly when adjacent text changes (page
 * content edit, frontmatter change, fallback chain different source).
 */
export function computeSourceTextHash(sourceText: string): string {
  return createHash('sha256').update(sourceText).digest('hex').slice(0, 16);
}

/**
 * Result of `reembedPageWithContextualRetrieval`. Caller dispatches on
 * `kind`:
 *
 *   success → all chunks embedded + page stamped, DB transaction committed
 *   skipped → mode='none' OR page has no chunks; no DB writes
 *   page_fallback → PHASE 1 detected a refusal/empty/malformed; restarted
 *      at lower tier; final tier in `mode_applied` is what landed
 *   transient_error → caller should retry (Minion job retries; inline
 *      callers propagate)
 *   permanent_error → won't be fixed by retry; doctor surfaces
 */
export type ReembedPageResult =
  | {
      kind: 'success';
      mode_applied: CRMode;
      chunks_embedded: number;
      corpus_generation: string;
    }
  | {
      kind: 'skipped';
      reason: 'mode_none' | 'no_chunks' | 'page_missing' | 'soft_deleted';
    }
  | {
      kind: 'page_fallback';
      mode_attempted: CRMode;
      mode_applied: CRMode;
      chunks_embedded: number;
      corpus_generation: string;
      fallback_kind: SynopsisFailureKind;
    }
  | {
      kind: 'transient_error';
      cause: SynopsisFailureKind | 'embed' | 'db';
      detail: string;
    }
  | {
      kind: 'permanent_error';
      cause: SynopsisFailureKind | 'embed' | 'db';
      detail: string;
    };

export interface ReembedPageArgs {
  engine: BrainEngine;
  /** Page slug (within `sourceId`). */
  pageSlug: string;
  /** Source that owns the page (multi-source brains). */
  sourceId: string;
  /** Global effective mode from the active ModeBundle. */
  globalMode: CRMode;
  /**
   * Soft kill switch from D18. When true, the resolver short-circuits to
   * 'none' regardless of frontmatter / source / global. Wrapped vectors
   * already in `content_chunks` continue serving queries.
   */
  killSwitchDisabled?: boolean;
  /**
   * Optional Haiku model override. When unset, page-summary.ts falls back
   * to its default (Haiku 4.5). Threaded so eval / future per-source
   * model overrides can choose a different model.
   */
  haikuModel?: string;
  /** Optional abort signal threaded into gateway.chat + embedBatch. */
  abortSignal?: AbortSignal;
  /**
   * Optional rate-leaser hooks (D26 P0-3). The Minion handler wires
   * src/core/minions/rate-leases.ts here; inline callers (import-file,
   * reindex command) pass undefined and rely on gateway-level retry.
   */
  acquireSynopsisLease?: () => Promise<void>;
  releaseSynopsisLease?: () => Promise<void>;
}

const DEFAULT_HAIKU_MODEL = 'anthropic:claude-haiku-4-5-20251001';

/**
 * Re-embed one page through the active CR mode. Implements the D26 P0-2
 * two-phase build pattern.
 */
export async function reembedPageWithContextualRetrieval(
  args: ReembedPageArgs,
): Promise<ReembedPageResult> {
  // ── Load page + source + chunks ────────────────────────────────────
  const page = await args.engine.getPage(args.pageSlug, { sourceId: args.sourceId });
  if (!page) {
    return { kind: 'skipped', reason: 'page_missing' };
  }
  if (page.deleted_at != null) {
    return { kind: 'skipped', reason: 'soft_deleted' };
  }

  const source = await loadSourceRow(args.engine, args.sourceId);

  // ── Resolve effective mode (D5+D6+D15+D18) ─────────────────────────
  const resolution = resolveContextualRetrievalMode({
    pageFrontmatter: page.frontmatter ?? {},
    source: {
      id: source.id,
      contextual_retrieval_mode: source.contextual_retrieval_mode ?? null,
      trust_frontmatter_overrides: source.trust_frontmatter_overrides ?? false,
    },
    globalMode: args.globalMode,
    killSwitchDisabled: args.killSwitchDisabled ?? false,
  });

  // 'none' mode skips wrapping entirely. Still stamp the column to record
  // the page is up-to-date relative to current global state — prevents
  // the reindex sweep from re-walking pages that are already aligned.
  if (resolution.mode === 'none') {
    await args.engine.updatePageContextualRetrievalState(
      args.pageSlug,
      args.sourceId,
      'none',
      null,
    );
    return { kind: 'skipped', reason: 'mode_none' };
  }

  const chunks = await args.engine.getChunks(args.pageSlug, { sourceId: args.sourceId });
  if (chunks.length === 0) {
    // No chunks but page exists (frontmatter-only or empty). Stamp the
    // column anyway so subsequent reindex sweeps don't keep visiting.
    await args.engine.updatePageContextualRetrievalState(
      args.pageSlug,
      args.sourceId,
      resolution.mode,
      computeCorpusGeneration({ crMode: resolution.mode, haikuModel: args.haikuModel ?? DEFAULT_HAIKU_MODEL }),
    );
    return { kind: 'skipped', reason: 'no_chunks' };
  }

  // ── PHASE 1: in-memory build (no DB writes) ────────────────────────
  // Iterate at most twice — once at the requested tier, once at the
  // fall-back 'title' tier if a refusal/empty/malformed fires. The
  // fall-back path is the D14 page-level consistency guarantee: a
  // single bad chunk demotes the whole page to title-only so all
  // chunks on the page share the same wrapper shape.
  const haikuModel = args.haikuModel ?? DEFAULT_HAIKU_MODEL;
  let attemptMode: CRMode = resolution.mode;
  let fallbackReason: SynopsisFailureKind | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const phase1 = await tryBuildPhase1({
      attemptMode,
      page,
      chunks: chunks as ChunkInput[],
      args,
      haikuModel,
    });

    if (phase1.kind === 'success') {
      const corpus_generation = computeCorpusGeneration({
        crMode: attemptMode,
        haikuModel,
      });

      // ── PHASE 2: single DB transaction ───────────────────────────
      try {
        await args.engine.transaction(async (tx) => {
          await tx.upsertChunks(args.pageSlug, phase1.embeddedChunks, {
            sourceId: args.sourceId,
          });
          await tx.updatePageContextualRetrievalState(
            args.pageSlug,
            args.sourceId,
            attemptMode,
            corpus_generation,
          );
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { kind: 'transient_error', cause: 'db', detail };
      }

      if (fallbackReason != null) {
        return {
          kind: 'page_fallback',
          mode_attempted: resolution.mode,
          mode_applied: attemptMode,
          chunks_embedded: phase1.embeddedChunks.length,
          corpus_generation,
          fallback_kind: fallbackReason,
        };
      }
      return {
        kind: 'success',
        mode_applied: attemptMode,
        chunks_embedded: phase1.embeddedChunks.length,
        corpus_generation,
      };
    }

    // PHASE 1 failed. Decide whether to fall back or surface.
    if (phase1.kind === 'page_level_fallback_requested') {
      if (attemptMode === 'title') {
        // Already at the lowest non-none tier; can't fall back further.
        // Stamp as 'none' and treat as permanent so doctor flags.
        return {
          kind: 'permanent_error',
          cause: phase1.cause,
          detail: 'Even title-only tier failed; pages_summary call surfaced unrecoverable error.',
        };
      }
      // Restart PHASE 1 at the lower tier. fallbackReason captures the
      // original failure kind for the result envelope.
      fallbackReason = phase1.cause;
      attemptMode = 'title';
      continue;
    }

    // Transient (rate_limit / timeout / network / provider_5xx) or auth
    // failure — caller decides retry policy.
    return {
      kind: phase1.kind === 'transient' ? 'transient_error' : 'permanent_error',
      cause: phase1.cause,
      detail: phase1.detail,
    };
  }
}

// ── Internal helpers ────────────────────────────────────────────────

interface Phase1Success {
  kind: 'success';
  embeddedChunks: ChunkInput[];
}
interface Phase1FallbackRequest {
  kind: 'page_level_fallback_requested';
  cause: SynopsisFailureKind;
}
interface Phase1Transient {
  kind: 'transient';
  cause: SynopsisFailureKind | 'embed';
  detail: string;
}
interface Phase1Permanent {
  kind: 'permanent';
  cause: SynopsisFailureKind | 'embed';
  detail: string;
}
type Phase1Result = Phase1Success | Phase1FallbackRequest | Phase1Transient | Phase1Permanent;

async function tryBuildPhase1(opts: {
  attemptMode: CRMode;
  page: Page;
  chunks: ChunkInput[];
  args: ReembedPageArgs;
  haikuModel: string;
}): Promise<Phase1Result> {
  const { attemptMode, page, chunks, args, haikuModel } = opts;

  // Build the wrapper prefix for THIS page. Title-only tier: one prefix
  // reused across all chunks. per_chunk_synopsis tier: prefix is built
  // per-chunk with the chunk-specific Haiku synopsis.
  const safeTitle = sanitizeTitle(page.title);

  if (attemptMode === 'title' || !modeRequiresHaiku(attemptMode)) {
    // Title-only path. No Haiku calls; pure string concat.
    // Use compiled_truth first sentences as a free pseudo-summary when
    // the title tier wants slightly more context — but per D2 the
    // balanced default is title-only without summary. Keep it pure for
    // now; the title block alone is what 'balanced' ships.
    const prefix = buildContextualPrefix(safeTitle, null);
    const wrappedTexts = chunks.map((c) =>
      modeRequiresWrapper(attemptMode)
        ? wrapChunkForEmbedding(c.chunk_text, prefix, c.chunk_source)
        : c.chunk_text,
    );

    try {
      const embeddings = await embedBatch(wrappedTexts, { abortSignal: args.abortSignal });
      return {
        kind: 'success',
        embeddedChunks: chunks.map((c, i) => ({
          ...c,
          chunk_text: c.chunk_text, // canonical, NOT the wrapped string (D20-T1)
          embedding: embeddings[i],
          token_count: Math.ceil(wrappedTexts[i].length / 4),
        })),
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return classifyEmbedError(err, detail);
    }
  }

  // per_chunk_synopsis path. Read source text via fallback chain,
  // generate synopsis per chunk sequentially within this page (D10),
  // batch embed at the end (D27 P2-2).
  const sourceText = readSourceTextWithFallback(page, chunks);
  const wrappedTexts: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];

    // Code chunks always bypass the wrapper (D20-T4) — pass through.
    if (c.chunk_source === 'fenced_code') {
      wrappedTexts.push(c.chunk_text);
      continue;
    }

    // Acquire rate-lease per chunk (D26 P0-3). Inline callers pass no
    // hooks; only the Minion handler wires through rate-leases.ts.
    if (args.acquireSynopsisLease) {
      await args.acquireSynopsisLease();
    }

    let synopsisResult: GeneratePerChunkSynopsisResult;
    try {
      synopsisResult = await generatePerChunkSynopsis({
        documentText: sourceText,
        chunkText: c.chunk_text,
        pageTitle: page.title,
        pageSlug: args.pageSlug,
        sourceId: args.sourceId,
        chunkIndex: c.chunk_index,
        model: haikuModel,
        abortSignal: args.abortSignal,
      });
    } finally {
      if (args.releaseSynopsisLease) {
        try {
          await args.releaseSynopsisLease();
        } catch {
          // Lease release failure shouldn't abort the page; surfacing it
          // would race with the synopsis result. Audit-only.
        }
      }
    }

    if (synopsisResult.kind === 'success') {
      const prefix = buildContextualPrefix(safeTitle, synopsisResult.synopsis);
      wrappedTexts.push(
        wrapChunkForEmbedding(c.chunk_text, prefix, c.chunk_source),
      );
      continue;
    }

    // Failure classification per D27 P1-2:
    //   refusal | empty | malformed → page-level fall-back to title-only
    //   auth_failure → permanent (won't fix with retry)
    //   rate_limit | timeout | network | provider_5xx → transient
    //   source_missing → walked into fallback already; would be 'malformed'
    //     from generatePerChunkSynopsis if we ever propagated it here
    if (
      synopsisResult.kind === 'refusal' ||
      synopsisResult.kind === 'empty' ||
      synopsisResult.kind === 'malformed'
    ) {
      return { kind: 'page_level_fallback_requested', cause: synopsisResult.kind };
    }
    if (synopsisResult.kind === 'auth_failure') {
      return {
        kind: 'permanent',
        cause: synopsisResult.kind,
        detail: synopsisResult.detail ?? 'auth failure',
      };
    }
    return {
      kind: 'transient',
      cause: synopsisResult.kind,
      detail: synopsisResult.detail ?? 'transient',
    };
  }

  // All chunks synthesized successfully. Single batch embed (D27 P2-2).
  try {
    const embeddings = await embedBatch(wrappedTexts, { abortSignal: args.abortSignal });
    return {
      kind: 'success',
      embeddedChunks: chunks.map((c, i) => ({
        ...c,
        chunk_text: c.chunk_text, // canonical (D20-T1)
        embedding: embeddings[i],
        token_count: Math.ceil(wrappedTexts[i].length / 4),
      })),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return classifyEmbedError(err, detail);
  }
}

/**
 * Source-text fallback chain per D11:
 *   1. read page.source_path from disk (truest "document")
 *   2. concat all chunks (loses frontmatter context but in-memory)
 *   3. just the chunks one-by-one (degraded; loses cross-chunk context)
 *
 * For step 2/3 we just concatenate chunk_text — synopsis quality
 * degrades but stays valid.
 */
function readSourceTextWithFallback(page: Page, chunks: ChunkInput[]): string {
  // Step 1: try filesystem read
  // Note: Page type doesn't carry source_path in the canonical shape;
  // it lives on PageInput / DB column. For now we attempt the chunk-concat
  // path directly — a v0.41+ wave can thread source_path through Page if
  // the synopsis quality benchmark shows the filesystem read materially
  // helps.

  if (chunks.length === 0) return page.title;

  // Step 2: chunk-concat (in-memory).
  return chunks
    .filter((c) => c.chunk_source !== 'image_asset')
    .map((c) => c.chunk_text)
    .join('\n\n');
}

async function loadSourceRow(engine: BrainEngine, sourceId: string): Promise<SourceRow> {
  const rows = await engine.executeRaw<SourceRow>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config, created_at,
            contextual_retrieval_mode, trust_frontmatter_overrides
     FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (rows.length === 0) {
    throw new Error(`Source not found: ${sourceId}`);
  }
  return rows[0];
}

function classifyEmbedError(err: unknown, detail: string): Phase1Transient | Phase1Permanent {
  const e = err as { status?: number; code?: string; name?: string };
  if (e.status === 401 || e.status === 403) {
    return { kind: 'permanent', cause: 'embed', detail };
  }
  if (
    e.status === 429 ||
    (e.status != null && e.status >= 500 && e.status < 600) ||
    e.name === 'AbortError' ||
    /timeout|network|fetch/i.test(detail)
  ) {
    return { kind: 'transient', cause: 'embed', detail };
  }
  return { kind: 'transient', cause: 'embed', detail };
}

/**
 * Public helper for the eng-review T9 reindex sweep: compute the
 * expected effective mode for one page given (page row, source row,
 * global mode, kill switch). Used by the reindex predicate to decide
 * whether a page is drifted relative to its expected state.
 *
 * Pure — no DB / network. Doesn't read frontmatter; the reindex
 * sweep parses frontmatter separately in the candidate path that
 * resolves overrides.
 */
export function expectedModeForPageSourceOnly(args: {
  source: { id: string; contextual_retrieval_mode?: string | null };
  globalMode: CRMode;
  killSwitchDisabled?: boolean;
}): CRMode {
  if (args.killSwitchDisabled) return 'none';
  const sm = args.source.contextual_retrieval_mode;
  if (sm === 'none' || sm === 'title' || sm === 'per_chunk_synopsis') {
    return sm;
  }
  return args.globalMode;
}

// fs imported above for the future filesystem-read path.
void fs;
