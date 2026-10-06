/**
 * takes-quality-eval/runner — orchestrator for one `eval takes-quality run`.
 *
 * Three-model panel scored over a sample of takes. Each cycle dispatches
 * gateway.chat() to all 3 models in parallel via Promise.allSettled (thinking
 * off, #5331), parses the JSON via the shared eval-shared/json-repair, re-asks
 * each malformed slot once with the same model and sample (#5325; a correction
 * replaces the first attempt only when it validates), drops models with
 * incomplete dim scores (codex review #5), aggregates, and stops early on
 * PASS or INCONCLUSIVE.
 *
 * Budget enforcement: if --budget-usd is set, the runner aborts BEFORE the
 * next call's projected cost would exceed the cap. Pricing comes from
 * pricing.ts (registered overrides, then the canonical table). An unpriced
 * model refuses up front under a cap (`no_pricing`, fix: register the rate)
 * and runs with a warning without one.
 *
 * NB: this module is engine-aware (samples takes from DB) but the runner
 * itself doesn't write the receipt — that's `runEval()`'s caller's job
 * (the CLI wires receipt-write after the runner returns).
 */
import type { BrainEngine } from '../engine.ts';
import { chat } from '../ai/gateway.ts';
import { parseModelJSON } from '../eval-shared/json-repair.ts';
import { aggregate, slotFormatFailure, type SlotResult, type AggregateResult } from './aggregate.ts';
import {
  RUBRIC_VERSION,
  rubricSha8,
  renderJudgePrompt,
} from './rubric.ts';
import {
  corpusSha8,
  modelSetSha8,
} from './receipt-name.ts';
import type { TakesQualityCorrection, TakesQualityReceipt } from './receipt.ts';
import { estimateCost, getPricing, unpricedUnderCapError, unpricedWarning } from './pricing.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { DEFAULT_CYCLES_NONTTY } from '../eval/cycle-default.ts';

/**
 * Three distinct providers (uncorrelated judge blind spots). Every entry MUST
 * be listed in its recipe's chat touchpoint AND priced for takes-quality
 * (pricing.ts) — pinned by test/default-model-panels.test.ts.
 * google:gemini-1.5-pro (retired by Google) and openai:gpt-4o (dropped from
 * the OpenAI recipe's chat list) sat here dead until #3510; gemini-2.0-flash
 * replaced the former and was itself retired before it was ever swept.
 */
/** Receipt `protocol_version`: thinking-off judges plus one correction per malformed slot. */
export const TAKES_QUALITY_PROTOCOL_VERSION = 2;

function correctionPrompt(prompt: string, formatFailure: string): string {
  return `${prompt}\n\nYour previous response failed validation: ${formatFailure}\n` +
    'Return a complete replacement in the requested JSON shape, with a score for every dimension. ' +
    'Do not invent scores when evidence is insufficient.';
}

export const DEFAULT_MODEL_PANEL = [
  'openai:gpt-5.2',
  'anthropic:claude-opus-4-7',
  'google:gemini-2.5-flash',
] as const;

export interface RunOpts {
  /** Sample size from the takes table. Default 100. */
  limit?: number;
  /** Optional deterministic seed; same seed + same corpus = same sample. */
  seed?: number;
  /** Budget cap in USD; runner aborts before next call would exceed. null = no cap. */
  budgetUsd?: number | null;
  /** 'db' samples from takes table; 'fs' walks markdown (not yet wired). */
  source?: 'db' | 'fs';
  /** Filter to slugs starting with this prefix (DB source). */
  slugPrefix?: string | null;
  /** Cycles to run per panel. Default 3 in TTY, 1 in non-TTY. */
  cycles?: number;
  /** Override the default 3-model panel. */
  models?: readonly string[];
  /** Abort signal from the CLI (Ctrl-C, etc.). */
  abortSignal?: AbortSignal;
}

export interface RunResult {
  receipt: TakesQualityReceipt;
  /** True when the budget cap aborted the run before all cycles ran. */
  budgetAborted: boolean;
}

/**
 * Sample N takes from the DB, render them as text the judge model sees.
 * Random sampling via tablesample (Postgres) or ORDER BY random() (PGLite,
 * acceptable on 100K rows for an eval). For deterministic re-runs we'd
 * need a seed; v1 ships non-seeded random sampling.
 */
async function sampleTakesAsText(
  engine: BrainEngine,
  opts: { limit: number; slugPrefix: string | null },
): Promise<{ takesText: string; nTakes: number }> {
  const params: any[] = [opts.limit];
  let where = '';
  if (opts.slugPrefix) {
    params.push(opts.slugPrefix + '%');
    where = `JOIN pages p ON p.id = t.page_id WHERE p.slug LIKE $${params.length}`;
  }
  const rows = await engine.executeRaw<{
    claim: string;
    kind: string;
    holder: string;
    weight: number;
    since_date: string | null;
    source: string | null;
    page_slug: string | null;
  }>(
    `SELECT t.claim, t.kind, t.holder, t.weight, t.since_date, t.source,
            ${opts.slugPrefix ? 'p.slug' : 'NULL'} AS page_slug
       FROM takes t ${where || 'JOIN pages p ON p.id = t.page_id'}
       ${where ? '' : ''}
       ORDER BY random()
       LIMIT $1`,
    params,
  );
  const lines = rows.map(r => {
    const since = r.since_date ?? '—';
    const src = r.source ?? '—';
    const slug = r.page_slug ? ` [page=${r.page_slug}]` : '';
    return `- ${r.kind} | holder=${r.holder} | weight=${r.weight} | since=${since} | src=${src}${slug}\n  ${r.claim}`;
  });
  return { takesText: lines.join('\n'), nTakes: rows.length };
}

async function callOneModel(
  modelId: string,
  systemPrompt: string,
  abortSignal?: AbortSignal,
): Promise<SlotResult & { _usage?: { input_tokens: number; output_tokens: number } }> {
  try {
    const result = await chat({
      model: modelId,
      system: 'You are an evaluation judge. Return strict JSON in the requested shape. Do not include markdown fences in your final response.',
      messages: [{ role: 'user', content: systemPrompt }],
      maxTokens: 2000,
      abortSignal,
      allowFallback: false,
      thinking: 'off',
    });
    try {
      const parsed = parseModelJSON(result.text);
      return {
        ok: true,
        modelId,
        parsed,
        _usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
      } as SlotResult & { _usage: { input_tokens: number; output_tokens: number } };
    } catch (parseErr) {
      return {
        ok: false,
        modelId,
        error: `parse_failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        _usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
      } as SlotResult & { _usage: { input_tokens: number; output_tokens: number } };
    }
  } catch (err) {
    return {
      ok: false,
      modelId,
      error: `provider_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runEval(engine: BrainEngine, opts: RunOpts = {}): Promise<RunResult> {
  const limit = opts.limit ?? 100;
  // Library core stays TTY-agnostic (#1784): default to the cost-conservative
  // value. The CLI layer (eval-takes-quality.ts) owns the TTY=3 upgrade + the
  // banner annotation; it always passes an explicit `cycles` down.
  const cycles = opts.cycles ?? DEFAULT_CYCLES_NONTTY;
  const models = opts.models ?? DEFAULT_MODEL_PANEL;
  const budgetUsd = opts.budgetUsd ?? null;
  const source = opts.source ?? 'db';

  if (source === 'fs') {
    throw new Error('fs source not yet wired in v0.32; use --source db');
  }

  // Pre-flight pricing: a cap is enforceable only when every model is priced.
  const overrides = await loadPricingOverrides(engine);
  for (const m of models) {
    if (getPricing(m, overrides)) continue;
    if (budgetUsd !== null) throw unpricedUnderCapError(m, budgetUsd);
    process.stderr.write(`${unpricedWarning(m)}\n`);
  }

  // Sample the corpus.
  const { takesText, nTakes } = await sampleTakesAsText(engine, { limit, slugPrefix: opts.slugPrefix ?? null });
  if (nTakes === 0) {
    throw new Error('no takes to evaluate (empty corpus). Run `gbrain extract takes` first or check --slug-prefix.');
  }

  const corpus_sha8 = corpusSha8(takesText);
  const { prompt, sha8: prompt_sha8 } = renderJudgePrompt(takesText);
  const models_sha8 = modelSetSha8(models);
  const rubric_sha8 = rubricSha8();

  const ts = new Date().toISOString();
  const successes_per_cycle: number[] = [];
  let cumulativeCost = 0;
  let budgetAborted = false;
  let lastAggregate: AggregateResult | null = null;
  const corrections: TakesQualityCorrection[] = [];

  for (let cycle = 0; cycle < cycles; cycle++) {
    if (opts.abortSignal?.aborted) {
      process.stderr.write('[eval takes-quality] aborted by signal\n');
      break;
    }

    // Project the worst-case spend for this cycle if budget is set. We
    // assume the prompt is ~5k tokens input + ~2k output per model; the
    // cap fires before the call if the projection would exceed remaining
    // budget. (Real usage is captured post-call from result.usage.)
    if (budgetUsd !== null) {
      let projected = 0;
      for (const m of models) {
        projected += estimateCost(m, 5000, 2000, overrides) ?? 0;
      }
      if (cumulativeCost + projected > budgetUsd) {
        process.stderr.write(
          `[eval takes-quality] budget cap hit: cumulative=$${cumulativeCost.toFixed(2)} ` +
          `projected_next=$${projected.toFixed(2)} cap=$${budgetUsd.toFixed(2)}; aborting before cycle ${cycle + 1}\n`,
        );
        budgetAborted = true;
        break;
      }
    }

    const settled = await Promise.allSettled(
      models.map(m => callOneModel(m, prompt, opts.abortSignal)),
    );
    const slots: SlotResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const m = models[i];
      if (s.status === 'fulfilled') {
        const r = s.value as SlotResult & { _usage?: { input_tokens: number; output_tokens: number } };
        if (r._usage) {
          cumulativeCost += estimateCost(m, r._usage.input_tokens, r._usage.output_tokens, overrides) ?? 0;
        }
        slots.push(r);
      } else {
        slots.push({ ok: false, modelId: m, error: `allSettled_rejected: ${String(s.reason)}` });
      }
    }
    // #5325: one same-model correction per malformed slot, priced against the
    // cap before it is sent. Provider errors and valid low scores never re-run.
    for (let i = 0; i < slots.length; i++) {
      const firstError = slotFormatFailure(slots[i]!);
      if (!firstError) continue;
      const m = models[i]!;
      const skipped = opts.abortSignal?.aborted ? 'aborted'
        : budgetUsd !== null && cumulativeCost + (estimateCost(m, 5000, 2000, overrides) ?? 0) > budgetUsd ? 'budget'
        : null;
      if (skipped) {
        corrections.push({ cycle, modelId: m, first_error: firstError, corrected: null, skipped_reason: skipped });
        continue;
      }
      const retry = await callOneModel(m, correctionPrompt(prompt, firstError), opts.abortSignal);
      if (retry._usage) cumulativeCost += estimateCost(m, retry._usage.input_tokens, retry._usage.output_tokens, overrides) ?? 0;
      const retryError = retry.ok ? slotFormatFailure(retry) : retry.error;
      corrections.push({
        cycle, modelId: m, first_error: firstError,
        corrected: retryError === null ? 'valid' : 'invalid',
        ...(retryError !== null ? { corrected_error: retryError } : {}),
      });
      if (retryError === null) slots[i] = retry;
    }
    const agg = aggregate({ slots });
    lastAggregate = agg;
    successes_per_cycle.push(agg.successes);
    if (agg.verdict === 'pass' || agg.verdict === 'inconclusive') break;
  }

  if (!lastAggregate) {
    // Budget aborted before any cycle ran.
    lastAggregate = {
      verdict: 'inconclusive',
      successes: 0,
      failures: 0,
      dimensions: {},
      overall: undefined,
      topImprovements: [],
      errors: [],
      verdictMessage: 'INCONCLUSIVE: budget cap exceeded before any cycle completed.',
    };
  }

  const receipt: TakesQualityReceipt = {
    schema_version: 1,
    ts,
    rubric_version: RUBRIC_VERSION,
    rubric_sha8,
    corpus: { source, n_takes: nTakes, slug_prefix: opts.slugPrefix ?? null, corpus_sha8 },
    prompt_sha8,
    models_sha8,
    models: [...models],
    cycles_run: successes_per_cycle.length,
    successes_per_cycle,
    verdict: lastAggregate.verdict,
    scores: lastAggregate.dimensions,
    overall_score: lastAggregate.overall ?? null,
    cost_usd: roundCost(cumulativeCost),
    improvements: lastAggregate.topImprovements,
    errors: lastAggregate.errors,
    verdictMessage: lastAggregate.verdictMessage,
    protocol_version: TAKES_QUALITY_PROTOCOL_VERSION,
    correction_selection_rule: 'corrected_if_valid',
    ...(corrections.length > 0 ? { corrections } : {}),
  };

  return { receipt, budgetAborted };
}

function roundCost(n: number): number {
  return Math.round(n * 10000) / 10000;
}
