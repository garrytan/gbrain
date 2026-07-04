import type { BrainEngine } from '../engine.ts';
import { estimateTokenCount } from '../token-count.ts';
import type { MemoryScenarioKnownSubject, MemoryScenarioScopeDecision, RetrievalRouteIntent } from '../types.ts';
import { readContext } from '../services/read-context-service.ts';
import { retrieveContext, type RetrieveContextDependencies } from '../services/retrieve-context-service.ts';

export interface RetrievalEvalThresholds {
  top1_match_rate?: number;
  recall_at_10?: number;
}

export interface RetrievalEvalCaseInput {
  id: string;
  query: string;
  route: RetrievalRouteIntent;
  expected_selected_intent?: RetrievalRouteIntent | null;
  requested_scope?: Exclude<MemoryScenarioScopeDecision, 'defer'>;
  known_subjects?: Array<string | MemoryScenarioKnownSubject>;
  provenance?: Record<string, unknown> | string | null;
  gold_slugs: string[];
  gold_answer?: string | null;
  precision_k?: number;
  limit?: number;
  token_budget?: number;
}

export interface RetrievalEvalFixtureInput {
  fixture_id: string;
  thresholds?: RetrievalEvalThresholds;
  model_id?: string | null;
  cases: RetrievalEvalCaseInput[];
}

export interface RetrievalAnswerJudgeRequest {
  case: RetrievalEvalCaseInput;
  candidate_slugs: string[];
  candidate_answer: string;
  evidence_text: string;
  judge_model: string;
  prompt_version: string;
}

export interface RetrievalAnswerJudgeResult {
  score: number | null;
  passed: boolean | null;
  reason: string | null;
  model_id: string;
  prompt_version: string;
}

export type RetrievalAnswerJudge = (
  request: RetrievalAnswerJudgeRequest,
) => Promise<RetrievalAnswerJudgeResult>;

export interface RetrievalEvalOptions {
  judge?: RetrievalAnswerJudge;
  judge_model?: string | null;
  judge_prompt_version?: string | null;
  retrieve_context_dependencies?: RetrieveContextDependencies;
}

export interface RetrievalEvalCaseResult {
  id: string;
  route: RetrievalRouteIntent;
  selected_intent: RetrievalRouteIntent | null;
  expected_selected_intent: RetrievalRouteIntent | null;
  route_match: boolean | null;
  query: string;
  status: 'passed' | 'failed';
  gold_slugs: string[];
  candidate_slugs: string[];
  required_read_slugs: string[];
  scored_slugs: string[];
  top1_slug: string | null;
  top1_match: boolean;
  recall_at_10: number;
  precision_at_k: number;
  precision_k: number;
  mrr: number;
  missing_gold_slugs: string[];
  latency_ms: number;
  retrieved_token_count: number;
  trace_id: string | null;
  read_trace_id: string | null;
  judge: RetrievalAnswerJudgeResult | null;
}

export interface RetrievalEvalRouteSummary {
  case_count: number;
  top1_match_rate: number;
  recall_at_10: number;
  precision_at_k: number;
  mrr: number;
  latency_ms_avg: number;
  retrieved_token_count_total: number;
}

export interface RetrievalEvalReport {
  fixture_id: string;
  status: 'passed' | 'failed';
  thresholds: Required<RetrievalEvalThresholds>;
  case_count: number;
  top1_match_rate: number;
  recall_at_10: number;
  precision_at_k: number;
  mrr: number;
  latency_ms_avg: number;
  retrieved_token_count_total: number;
  per_route: Partial<Record<RetrievalRouteIntent, RetrievalEvalRouteSummary>>;
  cases: RetrievalEvalCaseResult[];
  failures: Array<{
    id: string;
    route: RetrievalRouteIntent;
    query: string;
    top1_slug: string | null;
    missing_gold_slugs: string[];
    reason_codes: Array<'top1_miss' | 'recall_at_10_miss' | 'judge_failed' | 'route_mismatch'>;
  }>;
  judge: {
    enabled: boolean;
    model_id: string | null;
    prompt_version: string | null;
  };
}

const DEFAULT_THRESHOLDS: Required<RetrievalEvalThresholds> = {
  top1_match_rate: 1,
  recall_at_10: 1,
};

export async function evaluateLiveRetrievalFixture(
  engine: BrainEngine,
  fixture: RetrievalEvalFixtureInput,
  options: RetrievalEvalOptions = {},
): Promise<RetrievalEvalReport> {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(fixture.thresholds ?? {}),
  };
  const cases: RetrievalEvalCaseResult[] = [];

  for (const testCase of fixture.cases) {
    cases.push(await evaluateLiveRetrievalCase(engine, testCase, options));
  }

  const top1MatchRate = average(cases.map((testCase) => testCase.top1_match ? 1 : 0));
  const recallAt10 = average(cases.map((testCase) => testCase.recall_at_10));
  const aggregatePassed = top1MatchRate >= thresholds.top1_match_rate
    && recallAt10 >= thresholds.recall_at_10
    && cases.every((testCase) => testCase.judge?.passed !== false && testCase.route_match !== false);

  return {
    fixture_id: fixture.fixture_id,
    status: aggregatePassed ? 'passed' : 'failed',
    thresholds,
    case_count: cases.length,
    top1_match_rate: top1MatchRate,
    recall_at_10: recallAt10,
    precision_at_k: average(cases.map((testCase) => testCase.precision_at_k)),
    mrr: average(cases.map((testCase) => testCase.mrr)),
    latency_ms_avg: average(cases.map((testCase) => testCase.latency_ms)),
    retrieved_token_count_total: cases.reduce((total, testCase) => total + testCase.retrieved_token_count, 0),
    per_route: summarizeByRoute(cases),
    cases,
    failures: cases.flatMap((testCase) => caseFailure(testCase)),
    judge: {
      enabled: Boolean(options.judge),
      model_id: options.judge_model ?? null,
      prompt_version: options.judge_prompt_version ?? null,
    },
  };
}

async function evaluateLiveRetrievalCase(
  engine: BrainEngine,
  testCase: RetrievalEvalCaseInput,
  options: RetrievalEvalOptions,
): Promise<RetrievalEvalCaseResult> {
  const started = Date.now();
  const retrieval = await retrieveContext(
    engine,
    {
      query: testCase.query,
      limit: testCase.limit ?? 10,
      token_budget: testCase.token_budget,
      include_orientation: false,
      persist_trace: true,
      requested_scope: testCase.requested_scope,
      known_subjects: testCase.known_subjects,
    },
    options.retrieve_context_dependencies,
  );
  const latencyMs = Math.max(0, Date.now() - started);
  const candidateSlugs = uniqueStrings(retrieval.candidates
    .map((candidate) => candidate.read_selector.slug)
    .filter((slug): slug is string => Boolean(slug)));
  const selectorSnapshots = retrieval.read_plan.selected_selector_snapshots?.length
    ? retrieval.read_plan.selected_selector_snapshots
    : retrieval.required_reads;
  const requiredReadSlugs = uniqueStrings(selectorSnapshots
    .map((selector) => selector.slug)
    .filter((slug): slug is string => Boolean(slug)));
  const scoredSlugs = uniqueStrings([...requiredReadSlugs, ...candidateSlugs]);
  const goldSlugs = uniqueStrings(testCase.gold_slugs);
  const top10 = scoredSlugs.slice(0, 10);
  const top1Slug = scoredSlugs[0] ?? null;
  const goldSet = new Set(goldSlugs);
  const missingGoldSlugs = goldSlugs.filter((slug) => !top10.includes(slug));
  const precisionK = Math.max(1, Math.floor(testCase.precision_k ?? 10));
  const topK = scoredSlugs.slice(0, precisionK);
  const hitsAtK = topK.filter((slug) => goldSet.has(slug)).length;
  const reciprocalRank = reciprocalRankForGold(scoredSlugs, goldSet);
  const read = options.judge ? await readCanonicalEvidence(engine, testCase, retrieval) : null;
  const evidenceText = read
    ? read.canonical_reads.map((canonicalRead) => canonicalRead.text).join('\n\n')
    : retrieval.candidates.map(candidateEvidenceText).join('\n\n');
  const candidateAnswer = read ? synthesizeAnswerFromCanonicalReads(evidenceText) : evidenceText;
  const judge = options.judge && options.judge_model && options.judge_prompt_version
    ? await options.judge({
      case: testCase,
      candidate_slugs: scoredSlugs,
      candidate_answer: candidateAnswer,
      evidence_text: evidenceText,
      judge_model: options.judge_model,
      prompt_version: options.judge_prompt_version,
    })
    : null;
  const estimatedCandidateTokens = retrieval.candidates.reduce(
      (total, candidate) =>
        total + estimateTokenCount(candidateEvidenceText(candidate)),
      0,
    );
  const readTokenCount = read
    ? read.trace?.retrieved_token_count
      ?? read.canonical_reads.reduce((total, canonicalRead) => total + canonicalRead.token_estimate, 0)
    : null;
  const retrievedTokenCount = readTokenCount !== null && readTokenCount > 0
    ? readTokenCount
    : retrieval.trace?.retrieved_token_count && retrieval.trace.retrieved_token_count > 0
    ? retrieval.trace.retrieved_token_count
    : estimatedCandidateTokens;
  const selectedIntent = retrieval.trace?.selected_intent ?? retrieval.route?.selected_intent ?? null;
  const expectedSelectedIntent = testCase.expected_selected_intent ?? null;
  const routeMatch = expectedSelectedIntent === null ? null : selectedIntent === expectedSelectedIntent;
  const passed = top1Slug !== null
    && goldSet.has(top1Slug)
    && missingGoldSlugs.length === 0
    && judge?.passed !== false
    && routeMatch !== false;

  return {
    id: testCase.id,
    route: testCase.route,
    selected_intent: selectedIntent,
    expected_selected_intent: expectedSelectedIntent,
    route_match: routeMatch,
    query: testCase.query,
    status: passed ? 'passed' : 'failed',
    gold_slugs: goldSlugs,
    candidate_slugs: candidateSlugs,
    required_read_slugs: requiredReadSlugs,
    scored_slugs: scoredSlugs,
    top1_slug: top1Slug,
    top1_match: top1Slug !== null && goldSet.has(top1Slug),
    recall_at_10: goldSlugs.length === 0
      ? 1
      : (goldSlugs.length - missingGoldSlugs.length) / goldSlugs.length,
    precision_at_k: hitsAtK / precisionK,
    precision_k: precisionK,
    mrr: reciprocalRank,
    missing_gold_slugs: missingGoldSlugs,
    latency_ms: latencyMs,
    retrieved_token_count: retrievedTokenCount,
    trace_id: retrieval.trace?.id ?? null,
    read_trace_id: read?.trace?.id ?? null,
    judge,
  };
}

async function readCanonicalEvidence(
  engine: BrainEngine,
  testCase: RetrievalEvalCaseInput,
  retrieval: Awaited<ReturnType<typeof retrieveContext>>,
) {
  const readSelectors = retrieval.read_plan.selected_selector_snapshots?.length
    ? retrieval.read_plan.selected_selector_snapshots
    : retrieval.required_reads;
  return readContext(engine, {
    query: testCase.query,
    selectors: readSelectors,
    include_source_refs: true,
    persist_trace: true,
    probe_context: {
      retrieve_trace_ids: retrieval.trace?.id ? [retrieval.trace.id] : [],
      candidate_signal_count: retrieval.candidate_signals.length,
      candidate_signal_ids: retrieval.candidate_signals.map((signal) => signal.candidate_id),
      search_chunk_count: retrieval.candidates.reduce(
        (total, candidate) => total + candidate.matched_chunks.length,
        0,
      ),
      context_map_consulted: retrieval.orientation.derived_consulted.length > 0,
    },
  });
}

function synthesizeAnswerFromCanonicalReads(evidenceText: string): string {
  const trimmed = evidenceText.trim();
  if (trimmed.length <= 4000) return trimmed;
  return `${trimmed.slice(0, 4000)}\n[truncated]`;
}

function candidateEvidenceText(candidate: {
  read_selector: { slug?: string; kind: string };
  canonical_target: { title?: string; slug?: string };
  matched_chunks: Array<{ chunk_source: string; stale: boolean }>;
  why_matched: string[];
}): string {
  const slug = candidate.read_selector.slug ?? candidate.canonical_target.slug ?? 'unknown';
  const title = candidate.canonical_target.title ?? slug;
  const chunkSources = candidate.matched_chunks.map((chunk) => chunk.chunk_source).join(',');
  return [
    `title: ${title}`,
    `slug: ${slug}`,
    `selector_kind: ${candidate.read_selector.kind}`,
    chunkSources ? `matched_chunk_sources: ${chunkSources}` : null,
    candidate.why_matched.length > 0 ? `why_matched: ${candidate.why_matched.join('; ')}` : null,
  ].filter(Boolean).join('\n');
}

function summarizeByRoute(
  cases: RetrievalEvalCaseResult[],
): Partial<Record<RetrievalRouteIntent, RetrievalEvalRouteSummary>> {
  const groups = new Map<RetrievalRouteIntent, RetrievalEvalCaseResult[]>();
  for (const testCase of cases) {
    const route = testCase.selected_intent ?? testCase.route;
    const group = groups.get(route) ?? [];
    group.push(testCase);
    groups.set(route, group);
  }
  const summary: Partial<Record<RetrievalRouteIntent, RetrievalEvalRouteSummary>> = {};
  for (const [route, group] of groups) {
    summary[route] = {
      case_count: group.length,
      top1_match_rate: average(group.map((testCase) => testCase.top1_match ? 1 : 0)),
      recall_at_10: average(group.map((testCase) => testCase.recall_at_10)),
      precision_at_k: average(group.map((testCase) => testCase.precision_at_k)),
      mrr: average(group.map((testCase) => testCase.mrr)),
      latency_ms_avg: average(group.map((testCase) => testCase.latency_ms)),
      retrieved_token_count_total: group.reduce((total, testCase) => total + testCase.retrieved_token_count, 0),
    };
  }
  return summary;
}

function caseFailure(testCase: RetrievalEvalCaseResult): RetrievalEvalReport['failures'][number][] {
  const reasonCodes: RetrievalEvalReport['failures'][number]['reason_codes'] = [
    ...(!testCase.top1_match ? ['top1_miss' as const] : []),
    ...(testCase.missing_gold_slugs.length > 0 ? ['recall_at_10_miss' as const] : []),
    ...(testCase.judge?.passed === false ? ['judge_failed' as const] : []),
    ...(testCase.route_match === false ? ['route_mismatch' as const] : []),
  ];
  if (reasonCodes.length === 0) return [];
  return [{
    id: testCase.id,
    route: testCase.route,
    query: testCase.query,
    top1_slug: testCase.top1_slug,
    missing_gold_slugs: testCase.missing_gold_slugs,
    reason_codes: reasonCodes,
  }];
}

function reciprocalRankForGold(candidateSlugs: string[], goldSet: Set<string>): number {
  const index = candidateSlugs.findIndex((slug) => goldSet.has(slug));
  return index === -1 ? 0 : 1 / (index + 1);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
