import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { RetrievalTrace } from '../src/core/types.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { auditBrainLoop } from '../src/core/services/brain-loop-audit-service.ts';

async function createSqliteEngine() {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-brain-loop-audit-'));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();

  return {
    engine: engine as unknown as BrainEngine,
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitForClockAfter(value: Date): Promise<Date> {
  for (;;) {
    const now = new Date();
    if (now.getTime() > value.getTime()) return now;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function makeTrace(id: string, taskId: string | null = null): RetrievalTrace {
  return {
    id,
    task_id: taskId,
    scope: 'work',
    route: [],
    source_refs: [],
    derived_consulted: [],
    verification: [],
    write_outcome: 'no_durable_write',
    selected_intent: 'precision_lookup',
    scope_gate_policy: null,
    scope_gate_reason: null,
    outcome: 'test trace',
    created_at: new Date(),
  };
}

async function createCandidate(
  engine: BrainEngine,
  id: string,
  options: {
    status?: 'captured' | 'candidate' | 'staged_for_review';
    scopeId?: string;
    targetObjectType?: 'curated_note' | 'procedure' | 'profile_memory' | 'personal_episode';
    targetObjectId?: string;
    sourceRefs?: string[];
  } = {},
) {
  return await engine.createMemoryCandidateEntry({
    id,
    scope_id: options.scopeId ?? 'workspace:default',
    candidate_type: 'fact',
    proposed_content: `Candidate ${id}.`,
    source_refs: options.sourceRefs ?? ['User, direct message, 2026-04-24 10:00 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: options.status ?? 'captured',
    target_object_type: options.targetObjectType ?? 'curated_note',
    target_object_id: options.targetObjectId ?? `note-${id}`,
  });
}

test('auditBrainLoop summarizes trace counts and canonical-vs-derived reads', async () => {
  const harness = await createSqliteEngine();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.createTaskThread({
      id: 'task-audit',
      scope: 'work',
      title: 'Audit task',
      status: 'active',
    });
    await harness.engine.putRetrievalTrace({
      id: 'trace-task-resume',
      task_id: 'task-audit',
      scope: 'work',
      route: ['task_thread', 'working_set'],
      source_refs: ['task-thread:task-audit'],
      verification: ['intent:task_resume'],
      selected_intent: 'task_resume',
      write_outcome: 'no_durable_write',
      outcome: 'task_resume route selected',
    });
    await harness.engine.putRetrievalTrace({
      id: 'trace-broad-synthesis',
      task_id: 'task-audit',
      scope: 'work',
      route: ['curated_notes', 'context_map_report'],
      source_refs: [],
      derived_consulted: ['context-map:workspace'],
      verification: ['intent:broad_synthesis'],
      selected_intent: 'broad_synthesis',
      write_outcome: 'no_durable_write',
      outcome: 'broad_synthesis route selected',
    });

    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.total_traces).toBe(2);
    expect(report.by_selected_intent.task_resume).toBe(1);
    expect(report.by_selected_intent.broad_synthesis).toBe(1);
    expect(report.canonical_vs_derived.canonical_ref_count).toBe(1);
    expect(report.canonical_vs_derived.derived_ref_count).toBe(1);
    expect(report.linked_writes.traces_without_linked_write).toBe(2);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop task_id filter limits task compliance to the requested task', async () => {
  const harness = await createSqliteEngine();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.createTaskThread({
      id: 'task-filtered-a',
      scope: 'work',
      title: 'Filtered task A',
      status: 'active',
    });
    await harness.engine.createTaskThread({
      id: 'task-filtered-b',
      scope: 'work',
      title: 'Filtered task B',
      status: 'active',
    });
    await harness.engine.putRetrievalTrace({
      id: 'trace-filtered-a',
      task_id: 'task-filtered-a',
      scope: 'work',
      route: [],
      source_refs: [],
      verification: [],
      selected_intent: 'task_resume',
      outcome: 'task A trace',
    });

    const report = await auditBrainLoop(harness.engine, {
      since,
      until,
      task_id: 'task-filtered-a',
    });

    expect(report.total_traces).toBe(1);
    expect(report.task_compliance.tasks_with_traces).toBe(1);
    expect(report.task_compliance.tasks_without_traces).toBe(0);
    expect(report.task_compliance.top_backlog).toEqual([]);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop scope filter limits task compliance to matching task scope', async () => {
  const harness = await createSqliteEngine();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.createTaskThread({
      id: 'task-scope-work-with-trace',
      scope: 'work',
      title: 'Work task with trace',
      status: 'active',
    });
    await harness.engine.createTaskThread({
      id: 'task-scope-work-without-trace',
      scope: 'work',
      title: 'Work task without trace',
      status: 'active',
    });
    await harness.engine.createTaskThread({
      id: 'task-scope-personal-without-trace',
      scope: 'personal',
      title: 'Personal task without trace',
      status: 'active',
    });
    await harness.engine.putRetrievalTrace({
      id: 'trace-scope-work',
      task_id: 'task-scope-work-with-trace',
      scope: 'work',
      route: [],
      source_refs: [],
      verification: [],
      selected_intent: 'task_resume',
      outcome: 'work trace',
    });

    const report = await auditBrainLoop(harness.engine, {
      since,
      until,
      scope: 'work',
    });

    expect(report.total_traces).toBe(1);
    expect(report.task_compliance.tasks_with_traces).toBe(1);
    expect(report.task_compliance.tasks_without_traces).toBe(1);
    expect(report.task_compliance.top_backlog.map((entry) => entry.task_id)).toEqual([
      'task-scope-work-without-trace',
    ]);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop returns an empty-window report with neutral canonical ratio', async () => {
  const harness = await createSqliteEngine();

  try {
    const report = await auditBrainLoop(harness.engine, {
      since: new Date(Date.now() - 60 * 60 * 1000),
      until: new Date(Date.now()),
    });

    expect(report.total_traces).toBe(0);
    expect(report.linked_writes.handoff_count).toBe(0);
    expect(report.linked_writes.traces_without_linked_write).toBe(0);
    expect(report.canonical_vs_derived.canonical_ratio).toBe(1);
    expect(report.summary_lines.join(' ').toLowerCase()).toContain('no');
    expect(report.summary_lines.join(' ').toLowerCase()).toContain('activity');
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop backlog includes the latest pre-window trace details', async () => {
  const harness = await createSqliteEngine();

  try {
    await harness.engine.createTaskThread({
      id: 'task-backlog-history',
      scope: 'work',
      title: 'Backlog task with historical trace',
      status: 'active',
    });
    await harness.engine.putRetrievalTrace({
      id: 'trace-backlog-history',
      task_id: 'task-backlog-history',
      scope: 'work',
      route: ['task_thread'],
      source_refs: ['task-thread:task-backlog-history'],
      verification: ['intent:task_resume'],
      selected_intent: 'task_resume',
      outcome: 'historical trace before audit window',
    });

    const since = new Date(Date.now() + 1000);
    const until = new Date(Date.now() + 60 * 60 * 1000);
    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.total_traces).toBe(0);
    expect(report.task_compliance.tasks_without_traces).toBe(1);
    expect(report.task_compliance.top_backlog).toHaveLength(1);
    expect(report.task_compliance.top_backlog[0]).toEqual({
      task_id: 'task-backlog-history',
      last_trace_at: expect.any(String),
      last_route_kind: 'task_resume',
    });
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop rejects invalid and inverted audit windows before scanning', async () => {
  await expect(auditBrainLoop({} as BrainEngine, {
    since: new Date('invalid-date'),
    until: new Date(),
  })).rejects.toThrow('Invalid audit date');

  await expect(auditBrainLoop({} as BrainEngine, {
    since: new Date('2026-04-24T11:00:00.000Z'),
    until: new Date('2026-04-24T10:00:00.000Z'),
  })).rejects.toThrow('since must be before until');
});

test('auditBrainLoop groups legacy null intent traces under unknown_legacy', async () => {
  const harness = await createSqliteEngine();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.putRetrievalTrace({
      id: 'legacy-null-intent',
      task_id: null,
      scope: 'unknown',
      route: [],
      source_refs: [],
      verification: [],
      selected_intent: null,
      outcome: 'legacy route unavailable',
    });

    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.by_selected_intent.unknown_legacy).toBe(1);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop suppresses approximate candidate counts for filtered audits', async () => {
  const harness = await createSqliteEngine();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.createTaskThread({
      id: 'task-filtered-approximate',
      scope: 'work',
      title: 'Filtered approximate task',
      status: 'active',
    });
    await harness.engine.putRetrievalTrace({
      id: 'trace-filtered-approximate',
      task_id: 'task-filtered-approximate',
      scope: 'work',
      route: [],
      source_refs: [],
      verification: [],
      selected_intent: 'task_resume',
      outcome: 'filtered approximate trace',
    });
    await createCandidate(harness.engine, 'candidate-unrelated-filtered-audit');

    const taskReport = await auditBrainLoop(harness.engine, {
      since,
      until,
      task_id: 'task-filtered-approximate',
    });
    const scopeReport = await auditBrainLoop(harness.engine, {
      since,
      until,
      scope: 'work',
    });

    expect(taskReport.approximate.candidate_creation_same_window).toBe(0);
    expect(taskReport.approximate.candidate_rejection_same_window).toBe(0);
    expect(taskReport.approximate.note).toContain('suppressed');
    expect(scopeReport.approximate.candidate_creation_same_window).toBe(0);
    expect(scopeReport.approximate.candidate_rejection_same_window).toBe(0);
    expect(scopeReport.approximate.note).toContain('suppressed');
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop counts linked write rows by interaction_id', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-linked-write';
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: [],
      source_refs: [],
      verification: [],
      selected_intent: 'precision_lookup',
      outcome: 'linked write trace',
    });

    await createCandidate(harness.engine, 'candidate-handoff-linked', {
      status: 'staged_for_review',
      targetObjectId: 'note-handoff-linked',
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-handoff-linked', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Promoted for linked-write audit.',
    });
    await harness.engine.createCanonicalHandoffEntry({
      id: 'handoff-linked',
      scope_id: 'workspace:default',
      candidate_id: 'candidate-handoff-linked',
      target_object_type: 'curated_note',
      target_object_id: 'note-handoff-linked',
      source_refs: [],
      interaction_id: traceId,
    });

    await createCandidate(harness.engine, 'candidate-superseded-linked', {
      status: 'staged_for_review',
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-superseded-linked', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Promoted for supersession audit.',
    });
    await createCandidate(harness.engine, 'candidate-replacement-linked', {
      status: 'staged_for_review',
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-replacement-linked', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Promoted as supersession replacement for audit.',
    });
    await harness.engine.supersedeMemoryCandidateEntry({
      id: 'supersession-linked',
      scope_id: 'workspace:default',
      superseded_candidate_id: 'candidate-superseded-linked',
      replacement_candidate_id: 'candidate-replacement-linked',
      expected_current_status: 'promoted',
      reviewed_at: new Date(),
      review_reason: 'Linked supersession audit.',
      interaction_id: traceId,
    });

    await createCandidate(harness.engine, 'candidate-contradiction-linked');
    await createCandidate(harness.engine, 'candidate-challenged-linked');
    await harness.engine.createMemoryCandidateContradictionEntry({
      id: 'contradiction-linked',
      scope_id: 'workspace:default',
      candidate_id: 'candidate-contradiction-linked',
      challenged_candidate_id: 'candidate-challenged-linked',
      outcome: 'unresolved',
      reviewed_at: new Date(),
      review_reason: 'Linked contradiction audit.',
      interaction_id: traceId,
    });

    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.linked_writes.handoff_count).toBe(1);
    expect(report.linked_writes.supersession_count).toBe(1);
    expect(report.linked_writes.contradiction_count).toBe(1);
    expect(report.linked_writes.traces_with_any_linked_write).toBe(1);
    expect(report.linked_writes.traces_without_linked_write).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop reports precise candidate status-event counts by interaction id', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-candidate-status-events-audit';
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: [],
      source_refs: [],
      verification: [],
      selected_intent: 'precision_lookup',
      outcome: 'candidate status-event audit trace',
    });

    await harness.engine.createMemoryCandidateStatusEvent({
      id: 'audit-status-event-created',
      candidate_id: 'audit-status-event-candidate',
      scope_id: 'workspace:default',
      from_status: null,
      to_status: 'captured',
      event_kind: 'created',
      interaction_id: traceId,
      created_at: new Date(),
    });
    await harness.engine.createMemoryCandidateStatusEvent({
      id: 'audit-status-event-advanced',
      candidate_id: 'audit-status-event-candidate',
      scope_id: 'workspace:default',
      from_status: 'captured',
      to_status: 'candidate',
      event_kind: 'advanced',
      interaction_id: traceId,
      created_at: new Date(),
    });

    const report = await auditBrainLoop(harness.engine, { since, until, scope: 'work' });

    expect(report.candidate_status_events.created_count).toBe(1);
    expect(report.candidate_status_events.advanced_count).toBe(1);
    expect(report.candidate_status_events.linked_event_count).toBe(2);
    expect(report.candidate_status_events.unlinked_event_count).toBe(0);
    expect(report.candidate_status_events.traces_with_candidate_events).toBe(1);
    expect(report.linked_writes.traces_with_any_linked_write).toBe(1);
    expect(report.linked_writes.traces_without_linked_write).toBe(0);
    expect(report.approximate.candidate_creation_same_window).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop counts candidate-event trace ids only when the trace is in the audit window', async () => {
  const since = new Date('2026-04-25T10:00:00.000Z');
  const until = new Date('2026-04-25T11:00:00.000Z');
  const engine = {
    listRetrievalTracesByWindow: async () => [],
    listCanonicalHandoffEntriesByInteractionIds: async () => [],
    listMemoryCandidateSupersessionEntriesByInteractionIds: async () => [],
    listMemoryCandidateContradictionEntriesByInteractionIds: async () => [],
    listMemoryCandidateStatusEvents: async () => [{
      id: 'audit-status-event-outside-trace',
      candidate_id: 'candidate-outside-trace',
      scope_id: 'workspace:default',
      from_status: null,
      to_status: 'captured',
      event_kind: 'created',
      interaction_id: 'trace-outside-window',
      reviewed_at: null,
      review_reason: null,
      created_at: new Date('2026-04-25T10:30:00.000Z'),
    }],
    listMemoryCandidateStatusEventsByInteractionIds: async () => [],
    listMemoryCandidateEntries: async () => [],
    listTaskThreads: async () => [],
  } as unknown as BrainEngine;

  const report = await auditBrainLoop(engine, { since, until });

  expect(report.total_traces).toBe(0);
  expect(report.candidate_status_events.linked_event_count).toBe(1);
  expect(report.candidate_status_events.traces_with_candidate_events).toBe(0);
  expect(report.linked_writes.traces_with_any_linked_write).toBe(0);
});

test('auditBrainLoop keeps approximate counters compatible for raw candidate rows', async () => {
  const harness = await createSqliteEngine();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await createCandidate(harness.engine, 'candidate-raw-compatibility', {
      status: 'staged_for_review',
    });
    await harness.engine.updateMemoryCandidateEntryStatus('candidate-raw-compatibility', {
      status: 'rejected',
      reviewed_at: new Date(),
      review_reason: 'Raw compatibility count.',
    });

    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.approximate.candidate_creation_same_window).toBe(1);
    expect(report.approximate.candidate_rejection_same_window).toBe(1);
    expect(report.candidate_status_events.created_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop counts unfiltered status events without double-counting represented candidate rows', async () => {
  const harness = await createSqliteEngine();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await createCandidate(harness.engine, 'candidate-status-event-compatibility', {
      status: 'staged_for_review',
    });
    await harness.engine.createMemoryCandidateStatusEvent({
      id: 'audit-status-event-compat-created',
      candidate_id: 'candidate-status-event-compatibility',
      scope_id: 'workspace:default',
      from_status: null,
      to_status: 'staged_for_review',
      event_kind: 'created',
      interaction_id: null,
      created_at: new Date(),
    });
    await harness.engine.createMemoryCandidateStatusEvent({
      id: 'audit-status-event-compat-rejected',
      candidate_id: 'candidate-status-event-compatibility',
      scope_id: 'workspace:default',
      from_status: 'staged_for_review',
      to_status: 'rejected',
      event_kind: 'rejected',
      interaction_id: null,
      created_at: new Date(),
    });
    await harness.engine.updateMemoryCandidateEntryStatus('candidate-status-event-compatibility', {
      status: 'rejected',
      reviewed_at: new Date(),
      review_reason: 'Status event should prevent raw fallback double count.',
    });

    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.candidate_status_events.created_count).toBe(1);
    expect(report.candidate_status_events.rejected_count).toBe(1);
    expect(report.candidate_status_events.unlinked_event_count).toBe(2);
    expect(report.approximate.candidate_creation_same_window).toBe(1);
    expect(report.approximate.candidate_rejection_same_window).toBe(1);
    expect(report.approximate.note).toContain('candidate_status_events are precise');
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop chunks linked-write lookups across large trace windows', async () => {
  const traces = Array.from({ length: 1001 }, (_, index) => makeTrace(`trace-large-${index}`));
  const lookupSizes: number[] = [];
  const engine = {
    listRetrievalTracesByWindow: async (filters: { limit?: number; offset?: number }) => {
      const limit = filters.limit ?? 500;
      const offset = filters.offset ?? 0;
      return traces.slice(offset, offset + limit);
    },
    listCanonicalHandoffEntriesByInteractionIds: async (interactionIds: string[]) => {
      lookupSizes.push(interactionIds.length);
      if (interactionIds.length > 500) {
        throw new Error('linked write lookup was not chunked');
      }
      return interactionIds.includes('trace-large-750')
        ? [{ interaction_id: 'trace-large-750' }]
        : [];
    },
    listMemoryCandidateSupersessionEntriesByInteractionIds: async (interactionIds: string[]) => {
      if (interactionIds.length > 500) {
        throw new Error('linked write lookup was not chunked');
      }
      return [];
    },
    listMemoryCandidateContradictionEntriesByInteractionIds: async (interactionIds: string[]) => {
      if (interactionIds.length > 500) {
        throw new Error('linked write lookup was not chunked');
      }
      return [];
    },
    listMemoryCandidateStatusEvents: async () => [],
    listMemoryCandidateStatusEventsByInteractionIds: async () => [],
    listMemoryCandidateEntries: async () => [],
    listTaskThreads: async () => [],
  } as unknown as BrainEngine;

  const report = await auditBrainLoop(engine, {
    since: new Date(Date.now() - 60 * 60 * 1000),
    until: new Date(Date.now() + 60 * 60 * 1000),
  });

  expect(report.total_traces).toBe(1001);
  expect(Math.max(...lookupSizes)).toBeLessThanOrEqual(500);
  expect(report.linked_writes.handoff_count).toBe(1);
  expect(report.linked_writes.traces_with_any_linked_write).toBe(1);
});

test('auditBrainLoop scans approximate candidates through window filters', async () => {
  const since = new Date('2026-04-24T10:00:00.000Z');
  const until = new Date('2026-04-24T11:00:00.000Z');
  const candidateFilters: Array<Record<string, unknown>> = [];
  const engine = {
    listRetrievalTracesByWindow: async () => [],
    listCanonicalHandoffEntriesByInteractionIds: async () => [],
    listMemoryCandidateSupersessionEntriesByInteractionIds: async () => [],
    listMemoryCandidateContradictionEntriesByInteractionIds: async () => [],
    listMemoryCandidateStatusEvents: async () => [],
    listMemoryCandidateStatusEventsByInteractionIds: async () => [],
    listMemoryCandidateEntries: async (filters: Record<string, unknown>) => {
      candidateFilters.push(filters);
      return [];
    },
    listTaskThreads: async () => [],
  } as unknown as BrainEngine;

  await auditBrainLoop(engine, { since, until });

  expect(candidateFilters).toHaveLength(2);
  expect(candidateFilters[0].created_since).toEqual(since);
  expect(candidateFilters[0].created_until).toEqual(until);
  expect(candidateFilters[1].status).toBe('rejected');
  expect(candidateFilters[1].reviewed_since).toEqual(since);
  expect(candidateFilters[1].reviewed_until).toEqual(until);
});

test('auditBrainLoop labels unlinked candidate events as approximate', async () => {
  const harness = await createSqliteEngine();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.createMemoryCandidateEntry({
      id: 'candidate-approximate',
      scope_id: 'workspace:default',
      candidate_type: 'fact',
      proposed_content: 'Approximate audit candidate.',
      source_refs: ['User, direct message, 2026-04-24 10:00 AM KST'],
      generated_by: 'manual',
      extraction_kind: 'manual',
      confidence_score: 0.8,
      importance_score: 0.7,
      recurrence_score: 0.1,
      sensitivity: 'work',
      status: 'captured',
      target_object_type: 'curated_note',
      target_object_id: 'concepts/audit',
    });
    await harness.engine.updateMemoryCandidateEntryStatus('candidate-approximate', {
      status: 'candidate',
    });
    await harness.engine.updateMemoryCandidateEntryStatus('candidate-approximate', {
      status: 'staged_for_review',
    });
    await harness.engine.updateMemoryCandidateEntryStatus('candidate-approximate', {
      status: 'rejected',
      reviewed_at: new Date(),
      review_reason: 'Audit approximate count fixture.',
    });

    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.approximate.candidate_creation_same_window).toBe(1);
    expect(report.approximate.candidate_rejection_same_window).toBe(1);
    expect(report.approximate.note).toContain('approximate');
    expect(report.linked_writes.traces_with_any_linked_write).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop does not mark task scan capped at exactly 5000 rows', async () => {
  const harness = await createSqliteEngine();

  try {
    for (let index = 0; index < 5000; index += 1) {
      await harness.engine.createTaskThread({
        id: `task-audit-exact-cap-${String(index).padStart(4, '0')}`,
        scope: 'work',
        title: `Audit exact cap task ${index}`,
        status: 'active',
      });
    }

    const report = await auditBrainLoop(harness.engine, {
      since: new Date(Date.now() - 60 * 60 * 1000),
      until: new Date(Date.now()),
    });

    expect(report.task_compliance.task_scan_capped_at).toBeNull();
    expect(report.task_compliance.tasks_without_traces).toBe(5000);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop caps task compliance scans at 5000 rows', async () => {
  const harness = await createSqliteEngine();

  try {
    for (let index = 0; index < 5001; index += 1) {
      await harness.engine.createTaskThread({
        id: `task-audit-cap-${String(index).padStart(4, '0')}`,
        scope: 'work',
        title: `Audit cap task ${index}`,
        status: 'active',
      });
    }

    const report = await auditBrainLoop(harness.engine, {
      since: new Date(Date.now() - 60 * 60 * 1000),
      until: new Date(Date.now()),
    });

    expect(report.task_compliance.task_scan_capped_at).toBe(5000);
    expect(report.task_compliance.tasks_without_traces).toBe(5000);
    expect(report.task_compliance.top_backlog).toHaveLength(50);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop reports candidate exposure, disposition, handoff, and pressure metrics', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-candidate-lifecycle';
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.createTaskThread({
      id: 'task-audit-candidate-lifecycle',
      scope: 'work',
      title: 'Audit candidate lifecycle',
      status: 'active',
    });
    await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: 'task-audit-candidate-lifecycle',
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: ['page:systems/mbrain'],
      verification: [
        'scenario:knowledge_qa',
        'candidate_signal_policy:normal',
        'candidate_signal:candidate-audit-exposed',
        'candidate_signal:candidate-audit-promoted',
      ],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context selected canonical read candidates',
    });

    await createCandidate(harness.engine, 'candidate-audit-exposed', {
      status: 'candidate',
      targetObjectId: 'systems/mbrain',
    });
    await createCandidate(harness.engine, 'candidate-audit-promoted', {
      status: 'staged_for_review',
      targetObjectId: 'systems/mbrain',
    });
    await harness.engine.createMemoryCandidateStatusEvent({
      id: 'status-event-audit-promoted',
      candidate_id: 'candidate-audit-promoted',
      scope_id: 'workspace:default',
      from_status: 'staged_for_review',
      to_status: 'promoted',
      event_kind: 'promoted',
      interaction_id: traceId,
      reviewed_at: new Date(),
      review_reason: 'Scenario promotion.',
      created_at: new Date(),
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-audit-promoted', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Scenario promotion.',
    });
    await harness.engine.createCanonicalHandoffEntry({
      id: 'handoff-audit-promoted',
      scope_id: 'workspace:default',
      candidate_id: 'candidate-audit-promoted',
      target_object_type: 'curated_note',
      target_object_id: 'systems/mbrain',
      source_refs: ['memory_candidate:candidate-audit-promoted'],
      reviewed_at: new Date(),
      review_reason: 'Scenario handoff.',
      interaction_id: traceId,
    });
    await harness.engine.createMemoryMutationEvent({
      id: 'mutation-audit-promoted-page',
      session_id: 'audit-session',
      realm_id: 'audit-realm',
      actor: 'test',
      operation: 'put_page',
      target_kind: 'page',
      target_id: 'systems/mbrain',
      scope_id: 'workspace:default',
      source_refs: ['canonical_handoff:handoff-audit-promoted'],
      result: 'applied',
      dry_run: false,
      redaction_visibility: 'visible',
    });

    const report = await auditBrainLoop(harness.engine, {
      since,
      until,
      task_id: 'task-audit-candidate-lifecycle',
      candidate_review_window_days: 0,
    });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(2);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(0.5);
    expect(report.candidate_lifecycle.promoted_without_handoff_count).toBe(0);
    expect(report.candidate_lifecycle.handoff_without_canonical_update_count).toBe(0);
    expect(report.candidate_lifecycle.stale_unresolved_signal_count).toBe(1);
    expect(report.candidate_lifecycle.median_time_to_disposition_ms).not.toBeNull();
    expect(report.candidate_lifecycle.pressure.review_priority_candidate_count).toBe(1);
    expect(report.summary_lines).toContain('candidate_signal_exposures=2');
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop lifecycle metrics count unlinked terminal candidate events', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-unlinked-candidate-disposition';
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);

  try {
    await harness.engine.createTaskThread({
      id: 'task-audit-unlinked-candidate-disposition',
      scope: 'work',
      title: 'Audit unlinked candidate disposition',
      status: 'active',
    });
    await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: 'task-audit-unlinked-candidate-disposition',
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: ['page:systems/mbrain'],
      verification: ['candidate_signal:candidate-audit-unlinked-disposed'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate with unlinked disposition',
    });
    await createCandidate(harness.engine, 'candidate-audit-unlinked-disposed', {
      status: 'staged_for_review',
      targetObjectId: 'systems/mbrain',
    });
    await harness.engine.createMemoryCandidateStatusEvent({
      id: 'status-event-audit-unlinked-disposed',
      candidate_id: 'candidate-audit-unlinked-disposed',
      scope_id: 'workspace:default',
      from_status: 'staged_for_review',
      to_status: 'rejected',
      event_kind: 'rejected',
      interaction_id: null,
      reviewed_at: new Date(),
      review_reason: 'Unlinked terminal disposition.',
      created_at: new Date(),
    });

    const report = await auditBrainLoop(harness.engine, {
      since,
      until,
      task_id: 'task-audit-unlinked-candidate-disposition',
      candidate_review_window_days: 0,
    });

    expect(report.candidate_status_events.rejected_count).toBe(0);
    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(1);
    expect(report.candidate_lifecycle.median_time_to_disposition_ms).not.toBeNull();
    expect(report.candidate_lifecycle.stale_unresolved_signal_count).toBe(0);
    expect(report.candidate_lifecycle.pressure.unresolved_exposed_candidate_count).toBe(0);
    expect(report.candidate_lifecycle.pressure.review_priority_candidate_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop counts repeated candidate signal exposures without duplicating pressure candidates', async () => {
  const harness = await createSqliteEngine();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const targetObjectId = 'systems/mbrain-repeated-exposure';

  try {
    await createCandidate(harness.engine, 'candidate-audit-repeated-exposure', {
      status: 'captured',
      targetObjectId,
    });
    await harness.engine.putRetrievalTrace({
      id: 'trace-audit-repeated-exposure-a',
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-repeated-exposure'],
      selected_intent: 'broad_synthesis',
      outcome: 'first repeated exposure',
    });
    await waitForClockAfter(new Date());
    await harness.engine.putRetrievalTrace({
      id: 'trace-audit-repeated-exposure-b',
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: [
        'candidate_signal:candidate-audit-repeated-exposure',
        'candidate_signal:candidate-audit-repeated-exposure',
      ],
      selected_intent: 'broad_synthesis',
      outcome: 'second repeated exposure',
    });

    const report = await auditBrainLoop(harness.engine, {
      since,
      until: new Date(Date.now() + 60 * 60 * 1000),
      candidate_review_window_days: 0,
    });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(2);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(0);
    expect(report.candidate_lifecycle.stale_unresolved_signal_count).toBe(1);
    expect(report.candidate_lifecycle.pressure.unresolved_exposed_candidate_count).toBe(1);
    expect(report.candidate_lifecycle.pressure.review_priority_candidate_count).toBe(1);
    expect(report.summary_lines).toContain('candidate_signal_exposures=2');
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop does not count dispositions that happened before candidate signal exposure', async () => {
  const harness = await createSqliteEngine();
  const targetObjectId = 'systems/mbrain-pre-exposure-disposition';

  try {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    await createCandidate(harness.engine, 'candidate-audit-pre-exposure-disposition', {
      status: 'staged_for_review',
      targetObjectId,
    });
    const disposition = await harness.engine.createMemoryCandidateStatusEvent({
      id: 'status-event-audit-pre-exposure-disposition',
      candidate_id: 'candidate-audit-pre-exposure-disposition',
      scope_id: 'workspace:default',
      from_status: 'staged_for_review',
      to_status: 'rejected',
      event_kind: 'rejected',
      interaction_id: null,
      reviewed_at: new Date(),
      review_reason: 'Rejected before later retrieval exposure.',
      created_at: new Date(),
    });
    await harness.engine.updateMemoryCandidateEntryStatus('candidate-audit-pre-exposure-disposition', {
      status: 'rejected',
      reviewed_at: disposition.created_at,
      review_reason: 'Rejected before later retrieval exposure.',
    });
    await waitForClockAfter(disposition.created_at);
    const trace = await harness.engine.putRetrievalTrace({
      id: 'trace-audit-pre-exposure-disposition',
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-pre-exposure-disposition'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate after disposition',
    });

    const report = await auditBrainLoop(harness.engine, {
      since,
      until: new Date(trace.created_at.getTime() + 60 * 60 * 1000),
      candidate_review_window_days: 0,
    });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(0);
    expect(report.candidate_lifecycle.median_time_to_disposition_ms).toBeNull();
    expect(report.candidate_lifecycle.stale_unresolved_signal_count).toBe(0);
    expect(report.candidate_lifecycle.pressure.unresolved_exposed_candidate_count).toBe(0);
    expect(report.candidate_lifecycle.pressure.review_priority_candidate_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop flags already-promoted candidates that still lack canonical handoff', async () => {
  const harness = await createSqliteEngine();
  const targetObjectId = 'systems/mbrain-promoted-without-handoff';

  try {
    await createCandidate(harness.engine, 'candidate-audit-promoted-without-handoff', {
      status: 'staged_for_review',
      targetObjectId,
    });
    const promotedAt = new Date();
    await harness.engine.promoteMemoryCandidateEntry('candidate-audit-promoted-without-handoff', {
      expected_current_status: 'staged_for_review',
      reviewed_at: promotedAt,
      review_reason: 'Promoted before later audit exposure.',
    });
    await waitForClockAfter(promotedAt);
    const trace = await harness.engine.putRetrievalTrace({
      id: 'trace-audit-promoted-without-handoff',
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-promoted-without-handoff'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed promoted candidate without handoff',
    });

    const report = await auditBrainLoop(harness.engine, {
      since: new Date(promotedAt.getTime() - 1000),
      until: new Date(trace.created_at.getTime() + 60 * 60 * 1000),
      candidate_review_window_days: 0,
    });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(0);
    expect(report.candidate_lifecycle.promoted_without_handoff_count).toBe(1);
    expect(report.candidate_lifecycle.pressure.stale_promoted_without_handoff_count).toBe(1);
    expect(report.candidate_lifecycle.pressure.unresolved_exposed_candidate_count).toBe(0);
    expect(report.candidate_lifecycle.pressure.review_priority_candidate_count).toBe(1);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop finds canonical updates beyond the first mutation page', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-handoff-paginated-mutation';
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);
  const targetObjectId = 'systems/mbrain-paginated-mutation';

  try {
    await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-paginated-handoff'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate with paginated handoff update',
    });
    await createCandidate(harness.engine, 'candidate-audit-paginated-handoff', {
      status: 'staged_for_review',
      targetObjectId,
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-audit-paginated-handoff', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Paginated mutation promotion.',
    });
    const handoff = await harness.engine.createCanonicalHandoffEntry({
      id: 'handoff-audit-paginated-mutation',
      scope_id: 'workspace:default',
      candidate_id: 'candidate-audit-paginated-handoff',
      target_object_type: 'curated_note',
      target_object_id: targetObjectId,
      source_refs: ['memory_candidate:candidate-audit-paginated-handoff'],
      reviewed_at: new Date(),
      review_reason: 'Paginated mutation handoff.',
      interaction_id: traceId,
    });
    if (!handoff) throw new Error('Expected canonical handoff fixture to be created');
    await harness.engine.createMemoryMutationEvent({
      id: 'mutation-audit-paginated-matching',
      session_id: 'audit-session',
      realm_id: 'audit-realm',
      actor: 'test',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetObjectId,
      scope_id: 'workspace:default',
      source_refs: ['canonical_handoff:handoff-audit-paginated-mutation'],
      result: 'applied',
      dry_run: false,
      redaction_visibility: 'visible',
      created_at: new Date(handoff.created_at.getTime() + 1000),
    });
    for (let index = 0; index < 500; index += 1) {
      await harness.engine.createMemoryMutationEvent({
        id: `mutation-audit-paginated-noise-${index}`,
        session_id: 'audit-session',
        realm_id: 'audit-realm',
        actor: 'test',
        operation: 'put_page',
        target_kind: 'page',
        target_id: targetObjectId,
        scope_id: 'workspace:default',
        source_refs: ['noise'],
        result: 'applied',
        dry_run: false,
        redaction_visibility: 'visible',
        created_at: new Date(handoff.created_at.getTime() + 2000 + index),
      });
    }

    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(1);
    expect(report.candidate_lifecycle.handoff_without_canonical_update_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop accepts preserved handoff source refs as canonical update linkage', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-handoff-source-ref-mutation';
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);
  const targetObjectId = 'systems/mbrain-handoff-source-ref';
  const provenanceRef = 'page:source/provenance';

  try {
    await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-handoff-source-ref'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate with source-ref handoff update',
    });
    await createCandidate(harness.engine, 'candidate-audit-handoff-source-ref', {
      status: 'staged_for_review',
      targetObjectId,
      sourceRefs: [provenanceRef],
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-audit-handoff-source-ref', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Source-ref mutation promotion.',
    });
    const handoff = await harness.engine.createCanonicalHandoffEntry({
      id: 'handoff-audit-source-ref-mutation',
      scope_id: 'workspace:default',
      candidate_id: 'candidate-audit-handoff-source-ref',
      target_object_type: 'curated_note',
      target_object_id: targetObjectId,
      source_refs: [provenanceRef],
      reviewed_at: new Date(),
      review_reason: 'Source-ref mutation handoff.',
      interaction_id: traceId,
    });
    if (!handoff) throw new Error('Expected canonical handoff fixture to be created');
    expect(handoff.source_refs).toContain(provenanceRef);
    await harness.engine.createMemoryMutationEvent({
      id: 'mutation-audit-source-ref-matching',
      session_id: 'audit-session',
      realm_id: 'audit-realm',
      actor: 'test',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetObjectId,
      scope_id: 'workspace:default',
      source_refs: [provenanceRef],
      result: 'applied',
      dry_run: false,
      redaction_visibility: 'visible',
      created_at: new Date(handoff.created_at.getTime() + 1000),
    });

    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.handoff_without_canonical_update_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop does not let another scope canonical update satisfy a handoff', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-cross-scope-handoff-update';
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date(Date.now() + 60 * 60 * 1000);
  const targetObjectId = 'systems/mbrain-cross-scope-handoff-update';

  try {
    await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-cross-scope-handoff'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate with cross-scope update',
    });
    await createCandidate(harness.engine, 'candidate-audit-cross-scope-handoff', {
      status: 'staged_for_review',
      targetObjectId,
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-audit-cross-scope-handoff', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Cross-scope handoff promotion.',
    });
    const handoff = await harness.engine.createCanonicalHandoffEntry({
      id: 'handoff-audit-cross-scope',
      scope_id: 'workspace:default',
      candidate_id: 'candidate-audit-cross-scope-handoff',
      target_object_type: 'curated_note',
      target_object_id: targetObjectId,
      source_refs: ['memory_candidate:candidate-audit-cross-scope-handoff'],
      reviewed_at: new Date(),
      review_reason: 'Cross-scope handoff.',
      interaction_id: traceId,
    });
    if (!handoff) throw new Error('Expected canonical handoff fixture to be created');
    await harness.engine.createMemoryMutationEvent({
      id: 'mutation-audit-cross-scope-wrong-scope',
      session_id: 'audit-session',
      realm_id: 'audit-realm',
      actor: 'test',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetObjectId,
      scope_id: 'workspace:other',
      source_refs: ['canonical_handoff:handoff-audit-cross-scope'],
      result: 'applied',
      dry_run: false,
      redaction_visibility: 'visible',
      created_at: new Date(handoff.created_at.getTime() + 1000),
    });

    const report = await auditBrainLoop(harness.engine, { since, until });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(1);
    expect(report.candidate_lifecycle.handoff_without_canonical_update_count).toBe(1);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop excludes future handoffs and mutations from old audit windows', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-future-handoff';
  const targetObjectId = 'systems/mbrain-future-handoff';

  try {
    const trace = await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-future-handoff'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate before future handoff',
    });
    await waitForClockAfter(trace.created_at);
    await createCandidate(harness.engine, 'candidate-audit-future-handoff', {
      status: 'staged_for_review',
      targetObjectId,
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-audit-future-handoff', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Future handoff promotion.',
    });
    const handoff = await harness.engine.createCanonicalHandoffEntry({
      id: 'handoff-audit-future',
      scope_id: 'workspace:default',
      candidate_id: 'candidate-audit-future-handoff',
      target_object_type: 'curated_note',
      target_object_id: targetObjectId,
      source_refs: ['memory_candidate:candidate-audit-future-handoff'],
      reviewed_at: new Date(),
      review_reason: 'Future handoff.',
      interaction_id: traceId,
    });
    if (!handoff) throw new Error('Expected canonical handoff fixture to be created');
    const mutationCreatedAt = new Date(handoff.created_at.getTime() + 1000);
    await harness.engine.createMemoryMutationEvent({
      id: 'mutation-audit-future-handoff',
      session_id: 'audit-session',
      realm_id: 'audit-realm',
      actor: 'test',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetObjectId,
      scope_id: 'workspace:default',
      source_refs: ['canonical_handoff:handoff-audit-future'],
      result: 'applied',
      dry_run: false,
      redaction_visibility: 'visible',
      created_at: mutationCreatedAt,
    });

    const oldWindowReport = await auditBrainLoop(harness.engine, {
      since: new Date(trace.created_at.getTime() - 1000),
      until: handoff.created_at,
      candidate_review_window_days: 0,
    });
    const extendedWindowReport = await auditBrainLoop(harness.engine, {
      since: new Date(trace.created_at.getTime() - 1000),
      until: new Date(mutationCreatedAt.getTime() + 1),
      candidate_review_window_days: 0,
    });

    expect(oldWindowReport.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(oldWindowReport.candidate_lifecycle.signal_to_status_event_rate).toBe(0);
    expect(oldWindowReport.candidate_lifecycle.median_time_to_disposition_ms).toBeNull();
    expect(oldWindowReport.candidate_lifecycle.promoted_without_handoff_count).toBe(0);
    expect(oldWindowReport.candidate_lifecycle.handoff_without_canonical_update_count).toBe(0);
    expect(extendedWindowReport.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(extendedWindowReport.candidate_lifecycle.signal_to_status_event_rate).toBe(1);
    expect(extendedWindowReport.candidate_lifecycle.median_time_to_disposition_ms).not.toBeNull();
    expect(extendedWindowReport.candidate_lifecycle.promoted_without_handoff_count).toBe(0);
    expect(extendedWindowReport.candidate_lifecycle.handoff_without_canonical_update_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop ignores mutable candidate status after the audit window', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-future-status';
  const targetObjectId = 'systems/mbrain-future-status';

  try {
    const trace = await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-future-status'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate before future status',
    });
    const candidate = await createCandidate(harness.engine, 'candidate-audit-future-status', {
      status: 'staged_for_review',
      targetObjectId,
    });
    const oldUntil = await waitForClockAfter(candidate.created_at);
    const futureDispositionAt = new Date(oldUntil.getTime() + 1000);
    await harness.engine.createMemoryCandidateStatusEvent({
      id: 'status-event-audit-future-status',
      candidate_id: 'candidate-audit-future-status',
      scope_id: 'workspace:default',
      from_status: 'staged_for_review',
      to_status: 'rejected',
      event_kind: 'rejected',
      interaction_id: null,
      reviewed_at: futureDispositionAt,
      review_reason: 'Future terminal disposition.',
      created_at: futureDispositionAt,
    });
    await harness.engine.updateMemoryCandidateEntryStatus('candidate-audit-future-status', {
      status: 'rejected',
      reviewed_at: futureDispositionAt,
      review_reason: 'Future row status update.',
    });

    const oldWindowReport = await auditBrainLoop(harness.engine, {
      since: new Date(trace.created_at.getTime() - 1000),
      until: oldUntil,
      candidate_review_window_days: 0,
    });
    const extendedWindowReport = await auditBrainLoop(harness.engine, {
      since: new Date(trace.created_at.getTime() - 1000),
      until: new Date(futureDispositionAt.getTime() + 1),
      candidate_review_window_days: 0,
    });

    expect(oldWindowReport.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(oldWindowReport.candidate_lifecycle.signal_to_status_event_rate).toBe(0);
    expect(oldWindowReport.candidate_lifecycle.median_time_to_disposition_ms).toBeNull();
    expect(oldWindowReport.candidate_lifecycle.stale_unresolved_signal_count).toBe(1);
    expect(oldWindowReport.candidate_lifecycle.pressure.unresolved_exposed_candidate_count).toBe(1);
    expect(oldWindowReport.candidate_lifecycle.pressure.review_priority_candidate_count).toBe(1);
    expect(extendedWindowReport.candidate_lifecycle.signal_to_status_event_rate).toBe(1);
    expect(extendedWindowReport.candidate_lifecycle.median_time_to_disposition_ms).not.toBeNull();
    expect(extendedWindowReport.candidate_lifecycle.stale_unresolved_signal_count).toBe(0);
    expect(extendedWindowReport.candidate_lifecycle.pressure.unresolved_exposed_candidate_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop ignores backdated row status when the row changed after the audit window', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-backdated-row-status';
  const targetObjectId = 'systems/mbrain-backdated-row-status';

  try {
    const trace = await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-backdated-row-status'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate before backdated row status',
    });
    await createCandidate(harness.engine, 'candidate-audit-backdated-row-status', {
      status: 'staged_for_review',
      targetObjectId,
    });
    const oldUntil = await waitForClockAfter(trace.created_at);
    await waitForClockAfter(oldUntil);
    await harness.engine.promoteMemoryCandidateEntry('candidate-audit-backdated-row-status', {
      expected_current_status: 'staged_for_review',
      reviewed_at: trace.created_at,
      review_reason: 'Backdated row promotion happened after the old audit window.',
    });

    const report = await auditBrainLoop(harness.engine, {
      since: new Date(trace.created_at.getTime() - 1000),
      until: oldUntil,
      candidate_review_window_days: 0,
    });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(0);
    expect(report.candidate_lifecycle.median_time_to_disposition_ms).toBeNull();
    expect(report.candidate_lifecycle.promoted_without_handoff_count).toBe(0);
    expect(report.candidate_lifecycle.stale_unresolved_signal_count).toBe(1);
    expect(report.candidate_lifecycle.pressure.unresolved_exposed_candidate_count).toBe(1);
    expect(report.candidate_lifecycle.pressure.review_priority_candidate_count).toBe(1);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop does not let a pre-window canonical update satisfy a later audit window', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-pre-window-update';
  const targetObjectId = 'systems/mbrain-pre-window-update';

  try {
    await createCandidate(harness.engine, 'candidate-audit-pre-window-update', {
      status: 'staged_for_review',
      targetObjectId,
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-audit-pre-window-update', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Pre-window update promotion.',
    });
    const handoff = await harness.engine.createCanonicalHandoffEntry({
      id: 'handoff-audit-pre-window-update',
      scope_id: 'workspace:default',
      candidate_id: 'candidate-audit-pre-window-update',
      target_object_type: 'curated_note',
      target_object_id: targetObjectId,
      source_refs: ['memory_candidate:candidate-audit-pre-window-update'],
      reviewed_at: new Date(),
      review_reason: 'Pre-window update handoff.',
      interaction_id: null,
    });
    if (!handoff) throw new Error('Expected canonical handoff fixture to be created');
    const preWindowUpdate = await harness.engine.createMemoryMutationEvent({
      id: 'mutation-audit-pre-window-update',
      session_id: 'audit-session',
      realm_id: 'audit-realm',
      actor: 'test',
      operation: 'put_page',
      target_kind: 'page',
      target_id: targetObjectId,
      scope_id: 'workspace:default',
      source_refs: ['canonical_handoff:handoff-audit-pre-window-update'],
      result: 'applied',
      dry_run: false,
      redaction_visibility: 'visible',
    });
    const since = await waitForClockAfter(preWindowUpdate.created_at);
    const trace = await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-pre-window-update'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate after pre-window update',
    });

    const report = await auditBrainLoop(harness.engine, {
      since,
      until: new Date(trace.created_at.getTime() + 60 * 60 * 1000),
    });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(0);
    expect(report.candidate_lifecycle.median_time_to_disposition_ms).toBeNull();
    expect(report.candidate_lifecycle.handoff_without_canonical_update_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop keeps pre-exposure terminal events out of signal-to-status conversion', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-pre-window-terminal-event';
  const targetObjectId = 'systems/mbrain-pre-window-terminal-event';

  try {
    await createCandidate(harness.engine, 'candidate-audit-pre-window-terminal-event', {
      status: 'staged_for_review',
      targetObjectId,
    });
    const preWindowEvent = await harness.engine.createMemoryCandidateStatusEvent({
      id: 'status-event-audit-pre-window-terminal',
      candidate_id: 'candidate-audit-pre-window-terminal-event',
      scope_id: 'workspace:default',
      from_status: 'staged_for_review',
      to_status: 'rejected',
      event_kind: 'rejected',
      interaction_id: null,
      reviewed_at: new Date(),
      review_reason: 'Pre-window terminal disposition.',
      created_at: new Date(),
    });
    await harness.engine.updateMemoryCandidateEntryStatus('candidate-audit-pre-window-terminal-event', {
      status: 'rejected',
      reviewed_at: preWindowEvent.created_at,
      review_reason: 'Pre-window row status update.',
    });
    const since = await waitForClockAfter(preWindowEvent.created_at);
    const trace = await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`page:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-pre-window-terminal-event'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate after pre-window terminal event',
    });

    const report = await auditBrainLoop(harness.engine, {
      since,
      until: new Date(trace.created_at.getTime() + 60 * 60 * 1000),
      candidate_review_window_days: 0,
    });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(0);
    expect(report.candidate_lifecycle.median_time_to_disposition_ms).toBeNull();
    expect(report.candidate_lifecycle.stale_unresolved_signal_count).toBe(0);
    expect(report.candidate_lifecycle.pressure.unresolved_exposed_candidate_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});

test('auditBrainLoop does not require put_page updates for non-page canonical handoffs', async () => {
  const harness = await createSqliteEngine();
  const traceId = 'trace-audit-non-page-handoff';
  const targetObjectId = 'procedures/audit-non-page-handoff';

  try {
    await harness.engine.putRetrievalTrace({
      id: traceId,
      task_id: null,
      scope: 'work',
      route: ['retrieve_context'],
      source_refs: [`procedure:${targetObjectId}`],
      verification: ['candidate_signal:candidate-audit-non-page-handoff'],
      selected_intent: 'broad_synthesis',
      outcome: 'retrieve_context exposed candidate with non-page handoff',
    });
    await createCandidate(harness.engine, 'candidate-audit-non-page-handoff', {
      status: 'staged_for_review',
      targetObjectType: 'procedure',
      targetObjectId,
    });
    await harness.engine.promoteMemoryCandidateEntry('candidate-audit-non-page-handoff', {
      expected_current_status: 'staged_for_review',
      reviewed_at: new Date(),
      review_reason: 'Non-page handoff promotion.',
    });
    const handoff = await harness.engine.createCanonicalHandoffEntry({
      id: 'handoff-audit-non-page',
      scope_id: 'workspace:default',
      candidate_id: 'candidate-audit-non-page-handoff',
      target_object_type: 'procedure',
      target_object_id: targetObjectId,
      source_refs: ['memory_candidate:candidate-audit-non-page-handoff'],
      reviewed_at: new Date(),
      review_reason: 'Non-page canonical handoff.',
      interaction_id: traceId,
    });
    if (!handoff) throw new Error('Expected canonical handoff fixture to be created');

    const report = await auditBrainLoop(harness.engine, {
      since: new Date(Date.now() - 60 * 60 * 1000),
      until: new Date(Date.now() + 60 * 60 * 1000),
    });

    expect(report.candidate_lifecycle.candidate_signal_exposure_count).toBe(1);
    expect(report.candidate_lifecycle.signal_to_status_event_rate).toBe(1);
    expect(report.candidate_lifecycle.handoff_without_canonical_update_count).toBe(0);
  } finally {
    await harness.cleanup();
  }
});
