import type { BrainEngine } from '../engine.ts';
import type {
  AuditApproximateCounts,
  AuditBrainLoopInput,
  AuditBrainLoopReport,
  AuditCandidateLifecycleMetrics,
  AuditCandidatePressureCounts,
  AuditCandidateStatusEventCounts,
  AuditLinkedWriteCounts,
  AuditTaskCompliance,
  CanonicalHandoffEntry,
  MemoryCandidateEntry,
  MemoryCandidateContradictionEntry,
  MemoryCandidateFilters,
  MemoryCandidateStatusEvent,
  MemoryCandidateSupersessionEntry,
  MemoryMutationEvent,
  RetrievalTrace,
  ScopeGateScope,
  TaskScope,
  TaskThread,
} from '../types.ts';

const TRACE_BATCH_SIZE = 500;
const LINKED_WRITE_LOOKUP_BATCH_SIZE = 500;
const TASK_BATCH_SIZE = 500;
const TASK_SCAN_CAP = 5000;
const CANDIDATE_BATCH_SIZE = 100;
const CANONICAL_HANDOFF_BATCH_SIZE = 100;
const STATUS_EVENT_BATCH_SIZE = 500;
const MUTATION_EVENT_BATCH_SIZE = 500;
const TRACE_HISTORY_START = new Date(0);
const DEFAULT_CANDIDATE_REVIEW_WINDOW_DAYS = 14;
const CANDIDATE_SIGNAL_PREFIX = 'candidate_signal:';
const TERMINAL_CANDIDATE_STATUS_EVENT_KINDS = ['promoted', 'rejected', 'superseded'] as const;

interface CandidateStatusEventAudit {
  counts: AuditCandidateStatusEventCounts;
  events: MemoryCandidateStatusEvent[];
}

export async function auditBrainLoop(
  engine: BrainEngine,
  input: AuditBrainLoopInput = {},
): Promise<AuditBrainLoopReport> {
  const now = new Date();
  const until = normalizeDate(input.until, now);
  const since = normalizeDate(input.since, new Date(until.getTime() - 24 * 60 * 60 * 1000));
  validateAuditWindow(since, until);
  const limit = clampLimit(input.limit ?? 50, 1, 500);
  const traces = await listAllRetrievalTracesInWindow(engine, {
    since,
    until,
    task_id: input.task_id,
    scope: input.scope,
  });
  const traceIds = traces.map((trace) => trace.id);
  const candidateStatusEvents = await countCandidateStatusEvents(engine, traceIds, since, until, {
    task_id: input.task_id,
    scope: input.scope,
  });
  const linkedWrites = await countLinkedWrites(engine, traceIds, candidateStatusEvents.events);
  const candidateLifecycle = await computeCandidateLifecycleMetrics(engine, traces, {
    since,
    until,
    reviewWindowDays: clampLimit(
      input.candidate_review_window_days ?? DEFAULT_CANDIDATE_REVIEW_WINDOW_DAYS,
      0,
      3650,
    ),
  });
  const approximate = await approximateUnlinkedCandidateEvents(engine, since, until, {
    task_id: input.task_id,
    scope: input.scope,
  }, candidateStatusEvents);
  const taskCompliance = await computeTaskCompliance(
    engine,
    traces,
    limit,
    { until },
    {
      task_id: input.task_id,
      scope: input.scope,
    },
  );
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
    candidate_status_events: candidateStatusEvents.counts,
    candidate_lifecycle: candidateLifecycle,
    approximate,
    task_compliance: taskCompliance,
    summary_lines: buildSummaryLines(traces, linkedWrites, candidateLifecycle, canonicalRefCount, derivedRefCount),
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
  candidateStatusEvents: MemoryCandidateStatusEvent[],
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

  const traceIdSet = new Set(traceIds);
  const handoffs: CanonicalHandoffEntry[] = [];
  const supersessions: MemoryCandidateSupersessionEntry[] = [];
  const contradictions: MemoryCandidateContradictionEntry[] = [];
  for (const chunk of chunkArray(traceIds, LINKED_WRITE_LOOKUP_BATCH_SIZE)) {
    const [handoffBatch, supersessionBatch, contradictionBatch] = await Promise.all([
      engine.listCanonicalHandoffEntriesByInteractionIds(chunk),
      engine.listMemoryCandidateSupersessionEntriesByInteractionIds(chunk),
      engine.listMemoryCandidateContradictionEntriesByInteractionIds(chunk),
    ]);
    handoffs.push(...handoffBatch);
    supersessions.push(...supersessionBatch);
    contradictions.push(...contradictionBatch);
  }

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
  for (const event of candidateStatusEvents) {
    if (event.interaction_id && traceIdSet.has(event.interaction_id)) {
      linkedTraceIds.add(event.interaction_id);
    }
  }

  return {
    handoff_count: handoffs.length,
    supersession_count: supersessions.length,
    contradiction_count: contradictions.length,
    traces_with_any_linked_write: linkedTraceIds.size,
    traces_without_linked_write: traceIds.length - linkedTraceIds.size,
  };
}

async function countCandidateStatusEvents(
  engine: BrainEngine,
  traceIds: string[],
  since: Date,
  until: Date,
  filters: {
    task_id?: string;
    scope?: ScopeGateScope;
  },
): Promise<CandidateStatusEventAudit> {
  const events = filters.task_id !== undefined || filters.scope !== undefined
    ? await listCandidateStatusEventsByTraceIds(engine, traceIds)
    : await listAllCandidateStatusEventsInWindow(engine, since, until);
  const inWindow = events.filter((event) => isInAuditWindow(event.created_at, since, until));
  const traceIdSet = new Set(traceIds);
  const linkedTraceIds = new Set<string>();
  for (const event of inWindow) {
    if (event.interaction_id && traceIdSet.has(event.interaction_id)) {
      linkedTraceIds.add(event.interaction_id);
    }
  }

  return {
    counts: {
      created_count: countStatusEventsByKind(inWindow, 'created'),
      advanced_count: countStatusEventsByKind(inWindow, 'advanced'),
      promoted_count: countStatusEventsByKind(inWindow, 'promoted'),
      rejected_count: countStatusEventsByKind(inWindow, 'rejected'),
      superseded_count: countStatusEventsByKind(inWindow, 'superseded'),
      linked_event_count: inWindow.filter((event) => event.interaction_id != null).length,
      unlinked_event_count: inWindow.filter((event) => event.interaction_id == null).length,
      traces_with_candidate_events: linkedTraceIds.size,
    },
    events: inWindow,
  };
}

async function listAllCandidateStatusEventsInWindow(
  engine: BrainEngine,
  since: Date,
  until: Date,
): Promise<MemoryCandidateStatusEvent[]> {
  const events: MemoryCandidateStatusEvent[] = [];
  for (let offset = 0; ; offset += STATUS_EVENT_BATCH_SIZE) {
    const batch = await engine.listMemoryCandidateStatusEvents({
      created_since: since,
      created_until: until,
      limit: STATUS_EVENT_BATCH_SIZE,
      offset,
    });
    events.push(...batch);
    if (batch.length < STATUS_EVENT_BATCH_SIZE) break;
  }
  return events;
}

async function listCandidateStatusEventsByTraceIds(
  engine: BrainEngine,
  traceIds: string[],
): Promise<MemoryCandidateStatusEvent[]> {
  if (traceIds.length === 0) return [];
  const events: MemoryCandidateStatusEvent[] = [];
  for (const chunk of chunkArray(traceIds, LINKED_WRITE_LOOKUP_BATCH_SIZE)) {
    events.push(...await engine.listMemoryCandidateStatusEventsByInteractionIds(chunk));
  }
  return events;
}

async function approximateUnlinkedCandidateEvents(
  engine: BrainEngine,
  since: Date,
  until: Date,
  filters: {
    task_id?: string;
    scope?: ScopeGateScope;
  },
  candidateStatusEvents: CandidateStatusEventAudit,
): Promise<AuditApproximateCounts> {
  if (filters.task_id !== undefined || filters.scope !== undefined) {
    return {
      candidate_creation_same_window: 0,
      candidate_rejection_same_window: 0,
      note: 'suppressed for filtered audits; candidate_status_events are precise for trace-linked lifecycle transitions while legacy candidate rows remain unlinked',
    };
  }

  const createdEventCandidateIds = new Set(
    candidateStatusEvents.events
      .filter((event) => event.event_kind === 'created')
      .map((event) => event.candidate_id),
  );
  const rejectedEventCandidateIds = new Set(
    candidateStatusEvents.events
      .filter((event) => event.event_kind === 'rejected')
      .map((event) => event.candidate_id),
  );

  const candidateCreationCount = await countMemoryCandidateEntriesExcluding(engine, {
    created_since: since,
    created_until: until,
  }, createdEventCandidateIds);
  const candidateRejectionCount = await countMemoryCandidateEntriesExcluding(engine, {
    status: 'rejected',
    reviewed_since: since,
    reviewed_until: until,
  }, rejectedEventCandidateIds);

  return {
    candidate_creation_same_window: candidateStatusEvents.counts.created_count + candidateCreationCount,
    candidate_rejection_same_window: candidateStatusEvents.counts.rejected_count + candidateRejectionCount,
    note: 'compatibility counters; candidate_status_events are precise for service-recorded lifecycle transitions; raw candidate rows remain approximate',
  };
}

async function countMemoryCandidateEntriesExcluding(
  engine: BrainEngine,
  filters: MemoryCandidateFilters,
  excludedCandidateIds: Set<string>,
): Promise<number> {
  let count = 0;
  for (let offset = 0; ; offset += CANDIDATE_BATCH_SIZE) {
    const batch = await engine.listMemoryCandidateEntries({
      ...filters,
      limit: CANDIDATE_BATCH_SIZE,
      offset,
    });
    count += batch.filter((entry: MemoryCandidateEntry) => !excludedCandidateIds.has(entry.id)).length;
    if (batch.length < CANDIDATE_BATCH_SIZE) break;
  }
  return count;
}

async function computeCandidateLifecycleMetrics(
  engine: BrainEngine,
  traces: RetrievalTrace[],
  window: {
    since: Date;
    until: Date;
    reviewWindowDays: number;
  },
): Promise<AuditCandidateLifecycleMetrics> {
  const candidateIds = collectCandidateSignalIds(traces);
  if (candidateIds.length === 0) {
    return emptyCandidateLifecycleMetrics();
  }

  const candidates = new Map<string, MemoryCandidateEntry>();
  for (const candidateId of candidateIds) {
    const candidate = await engine.getMemoryCandidateEntry(candidateId);
    if (candidate) candidates.set(candidateId, candidate);
  }

  const statusEventsByCandidate = await listTerminalStatusEventsForCandidates(
    engine,
    [...candidates.keys()],
    window.since,
    window.until,
  );
  const handoffsByCandidate = new Map<string, CanonicalHandoffEntry[]>();
  const allHandoffs: CanonicalHandoffEntry[] = [];
  for (const candidateId of candidateIds) {
    if (!candidates.has(candidateId)) continue;
    const handoffs = await listCanonicalHandoffEntriesForCandidateInWindow(
      engine,
      candidateId,
      window.since,
      window.until,
    );
    handoffsByCandidate.set(candidateId, handoffs);
    allHandoffs.push(...handoffs);
  }

  const disposedCandidateIds = new Set<string>();
  const dispositionDurations: number[] = [];
  const staleBefore = new Date(window.until.getTime() - window.reviewWindowDays * 24 * 60 * 60 * 1000);
  let staleUnresolvedSignalCount = 0;
  let promotedWithoutHandoffCount = 0;
  const pressureCandidateIds = new Set<string>();
  const pressure: AuditCandidatePressureCounts = {
    review_priority_candidate_count: 0,
    missing_provenance_count: 0,
    stale_promoted_without_handoff_count: 0,
    unresolved_exposed_candidate_count: 0,
  };

  for (const candidateId of candidateIds) {
    const candidate = candidates.get(candidateId);
    if (!candidate) continue;
    const terminalEvents = (statusEventsByCandidate.get(candidateId) ?? []).filter(isTerminalDispositionEvent);
    const handoffs = handoffsByCandidate.get(candidateId) ?? [];
    const dispositionAt = earliestDispositionDate(terminalEvents, handoffs);
    const disposed = dispositionAt != null;
    if (disposed) {
      disposedCandidateIds.add(candidateId);
      const duration = dispositionAt.getTime() - candidate.created_at.getTime();
      if (duration >= 0) dispositionDurations.push(duration);
    }

    const rejectedOrSuperseded = terminalEvents.some((event) =>
      event.event_kind === 'rejected' || event.event_kind === 'superseded');
    const unresolved = !disposed && !rejectedOrSuperseded;
    const missingProvenance = !candidate.source_refs.some((sourceRef) => sourceRef.trim().length > 0);
    const promotedWithoutHandoff = terminalEvents.some((event) => event.event_kind === 'promoted')
      && handoffs.length === 0;

    if (unresolved) {
      pressure.unresolved_exposed_candidate_count += 1;
      if (candidate.created_at <= staleBefore) staleUnresolvedSignalCount += 1;
    }
    if (missingProvenance) {
      pressure.missing_provenance_count += 1;
    }
    if (promotedWithoutHandoff) {
      promotedWithoutHandoffCount += 1;
      pressure.stale_promoted_without_handoff_count += 1;
    }
    if (unresolved || missingProvenance || promotedWithoutHandoff) {
      pressureCandidateIds.add(candidateId);
    }
  }

  pressure.review_priority_candidate_count = pressureCandidateIds.size;

  return {
    candidate_signal_exposure_count: candidateIds.length,
    signal_to_status_event_rate: roundedRatio(disposedCandidateIds.size, candidateIds.length),
    median_time_to_disposition_ms: median(dispositionDurations),
    stale_unresolved_signal_count: staleUnresolvedSignalCount,
    promoted_without_handoff_count: promotedWithoutHandoffCount,
    handoff_without_canonical_update_count: await countHandoffsWithoutCanonicalUpdate(
      engine,
      allHandoffs,
      window.since,
      window.until,
    ),
    pressure,
  };
}

function collectCandidateSignalIds(traces: RetrievalTrace[]): string[] {
  const candidateIds = new Set<string>();
  for (const trace of traces) {
    for (const marker of trace.verification) {
      if (!marker.startsWith(CANDIDATE_SIGNAL_PREFIX)) continue;
      const candidateId = marker.slice(CANDIDATE_SIGNAL_PREFIX.length).trim();
      if (candidateId.length > 0) candidateIds.add(candidateId);
    }
  }
  return [...candidateIds].sort((a, b) => a.localeCompare(b));
}

async function listCanonicalHandoffEntriesForCandidateInWindow(
  engine: BrainEngine,
  candidateId: string,
  since: Date,
  until: Date,
): Promise<CanonicalHandoffEntry[]> {
  const handoffs: CanonicalHandoffEntry[] = [];
  for (let offset = 0; ; offset += CANONICAL_HANDOFF_BATCH_SIZE) {
    const batch = await engine.listCanonicalHandoffEntries({
      candidate_id: candidateId,
      limit: CANONICAL_HANDOFF_BATCH_SIZE,
      offset,
    });
    handoffs.push(...batch.filter((handoff) =>
      handoff.created_at >= since && handoff.created_at < until));
    if (batch.length < CANONICAL_HANDOFF_BATCH_SIZE) break;
  }
  return handoffs;
}

async function listTerminalStatusEventsForCandidates(
  engine: BrainEngine,
  candidateIds: string[],
  since: Date,
  until: Date,
): Promise<Map<string, MemoryCandidateStatusEvent[]>> {
  const byCandidate = new Map<string, MemoryCandidateStatusEvent[]>();
  for (const candidateId of candidateIds) {
    const events: MemoryCandidateStatusEvent[] = [];
    for (const eventKind of TERMINAL_CANDIDATE_STATUS_EVENT_KINDS) {
      for (let offset = 0; ; offset += STATUS_EVENT_BATCH_SIZE) {
        const batch = await engine.listMemoryCandidateStatusEvents({
          candidate_id: candidateId,
          event_kind: eventKind,
          created_since: since,
          created_until: until,
          limit: STATUS_EVENT_BATCH_SIZE,
          offset,
        });
        events.push(...batch);
        if (batch.length < STATUS_EVENT_BATCH_SIZE) break;
      }
    }
    if (events.length > 0) {
      byCandidate.set(candidateId, events.sort((a, b) =>
        a.created_at.getTime() - b.created_at.getTime()
        || a.id.localeCompare(b.id)));
    }
  }
  return byCandidate;
}

function emptyCandidateLifecycleMetrics(): AuditCandidateLifecycleMetrics {
  return {
    candidate_signal_exposure_count: 0,
    signal_to_status_event_rate: 0,
    median_time_to_disposition_ms: null,
    stale_unresolved_signal_count: 0,
    promoted_without_handoff_count: 0,
    handoff_without_canonical_update_count: 0,
    pressure: {
      review_priority_candidate_count: 0,
      missing_provenance_count: 0,
      stale_promoted_without_handoff_count: 0,
      unresolved_exposed_candidate_count: 0,
    },
  };
}

function isTerminalDispositionEvent(event: MemoryCandidateStatusEvent): boolean {
  return event.event_kind === 'promoted'
    || event.event_kind === 'rejected'
    || event.event_kind === 'superseded';
}

function earliestDispositionDate(
  terminalEvents: MemoryCandidateStatusEvent[],
  handoffs: CanonicalHandoffEntry[],
): Date | null {
  const dates = [
    ...terminalEvents.map((event) => event.created_at),
    ...handoffs.map((handoff) => handoff.created_at),
  ].sort((a, b) => a.getTime() - b.getTime());
  return dates[0] ?? null;
}

async function countHandoffsWithoutCanonicalUpdate(
  engine: BrainEngine,
  handoffs: CanonicalHandoffEntry[],
  since: Date,
  until: Date,
): Promise<number> {
  let count = 0;
  const handoffScanStartByTargetId = new Map<string, Date>();
  for (const handoff of handoffs) {
    if (!isPageBackedCanonicalHandoff(handoff)) continue;
    const scanStart = handoffScanStartByTargetId.get(handoff.target_object_id);
    if (!scanStart || handoff.created_at < scanStart) {
      handoffScanStartByTargetId.set(handoff.target_object_id, handoff.created_at);
    }
  }

  const mutationsByTargetId = new Map<string, MemoryMutationEvent[]>();
  for (const handoff of handoffs) {
    if (!isPageBackedCanonicalHandoff(handoff)) continue;
    let mutations = mutationsByTargetId.get(handoff.target_object_id);
    if (!mutations) {
      mutations = await listAppliedPageMutationsForTargetSince(
        engine,
        handoff.target_object_id,
        maxDate(handoffScanStartByTargetId.get(handoff.target_object_id) ?? handoff.created_at, since),
        until,
      );
      mutationsByTargetId.set(handoff.target_object_id, mutations);
    }
    const linkedSourceRefs = canonicalUpdateLinkSourceRefs(handoff);
    const hasCanonicalUpdate = mutations.some((mutation) =>
      mutation.created_at >= handoff.created_at
      && mutation.created_at >= since
      && mutation.source_refs.some((sourceRef) => linkedSourceRefs.has(sourceRef.trim())));
    if (!hasCanonicalUpdate) count += 1;
  }
  return count;
}

function isPageBackedCanonicalHandoff(handoff: CanonicalHandoffEntry): boolean {
  return handoff.target_object_type === 'curated_note';
}

function canonicalUpdateLinkSourceRefs(handoff: CanonicalHandoffEntry): Set<string> {
  const sourceRefs = new Set<string>([
    `canonical_handoff:${handoff.id}`,
    `memory_candidate:${handoff.candidate_id}`,
  ]);
  for (const sourceRef of handoff.source_refs) {
    const normalized = sourceRef.trim();
    if (normalized.length > 0) sourceRefs.add(normalized);
  }
  return sourceRefs;
}

function maxDate(left: Date, right: Date): Date {
  return left >= right ? left : right;
}

async function listAppliedPageMutationsForTargetSince(
  engine: BrainEngine,
  targetId: string,
  createdSince: Date,
  createdUntil: Date,
): Promise<MemoryMutationEvent[]> {
  const mutations: MemoryMutationEvent[] = [];
  for (let offset = 0; ; offset += MUTATION_EVENT_BATCH_SIZE) {
    const batch = await engine.listMemoryMutationEvents({
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetId,
      result: 'applied',
      created_since: createdSince,
      created_until: createdUntil,
      limit: MUTATION_EVENT_BATCH_SIZE,
      offset,
    });
    mutations.push(...batch);
    if (batch.length < MUTATION_EVENT_BATCH_SIZE) break;
  }
  return mutations;
}

function roundedRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint];
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

async function computeTaskCompliance(
  engine: BrainEngine,
  traces: RetrievalTrace[],
  limit: number,
  window: {
    until: Date;
  },
  filters: {
    task_id?: string;
    scope?: ScopeGateScope;
  } = {},
): Promise<AuditTaskCompliance> {
  const { tasks, cappedAt } = await listTaskThreadsForCompliance(engine, filters);

  const lastTraceByTask = new Map<string, RetrievalTrace>();
  for (const trace of traces) {
    if (!trace.task_id) continue;
    const previous = lastTraceByTask.get(trace.task_id);
    if (!previous || previous.created_at < trace.created_at) {
      lastTraceByTask.set(trace.task_id, trace);
    }
  }
  const tasksWithoutWindowTrace = tasks.filter((task) => !lastTraceByTask.has(task.id));
  const backlog: AuditTaskCompliance['top_backlog'] = [];
  for (const task of tasksWithoutWindowTrace.slice(0, limit)) {
    const latestTrace = await getLatestTaskTraceBefore(engine, task.id, window.until);
    backlog.push({
      task_id: task.id,
      last_trace_at: latestTrace?.created_at.toISOString() ?? null,
      last_route_kind: latestTrace ? traceRouteKind(latestTrace) : null,
    });
  }

  return {
    tasks_with_traces: tasks.filter((task) => lastTraceByTask.has(task.id)).length,
    tasks_without_traces: tasksWithoutWindowTrace.length,
    task_scan_capped_at: cappedAt,
    top_backlog: backlog,
  };
}

async function getLatestTaskTraceBefore(
  engine: BrainEngine,
  taskId: string,
  until: Date,
): Promise<RetrievalTrace | null> {
  const traces = await engine.listRetrievalTracesByWindow({
    since: TRACE_HISTORY_START,
    until,
    task_id: taskId,
    limit: 1,
    offset: 0,
  });
  return traces[0] ?? null;
}

function traceRouteKind(trace: RetrievalTrace): string | null {
  if (trace.selected_intent) {
    return trace.selected_intent;
  }
  const intentMarker = trace.verification.find((item) => item.startsWith('intent:'));
  if (intentMarker) {
    return intentMarker.slice('intent:'.length) || null;
  }
  return trace.route[0] ?? null;
}

async function listTaskThreadsForCompliance(
  engine: BrainEngine,
  filters: {
    task_id?: string;
    scope?: ScopeGateScope;
  },
): Promise<{ tasks: TaskThread[]; cappedAt: number | null }> {
  if (filters.task_id !== undefined) {
    const task = await engine.getTaskThread(filters.task_id);
    if (!task || (filters.scope !== undefined && task.scope !== filters.scope)) {
      return { tasks: [], cappedAt: null };
    }
    return { tasks: [task], cappedAt: null };
  }

  if (filters.scope !== undefined && !isTaskScope(filters.scope)) {
    return { tasks: [], cappedAt: null };
  }

  const tasks: TaskThread[] = [];
  const baseFilters = filters.scope === undefined ? {} : { scope: filters.scope };
  for (let offset = 0; tasks.length < TASK_SCAN_CAP; offset += TASK_BATCH_SIZE) {
    const remaining = TASK_SCAN_CAP - tasks.length;
    const limit = Math.min(TASK_BATCH_SIZE, remaining);
    const batch = await engine.listTaskThreads({ ...baseFilters, limit, offset });
    tasks.push(...batch);
    if (batch.length < limit) {
      return { tasks, cappedAt: null };
    }
  }

  const overflow = await engine.listTaskThreads({
    ...baseFilters,
    limit: 1,
    offset: TASK_SCAN_CAP,
  });
  return { tasks, cappedAt: overflow.length > 0 ? TASK_SCAN_CAP : null };
}

function isTaskScope(scope: ScopeGateScope): scope is TaskScope {
  return scope === 'work' || scope === 'personal' || scope === 'mixed';
}

function normalizeDate(input: Date | string | undefined, fallback: Date): Date {
  if (input === undefined) return fallback;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new Error(`Invalid audit date: ${String(input)}`);
    }
    return input;
  }
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

function validateAuditWindow(since: Date, until: Date): void {
  if (since >= until) {
    throw new Error('Invalid audit window: since must be before until');
  }
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

function isInAuditWindow(value: Date, since: Date, until: Date): boolean {
  return value >= since && value < until;
}

function countStatusEventsByKind(
  events: MemoryCandidateStatusEvent[],
  kind: MemoryCandidateStatusEvent['event_kind'],
): number {
  return events.filter((event) => event.event_kind === kind).length;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function buildSummaryLines(
  traces: RetrievalTrace[],
  linkedWrites: AuditLinkedWriteCounts,
  candidateLifecycle: AuditCandidateLifecycleMetrics,
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
    `candidate_signal_exposures=${candidateLifecycle.candidate_signal_exposure_count}`,
    `canonical_refs=${canonicalRefCount}`,
    `derived_refs=${derivedRefCount}`,
  ];
}
