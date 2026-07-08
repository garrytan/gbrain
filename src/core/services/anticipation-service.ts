import type { BrainEngine } from '../engine.ts';
import type { RetrievalSelector, RetrievalTrace } from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { retrieveContext } from './retrieve-context-service.ts';

// Sleep-time anticipation (N-9, LLM-free v1): deterministically rank likely
// next-session questions and precompute their read plans as a dated derived
// artifact. The pack is persisted in the config table (no new schema) and is
// orientation-only — never answer evidence; read_context remains the boundary.
export const ANTICIPATION_PACK_CONFIG_KEY = 'anticipation_pack_latest';

const DEFAULT_PACK_LIMIT = 5;
const MAX_SELECTORS_PER_ENTRY = 5;
const PROBE_CANDIDATE_LIMIT = 3;
// Coarse per-selector read cost estimate; real token counts require read_context.
const TOKEN_ESTIMATE_PER_SELECTOR = 400;
const RECURRING_TRACE_WINDOW_DAYS = 7;
const RECURRING_TRACE_SCAN_LIMIT = 500;
const RECURRING_MIN_OCCURRENCES = 2;
const MAX_WATCHED_QUESTION_CANDIDATES = 50;
const MAX_TASK_CANDIDATES = 20;
const MAX_RECURRING_CANDIDATES = 10;

export type AnticipationQuestionSource = 'watched_question' | 'task' | 'recurring_query';

export interface AnticipationReadPlanSelector {
  selector_id?: string;
  kind: RetrievalSelector['kind'];
  scope_id?: string;
  slug?: string;
  path?: string;
  section_id?: string;
  object_id?: string;
  line_start?: number;
  line_end?: number;
  content_hash?: string;
  freshness?: RetrievalSelector['freshness'];
}

export interface AnticipationPackEntry {
  question: string;
  source: AnticipationQuestionSource;
  read_plan_selectors: AnticipationReadPlanSelector[];
  token_estimate: number;
}

export interface AnticipationProbeFailure {
  question: string;
  source: AnticipationQuestionSource;
  reason: string;
}

export interface AnticipationPack {
  generated_at: string;
  entries: AnticipationPackEntry[];
  candidate_question_count: number;
  probe_failures: AnticipationProbeFailure[];
}

export interface AnticipationProbeResult {
  read_plan: { selected_selector_snapshots?: RetrievalSelector[] };
  required_reads: RetrievalSelector[];
}

export type AnticipationProbe = (
  engine: BrainEngine,
  input: { query: string },
) => Promise<AnticipationProbeResult>;

export interface AnticipationDependencies {
  probe?: AnticipationProbe;
}

export interface BuildAnticipationPackInput {
  scope_id?: string;
  limit?: number;
  now?: string;
  dependencies?: AnticipationDependencies;
}

interface AnticipationCandidateQuestion {
  question: string;
  source: AnticipationQuestionSource;
}

export async function buildAnticipationPack(
  engine: BrainEngine,
  input: BuildAnticipationPackInput = {},
): Promise<AnticipationPack> {
  const now = input.now ?? new Date().toISOString();
  const limit = normalizePackLimit(input.limit);
  const scopeId = input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const probe = input.dependencies?.probe ?? defaultAnticipationProbe;

  const candidates = dedupeCandidateQuestions([
    ...await watchedQuestionCandidates(engine, scopeId),
    ...await activeTaskCandidates(engine),
    ...await recurringTraceCandidates(engine, now),
  ]).slice(0, limit);

  const entries: AnticipationPackEntry[] = [];
  const probeFailures: AnticipationProbeFailure[] = [];
  for (const candidate of candidates) {
    try {
      const result = await probe(engine, { query: candidate.question });
      const selectors = (result.read_plan.selected_selector_snapshots?.length
        ? result.read_plan.selected_selector_snapshots
        : result.required_reads).slice(0, MAX_SELECTORS_PER_ENTRY);
      entries.push({
        question: candidate.question,
        source: candidate.source,
        read_plan_selectors: selectors.map(compactSelectorSnapshot),
        token_estimate: selectors.length * TOKEN_ESTIMATE_PER_SELECTOR,
      });
    } catch (error) {
      probeFailures.push({
        question: candidate.question,
        source: candidate.source,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    generated_at: now,
    entries,
    candidate_question_count: candidates.length,
    probe_failures: probeFailures,
  };
}

const defaultAnticipationProbe: AnticipationProbe = (engine, input) =>
  retrieveContext(engine, {
    query: input.query,
    limit: PROBE_CANDIDATE_LIMIT,
    include_orientation: false,
    persist_trace: false,
  });

async function watchedQuestionCandidates(
  engine: BrainEngine,
  scopeId: string,
): Promise<AnticipationCandidateQuestion[]> {
  if (typeof engine.listWatchedQuestions !== 'function') return [];
  const questions = await engine.listWatchedQuestions({
    scope_id: scopeId,
    enabled: true,
    limit: MAX_WATCHED_QUESTION_CANDIDATES,
  });
  return [...questions]
    .sort((left, right) =>
      left.created_at.getTime() - right.created_at.getTime() || left.id.localeCompare(right.id))
    .map((question) => question.question.trim())
    .filter((question) => question.length > 0)
    .map((question) => ({ question, source: 'watched_question' as const }));
}

async function activeTaskCandidates(engine: BrainEngine): Promise<AnticipationCandidateQuestion[]> {
  if (typeof engine.listTaskThreads !== 'function') return [];
  const tasks = await engine.listTaskThreads({ status: 'active', limit: MAX_TASK_CANDIDATES });
  const sorted = [...tasks].sort((left, right) =>
    right.updated_at.getTime() - left.updated_at.getTime() || left.id.localeCompare(right.id));

  const candidates: AnticipationCandidateQuestion[] = [];
  for (const task of sorted) {
    const title = task.title.trim();
    if (!title) continue;
    const latestDecision = typeof engine.listTaskDecisions === 'function'
      ? (await engine.listTaskDecisions(task.id, { limit: 1 }))[0]
      : undefined;
    const topic = latestDecision?.summary.trim();
    candidates.push({
      question: topic ? `${title} ${topic}` : title,
      source: 'task',
    });
  }
  return candidates;
}

async function recurringTraceCandidates(
  engine: BrainEngine,
  now: string,
): Promise<AnticipationCandidateQuestion[]> {
  if (typeof engine.listRetrievalTracesByWindow !== 'function') return [];
  const until = new Date(now);
  const since = new Date(until.getTime() - RECURRING_TRACE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const traces = await engine.listRetrievalTracesByWindow({
    since,
    until,
    limit: RECURRING_TRACE_SCAN_LIMIT,
  });

  const bySlug = new Map<string, { count: number; latestAt: number }>();
  for (const trace of traces) {
    for (const slug of traceTargetSlugs(trace)) {
      const current = bySlug.get(slug);
      if (!current) {
        bySlug.set(slug, { count: 1, latestAt: trace.created_at.getTime() });
        continue;
      }
      current.count += 1;
      current.latestAt = Math.max(current.latestAt, trace.created_at.getTime());
    }
  }

  return [...bySlug.entries()]
    .filter(([, usage]) => usage.count >= RECURRING_MIN_OCCURRENCES)
    .sort(([leftSlug, left], [rightSlug, right]) =>
      right.count - left.count || right.latestAt - left.latestAt || leftSlug.localeCompare(rightSlug))
    .slice(0, MAX_RECURRING_CANDIDATES)
    .map(([slug]) => questionFromSlug(slug))
    .filter((question): question is string => question !== null)
    .map((question) => ({ question, source: 'recurring_query' as const }));
}

// Retrieval traces do not persist raw query text, so the recurring-query lane
// uses recurring retrieval targets: page-like selector ids in trace source_refs
// (same shape slugFromRetrievalTraceSourceRef parses for usage-aware ranking).
function traceTargetSlugs(trace: RetrievalTrace): string[] {
  const slugs = new Set<string>();
  for (const sourceRef of trace.source_refs) {
    const ref = sourceRef.split('@chars:')[0]!;
    const parts = ref.split(':');
    const kind = parts[0];
    if (
      (kind === 'page' || kind === 'compiled_truth' || kind === 'frontmatter' || kind === 'timeline_range')
      && parts.length >= 4
    ) {
      slugs.add(parts.slice(3).join(':'));
    }
  }
  return [...slugs];
}

function questionFromSlug(slug: string): string | null {
  const lastSegment = slug.split('/').at(-1) ?? slug;
  const question = lastSegment.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return question.length > 0 ? question : null;
}

function dedupeCandidateQuestions(
  candidates: AnticipationCandidateQuestion[],
): AnticipationCandidateQuestion[] {
  const seen = new Set<string>();
  const deduped: AnticipationCandidateQuestion[] = [];
  for (const candidate of candidates) {
    const key = candidate.question.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function compactSelectorSnapshot(selector: RetrievalSelector): AnticipationReadPlanSelector {
  return {
    kind: selector.kind,
    ...(selector.selector_id !== undefined ? { selector_id: selector.selector_id } : {}),
    ...(selector.scope_id !== undefined ? { scope_id: selector.scope_id } : {}),
    ...(selector.slug !== undefined ? { slug: selector.slug } : {}),
    ...(selector.path !== undefined ? { path: selector.path } : {}),
    ...(selector.section_id !== undefined ? { section_id: selector.section_id } : {}),
    ...(selector.object_id !== undefined ? { object_id: selector.object_id } : {}),
    ...(selector.line_start !== undefined ? { line_start: selector.line_start } : {}),
    ...(selector.line_end !== undefined ? { line_end: selector.line_end } : {}),
    ...(selector.content_hash !== undefined ? { content_hash: selector.content_hash } : {}),
    ...(selector.freshness !== undefined ? { freshness: selector.freshness } : {}),
  };
}

function normalizePackLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PACK_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('anticipation pack limit must be a positive integer');
  }
  return limit;
}
