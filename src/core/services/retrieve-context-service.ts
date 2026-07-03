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
  EvidenceSourceRefKind,
  RetrieveContextCandidate,
  RetrieveContextBackendGap,
  RetrieveContextGraphFrontierOptions,
  RetrieveContextInput,
  RetrieveContextOrientation,
  RetrieveContextReadPlan,
  RetrieveContextResult,
  RetrievalMatchedChunk,
  RetrievalRouteIntent,
  RetrievalRouteSelectorInput,
  RetrievalRouteSelectorResult,
  RetrievalTrace,
  RetrievalSelector,
  ScopeGateDecisionResult,
  ScopeGateScope,
  AnswerTrustFooter,
  AnswerTrustFooterExcludedSignal,
  SearchResult,
} from '../types.ts';
import { getBroadSynthesisRoute, type BroadSynthesisCandidateSearch } from './broad-synthesis-route-service.ts';
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
import { buildSelectorFirstPushContextEnvelope } from './selector-first-push-context-service.ts';
import { selectRetrievalRoute } from './retrieval-route-selector-service.ts';

export type RetrieveContextCandidateSearch = (
  query: string,
  options: { limit: number },
) => Promise<SearchResult[]>;

type CandidateSearchBackendGap =
  | 'retrieval_backend_partial_failure'
  | 'retrieval_backend_failed';

interface CandidateSearchFailure {
  query: string;
  original_query: boolean;
  message: string;
}

interface CandidateSearchPoolResult {
  results: SearchResult[];
  failures: CandidateSearchFailure[];
  total_queries: number;
  successful_queries: number;
}

interface RetrievalUsageStats {
  bySlug: Map<string, {
    count: number;
    latestAt: Date;
  }>;
}

interface TaskAffinityContext {
  taskId: string;
  haystack: string;
}

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
  broadSynthesisCandidateSearch?: BroadSynthesisCandidateSearch;
  candidateSignalBuilder?: RetrieveContextCandidateSignalBuilder;
  graphFrontierInputBuilder?: RetrieveContextGraphFrontierInputBuilder;
  graphFrontierPlanner?: RetrieveContextGraphFrontierPlanner;
  usageAwareRanking?: boolean;
  usageWindowDays?: number;
}

export async function buildProductionGraphFrontierInput(
  input: RetrieveContextGraphFrontierBuildInput,
): Promise<RetrieveContextGraphFrontierBuildResult> {
  const scopeId = input.required_reads.find((selector) => selector.scope_id)?.scope_id
    ?? (input.scope_gate?.resolved_scope === 'personal' ? 'personal:default' : DEFAULT_NOTE_MANIFEST_SCOPE_ID);
  const policyVersion = DEFAULT_GRAPH_FRONTIER_POLICY_VERSION;
  const seedSlugs = uniqueSlugs(input.candidates
    .map((candidate) => candidate.read_selector.slug ?? candidate.canonical_target.slug)
    .filter((slug): slug is string => Boolean(slug)))
    .slice(0, LINKED_CANDIDATE_SEED_LIMIT);
  if (seedSlugs.length === 0) {
    return { scope_id: scopeId, policy_version: policyVersion, seed_node_ids: [], nodes: [], edges: [] };
  }

  const allSlugs = new Set(seedSlugs);
  const edges: GraphFrontierEdge[] = [];
  let frontier = seedSlugs;
  for (let depth = 0; depth < 2 && frontier.length > 0; depth += 1) {
    const manifests = await loadManifestEntriesBySlug(input.engine, frontier);
    const explicitLinks = await explicitLinkedSlugsBySeed(input.engine, frontier);
    const next = new Set<string>();
    for (const slug of frontier) {
      const manifest = manifests.get(slugLookupKey(slug));
      const explicit = explicitLinks.get(slug);
      const linked = uniqueSlugs([
        ...(manifest?.outgoing_wikilinks ?? []),
        ...(explicit?.outgoing ?? []),
        ...(explicit?.incoming ?? []),
      ]).slice(0, 8);
      for (const target of linked) {
        edges.push(graphFrontierEdge('supports', slug, target, scopeId, policyVersion, `link:${slug}->${target}`));
        if (!allSlugs.has(target)) next.add(target);
        allSlugs.add(target);
      }
      const supersededBy = typeof manifest?.frontmatter.superseded_by === 'string'
        ? manifest.frontmatter.superseded_by.trim()
        : '';
      if (supersededBy) {
        edges.push(graphFrontierEdge('supersedes', slug, supersededBy, scopeId, policyVersion, `supersedes:${slug}->${supersededBy}`));
        if (!allSlugs.has(supersededBy)) next.add(supersededBy);
        allSlugs.add(supersededBy);
      }
    }
    frontier = [...next].slice(0, LINKED_CANDIDATE_SEED_LIMIT * 8);
  }

  const manifests = await loadManifestEntriesBySlug(input.engine, [...allSlugs]);
  const nodes: GraphFrontierNode[] = [...manifests.values()].map((manifest) => ({
    id: graphFrontierNodeId(manifest.slug),
    scope_id: scopeId,
    policy_version: policyVersion,
    selector: normalizeRetrievalSelector({
      kind: 'compiled_truth',
      scope_id: scopeId,
      slug: manifest.slug,
      path: manifest.path,
      freshness: 'unknown',
    }),
  }));
  const existingNodeIds = new Set(nodes.map((node) => node.id));

  return {
    scope_id: scopeId,
    policy_version: policyVersion,
    seed_node_ids: seedSlugs.map(graphFrontierNodeId).filter((id) => existingNodeIds.has(id)),
    nodes,
    edges: dedupeGraphFrontierEdges(edges).filter((edge) =>
      existingNodeIds.has(edge.from_node_id) && existingNodeIds.has(edge.to_node_id)
    ),
  };
}

function graphFrontierNodeId(slug: string): string {
  return `page:${slug}`;
}

function graphFrontierEdge(
  edgeType: GraphFrontierEdge['edge_type'],
  fromSlug: string,
  toSlug: string,
  scopeId: string,
  policyVersion: string,
  idPrefix: string,
): GraphFrontierEdge {
  return {
    id: `${idPrefix}`,
    edge_type: edgeType,
    from_node_id: graphFrontierNodeId(fromSlug),
    to_node_id: graphFrontierNodeId(toSlug),
    scope_id: scopeId,
    policy_version: policyVersion,
  };
}

function dedupeGraphFrontierEdges(edges: GraphFrontierEdge[]): GraphFrontierEdge[] {
  const seen = new Set<string>();
  const result: GraphFrontierEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.edge_type}:${edge.from_node_id}:${edge.to_node_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

const DEFAULT_CANDIDATE_LIMIT = 5;
const DEFAULT_READ_CONTEXT_MAX_SELECTORS = 3;
const TOKEN_BUDGET_CANDIDATE_DIVISOR = 600;
const TOKEN_BUDGET_READ_DIVISOR = 1200;
const TOKEN_BUDGET_ORIENTATION_FLOOR = 2000;
const READ_PLAN_MAX_DEPTH = 1;
const CANDIDATE_SELECTOR_BATCH_SIZE = 10;
const MAX_CANDIDATE_QUERY_VARIANTS = 8;
const CANDIDATE_RRF_K = 60;
const LINKED_CANDIDATE_SEED_LIMIT = 5;
const LINKED_CANDIDATE_PER_SEED_LIMIT = 4;
const MANIFEST_LOOKUP_BATCH_SIZE = 100;
const MANIFEST_LINK_SCAN_BATCH_SIZE = 500;
const SECTION_LOOKUP_BATCH_SIZE = 100;
const SECTION_SELECTOR_LOOKUP_LIMIT = 50;
// Backlink discovery is a fallback for seeds with no recorded links; cap the
// manifest scan so a large brain cannot turn one retrieval into a full-table
// sweep. Targets with fewer backlinks inside the cap simply get fewer.
const MANIFEST_LINK_SCAN_MAX_ROWS = 5_000;
const ALIAS_RESOLUTION_MANIFEST_LIMIT = 500;
const DEFAULT_USAGE_RANKING_WINDOW_DAYS = 90;
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

function candidateLimitForTokenBudget(requestedLimit: number, tokenBudget: number | undefined): number {
  if (tokenBudget === undefined) return requestedLimit;
  return Math.min(requestedLimit, Math.max(3, Math.floor(tokenBudget / TOKEN_BUDGET_CANDIDATE_DIVISOR)));
}

function requiredReadLimitForTokenBudget(candidateLimit: number, tokenBudget: number | undefined): number {
  if (tokenBudget === undefined) return Math.min(candidateLimit, DEFAULT_READ_CONTEXT_MAX_SELECTORS);
  return Math.min(
    candidateLimit,
    DEFAULT_READ_CONTEXT_MAX_SELECTORS,
    Math.max(1, Math.floor(tokenBudget / TOKEN_BUDGET_READ_DIVISOR)),
  );
}

function shouldIncludeOrientation(input: RetrieveContextInput): boolean {
  if (input.include_orientation === false) return false;
  return input.token_budget === undefined || input.token_budget >= TOKEN_BUDGET_ORIENTATION_FLOOR;
}

export async function retrieveContext(
  engine: BrainEngine,
  input: RetrieveContextInput,
  dependencies: RetrieveContextDependencies = {},
): Promise<RetrieveContextResult> {
  const startedAtMs = Date.now();
  const requestedLimit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
  assertPositiveInteger(requestedLimit, 'limit');
  if (input.token_budget !== undefined) assertPositiveInteger(input.token_budget, 'token_budget');
  const limit = candidateLimitForTokenBudget(requestedLimit, input.token_budget);
  const requiredReadLimit = requiredReadLimitForTokenBudget(limit, input.token_budget);
  const includeOrientation = shouldIncludeOrientation(input);

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
      startedAtMs,
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
    const createSafety = buildCreateSafety(candidates, requiredReads, { selector_existence_verified: false });
    const decoratedCandidates = withCandidateResultMetadata(candidates, createSafety);

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
      candidates: decoratedCandidates,
      required_reads: requiredReads,
      create_safety: createSafety,
      read_plan: buildReadPlan({
        candidates: decoratedCandidates,
        required_reads: requiredReads,
        orientation,
        candidate_signals: candidateSignals,
        required_read_limit: requiredReadLimit,
      }),
      orientation,
      ...candidateSignals,
      warnings: ['Exact selector supplied; call read_context for canonical evidence.'],
    }, input, startedAtMs);
  }

  const taskWorkingSetSelector = input.task_id
    ? normalizeRetrievalSelector({
      kind: 'task_working_set',
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      object_id: input.task_id,
      freshness: 'current',
    })
    : null;
  const taskCandidate = taskWorkingSetSelector ? candidateFromSelector(taskWorkingSetSelector, 1) : null;
  const taskAffinity = input.task_id
    ? await buildTaskAffinityContext(engine, input.task_id)
    : undefined;

  const query = input.query?.trim() ?? '';
  const searchLimit = query.length > 0 ? sourceRankCandidateLimit(limit) : 0;
  const candidateSearch = dependencies.candidateSearch ?? ((candidateQuery, options) =>
    engine.searchKeyword(candidateQuery, { limit: options.limit }));
  // Orientation only depends on the query, not on the candidate search
  // results, so both run concurrently.
  const [candidatePool, orientation] = await Promise.all([
    query.length > 0
      ? searchCandidatePool(engine, candidateSearch, query, searchLimit, input.known_subjects)
      : Promise.resolve(emptyCandidateSearchPool()),
    !includeOrientation || query.length === 0
      ? Promise.resolve(emptyOrientation())
      : buildOrientation(engine, query, limit, dependencies.broadSynthesisCandidateSearch),
  ]);
  const searchResults = rankSearchResults(candidatePool.results);
  const candidates = await groupCandidatesByCanonicalPage(
    engine,
    searchResults,
    limit,
    query,
    scopeGate,
    repoBasename(input.repo_path),
    dependencies,
    taskAffinity,
  );
  const combinedCandidates = taskCandidate
    ? [taskCandidate, ...candidates]
    : candidates;
  const route = await maybeSelectAutoRoute(engine, input, {
    scenario: classification.scenario,
    query,
    limit,
    scopeGate,
    dependencies,
  });
  const orientationReadsCompeted = shouldApplyOrientationReadsToRequiredReads(classification.scenario);
  const baseRequiredReads = selectRequiredReadSelectors({
    taskWorkingSetSelector,
    routeSelectors: requiredReadSelectorsFromAutoRoute(route),
    candidates,
    orientation,
    scopeGate,
    requiredReadLimit,
    includeOrientationReads: orientationReadsCompeted,
  });
  const graphAugmentation = await maybeAugmentRequiredReadsWithGraphFrontier(engine, input, dependencies, {
    query,
    limit,
    candidates: combinedCandidates,
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
    combinedCandidates,
    limit,
  );

  const backendGapReason = candidateSearchBackendGap(candidatePool);
  const backendGap = buildBackendGap(candidatePool);
  const createSafety = buildCreateSafety(candidates, requiredReads, {
    candidate_signals: candidateSignals.candidate_signals,
    candidate_signal_policy: candidateSignals.candidate_signal_policy,
    canonical_probe_completed: query.length > 0 && !backendGapReason,
  });
  const graphFrontierUsed = graphAugmentation.orientation.derived_consulted.includes('graph_frontier');
  const decoratedCandidates = withCandidateResultMetadata(combinedCandidates, createSafety, {
    backend_gap: backendGap,
    graph_frontier_authority: graphFrontierUsed ? 'selector_planning_only' : undefined,
  });
  return maybePersistRetrieveTrace(engine, {
    request_id: requestId,
    scenario: classification.scenario,
    scope_gate: scopeGate,
    route,
    answerability: {
      answerable_from_probe: false,
      allowed_probe_answer_kind: 'none',
      must_read_context: requiredReads.length > 0,
      reason_codes: broadRetrievalReasonCodes(requiredReads, candidateSignals, backendGapReason),
    },
    candidates: decoratedCandidates,
    required_reads: requiredReads,
    create_safety: createSafety,
    read_plan: buildReadPlan({
      candidates: decoratedCandidates,
      required_reads: requiredReads,
      orientation: graphAugmentation.orientation,
      candidate_signals: candidateSignals,
      required_read_limit: requiredReadLimit,
      orientation_reads_competed: orientationReadsCompeted,
      backend_gap_reason: backendGapReason,
      backend_gap: backendGap,
    }),
    orientation: graphAugmentation.orientation,
    ...candidateSignals,
    warnings: [
      ...candidateSearchWarnings(candidatePool),
      ...(searchResults.length > 0 ? [SEARCH_CHUNK_WARNING] : []),
      ...graphAugmentation.warnings,
      ...(taskWorkingSetSelector ? ['Task continuation includes task working set and normal search; read task state before acting on raw files.'] : []),
      ...(requiredReads.length === 0 && candidateSignals.candidate_signals.length > 0
        ? ['No canonical read candidate was found; non-canonical Memory Inbox candidate signals are available.']
        : []),
      ...(requiredReads.length === 0 && candidateSignals.candidate_signals.length === 0
        ? ['No canonical read candidate was found.']
        : []),
    ],
  }, input, startedAtMs);
}

async function maybeSelectAutoRoute(
  engine: BrainEngine,
  input: RetrieveContextInput,
  context: {
    scenario: MemoryScenario;
    query: string;
    limit: number;
    scopeGate?: ScopeGateDecisionResult;
    dependencies: RetrieveContextDependencies;
  },
): Promise<RetrievalRouteSelectorResult | null> {
  if (input.auto_route === false) return null;
  const routeInput = buildAutoRouteInput(input, context);
  if (!routeInput) return null;
  if (!engineSupportsAutoRoute(engine, routeInput.intent)) return null;
  return selectRetrievalRoute(engine, routeInput, {
    ...(context.dependencies.broadSynthesisCandidateSearch
      ? { broadSynthesis: { candidateSearch: context.dependencies.broadSynthesisCandidateSearch } }
      : {}),
  });
}

function engineSupportsAutoRoute(engine: BrainEngine, intent: RetrievalRouteIntent): boolean {
  switch (intent) {
  case 'broad_synthesis':
    return typeof engine.listContextMapEntries === 'function';
  case 'mixed_scope_bridge':
    return typeof engine.listContextMapEntries === 'function'
      && typeof engine.listProfileMemoryEntries === 'function'
      && typeof engine.listPersonalEpisodeEntries === 'function';
  case 'personal_profile_lookup':
    return typeof engine.listProfileMemoryEntries === 'function';
  case 'personal_episode_lookup':
    return typeof engine.listPersonalEpisodeEntries === 'function';
  case 'task_resume':
    return typeof engine.getTaskThread === 'function';
  case 'precision_lookup':
    return true;
  }
}

function buildAutoRouteInput(
  input: RetrieveContextInput,
  context: {
    scenario: MemoryScenario;
    query: string;
    limit: number;
    scopeGate?: ScopeGateDecisionResult;
  },
): RetrievalRouteSelectorInput | null {
  if (context.query.length === 0 && !input.task_id) return null;
  const intent = intentFromScenario(context.scenario);
  if (intent === 'task_resume' && !input.task_id) {
    return null;
  }
  if (intent === 'personal_profile_lookup') {
    const subject = firstKnownSubjectRef(input.known_subjects) ?? context.query;
    if (!subject.trim()) return null;
    return {
      intent,
      query: context.query,
      subject,
      limit: context.limit,
      requested_scope: normalizedRouteScope(input.requested_scope ?? 'personal'),
      persist_trace: false,
    };
  }
  if (intent === 'mixed_scope_bridge') {
    return {
      intent,
      query: context.query,
      limit: context.limit,
      requested_scope: normalizedRouteScope(input.requested_scope ?? context.scopeGate?.resolved_scope),
      subject: firstKnownSubjectRef(input.known_subjects),
      persist_trace: false,
    };
  }
  return {
    intent,
    task_id: input.task_id,
    query: context.query,
    limit: context.limit,
    requested_scope: normalizedRouteScope(input.requested_scope ?? context.scopeGate?.resolved_scope),
    persist_trace: false,
  };
}

function firstKnownSubjectRef(subjects: RetrieveContextInput['known_subjects']): string | undefined {
  for (const subject of subjects ?? []) {
    if (typeof subject === 'string') {
      const value = subject.trim();
      if (value.length > 0) return value;
      continue;
    }
    const value = subject.ref.trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

function normalizedRouteScope(scope: ScopeGateScope | undefined): RetrievalRouteSelectorInput['requested_scope'] {
  return scope === 'work' || scope === 'personal' || scope === 'mixed' ? scope : undefined;
}

function selectRequiredReadSelectors(input: {
  taskWorkingSetSelector: RetrievalSelector | null;
  routeSelectors: RetrievalSelector[];
  candidates: RetrieveContextCandidate[];
  orientation: RetrieveContextOrientation;
  scopeGate?: ScopeGateDecisionResult;
  requiredReadLimit: number;
  includeOrientationReads: boolean;
}): RetrievalSelector[] {
  const pinnedSelectors = input.taskWorkingSetSelector
    ? [input.taskWorkingSetSelector]
    : [];
  const candidateSelectors = input.candidates.map((candidate) => candidate.read_selector);
  const orientationSelectors = input.includeOrientationReads ? input.orientation.recommended_reads : [];
  return dedupeSelectorsByEvidence([
    ...pinnedSelectors,
    ...input.routeSelectors,
    ...interleaveSelectors(candidateSelectors, orientationSelectors),
  ].filter((selector) => selectorAllowedByRetrieveScope(selector, input.scopeGate))).slice(0, input.requiredReadLimit);
}

function requiredReadSelectorsFromAutoRoute(routeResult: RetrievalRouteSelectorResult | null): RetrievalSelector[] {
  const route = routeResult?.route;
  if (!route) return [];

  switch (route.route_kind) {
  case 'personal_profile_lookup':
    return [normalizeRetrievalSelector({
      kind: 'profile_memory',
      scope_id: route.payload.scope_id,
      object_id: route.payload.profile_memory_id,
      freshness: 'current',
      source_refs: route.payload.source_refs,
    })];
  case 'personal_episode_lookup':
    return [normalizeRetrievalSelector({
      kind: 'personal_episode',
      scope_id: route.payload.scope_id,
      object_id: route.payload.personal_episode_id,
      freshness: 'current',
      source_refs: route.payload.source_refs,
    })];
  case 'precision_lookup':
    return route.payload.recommended_reads.map(selectorFromRouteReadLike);
  case 'mixed_scope_bridge':
    return [
      ...requiredReadSelectorsFromPersonalRoute(route.payload.personal_route),
      ...route.payload.work_route.recommended_reads.map(selectorFromRouteReadLike),
    ];
  case 'broad_synthesis':
  case 'task_resume':
    return [];
  }
}

function requiredReadSelectorsFromPersonalRoute(
  route: Extract<NonNullable<RetrievalRouteSelectorResult['route']>, { route_kind: 'mixed_scope_bridge' }>['payload']['personal_route'],
): RetrievalSelector[] {
  if (route.route_kind === 'personal_profile_lookup') {
    return [normalizeRetrievalSelector({
      kind: 'profile_memory',
      scope_id: route.scope_id,
      object_id: route.profile_memory_id,
      freshness: 'current',
      source_refs: route.source_refs,
    })];
  }
  return [normalizeRetrievalSelector({
    kind: 'personal_episode',
    scope_id: route.scope_id,
    object_id: route.personal_episode_id,
    freshness: 'current',
    source_refs: route.source_refs,
  })];
}

function selectorFromRouteReadLike(read: {
  node_kind: 'page' | 'section';
  page_slug: string;
  path: string;
  section_id?: string;
}): RetrievalSelector {
  return normalizeRetrievalSelector({
    kind: read.node_kind === 'section' ? 'section' : 'page',
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    slug: read.page_slug,
    path: read.path,
    section_id: read.section_id,
    freshness: 'unknown',
  });
}

function shouldApplyOrientationReadsToRequiredReads(scenario: MemoryScenario): boolean {
  return scenario === 'project_qa'
    || scenario === 'knowledge_qa'
    || scenario === 'auto_accumulation'
    || scenario === 'mixed';
}

function interleaveSelectors(
  primarySelectors: RetrievalSelector[],
  secondarySelectors: RetrievalSelector[],
): RetrievalSelector[] {
  const selectors: RetrievalSelector[] = [];
  const maxLength = Math.max(primarySelectors.length, secondarySelectors.length);
  for (let index = 0; index < maxLength; index += 1) {
    const primary = primarySelectors[index];
    if (primary) selectors.push(primary);
    const secondary = secondarySelectors[index];
    if (secondary) selectors.push(secondary);
  }
  return selectors;
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
    create_safety: buildCreateSafety([], []),
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
  backendGapReason?: CandidateSearchBackendGap,
): string[] {
  const reasonCodes = requiredReads.length > 0
    ? ['probe_candidates_are_not_answer_ground']
    : candidateSignals.candidate_signals.length > 0
      ? ['no_canonical_evidence_candidate_signals_present']
      : ['no_candidate'];
  if (!backendGapReason) return reasonCodes;
  if (backendGapReason === 'retrieval_backend_failed' && reasonCodes[0] === 'no_candidate') {
    return ['retrieval_backend_failed'];
  }
  return [...reasonCodes, backendGapReason];
}

async function searchCandidatePool(
  engine: BrainEngine,
  candidateSearch: RetrieveContextCandidateSearch,
  query: string,
  limit: number,
  knownSubjects?: RetrieveContextInput['known_subjects'],
): Promise<CandidateSearchPoolResult> {
  const queries = await candidateSearchQueries(engine, query, knownSubjects);
  const settled = await Promise.allSettled(
    queries.map((candidateQuery) => candidateSearch(candidateQuery, { limit })),
  );
  const failures = settled.flatMap((result, index): CandidateSearchFailure[] => (
    result.status === 'rejected'
      ? [{
        query: queries[index]!,
        original_query: index === 0,
        message: errorMessage(result.reason),
      }]
      : []
  ));
  const resultLists = settled.flatMap((result) => (
    result.status === 'fulfilled' ? [result.value] : []
  ));
  const successfulQueries = settled.length - failures.length;
  const results = resultLists.length === 0
    ? []
    : resultLists.length === 1
      ? resultLists[0]!
      : fuseCandidateSearchResults(resultLists);
  return {
    results,
    failures,
    total_queries: queries.length,
    successful_queries: successfulQueries,
  };
}

function emptyCandidateSearchPool(): CandidateSearchPoolResult {
  return {
    results: [],
    failures: [],
    total_queries: 0,
    successful_queries: 0,
  };
}

function candidateSearchBackendGap(pool: CandidateSearchPoolResult): CandidateSearchBackendGap | undefined {
  if (pool.failures.length === 0) return undefined;
  return pool.successful_queries === 0
    ? 'retrieval_backend_failed'
    : 'retrieval_backend_partial_failure';
}

function buildBackendGap(pool: CandidateSearchPoolResult): RetrieveContextBackendGap | undefined {
  const reasonCode = candidateSearchBackendGap(pool);
  if (!reasonCode) return undefined;
  return {
    status: reasonCode === 'retrieval_backend_failed' ? 'failed' : 'partial_failure',
    reason_code: reasonCode,
    failed_query_count: pool.failures.length,
    successful_query_count: pool.successful_queries,
    total_query_count: pool.total_queries,
    failure_messages: [...new Set(pool.failures.map((failure) => failure.message))].slice(0, 3),
  };
}

function candidateSearchWarnings(pool: CandidateSearchPoolResult): string[] {
  const gap = candidateSearchBackendGap(pool);
  if (!gap) return [];
  const firstFailure = pool.failures[0];
  const firstFailureDetail = firstFailure
    ? ` First failure${firstFailure.original_query ? ' on original query' : ''}: ${firstFailure.message}.`
    : '';
  const suffix = gap === 'retrieval_backend_failed'
    ? 'No fallback query variant succeeded; do not treat this as absence of memory.'
    : 'Continuing with successful fallback query variants; results may be incomplete.';
  return [
    `Candidate search failed for ${pool.failures.length} of ${pool.total_queries} query variant${pool.total_queries === 1 ? '' : 's'}. ${suffix}${firstFailureDetail}`,
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : String(error);
}

async function candidateSearchQueries(
  engine: BrainEngine,
  query: string,
  knownSubjects?: RetrieveContextInput['known_subjects'],
): Promise<string[]> {
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
  for (const subject of (knownSubjects ?? []).slice(0, 3)) {
    addVariant(knownSubjectRef(subject));
  }

  for (const variant of await deterministicAliasQueryVariants(engine, query)) {
    addVariant(variant);
    if (variants.length >= MAX_CANDIDATE_QUERY_VARIANTS) break;
  }

  return variants;
}

async function deterministicAliasQueryVariants(engine: BrainEngine, query: string): Promise<string[]> {
  if (typeof engine.listNoteManifestEntries !== 'function') return [];
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];
  const queryTokens = new Set(tokenizeForSectionRank(query));
  try {
    const manifests = await engine.listNoteManifestEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      limit: ALIAS_RESOLUTION_MANIFEST_LIMIT,
      offset: 0,
    });
    const variants: string[] = [];
    const addVariant = (value: string | undefined) => {
      const normalized = value?.trim();
      if (!normalized) return;
      if (variants.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) return;
      variants.push(normalized);
    };

    for (const manifest of manifests) {
      const aliases = uniqueStrings([
        ...manifest.aliases,
        ...(typeof manifest.frontmatter.alias === 'string' ? [manifest.frontmatter.alias] : []),
      ]);
      if (!aliases.some((alias) => aliasMatchesQuery(alias, normalizedQuery, queryTokens))) continue;
      addVariant(manifest.title);
      addVariant(manifest.slug);
      for (const alias of aliases) addVariant(alias);
      if (variants.length >= MAX_CANDIDATE_QUERY_VARIANTS) break;
    }
    return variants;
  } catch {
    return [];
  }
}

function aliasMatchesQuery(alias: string, normalizedQuery: string, queryTokens: Set<string>): boolean {
  const normalizedAlias = normalizeText(alias);
  if (!normalizedAlias) return false;
  if (queryTokens.has(normalizedAlias)) return true;
  if (normalizedAlias.length <= 3) return normalizedQuery === normalizedAlias;
  return normalizedQuery.includes(normalizedAlias);
}

function knownSubjectRef(subject: string | { ref: string }): string {
  return typeof subject === 'string' ? subject : subject.ref;
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
  repoContext?: string,
  dependencies: RetrieveContextDependencies = {},
  taskAffinity?: TaskAffinityContext,
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
  const sectionsBySlug = await loadSectionEntriesBySlug(
    engine,
    groupedResults.map((group) => group.slug),
  );
  const resolvedCandidates: RetrieveContextCandidate[] = [];
  for (let index = 0; index < groupedResults.length; index += CANDIDATE_SELECTOR_BATCH_SIZE) {
    const batch = groupedResults.slice(index, index + CANDIDATE_SELECTOR_BATCH_SIZE);
    const resolved = await Promise.all(batch.map((group) =>
      resolveCandidateGroup(
        engine,
        group,
        query,
        manifestBySlug.get(slugLookupKey(group.slug)),
        sectionsBySlug.get(slugLookupKey(group.slug)) ?? [],
        repoContext,
        normalizedSearchRankScore(group.rank),
      )));
    resolvedCandidates.push(...resolved);
  }

  const usageStats = await loadRetrievalUsageStatsForRanking(engine, dependencies);
  const usageDecoratedCandidates = applyUsageSignalsToCandidates(
    applyTaskAffinitySignalsToCandidates(resolvedCandidates, taskAffinity),
    usageStats,
  );
  const rankedBaseCandidates = rankResolvedCandidates(usageDecoratedCandidates, query, usageStats);
  const linkedCandidates = await linkedCandidatesForResolvedCandidates(
    engine,
    rankedBaseCandidates,
    query,
    limit,
    scopeGate,
    manifestBySlug,
  );
  const rankedCandidates = rankResolvedCandidates(
    applyUsageSignalsToCandidates(
      applyTaskAffinitySignalsToCandidates([...rankedBaseCandidates, ...linkedCandidates], taskAffinity),
      usageStats,
    ),
    query,
    usageStats,
  );
  const candidates: RetrieveContextCandidate[] = [];
  const seenCanonicalEvidence = new Set<string>();
  for (const candidate of rankedCandidates) {
    if (!selectorAllowedByRetrieveScope(candidate.read_selector, scopeGate)) continue;
    const evidenceKey = canonicalEvidenceKey(candidate.read_selector);
    if (evidenceKey && seenCanonicalEvidence.has(evidenceKey)) continue;
    if (evidenceKey) seenCanonicalEvidence.add(evidenceKey);
    const readPriority = candidates.length + 1;
    candidates.push({
      ...candidate,
      read_priority: readPriority,
      evidence_metadata: buildCandidateEvidenceMetadata({
        ...candidate,
        read_priority: readPriority,
      }, scopeGate),
    });
    if (candidates.length >= limit) break;
  }

  return candidates;
}

function rankResolvedCandidates(
  candidates: RetrieveContextCandidate[],
  query: string,
  usageStats?: RetrievalUsageStats,
): RetrieveContextCandidate[] {
  const queryTokens = tokenizeForSectionRank(query);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: scoreResolvedCandidate(candidate, queryTokens, usageStats),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((entry) => entry.candidate);
}

function scoreResolvedCandidate(
  candidate: RetrieveContextCandidate,
  queryTokens: string[],
  usageStats?: RetrievalUsageStats,
): number {
  const title = normalizeText(candidate.canonical_target.title ?? '');
  const path = normalizeText(candidate.canonical_target.path ?? '');
  const sectionId = normalizeText(candidate.canonical_target.section_id ?? '');
  const targetText = `${title} ${path} ${sectionId}`;
  const matchedChunkText = normalizeText(candidate.matched_chunks
    .map((chunk) => `${chunk.title} ${chunk.slug}`)
    .join(' '));
  let score = Math.max(0, ...candidate.matched_chunks.map(normalizedMatchedChunkScore)) * 100;
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
  if (candidate.why_matched.some((reason) => reason.startsWith('repo_path matched '))) score += 10;
  if (candidate.why_matched.some((reason) => reason.startsWith('task_id affinity matched '))) score += 8;
  score += usageRankBonus(candidate, usageStats);
  if (candidate.read_selector.freshness === 'stale') score -= 8;

  return score;
}

async function buildTaskAffinityContext(
  engine: BrainEngine,
  taskId: string,
): Promise<TaskAffinityContext | undefined> {
  try {
    const [thread, workingSet, attempts, decisions] = await Promise.all([
      engine.getTaskThread(taskId).catch(() => null),
      engine.getTaskWorkingSet(taskId).catch(() => null),
      engine.listTaskAttempts(taskId, { limit: 20 }).catch(() => []),
      engine.listTaskDecisions(taskId, { limit: 20 }).catch(() => []),
    ]);
    const parts = [
      thread?.title,
      thread?.goal,
      thread?.repo_path ?? undefined,
      thread?.branch_name ?? undefined,
      thread?.current_summary,
      ...(workingSet?.active_paths ?? []),
      ...(workingSet?.active_symbols ?? []),
      ...(workingSet?.blockers ?? []),
      ...(workingSet?.open_questions ?? []),
      ...(workingSet?.next_steps ?? []),
      ...(workingSet?.verification_notes ?? []),
      ...attempts.flatMap((attempt) => [
        attempt.summary,
        ...attempt.evidence,
        JSON.stringify(attempt.applicability_context ?? {}),
      ]),
      ...decisions.flatMap((decision) => [
        decision.summary,
        decision.rationale,
        ...decision.consequences,
        JSON.stringify(decision.validity_context ?? {}),
      ]),
    ];
    const haystack = normalizeText(parts.filter((part): part is string => Boolean(part && part.trim())).join('\n'));
    return haystack ? { taskId, haystack } : undefined;
  } catch {
    return undefined;
  }
}

function applyTaskAffinitySignalsToCandidates(
  candidates: RetrieveContextCandidate[],
  taskAffinity?: TaskAffinityContext,
): RetrieveContextCandidate[] {
  if (!taskAffinity) return candidates;
  return candidates.map((candidate) => {
    if (!candidateMatchesTaskAffinity(candidate, taskAffinity)) return candidate;
    const reason = `task_id affinity matched ${taskAffinity.taskId}`;
    if (candidate.why_matched.includes(reason)) return candidate;
    return {
      ...candidate,
      why_matched: [...candidate.why_matched, reason],
    };
  });
}

function candidateMatchesTaskAffinity(
  candidate: RetrieveContextCandidate,
  taskAffinity: TaskAffinityContext,
): boolean {
  const values = [
    candidate.canonical_target.slug,
    candidate.canonical_target.title,
    candidate.canonical_target.path,
    candidate.read_selector.slug,
    candidate.read_selector.path,
    ...candidate.matched_chunks.flatMap((chunk) => [chunk.slug, chunk.title]),
  ];
  return values.some((value) => {
    const normalized = normalizeText(value ?? '');
    return normalized.length > 0 && taskAffinity.haystack.includes(normalized);
  });
}

async function loadRetrievalUsageStatsForRanking(
  engine: BrainEngine,
  dependencies: RetrieveContextDependencies,
): Promise<RetrievalUsageStats | undefined> {
  if (!dependencies.usageAwareRanking || typeof engine.listRetrievalTracesByWindow !== 'function') {
    return undefined;
  }

  const until = new Date();
  const since = new Date(until.getTime() - (dependencies.usageWindowDays ?? DEFAULT_USAGE_RANKING_WINDOW_DAYS) * 24 * 60 * 60 * 1000);
  const traces = await engine.listRetrievalTracesByWindow({
    since,
    until,
    limit: 1_000,
  });
  const bySlug = new Map<string, { count: number; latestAt: Date }>();

  for (const trace of traces) {
    const traceSlugs = uniqueStrings(trace.source_refs
      .map(slugFromRetrievalTraceSourceRef)
      .filter((slug): slug is string => Boolean(slug)));
    for (const slug of traceSlugs) {
      const current = bySlug.get(slug);
      if (!current) {
        bySlug.set(slug, { count: 1, latestAt: trace.created_at });
        continue;
      }
      current.count += 1;
      if (trace.created_at > current.latestAt) current.latestAt = trace.created_at;
    }
  }

  return { bySlug };
}

function applyUsageSignalsToCandidates(
  candidates: RetrieveContextCandidate[],
  usageStats?: RetrievalUsageStats,
): RetrieveContextCandidate[] {
  if (!usageStats) return candidates;
  return candidates.map((candidate) => {
    const slug = candidate.canonical_target.slug ?? candidate.read_selector.slug;
    if (!slug) return candidate;
    const usage = usageStats.bySlug.get(slug);
    const reason = usage
      ? `usage-aware ranking: ${usage.count} recent retrieval trace${usage.count === 1 ? '' : 's'}`
      : 'cold page: no recent retrieval trace usage';
    if (candidate.why_matched.includes(reason)) return candidate;
    return {
      ...candidate,
      why_matched: [...candidate.why_matched, reason],
    };
  });
}

function usageRankBonus(candidate: RetrieveContextCandidate, usageStats?: RetrievalUsageStats): number {
  if (!usageStats) return 0;
  const slug = candidate.canonical_target.slug ?? candidate.read_selector.slug;
  if (!slug) return 0;
  const usage = usageStats.bySlug.get(slug);
  if (!usage) return 0;
  const ageDays = Math.max(0, (Date.now() - usage.latestAt.getTime()) / (24 * 60 * 60 * 1000));
  const recencyBonus = ageDays <= 7 ? 4 : ageDays <= 30 ? 2 : 0;
  return Math.min(12, usage.count * 3) + recencyBonus;
}

function slugFromRetrievalTraceSourceRef(sourceRef: string): string | undefined {
  const ref = sourceRef.split('@chars:')[0]!;
  const parts = ref.split(':');
  const kind = parts[0];
  if (
    (kind === 'page' || kind === 'compiled_truth' || kind === 'frontmatter' || kind === 'timeline_range')
    && parts.length >= 4
  ) {
    return parts.slice(3).join(':');
  }
  if (kind === 'line_span' && parts.length >= 6) {
    return parts.slice(3, -2).join(':');
  }
  return undefined;
}

async function resolveCandidateGroup(
  engine: BrainEngine,
  group: { slug: string; results: SearchResult[]; top: SearchResult; rank: number },
  query: string,
  manifest?: NoteManifestEntry,
  sections?: NoteSectionEntry[],
  repoContext?: string,
  searchRankScore?: number,
): Promise<RetrieveContextCandidate> {
  const readResult = bestTimelineSearchResult(group.results) ?? group.top;
  const selector = await bestReadSelectorForSearchResult(engine, readResult, query, sections, manifest?.content_hash);
  const manifestCorpusLane = manifest
    ? corpusLaneForManifest(manifest)
    : await corpusLaneForPage(engine, group.slug);
  const corpusLane = selector.corpus_lane
    ?? corpusLaneFromSourceRefs(selector.source_refs ?? [])
    ?? manifestCorpusLane;
  const readSelector = corpusLane
    ? normalizeRetrievalSelector({ ...selector, corpus_lane: corpusLane })
    : selector;

  const whyMatched = [`matched ${group.results.length} search chunk${group.results.length === 1 ? '' : 's'}`];
  if (repoContext && candidateMatchesRepoContext(group.slug, manifest, repoContext)) {
    whyMatched.push(`repo_path matched ${repoContext}`);
  }

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
    matched_chunks: group.results.map((result) => toMatchedChunk(result, corpusLane, searchRankScore)),
    why_matched: whyMatched,
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

  const sectionsBySlug = await loadSectionEntriesBySlug(
    engine,
    selected.map(({ manifest }) => manifest.slug),
  );

  return Promise.all(selected.map(({ seedSlug, manifest }) =>
    candidateFromLinkedManifest(
      engine,
      manifest,
      seedSlug,
      query,
      sectionsBySlug.get(slugLookupKey(manifest.slug)) ?? [],
    )));
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

async function loadSectionEntriesBySlug(
  engine: BrainEngine,
  slugs: string[],
): Promise<Map<string, NoteSectionEntry[]>> {
  const unique = uniqueSlugs(slugs);
  const sectionsBySlug = new Map<string, NoteSectionEntry[]>(
    unique.map((slug) => [slugLookupKey(slug), []]),
  );
  if (unique.length === 0) return sectionsBySlug;

  for (let index = 0; index < unique.length; index += SECTION_LOOKUP_BATCH_SIZE) {
    const batchSlugs = unique.slice(index, index + SECTION_LOOKUP_BATCH_SIZE);
    const sections = await engine.listNoteSectionEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      page_slugs: batchSlugs,
      limit: batchSlugs.length * SECTION_SELECTOR_LOOKUP_LIMIT,
      per_page_limit: SECTION_SELECTOR_LOOKUP_LIMIT,
    });
    for (const section of sections) {
      const sectionKey = slugLookupKey(section.page_slug);
      const existing = sectionsBySlug.get(sectionKey);
      if (!existing || existing.length >= SECTION_SELECTOR_LOOKUP_LIMIT) continue;
      existing.push(section);
    }
  }

  return sectionsBySlug;
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

function repoBasename(repoPath: string | null | undefined): string | undefined {
  const normalized = repoPath?.trim().replace(/[\\/]+$/, '');
  if (!normalized) return undefined;
  return normalized.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
}

function candidateMatchesRepoContext(
  slug: string,
  manifest: NoteManifestEntry | undefined,
  repoContext: string,
): boolean {
  const frontmatter = manifest?.frontmatter ?? {};
  const repoValues = [
    stringFrontmatterValue(frontmatter.repo),
    stringFrontmatterValue(frontmatter.repo_path),
  ].filter((value): value is string => Boolean(value));
  if (repoValues.some((value) => repoBasename(value) === repoContext || value.toLowerCase() === repoContext)) {
    return true;
  }

  const slugSegments = slugLookupKey(slug).split(/[/.]/).filter(Boolean);
  const systemsOrProjectsIndex = slugSegments.findIndex((segment) => (
    segment === 'systems' || segment === 'projects'
  ));
  if (systemsOrProjectsIndex < 0) return false;
  return slugSegments.slice(systemsOrProjectsIndex + 1).some((segment) => segment === repoContext);
}

function stringFrontmatterValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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
  sections?: NoteSectionEntry[],
): Promise<RetrieveContextCandidate> {
  const selector = await bestReadSelectorForLinkedManifest(engine, manifest, query, sections);
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
  sections?: NoteSectionEntry[],
): Promise<RetrievalSelector> {
  const candidateSections = sections ?? await engine.listNoteSectionEntries({
    scope_id: manifest.scope_id,
    page_slug: manifest.slug,
    limit: SECTION_SELECTOR_LOOKUP_LIMIT,
  });
  const queryTokens = tokenizeForSectionRank(query);
  const rankedSection = candidateSections
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
      content_hash: manifest.content_hash,
      freshness: 'current',
    });
  }

  return normalizeRetrievalSelector({
    kind: 'compiled_truth',
    scope_id: manifest.scope_id,
    slug: manifest.slug,
    path: manifest.path,
    source_refs: manifest.source_refs,
    content_hash: manifest.content_hash,
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
  sections?: NoteSectionEntry[],
  pageContentHash?: string,
): Promise<RetrievalSelector> {
  if (result.chunk_source === 'timeline') {
    const contentHash = pageContentHash
      ?? (await engine.getPageProjection(result.slug))?.content_hash;
    return normalizeRetrievalSelector({
      ...selectorFromSearchResult(result),
      content_hash: contentHash,
    });
  }
  if (result.chunk_source === 'frontmatter') {
    const contentHash = pageContentHash
      ?? (await engine.getPageProjection(result.slug))?.content_hash;
    return normalizeRetrievalSelector({
      ...selectorFromSearchResult(result),
      content_hash: contentHash,
    });
  }

  const candidateSections = sections ?? await engine.listNoteSectionEntries({
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    page_slug: result.slug,
    limit: SECTION_SELECTOR_LOOKUP_LIMIT,
  });
  const matchingSection = bestSectionForSearchResult(candidateSections, result, query);

  if (matchingSection) {
    const charStart = matchingSection.match && matchingSection.match.index > 0
      ? Math.max(0, matchingSection.match.index - SEARCH_HIT_CONTEXT_CHARS)
      : undefined;
    const contentHash = pageContentHash
      ?? (await engine.getPageProjection(result.slug))?.content_hash;
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
      content_hash: contentHash,
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
  candidateSearch?: BroadSynthesisCandidateSearch,
): Promise<RetrieveContextOrientation> {
  const routeResult = await getBroadSynthesisRoute(
    engine,
    { query, limit },
    candidateSearch ? { candidateSearch } : {},
  );
  if (!routeResult.route) return emptyOrientation();

  return {
    derived_consulted: [`context_map:${routeResult.route.map_id}`],
    recommended_reads: routeResult.route.recommended_reads.map(selectorFromRouteRead),
    summary_lines: routeResult.route.summary_lines,
  };
}

function candidateFromSelector(selector: RetrievalSelector, priority: number): RetrieveContextCandidate {
  const corpusLane = selector.corpus_lane ?? corpusLaneFromSourceRefs(selector.source_refs ?? []);
  const candidate: RetrieveContextCandidate = {
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
  return {
    ...candidate,
    evidence_metadata: buildCandidateEvidenceMetadata(candidate),
  };
}

function buildCandidateEvidenceMetadata(
  candidate: RetrieveContextCandidate,
  scopeGate?: ScopeGateDecisionResult,
): NonNullable<RetrieveContextCandidate['evidence_metadata']> {
  const selectorRefs = candidate.read_selector.source_refs ?? [];
  return {
    evidence_role: 'probe_candidate_pointer',
    authority: 'not_answer_evidence',
    activation: candidate.activation,
    freshness: candidate.read_selector.freshness
      ?? (candidate.matched_chunks.some((chunk) => chunk.stale) ? 'stale' : 'current'),
    ...(candidate.read_selector.content_hash ? { content_hash: candidate.read_selector.content_hash } : {}),
    source_ref_count: selectorRefs.length,
    source_ref_kinds: sourceRefKinds(selectorRefs),
    ...(candidate.read_selector.corpus_lane ?? candidate.canonical_target.corpus_lane
      ? { corpus_lane: (candidate.read_selector.corpus_lane ?? candidate.canonical_target.corpus_lane)! }
      : {}),
    ...(scopeGate ? { scope_gate: scopeGate } : {}),
    rank_reason: candidate.why_matched,
  };
}

function withCandidateResultMetadata(
  candidates: RetrieveContextCandidate[],
  createSafety: NonNullable<RetrieveContextResult['create_safety']>,
  options: {
    backend_gap?: RetrieveContextBackendGap;
    graph_frontier_authority?: NonNullable<RetrieveContextCandidate['evidence_metadata']>['graph_frontier_authority'];
  } = {},
): RetrieveContextCandidate[] {
  const createSafetySummary = compactCreateSafety(createSafety);
  const backendGapSummary = options.backend_gap
    ? {
        status: options.backend_gap.status,
        reason_code: options.backend_gap.reason_code,
      }
    : undefined;
  return candidates.map((candidate) => {
    const evidenceMetadata = candidate.evidence_metadata ?? buildCandidateEvidenceMetadata(candidate);
    return {
      ...candidate,
      evidence_metadata: {
        ...evidenceMetadata,
        create_safety: createSafetySummary,
        ...(backendGapSummary ? { backend_gap: backendGapSummary } : {}),
        ...(options.graph_frontier_authority
          ? { graph_frontier_authority: options.graph_frontier_authority }
          : {}),
      },
    };
  });
}

function compactCreateSafety(
  createSafety: NonNullable<RetrieveContextResult['create_safety']>,
): NonNullable<NonNullable<RetrieveContextCandidate['evidence_metadata']>['create_safety']> {
  return {
    status: createSafety.status,
    reasons: createSafety.reasons,
    write_permission_granted: createSafety.write_permission_granted,
  };
}

function buildCreateSafety(
  candidates: RetrieveContextCandidate[],
  requiredReads: RetrievalSelector[],
  options: {
    selector_existence_verified?: boolean;
    candidate_signals?: RetrieveContextResult['candidate_signals'];
    candidate_signal_policy?: RetrieveContextResult['candidate_signal_policy'];
    canonical_probe_completed?: boolean;
  } = {},
): NonNullable<RetrieveContextResult['create_safety']> {
  const matchedCandidateIds = candidates
    .filter((candidate) => requiredReads.some((selector) =>
      selectorEvidencePlanKey(selector) === selectorEvidencePlanKey(candidate.read_selector)
    ))
    .map((candidate) => candidate.candidate_id);
  const matchedSelectorIds = requiredReads.map(retrievalSelectorId);
  const existenceVerified = options.selector_existence_verified !== false;
  const candidateSignalIds = options.candidate_signals?.map((signal) => signal.candidate_id) ?? [];
  const suppressedCandidateCount = options.candidate_signal_policy?.suppressed_count ?? 0;
  const status = matchedCandidateIds.length > 0
    ? existenceVerified
      ? 'exists'
      : 'unknown'
    : candidateSignalIds.length > 0
      ? 'probable_duplicate'
      : suppressedCandidateCount > 0
        ? 'probable_duplicate'
        : matchedSelectorIds.length > 0
          ? 'unknown'
          : options.canonical_probe_completed === true
            ? 'safe_to_propose'
            : 'no_canonical_candidate';
  const candidateIds = status === 'probable_duplicate'
    ? candidateSignalIds
    : matchedCandidateIds;
  const probableDuplicateReasons = candidateSignalIds.length > 0
    ? ['memory_inbox_candidate_overlap_requires_review', 'route_memory_writeback_required_before_write']
    : ['suppressed_memory_inbox_overlap_requires_review', 'route_memory_writeback_required_before_write'];
  return {
    status,
    matched_candidate_ids: candidateIds,
    matched_selector_ids: matchedSelectorIds,
    reasons: status === 'exists'
      ? ['canonical_candidate_exists', 'route_memory_writeback_still_required_for_writes']
      : status === 'unknown'
        ? matchedSelectorIds.length > 0 && matchedCandidateIds.length === 0
          ? ['canonical_read_selected_requires_read_context', 'route_memory_writeback_required_before_write']
          : ['selector_existence_not_verified', 'route_memory_writeback_required_before_write']
        : status === 'probable_duplicate'
          ? probableDuplicateReasons
          : status === 'safe_to_propose'
            ? ['no_canonical_or_candidate_overlap_in_probe', 'route_memory_writeback_required_before_write']
            : ['no_existing_canonical_candidate_in_probe', 'route_memory_writeback_required_before_write'],
    write_permission_granted: false,
  };
}

function sourceRefKinds(sourceRefs: string[]): EvidenceSourceRefKind[] {
  const kinds = sourceRefs.map((sourceRef): EvidenceSourceRefKind => {
    const lower = sourceRef.toLowerCase();
    if (lower.startsWith('source: user') || lower.includes('user,')) return 'user';
    if (lower.startsWith('task:') || lower.startsWith('task_decision:')) return 'task';
    if (lower.startsWith('corpus_lane:')) return 'corpus_lane';
    if (lower.startsWith('source_record:')) return 'source_record';
    if (lower.startsWith('import_origin:')) return 'import_origin';
    return 'other';
  });
  return [...new Set(kinds)];
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
    selected_selector_snapshots: [],
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
  orientation_reads_competed?: boolean;
  backend_gap_reason?: CandidateSearchBackendGap;
  backend_gap?: RetrieveContextBackendGap;
}): RetrieveContextReadPlan {
  const selectedSelectorSnapshots = input.required_reads.map((selector) => normalizeRetrievalSelector(selector));
  const selectedSelectors = selectedSelectorSnapshots.map(retrievalSelectorId);
  const selectedEvidence = new Set(selectedSelectorSnapshots.map(selectorEvidencePlanKey));
  const deferredCandidateIds = input.candidates
    .filter((candidate) => !selectedEvidence.has(selectorEvidencePlanKey(candidate.read_selector)))
    .map((candidate) => candidate.candidate_id);
  const deferredOrientationReads = input.orientation_reads_competed === true
    ? input.orientation.recommended_reads
      .filter((selector) => !selectedEvidence.has(selectorEvidencePlanKey(selector)))
    : [];
  const hasOrientationReads = input.orientation_reads_competed === true
    && input.orientation.recommended_reads.length > 0;
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
  if (input.backend_gap_reason) {
    gapReasons.push(input.backend_gap_reason);
  }

  return {
    mode: 'bounded_evidence',
    max_depth: READ_PLAN_MAX_DEPTH,
    max_selectors: input.required_read_limit,
    selected_selectors: selectedSelectors,
    selected_selector_snapshots: selectedSelectorSnapshots,
    deferred_candidate_ids: deferredCandidateIds,
    gap_reasons: [...new Set(gapReasons)],
    next_actions: readPlanNextActions(
      selectedSelectors,
      deferredCandidateIds,
      hasOrientationReads,
      deferredOrientationReads.length > 0,
      input.candidate_signals,
      input.backend_gap_reason,
    ),
    ...(input.backend_gap ? { backend_gap: input.backend_gap } : {}),
  };
}

function selectorEvidencePlanKey(selector: RetrievalSelector): string {
  return canonicalEvidenceKey(normalizeRetrievalSelector(selector)) ?? retrievalSelectorId(selector);
}

function readPlanNextActions(
  selectedSelectors: string[],
  deferredCandidateIds: string[],
  hasOrientationReads: boolean,
  hasDeferredOrientationReads: boolean,
  candidateSignals: CandidateSignalResult,
  backendGapReason?: CandidateSearchBackendGap,
): string[] {
  const actions: string[] = [];
  if (selectedSelectors.length > 0) {
    actions.push('Call read_context with read_plan.selected_selector_snapshots before making factual claims.');
  } else {
    actions.push('Do not answer factual claims until retrieve_context finds canonical read selectors.');
  }
  if (deferredCandidateIds.length > 0) {
    actions.push('If read_context reports gaps, rerun retrieve_context with a narrower query or higher limit.');
  }
  if (hasOrientationReads) {
    actions.push('Context-map recommended reads were considered for required_reads; selected_selector_snapshots still require read_context before factual claims.');
  }
  if (hasDeferredOrientationReads) {
    actions.push('Some context-map recommended reads were deferred by the read budget; narrow the query or raise the limit if synthesis coverage is incomplete.');
  }
  if (candidateSignals.candidate_signals.length > 0) {
    actions.push('Inspect candidate_signals separately; they are non-canonical and not answer evidence.');
  }
  if (backendGapReason) {
    actions.push('Retrieval backend failures occurred; treat fallback or empty results as incomplete and retry when the backend is healthy.');
  }
  return actions;
}

function normalizedMatchedChunkScore(chunk: RetrievalMatchedChunk): number {
  if (typeof chunk.search_rank_score === 'number' && Number.isFinite(chunk.search_rank_score)) {
    return Math.max(0, Math.min(1, chunk.search_rank_score));
  }
  return Math.max(0, Math.min(1, chunk.score));
}

function normalizedSearchRankScore(rank: number): number {
  if (!Number.isFinite(rank) || rank < 0) return 0;
  return 1 / (rank + 10);
}

function toMatchedChunk(
  result: SearchResult,
  corpusLane?: RetrievalMatchedChunk['corpus_lane'],
  searchRankScore?: number,
): RetrievalMatchedChunk {
  return {
    slug: result.slug,
    page_id: result.page_id,
    title: result.title,
    type: result.type,
    chunk_source: result.chunk_source,
    score: result.score,
    ...(searchRankScore !== undefined ? { search_rank_score: searchRankScore } : {}),
    stale: result.stale,
    ...(corpusLane ? { corpus_lane: corpusLane } : {}),
  };
}

function canonicalEvidenceKey(selector: RetrievalSelector): string | undefined {
  if (
    selector.kind !== 'section'
    && selector.kind !== 'compiled_truth'
    && selector.kind !== 'frontmatter'
    && selector.kind !== 'page'
  ) return undefined;
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
  startedAtMs: number,
): Promise<RetrieveContextResult> {
  if (input.persist_trace === false || typeof engine.putRetrievalTrace !== 'function') {
    return attachPushContextEnvelope(withRetrieveTrustFooter(result), input);
  }
  const resultWithTrace = {
    ...result,
    trace: await persistRetrieveTrace(engine, result, input, startedAtMs),
  };
  return attachPushContextEnvelope(withRetrieveTrustFooter(resultWithTrace), input);
}

function withRetrieveTrustFooter(result: RetrieveContextResult): RetrieveContextResult {
  return {
    ...result,
    answer_trust_footer: buildRetrieveTrustFooter(result),
  };
}

function buildRetrieveTrustFooter(result: RetrieveContextResult): AnswerTrustFooter {
  const selectors = result.read_plan.selected_selector_snapshots?.length
    ? result.read_plan.selected_selector_snapshots
    : result.required_reads;
  const sourceRefs = traceSourceRefs(selectors);
  const contentHashes = uniqueStrings(selectors
    .map((selector) => selector.content_hash)
    .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0));
  const excludedSignals: AnswerTrustFooterExcludedSignal[] = [];
  if (result.candidate_signals.length > 0) {
    excludedSignals.push({
      kind: 'candidate_signal',
      count: result.candidate_signals.length,
      reason: 'Memory Inbox candidate signals are non-canonical pointers and require review before answer use.',
    });
  }
  const matchedChunkCount = result.candidates.reduce((total, candidate) => total + candidate.matched_chunks.length, 0);
  if (matchedChunkCount > 0) {
    excludedSignals.push({
      kind: 'search_chunk',
      count: matchedChunkCount,
      reason: 'Search/query chunks are discovery pointers; read_context is required for factual answer evidence.',
    });
  }
  if ((result.orientation.graph_paths_considered?.length ?? 0) > 0) {
    excludedSignals.push({
      kind: 'graph_frontier',
      count: result.orientation.graph_paths_considered?.length,
      reason: 'Graph frontier paths orient selector planning but are not canonical answer evidence.',
    });
  }
  if (result.orientation.derived_consulted.length > 0) {
    excludedSignals.push({
      kind: 'context_map',
      count: result.orientation.derived_consulted.length,
      reason: 'Derived orientation artifacts can rank or recommend reads, but read_context must provide answer evidence.',
    });
  }

  return {
    authority_class: 'not_answer_evidence',
    underlying_authorities: ['not_answer_evidence'],
    evidence_selectors: selectors.map(retrievalSelectorId),
    source_refs: sourceRefs,
    excluded_signals: excludedSignals,
    freshness: {
      content_hashes: contentHashes,
      derived_index_status: result.read_plan.backend_gap ? 'unknown' : 'current',
      generated_at: new Date().toISOString(),
    },
    write_status: 'no_write',
    next_verification_action: result.required_reads.length > 0
      ? 'Call read_context with read_plan.selected_selector_snapshots before making factual claims.'
      : 'No canonical reads were selected; narrow the query or inspect candidate pointers without treating them as evidence.',
    trace_ids: result.trace?.id ? [result.trace.id] : [],
  };
}

function attachPushContextEnvelope(
  result: RetrieveContextResult,
  input: RetrieveContextInput,
): RetrieveContextResult {
  if (input.include_push_context !== true || result.required_reads.length === 0) return result;
  const selectors = result.read_plan.selected_selector_snapshots?.length
    ? result.read_plan.selected_selector_snapshots
    : result.required_reads;
  return {
    ...result,
    push_context: buildSelectorFirstPushContextEnvelope({
      request_id: result.request_id,
      trace_ids: result.trace?.id ? [result.trace.id] : [],
      selectors,
      scope_gate: result.scope_gate,
      answerability: result.answerability,
      source_ref_count: countSourceRefs(selectors),
    }),
  };
}

async function persistRetrieveTrace(
  engine: BrainEngine,
  result: RetrieveContextResult,
  input: RetrieveContextInput,
  startedAtMs: number,
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
    selected_intent: result.route?.selected_intent ?? intentFromScenario(result.scenario),
    scope_gate_policy: result.scope_gate?.policy ?? null,
    scope_gate_reason: result.scope_gate?.decision_reason ?? null,
    elapsed_ms: Math.max(0, Date.now() - startedAtMs),
    retrieved_token_count: 0,
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

function countSourceRefs(selectors: RetrievalSelector[]): number {
  return mergeSourceRefs(selectors.flatMap((selector) => selector.source_refs ?? [])).length;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
