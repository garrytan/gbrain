import type { BrainEngine } from '../engine.ts';
import type {
  ProfileMemoryEntry,
  RetrievalTrace,
  TaskThread,
  WatchedQuestionRun,
} from '../types.ts';
import { clipToBudget, estimateTokens } from './read-context-budget-service.ts';

// N-3 core memory blocks: a small set of named, hard token-budgeted, always-injectable
// context blocks compiled deterministically from canonical sources (no LLM, no runner).
// Blocks are derived pointers + distilled lines, never answer evidence: agents still
// route through read_context to cite canonical pages.

export type CoreMemoryBlockName = 'owner-profile' | 'active-projects' | 'attention';

export type CoreMemoryBlockSourceKind =
  | 'profile_memory'
  | 'task_thread'
  | 'task_working_set'
  | 'page'
  | 'watched_question';

export interface CoreMemoryBlockLineSource {
  kind: CoreMemoryBlockSourceKind;
  id?: string;
  slug?: string;
}

export interface CoreMemoryBlockLine {
  text: string;
  source: CoreMemoryBlockLineSource;
  token_estimate: number;
}

export interface CoreMemoryBlock {
  name: CoreMemoryBlockName;
  authority: 'not_answer_evidence';
  lines: CoreMemoryBlockLine[];
  token_estimate: number;
}

export interface CoreMemoryBlocksResult {
  authority: 'not_answer_evidence';
  budget_tokens: number;
  total_token_estimate: number;
  generated_at: string;
  window_days: number;
  priority_order: CoreMemoryBlockName[];
  trimmed_line_count: number;
  blocks: CoreMemoryBlock[];
}

export interface BuildCoreMemoryBlocksInput {
  budget_tokens?: number;
  now?: Date;
}

/** Owner decision D-F: total always-on block budget is hard-capped at 2,000 tokens (tunable down). */
export const CORE_MEMORY_BLOCKS_HARD_BUDGET_TOKENS = 2000;

/** Config-store key the dream cycle uses to persist the latest compiled snapshot. */
export const CORE_MEMORY_BLOCKS_CONFIG_KEY = 'core_memory_blocks_snapshot_v1';

/**
 * Trim priority: lines are included in this block order (and in ranked order within each
 * block). When the budget runs out, inclusion stops at the first line that does not fit,
 * so the lowest-priority tail (attention first, then active-projects, then owner-profile)
 * is trimmed before anything above it.
 */
export const CORE_MEMORY_BLOCK_PRIORITY: readonly CoreMemoryBlockName[] = [
  'owner-profile',
  'active-projects',
  'attention',
];

const ATTENTION_WINDOW_DAYS = 14;
const MAX_LINE_TOKENS = 40;
const MAX_PROFILE_LINES = 12;
const MAX_PROJECT_THREADS = 6;
const MAX_ATTENTION_PAGES = 8;
const MAX_WATCHED_DELTAS = 4;
const PROFILE_SCAN_LIMIT = 100;
const THREAD_SCAN_LIMIT = 25;
const TRACE_SCAN_LIMIT = 1000;
const WATCHED_RUN_SCAN_LIMIT = 100;
const PERSONAL_SCOPE_ID = 'personal:default';

export async function buildCoreMemoryBlocks(
  engine: BrainEngine,
  input: BuildCoreMemoryBlocksInput = {},
): Promise<CoreMemoryBlocksResult> {
  const now = input.now ?? new Date();
  const budgetTokens = clampBudget(input.budget_tokens);

  const [profileLines, projectLines, attentionLines] = await Promise.all([
    ownerProfileLines(engine),
    activeProjectLines(engine),
    attentionBlockLines(engine, now),
  ]);
  const candidateLinesByBlock: Record<CoreMemoryBlockName, CoreMemoryBlockLine[]> = {
    'owner-profile': profileLines,
    'active-projects': projectLines,
    attention: attentionLines,
  };

  let remaining = budgetTokens;
  let trimmedLineCount = 0;
  let budgetExhausted = false;
  const blocks: CoreMemoryBlock[] = CORE_MEMORY_BLOCK_PRIORITY.map((name) => {
    const kept: CoreMemoryBlockLine[] = [];
    for (const line of candidateLinesByBlock[name]) {
      if (budgetExhausted || line.token_estimate > remaining) {
        // Strict priority cutoff: the first non-fitting line trims everything after it.
        budgetExhausted = true;
        trimmedLineCount += 1;
        continue;
      }
      remaining -= line.token_estimate;
      kept.push(line);
    }
    return {
      name,
      authority: 'not_answer_evidence' as const,
      lines: kept,
      token_estimate: kept.reduce((total, line) => total + line.token_estimate, 0),
    };
  });

  return {
    authority: 'not_answer_evidence',
    budget_tokens: budgetTokens,
    total_token_estimate: blocks.reduce((total, block) => total + block.token_estimate, 0),
    generated_at: now.toISOString(),
    window_days: ATTENTION_WINDOW_DAYS,
    priority_order: [...CORE_MEMORY_BLOCK_PRIORITY],
    trimmed_line_count: trimmedLineCount,
    blocks,
  };
}

/** Persist the compiled snapshot through the engine config store. Returns false when unavailable. */
export async function persistCoreMemoryBlocksSnapshot(
  engine: BrainEngine,
  result: CoreMemoryBlocksResult,
): Promise<boolean> {
  if (typeof engine.setConfig !== 'function') return false;
  await engine.setConfig(CORE_MEMORY_BLOCKS_CONFIG_KEY, JSON.stringify(result));
  return true;
}

function clampBudget(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return CORE_MEMORY_BLOCKS_HARD_BUDGET_TOKENS;
  }
  return Math.max(1, Math.min(Math.floor(requested), CORE_MEMORY_BLOCKS_HARD_BUDGET_TOKENS));
}

async function ownerProfileLines(engine: BrainEngine): Promise<CoreMemoryBlockLine[]> {
  if (typeof engine.listProfileMemoryEntries !== 'function') return [];
  const entries = await engine.listProfileMemoryEntries({
    scope_id: PERSONAL_SCOPE_ID,
    limit: PROFILE_SCAN_LIMIT,
    offset: 0,
  });
  return entries
    .filter((entry) => entry.superseded_by == null)
    .sort(compareProfileEntries)
    .slice(0, MAX_PROFILE_LINES)
    .map((entry) => makeLine(
      `[${entry.profile_type}] ${entry.subject} — ${entry.content}`,
      { kind: 'profile_memory', id: entry.id },
    ));
}

function compareProfileEntries(left: ProfileMemoryEntry, right: ProfileMemoryEntry): number {
  const confirmedDelta = timeOrZero(right.last_confirmed_at) - timeOrZero(left.last_confirmed_at);
  if (confirmedDelta !== 0) return confirmedDelta;
  const updatedDelta = timeOrZero(right.updated_at) - timeOrZero(left.updated_at);
  if (updatedDelta !== 0) return updatedDelta;
  return left.id.localeCompare(right.id);
}

async function activeProjectLines(engine: BrainEngine): Promise<CoreMemoryBlockLine[]> {
  if (typeof engine.listTaskThreads !== 'function') return [];
  const [active, blocked] = await Promise.all([
    engine.listTaskThreads({ status: 'active', limit: THREAD_SCAN_LIMIT }),
    engine.listTaskThreads({ status: 'blocked', limit: THREAD_SCAN_LIMIT }),
  ]);
  const threads = [...active, ...blocked]
    .sort(compareThreads)
    .slice(0, MAX_PROJECT_THREADS);

  const lines: CoreMemoryBlockLine[] = [];
  for (const thread of threads) {
    const summary = thread.current_summary.trim() || thread.goal.trim();
    lines.push(makeLine(
      `[${thread.status}] ${thread.title}${summary ? ` — ${summary}` : ''}`,
      { kind: 'task_thread', id: thread.id },
    ));
    lines.push(...await workingSetLines(engine, thread.id));
  }
  return lines;
}

function compareThreads(left: TaskThread, right: TaskThread): number {
  const updatedDelta = timeOrZero(right.updated_at) - timeOrZero(left.updated_at);
  if (updatedDelta !== 0) return updatedDelta;
  return left.id.localeCompare(right.id);
}

async function workingSetLines(engine: BrainEngine, taskId: string): Promise<CoreMemoryBlockLine[]> {
  if (typeof engine.getTaskWorkingSet !== 'function') return [];
  const workingSet = await engine.getTaskWorkingSet(taskId);
  if (!workingSet) return [];
  const lines: CoreMemoryBlockLine[] = [];
  if (workingSet.next_steps.length > 0) {
    lines.push(makeLine(
      `next: ${workingSet.next_steps.slice(0, 2).join('; ')}`,
      { kind: 'task_working_set', id: taskId },
    ));
  }
  if (workingSet.blockers.length > 0) {
    lines.push(makeLine(
      `blocked: ${workingSet.blockers.slice(0, 2).join('; ')}`,
      { kind: 'task_working_set', id: taskId },
    ));
  }
  return lines;
}

async function attentionBlockLines(engine: BrainEngine, now: Date): Promise<CoreMemoryBlockLine[]> {
  const since = new Date(now.getTime() - ATTENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [pageLines, watchedLines] = await Promise.all([
    mostConfirmedReadPageLines(engine, since, now),
    watchedQuestionDeltaLines(engine, since),
  ]);
  return [...pageLines, ...watchedLines];
}

async function mostConfirmedReadPageLines(
  engine: BrainEngine,
  since: Date,
  until: Date,
): Promise<CoreMemoryBlockLine[]> {
  if (typeof engine.listRetrievalTracesByWindow !== 'function') return [];
  const traces = await engine.listRetrievalTracesByWindow({
    since,
    until,
    limit: TRACE_SCAN_LIMIT,
  });
  const countBySlug = new Map<string, number>();
  for (const trace of traces) {
    if (!isConfirmedReadTrace(trace)) continue;
    const slugs = new Set(trace.source_refs
      .map(slugFromRetrievalTraceSourceRef)
      .filter((slug): slug is string => Boolean(slug)));
    for (const slug of slugs) {
      countBySlug.set(slug, (countBySlug.get(slug) ?? 0) + 1);
    }
  }
  return [...countBySlug.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_ATTENTION_PAGES)
    .map(([slug, count]) => makeLine(
      `${slug} — ${count} confirmed read${count === 1 ? '' : 's'} in last ${ATTENTION_WINDOW_DAYS}d`,
      { kind: 'page', slug },
    ));
}

function isConfirmedReadTrace(trace: RetrievalTrace): boolean {
  return trace.route.includes('read_context');
}

async function watchedQuestionDeltaLines(
  engine: BrainEngine,
  since: Date,
): Promise<CoreMemoryBlockLine[]> {
  if (typeof engine.listWatchedQuestionRuns !== 'function') return [];
  const runs = await engine.listWatchedQuestionRuns({
    changed: true,
    since,
    limit: WATCHED_RUN_SCAN_LIMIT,
  });
  const latestByQuestion = new Map<string, WatchedQuestionRun>();
  for (const run of [...runs].sort(compareWatchedRuns)) {
    if (!latestByQuestion.has(run.question_id)) {
      latestByQuestion.set(run.question_id, run);
    }
  }
  return [...latestByQuestion.values()]
    .slice(0, MAX_WATCHED_DELTAS)
    .map((run) => makeLine(
      `watched question changed: ${run.question}`,
      { kind: 'watched_question', id: run.question_id },
    ));
}

function compareWatchedRuns(left: WatchedQuestionRun, right: WatchedQuestionRun): number {
  const createdDelta = timeOrZero(right.created_at) - timeOrZero(left.created_at);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
}

function makeLine(text: string, source: CoreMemoryBlockLineSource): CoreMemoryBlockLine {
  const clipped = clipToBudget(text.replace(/\s+/g, ' ').trim(), MAX_LINE_TOKENS).text;
  return {
    text: clipped,
    source,
    token_estimate: estimateTokens(clipped),
  };
}

/** Mirrors the trace source-ref slug extraction used by usage-aware retrieval stats. */
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

function timeOrZero(value: Date | null | undefined): number {
  return value instanceof Date ? value.getTime() : 0;
}
