import type { BrainEngine } from '../engine.ts';
import type {
  CanonicalContextRead,
  ContextAnswerReady,
  ContextEvidenceClaim,
  MemoryArtifactAuthority,
  ReadContextInput,
  ReadContextResult,
  RetrievalRouteIntent,
  RetrievalSelector,
  RetrievalTrace,
  ScopeGateDecisionResult,
  ScopeGateScope,
} from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { normalizeRetrievalSelector, retrievalSelectorId } from './retrieval-selector-service.ts';
import { retrieveContext } from './retrieve-context-service.ts';
import { evaluateScopeGate } from './scope-gate-service.ts';
import { listAllNoteSectionEntries } from './structural-entry-pagination.ts';

const DEFAULT_TOKEN_BUDGET = 900;
const DEFAULT_MAX_SELECTORS = 3;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const PERSONAL_SELECTOR_PREFIXES = ['personal/', 'brain/personal/', 'profile/', 'profiles/'] as const;

type ReadSelectorOptions = {
  token_budget: number;
  include_timeline: 'auto' | 'include' | 'exclude';
  include_source_refs: boolean;
  requested_scope?: ReadContextInput['requested_scope'];
  query?: string;
};

class ScopeBlockedReadError extends Error {
  constructor(readonly scopeGate: ScopeGateDecisionResult) {
    super(`scope gate blocked canonical read: ${scopeGate.policy}`);
  }
}

export async function readContext(
  engine: BrainEngine,
  input: ReadContextInput,
): Promise<ReadContextResult> {
  const maxSelectors = input.max_selectors ?? DEFAULT_MAX_SELECTORS;
  assertPositiveInteger(maxSelectors, 'max_selectors');
  if (input.token_budget !== undefined) assertPositiveInteger(input.token_budget, 'token_budget');

  const warnings: string[] = [];
  const autoResolved = await resolveReadSelectors(engine, input, maxSelectors, warnings);
  if (autoResolved.blocked) {
    return maybePersistReadTrace(engine, autoResolved.blocked, input);
  }

  const normalizedSelectors = autoResolved.selectors
    .map((selector) => normalizeRetrievalSelector(selector));
  const scopeGate = await maybeEvaluateReadScopeGate(engine, input, normalizedSelectors, autoResolved.scope_gate);
  if (scopeGate && scopeGate.policy !== 'allow') {
    return maybePersistReadTrace(engine, blockedByScopeGate(scopeGate, normalizedSelectors), input);
  }

  const selectors = normalizedSelectors.slice(0, maxSelectors);
  const reads: CanonicalContextRead[] = [];
  const unreadRequired: RetrievalSelector[] = [];
  const continuations: RetrievalSelector[] = [];
  let remainingBudget = input.token_budget ?? DEFAULT_TOKEN_BUDGET;

  for (const selector of normalizedSelectors.slice(maxSelectors)) {
    unreadRequired.push(selector);
    warnings.push(`Selector deferred by max_selectors: ${retrievalSelectorId(selector)}`);
  }

  for (const selector of selectors) {
    if (remainingBudget <= 0) {
      unreadRequired.push(selector);
      warnings.push(`Token budget exhausted before reading: ${retrievalSelectorId(selector)}`);
      continue;
    }

    let read: CanonicalContextRead | null;
    try {
      read = await readSelector(engine, selector, {
        token_budget: remainingBudget,
        include_timeline: input.include_timeline ?? 'auto',
        include_source_refs: input.include_source_refs !== false,
        requested_scope: input.requested_scope,
        query: input.query,
      });
    } catch (error) {
      if (error instanceof ScopeBlockedReadError) {
        return maybePersistReadTrace(engine, blockedByScopeGate(error.scopeGate, [selector]), input);
      }
      throw error;
    }

    if (!read) {
      unreadRequired.push(selector);
      warnings.push(`Selector could not be read: ${retrievalSelectorId(selector)}`);
      continue;
    }

    reads.push(read);
    remainingBudget -= read.token_estimate;
    if (read.continuation_selector) continuations.push(read.continuation_selector);
  }

  return maybePersistReadTrace(engine, {
    answer_ready: buildAnswerReady(reads, unreadRequired, warnings),
    canonical_reads: reads,
    evidence_claims: reads.map(buildEvidenceClaim),
    conflicts: [],
    warnings,
    unread_required: unreadRequired,
    continuations,
    scope_gate: scopeGate,
  }, input);
}

async function readSelector(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: ReadSelectorOptions,
): Promise<CanonicalContextRead | null> {
  switch (selector.kind) {
    case 'page':
      return readPage(engine, selector, options, true);
    case 'compiled_truth':
      return readPage(engine, selector, options, false);
    case 'section':
      return readSection(engine, selector, options);
    case 'line_span':
      return readLineSpan(engine, selector, options);
    case 'timeline_range':
      return readTimelineRange(engine, selector, options);
    case 'timeline_entry':
      return readTimelineEntry(engine, selector, options);
    case 'source_ref':
      return readSourceRef(engine, selector, options);
    case 'task_working_set':
      return readTaskWorkingSet(engine, selector, options);
    case 'task_attempt':
      return readTaskAttempt(engine, selector, options);
    case 'task_decision':
      return readTaskDecision(engine, selector, options);
    case 'profile_memory':
      return readProfileMemory(engine, selector, options);
    case 'personal_episode':
      return readPersonalEpisode(engine, selector, options);
  }
}

async function readPage(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: ReadSelectorOptions,
  includePageTimeline: boolean,
): Promise<CanonicalContextRead | null> {
  if (!selector.slug) return null;
  const page = await engine.getPage(selector.slug);
  if (!page) return null;

  const shouldIncludeTimeline = includePageTimeline && options.include_timeline === 'include';
  const compiledTruth = page.compiled_truth.trim();
  const timeline = page.timeline.trim();
  const text = shouldIncludeTimeline && timeline
    ? `${compiledTruth}\n\n---\n\n${timeline}`
    : compiledTruth;

  return buildRead({
    selector,
    title: page.title,
    text,
    authority: 'canonical_compiled_truth',
    source_refs: options.include_source_refs ? extractSourceRefs(text) : [],
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

async function readSection(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.section_id) return null;
  const scopeId = selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const section = await engine.getNoteSectionEntry(scopeId, selector.section_id);
  if (!section) return null;

  return buildRead({
    selector: normalizeRetrievalSelector({
      ...selector,
      slug: section.page_slug,
      path: section.page_path,
      line_start: section.line_start,
      line_end: section.line_end,
      source_refs: section.source_refs,
      content_hash: section.content_hash,
    }),
    title: section.heading_text,
    text: section.section_text,
    authority: 'canonical_compiled_truth',
    source_refs: options.include_source_refs ? section.source_refs : [],
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

async function readLineSpan(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.slug || selector.line_start === undefined || selector.line_end === undefined) return null;
  const page = await engine.getPage(selector.slug);
  if (!page) return null;

  const fullText = page.timeline.trim()
    ? `${page.compiled_truth}\n\n---\n\n${page.timeline}`
    : page.compiled_truth;
  const text = fullText
    .split('\n')
    .slice(selector.line_start - 1, selector.line_end)
    .join('\n')
    .trim();
  if (!text) return null;

  return buildRead({
    selector,
    title: page.title,
    text,
    authority: 'source_or_timeline_evidence',
    source_refs: options.include_source_refs ? extractSourceRefs(text) : [],
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

async function readTimelineRange(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.slug) return null;
  const hasCharWindow = selector.char_start !== undefined || selector.char_end !== undefined;
  if (hasCharWindow) {
    const page = await engine.getPage(selector.slug);
    if (page?.timeline.trim()) {
      const timeline = page.timeline.trim();
      return buildRead({
        selector,
        title: `Timeline: ${selector.slug}`,
        text: timeline,
        authority: 'source_or_timeline_evidence',
        source_refs: options.include_source_refs ? extractSourceRefs(timeline) : [],
        include_source_refs: options.include_source_refs,
        token_budget: options.token_budget,
      });
    }
  }

  const entries = await engine.getTimeline(selector.slug);
  if (entries.length === 0) {
    const page = await engine.getPage(selector.slug);
    if (!page?.timeline.trim()) return null;
    const timeline = page.timeline.trim();
    return buildRead({
      selector,
      title: `Timeline: ${selector.slug}`,
      text: timeline,
      authority: 'source_or_timeline_evidence',
      source_refs: options.include_source_refs ? extractSourceRefs(timeline) : [],
      include_source_refs: options.include_source_refs,
      token_budget: options.token_budget,
    });
  }

  const text = entries
    .map((entry) => {
      const source = entry.source.trim() ? ` [Source: ${entry.source.trim()}]` : '';
      return `- **${entry.date}** | ${entry.summary}${source}${entry.detail ? `\n  ${entry.detail}` : ''}`;
    })
    .join('\n');

  return buildRead({
    selector,
    title: `Timeline: ${selector.slug}`,
    text,
    authority: 'source_or_timeline_evidence',
    source_refs: options.include_source_refs
      ? entries.map((entry) => entry.source).filter((source) => source.length > 0)
      : [],
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

async function readTimelineEntry(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  const target = timelineEntryTarget(selector);
  if (!target) return null;
  const entries = await engine.getTimeline(target.slug);
  const entry = entries.find((candidate) => String(candidate.id) === target.entry_id);
  if (!entry) return null;

  const text = [
    `- **${entry.date}** | ${entry.summary}${entry.source ? ` [Source: ${entry.source}]` : ''}`,
    entry.detail,
  ].filter((line) => line.trim().length > 0).join('\n');

  return buildRead({
    selector: normalizeRetrievalSelector({
      ...selector,
      slug: target.slug,
    }),
    title: `Timeline entry: ${target.slug}#${entry.id}`,
    text,
    authority: 'source_or_timeline_evidence',
    source_refs: options.include_source_refs && entry.source ? [entry.source] : [],
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

function timelineEntryTarget(selector: RetrievalSelector): { slug: string; entry_id: string } | null {
  if (selector.slug && selector.object_id) {
    return { slug: selector.slug, entry_id: selector.object_id };
  }
  if (!selector.object_id) return null;
  const separator = selector.object_id.lastIndexOf(':');
  if (separator <= 0 || separator >= selector.object_id.length - 1) return null;
  return {
    slug: selector.object_id.slice(0, separator),
    entry_id: selector.object_id.slice(separator + 1),
  };
}

async function readSourceRef(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs' | 'requested_scope' | 'query'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.source_ref) return null;
  const sections = await listAllNoteSectionEntries(
    engine,
    selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID,
  );
  const targetPath = selector.path?.split('#')[0]?.trim();
  const matches = sections.filter((entry) => {
    if (!entry.source_refs.includes(selector.source_ref!)) return false;
    if (selector.slug && entry.page_slug !== selector.slug) return false;
    if (targetPath && entry.page_path !== targetPath) return false;
    if (selector.section_id && entry.section_id !== selector.section_id) return false;
    return true;
  });
  if (matches.length !== 1) return null;
  const section = matches[0]!;
  const resolvedSelector = normalizeRetrievalSelector({
    kind: 'section',
    scope_id: section.scope_id,
    slug: section.page_slug,
    path: section.page_path,
    section_id: section.section_id,
  });
  const resolvedScopeGate = await maybeEvaluateReadScopeGate(engine, {
    requested_scope: options.requested_scope,
    query: options.query,
  }, [resolvedSelector]);
  if (resolvedScopeGate && resolvedScopeGate.policy !== 'allow') {
    throw new ScopeBlockedReadError(resolvedScopeGate);
  }

  return readSection(engine, {
    kind: 'section',
    scope_id: section.scope_id,
    slug: section.page_slug,
    path: section.page_path,
    section_id: section.section_id,
    char_start: selector.char_start,
    char_end: selector.char_end,
  }, options);
}

async function readTaskWorkingSet(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const [thread, workingSet, attempts, decisions] = await Promise.all([
    engine.getTaskThread(selector.object_id),
    engine.getTaskWorkingSet(selector.object_id),
    engine.listTaskAttempts(selector.object_id, { limit: 3 }),
    engine.listTaskDecisions(selector.object_id, { limit: 3 }),
  ]);
  if (!thread && !workingSet) return null;

  const text = [
    thread ? `Task: ${thread.title}\nStatus: ${thread.status}\nSummary: ${thread.current_summary}` : '',
    workingSet ? `Active paths: ${workingSet.active_paths.join(', ')}` : '',
    workingSet ? `Active symbols: ${workingSet.active_symbols.join(', ')}` : '',
    workingSet ? `Blockers: ${workingSet.blockers.join(', ') || 'none'}` : '',
    workingSet ? `Open questions: ${workingSet.open_questions.join(', ') || 'none'}` : '',
    workingSet ? `Next steps: ${workingSet.next_steps.join(', ') || 'none'}` : '',
    workingSet ? `Verification notes: ${workingSet.verification_notes.join(', ') || 'none'}` : '',
    attempts.length > 0
      ? `Recent attempts: ${attempts.map((attempt) => `${attempt.outcome}: ${attempt.summary}`).join(' | ')}`
      : '',
    decisions.length > 0
      ? `Recent decisions: ${decisions.map((decision) => decision.summary).join(' | ')}`
      : '',
  ].filter((line) => line.trim().length > 0).join('\n');

  return buildRead({
    selector,
    title: `Task working set: ${selector.object_id}`,
    text,
    authority: 'operational_memory',
    source_refs: [`task:${selector.object_id}`],
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

async function readTaskAttempt(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const [taskId] = selector.object_id.split(':');
  if (!taskId) return null;
  const attempts = await engine.listTaskAttempts(taskId, { limit: 20 });
  const attempt = attempts.find((entry) =>
    entry.id === selector.object_id || `${entry.task_id}:${entry.id}` === selector.object_id
  );
  if (!attempt) return null;

  return buildRead({
    selector,
    title: `Task attempt: ${attempt.id}`,
    text: `${attempt.outcome}: ${attempt.summary}\nEvidence: ${attempt.evidence.join(', ')}`,
    authority: 'operational_memory',
    source_refs: attempt.evidence,
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

async function readTaskDecision(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const [taskId] = selector.object_id.split(':');
  if (!taskId) return null;
  const decisions = await engine.listTaskDecisions(taskId, { limit: 20 });
  const decision = decisions.find((entry) =>
    entry.id === selector.object_id || `${entry.task_id}:${entry.id}` === selector.object_id
  );
  if (!decision) return null;

  return buildRead({
    selector,
    title: `Task decision: ${decision.id}`,
    text: `${decision.summary}\nRationale: ${decision.rationale}\nConsequences: ${decision.consequences.join(', ')}`,
    authority: 'operational_memory',
    source_refs: [`task_decision:${decision.id}`],
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

async function readProfileMemory(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const entry = await engine.getProfileMemoryEntry(selector.object_id);
  if (!entry) return null;

  return buildRead({
    selector,
    title: `Profile memory: ${entry.subject}`,
    text: `${entry.subject} [${entry.profile_type}]\n${entry.content}`,
    authority: 'canonical_compiled_truth',
    source_refs: entry.source_refs,
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

async function readPersonalEpisode(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const entry = await engine.getPersonalEpisodeEntry(selector.object_id);
  if (!entry) return null;

  return buildRead({
    selector,
    title: `Personal episode: ${entry.title}`,
    text: [
      entry.title,
      `Source kind: ${entry.source_kind}`,
      `Started: ${entry.start_time.toISOString()}`,
      `Ended: ${entry.end_time?.toISOString() ?? 'open'}`,
      entry.summary,
    ].join('\n'),
    authority: 'canonical_compiled_truth',
    source_refs: entry.source_refs,
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

function buildRead(input: {
  selector: RetrievalSelector;
  title: string;
  text: string;
  authority: MemoryArtifactAuthority;
  source_refs: string[];
  include_source_refs: boolean;
  token_budget: number;
}): CanonicalContextRead | null {
  const selector = normalizeRetrievalSelector(input.selector);
  const selectedText = applyCharRange(input.text.trim(), selector);
  if (selectedText === null) return null;
  const clipped = clipToBudget(selectedText, input.token_budget);
  if (!clipped.text) return null;
  const hasMore = clipped.consumed_chars < selectedText.length;
  const continuation = hasMore
    ? buildContinuationSelector(selector, clipped.consumed_chars)
    : undefined;
  const sourceRefs = !input.include_source_refs
    ? []
    : textHasSourceMarkers(input.text)
      ? extractSourceRefs(clipped.text)
      : input.source_refs;

  return {
    selector,
    authority: input.authority,
    title: input.title,
    text: clipped.text,
    source_refs: [...new Set(sourceRefs)],
    token_estimate: estimateTokens(clipped.text),
    has_more: hasMore,
    continuation_selector: continuation,
  };
}

function applyCharRange(text: string, selector: RetrievalSelector): string | null {
  const charStart = selector.char_start ?? 0;
  const charEnd = Math.min(selector.char_end ?? text.length, text.length);
  if (charStart >= text.length || charEnd <= charStart) return null;
  return text.slice(charStart, charEnd);
}

function buildContinuationSelector(selector: RetrievalSelector, consumedChars: number): RetrievalSelector | undefined {
  const charStart = (selector.char_start ?? 0) + consumedChars;
  if (selector.char_end !== undefined && charStart >= selector.char_end) {
    return undefined;
  }
  return normalizeRetrievalSelector({
    ...selector,
    selector_id: undefined,
    char_start: charStart,
  });
}

function buildAnswerReady(
  reads: CanonicalContextRead[],
  unreadRequired: RetrievalSelector[],
  warnings: string[],
): ContextAnswerReady {
  if (reads.length === 0) {
    return {
      ready: false,
      answer_ground: [],
      unsupported_reasons: unreadRequired.length > 0 ? ['no_canonical_selector_read'] : ['no_selectors_requested'],
      citation_policy: 'Do not answer from chunks or derived orientation alone.',
    };
  }
  const hasContinuation = reads.some((read) => read.has_more);
  if (unreadRequired.length > 0 || hasContinuation) {
    const unsupportedReasons = [
      ...(unreadRequired.length > 0 ? ['required_selectors_unread', ...warnings] : []),
      ...(hasContinuation ? ['continuation_required'] : []),
    ];
    return {
      ready: false,
      answer_ground: reads.map((read) => read.selector),
      unsupported_reasons: unsupportedReasons,
      citation_policy: 'Answer only claims supported by canonical_reads; disclose unread selectors and continuations.',
    };
  }
  return {
    ready: true,
    answer_ground: reads.map((read) => read.selector),
    unsupported_reasons: [],
    citation_policy: 'Cite canonical_reads by selector_id and propagate source_refs when present.',
  };
}

function buildEvidenceClaim(read: CanonicalContextRead): ContextEvidenceClaim {
  const selectorId = retrievalSelectorId(read.selector);
  switch (read.selector.kind) {
    case 'task_working_set':
    case 'task_attempt':
    case 'task_decision':
      return { selector_id: selectorId, claim_kind: 'task_state', source_refs: read.source_refs };
    case 'profile_memory':
      return { selector_id: selectorId, claim_kind: 'profile_memory', source_refs: read.source_refs };
    case 'personal_episode':
      return { selector_id: selectorId, claim_kind: 'personal_episode', source_refs: read.source_refs };
    case 'timeline_range':
    case 'timeline_entry':
    case 'line_span':
      return { selector_id: selectorId, claim_kind: 'timeline_evidence', source_refs: read.source_refs };
    default:
      return { selector_id: selectorId, claim_kind: 'compiled_truth', source_refs: read.source_refs };
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE));
}

function clipToBudget(text: string, tokenBudget: number): { text: string; consumed_chars: number } {
  const maxChars = Math.max(1, tokenBudget * CHARS_PER_TOKEN_ESTIMATE);
  if (text.length <= maxChars) return { text, consumed_chars: text.length };
  return { text: text.slice(0, maxChars), consumed_chars: maxChars };
}

function extractSourceRefs(text: string): string[] {
  const refs: string[] = [];
  const pattern = /\[Source:\s*([^\]\n]+)\]/g;
  for (const match of text.matchAll(pattern)) {
    const source = match[1]?.trim();
    if (source) refs.push(source);
  }
  return [...new Set(refs)];
}

function textHasSourceMarkers(text: string): boolean {
  return /\[Source:\s*[^\]\n]+\]/.test(text);
}

async function resolveReadSelectors(
  engine: BrainEngine,
  input: ReadContextInput,
  maxSelectors: number,
  warnings: string[],
): Promise<{
  selectors: RetrievalSelector[];
  scope_gate?: ScopeGateDecisionResult;
  blocked?: ReadContextResult;
}> {
  if ((input.selectors ?? []).length > 0 || input.reads !== 'auto') {
    return { selectors: input.selectors ?? [] };
  }

  const query = input.query?.trim();
  if (!query) return { selectors: [] };

  const probe = await retrieveContext(engine, {
    query,
    task_id: input.task_id ?? undefined,
    requested_scope: input.requested_scope,
    limit: maxSelectors,
    include_orientation: true,
    persist_trace: false,
  });

  warnings.push('Auto reads selected from retrieve_context required_reads.');
  warnings.push(...probe.warnings);

  if (probe.scope_gate && probe.scope_gate.policy !== 'allow') {
    return {
      selectors: [],
      scope_gate: probe.scope_gate,
      blocked: blockedByScopeGate(probe.scope_gate, probe.required_reads),
    };
  }

  return {
    selectors: probe.required_reads,
    scope_gate: probe.scope_gate,
  };
}

async function maybeEvaluateReadScopeGate(
  engine: BrainEngine,
  input: ReadContextInput,
  selectors: RetrievalSelector[],
  existingScopeGate?: ScopeGateDecisionResult,
): Promise<ScopeGateDecisionResult | undefined> {
  if (existingScopeGate && existingScopeGate.policy !== 'allow') return existingScopeGate;
  const hasPersonalSelector = selectors.some(hasPersonalSelectorSignal);
  if (!hasPersonalSelector && input.requested_scope === undefined) return existingScopeGate;

  return evaluateScopeGate(engine, {
    intent: readIntentForSelectors(selectors, hasPersonalSelector),
    requested_scope: input.requested_scope,
    task_id: input.task_id,
    query: input.query,
  });
}

function readIntentForSelectors(
  selectors: RetrievalSelector[],
  hasPersonalSelector: boolean,
): RetrievalRouteIntent {
  if (selectors.some((selector) => selector.kind === 'personal_episode')) {
    return 'personal_episode_lookup';
  }
  if (hasPersonalSelector) return 'personal_profile_lookup';
  if (selectors.some((selector) => selector.kind === 'task_working_set' || selector.kind === 'task_attempt' || selector.kind === 'task_decision')) {
    return 'task_resume';
  }
  return 'broad_synthesis';
}

function blockedByScopeGate(
  scopeGate: ScopeGateDecisionResult,
  selectors: RetrievalSelector[],
): ReadContextResult {
  const normalizedSelectors = selectors.map((selector) => normalizeRetrievalSelector(selector));
  return {
    answer_ready: {
      ready: false,
      answer_ground: [],
      unsupported_reasons: [`scope_gate_${scopeGate.policy}`],
      citation_policy: 'Do not read or answer from selectors blocked by scope gate.',
    },
    canonical_reads: [],
    evidence_claims: [],
    conflicts: [],
    warnings: scopeGate.summary_lines,
    unread_required: normalizedSelectors,
    continuations: [],
    scope_gate: scopeGate,
  };
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
    timelineEntryTarget(selector)?.slug,
    selector.object_id,
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

async function maybePersistReadTrace(
  engine: BrainEngine,
  result: ReadContextResult,
  input: ReadContextInput,
): Promise<ReadContextResult> {
  if (!input.persist_trace) return result;
  return {
    ...result,
    trace: await persistReadTrace(engine, result, input),
  };
}

async function persistReadTrace(
  engine: BrainEngine,
  result: ReadContextResult,
  input: ReadContextInput,
): Promise<RetrievalTrace> {
  const thread = input.task_id ? await engine.getTaskThread(input.task_id) : null;
  const scope: ScopeGateScope = result.scope_gate?.resolved_scope ?? thread?.scope ?? 'unknown';

  return engine.putRetrievalTrace({
    id: crypto.randomUUID(),
    task_id: thread ? input.task_id! : null,
    scope,
    route: ['read_context'],
    source_refs: result.canonical_reads.map((read) => retrievalSelectorId(read.selector)),
    derived_consulted: [],
    verification: [
      `answer_ready:${result.answer_ready.ready ? 'ready' : 'not_ready'}`,
      ...result.answer_ready.unsupported_reasons.map((reason) => `unsupported:${reason}`),
      ...buildScopeGateVerification(result.scope_gate),
    ],
    write_outcome: 'no_durable_write',
    selected_intent: intentFromReads(result.canonical_reads.map((read) => read.selector)),
    scope_gate_policy: result.scope_gate?.policy ?? null,
    scope_gate_reason: result.scope_gate?.decision_reason ?? null,
    outcome: result.answer_ready.ready
      ? 'read_context returned canonical evidence'
      : 'read_context could not return complete answer-ready evidence',
  });
}

function intentFromReads(selectors: RetrievalSelector[]): RetrievalRouteIntent {
  return readIntentForSelectors(selectors, selectors.some(hasPersonalSelectorSignal));
}

function buildScopeGateVerification(scopeGate: ScopeGateDecisionResult | undefined): string[] {
  if (!scopeGate) return [];
  return [
    `scope_gate:${scopeGate.policy}`,
    `scope_gate_reason:${scopeGate.decision_reason}`,
  ];
}

function assertPositiveInteger(value: number, key: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
}
