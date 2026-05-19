/**
 * v0.36.0.0 — RetrievalUpgradePlanner (D12 architecture).
 *
 * The planner computes the brain's pending retrieval-upgrade work in one
 * pass and either previews it (planRetrievalUpgrade) or applies it
 * (applyRetrievalUpgrade). It consolidates two surfaces that BOTH invalidate
 * embeddings on the same upgrade:
 *
 *   1. v0.32.7 chunker-version bump (pages re-chunk + re-embed under the
 *      same provider). The legacy `runPostUpgradeReembedPrompt` covered this.
 *   2. v0.36.0.0 ZE-as-default switch (schema goes from current width to
 *      1024d via Matryoshka + provider flips to zeroentropyai:zembed-1).
 *
 * Letting these fire as two separate prompts on the same `gbrain upgrade`
 * would double-charge the user for re-embed (codex outside-voice flag #2).
 * The planner returns a single `RetrievalUpgradeState` capturing the
 * combined work; `applyRetrievalUpgrade` runs one schema transition (when
 * needed) + sets config so ONE re-embed pass invalidates both surfaces.
 *
 * Three config keys (D12) separate UI state, intent, and work-done:
 *
 *   ze_switch_prompt_shown    : user has seen the prompt — don't re-ask
 *   ze_switch_requested       : user said yes — schema transition is starting
 *   ze_switch_applied         : work is done — schema width + config are
 *                               aligned and re-embed can proceed
 *   ze_switch_declined_at     : ISO ts when user said "never ask again"
 *   ze_switch_previous_snapshot : JSON snapshot for --undo (D16)
 *
 * State diagram:
 *
 *   [fresh brain]
 *        |
 *        |  user picks "s" or runs `gbrain ze-switch`
 *        v
 *   prompt_shown=true, requested=true
 *        |
 *        |  schema transition runs (transaction)
 *        v
 *   ... (schema width is at target) ...
 *        |
 *        |  config writes (embedding_model, dim, reranker)
 *        v
 *   applied=true  -> stable. Re-embed via `gbrain embed --stale` or autopilot.
 *
 *   Crash between schema and config writes:
 *     requested=true, applied=false, schema is at target width.
 *     Doctor's `embedding_width_consistency` detects + suggests `--resume`.
 *
 *   "Never ask again" path:
 *     prompt_shown=true, declined_at=<iso>. Re-asked after 90 days (C3).
 *
 *   Undo path:
 *     ze_switch_previous_snapshot JSON drives reverse schema + config.
 *
 * The planner is intentionally NOT a migration in the MIGRATIONS array.
 * Migrations are forward-only and run for every brain on every upgrade.
 * The ZE switch is conditional (user-requested), idempotent (re-runnable),
 * and reversible (--undo). Mixing it into MIGRATIONS would muddy the
 * ledger semantics (see plan D12 for full rationale).
 */

import type { BrainEngine } from './engine.ts';
import { MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';
import { lookupEmbeddingPrice, estimateCostFromChars } from './embedding-pricing.ts';
import { computeReembedEstimate } from './post-upgrade-reembed.ts';

// ============================================================================
// Constants
// ============================================================================

/** v0.36.0.0 cutover target: ZeroEntropy zembed-1 at 1024d via Matryoshka. */
export const ZE_TARGET_EMBEDDING_MODEL = 'zeroentropyai:zembed-1';
export const ZE_TARGET_EMBEDDING_DIM = 1280;
export const ZE_TARGET_RERANKER_MODEL = 'zeroentropyai:zerank-2';

/** Config keys (D12). */
export const KEY_PROMPT_SHOWN = 'ze_switch_prompt_shown';
export const KEY_REQUESTED = 'ze_switch_requested';
export const KEY_APPLIED = 'ze_switch_applied';
export const KEY_DECLINED_AT = 'ze_switch_declined_at';
export const KEY_PREVIOUS_SNAPSHOT = 'ze_switch_previous_snapshot';

/** C3 eligibility: skip prompt for tiny brains (< 100 pages) to avoid noise. */
export const ZE_MIN_PAGES_FOR_OFFER = 100;

/** C3 eligibility: re-ask after this many days even if user said "never". */
export const ZE_DECLINE_REASK_DAYS = 90;

/** Heuristic: serial re-embed throughput per worker. */
const EMBED_PAGES_PER_MINUTE = 60;

/** Heuristic: DDL wall-clock per page on Postgres. PGLite is effectively zero. */
const POSTGRES_DDL_MS_PER_PAGE = 0.5;

// ============================================================================
// Types
// ============================================================================

export type RetrievalUpgradeState = {
  /** v0.32.7 surface: chunker-version bump pending re-chunk + re-embed. */
  chunker_bump_pending: boolean;
  /** v0.36.0.0 surface: ZE-default switch offered per C3 eligibility. */
  ze_switch_offered: boolean;
  /** User previously declined; respected unless >= ZE_DECLINE_REASK_DAYS old. */
  ze_switch_already_declined: boolean;
  current_embedding_model: string;
  current_dim: number;
  /** null = no provider change; e.g. user is already on ZE. */
  target_embedding_model: string | null;
  /** null = no dim change. */
  target_dim: number | null;
  pages_pending_chunker: number;
  /** All non-deleted pages (the whole brain) when dim changes. */
  pages_pending_dim: number;
  /** MAX(pending_chunker, pending_dim) × token_cost, NOT the sum (C4). */
  est_cost_usd: number;
  est_minutes: number;
  est_schema_change_seconds: number;
};

/**
 * Snapshot stored in `ze_switch_previous_snapshot` (D16) so --undo can
 * restore the user's exact prior config including the reranker state.
 */
export type ZeSwitchSnapshot = {
  embedding_model: string;
  embedding_dimensions: number;
  search_reranker_enabled: boolean;
  search_reranker_model: string | null;
};

/**
 * Tagged-union return (D15) so callers can dispatch on `status` without
 * parsing the `reason` string. `failed` carries a reason; all others omit it.
 */
export type ApplyResult =
  | { status: 'applied'; plan: RetrievalUpgradeState }
  | { status: 'skipped_already_applied'; plan: RetrievalUpgradeState }
  | { status: 'skipped_no_work'; plan: RetrievalUpgradeState }
  | { status: 'declined'; plan: RetrievalUpgradeState }
  | { status: 'planned'; plan: RetrievalUpgradeState }
  | { status: 'failed'; plan: RetrievalUpgradeState; reason: string };

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute the brain's pending retrieval-upgrade work. Pure read; no writes.
 *
 * Eligibility for `ze_switch_offered` (per plan C3):
 *   (a) current `embedding_model` does NOT start with `zeroentropyai:`
 *   (b) `ze_switch_declined_at` is unset OR > 90 days old
 *   (c) `ze_switch_applied` is not true
 *   (d) at least one of:
 *         - embedding_model is the legacy default (openai:text-embedding-3-large)
 *         - brain has > 100 non-deleted pages
 */
export async function planRetrievalUpgrade(engine: BrainEngine): Promise<RetrievalUpgradeState> {
  // Current config — file plane + DB plane both feed this; we read DB plane
  // because that's what the upgrade flow writes.
  const currentEmbeddingModel = await getStringConfig(engine, 'embedding_model')
    ?? 'openai:text-embedding-3-large';
  const currentDimStr = await engine.getConfig('embedding_dimensions');
  const currentDim = currentDimStr ? parseInt(currentDimStr, 10) : 1536;

  const declinedAtStr = await engine.getConfig(KEY_DECLINED_AT);
  const declinedAt = declinedAtStr ? new Date(declinedAtStr) : null;
  const declinedTooLongAgo = declinedAt
    ? (Date.now() - declinedAt.getTime()) > ZE_DECLINE_REASK_DAYS * 24 * 60 * 60 * 1000
    : true; // never declined = same as "decline expired" for the iff check
  const alreadyDeclined = declinedAt !== null && !declinedTooLongAgo;

  const applied = (await engine.getConfig(KEY_APPLIED)) === 'true';

  // Page-count probe (C3-d) — cheap COUNT(*).
  const pageCountRows = await engine.executeRaw<{ count: string | number }>(
    `SELECT COUNT(*)::bigint AS count FROM pages WHERE deleted_at IS NULL`,
  );
  const totalPages = Number(pageCountRows[0]?.count ?? 0);

  const isOnZE = currentEmbeddingModel.startsWith('zeroentropyai:');
  const isLegacyDefault = currentEmbeddingModel === 'openai:text-embedding-3-large';

  const zeSwitchOffered =
    !isOnZE
    && !alreadyDeclined
    && !applied
    && (isLegacyDefault || totalPages > ZE_MIN_PAGES_FOR_OFFER);

  // Chunker-bump pending: same query the v0.32.7 prompt uses.
  const chunkerEstimate = await computeReembedEstimate(engine, currentEmbeddingModel);
  const chunkerBumpPending = chunkerEstimate.pendingCount > 0;
  const pagesPendingChunker = chunkerEstimate.pendingCount;

  // Dim-change pending: all non-deleted pages, when target dim differs.
  const targetEmbeddingModel = zeSwitchOffered ? ZE_TARGET_EMBEDDING_MODEL : null;
  const targetDim = zeSwitchOffered ? ZE_TARGET_EMBEDDING_DIM : null;
  const pagesPendingDim = zeSwitchOffered && currentDim !== ZE_TARGET_EMBEDDING_DIM
    ? totalPages
    : 0;

  // C4 cost math: ONE re-embed pass covers both surfaces. MAX, not SUM.
  // When dim is changing, every page re-embeds at the new dim regardless of
  // chunker state; the chunker count is naturally subsumed.
  const pagesToReembed = Math.max(pagesPendingChunker, pagesPendingDim);

  // Cost: estimate at the TARGET provider's price when switching, else the
  // current provider's price. Both estimates feed lookupEmbeddingPrice; if
  // pricing is unknown we degrade to 0 (caller surfaces "estimate unavailable").
  const targetModelForCost = targetEmbeddingModel ?? currentEmbeddingModel;
  const price = lookupEmbeddingPrice(targetModelForCost);
  const charsPerPageRows = await engine.executeRaw<{ avg_chars: string | number | null }>(
    `SELECT COALESCE(AVG(LENGTH(compiled_truth) + LENGTH(timeline)), 0)::bigint AS avg_chars
       FROM pages WHERE deleted_at IS NULL`,
  );
  const avgChars = Number(charsPerPageRows[0]?.avg_chars ?? 0);
  const totalChars = avgChars * pagesToReembed;
  const estCostUsd = price.kind === 'known'
    ? estimateCostFromChars(totalChars, price.pricePerMTok)
    : 0;

  const estMinutes = pagesToReembed === 0
    ? 0
    : Math.max(1, Math.ceil(pagesToReembed / EMBED_PAGES_PER_MINUTE));
  // PGLite: schema change is fast (single-writer, no concurrency, in-process).
  // Postgres: drop+recreate column + HNSW rebuild scales with row count.
  // Cap at 60s — past that the user should be on a worker job anyway.
  const estSchemaChangeSeconds = engine.kind === 'pglite'
    ? 1
    : Math.min(60, Math.ceil(totalPages * POSTGRES_DDL_MS_PER_PAGE / 1000));

  return {
    chunker_bump_pending: chunkerBumpPending,
    ze_switch_offered: zeSwitchOffered,
    ze_switch_already_declined: alreadyDeclined,
    current_embedding_model: currentEmbeddingModel,
    current_dim: currentDim,
    target_embedding_model: targetEmbeddingModel,
    target_dim: targetDim,
    pages_pending_chunker: pagesPendingChunker,
    pages_pending_dim: pagesPendingDim,
    est_cost_usd: estCostUsd,
    est_minutes: estMinutes,
    est_schema_change_seconds: estSchemaChangeSeconds,
  };
}

/**
 * Apply the planned upgrade: capture snapshot, run schema transition,
 * write config, mark applied. Idempotent: re-running on an already-applied
 * brain returns `skipped_already_applied`.
 *
 * The order (D18 + plan A2 step list) is deliberate:
 *   1. Snapshot prior state for --undo (D16)
 *   2. Set ze_switch_requested = true
 *   3. Schema transition INSIDE a single transaction (D18)
 *      - DROP indexes, ALTER COLUMN, CREATE indexes — atomic
 *   4. Write config keys (embedding_model, dim, reranker)
 *   5. Set ze_switch_applied = true
 *
 * Crash between (3) and (4) leaves the schema at the target width but the
 * config at the source. Doctor's `embedding_width_consistency` detects this
 * and suggests `gbrain ze-switch --resume`.
 */
export async function applyRetrievalUpgrade(
  engine: BrainEngine,
  plan: RetrievalUpgradeState,
): Promise<ApplyResult> {
  // Idempotency.
  if ((await engine.getConfig(KEY_APPLIED)) === 'true') {
    return { status: 'skipped_already_applied', plan };
  }
  // No-work fast path.
  if (!plan.ze_switch_offered && !plan.chunker_bump_pending) {
    return { status: 'skipped_no_work', plan };
  }
  // The chunker-only path doesn't need a schema transition. Caller's
  // responsibility to invoke the existing `gbrain reindex --markdown` flow.
  // We return skipped_no_work for this case since the planner is the ZE-switch
  // applier; chunker-only re-embed continues through the legacy v0.32.7 path.
  if (!plan.ze_switch_offered) {
    return { status: 'skipped_no_work', plan };
  }

  try {
    // 1. Capture snapshot BEFORE any writes so --undo always has a target.
    const snapshot: ZeSwitchSnapshot = {
      embedding_model: plan.current_embedding_model,
      embedding_dimensions: plan.current_dim,
      search_reranker_enabled: (await engine.getConfig('search.reranker.enabled')) === 'true',
      search_reranker_model: await engine.getConfig('search.reranker.model'),
    };
    await engine.setConfig(KEY_PREVIOUS_SNAPSHOT, JSON.stringify(snapshot));

    // 2. Record intent.
    await engine.setConfig(KEY_REQUESTED, 'true');

    // 3. Schema transition atomically (D18). DROP indexes, swap column,
    //    recreate indexes — all in one transaction so a crash mid-flight
    //    rolls everything back. HNSW indexes are part of the transaction;
    //    no "lazy recreation" window.
    const targetDim = plan.target_dim ?? ZE_TARGET_EMBEDDING_DIM;
    await runSchemaTransition(engine, targetDim);

    // 4. Write config.
    await engine.setConfig('embedding_model', plan.target_embedding_model ?? ZE_TARGET_EMBEDDING_MODEL);
    await engine.setConfig('embedding_dimensions', String(targetDim));
    await engine.setConfig('search.reranker.enabled', 'true');
    await engine.setConfig('search.reranker.model', ZE_TARGET_RERANKER_MODEL);

    // 5. Mark work complete.
    await engine.setConfig(KEY_APPLIED, 'true');
    await engine.setConfig(KEY_PROMPT_SHOWN, 'true');

    return { status: 'applied', plan };
  } catch (err) {
    return {
      status: 'failed',
      plan,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Mark the prompt as shown without accepting. User picked Enter (default = stay). */
export async function recordDeclinedThisRun(engine: BrainEngine): Promise<void> {
  await engine.setConfig(KEY_PROMPT_SHOWN, 'true');
}

/** Mark "never ask again". User picked 'n'. */
export async function recordDeclinedForever(engine: BrainEngine): Promise<void> {
  await engine.setConfig(KEY_PROMPT_SHOWN, 'true');
  await engine.setConfig(KEY_DECLINED_AT, new Date().toISOString());
}

/**
 * Crash recovery (D5 superseded). Reads the (requested, applied) pair and
 * finishes whichever step is incomplete. Idempotent.
 */
export async function resumeRetrievalUpgrade(engine: BrainEngine): Promise<ApplyResult> {
  const requested = (await engine.getConfig(KEY_REQUESTED)) === 'true';
  const applied = (await engine.getConfig(KEY_APPLIED)) === 'true';
  const plan = await planRetrievalUpgrade(engine);

  if (applied) {
    return { status: 'skipped_already_applied', plan };
  }
  if (!requested) {
    // Nothing to resume — caller should run `applyRetrievalUpgrade` fresh.
    return { status: 'skipped_no_work', plan };
  }

  // requested=true, applied=false. Either schema is at target and config
  // still says source, or schema crashed mid-DDL. Re-run schema transition
  // (idempotent via CREATE INDEX IF NOT EXISTS + ALTER COLUMN no-op semantics)
  // then write config + mark applied.
  try {
    const targetDim = ZE_TARGET_EMBEDDING_DIM;
    await runSchemaTransition(engine, targetDim);
    await engine.setConfig('embedding_model', ZE_TARGET_EMBEDDING_MODEL);
    await engine.setConfig('embedding_dimensions', String(targetDim));
    await engine.setConfig('search.reranker.enabled', 'true');
    await engine.setConfig('search.reranker.model', ZE_TARGET_RERANKER_MODEL);
    await engine.setConfig(KEY_APPLIED, 'true');
    await engine.setConfig(KEY_PROMPT_SHOWN, 'true');
    return { status: 'applied', plan };
  } catch (err) {
    return {
      status: 'failed',
      plan,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Undo the switch (D16). Reads ze_switch_previous_snapshot, runs reverse
 * schema transition to the prior width, restores prior config. Caller is
 * responsible for surfacing the cost-warning prompt BEFORE invoking this.
 */
export async function undoRetrievalUpgrade(engine: BrainEngine): Promise<
  | { status: 'undone'; snapshot: ZeSwitchSnapshot }
  | { status: 'no_snapshot' }
  | { status: 'failed'; reason: string }
> {
  const snapshotStr = await engine.getConfig(KEY_PREVIOUS_SNAPSHOT);
  if (!snapshotStr) {
    return { status: 'no_snapshot' };
  }

  let snapshot: ZeSwitchSnapshot;
  try {
    snapshot = JSON.parse(snapshotStr) as ZeSwitchSnapshot;
  } catch (err) {
    return {
      status: 'failed',
      reason: `corrupt ze_switch_previous_snapshot: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    await runSchemaTransition(engine, snapshot.embedding_dimensions);
    await engine.setConfig('embedding_model', snapshot.embedding_model);
    await engine.setConfig('embedding_dimensions', String(snapshot.embedding_dimensions));
    await engine.setConfig('search.reranker.enabled', snapshot.search_reranker_enabled ? 'true' : 'false');
    if (snapshot.search_reranker_model) {
      await engine.setConfig('search.reranker.model', snapshot.search_reranker_model);
    } else {
      await engine.unsetConfig('search.reranker.model');
    }
    // Reset applied marker so the planner re-offers on a future upgrade.
    await engine.unsetConfig(KEY_APPLIED);
    await engine.unsetConfig(KEY_REQUESTED);
    return { status: 'undone', snapshot };
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Schema transition (D18)
// ============================================================================

/**
 * The atomic DROP + ALTER + CREATE INDEX sequence for content_chunks.
 * Both engines accept identical SQL (PGLite uses pgvector via WASM, same
 * grammar). Wrapped in engine.transaction so a partial failure rolls back.
 *
 * Index names verified against:
 *   src/schema.sql:163  -> idx_chunks_embedding
 *   src/core/pglite-schema.ts:127 -> idx_chunks_embedding
 *   src/schema.sql:169  -> idx_chunks_embedding_image
 *   src/core/pglite-schema.ts:130 -> idx_chunks_embedding_image
 *
 * IF NOT EXISTS on CREATE INDEX makes the operation safe to re-run during
 * `--resume`.
 */
async function runSchemaTransition(engine: BrainEngine, targetDim: number): Promise<void> {
  await engine.transaction(async (tx) => {
    await tx.executeRaw(`DROP INDEX IF EXISTS idx_chunks_embedding`);
    await tx.executeRaw(`DROP INDEX IF EXISTS idx_chunks_embedding_image`);
    await tx.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding`);
    await tx.executeRaw(`ALTER TABLE content_chunks ADD COLUMN embedding vector(${targetDim})`);
    await tx.executeRaw(`ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_image`);
    await tx.executeRaw(`ALTER TABLE content_chunks ADD COLUMN embedding_image vector(${targetDim})`);
    await tx.executeRaw(
      `CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)`,
    );
    await tx.executeRaw(
      `CREATE INDEX IF NOT EXISTS idx_chunks_embedding_image ON content_chunks USING hnsw (embedding_image vector_cosine_ops)`,
    );
  });
}

// ============================================================================
// Helpers
// ============================================================================

async function getStringConfig(engine: BrainEngine, key: string): Promise<string | null> {
  return await engine.getConfig(key);
}

/** For tests + introspection: re-export the chunker version we plan against. */
export { MARKDOWN_CHUNKER_VERSION };
