import type { BrainEngine } from '../engine.ts';
import type {
  CanonicalContextRead,
  ContextAnswerReady,
  ContextEvidenceClaim,
  DerivedJobStatus,
  MemoryArtifactAuthority,
  PageTextWindow,
  ReadContextInput,
  ReadContextResult,
  RetrievalRouteIntent,
  RetrievalSelector,
  RetrievalSelectorWarning,
  RetrievalTrace,
  ScopeGateDecisionResult,
  ScopeGateScope,
} from '../types.ts';
import { scalarLength, sliceScalars } from '../text-offsets.ts';
import {
  corpusLaneFromSourceRefs,
  extractFrontmatterSourceRefs,
  laneOnlySourceRefs,
  mergeSourceRefs,
} from './corpus-lane-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { normalizeRetrievalSelector, retrievalSelectorId } from './retrieval-selector-service.ts';
import { retrieveContext } from './retrieve-context-service.ts';
import { evaluateScopeGate } from './scope-gate-service.ts';
import { listAllNoteSectionEntries } from './structural-entry-pagination.ts';
import { pathToSlug } from '../sync.ts';

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

class StaleSelectorReadError extends Error {
  constructor(readonly warning: RetrievalSelectorWarning) {
    super(warning.message);
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
  const selectorWarnings: RetrievalSelectorWarning[] = [];
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
      if (error instanceof StaleSelectorReadError) {
        selectorWarnings.push(error.warning);
        unreadRequired.push(error.warning.selector);
        warnings.push(`${error.warning.code}: ${error.warning.message}`);
        continue;
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
    answer_ready: buildAnswerReady(reads, unreadRequired, warnings, selectorWarnings),
    canonical_reads: reads,
    evidence_claims: reads.map(buildEvidenceClaim),
    conflicts: [],
    warnings,
    ...(selectorWarnings.length > 0 ? { selector_warnings: selectorWarnings } : {}),
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
  const shouldIncludeTimeline = includePageTimeline && options.include_timeline === 'include';
  if (!shouldIncludeTimeline) {
    return readProjectedPageField(engine, selector, options, 'compiled_truth');
  }

  return readProjectedPageWithTimeline(engine, selector, options);
}

async function readSection(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.section_id) return null;
  const scopeId = selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const section = await engine.getNoteSectionEntry(scopeId, selector.section_id);
  if (!section) {
    await assertNoteSectionsDerivedCurrent(engine, selector, selectorPageSlug(selector), undefined, scopeId);
    await assertStaleIfCurrentPageHashChanged(engine, selector);
    return null;
  }
  const projection = await currentPageProjectionOrStale(engine, selector, section.page_slug);
  if (!projection) return null;
  await assertNoteSectionsDerivedCurrent(engine, selector, section.page_slug, projection.content_hash, scopeId);

  return buildRead({
    selector: normalizeRetrievalSelector({
      ...selector,
      slug: section.page_slug,
      path: section.page_path,
      line_start: section.line_start,
      line_end: section.line_end,
      source_refs: section.source_refs,
      content_hash: projection.content_hash,
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
  const span = await engine.getPageLineSpanProjection(selector.slug, {
    line_start: selector.line_start,
    line_end: selector.line_end,
  });
  if (!span) {
    assertCurrentContentHash(selector, undefined, selector.slug);
    return null;
  }
  assertCurrentContentHash(selector, span.content_hash, span.slug);

  const text = span.text.trim();
  if (!text) return null;

  return buildRead({
    selector: selectorWithCurrentContentHash(selector, span.content_hash),
    title: span.title,
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
  const projectedRead = await readProjectedPageField(engine, selector, options, 'timeline');
  if (projectedRead || selector.char_start !== undefined || selector.char_end !== undefined) {
    return projectedRead;
  }

  const initialProjection = await currentPageProjectionOrStale(engine, selector, selector.slug);
  if (!initialProjection) return null;
  const entries = await engine.getTimeline(selector.slug);
  if (entries.length === 0) return null;
  const finalProjection = await currentPageProjectionOrStale(engine, {
    ...selector,
    content_hash: initialProjection.content_hash,
  }, selector.slug);
  if (!finalProjection) return null;

  const text = entries
    .map((entry) => {
      const source = entry.source.trim() ? ` [Source: ${entry.source.trim()}]` : '';
      return `- **${entry.date}** | ${entry.summary}${source}${entry.detail ? `\n  ${entry.detail}` : ''}`;
    })
    .join('\n');

  return buildRead({
    selector: selectorWithCurrentContentHash(selector, initialProjection.content_hash),
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
  if (matches.length !== 1) {
    const scopeId = selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
    await assertNoteSectionsDerivedCurrent(
      engine,
      selector,
      await selectorPageSlugForSourceRefFreshness(engine, selector, sections, scopeId),
      undefined,
      scopeId,
    );
    await assertStaleIfCurrentPageHashChanged(engine, selector);
    return null;
  }
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
    content_hash: selector.content_hash,
  }, options);
}

async function readProjectedPageField(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
  field: 'compiled_truth' | 'timeline',
): Promise<CanonicalContextRead | null> {
  if (!selector.slug) return null;
  const charStart = selector.char_start ?? 0;
  const charLimit = projectionCharLimit(selector, options.token_budget);
  const projection = await engine.getPageProjection(selector.slug, {
    windows: {
      [field]: { char_start: charStart, char_limit: charLimit },
    },
  });
  if (!projection) {
    assertCurrentContentHash(selector, undefined, selector.slug);
    return null;
  }
  assertCurrentContentHash(selector, projection.content_hash, projection.slug);

  const window = projection.content_windows[field];
  if (!window || window.returned_chars === 0) return null;

  return buildWindowRead({
    selector: selectorWithCurrentContentHash(selector, projection.content_hash),
    title: field === 'timeline' ? `Timeline: ${projection.slug}` : projection.title,
    window,
    authority: field === 'timeline' ? 'source_or_timeline_evidence' : 'canonical_compiled_truth',
    source_refs: options.include_source_refs
      ? mergeSourceRefs(extractSourceRefs(window.text), extractFrontmatterSourceRefs(projection.frontmatter))
      : [],
    include_source_refs: options.include_source_refs,
    token_budget: options.token_budget,
  });
}

async function readProjectedPageWithTimeline(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: Pick<ReadSelectorOptions, 'token_budget' | 'include_source_refs'>,
): Promise<CanonicalContextRead | null> {
  if (!selector.slug) return null;
  if (selector.char_start !== undefined || selector.char_end !== undefined) {
    return readProjectedPageField(engine, selector, options, 'compiled_truth');
  }

  const charBudget = Math.max(1, options.token_budget * CHARS_PER_TOKEN_ESTIMATE);
  const projection = await engine.getPageProjection(selector.slug, {
    windows: {
      compiled_truth: { char_start: 0, char_limit: charBudget },
      timeline: { char_start: 0, char_limit: charBudget },
    },
  });
  if (!projection) {
    assertCurrentContentHash(selector, undefined, selector.slug);
    return null;
  }
  assertCurrentContentHash(selector, projection.content_hash, projection.slug);

  const compiledWindow = projection.content_windows.compiled_truth;
  if (!compiledWindow) return null;
  const normalizedSelector = normalizeRetrievalSelector(
    selectorWithCurrentContentHash(selector, projection.content_hash),
  );
  const sourceRefs: string[] = [];
  let text = compiledWindow.text.trim();
  if (options.include_source_refs && text) {
    sourceRefs.push(...mergeSourceRefs(
      extractSourceRefs(text),
      extractFrontmatterSourceRefs(projection.frontmatter),
    ));
  }

  let continuation = compiledWindow.has_more
    ? pageFieldContinuationSelector(normalizedSelector, 'compiled_truth', compiledWindow.next_char_start)
    : undefined;

  if (!continuation) {
    const separator = text ? '\n\n---\n\n' : '';
    const remainingChars = charBudget - scalarLength(text) - scalarLength(separator);
    const timelineWindow = projection.content_windows.timeline;
    if (timelineWindow && timelineWindow.total_chars > 0) {
      if (remainingChars <= 0) {
        continuation = pageFieldContinuationSelector(normalizedSelector, 'timeline_range', 0);
      } else {
        const timelineText = sliceScalars(timelineWindow.text, 0, remainingChars).trim();
        const returnedTimelineChars = scalarLength(timelineText);
        if (timelineText) {
          text = `${text}${separator}${timelineText}`;
          if (options.include_source_refs) sourceRefs.push(...extractSourceRefs(timelineText));
        }
        if (returnedTimelineChars < timelineWindow.total_chars) {
          continuation = pageFieldContinuationSelector(normalizedSelector, 'timeline_range', returnedTimelineChars);
        }
      }
    }
  }

  if (!text) return null;
  return {
    selector: normalizedSelector,
    authority: 'canonical_compiled_truth',
    title: projection.title,
    text,
    source_refs: options.include_source_refs ? mergeSourceRefs(sourceRefs) : [],
    corpus_lane: corpusLaneFromSourceRefs(sourceRefs),
    token_estimate: estimateTokens(text),
    has_more: continuation !== undefined,
    continuation_selector: continuation,
  };
}

function pageFieldContinuationSelector(
  selector: RetrievalSelector,
  kind: 'compiled_truth' | 'timeline_range',
  nextCharStart: number | null,
): RetrievalSelector | undefined {
  if (nextCharStart === null) return undefined;
  return normalizeRetrievalSelector({
    kind,
    slug: selector.slug,
    scope_id: selector.scope_id,
    char_start: nextCharStart,
    content_hash: selector.content_hash,
  });
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
    authority: 'profile_memory',
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
    authority: 'personal_episode',
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
  const hasMore = clipped.consumed_chars < scalarLength(selectedText);
  const continuation = hasMore
    ? buildContinuationSelector(selector, clipped.consumed_chars)
    : undefined;
  const sourceRefs = !input.include_source_refs
    ? []
    : textHasSourceMarkers(input.text)
      ? mergeSourceRefs(extractSourceRefs(clipped.text), laneOnlySourceRefs(input.source_refs))
      : input.source_refs;
  const corpusLane = corpusLaneFromSourceRefs(sourceRefs);

  return {
    selector,
    authority: input.authority,
    title: input.title,
    text: clipped.text,
    source_refs: mergeSourceRefs(sourceRefs),
    ...(corpusLane ? { corpus_lane: corpusLane } : {}),
    token_estimate: estimateTokens(clipped.text),
    has_more: hasMore,
    continuation_selector: continuation,
  };
}

function buildWindowRead(input: {
  selector: RetrievalSelector;
  title: string;
  window: PageTextWindow;
  authority: MemoryArtifactAuthority;
  source_refs: string[];
  include_source_refs: boolean;
  token_budget: number;
}): CanonicalContextRead | null {
  const selector = normalizeRetrievalSelector(input.selector);
  const clipped = clipToBudget(input.window.text, input.token_budget);
  if (!clipped.text.trim()) return null;

  const absoluteCharStart = input.window.char_start + clipped.consumed_chars;
  const effectiveCharEnd = Math.min(selector.char_end ?? input.window.total_chars, input.window.total_chars);
  const hasMore = absoluteCharStart < effectiveCharEnd;
  const continuation = hasMore
    ? buildContinuationSelector(selector, clipped.consumed_chars)
    : undefined;
  const sourceRefs = !input.include_source_refs
    ? []
    : textHasSourceMarkers(input.window.text)
      ? mergeSourceRefs(extractSourceRefs(clipped.text), laneOnlySourceRefs(input.source_refs))
      : input.source_refs;
  const corpusLane = corpusLaneFromSourceRefs(sourceRefs);

  return {
    selector,
    authority: input.authority,
    title: input.title,
    text: clipped.text,
    source_refs: mergeSourceRefs(sourceRefs),
    ...(corpusLane ? { corpus_lane: corpusLane } : {}),
    token_estimate: estimateTokens(clipped.text),
    has_more: hasMore,
    continuation_selector: continuation,
  };
}

function applyCharRange(text: string, selector: RetrievalSelector): string | null {
  const charStart = selector.char_start ?? 0;
  const textLength = scalarLength(text);
  const charEnd = Math.min(selector.char_end ?? textLength, textLength);
  if (charStart >= textLength || charEnd <= charStart) return null;
  return sliceScalars(text, charStart, charEnd);
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
  selectorWarnings: RetrievalSelectorWarning[] = [],
): ContextAnswerReady {
  if (reads.length === 0) {
    return {
      ready: false,
      answer_ground: [],
      unsupported_reasons: unreadRequired.length > 0
        ? ['no_canonical_selector_read', ...selectorWarningCodes(selectorWarnings)]
        : ['no_selectors_requested'],
      citation_policy: 'Do not answer from chunks or derived orientation alone.',
    };
  }
  const hasContinuation = reads.some((read) => read.has_more);
  if (unreadRequired.length > 0 || hasContinuation) {
    const unsupportedReasons = [
      ...(unreadRequired.length > 0 ? ['required_selectors_unread', ...selectorWarningCodes(selectorWarnings), ...warnings] : []),
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

function selectorWarningCodes(selectorWarnings: RetrievalSelectorWarning[]): string[] {
  return [...new Set(selectorWarnings.map((warning) => warning.code))];
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
  return Math.max(1, Math.ceil(scalarLength(text) / CHARS_PER_TOKEN_ESTIMATE));
}

function clipToBudget(text: string, tokenBudget: number): { text: string; consumed_chars: number } {
  const maxChars = Math.max(1, tokenBudget * CHARS_PER_TOKEN_ESTIMATE);
  const textLength = scalarLength(text);
  if (textLength <= maxChars) return { text, consumed_chars: textLength };
  return { text: sliceScalars(text, 0, maxChars), consumed_chars: maxChars };
}

function projectionCharLimit(selector: RetrievalSelector, tokenBudget: number): number {
  const charStart = selector.char_start ?? 0;
  const budgetLimit = Math.max(1, tokenBudget * CHARS_PER_TOKEN_ESTIMATE);
  if (selector.char_end !== undefined) {
    return Math.max(1, Math.min(selector.char_end - charStart, budgetLimit));
  }
  return budgetLimit;
}

function selectorWithCurrentContentHash(selector: RetrievalSelector, contentHash: string | undefined): RetrievalSelector {
  return contentHash ? { ...selector, content_hash: contentHash } : selector;
}

function assertCurrentContentHash(
  selector: RetrievalSelector,
  currentContentHash: string | undefined,
  slug?: string,
): void {
  if (!selector.content_hash || selector.content_hash === currentContentHash) return;
  const staleSelector = normalizeRetrievalSelector({
    ...selector,
    freshness: 'stale',
  });
  const code = selector.char_start !== undefined || selector.char_end !== undefined
    ? 'stale_continuation'
    : 'stale_selector';
  throw new StaleSelectorReadError({
    code,
    severity: 'warning',
    selector_id: staleSelector.selector_id!,
    selector: staleSelector,
    slug,
    expected_content_hash: selector.content_hash,
    current_content_hash: currentContentHash ?? null,
    message: `Selector ${staleSelector.selector_id} expected content_hash ${selector.content_hash}, but current content_hash is ${currentContentHash ?? 'null'}. Start a fresh read from the current page snapshot.`,
  });
}

async function assertStaleIfCurrentPageHashChanged(
  engine: BrainEngine,
  selector: RetrievalSelector,
): Promise<void> {
  const slug = selectorPageSlug(selector);
  if (!selector.content_hash || !slug) return;
  const projection = await engine.getPageProjection(slug);
  if (!projection) {
    assertCurrentContentHash(selector, undefined, slug);
    return;
  }
  assertCurrentContentHash(selector, projection.content_hash, projection.slug);
}

async function currentPageProjectionOrStale(
  engine: BrainEngine,
  selector: RetrievalSelector,
  slug: string,
) {
  const projection = await engine.getPageProjection(slug);
  if (!projection) {
    assertCurrentContentHash(selector, undefined, slug);
    return null;
  }
  assertCurrentContentHash(selector, projection.content_hash, projection.slug);
  return projection;
}

async function assertNoteSectionsDerivedCurrent(
  engine: BrainEngine,
  selector: RetrievalSelector,
  slug: string | undefined,
  knownContentHash?: string,
  scopeId = DEFAULT_NOTE_MANIFEST_SCOPE_ID,
): Promise<void> {
  if (!slug) return;
  const projection = knownContentHash === undefined
    ? await engine.getPageProjection(slug)
    : { slug, content_hash: knownContentHash };
  if (!projection) {
    assertCurrentContentHash(selector, undefined, slug);
    return;
  }
  const state = await engine.getDerivedIndexState(
    scopeId,
    projection.slug,
    'note_sections',
  );
  if (!state) return;

  const currentContentHash = projection.content_hash ?? null;
  const current = state.status === 'ready'
    && state.target_content_hash === currentContentHash
    && state.indexed_content_hash === currentContentHash;
  if (current) return;

  const code = state.status === 'failed' ? 'derived_failed' : 'derived_pending';
  const selectorForWarning = { ...selector };
  delete selectorForWarning.selector_id;
  const warningSelector = normalizeRetrievalSelector({
    ...selectorForWarning,
    slug: projection.slug,
    freshness: 'stale',
  });
  throw new StaleSelectorReadError({
    code,
    severity: 'warning',
    selector_id: warningSelector.selector_id!,
    selector: warningSelector,
    slug: projection.slug,
    expected_content_hash: state.target_content_hash,
    current_content_hash: state.indexed_content_hash,
    message: `Selector ${warningSelector.selector_id} depends on note_sections, but the derived index is ${state.status} for ${projection.slug}. Refresh derived storage before treating section/source_ref reads as current evidence.`,
  });
}

function selectorPageSlug(
  selector: RetrievalSelector,
  sections?: ReadonlyArray<{ page_path: string; page_slug: string }>,
): string | undefined {
  if (selector.slug) return selector.slug;
  const sectionIdSlug = selector.section_id?.split('#')[0]?.trim();
  if (sectionIdSlug) return sectionIdSlug;
  const targetPath = selector.path?.split('#')[0]?.trim();
  if (targetPath) {
    const section = sections?.find((entry) => entry.page_path === targetPath);
    if (section?.page_slug) return section.page_slug;
    const pathSlug = pathToSlug(targetPath);
    if (pathSlug) return pathSlug;
  }
  return undefined;
}

async function selectorPageSlugForSourceRefFreshness(
  engine: BrainEngine,
  selector: RetrievalSelector,
  sections: ReadonlyArray<{ page_path: string; page_slug: string }>,
  scopeId: string,
): Promise<string | undefined> {
  const targetPath = selector.path?.split('#')[0]?.trim();
  if (!targetPath) return selectorPageSlug(selector, sections);
  if (selector.slug || selector.section_id) return selectorPageSlug(selector, sections);

  const sectionSlug = sections.find((entry) => entry.page_path === targetPath)?.page_slug;
  if (sectionSlug) return sectionSlug;

  const jobSlug = await derivedJobSlugForManifestPath(engine, scopeId, targetPath);
  if (jobSlug) return jobSlug;

  return selectorPageSlug(selector, sections);
}

async function derivedJobSlugForManifestPath(
  engine: BrainEngine,
  scopeId: string,
  manifestPath: string,
): Promise<string | undefined> {
  const statuses: DerivedJobStatus[] = ['pending', 'running', 'failed'];
  const limit = 100;
  for (const status of statuses) {
    let offset = 0;
    while (true) {
      const jobs = await engine.listDerivedJobs({
        scope_id: scopeId,
        artifact_kind: 'note_sections',
        status,
        limit,
        offset,
      });
      const match = jobs.find((job) => job.manifest_path === manifestPath);
      if (match) return match.slug;
      if (jobs.length < limit) break;
      offset += jobs.length;
    }
  }
  return undefined;
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
    source_refs: traceSourceRefs(result.canonical_reads),
    derived_consulted: [],
    verification: [
      `answer_ready:${result.answer_ready.ready ? 'ready' : 'not_ready'}`,
      ...result.answer_ready.unsupported_reasons.map((reason) => `unsupported:${reason}`),
      ...buildScopeGateVerification(result.scope_gate),
      ...corpusLaneVerification(result.canonical_reads.map((read) => read.corpus_lane)),
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

function traceSourceRefs(reads: CanonicalContextRead[]): string[] {
  return mergeSourceRefs(
    reads.map((read) => retrievalSelectorId(read.selector)),
    reads.flatMap((read) => read.source_refs),
  );
}

function corpusLaneVerification(lanes: Array<CanonicalContextRead['corpus_lane']>): string[] {
  return mergeSourceRefs(lanes
    .filter((lane): lane is NonNullable<CanonicalContextRead['corpus_lane']> => lane !== undefined)
    .map((lane) => `corpus_lane:${lane.lane_id}:post_scope_metadata`));
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
