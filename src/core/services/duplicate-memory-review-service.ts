import type {
  BrainEngine,
} from '../engine.ts';
import type {
  MemoryCandidateTargetObjectType,
  MemoryCandidateType,
  Page,
} from '../types.ts';

export type DuplicateMemorySubjectKind = 'proposed_memory' | 'memory_candidate';
export type DuplicateMemoryMatchKind = 'page' | 'candidate';
export type DuplicateMemoryDecision = 'no_match' | 'possible_duplicate' | 'likely_duplicate' | 'same_target_update';

export interface DuplicateMemoryReviewInput {
  scope_id?: string;
  subject_kind: DuplicateMemorySubjectKind;
  subject_id?: string;
  title?: string;
  content: string;
  tags?: string[];
  source_refs?: string[];
  candidate_type?: MemoryCandidateType;
  target_object_type?: MemoryCandidateTargetObjectType;
  target_object_id?: string;
  include_pages?: boolean;
  include_candidates?: boolean;
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

interface DuplicateMemoryReviewThresholds {
  possible_duplicate: number;
  likely_duplicate: number;
  same_target_update: number;
}

const THRESHOLDS: DuplicateMemoryReviewThresholds = {
  possible_duplicate: 0.45,
  likely_duplicate: 0.72,
  same_target_update: 0.35,
};

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
  const limit = input.limit ?? 5;
  const excludedIds = new Set([input.subject_id, ...(input.exclude_ids ?? [])].filter(Boolean));
  const matches: DuplicateMemoryReviewMatch[] = [];

  if (input.include_pages !== false) {
    const pages = await engine.listPages({ limit, offset: 0 });
    for (const page of pages) {
      if (excludedIds.has(page.slug)) continue;
      const tags = await engine.getTags(page.slug);
      const match = scorePage(input, page, tags);
      if (isMeaningfulMatch(match)) matches.push(match);
    }
  }

  if (input.include_candidates !== false) {
    const candidates = await engine.listMemoryCandidateEntries({
      scope_id: input.scope_id,
      limit,
      offset: 0,
    });

    for (const candidate of candidates) {
      if (excludedIds.has(candidate.id)) continue;
      const match = scoreCandidate(input, candidate);
      if (isMeaningfulMatch(match)) matches.push(match);
    }
  }

  const rankedMatches = matches
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.id.localeCompare(right.id);
    })
    .slice(0, limit);
  const decision = decide(rankedMatches);

  return {
    decision,
    matches: decision === 'no_match' ? [] : rankedMatches,
    thresholds: THRESHOLDS,
    summary_lines: buildSummaryLines(decision, rankedMatches),
  };
}

export function summarizeDuplicateReviewForPreflight(
  result: DuplicateMemoryReviewResult,
): DuplicateMemoryReviewPreflightSummary {
  const topMatch = result.matches[0];
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

function scorePage(
  input: DuplicateMemoryReviewInput,
  page: Page,
  tags: string[],
): DuplicateMemoryReviewMatch {
  const contentScore = tokenOverlap(input.content, pageText(page));
  const titleScore = tokenOverlap(input.title ?? '', page.title);
  const tagScore = setOverlap(input.tags ?? [], tags);
  const sourceScore = setOverlap(input.source_refs ?? [], sourceRefsFromPage(page));
  const score = roundScore((contentScore * 0.65) + (titleScore * 0.2) + (tagScore * 0.15) + (sourceScore * 0.1));
  const reasons = buildReasons([
    [contentScore >= 0.35, 'content overlap'],
    [titleScore >= 0.5, 'title overlap'],
    [tagScore > 0, 'shared tags'],
    [sourceScore > 0, 'shared source refs'],
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
    kind: 'candidate',
    id: candidate.id,
    score,
    reasons,
  };
}

function decide(matches: DuplicateMemoryReviewMatch[]): DuplicateMemoryDecision {
  const topMatch = matches[0];
  if (!topMatch) return 'no_match';
  if (topMatch.reasons.includes('same target object') && topMatch.score >= THRESHOLDS.same_target_update) {
    return 'same_target_update';
  }
  if (topMatch.score >= THRESHOLDS.likely_duplicate) return 'likely_duplicate';
  if (topMatch.score >= THRESHOLDS.possible_duplicate) return 'possible_duplicate';
  return 'no_match';
}

function isMeaningfulMatch(match: DuplicateMemoryReviewMatch): boolean {
  return match.score >= THRESHOLDS.possible_duplicate
    || (match.reasons.includes('same target object') && match.score >= THRESHOLDS.same_target_update);
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
