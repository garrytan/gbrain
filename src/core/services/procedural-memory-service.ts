import { randomUUID } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type {
  MemoryCandidateSensitivity,
  MemoryWritebackDecision,
  PersonalEpisodeEntry,
  TaskAttempt,
  TaskDecision,
} from '../types.ts';
import {
  DUPLICATE_MEMORY_REVIEW_CANDIDATE_STATUSES,
  type DuplicateMemoryReviewPreflightSummary,
  reviewDuplicateMemory,
  summarizeDuplicateReviewForPreflight,
} from './duplicate-memory-review-service.ts';
import { createMemoryCandidateEntryWithStatusEvent } from './memory-inbox-service.ts';
import { routeMemoryWriteback } from './memory-writeback-router-service.ts';

export type ProceduralPatternKind = 'task_decision' | 'attempt_failure_fix' | 'episode';

export interface ProceduralRuleProposal {
  pattern_kind: ProceduralPatternKind;
  rule_text: string;
  normalized_signal: string;
  occurrences: number;
  source_refs: string[];
  recurrence_score: number;
  sensitivity: Extract<MemoryCandidateSensitivity, 'work' | 'personal'>;
}

export interface DetectProceduralPatternsOptions {
  window_days?: number;
  min_occurrences?: number;
  limit?: number;
  now?: Date | string | null;
}

export interface ProceduralPatternDetectionResult {
  generated_at: string;
  window_days: number;
  min_occurrences: number;
  limit: number;
  scanned: {
    tasks: number;
    decisions: number;
    attempts: number;
    episodes: number;
  };
  proposals: ProceduralRuleProposal[];
  summary_lines: string[];
}

export type ProceduralProposalAction = 'created' | 'planned' | 'skipped_duplicate' | 'not_routable';

export interface ProceduralProposalOutcome {
  pattern_kind: ProceduralPatternKind;
  rule_text: string;
  occurrences: number;
  action: ProceduralProposalAction;
  candidate_id: string | null;
  route_decision: MemoryWritebackDecision | null;
  duplicate_review: DuplicateMemoryReviewPreflightSummary | null;
}

export interface ProposeProceduralCandidatesOptions {
  apply?: boolean;
  scope_id?: string;
}

export interface ProposeProceduralCandidatesResult {
  apply: boolean;
  considered: number;
  created: number;
  planned: number;
  skipped_duplicates: number;
  not_routable: number;
  outcomes: ProceduralProposalOutcome[];
  summary_lines: string[];
}

export const PROCEDURAL_RULE_MAX_LENGTH = 200;

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_MIN_OCCURRENCES = 3;
const MIN_MIN_OCCURRENCES = 2;
const DEFAULT_PROPOSAL_LIMIT = 10;
const MAX_PROPOSAL_LIMIT = 50;
const MAX_TASKS_SCANNED = 200;
const MAX_ITEMS_PER_TASK = 100;
const MAX_EPISODES_SCANNED = 500;
const MAX_SOURCE_REFS_PER_PROPOSAL = 24;
const MAX_OPEN_PROCEDURE_SCAN_BATCH = 100;
const DEFAULT_PROPOSAL_SCOPE_ID = 'workspace:default';
const PERSONAL_PROPOSAL_SCOPE_ID = 'personal:default';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type ProceduralDetectionEngine = Partial<
  Pick<BrainEngine, 'listTaskThreads' | 'listTaskDecisions' | 'listTaskAttempts' | 'listPersonalEpisodeEntries'>
>;

interface PatternGroup {
  pattern_kind: ProceduralPatternKind;
  normalized_signal: string;
  rule_text: string;
  occurrences: number;
  distinct_group_keys: Set<string>;
  source_refs: Set<string>;
  sensitivity: ProceduralRuleProposal['sensitivity'];
}

export async function detectProceduralPatterns(
  engine: ProceduralDetectionEngine,
  options: DetectProceduralPatternsOptions = {},
): Promise<ProceduralPatternDetectionResult> {
  const windowDays = normalizeBoundedInteger(options.window_days, DEFAULT_WINDOW_DAYS, 1, MAX_WINDOW_DAYS, 'window_days');
  const minOccurrences = normalizeBoundedInteger(
    options.min_occurrences,
    DEFAULT_MIN_OCCURRENCES,
    MIN_MIN_OCCURRENCES,
    100,
    'min_occurrences',
  );
  const limit = normalizeBoundedInteger(options.limit, DEFAULT_PROPOSAL_LIMIT, 1, MAX_PROPOSAL_LIMIT, 'limit');
  const now = normalizeNow(options.now);
  const windowStart = new Date(now.getTime() - windowDays * MS_PER_DAY);
  const inWindow = (timestamp: Date): boolean =>
    timestamp.getTime() >= windowStart.getTime() && timestamp.getTime() <= now.getTime();

  const groups = new Map<string, PatternGroup>();
  const scanned = { tasks: 0, decisions: 0, attempts: 0, episodes: 0 };

  const canScanTasks = typeof engine.listTaskThreads === 'function';
  if (canScanTasks) {
    const tasks = await engine.listTaskThreads!({ limit: MAX_TASKS_SCANNED, offset: 0 });
    scanned.tasks = tasks.length;

    for (const task of tasks) {
      if (typeof engine.listTaskDecisions === 'function') {
        const decisions = (await engine.listTaskDecisions(task.id, { limit: MAX_ITEMS_PER_TASK }))
          .filter((decision) => inWindow(decision.created_at));
        scanned.decisions += decisions.length;
        collectDecisionSignals(groups, task.id, decisions);
      }
      if (typeof engine.listTaskAttempts === 'function') {
        const attempts = (await engine.listTaskAttempts(task.id, { limit: MAX_ITEMS_PER_TASK }))
          .filter((attempt) => inWindow(attempt.created_at));
        scanned.attempts += attempts.length;
        collectFailureFixSignals(groups, task.id, attempts);
      }
    }
  }

  if (typeof engine.listPersonalEpisodeEntries === 'function') {
    const episodes = (await engine.listPersonalEpisodeEntries({ limit: MAX_EPISODES_SCANNED }))
      .filter((episode) => inWindow(episode.start_time));
    scanned.episodes = episodes.length;
    collectEpisodeSignals(groups, episodes);
  }

  const proposals = [...groups.values()]
    .filter((group) => group.distinct_group_keys.size >= minOccurrences)
    .sort((left, right) => {
      if (right.occurrences !== left.occurrences) return right.occurrences - left.occurrences;
      if (left.pattern_kind !== right.pattern_kind) return left.pattern_kind.localeCompare(right.pattern_kind);
      return left.normalized_signal.localeCompare(right.normalized_signal);
    })
    .slice(0, limit)
    .map((group) => toProposal(group, minOccurrences));

  return {
    generated_at: now.toISOString(),
    window_days: windowDays,
    min_occurrences: minOccurrences,
    limit,
    scanned,
    proposals,
    summary_lines: [
      `Procedural pattern detection scanned ${scanned.tasks} tasks, ${scanned.decisions} decisions, ${scanned.attempts} attempts, and ${scanned.episodes} episodes over ${windowDays} days.`,
      `Detected ${proposals.length} recurring pattern proposal${proposals.length === 1 ? '' : 's'} at threshold ${minOccurrences}.`,
      'Proposals are deterministic recurrence signals, never auto-injected; route them through the Memory Inbox procedure lane for human review.',
    ],
  };
}

export async function proposeProceduralCandidates(
  engine: BrainEngine,
  proposals: readonly ProceduralRuleProposal[],
  options: ProposeProceduralCandidatesOptions = {},
): Promise<ProposeProceduralCandidatesResult> {
  const apply = options.apply === true;
  const outcomes: ProceduralProposalOutcome[] = [];
  const openProcedureSignals = await listOpenProcedureCandidateSignals(engine);

  for (const proposal of proposals) {
    const scopeId = proposal.sensitivity === 'personal'
      ? PERSONAL_PROPOSAL_SCOPE_ID
      : options.scope_id?.trim() || DEFAULT_PROPOSAL_SCOPE_ID;
    const duplicateReview = await reviewDuplicateMemory(engine, {
      scope_id: scopeId,
      subject_kind: 'proposed_memory',
      content: proposal.rule_text,
      source_refs: proposal.source_refs,
      candidate_type: 'procedure',
      include_pages: false,
      include_candidates: true,
      limit: 5,
    });
    const duplicateSummary = summarizeDuplicateReviewForPreflight(duplicateReview);

    const identicalOpenProcedure = openProcedureSignals.has(identitySignal(proposal.rule_text));
    if (duplicateReview.decision === 'likely_duplicate' || identicalOpenProcedure) {
      outcomes.push(outcome(proposal, 'skipped_duplicate', null, null, duplicateSummary));
      continue;
    }

    const routed = routeMemoryWriteback({
      content: proposal.rule_text,
      source_refs: proposal.source_refs,
      evidence_kind: 'agent_inferred',
      candidate_type: 'procedure',
      scope_id: scopeId,
      sensitivity: proposal.sensitivity,
      recurrence_score: proposal.recurrence_score,
    });

    if (routed.decision !== 'create_candidate' || !routed.candidate_input) {
      outcomes.push(outcome(proposal, 'not_routable', null, routed.decision, duplicateSummary));
      continue;
    }

    if (!apply) {
      outcomes.push(outcome(proposal, 'planned', null, routed.decision, duplicateSummary));
      continue;
    }

    const created = await createMemoryCandidateEntryWithStatusEvent(engine, {
      ...routed.candidate_input,
      id: routed.candidate_input.id ?? randomUUID(),
      review_reason: appendRecurrenceReason(routed.candidate_input.review_reason, proposal),
    });
    outcomes.push(outcome(proposal, 'created', created.id, routed.decision, duplicateSummary));
  }

  const created = outcomes.filter((entry) => entry.action === 'created').length;
  const planned = outcomes.filter((entry) => entry.action === 'planned').length;
  const skippedDuplicates = outcomes.filter((entry) => entry.action === 'skipped_duplicate').length;
  const notRoutable = outcomes.filter((entry) => entry.action === 'not_routable').length;

  return {
    apply,
    considered: proposals.length,
    created,
    planned,
    skipped_duplicates: skippedDuplicates,
    not_routable: notRoutable,
    outcomes,
    summary_lines: [
      `Considered ${proposals.length} procedural rule proposal${proposals.length === 1 ? '' : 's'}: created ${created}, planned ${planned}, skipped ${skippedDuplicates} duplicate${skippedDuplicates === 1 ? '' : 's'}, not routable ${notRoutable}.`,
      apply
        ? 'Created candidates entered the Memory Inbox procedure lane and still require human review before any promotion.'
        : 'Plan-only run: no Memory Inbox mutation occurred (pass apply=true to create procedure candidates).',
    ],
  };
}

async function listOpenProcedureCandidateSignals(engine: BrainEngine): Promise<Set<string>> {
  const signals = new Set<string>();
  for (const status of DUPLICATE_MEMORY_REVIEW_CANDIDATE_STATUSES) {
    let offset = 0;
    while (true) {
      const batch = await engine.listMemoryCandidateEntries({
        candidate_type: 'procedure',
        status,
        limit: MAX_OPEN_PROCEDURE_SCAN_BATCH,
        offset,
      });
      for (const candidate of batch) {
        const signal = identitySignal(candidate.proposed_content);
        if (signal) signals.add(signal);
      }
      if (batch.length < MAX_OPEN_PROCEDURE_SCAN_BATCH) break;
      offset += MAX_OPEN_PROCEDURE_SCAN_BATCH;
    }
  }
  return signals;
}

function outcome(
  proposal: ProceduralRuleProposal,
  action: ProceduralProposalAction,
  candidateId: string | null,
  routeDecision: MemoryWritebackDecision | null,
  duplicateReview: DuplicateMemoryReviewPreflightSummary | null,
): ProceduralProposalOutcome {
  return {
    pattern_kind: proposal.pattern_kind,
    rule_text: proposal.rule_text,
    occurrences: proposal.occurrences,
    action,
    candidate_id: candidateId,
    route_decision: routeDecision,
    duplicate_review: duplicateReview,
  };
}

function appendRecurrenceReason(reviewReason: string | null | undefined, proposal: ProceduralRuleProposal): string {
  const marker = `procedural_recurrence:${proposal.pattern_kind}:${proposal.occurrences}x`;
  if (!reviewReason || reviewReason.trim().length === 0) return marker;
  return reviewReason.includes(marker) ? reviewReason : `${reviewReason}; ${marker}`;
}

function collectDecisionSignals(
  groups: Map<string, PatternGroup>,
  taskId: string,
  decisions: readonly TaskDecision[],
): void {
  for (const decision of decisions) {
    const signal = normalizeProceduralSignal(decision.summary);
    if (!signal) continue;
    const group = upsertGroup(groups, {
      pattern_kind: 'task_decision',
      normalized_signal: signal,
      rule_text: capRuleText(capitalize(signal)),
      sensitivity: 'work',
    });
    group.occurrences += 1;
    group.distinct_group_keys.add(taskId);
    group.source_refs.add(`task:${taskId}`);
    group.source_refs.add(`task_decision:${decision.id}`);
  }
}

function collectFailureFixSignals(
  groups: Map<string, PatternGroup>,
  taskId: string,
  attempts: readonly TaskAttempt[],
): void {
  const ordered = [...attempts].sort((left, right) => {
    const delta = left.created_at.getTime() - right.created_at.getTime();
    if (delta !== 0) return delta;
    return left.id.localeCompare(right.id);
  });

  for (let index = 0; index < ordered.length; index += 1) {
    const failed = ordered[index]!;
    if (failed.outcome !== 'failed') continue;
    const fix = ordered.slice(index + 1).find((attempt) => attempt.outcome === 'succeeded');
    if (!fix) continue;
    const failureSignal = normalizeProceduralSignal(failed.summary);
    const fixSignal = normalizeProceduralSignal(fix.summary);
    if (!failureSignal || !fixSignal) continue;
    const signal = `${failureSignal} -> ${fixSignal}`;
    const group = upsertGroup(groups, {
      pattern_kind: 'attempt_failure_fix',
      normalized_signal: signal,
      rule_text: capRuleText(`When "${failureSignal}" recurs, ${fixSignal}.`),
      sensitivity: 'work',
    });
    group.occurrences += 1;
    group.distinct_group_keys.add(`${taskId}:${failed.id}`);
    group.source_refs.add(`task:${taskId}`);
    group.source_refs.add(`task_attempt:${failed.id}`);
    group.source_refs.add(`task_attempt:${fix.id}`);
  }
}

function collectEpisodeSignals(
  groups: Map<string, PatternGroup>,
  episodes: readonly PersonalEpisodeEntry[],
): void {
  for (const episode of episodes) {
    const signal = normalizeProceduralSignal(episode.title) || normalizeProceduralSignal(episode.summary);
    if (!signal) continue;
    const group = upsertGroup(groups, {
      pattern_kind: 'episode',
      normalized_signal: signal,
      rule_text: capRuleText(`Expect recurring episode: ${signal}.`),
      sensitivity: 'personal',
    });
    group.occurrences += 1;
    group.distinct_group_keys.add(episode.id);
    group.source_refs.add(`personal_episode:${episode.id}`);
  }
}

function upsertGroup(
  groups: Map<string, PatternGroup>,
  seed: Pick<PatternGroup, 'pattern_kind' | 'normalized_signal' | 'rule_text' | 'sensitivity'>,
): PatternGroup {
  const key = `${seed.pattern_kind} ${seed.normalized_signal}`;
  const existing = groups.get(key);
  if (existing) return existing;
  const group: PatternGroup = {
    ...seed,
    occurrences: 0,
    distinct_group_keys: new Set<string>(),
    source_refs: new Set<string>(),
  };
  groups.set(key, group);
  return group;
}

function toProposal(group: PatternGroup, minOccurrences: number): ProceduralRuleProposal {
  return {
    pattern_kind: group.pattern_kind,
    rule_text: group.rule_text,
    normalized_signal: group.normalized_signal,
    occurrences: group.occurrences,
    source_refs: [...group.source_refs].sort().slice(0, MAX_SOURCE_REFS_PER_PROPOSAL),
    recurrence_score: roundScore(Math.min(1, group.occurrences / (minOccurrences * 2))),
    sensitivity: group.sensitivity,
  };
}

/**
 * Deterministic signal normalization: lowercase, strip ids (UUID/hex), dates,
 * and times, then collapse whitespace. No LLM involvement anywhere.
 */
export function normalizeProceduralSignal(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:t[\d:.]+z?)?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\b[0-9a-f]{7,64}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Punctuation-insensitive identity signal used only for exact-duplicate skips. */
function identitySignal(value: string): string {
  return normalizeProceduralSignal(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function capRuleText(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= PROCEDURAL_RULE_MAX_LENGTH
    ? collapsed
    : collapsed.slice(0, PROCEDURAL_RULE_MAX_LENGTH).trimEnd();
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeBoundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function normalizeNow(value: Date | string | null | undefined): Date {
  if (value == null) return new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError('now must be a valid Date or ISO datetime string.');
  }
  return parsed;
}
