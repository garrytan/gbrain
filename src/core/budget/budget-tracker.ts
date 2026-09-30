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
import { ANTHROPIC_PRICING } from '../anthropic-pricing.ts';
import { EMBEDDING_PRICING } from '../embedding-pricing.ts';
import { isoWeekFilename, resolveAuditDir } from '../audit-week-file.ts';
import {
  canonicalPricingKey,
  reservationCostUsd,
  usageCostUsd,
  type BudgetKind,
  type PricingOverrides,
} from './reservation-cost.ts';
import { ModelLedger, type ModelUsageRow } from './models-used.ts';

export { isModelPriceable } from './reservation-cost.ts';
export type { BudgetKind, PricingOverrides };

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
  /** Model string the caller asked for, before alias/default resolution. Defaults to the served model. */
  requestedModelId?: string;
  /** Caller-declared purpose (`skillopt.optimizer`, …); engine-internal calls leave it unset. */
  purpose?: string;
  /** The call failed. A `.failed` label implies it. */
  failed?: boolean;
  /** False for an extra attempt inside one gateway operation (structured-output fallback). Default true. */
  countsAsCall?: boolean;
  /** Token counts are a heuristic (char estimate or pessimistic failure fallback), not provider-reported. */
  estimated?: boolean;
}

export interface BudgetSnapshot {
  cumulativeCostUsd: number;
  startedAt: number;
  elapsedMs: number;
  maxCostUsd?: number;
  maxRuntimeMs?: number;
  callsRecorded: number;
  /** Per-model ledger of every recorded call (see models-used.ts). */
  models: ModelUsageRow[];
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
  /**
   * #4312 — operator config-plane price overrides (`pricing.overrides`),
   * normalized via parsePricingOverrides. Consulted BEFORE the shipped
   * pricing tables in every cost computation, so an operator routing through
   * a proxy (LiteLLM fronting a paid provider — chat AND embed) can declare
   * their real rate instead of TX2 no_pricing hard-failing under --max-cost.
   * Models with neither a table row nor an override stay fail-closed.
   */
  pricingOverrides?: PricingOverrides;
}

/**
 * Parse the raw `pricing.overrides` config value (JSON string or object) into
 * a normalized PricingOverrides map. Invalid entries are DROPPED (the model
 * stays unpriced → the TX2 fail-closed contract still applies to it); a
 * wholly-unparseable value yields undefined. Never throws.
 */
export function parsePricingOverrides(raw: unknown): PricingOverrides | undefined {
  let value: unknown = raw;
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return undefined;
    try {
      value = JSON.parse(s);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const isRate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const out: PricingOverrides = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim().toLowerCase();
    if (!key) continue;
    if (isRate(v)) {
      out[key] = { input: v, output: v };
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as { input?: unknown; output?: unknown; pricePerMTok?: unknown };
      const input = obj.input ?? obj.pricePerMTok;
      if (isRate(input) && (obj.output === undefined || isRate(obj.output))) {
        out[key] = { input, output: (obj.output as number | undefined) ?? input };
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Load + parse operator price overrides from the DB config plane
 * (`pricing.overrides`). Fail-open to undefined — a config read failure must
 * never block a run; the affected models simply keep the fail-closed
 * no-pricing behavior.
 */
export async function loadPricingOverrides(
  engine: { getConfig(key: string): Promise<string | null> },
): Promise<PricingOverrides | undefined> {
  try {
    return parsePricingOverrides(await engine.getConfig('pricing.overrides'));
  } catch {
    return undefined;
  }
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

export class BudgetTracker {
  private cumulativeUsd = 0;
  /**
   * #4365 — sum of projections reserved but not yet record()ed. Concurrent
   * callers (e.g. skillopt's validation gate, concurrency 4) all pass
   * admission against cumulativeUsd alone, breaching the cap by up to
   * (N-1)×per-call cost. Admission checks cumulative + outstanding instead.
   */
  private outstandingUsd = 0;
  /** FIFO of unsettled projections keyed `${modelId}|${kind}` (gateway pairs reserve→record 1:1). */
  private readonly outstandingByKey = new Map<string, number[]>();
  private callsRecorded = 0;
  private readonly ledger = new ModelLedger();
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

    const projected = reservationCostUsd(
      estimate.modelId,
      estimate.kind,
      estimate.estimatedInputTokens,
      estimate.maxOutputTokens,
      this.opts.pricingOverrides,
    );

    if (projected === null) {
      if (this.opts.maxCostUsd !== undefined) {
        // TX2: hard-fail when a cap is set but pricing is missing — without
        // pricing we can't enforce the cap, and silently ignoring it would
        // void the contract.
        const pricingFile = estimate.kind === 'chat' ? 'model-pricing.ts' : 'embedding-pricing.ts';
        const msg = `${this.opts.label}: no pricing entry for model "${estimate.modelId}" (kind=${estimate.kind}). ` +
          `Add it to src/core/${pricingFile}, declare an operator rate via ` +
          `\`gbrain config set pricing.overrides '{"${estimate.modelId}": <usd-per-1M-tokens>}'\` (#4312), ` +
          `or drop --max-cost.`;
        appendAuditLine(this.auditPath, {
          schema_version: 1,
          ts: new Date().toISOString(),
          event: 'reserve_no_pricing',
          label: this.opts.label,
          kind: estimate.kind,
          model: estimate.modelId,
          sub_label: estimate.label,
          estimated_input_tokens: estimate.estimatedInputTokens,
          max_output_tokens: estimate.maxOutputTokens,
          cumulative_cost_usd: this.cumulativeUsd,
          max_cost_usd: this.opts.maxCostUsd,
          reason: 'no_pricing',
        });
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
      const after = this.cumulativeUsd + this.outstandingUsd + projected;
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
          outstanding_usd: this.outstandingUsd,
          max_cost_usd: this.opts.maxCostUsd,
        });
        this.fireExhausted();
        throw new BudgetExhausted(
          `${this.opts.label}: projected cost $${after.toFixed(4)} exceeds --max-cost $${this.opts.maxCostUsd.toFixed(2)} ` +
            `(cumulative $${this.cumulativeUsd.toFixed(4)} + outstanding $${this.outstandingUsd.toFixed(4)} + this call $${projected.toFixed(4)})`,
          { reason: 'cost', spent: this.cumulativeUsd, cap: this.opts.maxCostUsd, modelId: estimate.modelId },
        );
      }
      // Admission passed — hold the projection until record() settles it so
      // parallel reserve() calls can't all admit against the same cumulative.
      const key = `${estimate.modelId}|${estimate.kind}`;
      const queue = this.outstandingByKey.get(key) ?? [];
      queue.push(projected);
      this.outstandingByKey.set(key, queue);
      this.outstandingUsd += projected;
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
    const cost = usageCostUsd(
      actual.modelId,
      actual.inputTokens,
      actual.outputTokens ?? 0,
      kind,
      this.opts.pricingOverrides,
    );
    // The ledger sees every record — before the unpriced return and the TX1
    // throw below — so an over-cap or unpriced call is never invisible.
    const servedModel = canonicalPricingKey(actual.modelId);
    this.ledger.add({
      requestedModel: actual.requestedModelId ?? servedModel,
      model: servedModel,
      label: actual.label,
      purpose: actual.purpose,
      failed: actual.failed === true || (actual.label?.endsWith('.failed') ?? false),
      countsAsCall: actual.countsAsCall !== false,
      estimated: actual.estimated === true,
      inputTokens: actual.inputTokens,
      outputTokens: actual.outputTokens ?? 0,
      costUsd: cost,
    });

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

    this.settleReservation(actual.modelId, kind);
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
      models: this.ledger.rows(),
    };
  }

  /**
   * Release the oldest unsettled reservation for this call's model+kind.
   * Exact key first; on miss, the oldest same-kind entry — gateway.chat
   * reserves with the pre-resolution model string (alias/bare/slash form)
   * but records `${recipe.id}:${modelId}`, and a missed pop would leak
   * phantom outstanding budget for the tracker's lifetime. Records with no
   * reservation at all (expand/OCR spend sites) pop nothing.
   */
  private settleReservation(modelId: string, kind: BudgetKind): void {
    let key = `${modelId}|${kind}`;
    let queue = this.outstandingByKey.get(key);
    if (!queue || queue.length === 0) {
      const suffix = `|${kind}`;
      queue = undefined;
      for (const [k, q] of this.outstandingByKey) {
        if (k.endsWith(suffix) && q.length > 0) {
          key = k;
          queue = q;
          break;
        }
      }
    }
    if (!queue || queue.length === 0) return;
    const amount = queue.shift()!;
    if (queue.length === 0) this.outstandingByKey.delete(key);
    this.outstandingUsd = Math.max(0, this.outstandingUsd - amount);
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
  const found = usageFromError(err);
  return {
    inputTokens: found?.inputTokens ?? fallback.inputTokens,
    outputTokens: found?.outputTokens ?? fallback.outputTokens,
  };
}

/**
 * The usage an SDK error envelope reports, or null when it reports none.
 * Either side may be null when the provider reported only the other.
 */
export function usageFromError(err: unknown): { inputTokens: number | null; outputTokens: number | null } | null {
  if (!err || typeof err !== 'object') return null;
  const top = (err as { usage?: unknown }).usage;
  const nested = (err as { response?: { usage?: unknown } }).response?.usage;
  const candidate = (top && typeof top === 'object' ? top : nested && typeof nested === 'object' ? nested : null) as
    | { input_tokens?: number; output_tokens?: number; inputTokens?: number; outputTokens?: number }
    | null;
  if (!candidate) return null;
  const inputTokens = numericOrNull(candidate.input_tokens ?? candidate.inputTokens);
  const outputTokens = numericOrNull(candidate.output_tokens ?? candidate.outputTokens);
  return inputTokens !== null || outputTokens !== null ? { inputTokens, outputTokens } : null;
}

function numericOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Re-export the pricing maps for introspection / test setup. */
export { ANTHROPIC_PRICING, EMBEDDING_PRICING };
