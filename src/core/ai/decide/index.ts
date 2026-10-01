/**
 * `decide()`: one logical decision over typed questions, provider-agnostic.
 *
 *   policy → egress gate (typed provenance) → budget admission → pack
 *   (64k/32k, split before send) → provider (bounded concurrency, one
 *   deadline) → strict validation (malformed / mixed model fail the whole
 *   decision) → spend ledger rows → typed answers.
 *
 * Failures throw DecideError with a catalogued reason; every caller takes its
 * slot's documented fail direction. Receipts are written by the slot code,
 * which owns the outcome reducer (see recordDecisionReceipts).
 * Contract: docs/architecture/decide.md.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import { loadConfigSnapshot } from '../../config-snapshot.ts';
import { usageCostUsd } from '../../budget/reservation-cost.ts';
import {
  applyOpenAICompatConfig, applyResolveAuth, authToHeaders, chat, decideTransport, getCurrentBudgetTracker, requireConfig,
} from '../gateway.ts';
import { invokeAI, isAIInvocationPolicyError, responseInvocationUsage } from '../invocation-guard.ts';
import { recordOnTracker } from '../budget-record.ts';
import { getRecipe } from '../recipes/index.ts';
import { typesafeApiKey } from '../recipes/typesafe.ts';
import { providerKind, readDecideConfig, type DecideConfig } from './config.ts';
import { checkEgress } from './egress.ts';
import { estimateContextTokens, orderQuestions, parseRetryAfterMs, planBatches, RateLimitedError, runBatches } from './pack.ts';
import {
  buildLlmPrompt, llmCapability, llmChatModel, llmModelIdentity, LLM_ANSWER_SCHEMA, LLM_SYSTEM_PROMPT, parseLlmReply,
} from './providers/llm-structured.ts';
import { buildTypeSafeRequest, classifyTypeSafeHttpError, parseTypeSafeResponse, toWireQuestion } from './providers/typesafe.ts';
import { SLOT_SPECS } from './slots.ts';
import { dailySpend, recordSpend } from './store.ts';
import {
  DecideError, type DecideAnswer, type DecideLane, type DecideQuestion, type DecideRequest, type DecideResult, type EvidenceItem,
} from './types.ts';

export * from './types.ts';

export interface DecideContext {
  /** Needed for egress page checks, the spend ledger and the daily cap. */
  engine: BrainEngine | null;
  /** Typed decide config; loaded from the engine's config snapshot when omitted. */
  config?: DecideConfig;
  sourceId?: string;
  now?: () => number;
}

const BACKGROUND_DEFAULT_MS = 60_000;

export async function loadDecideConfig(engine: BrainEngine | null, opts: { evalSlots?: string } = {}): Promise<DecideConfig> {
  return readDecideConfig(engine ? await loadConfigSnapshot(engine) : null, { ...opts, typesafeKey: hasTypesafeKey() });
}

/** TypeSafe key presence in the gateway env snapshot (falls back to process env before configure). */
export function hasTypesafeKey(): boolean {
  try { return typesafeApiKey(requireConfig().env) !== null; } catch { return typesafeApiKey(process.env) !== null; }
}

function stateText(state: Record<string, EvidenceItem>): Record<string, string> {
  return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.text]));
}

function emptyResult(provider: string, lane: DecideLane, refused: Record<string, string>): DecideResult {
  return {
    decision_id: randomUUID(), provider, model_alias: provider, model_resolved: '', answers: {}, refused,
    usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0, latency_ms: 0, batches: 0, lane,
  };
}

export async function runDecide(req: DecideRequest, ctx: DecideContext): Promise<DecideResult> {
  const now = ctx.now ?? Date.now;
  const started = now();
  const cfg = ctx.config ?? await loadDecideConfig(ctx.engine);
  const provider = req.provider ?? cfg.slots[req.slot].provider;
  const lane = req.lane ?? SLOT_SPECS[req.slot].lane;
  const kind = providerKind(provider);
  if (kind === 'none') throw new DecideError('no_provider', 'decide: no provider configured');
  if (req.questions.length === 0) return emptyResult(provider, lane, {});
  if (new Set(req.questions.map((q) => q.id)).size !== req.questions.length) throw new Error('decide: question ids must be unique');

  const verdict = await checkEgress(ctx.engine, cfg, provider, req.state, req.questions, { consent: req.consent, slot: req.slot });
  const refusedIds = new Set(Object.keys(verdict.refused));
  const allowed = req.questions.filter((q) => !refusedIds.has(q.id));
  const withFallback = async (result: DecideResult): Promise<DecideResult> => {
    if (refusedIds.size === 0 || cfg.egressFallback === 'none' || cfg.egressFallback === provider || verdict.stateRefused === 'denied_source') return result;
    const refusedQuestions = req.questions.filter((q) => refusedIds.has(q.id));
    try {
      result.fallback = await runDecide({ ...req, questions: refusedQuestions, provider: cfg.egressFallback }, { ...ctx, config: cfg });
    } catch {
      // Fallback failure: refused items keep the slot's fail direction.
    }
    return result;
  };
  if (allowed.length === 0) return withFallback(emptyResult(provider, lane, verdict.refused));

  const deadlineAt = started + (req.deadlineMs ?? (lane === 'hot' ? cfg.timeoutMs : BACKGROUND_DEFAULT_MS));
  if (now() >= deadlineAt) throw new DecideError('late', 'decide: no time left in the budget');
  const ordered = orderQuestions(allowed);
  const state = stateText(req.state);
  const result = kind === 'typesafe'
    ? await runTypesafe(req, ctx, cfg, { provider, lane, deadlineAt, ordered, state, now })
    : await runLlm(req, cfg, { provider, lane, deadlineAt, ordered, state, now });
  result.refused = verdict.refused;
  result.latency_ms = now() - started;
  return withFallback(result);
}

interface RunArgs {
  provider: string;
  lane: DecideLane;
  deadlineAt: number;
  ordered: DecideQuestion[];
  state: Record<string, string>;
  now: () => number;
}

function deadlineSignal(deadlineAt: number, now: () => number, caller?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DecideError('timeout', 'decide: deadline exceeded')), Math.max(0, deadlineAt - now()));
  const onAbort = () => ctrl.abort(caller!.reason);
  if (caller?.aborted) onAbort();
  else caller?.addEventListener('abort', onAbort, { once: true });
  return { signal: ctrl.signal, done: () => { clearTimeout(t); caller?.removeEventListener('abort', onAbort); } };
}

function asDecideError(err: unknown, signal: AbortSignal, caller?: AbortSignal): unknown {
  if (err instanceof DecideError || isAIInvocationPolicyError(err)) return err;
  if (signal.aborted) return caller?.aborted ? new DecideError('provider_error', 'decide: caller aborted') : new DecideError('timeout', 'decide: deadline exceeded');
  return new DecideError('provider_error', `decide: transport failed (${err instanceof Error ? err.name : 'error'})`);
}

async function runTypesafe(req: DecideRequest, ctx: DecideContext, cfg: DecideConfig, a: RunArgs): Promise<DecideResult> {
  const recipe = getRecipe('typesafe');
  const tp = recipe?.touchpoints.decide;
  if (!recipe || !tp) throw new DecideError('provider_error', 'decide: TypeSafe recipe missing');
  const gw = requireConfig();
  if (!typesafeApiKey(gw.env)) throw new DecideError('no_key', 'decide: TYPESAFE_API_KEY is not set');
  const modelId = a.provider.replace(/^typesafe:/, '');
  const url = `${applyOpenAICompatConfig(recipe, gw).baseURL.replace(/\/$/, '')}${tp.path}`;
  const headers = { ...authToHeaders(applyResolveAuth(recipe, gw, 'reranker')), 'Content-Type': 'application/json' };

  const stateTokens = estimateContextTokens(a.state);
  const plan = planBatches(stateTokens, a.ordered.map((q) => estimateContextTokens(toWireQuestion(q))));
  const bodies = plan.map((b) => JSON.stringify(buildTypeSafeRequest(modelId, a.state, b.indices.map((i) => a.ordered[i]!))));
  if (bodies.some((body) => Buffer.byteLength(body, 'utf8') > tp.max_payload_bytes)) {
    throw new DecideError('payload_too_large', 'decide: request exceeds the payload byte cap');
  }
  const budgetKind = req.budgetKind ?? 'decide';
  const estimatedTokens = plan.reduce((n, b) => n + b.estimatedInputTokens, 0);
  const priced = (tokens: number) => usageCostUsd(a.provider, tokens, 0, budgetKind) ?? 0;
  if (budgetKind === 'decide' && ctx.engine) {
    const spent = await dailySpend(ctx.engine, a.now()).catch(() => ({ total: 0, remote: 0 }));
    const estimate = priced(estimatedTokens);
    if (spent.total + estimate > cfg.dailyUsd) throw new DecideError('budget_exhausted', 'decide: daily budget exhausted');
    if (req.remote && spent.remote + estimate > cfg.dailyUsd * cfg.remoteShare) throw new DecideError('budget_exhausted', 'decide: remote share of the daily budget exhausted');
  }
  const tracker = getCurrentBudgetTracker();
  tracker?.reserve({ modelId: a.provider, estimatedInputTokens: estimatedTokens, maxOutputTokens: 0, kind: budgetKind, label: 'gateway.decide' });

  const { signal, done } = deadlineSignal(a.deadlineAt, a.now, req.signal);
  const transport = decideTransport();
  const models = new Set<string>();
  const answers: Record<string, DecideAnswer> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  const spendRow = (tokens: number, outcome: 'ok' | 'failed' | 'timeout' | 'malformed', model?: string) => {
    if (!ctx.engine) return;
    recordSpend(ctx.engine, {
      request_id: randomUUID(), source_id: ctx.sourceId ?? null, slot: req.slot, provider: a.provider,
      model_resolved: model ?? null, lane: a.lane, remote: req.remote === true, input_tokens: tokens,
      cost_usd: priced(tokens), outcome,
    });
  };
  try {
    await runBatches(plan.length, async (i) => {
      const batch = plan[i]!;
      const questions = batch.indices.map((j) => a.ordered[j]!);
      let charged = false;
      try {
        const response = await invokeAI(
          { operation: 'gateway.decide', kind: 'decide', model: a.provider, maxInputTokens: batch.estimatedInputTokens },
          () => transport(url, { method: 'POST', headers, body: bodies[i]!, signal }),
          responseInvocationUsage,
        );
        if (response.status === 429) {
          spendRow(batch.estimatedInputTokens, 'failed');
          charged = true;
          throw new RateLimitedError(parseRetryAfterMs(response.headers.get('retry-after'), a.now()));
        }
        if (!response.ok) throw await classifyTypeSafeHttpError(response);
        let json: unknown;
        try { json = await response.json(); } catch { throw new DecideError('malformed_response', 'decide: response is not JSON'); }
        const parsed = parseTypeSafeResponse(json, questions);
        const tokens = parsed.inputTokens ?? batch.estimatedInputTokens;
        inputTokens += tokens;
        outputTokens += parsed.outputTokens ?? 0;
        models.add(parsed.model);
        spendRow(tokens, 'ok', parsed.model);
        charged = true;
        Object.assign(answers, parsed.answers);
      } catch (err) {
        if (!charged) {
          inputTokens += batch.estimatedInputTokens;
          const reason = err instanceof DecideError ? err.reason : signal.aborted ? 'timeout' : 'failed';
          spendRow(batch.estimatedInputTokens, reason === 'timeout' ? 'timeout' : reason === 'malformed_response' ? 'malformed' : 'failed');
        }
        if (err instanceof RateLimitedError) throw err;
        throw asDecideError(err, signal, req.signal);
      }
    }, { concurrency: a.lane === 'hot' ? cfg.maxConcurrency : cfg.backgroundConcurrency, deadlineAt: a.deadlineAt, signal, lane: a.lane, now: a.now });
  } catch (err) {
    throw asDecideError(err, signal, req.signal);
  } finally {
    done();
    recordOnTracker(tracker, { modelId: a.provider, inputTokens, outputTokens: 0, kind: budgetKind, label: 'gateway.decide' });
  }
  if (models.size > 1) throw new DecideError('mixed_model', `decide: batches answered by ${models.size} different models`);
  const modelResolved = [...models][0] ?? modelId;
  return {
    decision_id: randomUUID(), provider: a.provider, model_alias: modelId, model_resolved: modelResolved, answers, refused: {},
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }, cost_usd: priced(inputTokens), latency_ms: 0,
    batches: plan.length, lane: a.lane,
  };
}

async function runLlm(req: DecideRequest, cfg: DecideConfig, a: RunArgs): Promise<DecideResult> {
  const model = llmChatModel(a.provider);
  const capability = llmCapability(a.provider);
  if (capability === 'unknown') throw new DecideError('llm_capability', `decide: ${model} has no chat route`);
  const plan = planBatches(estimateContextTokens(a.state), a.ordered.map((q) => estimateContextTokens(toWireQuestion(q))));
  const { signal, done } = deadlineSignal(a.deadlineAt, a.now, req.signal);
  const models = new Set<string>();
  const answers: Record<string, DecideAnswer> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let baseUrl: string | undefined;
  try {
    const recipe = getRecipe(model.split(':')[0]!);
    baseUrl = recipe ? requireConfig().base_urls?.[recipe.id] ?? recipe.base_url_default : undefined;
  } catch { /* identity falls back to the requested id */ }
  try {
    await runBatches(plan.length, async (i) => {
      const questions = plan[i]!.indices.map((j) => a.ordered[j]!);
      const reply = await chat({
        model, system: LLM_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildLlmPrompt(a.state, questions) }],
        ...(capability === 'structured' ? { responseSchema: LLM_ANSWER_SCHEMA } : {}),
        temperature: 0, abortSignal: signal, purpose: `decide:${req.slot}`, maxTokens: 64 + questions.length * 96,
      });
      inputTokens += reply.usage.input_tokens;
      outputTokens += reply.usage.output_tokens;
      models.add(llmModelIdentity(model, reply.responseModel, baseUrl));
      Object.assign(answers, parseLlmReply(reply.text, questions));
    }, { concurrency: a.lane === 'hot' ? cfg.maxConcurrency : cfg.backgroundConcurrency, deadlineAt: a.deadlineAt, signal, lane: a.lane, now: a.now });
  } catch (err) {
    throw asDecideError(err, signal, req.signal);
  } finally {
    done();
  }
  if (models.size > 1) throw new DecideError('mixed_model', 'decide: batches answered by different models');
  return {
    decision_id: randomUUID(), provider: a.provider, model_alias: model, model_resolved: [...models][0] ?? model, answers, refused: {},
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }, cost_usd: 0, latency_ms: 0, batches: plan.length, lane: a.lane,
    uncalibrated: true,
  };
}
