import type {
  BrainEngine,
} from '../engine.ts';
import type {
  MemoryCandidateTargetObjectType,
  MemoryCandidateStatus,
  MemoryCandidateType,
  Page,
  PageType,
} from '../types.ts';

export type DuplicateMemorySubjectKind = 'page' | 'memory_candidate' | 'proposed_memory';
export type DuplicateMemoryMatchKind = 'page' | 'memory_candidate';
export type DuplicateMemoryDecision = 'no_match' | 'possible_duplicate' | 'likely_duplicate' | 'same_target_update';

export interface DuplicateMemoryReviewInput {
  scope_id?: string;
  subject_kind: DuplicateMemorySubjectKind;
  subject_id?: string;
  title?: string;
  content: string;
  page_type?: PageType;
  tags?: string[];
  source_refs?: string[];
  candidate_type?: MemoryCandidateType;
  target_object_type?: MemoryCandidateTargetObjectType;
  target_object_id?: string;
  include_pages?: boolean;
  include_candidates?: boolean;
  candidate_statuses?: MemoryCandidateStatus[];
  exclude_ids?: string[];
  limit?: number;
}

export interface DuplicateMemoryReviewMatch {
  kind: DuplicateMemoryMatchKind;
  id: string;
  title?: string;
  score: number;
  reasons: string[];
}

export interface DuplicateMemoryReviewResult {
  decision: DuplicateMemoryDecision;
  matches: DuplicateMemoryReviewMatch[];
  decision_match?: DuplicateMemoryReviewMatch;
  thresholds: DuplicateMemoryReviewThresholds;
  summary_lines: string[];
}

export interface DuplicateMemoryReviewPreflightSummary {
  decision: DuplicateMemoryDecision;
  top_match?: {
    kind: DuplicateMemoryMatchKind;
    id: string;
    score: number;
    reasons: string[];
  };
}

export interface DuplicateMemoryReviewFreshness {
  pages: Array<{ id: string; updated_at: string }>;
  memory_candidates: Array<{ id: string; updated_at: string }>;
}

export interface DuplicateMemoryReviewThresholds {
  possible_duplicate: number;
  likely_duplicate: number;
  same_target_update: number;
}

export const DUPLICATE_MEMORY_REVIEW_CANDIDATE_STATUSES = [
  'captured',
  'candidate',
  'staged_for_review',
] as const satisfies readonly MemoryCandidateStatus[];

const THRESHOLDS: DuplicateMemoryReviewThresholds = {
  possible_duplicate: 0.45,
  likely_duplicate: 0.72,
  same_target_update: 0.35,
};
const SCAN_BATCH_SIZE = 100;
const FRESHNESS_BATCH_SIZE = 100;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'has',
  'in',
  'of',
  'should',
  'the',
  'to',
  'uses',
  'with',
]);

export async function reviewDuplicateMemory(
  engine: Pick<BrainEngine, 'listPages' | 'getTags' | 'listMemoryCandidateEntries'>,
  input: DuplicateMemoryReviewInput,
): Promise<DuplicateMemoryReviewResult> {
  const limit = normalizeLimit(input.limit);
  const candidateStatuses: readonly MemoryCandidateStatus[] = input.candidate_statuses
    ?? DUPLICATE_MEMORY_REVIEW_CANDIDATE_STATUSES;
  const pageExcludedIds = new Set(input.exclude_ids ?? []);
  const candidateExcludedIds = new Set(input.exclude_ids ?? []);
  if (input.subject_kind === 'page' && input.subject_id) {
    pageExcludedIds.add(input.subject_id);
  }
  if (input.subject_kind === 'memory_candidate' && input.subject_id) {
    candidateExcludedIds.add(input.subject_id);
  }
  const matches: DuplicateMemoryReviewMatch[] = [];

  if (input.include_pages !== false) {
    let offset = 0;
    while (true) {
      const pages = await engine.listPages({ limit: SCAN_BATCH_SIZE, offset });
      for (const page of pages) {
        if (pageExcludedIds.has(page.slug)) continue;
        if (input.page_type !== undefined && page.type !== input.page_type) continue;
        const tags = await engine.getTags(page.slug);
        const match = scorePage(input, page, tags);
        if (isMeaningfulMatch(match)) matches.push(match);
      }
      if (pages.length < SCAN_BATCH_SIZE) break;
      offset += SCAN_BATCH_SIZE;
    }
  }

  if (input.include_candidates !== false) {
    let offset = 0;
    while (true) {
      const candidates = await engine.listMemoryCandidateEntries({
        scope_id: input.scope_id,
        limit: SCAN_BATCH_SIZE,
        offset,
      });

      for (const candidate of candidates) {
        if (candidateExcludedIds.has(candidate.id)) continue;
        if (!candidateStatuses.includes(candidate.status)) continue;
        const match = scoreCandidate(input, candidate);
        if (isMeaningfulMatch(match)) matches.push(match);
      }
      if (candidates.length < SCAN_BATCH_SIZE) break;
      offset += SCAN_BATCH_SIZE;
    }
  }

  const allRankedMatches = matches
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.id.localeCompare(right.id);
    });
  const decisionResult = decide(allRankedMatches);
  const decision = decisionResult.decision;
  const returnedMatches = decision === 'no_match' ? [] : allRankedMatches.slice(0, limit);

  return {
    decision,
    matches: returnedMatches,
    ...(decisionResult.decision_match ? { decision_match: decisionResult.decision_match } : {}),
    thresholds: { ...THRESHOLDS },
    summary_lines: buildSummaryLines(decision, allRankedMatches),
  };
}

export function summarizeDuplicateReviewForPreflight(
  result: DuplicateMemoryReviewResult,
): DuplicateMemoryReviewPreflightSummary {
  const topMatch = selectPreflightTopMatch(result);
  return {
    decision: result.decision,
    ...(topMatch
      ? {
          top_match: {
            kind: topMatch.kind,
            id: topMatch.id,
            score: topMatch.score,
            reasons: topMatch.reasons,
          },
        }
      : {}),
  };
}

function selectPreflightTopMatch(
  result: DuplicateMemoryReviewResult,
): DuplicateMemoryReviewMatch | undefined {
  if (result.decision !== 'likely_duplicate') {
    return result.matches[0];
  }
  return result.decision_match ?? result.matches.find((match) => {
    return !isSameTargetMatch(match) && match.score >= result.thresholds.likely_duplicate;
  }) ?? result.matches[0];
}

export async function getDuplicateMemoryReviewFreshness(
  engine: Pick<BrainEngine, 'listPages' | 'listMemoryCandidateEntries'>,
  input: { scope_id?: string; limit?: number; candidate_statuses?: MemoryCandidateStatus[] },
): Promise<DuplicateMemoryReviewFreshness> {
  const limit = input.limit === undefined ? undefined : normalizeFreshnessLimit(input.limit);
  const candidateStatuses: readonly MemoryCandidateStatus[] = input.candidate_statuses
    ?? DUPLICATE_MEMORY_REVIEW_CANDIDATE_STATUSES;
  const [pages, memoryCandidates] = await Promise.all([
    listFreshnessPages(engine, { limit }),
    listFreshnessMemoryCandidates(engine, {
      scope_id: input.scope_id,
      limit,
      candidate_statuses: candidateStatuses,
    }),
  ]);

  return {
    pages,
    memory_candidates: memoryCandidates,
  };
}

export function duplicateMemoryReviewFreshnessEquals(
  left: DuplicateMemoryReviewFreshness,
  right: DuplicateMemoryReviewFreshness,
): boolean {
  return markerEntriesEqual(left.pages, right.pages)
    && markerEntriesEqual(left.memory_candidates, right.memory_candidates);
}

async function listFreshnessPages(
  engine: Pick<BrainEngine, 'listPages'>,
  input: { limit?: number },
): Promise<Array<{ id: string; updated_at: string }>> {
  if (input.limit === 0) return [];
  const batchSize = input.limit ?? FRESHNESS_BATCH_SIZE;
  const pages: Array<{ id: string; updated_at: string }> = [];
  let offset = 0;
  while (true) {
    const batch = await engine.listPages({
      limit: batchSize,
      offset,
    });
    pages.push(...batch.map((page) => ({
      id: page.slug,
      updated_at: page.updated_at.toISOString(),
    })));
    if (input.limit !== undefined || batch.length < batchSize) break;
    offset += batchSize;
  }
  return sortAndLimitFreshnessMarkers(pages, input.limit);
}

async function listFreshnessMemoryCandidates(
  engine: Pick<BrainEngine, 'listMemoryCandidateEntries'>,
  input: {
    scope_id?: string;
    limit?: number;
    candidate_statuses: readonly MemoryCandidateStatus[];
  },
): Promise<Array<{ id: string; updated_at: string }>> {
  if (input.limit === 0) return [];
  const batches = await Promise.all(input.candidate_statuses.map(async (status) => {
    const batchSize = input.limit ?? FRESHNESS_BATCH_SIZE;
    const candidates: Array<{ id: string; updated_at: string }> = [];
    let offset = 0;
    while (true) {
      const batch = await engine.listMemoryCandidateEntries({
        scope_id: input.scope_id,
        status,
        limit: batchSize,
        offset,
      });
      candidates.push(...batch.map((candidate) => ({
        id: candidate.id,
        updated_at: candidate.updated_at.toISOString(),
      })));
      if (input.limit !== undefined || batch.length < batchSize) break;
      offset += batchSize;
    }
    return candidates;
  }));
  return sortAndLimitFreshnessMarkers(batches.flat(), input.limit);
}

function sortAndLimitFreshnessMarkers(
  markers: Array<{ id: string; updated_at: string }>,
  limit: number | undefined,
): Array<{ id: string; updated_at: string }> {
  const sorted = markers.sort((left, right) => {
    const updatedAtDelta = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    if (updatedAtDelta !== 0) return updatedAtDelta;
    return left.id.localeCompare(right.id);
  });
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

function scorePage(
  input: DuplicateMemoryReviewInput,
  page: Page,
  tags: string[],
): DuplicateMemoryReviewMatch {
  const contentScore = tokenOverlap(input.content, pageText(page));
  const titleScore = tokenOverlap(input.title ?? '', page.title);
  const tagScore = setOverlap(input.tags ?? [], tags);
  const sourceScore = setOverlap(input.source_refs ?? [], sourceRefsFromPage(page));
  const sameTarget = input.target_object_id !== undefined && input.target_object_id === page.slug;
  const score = roundScore(
    (contentScore * 0.65)
      + (titleScore * 0.2)
      + (tagScore * 0.15)
      + (sourceScore * 0.1)
      + (sameTarget ? 0.5 : 0),
  );
  const reasons = buildReasons([
    [contentScore >= 0.35, 'content overlap'],
    [titleScore >= 0.5, 'title overlap'],
    [tagScore > 0, 'shared tags'],
    [sourceScore > 0, 'shared source refs'],
    [sameTarget, 'same target object'],
  ]);

  return {
    kind: 'page',
    id: page.slug,
    title: page.title,
    score,
    reasons,
  };
}

function scoreCandidate(
  input: DuplicateMemoryReviewInput,
  candidate: Awaited<ReturnType<BrainEngine['listMemoryCandidateEntries']>>[number],
): DuplicateMemoryReviewMatch {
  const contentScore = tokenOverlap(input.content, candidate.proposed_content);
  const sourceScore = setOverlap(input.source_refs ?? [], candidate.source_refs);
  const sameTarget = Boolean(
    input.target_object_type
      && input.target_object_id
      && candidate.target_object_type === input.target_object_type
      && candidate.target_object_id === input.target_object_id,
  );
  const sameType = input.candidate_type !== undefined && input.candidate_type === candidate.candidate_type;
  const score = roundScore(
    (contentScore * 0.55)
      + (sourceScore * 0.15)
      + (sameTarget ? 0.5 : 0)
      + (sameType ? 0.05 : 0),
  );
  const reasons = buildReasons([
    [contentScore >= 0.35, 'content overlap'],
    [sourceScore > 0, 'shared source refs'],
    [sameTarget, 'same target object'],
    [sameType, 'same candidate type'],
  ]);

  return {
    kind: 'memory_candidate',
    id: candidate.id,
    score,
    reasons,
  };
}

interface DuplicateMemoryDecisionResult {
  decision: DuplicateMemoryDecision;
  decision_match?: DuplicateMemoryReviewMatch;
}

function decide(matches: DuplicateMemoryReviewMatch[]): DuplicateMemoryDecisionResult {
  const likelyDuplicate = matches.find((match) => !isSameTargetMatch(match) && match.score >= THRESHOLDS.likely_duplicate);
  if (likelyDuplicate) {
    return {
      decision: 'likely_duplicate',
      decision_match: likelyDuplicate,
    };
  }

  const topMatch = matches[0];
  if (!topMatch) return { decision: 'no_match' };
  if (isSameTargetMatch(topMatch) && topMatch.score >= THRESHOLDS.same_target_update) {
    return {
      decision: 'same_target_update',
      decision_match: topMatch,
    };
  }
  if (topMatch.score >= THRESHOLDS.likely_duplicate) {
    return {
      decision: 'likely_duplicate',
      decision_match: topMatch,
    };
  }
  if (topMatch.score >= THRESHOLDS.possible_duplicate) {
    return {
      decision: 'possible_duplicate',
      decision_match: topMatch,
    };
  }
  return { decision: 'no_match' };
}

function isMeaningfulMatch(match: DuplicateMemoryReviewMatch): boolean {
  return match.score >= THRESHOLDS.possible_duplicate
    || (isSameTargetMatch(match) && match.score >= THRESHOLDS.same_target_update);
}

function isSameTargetMatch(match: DuplicateMemoryReviewMatch): boolean {
  return match.reasons.includes('same target object');
}

function buildSummaryLines(
  decision: DuplicateMemoryDecision,
  matches: DuplicateMemoryReviewMatch[],
): string[] {
  const topMatch = matches[0];
  if (!topMatch) return [`Duplicate review decision: ${decision}.`];
  return [
    `Duplicate review decision: ${decision}.`,
    `Top match: ${topMatch.kind}:${topMatch.id} score ${topMatch.score}.`,
  ];
}

function pageText(page: Page): string {
  return [
    page.title,
    page.compiled_truth,
    page.timeline,
  ].filter(Boolean).join('\n');
}

function sourceRefsFromPage(page: Page): string[] {
  const sourceRefs = page.frontmatter.source_refs;
  return Array.isArray(sourceRefs) ? sourceRefs.filter((value): value is string => typeof value === 'string') : [];
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / new Set([...leftTokens, ...rightTokens]).size;
}

function setOverlap(left: readonly string[], right: readonly string[]): number {
  const leftValues = normalizeSet(left);
  const rightValues = normalizeSet(right);
  if (leftValues.size === 0 || rightValues.size === 0) return 0;
  let shared = 0;
  for (const value of leftValues) {
    if (rightValues.has(value)) shared += 1;
  }
  return shared / new Set([...leftValues, ...rightValues]).size;
}

function tokenize(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

function normalizeSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function buildReasons(entries: Array<[boolean, string]>): string[] {
  return entries.filter(([include]) => include).map(([, reason]) => reason);
}

function roundScore(value: number): number {
  return Number(Math.min(1, value).toFixed(6));
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 5;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeFreshnessLimit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function markerEntriesEqual(
  left: Array<{ id: string; updated_at: string }>,
  right: Array<{ id: string; updated_at: string }>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return other !== undefined
      && entry.id === other.id
      && entry.updated_at === other.updated_at;
  });
}
