import type { BrainEngine } from '../engine.ts';
import type {
  MemoryScenario,
  RetrieveContextCandidate,
  RetrieveContextInput,
  RetrieveContextOrientation,
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
import { classifyMemoryScenario } from './memory-scenario-classifier-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
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

export interface RetrieveContextDependencies {
  candidateSearch?: RetrieveContextCandidateSearch;
}

const DEFAULT_CANDIDATE_LIMIT = 5;
const SEARCH_HIT_CONTEXT_CHARS = 40;
const SEARCH_CHUNK_WARNING = 'Search/query chunks are candidate pointers; call read_context before answering factual questions.';
const PERSONAL_SELECTOR_PREFIXES = ['personal/', 'brain/personal/', 'profile/', 'profiles/'] as const;

export async function retrieveContext(
  engine: BrainEngine,
  input: RetrieveContextInput,
  dependencies: RetrieveContextDependencies = {},
): Promise<RetrieveContextResult> {
  const limit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
  assertPositiveInteger(limit, 'limit');
  if (input.token_budget !== undefined) assertPositiveInteger(input.token_budget, 'token_budget');

  const requestId = crypto.randomUUID();
  const classification = classifyMemoryScenario(input);
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
      candidates: normalizedSelectors.map((selector, index) => candidateFromSelector(selector, index + 1)),
      required_reads: normalizedSelectors,
      orientation: emptyOrientation(),
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
      candidates: [candidateFromSelector(selector, 1)],
      required_reads: [selector],
      orientation: emptyOrientation(),
      warnings: ['Task continuation must read task state before raw files or graph orientation.'],
    }, input);
  }

  const query = input.query?.trim() ?? '';
  const candidateSearch = dependencies.candidateSearch ?? ((candidateQuery, options) =>
    engine.searchKeyword(candidateQuery, { limit: options.limit }));
  const searchResults = query.length > 0 ? await candidateSearch(query, { limit }) : [];
  const candidates = await groupCandidatesByCanonicalPage(engine, searchResults, limit);
  const orientation = input.include_orientation === false || query.length === 0
    ? emptyOrientation()
    : await buildOrientation(engine, query, limit);
  const requiredReads = dedupeSelectors([
    ...candidates.map((candidate) => candidate.read_selector),
    ...orientation.recommended_reads,
  ]).slice(0, limit);

  return maybePersistRetrieveTrace(engine, {
    request_id: requestId,
    scenario: classification.scenario,
    scope_gate: scopeGate,
    route: null,
    answerability: {
      answerable_from_probe: false,
      allowed_probe_answer_kind: 'none',
      must_read_context: requiredReads.length > 0,
      reason_codes: requiredReads.length > 0
        ? ['probe_candidates_are_not_answer_ground']
        : ['no_candidate'],
    },
    candidates,
    required_reads: requiredReads,
    orientation,
    warnings: [
      ...(searchResults.length > 0 ? [SEARCH_CHUNK_WARNING] : []),
      ...(requiredReads.length === 0 ? ['No canonical read candidate was found.'] : []),
    ],
  }, input);
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
    orientation: emptyOrientation(),
    warnings: scopeGate.summary_lines,
  };
}

async function groupCandidatesByCanonicalPage(
  engine: BrainEngine,
  searchResults: SearchResult[],
  limit: number,
): Promise<RetrieveContextCandidate[]> {
  const resultsBySlug = new Map<string, SearchResult[]>();
  for (const result of searchResults) {
    const existing = resultsBySlug.get(result.slug) ?? [];
    existing.push(result);
    resultsBySlug.set(result.slug, existing);
  }

  const groupedResults = [...resultsBySlug.entries()]
    .map(([slug, results]) => ({
      slug,
      results,
      top: [...results].sort((a, b) => b.score - a.score)[0]!,
    }))
    .sort((a, b) => b.top.score - a.top.score);

  const candidates: RetrieveContextCandidate[] = [];
  for (const group of groupedResults) {
    if (candidates.length >= limit) break;
    const readResult = bestTimelineSearchResult(group.results) ?? group.top;
    const selector = await bestReadSelectorForSearchResult(engine, readResult);
    candidates.push({
      candidate_id: `candidate:${group.slug}`,
      canonical_target: {
        kind: selector.kind,
        slug: group.slug,
        title: group.top.title,
        type: group.top.type,
        path: selector.path,
        section_id: selector.section_id,
        scope_id: selector.scope_id,
      },
      matched_chunks: group.results.map(toMatchedChunk),
      why_matched: [`matched ${group.results.length} search chunk${group.results.length === 1 ? '' : 's'}`],
      activation: group.top.stale ? 'verify_first' : 'candidate_only',
      read_priority: candidates.length + 1,
      read_selector: selector,
    });
  }

  return candidates;
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
): Promise<RetrievalSelector> {
  if (result.chunk_source === 'timeline') {
    return selectorFromSearchResult(result);
  }

  const sections = await engine.listNoteSectionEntries({
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    page_slug: result.slug,
    limit: 50,
  });
  const normalizedChunk = normalizeText(result.chunk_text);
  const matchingSection = normalizedChunk.length === 0
    ? undefined
    : sections
      .map((section) => ({
        section,
        match: locateSearchSnippet(section.section_text, result.chunk_text),
      }))
      .find((entry) => entry.match !== null);

  if (matchingSection) {
    const charStart = matchingSection.match!.index > 0
      ? Math.max(0, matchingSection.match!.index - SEARCH_HIT_CONTEXT_CHARS)
      : undefined;
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
      content_hash: matchingSection.section.content_hash,
      freshness: result.stale ? 'stale' : 'current',
    });
  }

  return selectorFromSearchResult(result);
}

function hasPersonalSelectorSignal(selector: RetrievalSelector): boolean {
  if (selector.kind === 'profile_memory' || selector.kind === 'personal_episode') {
    return true;
  }

  if (isPersonalScopeId(selector.scope_id)) {
    return true;
  }

  return [
    selector.slug,
    selector.path,
    selector.section_id,
  ].some(startsWithPersonalPrefix);
}

function isPersonalScopeId(value: string | undefined): boolean {
  if (!value) return false;
  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === 'personal' || normalizedValue.startsWith('personal:');
}

function startsWithPersonalPrefix(value: string | undefined): boolean {
  if (!value) return false;
  const normalizedValue = value.trim().toLowerCase();
  return PERSONAL_SELECTOR_PREFIXES.some((prefix) => normalizedValue.startsWith(prefix));
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
  return {
    candidate_id: `candidate:${retrievalSelectorId(selector)}`,
    canonical_target: {
      kind: selector.kind,
      slug: selector.slug,
      path: selector.path,
      section_id: selector.section_id,
      scope_id: selector.scope_id,
    },
    matched_chunks: [],
    why_matched: ['explicit selector'],
    activation: 'candidate_only',
    read_priority: priority,
    read_selector: selector,
  };
}

function emptyOrientation(): RetrieveContextOrientation {
  return {
    derived_consulted: [],
    recommended_reads: [],
    summary_lines: [],
  };
}

function toMatchedChunk(result: SearchResult): RetrievalMatchedChunk {
  return {
    slug: result.slug,
    page_id: result.page_id,
    title: result.title,
    type: result.type,
    chunk_source: result.chunk_source,
    score: result.score,
    stale: result.stale,
  };
}

function dedupeSelectors(selectors: RetrievalSelector[]): RetrievalSelector[] {
  const seen = new Set<string>();
  const output: RetrievalSelector[] = [];
  for (const selector of selectors) {
    const normalized = normalizeRetrievalSelector(selector);
    const id = retrievalSelectorId(normalized);
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
    source_refs: result.required_reads.map(retrievalSelectorId),
    derived_consulted: result.orientation.derived_consulted,
    verification: [
      `scenario:${result.scenario}`,
      ...result.answerability.reason_codes.map((code) => `answerability:${code}`),
      ...buildScopeGateVerification(result.scope_gate),
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
