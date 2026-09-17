#!/usr/bin/env bun
/** Paired, rank-only evaluation on frozen candidate pools. Never opens the operator's brain. */
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { configureGateway, rerank, resetGateway, RerankError, __setRerankTransportForTests, __setEmbedTransportForTests, withBudgetTracker, type RerankInput, type RerankResult } from '../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { loadConfig } from '../src/core/config.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { rerankerReadiness } from '../src/core/ai/reranker-readiness.ts';
import { capRerankDoc } from '../src/core/search/rerank.ts';
import { dedupeRankedKeys } from '../src/core/eval/ranked-docs.ts';
import { buildMetricGlossaryMeta } from '../src/core/eval/metric-glossary.ts';
import { lookupEmbeddingPrice } from '../src/core/embedding-pricing.ts';
import { buildTypeSafeRerankBatches } from '../src/core/ai/rerank-typesafe.ts';
import { estimateRerankTokens, planVoyageRerankBatches, RERANK_TOKEN_ESTIMATE_BASIS, type RerankBatchPlan } from './lib/rerank-batch-plan.ts';
import { createRerankRequestRecorder } from './lib/rerank-request-telemetry.ts';
import { createRerankQuota } from './lib/rerank-quota.ts';
import { rerankConcurrentPool } from './lib/rerank-concurrent.ts';

export interface FrozenPool {
  id: string;
  query: string;
  group: string;
  candidates: Array<{ id: string; text: string }>;
  relevant: string[];
}
export interface RankedScore { hit1: number; hit3: number; mrr: number; recall3: number }
export function scoreRanking(pool: FrozenPool, ids: string[]): RankedScore {
  const ranked = dedupeRankedKeys(ids);
  const relevant = new Set(pool.relevant);
  const index = ranked.findIndex(id => relevant.has(id));
  return {
    hit1: Number(index === 0), hit3: Number(index >= 0 && index < 3),
    mrr: index >= 0 ? 1 / (index + 1) : 0,
    recall3: ranked.slice(0, 3).filter(id => relevant.has(id)).length / relevant.size,
  };
}
export function parsePools(text: string): FrozenPool[] {
  const ids = new Set<string>();
  let pools: FrozenPool[];
  try { pools = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as FrozenPool); }
  catch { throw new Error('Invalid frozen pool JSON; source content omitted'); }
  for (const pool of pools) {
    if (!pool || typeof pool.id !== 'string' || !pool.id.trim() || ids.has(pool.id) || typeof pool.query !== 'string' || !pool.query.trim() ||
        typeof pool.group !== 'string' || !pool.group.trim() || !Array.isArray(pool.relevant) || pool.relevant.length === 0 ||
        pool.relevant.some(id => typeof id !== 'string' || !id.trim()) || !Array.isArray(pool.candidates) ||
        pool.candidates.some(doc => !doc || typeof doc.id !== 'string' || !doc.id.trim() || typeof doc.text !== 'string')) {
      throw new Error('Invalid frozen pool: unique id, query, group, candidates and nonempty relevance labels required');
    }
    ids.add(pool.id);
  }
  if (!pools.length) throw new Error('No frozen pools');
  return pools;
}

/** Cluster bootstrap: related queries move together; deterministic seed for reproducibility. */
export function pairedHit1(left: number[], right: number[], groups: string[]) {
  if (!left.length || left.length !== right.length || left.length !== groups.length) throw new Error('Unpaired results');
  const grouped = new Map<string, number[]>();
  const differences = left.map((value, i) => right[i]! - value);
  differences.forEach((value, i) => grouped.set(groups[i]!, [...(grouped.get(groups[i]!) ?? []), value]));
  const clusters = [...grouped.values()];
  let seed = 20260917;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const samples = Array.from({ length: 2000 }, () => {
    let sum = 0, count = 0;
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      sum += cluster.reduce((a, b) => a + b, 0); count += cluster.length;
    }
    return sum / count;
  }).sort((a, b) => a - b);
  return {
    delta: differences.reduce((a, b) => a + b, 0) / left.length,
    wins: differences.filter(value => value > 0).length,
    losses: differences.filter(value => value < 0).length,
    ties: differences.filter(value => value === 0).length,
    clusters: clusters.length, ci95: [samples[50]!, samples[1949]!],
  };
}

async function namedThingPools(): Promise<FrozenPool[]> {
  const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
  const { hybridSearch } = await import('../src/core/search/hybrid.ts');
  const { loadNamedThingQuestions, seedNamedThingCorpus } = await import('../test/fixtures/retrieval-quality/namedthing/corpus.ts');
  const engine = new PGLiteEngine();
  __setEmbedTransportForTests(() => { throw new Error('rank-only snapshot: no vectors'); });
  try {
    await engine.connect({}); await engine.initSchema();
    await seedNamedThingCorpus(engine);
    const pools: FrozenPool[] = [];
    for (const [i, question] of loadNamedThingQuestions().entries()) {
      if (question.family === 'hard-negative') continue;
      const rows = await hybridSearch(engine, question.query, { sourceId: 'default', limit: 30,
        reranker: { enabled: false, topNIn: 30, topNOut: null }, autocut: false });
      pools.push({ id: `namedthing-${i}`, query: question.query, relevant: question.relevant!,
        group: question.relevant!.join('|'), candidates: rows.map(row => ({ id: row.slug, text: row.chunk_text || row.title || '' })) });
    }
    return pools;
  } finally { await engine.disconnect(); __setEmbedTransportForTests(null); }
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0;

/** Optional evaluation-only splitting. Never changes the production Voyage adapter. */
export async function rerankPoolChunks(input: RerankInput & { documents: string[] }, batchSize: number | RerankBatchPlan[] | AsyncIterable<RerankBatchPlan>,
  beforeBatch: () => Promise<void>, call: (input: RerankInput) => Promise<RerankResult[]>) {
  if (typeof batchSize === 'number' && (!Number.isSafeInteger(batchSize) || batchSize < 0)) {
    throw new Error('Invalid reranking batch coverage');
  }
  const dynamic = typeof batchSize !== 'number' && Symbol.asyncIterator in batchSize;
  const size = typeof batchSize === 'number' ? batchSize || Math.max(1, input.documents.length) : 1;
  const plan = typeof batchSize === 'number'
    ? Array.from({ length: Math.ceil(input.documents.length / size) }, (_, i) => ({ offset: i * size, count: Math.min(size, input.documents.length - i * size), inputTokens: 0 }))
    : batchSize;
  if (!dynamic && ((plan as RerankBatchPlan[]).reduce((sum, batch) => sum + batch.count, 0) !== input.documents.length ||
      (plan as RerankBatchPlan[]).some((batch, i, batches) => !Number.isSafeInteger(batch.count) || batch.count <= 0 ||
        batch.offset !== (i ? batches[i - 1]!.offset + batches[i - 1]!.count : 0)))) {
    throw new Error('Invalid reranking batch coverage');
  }
  const ranked: RerankResult[] = [];
  let activeMs = 0, quotaWaitMs = 0, wallStart = 0, coverage = 0, nextStart = performance.now();
  for await (const { offset, count } of plan) {
    if (offset !== coverage || !Number.isSafeInteger(count) || count <= 0 || offset + count > input.documents.length) {
      throw new Error('Invalid reranking batch coverage');
    }
    if (dynamic && offset > 0) quotaWaitMs += performance.now() - nextStart;
    const waitStart = performance.now();
    await beforeBatch();
    if (offset === 0) wallStart = performance.now();
    else quotaWaitMs += performance.now() - waitStart;
    const start = performance.now();
    const documents = input.documents.slice(offset, offset + count);
    const chunk = await call({ ...input, documents });
    const valid = chunk.length === documents.length && new Set(chunk.map(r => r.index)).size === chunk.length &&
      chunk.every(r => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length && Number.isFinite(r.relevanceScore));
    if (!valid) throw new Error('Incomplete reranking response');
    ranked.push(...chunk.map(result => ({ ...result, index: offset + result.index })));
    activeMs += performance.now() - start;
    coverage += count;
    nextStart = performance.now();
  }
  if (coverage !== input.documents.length) throw new Error('Incomplete reranking batch coverage');
  const mergeStart = performance.now();
  ranked.sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index);
  activeMs += performance.now() - mergeStart;
  return { ranked, activeMs, wallMs: coverage ? performance.now() - wallStart : activeMs, quotaWaitMs };
}

export async function main(args = process.argv.slice(2), transport: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<void> {
  const flag = (name: string, fallback?: string) => {
    const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1];
  };
  const dryRun = args.includes('--dry-run');
  const candidateOnly = args.includes('--candidate-only');
  const fixture = args.includes('--namedthing');
  const poolPath = flag('--pools');
  const out = flag('--out');
  const baseline = flag('--baseline', 'voyage:rerank-2.5')!;
  const candidate = flag('--candidate', 'typesafe:jev-1.13.0')!;
  const timeoutMs = Number(flag('--timeout-ms', '5000'));
  const maxUsd = Number(flag('--max-usd', '1'));
  const repeats = Number(flag('--repeats', '1'));
  const baselineIntervalMs = Number(flag('--baseline-interval-ms', '0'));
  const candidateIntervalMs = Number(flag('--candidate-interval-ms', '0'));
  const baselineBatchSize = Number(flag('--baseline-batch-size', '0'));
  const baselineMaxInputTokens = Number(flag('--baseline-max-input-tokens', '600000'));
  const baselineRpm = Number(flag('--baseline-rpm', '0'));
  const baselineTpm = Number(flag('--baseline-tpm', '0'));
  const baselineConcurrency = Number(flag('--baseline-concurrency', '1'));
  const baselineTokenMargin = Number(flag('--baseline-token-margin', '2'));
  const voyageCountTokens = (text: string) => estimateRerankTokens(text, baselineTokenMargin);
  const quotaEnabled = baselineRpm > 0 && baselineTpm > 0;
  const isolateProfiles = args.includes('--baseline-isolate-profiles');
  const models = candidateOnly ? [candidate] : [baseline, candidate];
  if ((fixture === !!poolPath) || !out || (!candidateOnly && baseline === candidate) ||
      !Number.isInteger(repeats) || repeats < 1 || repeats > 100 ||
      !Number.isInteger(baselineBatchSize) || baselineBatchSize < 0 || baselineBatchSize > 1000 ||
      !Number.isSafeInteger(baselineMaxInputTokens) || baselineMaxInputTokens <= 0 || baselineMaxInputTokens > 600_000 ||
      (args.includes('--baseline-max-input-tokens') && !baseline.startsWith('voyage:')) ||
      [baselineRpm, baselineTpm].some(value => !Number.isSafeInteger(value) || value < 0) ||
      ((baselineRpm > 0) !== (baselineTpm > 0)) || (quotaEnabled && (!baseline.startsWith('voyage:') || baselineIntervalMs > 0)) ||
      !Number.isSafeInteger(baselineConcurrency) || baselineConcurrency < 1 || baselineConcurrency > 16 ||
      (baselineConcurrency > 1 && !quotaEnabled) ||
      (isolateProfiles && !quotaEnabled) ||
      !Number.isFinite(baselineTokenMargin) || baselineTokenMargin < 1 || baselineTokenMargin > 4 ||
      [baselineIntervalMs, candidateIntervalMs].some(value => !Number.isFinite(value) || value < 0 || value > 60_000) ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxUsd) || maxUsd <= 0) {
    throw new Error('Usage: --pools frozen.jsonl | --namedthing; --out receipt.json [--dry-run] [--candidate-only] [--baseline provider:model] [--candidate provider:model] [--repeats 1] [--max-usd 1] [--timeout-ms 5000] [--baseline-interval-ms 0 | --baseline-rpm N --baseline-tpm N] [--baseline-concurrency 1] [--baseline-token-margin 2] [--baseline-isolate-profiles] [--candidate-interval-ms 0] [--baseline-batch-size 0] [--baseline-max-input-tokens 600000]');
  }
  const config = buildGatewayConfig(loadConfig() ?? { engine: 'pglite' });
  configureGateway(config);
  // Preflight BOTH providers before any provider spend, including embeddings.
  if (!dryRun) for (const model of models) {
    const ready = rerankerReadiness(model, config.env ?? {}, { baseUrlOverrides: config.base_urls });
    if (!ready.ready) throw new Error(`Reranker not ready: ${model}; required env: ${ready.requiredKey ?? 'check recipe/model'}`);
    if (lookupEmbeddingPrice(model).kind !== 'known') throw new Error(`Missing price for ${model}`);
  }
  const pools = fixture ? await namedThingPools() : parsePools(readFileSync(poolPath!, 'utf8'));
  // Identical caps for both providers; fingerprint exactly what they will see.
  pools.forEach(pool => pool.candidates.forEach(doc => { doc.text = capRerankDoc(doc.text); }));
  const fingerprint = createHash('sha256').update(JSON.stringify(pools)).digest('hex');
  // Validate ALL evidence before spending; each provider has its own formula.
  const batchPlans = pools.map(pool => {
    const documents = pool.candidates.map(doc => doc.text);
    return { id: pool.id, providers: Object.fromEntries(models.map(model => [model,
      model.startsWith('typesafe:')
        ? buildTypeSafeRerankBatches(model.split(':')[1]!, pool.query, documents).map(batch => ({ offset: batch.indices[0], count: batch.indices.length, inputTokens: batch.estimatedInputTokens }))
        : model.startsWith('voyage:')
          ? planVoyageRerankBatches(pool.query, documents, Math.min(baselineMaxInputTokens, quotaEnabled ? baselineTpm : Infinity), baselineBatchSize || 1000, voyageCountTokens)
          : null])) };
  });
  const rows: Array<Record<string, any>> = [];
  const provider = Object.fromEntries(models.map(model => [model, {
    calls: 0, usageInputTokens: 0, usageComplete: true, resolvedModels: new Set<string>(), requestHashes: new Set<string>(),
  }]));
  mkdirSync(dirname(out), { recursive: true });
  const tracker = new BudgetTracker({ label: 'typesafe-rerank-ab', maxCostUsd: maxUsd, auditPath: `${out}.budget.jsonl` });
  let activeModel = '';
  let activeOperation: { profileId: string; sample: number; nextBatch: number; quotaWaitMs: number; plans: RerankBatchPlan[] };
  const chunkContext = new AsyncLocalStorage<{ batchIndex: number; plan: RerankBatchPlan; waitMs: number }>();
  const requestAuditPath = `${out}.requests.jsonl`;
  writeFileSync(requestAuditPath, '');
  const recorder = createRerankRequestRecorder(model => {
    const price = lookupEmbeddingPrice(model);
    return price.kind === 'known' ? price.pricePerMTok : null;
  }, record => appendFileSync(requestAuditPath, JSON.stringify(record) + '\n'));
  const lastStart = new Map(models.map(model => [model, Date.now()]));
  const baselineQuota = quotaEnabled ? createRerankQuota(baselineRpm, baselineTpm) : null;
  const executedPlans: Array<{ profile_id: string; sample: number; model: string; batches: RerankBatchPlan[] }> = [];
  let failure: string | null = null;
  __setRerankTransportForTests(async (url, init) => {
    // Compare untruncated evidence. This is an evaluation-only wire option.
    if (activeModel.startsWith('voyage:')) {
      init = { ...init, body: JSON.stringify({ ...JSON.parse(String(init?.body)), truncation: false }) };
    }
    const telemetry = provider[activeModel]!;
    telemetry.calls++;
    telemetry.requestHashes.add(createHash('sha256').update(String(init?.body ?? '')).digest('hex'));
    const body = String(init?.body ?? '');
    const local = chunkContext.getStore();
    const batchIndex = local?.batchIndex ?? activeOperation.nextBatch++;
    const batch = local?.plan ?? activeOperation.plans[batchIndex];
    const payload = JSON.parse(body);
    const documents: string[] = activeModel.startsWith('typesafe:')
      ? Object.values(payload.questions).map((question: any) => question.instructions.candidate)
      : payload.documents;
    if (batch && batch.count !== documents.length) throw new Error('Request does not match its preflight plan');
    const context = { profile_id: activeOperation.profileId, sample: activeOperation.sample, model: activeModel,
      batch: batchIndex + 1, document_offset: batch?.offset ?? null, document_count: documents.length,
      document_chars: documents.reduce((sum, doc) => sum + doc.length, 0),
      estimated_input_tokens: batch?.inputTokens ?? null, quota_wait_ms: local?.waitMs ?? activeOperation.quotaWaitMs };
    try {
      return await recorder.run(context, body, () => transport(url, init));
    } finally {
      const record = recorder.records.find(record => record.profile_id === context.profile_id &&
        record.sample === context.sample && record.model === context.model && record.batch === context.batch)!;
      if (record.http_status !== null && record.http_status >= 200 && record.http_status < 300 && record.input_tokens !== null) {
        telemetry.usageInputTokens += record.input_tokens;
      } else telemetry.usageComplete = false;
      if (record.resolved_model !== null) telemetry.resolvedModels.add(record.resolved_model);
    }
  });
  try {
    for (const [index, pool] of pools.entries()) {
      const original = pool.candidates.map(doc => doc.id);
      const row: Record<string, any> = { id: pool.id, group: pool.group,
        candidate_count: pool.candidates.length,
        document_chars: pool.candidates.reduce((sum, doc) => sum + doc.text.length, 0),
        shortlist_sha256: createHash('sha256').update(JSON.stringify(pool.candidates)).digest('hex'),
        candidate_recall: new Set(original.filter(id => pool.relevant.includes(id))).size / new Set(pool.relevant).size,
        off: { order: original, score: scoreRanking(pool, original) } };
      rows.push(row);
      if (dryRun) continue;
      // Alternate provider order; no cached inference used for live timing.
      for (let sample = 0; sample < repeats; sample++) {
        for (const model of (index + sample) % 2 ? [...models].reverse() : models) {
          activeModel = model;
          activeOperation = { profileId: pool.id, sample: sample + 1, nextBatch: 0, quotaWaitMs: 0,
            plans: batchPlans[index]!.providers[model] ?? [] };
          const interval = model === candidate ? candidateIntervalMs : baselineIntervalMs;
          const before = { calls: provider[model]!.calls, tokens: provider[model]!.usageInputTokens };
          try {
            let initialQuotaWaitMs = 0;
            if (isolateProfiles && baselineQuota && model === baseline) {
              const waitStart = performance.now();
              await baselineQuota.idle();
              initialQuotaWaitMs = performance.now() - waitStart;
            }
            const planStart = performance.now();
            const documents = pool.candidates.map(doc => doc.text);
            let plan: number | RerankBatchPlan[] | AsyncIterable<RerankBatchPlan> = model.startsWith('voyage:')
              ? planVoyageRerankBatches(pool.query, documents, baselineMaxInputTokens, baselineBatchSize || 1000, voyageCountTokens)
              : model === baseline ? baselineBatchSize : 0;
            const concurrentBaseline = baselineQuota && model === baseline && baselineConcurrency > 1;
            if (baselineQuota && model === baseline && !concurrentBaseline) {
              const operation = activeOperation;
              operation.plans = [];
              executedPlans.push({ profile_id: pool.id, sample: sample + 1, model, batches: operation.plans });
              const queryTokens = voyageCountTokens(pool.query);
              const pairTokens = documents.map(doc => queryTokens + voyageCountTokens(doc));
              const quota = baselineQuota;
              plan = (async function* () {
                let offset = 0;
                while (offset < documents.length) {
                  const reservation = await quota.acquire(offset, pairTokens, baselineMaxInputTokens, baselineBatchSize || 1000);
                  operation.quotaWaitMs = reservation.waitMs + (offset === 0 ? initialQuotaWaitMs : 0);
                  operation.plans.push(reservation.plan);
                  yield reservation.plan;
                  const request = recorder.records.find(record => record.profile_id === pool.id && record.sample === sample + 1 &&
                    record.model === model && record.batch === operation.plans.length);
                  reservation.settle(request?.input_tokens ?? null);
                  offset += reservation.plan.count;
                }
              })();
            }
            const planningMs = performance.now() - planStart;
            const result = concurrentBaseline ? await (async () => {
              const prepStart = performance.now();
              const operation = activeOperation;
              operation.plans = [];
              executedPlans.push({ profile_id: pool.id, sample: sample + 1, model, batches: operation.plans });
              const queryTokens = voyageCountTokens(pool.query);
              const pairTokens = documents.map(doc => queryTokens + voyageCountTokens(doc));
              const prepMs = performance.now() - prepStart;
              const result = await rerankConcurrentPool({ model, query: pool.query, documents, timeoutMs }, baselineConcurrency,
                async (offset, signal) => {
                  const reservation = await baselineQuota.acquire(offset, pairTokens, baselineMaxInputTokens, baselineBatchSize || 1000, signal,
                    Math.floor(Math.min(baselineMaxInputTokens, baselineTpm) / 2));
                  operation.plans.push(reservation.plan);
                  return { ...reservation, waitMs: reservation.waitMs + (offset === 0 ? initialQuotaWaitMs : 0), settle() {
                    const record = recorder.records.find(record => record.profile_id === pool.id && record.sample === sample + 1 &&
                      record.model === model && record.document_offset === offset);
                    reservation.settle(record?.input_tokens ?? null);
                  } };
                }, (input, plan, batch, waitMs) => chunkContext.run({ batchIndex: batch - 1, plan, waitMs },
                  () => withBudgetTracker(tracker, () => rerank(input))));
              return { ...result, activeMs: result.activeMs + prepMs, wallMs: result.wallMs + prepMs };
            })() : await rerankPoolChunks({ model, query: pool.query,
              documents, timeoutMs }, plan,
              async () => {
                const waitStart = performance.now();
                const remaining = (lastStart.get(model) ?? 0) + interval - Date.now();
                if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
                lastStart.set(model, Date.now());
                if (!baselineQuota || model !== baseline) activeOperation.quotaWaitMs = performance.now() - waitStart;
              }, input => withBudgetTracker(tracker, () => rerank(input)));
            const { ranked, quotaWaitMs } = result;
            const activeMs = result.activeMs + planningMs, wallMs = result.wallMs + planningMs;
            const order = ranked.map(result => pool.candidates[result.index]!.id);
            row[model] ??= { order, score: scoreRanking(pool, order), latency_ms: activeMs, latency_samples_ms: [],
              wall_samples_ms: [], quota_wait_samples_ms: [],
              provider_calls: 0, input_tokens: 0, cost_usd: null };
            row[model].latency_samples_ms.push(activeMs);
            row[model].wall_samples_ms.push(wallMs);
            row[model].quota_wait_samples_ms.push(quotaWaitMs);
            row[model].provider_calls += provider[model]!.calls - before.calls;
            row[model].input_tokens = provider[model]!.usageComplete
              ? row[model].input_tokens + provider[model]!.usageInputTokens - before.tokens : null;
            const price = lookupEmbeddingPrice(model);
            row[model].cost_usd = row[model].input_tokens !== null && price.kind === 'known'
              ? row[model].input_tokens * price.pricePerMTok / 1_000_000 : null;
          } catch (err) {
            // No raw provider error/body or private query in public receipts.
            const reason = err instanceof RerankError ? `${err.reason}; HTTP ${err.status ?? 'unavailable'}` : 'budget, policy, or invalid response';
            failure = `Evaluation incomplete at ${pool.id} for ${model}: ${reason}`;
            break;
          }
        }
        if (failure) break;
      }
      if (failure) break;
    }
  } finally { __setRerankTransportForTests(null); resetGateway(); }
  const complete = !dryRun && !failure && rows.length === pools.length;
  const summary = Object.fromEntries(['off', ...(!dryRun ? models : [])].map(model => {
    const scored = rows.filter(row => row[model]);
    const telemetry = provider[model];
    const price = model === 'off' ? null : lookupEmbeddingPrice(model);
    const timings = scored.flatMap(row => row[model].latency_samples_ms ?? []);
    const wallTimings = scored.flatMap(row => row[model].wall_samples_ms ?? []);
    const cost = price?.kind === 'known' && telemetry?.usageComplete
      ? telemetry.usageInputTokens * price.pricePerMTok / 1_000_000 : null;
    return [model, {
      n: scored.length,
      hit_at_1: scored.length ? mean(scored.map(row => row[model].score.hit1)) : null,
      hit_at_3: scored.length ? mean(scored.map(row => row[model].score.hit3)) : null,
      mrr: scored.length ? mean(scored.map(row => row[model].score.mrr)) : null,
      recall_at_3: scored.length ? mean(scored.map(row => row[model].score.recall3)) : null,
      latency_samples: timings.length,
      latency_p50_ms: model === 'off' ? null : percentile(timings, 0.5),
      latency_p95_ms: model === 'off' ? null : percentile(timings, 0.95),
      wall_p50_ms: model === 'off' ? null : percentile(wallTimings, 0.5),
      wall_p95_ms: model === 'off' ? null : percentile(wallTimings, 0.95),
      provider_calls: telemetry?.calls ?? 0,
      resolved_models: telemetry ? [...telemetry.resolvedModels] : [],
      request_sha256: telemetry ? [...telemetry.requestHashes] : [],
      input_tokens: telemetry?.usageComplete ? telemetry.usageInputTokens : null,
      cost_usd: cost,
      cost_per_query_usd: complete && cost !== null ? cost / (pools.length * repeats) : null,
    }];
  }));
  const receipt = {
    schema_version: 6, status: dryRun ? 'dry_run' : !complete ? 'incomplete' : candidateOnly ? 'candidate_only' : 'complete', failure,
    evaluated_at: new Date().toISOString(), fixture: fixture ? 'NamedThing rank-only regression fixture' : poolPath,
    label_granularity: fixture ? 'page; not passage support' : 'provided by dataset; review independently',
    qualification: fixture ? 'Small known synthetic regression fixture; not held-out quality proof or full production search.' : 'Frozen candidate reranking; not final answer quality.',
    shortlist_sha256: fingerprint, queries: pools.length, timeout_ms: timeoutMs, max_usd: maxUsd,
    repeats, quality_scoring: 'First response per query; repetitions measure timing and cost, not extra independent questions.',
    pacing_ms: { baseline: baselineIntervalMs, candidate: candidateIntervalMs },
    baseline_batch_size: baselineBatchSize,
    baseline_concurrency: baselineConcurrency,
    baseline_concurrent_packing: 'While another reservation is pending, wait for settlement rather than dispatch a non-final batch smaller than half the request/window budget. This evaluation policy trades immediate concurrency for scarce RPM slots.',
    baseline_token_margin: baselineTokenMargin,
    baseline_isolate_profiles: isolateProfiles,
    baseline_max_input_tokens: baselineMaxInputTokens,
    baseline_quota: quotaEnabled ? { rpm: baselineRpm, tpm: baselineTpm, window_ms: 61_000,
      basis: 'Conservative estimated input reserved before each call, settled to provider-reported usage; adaptively packs remaining window budget. Account admission estimation may differ.' } : null,
    executed_plans: executedPlans,
    token_planning: { basis: RERANK_TOKEN_ESTIMATE_BASIS + '; Voyage margin is independently configurable and recorded.', typesafe: { state_plus_longest_question: 32_000, state_plus_all_questions: 64_000, headroom: 2048 }, voyage: { query: 8000, query_document_pair: 32_000, max_documents: baselineBatchSize || 1000, cl100k_margin: baselineTokenMargin, aggregate_evaluation_ceiling: baselineMaxInputTokens }, plans: batchPlans },
    timing_basis: 'Active time is the union of gateway-call intervals plus planning/merge, never the sum of overlapping calls. Wall includes between-chunk quota/dispatch idle time; initial between-query pacing excluded. With concurrent baseline, quota_wait is wall minus active, not the sum of overlapping per-request waits.',
    baseline_execution: baseline.startsWith('voyage:') || baselineBatchSize ? 'Provider-specific evaluation-only chunks merged by score; untruncated evidence; not paid-tier capacity.' : 'Native gateway call.',
    cost_basis: 'Provider-reported input tokens at list prices; account credits and promotions excluded.',
    request_timing_basis: 'Client HTTP duration through cloned response JSON read; excludes quota waits, batch planning and final ranking merge. Start offsets are relative to the first HTTP call of the same profile/model/sample. Concurrent durations overlap and must not be summed as elapsed time.',
    request_audit_path: requestAuditPath, requests: recorder.records,
    summary, paired_hit_at_1: complete && !candidateOnly ? pairedHit1(rows.map(row => row[baseline].score.hit1), rows.map(row => row[candidate].score.hit1), rows.map(row => row.group)) : null,
    gateway_budget_estimate_usd: tracker.snapshot().cumulativeCostUsd,
    _meta: { metric_glossary: buildMetricGlossaryMeta(['hit@1', 'hit@3', 'mrr']) }, rows,
  };
  writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: receipt.status, queries: pools.length, summary, paired_hit_at_1: receipt.paired_hit_at_1, receipt: out }));
  if (failure) throw new Error(failure);
}

if (import.meta.main) main().catch(err => { console.error(err.message); process.exitCode = 2; });
