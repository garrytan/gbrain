import type { BrainEngine } from '../engine.ts';
import { buildCandidateSignals, emptyCandidateSignalResult } from './candidate-signal-service.ts';
import type { BuildCandidateSignalsInput, CandidateSignalResult } from './candidate-signal-service.ts';
import type {
  GraphFrontierEdge,
  GraphFrontierInput,
  GraphFrontierNode,
  GraphFrontierPathTrace,
  GraphFrontierResult,
  Link,
  MemoryScenario,
  NoteManifestEntry,
  NoteSectionEntry,
  RetrieveContextCandidate,
  RetrieveContextGraphFrontierOptions,
  RetrieveContextInput,
  RetrieveContextOrientation,
  RetrieveContextReadPlan,
  RetrieveContextResult,
  RetrievalMatchedChunk,
  RetrievalRouteIntent,
  RetrievalTrace,
  RetrievalSelector,
  ScopeGateDecisionResult,
  ScopeGateScope,
  SearchResult,
} from '../types.ts';
import { getBroadSynthesisRoute } from './broad-synthesis-route-service.ts';
import { planAssertionGraphFrontier } from './assertion-frontier-retrieval-service.ts';
import { classifyMemoryScenario } from './memory-scenario-classifier-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { rankSearchResults, sourceRankCandidateLimit, sourceRankFactor } from '../search/source-ranking.ts';
import {
  corpusLaneFromSourceRefs,
  mergeSourceRefs,
  corpusLaneSourceRefs,
} from './corpus-lane-service.ts';
import {
  normalizeRetrievalSelector,
  retrievalSelectorId,
  selectorFromRouteRead,
  selectorFromSearchResult,
} from './retrieval-selector-service.ts';
import { evaluateScopeGate } from './scope-gate-service.ts';

export type RetrieveContextCandidateSearch = (
  query: string,
  options: { limit: number },
) => Promise<SearchResult[]>;

export type RetrieveContextCandidateSignalBuilder = (
  engine: BrainEngine,
  input: BuildCandidateSignalsInput,
) => Promise<CandidateSignalResult>;

export interface RetrieveContextGraphFrontierBuildInput {
  engine: BrainEngine;
  input: RetrieveContextInput;
  query: string;
  limit: number;
  candidates: RetrieveContextCandidate[];
  required_reads: RetrievalSelector[];
  orientation: RetrieveContextOrientation;
  scope_gate?: ScopeGateDecisionResult;
}

export interface RetrieveContextGraphFrontierBuildResult {
  scope_id?: string;
  policy_version?: string;
  seed_node_ids?: string[];
  nodes?: GraphFrontierNode[];
  edges?: GraphFrontierEdge[];
}

export type RetrieveContextGraphFrontierInputBuilder = (
  input: RetrieveContextGraphFrontierBuildInput,
) => Promise<RetrieveContextGraphFrontierBuildResult> | RetrieveContextGraphFrontierBuildResult;

export type RetrieveContextGraphFrontierPlanner = (
  input: GraphFrontierInput,
) => Promise<GraphFrontierResult> | GraphFrontierResult;

export interface RetrieveContextDependencies {
  candidateSearch?: RetrieveContextCandidateSearch;
  candidateSignalBuilder?: RetrieveContextCandidateSignalBuilder;
  graphFrontierInputBuilder?: RetrieveContextGraphFrontierInputBuilder;
  graphFrontierPlanner?: RetrieveContextGraphFrontierPlanner;
}

const DEFAULT_CANDIDATE_LIMIT = 5;
const DEFAULT_READ_CONTEXT_MAX_SELECTORS = 3;
const READ_PLAN_MAX_DEPTH = 1;
const CANDIDATE_SELECTOR_BATCH_SIZE = 10;
const MAX_CANDIDATE_QUERY_VARIANTS = 8;
const CANDIDATE_RRF_K = 60;
const LINKED_CANDIDATE_SEED_LIMIT = 5;
const LINKED_CANDIDATE_PER_SEED_LIMIT = 4;
const MANIFEST_LOOKUP_BATCH_SIZE = 100;
const MANIFEST_LINK_SCAN_BATCH_SIZE = 500;
// Backlink discovery is a fallback for seeds with no recorded links; cap the
// manifest scan so a large brain cannot turn one retrieval into a full-table
// sweep. Targets with fewer backlinks inside the cap simply get fewer.
const MANIFEST_LINK_SCAN_MAX_ROWS = 5_000;
const SEARCH_HIT_CONTEXT_CHARS = 40;
const SEARCH_CHUNK_WARNING = 'Search/query chunks are candidate pointers; call read_context before answering factual questions.';
const DEFAULT_GRAPH_FRONTIER_POLICY_VERSION = 'policy:v1';
const QUERY_TOKEN_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
]);

export async function retrieveContext(
  engine: BrainEngine,
  input: RetrieveContextInput,
  dependencies: RetrieveContextDependencies = {},
): Promise<RetrieveContextResult> {
  const limit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const requiredReadLimit = Math.min(limit, DEFAULT_READ_CONTEXT_MAX_SELECTORS);
  assertPositiveInteger(limit, 'limit');
  if (input.token_budget !== undefined) assertPositiveInteger(input.token_budget, 'token_budget');

  const requestId = crypto.randomUUID();
  const classification = classifyMemoryScenario(input);
  const candidateSignalBuilder = dependencies.candidateSignalBuilder ?? buildCandidateSignals;
  const normalizedSelectors = (input.selectors ?? []).map((selector) => normalizeRetrievalSelector(selector));
  const scopeGate = await maybeEvaluateScopeGate(engine, input, classification.scenario, normalizedSelectors);

  if (scopeGate && scopeGate.policy !== 'allow') {
    return maybePersistRetrieveTrace(
      engine,
      blockedByScopeGate(requestId, classification.scenario, scopeGate),
      input,
    );
  }

  if (normalizedSelectors.length > 0) {
    const candidates = normalizedSelectors.map((selector, index) => candidateFromSelector(selector, index + 1));
    const requiredReads = normalizedSelectors;
    const orientation = emptyOrientation();
    const candidateSignals = await buildRetrieveContextCandidateSignals(
      candidateSignalBuilder,
      engine,
      input,
      classification.scenario,
      requiredReads,
      candidates,
      limit,
    );

    return maybePersistRetrieveTrace(engine, {
      request_id: requestId,
      scenario: classification.scenario,
      scope_gate: scopeGate,
      route: null,
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: ['exact_selectors_require_canonical_read'],
      },
      candidates,
      required_reads: requiredReads,
      read_plan: buildReadPlan({
        candidates,
        required_reads: requiredReads,
        orientation,
        candidate_signals: candidateSignals,
        required_read_limit: requiredReadLimit,
      }),
      orientation,
      ...candidateSignals,
      warnings: ['Exact selector supplied; call read_context for canonical evidence.'],
    }, input);
  }

  if (input.task_id) {
    const selector = normalizeRetrievalSelector({
      kind: 'task_working_set',
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      object_id: input.task_id,
      freshness: 'current',
    });
    const candidates = [candidateFromSelector(selector, 1)];
    const requiredReads = [selector];
    const orientation = emptyOrientation();
    const candidateSignals = await buildRetrieveContextCandidateSignals(
      candidateSignalBuilder,
      engine,
      input,
      classification.scenario,
      requiredReads,
      candidates,
      limit,
    );

    return maybePersistRetrieveTrace(engine, {
      request_id: requestId,
      scenario: classification.scenario,
      scope_gate: scopeGate,
      route: null,
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: ['task_continuation_requires_task_state'],
      },
      candidates,
      required_reads: requiredReads,
      read_plan: buildReadPlan({
        candidates,
        required_reads: requiredReads,
        orientation,
        candidate_signals: candidateSignals,
        required_read_limit: requiredReadLimit,
      }),
      orientation,
      ...candidateSignals,
      warnings: ['Task continuation must read task state before raw files or graph orientation.'],
    }, input);
  }

  const query = input.query?.trim() ?? '';
  const searchLimit = query.length > 0 ? sourceRankCandidateLimit(limit) : 0;
  const candidateSearch = dependencies.candidateSearch ?? ((candidateQuery, options) =>
    engine.searchKeyword(candidateQuery, { limit: options.limit }));
  // Orientation only depends on the query, not on the candidate search
  // results, so both run concurrently.
  const [searchResults, orientation] = await Promise.all([
    query.length > 0
      ? searchCandidatePool(candidateSearch, query, searchLimit).then((pool) => rankSearchResults(pool))
      : Promise.resolve([]),
    input.include_orientation === false || query.length === 0
      ? Promise.resolve(emptyOrientation())
      : buildOrientation(engine, query, limit),
  ]);
  const candidates = await groupCandidatesByCanonicalPage(engine, searchResults, limit, query, scopeGate);
  const baseRequiredReads = dedupeSelectorsByEvidence([
    ...candidates.map((candidate) => candidate.read_selector),
    ...orientation.recommended_reads,
  ].filter((selector) => selectorAllowedByRetrieveScope(selector, scopeGate))).slice(0, requiredReadLimit);
  const graphAugmentation = await maybeAugmentRequiredReadsWithGraphFrontier(engine, input, dependencies, {
    query,
    limit,
    candidates,
    required_reads: baseRequiredReads,
    orientation,
    scope_gate: scopeGate,
    required_read_limit: requiredReadLimit,
  });
  const requiredReads = graphAugmentation.required_reads;
  const candidateSignals = await buildRetrieveContextCandidateSignals(
    candidateSignalBuilder,
    engine,
    input,
    classification.scenario,
    requiredReads,
    candidates,
    limit,
  );

  return maybePersistRetrieveTrace(engine, {
    request_id: requestId,
    scenario: classification.scenario,
    scope_gate: scopeGate,
    route: null,
    answerability: {
      answerable_from_probe: false,
      allowed_probe_answer_kind: 'none',
      must_read_context: requiredReads.length > 0,
      reason_codes: broadRetrievalReasonCodes(requiredReads, candidateSignals),
    },
    candidates,
    required_reads: requiredReads,
    read_plan: buildReadPlan({
      candidates,
      required_reads: requiredReads,
      orientation: graphAugmentation.orientation,
      candidate_signals: candidateSignals,
      required_read_limit: requiredReadLimit,
    }),
    orientation: graphAugmentation.orientation,
    ...candidateSignals,
    warnings: [
      ...(searchResults.length > 0 ? [SEARCH_CHUNK_WARNING] : []),
      ...graphAugmentation.warnings,
      ...(requiredReads.length === 0 && candidateSignals.candidate_signals.length > 0
        ? ['No canonical read candidate was found; non-canonical Memory Inbox candidate signals are available.']
        : []),
      ...(requiredReads.length === 0 && candidateSignals.candidate_signals.length === 0
        ? ['No canonical read candidate was found.']
        : []),
    ],
  }, input);
}

async function maybeAugmentRequiredReadsWithGraphFrontier(
  engine: BrainEngine,
  input: RetrieveContextInput,
  dependencies: RetrieveContextDependencies,
  context: Omit<RetrieveContextGraphFrontierBuildInput, 'engine' | 'input'> & {
    required_read_limit: number;
  },
): Promise<{
  required_reads: RetrievalSelector[];
  orientation: RetrieveContextOrientation;
  warnings: string[];
}> {
  const options = input.graph_frontier;
  if (options?.enabled !== true) {
    return {
      required_reads: context.required_reads,
      orientation: context.orientation,
      warnings: [],
    };
  }

  const buildResult = dependencies.graphFrontierInputBuilder
    ? await dependencies.graphFrontierInputBuilder({
      engine,
      input,
      query: context.query,
      limit: context.limit,
      candidates: context.candidates,
      required_reads: context.required_reads,
      orientation: context.orientation,
      scope_gate: context.scope_gate,
    })
    : {};
  const graphInput = buildGraphFrontierInput(input, options, context.required_reads, buildResult);
  const graphResult = await (dependencies.graphFrontierPlanner ?? planAssertionGraphFrontier)(graphInput);
  const graphSelectors = graphResult.selected_selectors
    .filter((entry) => entry.activation === 'canonical_read')
    .map((entry) => entry.selector)
    .filter((selector) => selectorAllowedByRetrieveScope(selector, context.scope_gate));
  const baseGraphKeys = new Set(context.required_reads
    .map(graphSelectorDuplicateKey)
    .filter((key): key is string => key !== undefined));
  const newGraphSelectors = graphSelectors.filter((selector) => {
    const key = graphSelectorDuplicateKey(selector);
    return key === undefined || !baseGraphKeys.has(key);
  });
  const requiredReads = dedupeSelectorsByEvidence([
    ...context.required_reads,
    ...newGraphSelectors,
  ]).slice(0, context.required_read_limit);
  const graphPaths = graphResult.paths_considered.map(formatGraphFrontierPath);
  const orientation = graphPaths.length > 0 || graphSelectors.length > 0
    ? {
      ...context.orientation,
      derived_consulted: mergeSourceRefs(context.orientation.derived_consulted, ['graph_frontier']),
      graph_paths_considered: mergeSourceRefs(context.orientation.graph_paths_considered ?? [], graphPaths),
      summary_lines: [
        ...context.orientation.summary_lines,
        `Graph frontier considered ${graphResult.paths_considered.length} path${graphResult.paths_considered.length === 1 ? '' : 's'} and selected ${newGraphSelectors.length} canonical read${newGraphSelectors.length === 1 ? '' : 's'}.`,
      ],
    }
    : context.orientation;

  return {
    required_reads: requiredReads,
    orientation,
    warnings: graphFrontierWarnings(options, buildResult, graphResult),
  };
}

function graphSelectorDuplicateKey(selector: RetrievalSelector): string | undefined {
  const scopeId = selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const pageRef = selector.slug
    ?? pageRefFromPath(selector.path)
    ?? (selector.section_id ? selector.section_id.split('#')[0] : undefined);
  return pageRef ? `${scopeId}:${canonicalPageRef(pageRef)}` : undefined;
}

function pageRefFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.split('#')[0]?.trim() || undefined;
}

function canonicalPageRef(value: string): string {
  return canonicalRetrievalPath(value)
    .replace(/\.md$/i, '')
    .split('#')[0]!;
}

function buildGraphFrontierInput(
  input: RetrieveContextInput,
  options: RetrieveContextGraphFrontierOptions,
  requiredReads: RetrievalSelector[],
  buildResult: RetrieveContextGraphFrontierBuildResult,
): GraphFrontierInput {
  return {
    enabled: true,
    scope_id: firstNonEmpty(buildResult.scope_id, candidateSignalScopeId(input, requiredReads)),
    policy_version: firstNonEmpty(buildResult.policy_version, DEFAULT_GRAPH_FRONTIER_POLICY_VERSION),
    seed_node_ids: buildResult.seed_node_ids ?? [],
    nodes: buildResult.nodes ?? [],
    edges: buildResult.edges ?? [],
    ...(options.max_depth !== undefined ? { max_depth: options.max_depth } : {}),
    ...(options.fanout_cap !== undefined ? { fanout_cap: options.fanout_cap } : {}),
  };
}

function graphFrontierWarnings(
  options: RetrieveContextGraphFrontierOptions,
  buildResult: RetrieveContextGraphFrontierBuildResult,
  graphResult: GraphFrontierResult,
): string[] {
  const omittedSummary = summarizeGraphOmissions(graphResult);
  return [
    ...((buildResult.seed_node_ids ?? []).length === 0
      ? ['Graph frontier enabled but no seed nodes were available.']
      : []),
    ...((buildResult.nodes ?? []).length === 0
      ? ['Graph frontier enabled but no scoped graph nodes were available.']
      : []),
    ...(omittedSummary.length > 0 ? [`Graph frontier omitted paths: ${omittedSummary.join(', ')}.`] : []),
    ...(graphResult.warnings.length > 0 ? ['Graph frontier reported stale graph warnings.'] : []),
    ...(graphResult.authority_violations.length > 0
      ? [`Graph frontier reported ${graphResult.authority_violations.length} authority violation${graphResult.authority_violations.length === 1 ? '' : 's'}.`]
      : []),
  ];
}

function summarizeGraphOmissions(graphResult: GraphFrontierResult): string[] {
  const counts = new Map<string, number>();
  for (const omitted of graphResult.omitted_paths) {
    counts.set(omitted.reason, (counts.get(omitted.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`);
}

function formatGraphFrontierPath(path: GraphFrontierPathTrace, index: number): string {
  return `graph_frontier_path:${index + 1} activation=${path.activation} authority=${path.authority}`;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value !== undefined && value.trim().length > 0) ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
}

async function maybeEvaluateScopeGate(
  engine: BrainEngine,
  input: RetrieveContextInput,
  scenario: MemoryScenario,
  selectors: RetrievalSelector[],
): Promise<ScopeGateDecisionResult | undefined> {
  const personalSelector = selectors.some(hasPersonalSelectorSignal);
  const shouldGate = input.requested_scope !== undefined
    || scenario === 'personal_recall'
    || scenario === 'mixed'
    || personalSelector;
  if (!shouldGate) return undefined;

  return evaluateScopeGate(engine, {
    intent: scenario === 'personal_recall' || personalSelector ? 'personal_profile_lookup' : 'broad_synthesis',
    requested_scope: input.requested_scope,
    task_id: input.task_id,
    query: input.query,
    repo_path: input.repo_path ?? undefined,
  });
}

function blockedByScopeGate(
  requestId: string,
  scenario: MemoryScenario,
  scopeGate: ScopeGateDecisionResult,
): RetrieveContextResult {
  return {
    request_id: requestId,
    scenario,
    scope_gate: scopeGate,
    route: null,
    answerability: {
      answerable_from_probe: false,
      allowed_probe_answer_kind: 'none',
      must_read_context: false,
      reason_codes: [`scope_gate_${scopeGate.policy}`],
    },
    candidates: [],
    required_reads: [],
    read_plan: emptyReadPlan(['Resolve the scope gate before planning canonical reads.']),
    orientation: emptyOrientation(),
    ...emptyCandidateSignalResult('strict', ['scope_gate_blocked']),
    warnings: scopeGate.summary_lines,
  };
}

async function buildRetrieveContextCandidateSignals(
  candidateSignalBuilder: RetrieveContextCandidateSignalBuilder,
  engine: BrainEngine,
  input: RetrieveContextInput,
  scenario: MemoryScenario,
  requiredReads: RetrievalSelector[],
  canonicalCandidates: RetrieveContextCandidate[],
  limit: number,
): Promise<CandidateSignalResult> {
  return candidateSignalBuilder(engine, {
    query: input.query?.trim(),
    requested_scope: input.requested_scope,
    scope_id: candidateSignalScopeId(input, requiredReads),
    scenario,
    known_subjects: input.known_subjects,
    required_reads: requiredReads,
    canonical_candidates: canonicalCandidates,
    limit,
  });
}

function candidateSignalScopeId(input: RetrieveContextInput, requiredReads: RetrievalSelector[]): string {
  const selectorScope = requiredReads.find(selector => selector.scope_id)?.scope_id;
  if (selectorScope) return selectorScope;
  if (input.requested_scope === 'personal') return 'personal:default';
  return DEFAULT_NOTE_MANIFEST_SCOPE_ID;
}

function broadRetrievalReasonCodes(
  requiredReads: RetrievalSelector[],
  candidateSignals: CandidateSignalResult,
): string[] {
  if (requiredReads.length > 0) return ['probe_candidates_are_not_answer_ground'];
  if (candidateSignals.candidate_signals.length > 0) return ['no_canonical_evidence_candidate_signals_present'];
  return ['no_candidate'];
}

async function searchCandidatePool(
  candidateSearch: RetrieveContextCandidateSearch,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const queries = candidateSearchQueries(query);
  const settled = await Promise.allSettled(
    queries.map((candidateQuery) => candidateSearch(candidateQuery, { limit })),
  );
  const resultLists = settled.flatMap((result) => (
    result.status === 'fulfilled' ? [result.value] : []
  ));
  if (resultLists.length === 0) return [];
  if (resultLists.length === 1) return resultLists[0]!;
  return fuseCandidateSearchResults(resultLists);
}

function candidateSearchQueries(query: string): string[] {
  const variants: string[] = [];
  const addVariant = (variant: string) => {
    const normalized = variant.trim();
    if (!normalized) return;
    if (variants.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) return;
    variants.push(normalized);
  };

  addVariant(query);
  const tokens = tokenizeForSectionRank(query);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    addVariant(token);
    if (index + 1 < tokens.length) {
      addVariant(`${token} ${tokens[index + 1]!}`);
    }
    if (variants.length >= MAX_CANDIDATE_QUERY_VARIANTS) break;
  }

  return variants;
}

function fuseCandidateSearchResults(resultLists: SearchResult[][]): SearchResult[] {
  const fusedByKey = new Map<string, { result: SearchResult; score: number; bestOriginalScore: number; firstSeen: number }>();
  let sequence = 0;

  for (const results of resultLists) {
    for (let rank = 0; rank < results.length; rank += 1) {
      const result = results[rank]!;
      const key = searchResultEvidenceKey(result);
      const rrfScore = 1 / (CANDIDATE_RRF_K + rank + 1);
      const existing = fusedByKey.get(key);
      if (!existing) {
        fusedByKey.set(key, {
          result,
          score: rrfScore,
          bestOriginalScore: result.score,
          firstSeen: sequence,
        });
        sequence += 1;
        continue;
      }

      existing.score += rrfScore;
      if (result.score > existing.bestOriginalScore) {
        existing.result = result;
        existing.bestOriginalScore = result.score;
      }
    }
  }

  return [...fusedByKey.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.bestOriginalScore !== a.bestOriginalScore) return b.bestOriginalScore - a.bestOriginalScore;
      return a.firstSeen - b.firstSeen;
    })
    .map((entry) => ({
      ...entry.result,
      score: entry.score,
    }));
}

function searchResultEvidenceKey(result: SearchResult): string {
  return [
    result.slug,
    result.chunk_source,
    normalizeText(result.chunk_text).slice(0, 160),
  ].join(':');
}

async function groupCandidatesByCanonicalPage(
  engine: BrainEngine,
  searchResults: SearchResult[],
  limit: number,
  query: string,
  scopeGate: ScopeGateDecisionResult | undefined,
): Promise<RetrieveContextCandidate[]> {
  const resultsBySlug = new Map<string, SearchResult[]>();
  const firstRankBySlug = new Map<string, number>();
  for (const result of searchResults) {
    const existing = resultsBySlug.get(result.slug) ?? [];
    existing.push(result);
    resultsBySlug.set(result.slug, existing);
    if (!firstRankBySlug.has(result.slug)) {
      firstRankBySlug.set(result.slug, firstRankBySlug.size);
    }
  }

  const groupedResults = [...resultsBySlug.entries()]
    .map(([slug, results]) => ({
      slug,
      results,
      top: results[0]!,
      rank: firstRankBySlug.get(slug) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.rank - b.rank);

  const manifestBySlug = await loadManifestEntriesBySlug(
    engine,
    groupedResults.map((group) => group.slug),
  );
  const resolvedCandidates: RetrieveContextCandidate[] = [];
  for (let index = 0; index < groupedResults.length; index += CANDIDATE_SELECTOR_BATCH_SIZE) {
    const batch = groupedResults.slice(index, index + CANDIDATE_SELECTOR_BATCH_SIZE);
    const resolved = await Promise.all(batch.map((group) =>
      resolveCandidateGroup(engine, group, query, manifestBySlug.get(slugLookupKey(group.slug)))));
    resolvedCandidates.push(...resolved);
  }

  const rankedBaseCandidates = rankResolvedCandidates(resolvedCandidates, query);
  const linkedCandidates = await linkedCandidatesForResolvedCandidates(
    engine,
    rankedBaseCandidates,
    query,
    limit,
    scopeGate,
    manifestBySlug,
  );
  const rankedCandidates = rankResolvedCandidates([...rankedBaseCandidates, ...linkedCandidates], query);
  const candidates: RetrieveContextCandidate[] = [];
  const seenCanonicalEvidence = new Set<string>();
  for (const candidate of rankedCandidates) {
    if (!selectorAllowedByRetrieveScope(candidate.read_selector, scopeGate)) continue;
    const evidenceKey = canonicalEvidenceKey(candidate.read_selector);
    if (evidenceKey && seenCanonicalEvidence.has(evidenceKey)) continue;
    if (evidenceKey) seenCanonicalEvidence.add(evidenceKey);
    candidates.push({
      ...candidate,
      read_priority: candidates.length + 1,
    });
    if (candidates.length >= limit) break;
  }

  return candidates;
}

function rankResolvedCandidates(
  candidates: RetrieveContextCandidate[],
  query: string,
): RetrieveContextCandidate[] {
  const queryTokens = tokenizeForSectionRank(query);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreResolvedCandidate(candidate, queryTokens),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((entry) => entry.candidate);
}

function scoreResolvedCandidate(candidate: RetrieveContextCandidate, queryTokens: string[]): number {
  const title = normalizeText(candidate.canonical_target.title ?? '');
  const path = normalizeText(candidate.canonical_target.path ?? '');
  const sectionId = normalizeText(candidate.canonical_target.section_id ?? '');
  const targetText = `${title} ${path} ${sectionId}`;
  const matchedChunkText = normalizeText(candidate.matched_chunks
    .map((chunk) => `${chunk.title} ${chunk.slug}`)
    .join(' '));
  let score = Math.max(0, ...candidate.matched_chunks.map((chunk) => chunk.score)) * 100;
  score *= sourceRankFactor(candidate.canonical_target.slug ?? candidate.read_selector.slug ?? '');

  for (let index = 0; index < queryTokens.length; index += 1) {
    const token = queryTokens[index]!;
    const positionWeight = Math.max(1, queryTokens.length - index);
    if (title.includes(token)) score += 16 + (positionWeight * 8);
    if (path.includes(token)) score += 6 + (positionWeight * 3);
    if (sectionId.includes(token)) score += 5 + (positionWeight * 2);
    if (matchedChunkText.includes(token)) score += 2 + positionWeight;
  }

  const coveredTokens = queryTokens.filter((token) => targetText.includes(token) || matchedChunkText.includes(token));
  score += coveredTokens.length * 4;
  if (queryTokens.length > 0 && coveredTokens.length === queryTokens.length) score += 12;
  if (candidate.why_matched.some((reason) => reason.startsWith('linked from '))) score += 18;
  if (candidate.read_selector.freshness === 'stale') score -= 8;

  return score;
}

async function resolveCandidateGroup(
  engine: BrainEngine,
  group: { slug: string; results: SearchResult[]; top: SearchResult },
  query: string,
  manifest?: NoteManifestEntry,
): Promise<RetrieveContextCandidate> {
  const readResult = bestTimelineSearchResult(group.results) ?? group.top;
  const selector = await bestReadSelectorForSearchResult(engine, readResult, query);
  const manifestCorpusLane = manifest
    ? corpusLaneForManifest(manifest)
    : await corpusLaneForPage(engine, group.slug);
  const corpusLane = selector.corpus_lane
    ?? corpusLaneFromSourceRefs(selector.source_refs ?? [])
    ?? manifestCorpusLane;
  const readSelector = corpusLane
    ? normalizeRetrievalSelector({ ...selector, corpus_lane: corpusLane })
    : selector;

  return {
    candidate_id: `candidate:${group.slug}`,
    canonical_target: {
      kind: readSelector.kind,
      slug: group.slug,
      title: group.top.title,
      type: group.top.type,
      path: readSelector.path,
      section_id: readSelector.section_id,
      scope_id: readSelector.scope_id,
      ...(corpusLane ? { corpus_lane: corpusLane } : {}),
    },
    matched_chunks: group.results.map((result) => toMatchedChunk(result, corpusLane)),
    why_matched: [`matched ${group.results.length} search chunk${group.results.length === 1 ? '' : 's'}`],
    activation: group.top.stale ? 'verify_first' : 'candidate_only',
    read_priority: 0,
    read_selector: readSelector,
  };
}

async function linkedCandidatesForResolvedCandidates(
  engine: BrainEngine,
  seedCandidates: RetrieveContextCandidate[],
  query: string,
  limit: number,
  scopeGate: ScopeGateDecisionResult | undefined,
  knownManifestBySlug?: Map<string, NoteManifestEntry>,
): Promise<RetrieveContextCandidate[]> {
  const seedSlugs = seedCandidates
    .map((candidate) => candidate.read_selector.slug)
    .filter((slug): slug is string => Boolean(slug))
    .slice(0, LINKED_CANDIDATE_SEED_LIMIT);
  if (seedSlugs.length === 0) return [];

  const seedManifestBySlug = new Map(knownManifestBySlug ?? []);
  const missingSeedSlugs = seedSlugs.filter((seedSlug) => !seedManifestBySlug.has(slugLookupKey(seedSlug)));
  const loadedSeedManifestBySlug = await loadManifestEntriesBySlug(engine, missingSeedSlugs);
  for (const [slug, manifest] of loadedSeedManifestBySlug) {
    seedManifestBySlug.set(slug, manifest);
  }
  const explicitLinksBySeed = await explicitLinkedSlugsBySeed(engine, seedSlugs);

  const linkedSlugsBySeed = new Map<string, string[]>();
  for (const seedSlug of seedSlugs) {
    const seedManifest = seedManifestBySlug.get(slugLookupKey(seedSlug));
    const explicit = explicitLinksBySeed.get(seedSlug);
    linkedSlugsBySeed.set(seedSlug, uniqueSlugs([
      ...(seedManifest?.outgoing_wikilinks ?? []),
      ...(explicit?.outgoing ?? []),
      ...(explicit?.incoming ?? []),
    ]));
  }

  const seedsNeedingManifestBacklinks = seedSlugs.filter(
    (seedSlug) => (linkedSlugsBySeed.get(seedSlug)?.length ?? 0) === 0,
  );
  if (seedsNeedingManifestBacklinks.length > 0) {
    const incomingBySlug = await manifestBacklinkSlugs(engine, new Set(seedsNeedingManifestBacklinks));
    for (const seedSlug of seedsNeedingManifestBacklinks) {
      linkedSlugsBySeed.set(seedSlug, uniqueSlugs([
        ...(linkedSlugsBySeed.get(seedSlug) ?? []),
        ...(incomingBySlug.get(seedSlug) ?? []),
      ]));
    }
  }

  const linkedManifestBySlug = await loadManifestEntriesBySlug(
    engine,
    uniqueSlugs([...linkedSlugsBySeed.values()].flat()),
  );
  // Selection is synchronous (limits + scope gating depend only on loaded
  // manifests), so pick the winners first and build their candidates
  // concurrently instead of one engine round-trip pair at a time.
  const selected: { seedSlug: string; manifest: NoteManifestEntry }[] = [];
  const seenSlugKeys = new Set(seedSlugs.map(slugLookupKey));
  for (const seedSlug of seedSlugs) {
    const linkedSlugs = linkedSlugsBySeed.get(seedSlug) ?? [];
    let addedForSeed = 0;

    for (const linkedSlug of linkedSlugs) {
      if (addedForSeed >= LINKED_CANDIDATE_PER_SEED_LIMIT) break;
      const linkedSlugKey = slugLookupKey(linkedSlug);
      if (seenSlugKeys.has(linkedSlugKey)) continue;
      const linkedManifest = linkedManifestBySlug.get(linkedSlugKey);
      if (!linkedManifest) continue;
      if (!manifestAllowedByRetrieveScope(linkedManifest, scopeGate)) continue;

      selected.push({ seedSlug, manifest: linkedManifest });
      seenSlugKeys.add(linkedSlugKey);
      addedForSeed += 1;
    }
  }

  return Promise.all(selected.map(({ seedSlug, manifest }) =>
    candidateFromLinkedManifest(engine, manifest, seedSlug, query)));
}

async function loadManifestEntriesBySlug(
  engine: BrainEngine,
  slugs: string[],
): Promise<Map<string, NoteManifestEntry>> {
  const unique = uniqueSlugs(slugs);
  if (unique.length === 0) return new Map();

  if (typeof engine.listNoteManifestEntries === 'function') {
    const manifestBySlug = new Map<string, NoteManifestEntry>();
    for (let index = 0; index < unique.length; index += MANIFEST_LOOKUP_BATCH_SIZE) {
      const batchSlugs = unique.slice(index, index + MANIFEST_LOOKUP_BATCH_SIZE);
      const manifests = await engine.listNoteManifestEntries({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        slugs: batchSlugs,
        limit: batchSlugs.length,
      });
      for (const manifest of manifests) {
        manifestBySlug.set(slugLookupKey(manifest.slug), manifest);
      }
    }
    return manifestBySlug;
  }

  if (typeof engine.getNoteManifestEntry !== 'function') return new Map();
  const entries = await Promise.all(unique.map(async (slug) => [
    slug,
    await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug),
  ] as const));
  return new Map(entries
    .filter((entry): entry is readonly [string, NoteManifestEntry] => entry[1] !== null)
    .map(([slug, manifest]) => [slugLookupKey(slug), manifest]));
}

async function manifestBacklinkSlugs(
  engine: BrainEngine,
  targetSlugs: Set<string>,
): Promise<Map<string, string[]>> {
  const incomingByTarget = new Map<string, string[]>();
  if (targetSlugs.size === 0) return incomingByTarget;
  if (typeof engine.listNoteManifestEntries !== 'function') return incomingByTarget;

  for (let offset = 0; offset < MANIFEST_LINK_SCAN_MAX_ROWS; offset += MANIFEST_LINK_SCAN_BATCH_SIZE) {
    const batch = await engine.listNoteManifestEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      limit: MANIFEST_LINK_SCAN_BATCH_SIZE,
      offset,
    });

    for (const manifest of batch) {
      for (const targetSlug of manifest.outgoing_wikilinks) {
        if (!targetSlugs.has(targetSlug)) continue;
        const incoming = incomingByTarget.get(targetSlug) ?? [];
        if (incoming.length >= LINKED_CANDIDATE_PER_SEED_LIMIT) continue;
        incoming.push(manifest.slug);
        incomingByTarget.set(targetSlug, incoming);
      }
    }

    if (manifestBacklinksSatisfied(targetSlugs, incomingByTarget) || batch.length < MANIFEST_LINK_SCAN_BATCH_SIZE) {
      break;
    }
  }

  return incomingByTarget;
}

function manifestBacklinksSatisfied(
  targetSlugs: Set<string>,
  incomingByTarget: Map<string, string[]>,
): boolean {
  for (const targetSlug of targetSlugs) {
    if ((incomingByTarget.get(targetSlug)?.length ?? 0) < LINKED_CANDIDATE_PER_SEED_LIMIT) {
      return false;
    }
  }
  return true;
}

async function explicitLinkedSlugsBySeed(
  engine: BrainEngine,
  seedSlugs: string[],
): Promise<Map<string, { outgoing: string[]; incoming: string[] }>> {
  const explicitBySeed = new Map<string, { outgoing: string[]; incoming: string[] }>(seedSlugs.map((seedSlug) => [
    seedSlug,
    { outgoing: [], incoming: [] },
  ]));
  if (seedSlugs.length === 0) return explicitBySeed;

  const [outgoingResult, incomingResult] = await Promise.allSettled([
    explicitOutgoingSlugsBySeed(engine, seedSlugs),
    explicitIncomingSlugsBySeed(engine, seedSlugs),
  ]);

  if (outgoingResult.status === 'fulfilled') {
    for (const [seedSlug, outgoing] of outgoingResult.value) {
      const explicit = explicitBySeed.get(seedSlug);
      if (explicit) explicit.outgoing = outgoing;
    }
  }
  if (incomingResult.status === 'fulfilled') {
    for (const [seedSlug, incoming] of incomingResult.value) {
      const explicit = explicitBySeed.get(seedSlug);
      if (explicit) explicit.incoming = incoming;
    }
  }

  return explicitBySeed;
}

async function explicitOutgoingSlugsBySeed(
  engine: BrainEngine,
  seedSlugs: string[],
): Promise<Map<string, string[]>> {
  if (typeof engine.getLinksForSlugs === 'function') {
    try {
      const linksBySeed = await engine.getLinksForSlugs(seedSlugs);
      return mapLinksBySeed(seedSlugs, linksBySeed, (link) => link.to_slug);
    } catch {
      // Optional batch APIs are an optimization; degrade to the existing
      // per-seed path if the batch query is unavailable or transiently fails.
    }
  }
  if (typeof engine.getLinks !== 'function') return new Map();

  return new Map(await Promise.all(seedSlugs.map(async (seedSlug): Promise<[string, string[]]> => {
    try {
      const links = await engine.getLinks(seedSlug);
      return [seedSlug, links.map((link) => link.to_slug)];
    } catch {
      return [seedSlug, []];
    }
  })));
}

async function explicitIncomingSlugsBySeed(
  engine: BrainEngine,
  seedSlugs: string[],
): Promise<Map<string, string[]>> {
  if (typeof engine.getBacklinksForSlugs === 'function') {
    try {
      const backlinksBySeed = await engine.getBacklinksForSlugs(seedSlugs);
      return mapLinksBySeed(seedSlugs, backlinksBySeed, (link) => link.from_slug);
    } catch {
      // Optional batch APIs are an optimization; degrade to the existing
      // per-seed path if the batch query is unavailable or transiently fails.
    }
  }
  if (typeof engine.getBacklinks !== 'function') return new Map();

  return new Map(await Promise.all(seedSlugs.map(async (seedSlug): Promise<[string, string[]]> => {
    try {
      const links = await engine.getBacklinks(seedSlug);
      return [seedSlug, links.map((link) => link.from_slug)];
    } catch {
      return [seedSlug, []];
    }
  })));
}

function mapLinksBySeed(
  seedSlugs: string[],
  linksBySeed: Map<string, Link[]>,
  linkedSlug: (link: Link) => string,
): Map<string, string[]> {
  return new Map(seedSlugs.map((seedSlug) => [
    seedSlug,
    (linksBySeed.get(seedSlug) ?? linksBySeed.get(slugLookupKey(seedSlug)) ?? []).map(linkedSlug),
  ]));
}

function slugLookupKey(slug: string): string {
  return slug.toLowerCase();
}

function uniqueSlugs(slugs: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const slug of slugs) {
    const key = slugLookupKey(slug);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(slug);
  }
  return output;
}

async function candidateFromLinkedManifest(
  engine: BrainEngine,
  manifest: NoteManifestEntry,
  seedSlug: string,
  query: string,
): Promise<RetrieveContextCandidate> {
  const selector = await bestReadSelectorForLinkedManifest(engine, manifest, query);
  const corpusLane = selector.corpus_lane
    ?? corpusLaneFromSourceRefs(selector.source_refs ?? [])
    ?? corpusLaneForManifest(manifest);
  const readSelector = corpusLane
    ? normalizeRetrievalSelector({ ...selector, corpus_lane: corpusLane })
    : selector;

  return {
    candidate_id: `candidate:${manifest.slug}:linked`,
    canonical_target: {
      kind: readSelector.kind,
      slug: manifest.slug,
      title: manifest.title,
      type: manifest.page_type,
      path: readSelector.path ?? manifest.path,
      section_id: readSelector.section_id,
      scope_id: readSelector.scope_id,
      ...(corpusLane ? { corpus_lane: corpusLane } : {}),
    },
    matched_chunks: [],
    why_matched: [`linked from ${seedSlug}`],
    activation: 'candidate_only',
    read_priority: 0,
    read_selector: readSelector,
  };
}

async function bestReadSelectorForLinkedManifest(
  engine: BrainEngine,
  manifest: NoteManifestEntry,
  query: string,
): Promise<RetrievalSelector> {
  const [projection, sections] = await Promise.all([
    engine.getPageProjection(manifest.slug),
    engine.listNoteSectionEntries({
      scope_id: manifest.scope_id,
      page_slug: manifest.slug,
      limit: 50,
    }),
  ]);
  const queryTokens = tokenizeForSectionRank(query);
  const rankedSection = sections
    .map((section, index) => ({
      section,
      index,
      score: scoreSectionCandidate(section, null, queryTokens, []),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.section.depth !== a.section.depth) return b.section.depth - a.section.depth;
      return a.index - b.index;
    })[0];

  if (rankedSection) {
    return normalizeRetrievalSelector({
      kind: 'section',
      scope_id: rankedSection.section.scope_id,
      slug: rankedSection.section.page_slug,
      path: `${rankedSection.section.page_path}#${rankedSection.section.heading_path.join('/')}`,
      section_id: rankedSection.section.section_id,
      line_start: rankedSection.section.line_start,
      line_end: rankedSection.section.line_end,
      source_refs: rankedSection.section.source_refs,
      content_hash: projection?.content_hash,
      freshness: 'current',
    });
  }

  return normalizeRetrievalSelector({
    kind: 'compiled_truth',
    scope_id: manifest.scope_id,
    slug: manifest.slug,
    path: manifest.path,
    source_refs: manifest.source_refs,
    content_hash: projection?.content_hash,
    freshness: 'current',
  });
}

function bestTimelineSearchResult(results: SearchResult[]): SearchResult | undefined {
  return results.reduce<SearchResult | undefined>((best, result) => {
    if (result.chunk_source !== 'timeline') return best;
    if (!best || result.score > best.score) return result;
    return best;
  }, undefined);
}

async function bestReadSelectorForSearchResult(
  engine: BrainEngine,
  result: SearchResult,
  query: string,
): Promise<RetrievalSelector> {
  if (result.chunk_source === 'timeline') {
    return selectorFromSearchResult(result);
  }

  const sections = await engine.listNoteSectionEntries({
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    page_slug: result.slug,
    limit: 50,
  });
  const matchingSection = bestSectionForSearchResult(sections, result, query);

  if (matchingSection) {
    const charStart = matchingSection.match && matchingSection.match.index > 0
      ? Math.max(0, matchingSection.match.index - SEARCH_HIT_CONTEXT_CHARS)
      : undefined;
    const projection = await engine.getPageProjection(result.slug);
    return normalizeRetrievalSelector({
      kind: 'section',
      scope_id: matchingSection.section.scope_id,
      slug: matchingSection.section.page_slug,
      path: `${matchingSection.section.page_path}#${matchingSection.section.heading_path.join('/')}`,
      section_id: matchingSection.section.section_id,
      line_start: matchingSection.section.line_start,
      line_end: matchingSection.section.line_end,
      char_start: charStart,
      source_refs: matchingSection.section.source_refs,
      content_hash: projection?.content_hash,
      freshness: result.stale ? 'stale' : 'current',
    });
  }

  return selectorFromSearchResult(result);
}

function bestSectionForSearchResult(
  sections: NoteSectionEntry[],
  result: SearchResult,
  query: string,
): { section: NoteSectionEntry; match: { index: number; length: number } | null } | undefined {
  if (sections.length === 0) return undefined;

  const queryTokens = tokenizeForSectionRank(query);
  const chunkTokens = tokenizeForSectionRank(result.chunk_text);
  const ranked = sections
    .map((section, index) => {
      const match = locateSearchSnippet(section.section_text, result.chunk_text);
      return {
        section,
        index,
        match,
        score: scoreSectionCandidate(section, match, queryTokens, chunkTokens),
      };
    })
    .filter((entry) => entry.match !== null || entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.section.depth !== a.section.depth) return b.section.depth - a.section.depth;
      return a.index - b.index;
    });

  const best = ranked[0];
  if (!best) return undefined;
  return {
    section: best.section,
    match: best.match,
  };
}

function scoreSectionCandidate(
  section: NoteSectionEntry,
  match: { index: number; length: number } | null,
  queryTokens: string[],
  chunkTokens: string[],
): number {
  const heading = normalizeText(`${section.heading_text} ${section.heading_path.join(' ')}`);
  const body = normalizeText(section.section_text);
  const searchable = `${heading} ${body}`;
  let score = 0;

  if (match) {
    score += 40 + Math.min(match.length, 80);
  }

  for (const token of queryTokens) {
    if (heading.includes(token)) score += 70;
    if (body.includes(token)) score += 6;
  }

  for (const token of chunkTokens) {
    if (heading.includes(token)) score += 12;
    if (body.includes(token)) score += 2;
  }

  if (queryTokens.length > 0 && queryTokens.every((token) => searchable.includes(token))) {
    score += 16;
  }

  if (match && queryTokens.some((token) => heading.includes(token))) {
    score += 24;
  }

  const headingMatchesQueryOrChunk = queryTokens.some((token) => heading.includes(token))
    || chunkTokens.some((token) => heading.includes(token));
  if (section.depth > 1 && headingMatchesQueryOrChunk) {
    score += section.depth;
  }

  return score;
}

function tokenizeForSectionRank(value: string): string[] {
  const seen = new Set<string>();
  const tokens = normalizeText(value)
    .match(/[a-z0-9]+/g)
    ?? [];
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (QUERY_TOKEN_STOPWORDS.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

function hasPersonalSelectorSignal(selector: RetrievalSelector): boolean {
  if (selector.kind === 'profile_memory' || selector.kind === 'personal_episode') {
    return true;
  }

  return isPersonalScopeId(selector.scope_id);
}

function selectorAllowedByRetrieveScope(
  selector: RetrievalSelector,
  scopeGate: ScopeGateDecisionResult | undefined,
): boolean {
  if (scopeGate?.policy !== 'allow') return true;
  if (scopeGate.resolved_scope !== 'work') return true;
  return !hasExplicitPersonalAuthoritySelector(selector);
}

function manifestAllowedByRetrieveScope(
  manifest: NoteManifestEntry,
  scopeGate: ScopeGateDecisionResult | undefined,
): boolean {
  if (scopeGate?.policy !== 'allow') return true;
  if (scopeGate.resolved_scope !== 'work') return true;
  return !isPersonalScopeId(manifest.scope_id);
}

function hasExplicitPersonalAuthoritySelector(selector: RetrievalSelector): boolean {
  if (selector.kind === 'profile_memory' || selector.kind === 'personal_episode') {
    return true;
  }
  return isPersonalScopeId(selector.scope_id);
}

function isPersonalScopeId(value: string | undefined): boolean {
  if (!value) return false;
  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === 'personal' || normalizedValue.startsWith('personal:');
}

async function buildOrientation(
  engine: BrainEngine,
  query: string,
  limit: number,
): Promise<RetrieveContextOrientation> {
  const routeResult = await getBroadSynthesisRoute(engine, { query, limit });
  if (!routeResult.route) return emptyOrientation();

  return {
    derived_consulted: [`context_map:${routeResult.route.map_id}`],
    recommended_reads: routeResult.route.recommended_reads.map(selectorFromRouteRead),
    summary_lines: routeResult.route.summary_lines,
  };
}

function candidateFromSelector(selector: RetrievalSelector, priority: number): RetrieveContextCandidate {
  const corpusLane = selector.corpus_lane ?? corpusLaneFromSourceRefs(selector.source_refs ?? []);
  return {
    candidate_id: `candidate:${retrievalSelectorId(selector)}`,
    canonical_target: {
      kind: selector.kind,
      slug: selector.slug,
      path: selector.path,
      section_id: selector.section_id,
      scope_id: selector.scope_id,
      ...(corpusLane ? { corpus_lane: corpusLane } : {}),
    },
    matched_chunks: [],
    why_matched: ['explicit selector'],
    activation: 'candidate_only',
    read_priority: priority,
    read_selector: corpusLane
      ? normalizeRetrievalSelector({ ...selector, corpus_lane: corpusLane })
      : selector,
  };
}

function emptyOrientation(): RetrieveContextOrientation {
  return {
    derived_consulted: [],
    recommended_reads: [],
    summary_lines: [],
  };
}

function emptyReadPlan(nextActions: string[] = []): RetrieveContextReadPlan {
  return {
    mode: 'bounded_evidence',
    max_depth: READ_PLAN_MAX_DEPTH,
    max_selectors: 0,
    selected_selectors: [],
    deferred_candidate_ids: [],
    gap_reasons: [],
    next_actions: nextActions,
  };
}

function buildReadPlan(input: {
  candidates: RetrieveContextCandidate[];
  required_reads: RetrievalSelector[];
  orientation: RetrieveContextOrientation;
  candidate_signals: CandidateSignalResult;
  required_read_limit: number;
}): RetrieveContextReadPlan {
  const selectedSelectors = input.required_reads.map(retrievalSelectorId);
  const selectedEvidence = new Set(input.required_reads.map(selectorEvidencePlanKey));
  const deferredCandidateIds = input.candidates
    .filter((candidate) => !selectedEvidence.has(selectorEvidencePlanKey(candidate.read_selector)))
    .map((candidate) => candidate.candidate_id);
  const deferredOrientationReads = input.orientation.recommended_reads
    .filter((selector) => !selectedEvidence.has(selectorEvidencePlanKey(selector)));
  const gapReasons: RetrieveContextReadPlan['gap_reasons'] = [];

  if (input.required_reads.length === 0) {
    gapReasons.push('no_canonical_read_candidates');
  }
  if (deferredCandidateIds.length > 0 || input.candidates.length > input.required_reads.length) {
    gapReasons.push('candidate_pool_exceeds_read_budget');
  }
  if (deferredOrientationReads.length > 0) {
    gapReasons.push('orientation_reads_deferred');
  }
  if (input.candidate_signals.candidate_signals.length > 0) {
    gapReasons.push('candidate_signals_are_non_canonical');
  }

  return {
    mode: 'bounded_evidence',
    max_depth: READ_PLAN_MAX_DEPTH,
    max_selectors: input.required_read_limit,
    selected_selectors: selectedSelectors,
    deferred_candidate_ids: deferredCandidateIds,
    gap_reasons: [...new Set(gapReasons)],
    next_actions: readPlanNextActions(
      selectedSelectors,
      deferredCandidateIds,
      input.orientation.recommended_reads.length > 0,
      input.candidate_signals,
    ),
  };
}

function selectorEvidencePlanKey(selector: RetrievalSelector): string {
  return canonicalEvidenceKey(normalizeRetrievalSelector(selector)) ?? retrievalSelectorId(selector);
}

function readPlanNextActions(
  selectedSelectors: string[],
  deferredCandidateIds: string[],
  hasOrientationReads: boolean,
  candidateSignals: CandidateSignalResult,
): string[] {
  const actions: string[] = [];
  if (selectedSelectors.length > 0) {
    actions.push('Call read_context with read_plan.selected_selectors before making factual claims.');
  } else {
    actions.push('Do not answer factual claims until retrieve_context finds canonical read selectors.');
  }
  if (deferredCandidateIds.length > 0) {
    actions.push('If read_context reports gaps, rerun retrieve_context with a narrower query or higher limit.');
  }
  if (hasOrientationReads) {
    actions.push('Broad-synthesis route contributes orientation reads only; read_plan.selected_selectors remains the evidence boundary.');
  }
  if (candidateSignals.candidate_signals.length > 0) {
    actions.push('Inspect candidate_signals separately; they are non-canonical and not answer evidence.');
  }
  return actions;
}

function toMatchedChunk(result: SearchResult, corpusLane?: RetrievalMatchedChunk['corpus_lane']): RetrievalMatchedChunk {
  return {
    slug: result.slug,
    page_id: result.page_id,
    title: result.title,
    type: result.type,
    chunk_source: result.chunk_source,
    score: result.score,
    stale: result.stale,
    ...(corpusLane ? { corpus_lane: corpusLane } : {}),
  };
}

function canonicalEvidenceKey(selector: RetrievalSelector): string | undefined {
  if (selector.kind !== 'section' && selector.kind !== 'compiled_truth' && selector.kind !== 'page') return undefined;
  const contentHash = selector.content_hash?.trim();
  const retrievalPath = selector.path
    ? canonicalRetrievalPath(selector.path)
    : selector.section_id
      ? canonicalRetrievalPath(selector.section_id)
      : selector.slug
        ? canonicalRetrievalPath(`${selector.slug}.md`)
        : undefined;
  if (!retrievalPath) return undefined;
  return contentHash
    ? `canonical:${contentHash}:${retrievalPath}`
    : `canonical:${selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID}:${retrievalPath}`;
}

function canonicalRetrievalPath(path: string): string {
  return path.replace(/^brain\//, '').replace(/^\/+/, '').toLowerCase();
}

async function corpusLaneForPage(
  engine: BrainEngine,
  slug: string,
): Promise<RetrievalMatchedChunk['corpus_lane'] | undefined> {
  if (typeof engine.getNoteManifestEntry !== 'function') return undefined;
  const manifest = await engine.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug);
  return manifest ? corpusLaneFromSourceRefs(manifest.source_refs) : undefined;
}

function corpusLaneForManifest(manifest: NoteManifestEntry): RetrievalMatchedChunk['corpus_lane'] | undefined {
  return corpusLaneFromSourceRefs(manifest.source_refs);
}

function dedupeSelectorsByEvidence(selectors: RetrievalSelector[]): RetrievalSelector[] {
  const seen = new Set<string>();
  const output: RetrievalSelector[] = [];
  for (const selector of selectors) {
    const normalized = normalizeRetrievalSelector(selector);
    const id = canonicalEvidenceKey(normalized) ?? retrievalSelectorId(normalized);
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(normalized);
  }
  return output;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function assertPositiveInteger(value: number, key: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
}

function locateSearchSnippet(text: string, snippet: string): { index: number; length: number } | null {
  const fragments = snippet
    .split(/(?:\.{3}|…)+/g)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= 12)
    .sort((a, b) => b.length - a.length);
  const candidates = fragments.length > 0 ? fragments : [snippet.trim()].filter((value) => value.length > 0);

  for (const fragment of candidates) {
    const index = text.toLowerCase().indexOf(fragment.toLowerCase());
    if (index >= 0) return { index, length: fragment.length };
  }

  const normalizedSnippet = normalizeText(snippet.replace(/(?:\.{3}|…)+/g, ' '));
  if (normalizedSnippet.length > 0 && normalizeText(text).includes(normalizedSnippet)) {
    return { index: 0, length: normalizedSnippet.length };
  }
  return null;
}

async function maybePersistRetrieveTrace(
  engine: BrainEngine,
  result: RetrieveContextResult,
  input: RetrieveContextInput,
): Promise<RetrieveContextResult> {
  if (!input.persist_trace) return result;
  return {
    ...result,
    trace: await persistRetrieveTrace(engine, result, input),
  };
}

async function persistRetrieveTrace(
  engine: BrainEngine,
  result: RetrieveContextResult,
  input: RetrieveContextInput,
): Promise<RetrievalTrace> {
  const thread = input.task_id ? await engine.getTaskThread(input.task_id) : null;
  const scope: ScopeGateScope = result.scope_gate?.resolved_scope ?? thread?.scope ?? 'unknown';
  const route = [
    'retrieve_context',
    ...result.required_reads.map((selector) => selector.kind),
  ];

  return engine.putRetrievalTrace({
    id: crypto.randomUUID(),
    task_id: thread ? input.task_id! : null,
    scope,
    route,
    source_refs: traceSourceRefs(result.required_reads),
    derived_consulted: result.orientation.derived_consulted,
    verification: [
      `scenario:${result.scenario}`,
      ...result.answerability.reason_codes.map((code) => `answerability:${code}`),
      ...buildScopeGateVerification(result.scope_gate),
      ...corpusLaneVerification(result.required_reads),
      ...buildGraphFrontierVerification(result),
      ...buildReadPlanVerification(result),
      ...buildCandidateSignalVerification(result),
    ],
    write_outcome: 'no_durable_write',
    selected_intent: intentFromScenario(result.scenario),
    scope_gate_policy: result.scope_gate?.policy ?? null,
    scope_gate_reason: result.scope_gate?.decision_reason ?? null,
    outcome: result.required_reads.length > 0
      ? 'retrieve_context selected canonical read candidates'
      : 'retrieve_context found no canonical read candidates',
  });
}

function traceSourceRefs(selectors: RetrievalSelector[]): string[] {
  return mergeSourceRefs(
    selectors.map(retrievalSelectorId),
    selectors.flatMap((selector) => selector.source_refs ?? []),
  );
}

function corpusLaneVerification(selectors: RetrievalSelector[]): string[] {
  return mergeSourceRefs(selectors.flatMap((selector) =>
    corpusLaneSourceRefs(selector.corpus_lane ?? corpusLaneFromSourceRefs(selector.source_refs ?? []))
      .filter((ref) => ref.startsWith('corpus_lane:'))
      .map((ref) => `${ref}:post_scope_metadata`)
  ));
}

function buildGraphFrontierVerification(result: RetrieveContextResult): string[] {
  const paths = result.orientation.graph_paths_considered ?? [];
  if (paths.length === 0) return [];
  return [
    `graph_frontier_paths_considered:${paths.length}`,
    'graph_frontier_authority:selector_planning_only',
  ];
}

function buildReadPlanVerification(result: RetrieveContextResult): string[] {
  return [
    `read_plan:${result.read_plan.mode}`,
    `read_plan_max_depth:${result.read_plan.max_depth}`,
    `read_plan_selected:${result.read_plan.selected_selectors.length}`,
    ...result.read_plan.gap_reasons.map((reason) => `read_plan_gap:${reason}`),
  ];
}

function intentFromScenario(scenario: RetrieveContextResult['scenario']): RetrievalRouteIntent {
  switch (scenario) {
    case 'coding_continuation':
      return 'task_resume';
    case 'personal_recall':
      return 'personal_profile_lookup';
    case 'mixed':
      return 'mixed_scope_bridge';
    case 'project_qa':
    case 'knowledge_qa':
    case 'auto_accumulation':
      return 'broad_synthesis';
  }
}

function buildScopeGateVerification(scopeGate: ScopeGateDecisionResult | undefined): string[] {
  if (!scopeGate) return [];
  return [
    `scope_gate:${scopeGate.policy}`,
    `scope_gate_reason:${scopeGate.decision_reason}`,
  ];
}

function buildCandidateSignalVerification(result: RetrieveContextResult): string[] {
  if (result.candidate_signals.length === 0) {
    return [`candidate_signal_policy:${result.candidate_signal_policy.mode}`];
  }
  return [
    `candidate_signal_policy:${result.candidate_signal_policy.mode}`,
    ...result.candidate_signals.map((signal) => `candidate_signal:${signal.candidate_id}`),
  ];
}
