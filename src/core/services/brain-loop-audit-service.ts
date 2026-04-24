import type { BrainEngine } from '../engine.ts';
import type {
  AuditApproximateCounts,
  AuditBrainLoopInput,
  AuditBrainLoopReport,
  AuditLinkedWriteCounts,
  AuditTaskCompliance,
  MemoryCandidateEntry,
  RetrievalTrace,
  ScopeGateScope,
  TaskThread,
} from '../types.ts';

const TRACE_BATCH_SIZE = 500;
const TASK_BATCH_SIZE = 500;
const TASK_SCAN_CAP = 5000;
const CANDIDATE_BATCH_SIZE = 100;

export async function auditBrainLoop(
  engine: BrainEngine,
  input: AuditBrainLoopInput = {},
): Promise<AuditBrainLoopReport> {
  const now = new Date();
  const until = normalizeDate(input.until, now);
  const since = normalizeDate(input.since, new Date(until.getTime() - 24 * 60 * 60 * 1000));
  const limit = clampLimit(input.limit ?? 50, 1, 500);
  const traces = await listAllRetrievalTracesInWindow(engine, {
    since,
    until,
    task_id: input.task_id,
    scope: input.scope,
  });
  const traceIds = traces.map((trace) => trace.id);
  const linkedWrites = await countLinkedWrites(engine, traceIds);
  const approximate = await approximateUnlinkedCandidateEvents(engine, since, until);
  const taskCompliance = await computeTaskCompliance(engine, traces, limit);
  const canonicalRefCount = traces.reduce((sum, trace) => sum + trace.source_refs.length, 0);
  const derivedRefCount = traces.reduce((sum, trace) => sum + trace.derived_consulted.length, 0);

  return {
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
    },
    total_traces: traces.length,
    by_selected_intent: countBy(traces, (trace) => trace.selected_intent ?? 'unknown_legacy'),
    by_scope: countBy(traces, (trace) => trace.scope),
    by_scope_gate_policy: countPresentBy(traces, (trace) => trace.scope_gate_policy),
    most_common_defer_reason: mostCommon(
      traces
        .filter((trace) => trace.scope_gate_policy === 'defer')
        .map((trace) => trace.scope_gate_reason)
        .filter((reason): reason is string => reason != null && reason.length > 0),
    ),
    canonical_vs_derived: {
      canonical_ref_count: canonicalRefCount,
      derived_ref_count: derivedRefCount,
      canonical_ratio: ratio(canonicalRefCount, derivedRefCount),
    },
    linked_writes: linkedWrites,
    approximate,
    task_compliance: taskCompliance,
    summary_lines: buildSummaryLines(traces, linkedWrites, canonicalRefCount, derivedRefCount),
  };
}

async function listAllRetrievalTracesInWindow(
  engine: BrainEngine,
  filters: {
    since: Date;
    until: Date;
    task_id?: string;
    scope?: ScopeGateScope;
  },
): Promise<RetrievalTrace[]> {
  const traces: RetrievalTrace[] = [];
  for (let offset = 0; ; offset += TRACE_BATCH_SIZE) {
    const batch = await engine.listRetrievalTracesByWindow({
      ...filters,
      limit: TRACE_BATCH_SIZE,
      offset,
    });
    traces.push(...batch);
    if (batch.length < TRACE_BATCH_SIZE) break;
  }
  return traces;
}

async function countLinkedWrites(
  engine: BrainEngine,
  traceIds: string[],
): Promise<AuditLinkedWriteCounts> {
  if (traceIds.length === 0) {
    return {
      handoff_count: 0,
      supersession_count: 0,
      contradiction_count: 0,
      traces_with_any_linked_write: 0,
      traces_without_linked_write: 0,
    };
  }

  const [handoffs, supersessions, contradictions] = await Promise.all([
    engine.listCanonicalHandoffEntriesByInteractionIds(traceIds),
    engine.listMemoryCandidateSupersessionEntriesByInteractionIds(traceIds),
    engine.listMemoryCandidateContradictionEntriesByInteractionIds(traceIds),
  ]);
  const linkedTraceIds = new Set<string>();
  for (const handoff of handoffs) {
    if (handoff.interaction_id) linkedTraceIds.add(handoff.interaction_id);
  }
  for (const supersession of supersessions) {
    if (supersession.interaction_id) linkedTraceIds.add(supersession.interaction_id);
  }
  for (const contradiction of contradictions) {
    if (contradiction.interaction_id) linkedTraceIds.add(contradiction.interaction_id);
  }

  return {
    handoff_count: handoffs.length,
    supersession_count: supersessions.length,
    contradiction_count: contradictions.length,
    traces_with_any_linked_write: linkedTraceIds.size,
    traces_without_linked_write: traceIds.length - linkedTraceIds.size,
  };
}

async function approximateUnlinkedCandidateEvents(
  engine: BrainEngine,
  since: Date,
  until: Date,
): Promise<AuditApproximateCounts> {
  const candidates: MemoryCandidateEntry[] = [];
  for (let offset = 0; ; offset += CANDIDATE_BATCH_SIZE) {
    const batch = await engine.listMemoryCandidateEntries({
      limit: CANDIDATE_BATCH_SIZE,
      offset,
    });
    candidates.push(...batch);
    if (batch.length < CANDIDATE_BATCH_SIZE) break;
  }

  return {
    candidate_creation_same_window: candidates.filter((candidate) => isInWindow(candidate.created_at, since, until)).length,
    candidate_rejection_same_window: candidates.filter((candidate) =>
      candidate.status === 'rejected'
      && candidate.reviewed_at != null
      && isInWindow(candidate.reviewed_at, since, until)
    ).length,
    note: 'approximate; precise correlation requires memory_candidate_status_events',
  };
}

async function computeTaskCompliance(
  engine: BrainEngine,
  traces: RetrievalTrace[],
  limit: number,
): Promise<AuditTaskCompliance> {
  const tasks: TaskThread[] = [];
  let cappedAt: number | null = null;
  for (let offset = 0; offset < TASK_SCAN_CAP; offset += TASK_BATCH_SIZE) {
    const batch = await engine.listTaskThreads({ limit: TASK_BATCH_SIZE, offset });
    tasks.push(...batch);
    if (batch.length < TASK_BATCH_SIZE) break;
    if (offset + TASK_BATCH_SIZE >= TASK_SCAN_CAP) {
      cappedAt = TASK_SCAN_CAP;
    }
  }

  const lastTraceByTask = new Map<string, RetrievalTrace>();
  for (const trace of traces) {
    if (!trace.task_id) continue;
    const previous = lastTraceByTask.get(trace.task_id);
    if (!previous || previous.created_at < trace.created_at) {
      lastTraceByTask.set(trace.task_id, trace);
    }
  }
  const backlog = tasks
    .filter((task) => !lastTraceByTask.has(task.id))
    .slice(0, limit)
    .map((task) => ({
      task_id: task.id,
      last_trace_at: null,
      last_route_kind: null,
    }));

  return {
    tasks_with_traces: tasks.filter((task) => lastTraceByTask.has(task.id)).length,
    tasks_without_traces: tasks.filter((task) => !lastTraceByTask.has(task.id)).length,
    task_scan_capped_at: cappedAt,
    top_backlog: backlog,
  };
}

function normalizeDate(input: Date | string | undefined, fallback: Date): Date {
  if (input === undefined) return fallback;
  if (input instanceof Date) return input;
  const relative = input.match(/^(\d+)([hd])$/);
  if (relative) {
    const amount = Number(relative[1]);
    const millis = relative[2] === 'h'
      ? amount * 60 * 60 * 1000
      : amount * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - millis);
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid audit date: ${input}`);
  }
  return parsed;
}

function clampLimit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function countBy<K extends string>(
  traces: RetrievalTrace[],
  selector: (trace: RetrievalTrace) => K,
): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const trace of traces) {
    const key = selector(trace);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function countPresentBy<K extends string>(
  traces: RetrievalTrace[],
  selector: (trace: RetrievalTrace) => K | null,
): Partial<Record<K, number>> {
  const counts: Partial<Record<K, number>> = {};
  for (const trace of traces) {
    const key = selector(trace);
    if (key == null) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function mostCommon(values: string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

function ratio(canonicalRefCount: number, derivedRefCount: number): number {
  const total = canonicalRefCount + derivedRefCount;
  if (total === 0) return 1;
  return canonicalRefCount / total;
}

function isInWindow(value: Date | string, since: Date, until: Date): boolean {
  const date = value instanceof Date ? value : new Date(value);
  return date >= since && date < until;
}

function buildSummaryLines(
  traces: RetrievalTrace[],
  linkedWrites: AuditLinkedWriteCounts,
  canonicalRefCount: number,
  derivedRefCount: number,
): string[] {
  if (traces.length === 0) {
    return ['No brain-loop activity in the selected window.'];
  }
  return [
    `traces=${traces.length}`,
    `linked_writes=${linkedWrites.traces_with_any_linked_write}`,
    `read_without_linked_write=${linkedWrites.traces_without_linked_write}`,
    `canonical_refs=${canonicalRefCount}`,
    `derived_refs=${derivedRefCount}`,
  ];
}
