import { setDefaultTimeout, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { auditBrainLoop } from '../src/core/services/brain-loop-audit-service.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

interface Harness {
  label: string;
  engine: BrainEngine;
  teardown: () => Promise<void>;
}

async function createSqliteHarness(label: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-audit-engine-${label}-`));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return {
    label: 'sqlite',
    engine: engine as unknown as BrainEngine,
    teardown: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(label: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-audit-engine-${label}-`));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(dir, 'pglite') });
  await engine.initSchema();
  return {
    label: 'pglite',
    engine,
    teardown: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPostgresHarness(label: string): Promise<Harness> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured');
  }
  const engine = new PostgresEngine();
  await engine.connect({ engine: 'postgres', database_url: databaseUrl });
  await engine.initSchema();
  return {
    label: `postgres-${label}`,
    engine,
    teardown: async () => {
      await engine.disconnect();
    },
  };
}

async function seedCandidate(engine: BrainEngine, id: string, targetObjectId: string) {
  await engine.createMemoryCandidateEntry({
    id,
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: `Audit engine candidate ${id}.`,
    source_refs: ['User, direct message, 2026-04-24 10:00 AM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'staged_for_review',
    target_object_type: 'curated_note',
    target_object_id: targetObjectId,
  });
}

async function seedTraceAndLinkedWrites(engine: BrainEngine, prefix: string) {
  const ids = {
    task: `${prefix}-task`,
    trace: `${prefix}-trace`,
    handoffCandidate: `${prefix}-handoff-candidate`,
    handoff: `${prefix}-handoff`,
    supersededCandidate: `${prefix}-superseded-candidate`,
    replacementCandidate: `${prefix}-replacement-candidate`,
    supersession: `${prefix}-supersession`,
    contradictionCandidate: `${prefix}-contradiction-candidate`,
    challengedCandidate: `${prefix}-challenged-candidate`,
    contradiction: `${prefix}-contradiction`,
  };

  await engine.createTaskThread({
    id: ids.task,
    scope: 'work',
    title: `Audit engine task ${prefix}`,
    status: 'active',
  });
  await engine.putRetrievalTrace({
    id: ids.trace,
    task_id: ids.task,
    scope: 'work',
    route: ['curated_notes', 'context_map_report'],
    source_refs: ['task-thread:audit-engine'],
    derived_consulted: ['context-map:audit-engine'],
    verification: ['intent:broad_synthesis'],
    selected_intent: 'broad_synthesis',
    scope_gate_policy: 'allow',
    outcome: 'audit engine parity trace',
  });

  await seedCandidate(engine, ids.handoffCandidate, `${prefix}-handoff-target`);
  await engine.promoteMemoryCandidateEntry(ids.handoffCandidate, {
    expected_current_status: 'staged_for_review',
    reviewed_at: new Date(),
    review_reason: 'Audit engine handoff candidate.',
  });
  await engine.createCanonicalHandoffEntry({
    id: ids.handoff,
    scope_id: 'workspace:default',
    candidate_id: ids.handoffCandidate,
    target_object_type: 'curated_note',
    target_object_id: `${prefix}-handoff-target`,
    source_refs: [],
    interaction_id: ids.trace,
  });

  await seedCandidate(engine, ids.supersededCandidate, `${prefix}-old-target`);
  await seedCandidate(engine, ids.replacementCandidate, `${prefix}-new-target`);
  await engine.promoteMemoryCandidateEntry(ids.supersededCandidate, {
    expected_current_status: 'staged_for_review',
    reviewed_at: new Date(),
    review_reason: 'Audit engine superseded candidate.',
  });
  await engine.promoteMemoryCandidateEntry(ids.replacementCandidate, {
    expected_current_status: 'staged_for_review',
    reviewed_at: new Date(),
    review_reason: 'Audit engine replacement candidate.',
  });
  await engine.supersedeMemoryCandidateEntry({
    id: ids.supersession,
    scope_id: 'workspace:default',
    superseded_candidate_id: ids.supersededCandidate,
    replacement_candidate_id: ids.replacementCandidate,
    expected_current_status: 'promoted',
    reviewed_at: new Date(),
    review_reason: 'Audit engine supersession.',
    interaction_id: ids.trace,
  });

  await seedCandidate(engine, ids.contradictionCandidate, `${prefix}-claim-target`);
  await seedCandidate(engine, ids.challengedCandidate, `${prefix}-challenged-target`);
  await engine.createMemoryCandidateContradictionEntry({
    id: ids.contradiction,
    scope_id: 'workspace:default',
    candidate_id: ids.contradictionCandidate,
    challenged_candidate_id: ids.challengedCandidate,
    outcome: 'unresolved',
    reviewed_at: new Date(),
    review_reason: 'Audit engine contradiction.',
    interaction_id: ids.trace,
  });

  return ids;
}

async function cleanupPostgresRows(engine: BrainEngine, ids: Awaited<ReturnType<typeof seedTraceAndLinkedWrites>>) {
  if (!(engine instanceof PostgresEngine)) {
    return;
  }
  const sql = (engine as any).sql;
  await sql`DELETE FROM canonical_handoff_entries WHERE id = ${ids.handoff}`;
  await sql`DELETE FROM memory_candidate_contradiction_entries WHERE id = ${ids.contradiction}`;
  await sql`DELETE FROM memory_candidate_supersession_entries WHERE id = ${ids.supersession}`;
  await sql`DELETE FROM memory_candidate_entries WHERE id IN (${ids.handoffCandidate}, ${ids.supersededCandidate}, ${ids.replacementCandidate}, ${ids.contradictionCandidate}, ${ids.challengedCandidate})`;
  await sql`DELETE FROM retrieval_traces WHERE id = ${ids.trace}`;
  await sql`DELETE FROM task_threads WHERE id = ${ids.task}`;
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} audit query surfaces and linked writes are backend-parity covered`, async () => {
    const harness = await createHarness(createHarness.name);
    const ids = await seedTraceAndLinkedWrites(harness.engine, `audit-${harness.label}`);
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const until = new Date(Date.now() + 60 * 60 * 1000);

    try {
      const traces = await harness.engine.listRetrievalTracesByWindow({
        since,
        until,
        task_id: ids.task,
        limit: 10,
      });
      const handoffs = await harness.engine.listCanonicalHandoffEntriesByInteractionIds([ids.trace]);
      const supersessions = await harness.engine.listMemoryCandidateSupersessionEntriesByInteractionIds([ids.trace]);
      const contradictions = await harness.engine.listMemoryCandidateContradictionEntriesByInteractionIds([ids.trace]);
      const report = await auditBrainLoop(harness.engine, { since, until, task_id: ids.task });

      expect(traces.map((trace) => trace.id)).toEqual([ids.trace]);
      expect(handoffs.map((entry) => entry.interaction_id)).toEqual([ids.trace]);
      expect(supersessions.map((entry) => entry.interaction_id)).toEqual([ids.trace]);
      expect(contradictions.map((entry) => entry.interaction_id)).toEqual([ids.trace]);
      expect(report.total_traces).toBe(1);
      expect(report.by_selected_intent.broad_synthesis).toBe(1);
      expect(report.linked_writes.handoff_count).toBe(1);
      expect(report.linked_writes.supersession_count).toBe(1);
      expect(report.linked_writes.contradiction_count).toBe(1);
      expect(report.linked_writes.traces_with_any_linked_write).toBe(1);
      expect(report.candidate_status_events.created_count).toBe(0);
      expect(report.candidate_status_events.advanced_count).toBe(0);
      expect(report.candidate_status_events.promoted_count).toBe(0);
      expect(report.candidate_status_events.rejected_count).toBe(0);
      expect(report.candidate_status_events.superseded_count).toBe(0);
      expect(report.candidate_status_events.linked_event_count).toBe(0);
      expect(report.candidate_status_events.unlinked_event_count).toBe(0);
      expect(report.candidate_status_events.traces_with_candidate_events).toBe(0);
    } finally {
      await harness.teardown();
    }
  }, 30_000);
}

if (process.env.DATABASE_URL) {
  test('postgres audit query surfaces and linked writes are backend-parity covered', async () => {
    const harness = await createPostgresHarness('audit');
    const ids = await seedTraceAndLinkedWrites(harness.engine, `audit-postgres-${Date.now()}`);
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const until = new Date(Date.now() + 60 * 60 * 1000);

    try {
      const traces = await harness.engine.listRetrievalTracesByWindow({
        since,
        until,
        task_id: ids.task,
        limit: 10,
      });
      const handoffs = await harness.engine.listCanonicalHandoffEntriesByInteractionIds([ids.trace]);
      const supersessions = await harness.engine.listMemoryCandidateSupersessionEntriesByInteractionIds([ids.trace]);
      const contradictions = await harness.engine.listMemoryCandidateContradictionEntriesByInteractionIds([ids.trace]);
      const report = await auditBrainLoop(harness.engine, { since, until, task_id: ids.task });

      expect(traces.map((trace) => trace.id)).toEqual([ids.trace]);
      expect(handoffs.map((entry) => entry.interaction_id)).toEqual([ids.trace]);
      expect(supersessions.map((entry) => entry.interaction_id)).toEqual([ids.trace]);
      expect(contradictions.map((entry) => entry.interaction_id)).toEqual([ids.trace]);
      expect(report.total_traces).toBe(1);
      expect(report.by_selected_intent.broad_synthesis).toBe(1);
      expect(report.linked_writes.handoff_count).toBe(1);
      expect(report.linked_writes.supersession_count).toBe(1);
      expect(report.linked_writes.contradiction_count).toBe(1);
      expect(report.linked_writes.traces_with_any_linked_write).toBe(1);
      expect(report.candidate_status_events.created_count).toBe(0);
      expect(report.candidate_status_events.advanced_count).toBe(0);
      expect(report.candidate_status_events.promoted_count).toBe(0);
      expect(report.candidate_status_events.rejected_count).toBe(0);
      expect(report.candidate_status_events.superseded_count).toBe(0);
      expect(report.candidate_status_events.linked_event_count).toBe(0);
      expect(report.candidate_status_events.unlinked_event_count).toBe(0);
      expect(report.candidate_status_events.traces_with_candidate_events).toBe(0);
    } finally {
      await cleanupPostgresRows(harness.engine, ids);
      await harness.teardown();
    }
  }, 30_000);
} else {
  test.skip('postgres audit query surface parity skipped: DATABASE_URL is not configured', () => {});
}

test('sqlite interaction-id lookups chunk large direct inputs', async () => {
  const harness = await createSqliteHarness('chunking');
  const interactionIds = Array.from({ length: 40_000 }, (_, index) => `interaction-${index}`);
  const sqliteEngine = harness.engine as unknown as SQLiteEngine;
  const database = (sqliteEngine as any).db;
  const originalQuery = database.query.bind(database);
  const placeholderCounts: number[] = [];
  database.query = (sql: string) => {
    if (sql.includes('interaction_id IN')) {
      const count = sql.match(/\?/g)?.length ?? 0;
      placeholderCounts.push(count);
      if (count > 500) {
        throw new Error(`interaction_id lookup was not chunked: ${count} placeholders`);
      }
    }
    return originalQuery(sql);
  };

  try {
    await expect(harness.engine.listCanonicalHandoffEntriesByInteractionIds(interactionIds)).resolves.toEqual([]);
    await expect(harness.engine.listMemoryCandidateSupersessionEntriesByInteractionIds(interactionIds)).resolves.toEqual([]);
    await expect(harness.engine.listMemoryCandidateContradictionEntriesByInteractionIds(interactionIds)).resolves.toEqual([]);
    expect(Math.max(...placeholderCounts)).toBeLessThanOrEqual(500);
  } finally {
    database.query = originalQuery;
    await harness.teardown();
  }
});
