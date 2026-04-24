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
    targetObjectId?: string;
  } = {},
) {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: `Candidate ${id}.`,
    source_refs: ['User, direct message, 2026-04-24 10:00 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: options.status ?? 'captured',
    target_object_type: 'curated_note',
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

test('auditBrainLoop returns a zeroed report for an empty window', async () => {
  const harness = await createSqliteEngine();

  try {
    const report = await auditBrainLoop(harness.engine, {
      since: new Date(Date.now() - 60 * 60 * 1000),
      until: new Date(Date.now()),
    });

    expect(report.total_traces).toBe(0);
    expect(report.linked_writes.handoff_count).toBe(0);
    expect(report.linked_writes.traces_without_linked_write).toBe(0);
    expect(report.summary_lines.join(' ').toLowerCase()).toContain('no');
    expect(report.summary_lines.join(' ').toLowerCase()).toContain('activity');
  } finally {
    await harness.cleanup();
  }
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
