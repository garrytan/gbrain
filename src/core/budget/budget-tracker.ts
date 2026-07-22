/**
 * v0.37.x — unified BudgetTracker for every gateway-routed LLM call.
 *
 * Replaces the per-command budget code (brainstorm orchestrator inline
 * BudgetExhausted, cycle/budget-meter, eval-contradictions cost-prompt +
 * cost-tracker). One class, one error type, one audit JSONL schema.
 *
 * Compose via `withBudgetTracker(tracker, fn)` from `src/core/ai/gateway.ts`
 * (Phase 2 / TX5). Once inside the scope, every `gateway.chat / embed /
 * rerank` call auto-records cost via AsyncLocalStorage — no per-call
 * injection seam needed.
 *
 * Contracts (locked by /plan-eng-review):
 *   - TX1: `record()` THROWS BudgetExhausted(reason:'cost') when cumulative
 *     spend > maxCostUsd. The cap is a real ceiling, not a suggestion.
 *   - TX2: When `maxCostUsd` is set AND the model is not in the pricing
 *     maps, `reserve()` HARD-FAILS with BudgetExhausted(reason:'no_pricing').
 *     When `maxCostUsd` is unset, legacy warn-once behavior is preserved.
 *   - A3 amended: `record()` is best called from try/finally on every
 *     gateway site. When the call threw without usage, callers feed
 *     `extractUsageFromError(err, fallback)` — fallback is the pessimistic
 *     ceiling (`maxOutputTokens` worth of output), not the optimistic
 *     pre-call estimate. Better to overcount on failure than undercount.
 *
 * Audit JSONL lives at `~/.gbrain/audit/budget-YYYY-Www.jsonl` (ISO-week
 * rotation, same shape as shell-audit / phantom-audit). Every line carries
 * `schema_version: 1` so consumers can detect future renames. Writes are
 * best-effort: a disk-full audit never gates the run.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from '../config.ts';
import { ANTHROPIC_PRICING, type ModelPricing } from '../anthropic-pricing.ts';
import { EMBEDDING_PRICING, lookupEmbeddingPrice } from '../embedding-pricing.ts';
import { splitProviderModelId } from '../model-id.ts';
import { isoWeekFilename, resolveAuditDir } from '../audit-week-file.ts';

export type BudgetKind = 'chat' | 'embed' | 'rerank';

export type BudgetReason = 'cost' | 'runtime' | 'no_pricing';

export interface BudgetEstimate {
  modelId: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  kind: BudgetKind;
  /** Optional label for telemetry (e.g. 'brainstorm.cross', 'dream.synthesize'). */
  label?: string;
}

export interface BudgetActualUsage {
  modelId: string;
  inputTokens: number;
  outputTokens?: number;
  /** For embeddings: dimension count, surfaces in audit only. */
  embeddingDims?: number;
  /** Optional label echo for the audit row. */
  label?: string;
}

export interface BudgetSnapshot {
  cumulativeCostUsd: number;
  startedAt: number;
  elapsedMs: number;
  maxCostUsd?: number;
  maxRuntimeMs?: number;
  callsRecorded: number;
}

export interface BudgetTrackerOpts {
  /** USD cap. When undefined, cost gate disabled; pricing misses warn-once. */
  maxCostUsd?: number;
  /** Wall-clock cap in milliseconds. When undefined, runtime gate disabled. */
  maxRuntimeMs?: number;
  /** Phase/command label used in audit rows. */
  label: string;
  /** Override the audit file path (tests + custom installers). */
  auditPath?: string;
}

export class BudgetExhausted extends Error {
  readonly tag = 'BUDGET_EXHAUSTED' as const;
  reason: BudgetReason;
  spent: number;
  cap: number;
  modelId?: string;
  constructor(
    message: string,
    opts: { reason: BudgetReason; spent: number; cap: number; modelId?: string },
  ) {
    super(message);
    this.name = 'BudgetExhausted';
    this.reason = opts.reason;
    this.spent = opts.spent;
    this.cap = opts.cap;
    this.modelId = opts.modelId;
  }
}

/** One-process memo: warn-once on missing pricing per (modelId, kind). */
const _unpricedWarnings = new Set<string>();

/** Test seam: reset warn-once memo so unit tests can re-trigger the path. */
export function _resetBudgetTrackerWarningsForTest(): void {
  _unpricedWarnings.clear();
}

/**
 * Best-effort JSONL audit append. Failure never gates the run; matches the
 * shell-audit / phantom-audit posture.
 */
function appendAuditLine(path: string, entry: object): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch {
    // swallow — audit failures must not block the LLM call
  }
}

function defaultAuditPath(): string {
  const dir = resolveAuditDir();
  return `${dir}/${isoWeekFilename('budget')}`;
}

/**
 * Provider id prefixes that always price at $0 for the rerank kind
 * (electricity, not API tokens). Centralized here so `--max-cost` callers
 * don't hard-fail TX2 when a local rerank provider is configured. Matched
 * against the provider half of the `provider:model` string. Extend this set
 * when adding new local-inference rerank recipes.
 */
const FREE_LOCAL_RERANK_PROVIDERS: ReadonlySet<string> = new Set([
  'llama-server-reranker',
]);

/**
 * Provider id prefixes whose embeddings run on local inference (electricity,
 * not API tokens) and so price at $0. Without this, a `--max-cost`-bounded
 * embed/reindex job configured for a local provider TX2 hard-fails because
 * lookupEmbeddingPrice has no entry for them. Matched against the provider
 * half of the `provider:model` string.
 *
 * 'lmstudio' is intentionally excluded — no lmstudio recipe is registered, so
 * `lmstudio:` model strings never resolve (the env mapping in cli.ts is
 * pre-existing dead plumbing). 'litellm' is excluded too — a LiteLLM proxy can
 * front a paid provider, so pricing-unknown is the honest state there.
 *
 * Sibling to FREE_LOCAL_RERANK_PROVIDERS; v0.41+ TODO unifies them via
 * recipe-cost-driven resolution.
 */
const FREE_LOCAL_EMBED_PROVIDERS: ReadonlySet<string> = new Set([
  'ollama',
  'llama-server',
]);

/**
 * Look up `modelId` in the chat or embedding pricing maps. Returns a
 * per-1M-token price tuple, or null when unknown.
 *
 * Strategy:
 *   - Chat: try the bare model id in ANTHROPIC_PRICING first (legacy keys
 *     are bare claude-* ids). Fall back to the provider-prefixed key.
 *   - Embed: lookupEmbeddingPrice handles the provider:model form; on a miss,
 *     local-inference providers (FREE_LOCAL_EMBED_PROVIDERS) price at $0 so
 *     `--max-cost` callers don't hard-fail.
 *   - Rerank: try ANTHROPIC_PRICING (legacy path for any Claude-priced
 *     rerank); else try lookupEmbeddingPrice — paid rerank providers (e.g.
 *     ZeroEntropy's zerank-2) share the same provider:model-keyed,
 *     $/1M-token table as their embedding siblings, so it's reused here
 *     rather than duplicated into a third table; else if the provider half
 *     is in FREE_LOCAL_RERANK_PROVIDERS, return zero pricing so `--max-cost`
 *     callers don't TX2 hard-fail on local inference recipes (electricity,
 *     not tokens); else unknown.
 */
function lookupPricing(modelId: string, kind: BudgetKind): ModelPricing | null {
  if (kind === 'embed') {
    const hit = lookupEmbeddingPrice(modelId);
    if (hit.kind === 'known') {
      return { input: hit.pricePerMTok, output: 0 };
    }
    // v0.40.x: local-inference embed providers cost electricity, not tokens.
    if (hit.kind === 'unknown' && FREE_LOCAL_EMBED_PROVIDERS.has(hit.provider)) {
      return { input: 0, output: 0 };
    }
    return null;
  }
  // chat or rerank: try bare key first, then provider:model or provider/model.
  // v0.41.21.0: route through splitProviderModelId so slash-prefixed ids
  // (the form `--judge-model` and OpenRouter recipes emit) hit the pricing
  // table. Pre-fix, slash-form silently no_pricing-failed `--max-cost` on
  // brainstorm/lsd.
  const bare = ANTHROPIC_PRICING[modelId];
  if (bare) return bare;
  const { provider: providerId, model: modelTail } = splitProviderModelId(modelId);
  if (modelTail) {
    const tailHit = ANTHROPIC_PRICING[modelTail];
    if (tailHit) return tailHit;
  }
  // Paid rerank providers (e.g. ZeroEntropy's zerank-2) aren't Claude-priced,
  // so they miss the ANTHROPIC_PRICING checks above. Reuse the embedding
  // pricing table (issue #3223) — same provider:model key shape, same
  // $/1M-token unit — instead of hand-copying a third pricing surface.
  if (kind === 'rerank') {
    const hit = lookupEmbeddingPrice(modelId);
    if (hit.kind === 'known') return { input: hit.pricePerMTok, output: 0 };
  }
  // v0.40.6.1: zero-price local-inference rerank providers so the budget
  // tracker's TX2 hard-fail doesn't trip on `llama-server-reranker:<model>`
  // under `--max-cost`. Only the rerank kind — chat/embed already have
  // their own provider-specific pricing surfaces.
  if (kind === 'rerank' && providerId && FREE_LOCAL_RERANK_PROVIDERS.has(providerId)) {
    return { input: 0, output: 0 };
  }
  return null;
}

function costForUsage(modelId: string, inputTokens: number, outputTokens: number, kind: BudgetKind): number | null {
  const p = lookupPricing(modelId, kind);
  if (!p) return null;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

export class BudgetTracker {
  private cumulativeUsd = 0;
  private callsRecorded = 0;
  private readonly startedAt: number;
  private readonly auditPath: string;
  private readonly onExhaustedCbs: Array<() => void> = [];
  private exhaustedFired = false;

  constructor(private readonly opts: BudgetTrackerOpts) {
    this.startedAt = Date.now();
    this.auditPath = opts.auditPath ?? defaultAuditPath();
  }

  /** Public read access. */
  get totalSpent(): number {
    return this.cumulativeUsd;
  }

  /**
   * The configured cost ceiling (USD), or undefined when uncapped. Read-only.
   * Lets callers detect a post-hoc overage when a final-call BudgetExhausted is
   * swallowed by the gateway ("surfaced via next reserve") and there is no next
   * reserve — `totalSpent > cap` with no throw. See enrich's runEnrichCore.
   */
  get cap(): number | undefined {
    return this.opts.maxCostUsd;
  }

  /**
   * Register a synchronous callback to fire the first time the tracker
   * throws BudgetExhausted (from reserve OR record). Fires once. Useful for
   * persisting checkpoint state before the throw propagates. The callback
   * MUST be synchronous; async work (fs writes are fine via writeFileSync)
   * goes inside the callback body.
   */
  onExhausted(cb: () => void): void {
    this.onExhaustedCbs.push(cb);
  }

  /**
   * Project a planned LLM call against the cap. Throws BudgetExhausted
   * BEFORE any provider call when:
   *   - cumulative + projected > maxCostUsd (reason: 'cost')
   *   - wall-clock > maxRuntimeMs (reason: 'runtime')
   *   - maxCostUsd set AND pricing missing (reason: 'no_pricing') -- TX2
   *
   * When maxCostUsd is unset, missing pricing warns-once but does not throw
   * (legacy behavior preserved for non-priced providers).
   */
  reserve(estimate: BudgetEstimate): void {
    this.assertRuntime(estimate.modelId);

    const projected = costForUsage(
      estimate.modelId,
      estimate.estimatedInputTokens,
      estimate.maxOutputTokens,
      estimate.kind,
    );

    if (projected === null) {
      if (this.opts.maxCostUsd !== undefined) {
        // TX2: hard-fail when a cap is set but pricing is missing — without
        // pricing we can't enforce the cap, and silently ignoring it would
        // void the contract.
        const msg = `${this.opts.label}: no pricing entry for model "${estimate.modelId}" (kind=${estimate.kind}). ` +
          `Add it to src/core/${estimate.kind === 'embed' ? 'embedding-pricing.ts' : 'anthropic-pricing.ts'} or drop --max-cost.`;
        this.fireExhausted();
        throw new BudgetExhausted(msg, {
          reason: 'no_pricing',
          spent: this.cumulativeUsd,
          cap: this.opts.maxCostUsd,
          modelId: estimate.modelId,
        });
      }
      // Legacy warn-once path — cap unset.
      const memoKey = `${estimate.modelId}:${estimate.kind}`;
      if (!_unpricedWarnings.has(memoKey)) {
        _unpricedWarnings.add(memoKey);
        process.stderr.write(
          `[budget] BUDGET_TRACKER_NO_PRICING: model "${estimate.modelId}" (kind=${estimate.kind}) not in pricing maps. ` +
            `Cost gate disabled for this call.\n`,
        );
      }
      appendAuditLine(this.auditPath, {
        schema_version: 1,
        ts: new Date().toISOString(),
        event: 'reserve_unpriced',
        label: this.opts.label,
        kind: estimate.kind,
        model: estimate.modelId,
        sub_label: estimate.label,
        estimated_input_tokens: estimate.estimatedInputTokens,
        max_output_tokens: estimate.maxOutputTokens,
      });
      return;
    }

    if (this.opts.maxCostUsd !== undefined) {
      const after = this.cumulativeUsd + projected;
      if (after > this.opts.maxCostUsd) {
        appendAuditLine(this.auditPath, {
          schema_version: 1,
          ts: new Date().toISOString(),
          event: 'reserve_denied',
          label: this.opts.label,
          kind: estimate.kind,
          model: estimate.modelId,
          sub_label: estimate.label,
          projected_cost_usd: projected,
          cumulative_cost_usd: this.cumulativeUsd,
          max_cost_usd: this.opts.maxCostUsd,
        });
        this.fireExhausted();
        throw new BudgetExhausted(
          `${this.opts.label}: projected cost $${after.toFixed(4)} exceeds --max-cost $${this.opts.maxCostUsd.toFixed(2)} ` +
            `(cumulative $${this.cumulativeUsd.toFixed(4)} + this call $${projected.toFixed(4)})`,
          { reason: 'cost', spent: this.cumulativeUsd, cap: this.opts.maxCostUsd, modelId: estimate.modelId },
        );
      }
    }

    appendAuditLine(this.auditPath, {
      schema_version: 1,
      ts: new Date().toISOString(),
      event: 'reserve',
      label: this.opts.label,
      kind: estimate.kind,
      model: estimate.modelId,
      sub_label: estimate.label,
      projected_cost_usd: projected,
      cumulative_cost_usd: this.cumulativeUsd,
      max_cost_usd: this.opts.maxCostUsd ?? null,
    });
  }

  /**
   * Record the actual usage after the provider returned (or threw). Updates
   * cumulative spend. Throws BudgetExhausted(reason:'cost') AFTER the update
   * when cumulative > maxCostUsd (TX1): a single underestimated call can
   * blow past the cap and the cap must remain a real ceiling.
   *
   * `outputTokens` defaults to 0 (embed/rerank). `embeddingDims` is audit-
   * only metadata.
   */
  record(actual: BudgetActualUsage & { kind?: BudgetKind }): void {
    this.callsRecorded++;
    const kind: BudgetKind = actual.kind ?? 'chat';
    const cost = costForUsage(actual.modelId, actual.inputTokens, actual.outputTokens ?? 0, kind);

    if (cost === null) {
      // Unpriced model: record audit but skip cumulative math. Cap (if set)
      // already rejected this call at reserve(); a record() here means the
      // unpriced warn-once path let it through (cap unset).
      appendAuditLine(this.auditPath, {
        schema_version: 1,
        ts: new Date().toISOString(),
        event: 'record_unpriced',
        label: this.opts.label,
        kind,
        model: actual.modelId,
        sub_label: actual.label,
        input_tokens: actual.inputTokens,
        output_tokens: actual.outputTokens ?? 0,
        embedding_dims: actual.embeddingDims ?? null,
      });
      return;
    }

    this.cumulativeUsd += cost;
    appendAuditLine(this.auditPath, {
      schema_version: 1,
      ts: new Date().toISOString(),
      event: 'record',
      label: this.opts.label,
      kind,
      model: actual.modelId,
      sub_label: actual.label,
      input_tokens: actual.inputTokens,
      output_tokens: actual.outputTokens ?? 0,
      embedding_dims: actual.embeddingDims ?? null,
      actual_cost_usd: cost,
      cumulative_cost_usd: this.cumulativeUsd,
      max_cost_usd: this.opts.maxCostUsd ?? null,
    });

    if (this.opts.maxCostUsd !== undefined && this.cumulativeUsd > this.opts.maxCostUsd) {
      // TX1: hard-throw — a single under-estimated call exceeded the cap.
      this.fireExhausted();
      throw new BudgetExhausted(
        `${this.opts.label}: cumulative cost $${this.cumulativeUsd.toFixed(4)} exceeded --max-cost $${this.opts.maxCostUsd.toFixed(2)} after recording ${kind} call to ${actual.modelId}`,
        { reason: 'cost', spent: this.cumulativeUsd, cap: this.opts.maxCostUsd, modelId: actual.modelId },
      );
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      cumulativeCostUsd: this.cumulativeUsd,
      startedAt: this.startedAt,
      elapsedMs: Date.now() - this.startedAt,
      maxCostUsd: this.opts.maxCostUsd,
      maxRuntimeMs: this.opts.maxRuntimeMs,
      callsRecorded: this.callsRecorded,
    };
  }

  /** Internal helper: throw BudgetExhausted(reason:'runtime') when the wall-clock cap fires. */
  private assertRuntime(modelId: string): void {
    if (this.opts.maxRuntimeMs === undefined) return;
    const elapsed = Date.now() - this.startedAt;
    if (elapsed > this.opts.maxRuntimeMs) {
      appendAuditLine(this.auditPath, {
        schema_version: 1,
        ts: new Date().toISOString(),
        event: 'runtime_denied',
        label: this.opts.label,
        elapsed_ms: elapsed,
        max_runtime_ms: this.opts.maxRuntimeMs,
        model: modelId,
      });
      this.fireExhausted();
      throw new BudgetExhausted(
        `${this.opts.label}: wall-clock ${(elapsed / 1000).toFixed(1)}s exceeded --max-runtime ${(this.opts.maxRuntimeMs / 1000).toFixed(1)}s`,
        { reason: 'runtime', spent: elapsed, cap: this.opts.maxRuntimeMs, modelId },
      );
    }
  }

  private fireExhausted(): void {
    if (this.exhaustedFired) return;
    this.exhaustedFired = true;
    for (const cb of this.onExhaustedCbs) {
      try {
        cb();
      } catch (err) {
        process.stderr.write(`[budget] onExhausted callback threw: ${String(err)}\n`);
      }
    }
  }
}

/**
 * Pull usage out of an SDK error envelope. Common providers attach `usage`
 * either at the top level (Anthropic) or under `response.usage` (OpenAI).
 * Returns the fallback (pessimistic ceiling) when no usage can be found —
 * NOT the conservative pre-call estimate (A3 amended). Callers should pass
 * `{ inputTokens: estimate.estimatedInputTokens, outputTokens: estimate.maxOutputTokens }`
 * so the worst-case budget is consumed on failure.
 */
export function extractUsageFromError(
  err: unknown,
  fallback: { inputTokens: number; outputTokens: number },
): { inputTokens: number; outputTokens: number } {
  if (err && typeof err === 'object') {
    const top = (err as { usage?: unknown }).usage;
    const nested = (err as { response?: { usage?: unknown } }).response?.usage;
    const candidate = (top && typeof top === 'object' ? top : nested && typeof nested === 'object' ? nested : null) as
      | { input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number }
      | null;
    if (candidate) {
      const inputTokens = numericOrNull(candidate.input_tokens ?? candidate.inputTokens);
      const outputTokens = numericOrNull(candidate.output_tokens ?? candidate.outputTokens);
      if (inputTokens !== null || outputTokens !== null) {
        return {
          inputTokens: inputTokens ?? fallback.inputTokens,
          outputTokens: outputTokens ?? fallback.outputTokens,
        };
      }
    }
  }
  return { inputTokens: fallback.inputTokens, outputTokens: fallback.outputTokens };
}

function numericOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Re-export the pricing maps for introspection / test setup. */
export { ANTHROPIC_PRICING, EMBEDDING_PRICING };
