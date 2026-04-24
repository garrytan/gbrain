import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

interface EngineHarness {
  label: string;
  engine: BrainEngine;
  reopen: () => Promise<BrainEngine>;
  cleanup: () => Promise<void>;
}

async function createSqliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-task-memory-sqlite-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  return {
    label: 'sqlite',
    engine,
    reopen: async () => {
      const reopened = new SQLiteEngine();
      await reopened.connect({ engine: 'sqlite', database_path: databasePath });
      await reopened.initSchema();
      return reopened;
    },
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(): Promise<EngineHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-task-memory-pglite-'));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();

  return {
    label: 'pglite',
    engine,
    reopen: async () => {
      const reopened = new PGLiteEngine();
      await reopened.connect({ engine: 'pglite', database_path: dir });
      await reopened.initSchema();
      return reopened;
    },
    cleanup: async () => {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedTaskMemory(engine: BrainEngine, label: string, taskId: string) {
  await engine.createTaskThread({
    id: taskId,
    scope: 'work',
    title: `Operational memory ${label}`,
    goal: 'Persist task continuity',
    status: 'active',
    repo_path: '/repo',
    branch_name: 'docs/mbrain-redesign-doc-set',
    current_summary: 'Need task-memory persistence',
  });

  await engine.updateTaskThread(taskId, {
    status: 'blocked',
    current_summary: 'Waiting on engine contract',
  });

  await engine.upsertTaskWorkingSet({
    task_id: taskId,
    active_paths: ['src/core/engine.ts'],
    active_symbols: ['BrainEngine'],
    blockers: ['task methods not implemented'],
    open_questions: ['should traces be task-scoped only'],
    next_steps: ['add engine methods'],
    verification_notes: ['schema verified'],
  });

  await engine.recordTaskAttempt({
    id: `attempt-${label}-${taskId}`,
    task_id: taskId,
    summary: 'Tried to keep task memory in raw notes only',
    outcome: 'failed',
    applicability_context: { branch: 'docs/mbrain-redesign-doc-set' },
    evidence: ['resume state drifted'],
  });

  await engine.recordTaskDecision({
    id: `decision-${label}-${taskId}`,
    task_id: taskId,
    summary: 'Keep working set canonical in DB',
    rationale: 'resume reads need cheap state access',
    consequences: ['task resume stays additive'],
    validity_context: { branch: 'docs/mbrain-redesign-doc-set' },
  });

  await engine.putRetrievalTrace({
    id: `trace-${label}-${taskId}`,
    task_id: taskId,
    scope: 'work',
    route: ['task_thread', 'working_set', 'attempts', 'decisions'],
    source_refs: [`task-thread:${taskId}`],
    verification: ['schema verified'],
    outcome: 'resume path assembled',
  });
}

async function expectTaskMemory(engine: BrainEngine, taskId: string) {
  const thread = await engine.getTaskThread(taskId);
  const threads = await engine.listTaskThreads({ status: 'blocked' });
  const workingSet = await engine.getTaskWorkingSet(taskId);
  const attempts = await engine.listTaskAttempts(taskId, { limit: 5 });
  const decisions = await engine.listTaskDecisions(taskId, { limit: 5 });
  const traces = await engine.listRetrievalTraces(taskId, { limit: 5 });

  expect(thread?.current_summary).toBe('Waiting on engine contract');
  expect(threads.some((entry) => entry.id === taskId)).toBe(true);
  expect(workingSet?.active_paths).toEqual(['src/core/engine.ts']);
  expect(attempts[0]?.summary).toContain('raw notes');
  expect(decisions[0]?.summary).toContain('working set canonical');
  expect(traces[0]?.route).toEqual(['task_thread', 'working_set', 'attempts', 'decisions']);
}

for (const createHarness of [createSqliteHarness, createPgliteHarness]) {
  test(`${createHarness.name} persists task-memory records across reopen`, async () => {
    const harness = await createHarness();
    const taskId = `task-${harness.label}`;
    let reopened: BrainEngine | null = null;

    try {
      await seedTaskMemory(harness.engine, harness.label, taskId);
      await expectTaskMemory(harness.engine, taskId);

      await harness.engine.disconnect();
      reopened = await harness.reopen();
      await expectTaskMemory(reopened, taskId);
    } finally {
      await reopened?.disconnect();
      await harness.cleanup();
    }
  });

  test(`${createHarness.name} listTaskThreads honors limit and offset`, async () => {
    const harness = await createHarness();

    try {
      for (const suffix of ['a', 'b', 'c']) {
        await harness.engine.createTaskThread({
          id: `task-page-${harness.label}-${suffix}`,
          scope: 'work',
          title: `Paged task ${suffix}`,
          status: 'active',
        });
      }

      const page = await harness.engine.listTaskThreads({ limit: 1, offset: 1 });

      expect(page.map((thread) => thread.id)).toEqual([`task-page-${harness.label}-b`]);
    } finally {
      await harness.cleanup();
    }
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  test('postgres persists task-memory records', async () => {
    const taskId = `task-postgres-${Date.now()}`;
    const engine = new PostgresEngine();
    const reopened = new PostgresEngine();

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      await seedTaskMemory(engine, 'postgres', taskId);
      await expectTaskMemory(engine, taskId);

      await engine.disconnect();
      await reopened.connect({ engine: 'postgres', database_url: databaseUrl });
      await reopened.initSchema();
      await expectTaskMemory(reopened, taskId);
    } finally {
      const cleanupEngine = reopened as PostgresEngine;
      if (!(cleanupEngine as any)._sql) {
        await cleanupEngine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      const sql = (cleanupEngine as any).sql;
      await sql`DELETE FROM retrieval_traces WHERE task_id = ${taskId}`;
      await sql`DELETE FROM task_decisions WHERE task_id = ${taskId}`;
      await sql`DELETE FROM task_attempts WHERE task_id = ${taskId}`;
      await sql`DELETE FROM task_working_sets WHERE task_id = ${taskId}`;
      await sql`DELETE FROM task_threads WHERE id = ${taskId}`;
      await reopened.disconnect();
      await engine.disconnect().catch(() => undefined);
    }
  });

  test('postgres listTaskThreads honors limit and offset', async () => {
    const engine = new PostgresEngine();
    const stamp = Date.now();
    const ids = [
      `task-postgres-page-${stamp}-a`,
      `task-postgres-page-${stamp}-b`,
      `task-postgres-page-${stamp}-c`,
    ];

    try {
      await engine.connect({ engine: 'postgres', database_url: databaseUrl });
      await engine.initSchema();
      for (const id of ids) {
        await engine.createTaskThread({
          id,
          scope: 'work',
          title: `Postgres paged task ${id}`,
          status: 'abandoned',
        });
      }

      const firstTwo = await engine.listTaskThreads({ status: 'abandoned', limit: 2 });
      const page = await engine.listTaskThreads({ status: 'abandoned', limit: 1, offset: 1 });

      expect(page.map((thread) => thread.id)).toEqual([firstTwo[1]?.id]);
    } finally {
      const cleanupEngine = engine as PostgresEngine;
      if (!(cleanupEngine as any)._sql) {
        await cleanupEngine.connect({ engine: 'postgres', database_url: databaseUrl });
      }
      const sql = (cleanupEngine as any).sql;
      for (const id of ids) {
        await sql`DELETE FROM task_threads WHERE id = ${id}`;
      }
      await engine.disconnect().catch(() => undefined);
    }
  });
} else {
  test.skip('postgres task-memory persistence skipped: DATABASE_URL is not configured', () => {});
  test.skip('postgres listTaskThreads offset skipped: DATABASE_URL is not configured', () => {});
}
