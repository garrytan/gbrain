import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
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
