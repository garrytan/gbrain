import { setDefaultTimeout, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import postgres from 'postgres';
import { buildExecutionEnvelope } from '../src/core/execution-envelope.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { ensurePageChunks } from '../src/core/page-chunks.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { buildTaskResumeCard } from '../src/core/services/task-memory-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { PageType } from '../src/core/types.ts';

setDefaultTimeout(20_000);

type SharedWorkflowEngine = Pick<
  BrainEngine,
  'putPage' | 'getPage' | 'listPages' | 'addTag' | 'getTags' | 'addTimelineEntry' | 'getTimeline' | 'searchKeyword'
> & {
  connect(config: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
};

type WorkflowSnapshot = {
  pages: Record<string, {
    type: PageType;
    title: string;
    compiled_truth: string;
    frontmatter: Record<string, unknown>;
  }>;
  lists: {
    concepts: string[];
    redesign: string[];
  };
  search: {
    contractSurface: string[];
    executionEnvelope: string[];
  };
  tags: Record<string, string[]>;
  timeline: Record<string, Array<{
    date: string;
    detail: string;
    source: string;
    summary: string;
  }>>;
};

type TaskResumeSnapshot = {
  title: string;
  status: string;
  active_paths: string[];
  active_symbols: string[];
  blockers: string[];
  open_questions: string[];
  next_steps: string[];
  failed_attempts: string[];
  active_decisions: string[];
  latest_trace_route: string[];
  stale: boolean;
};

const FIXTURE_PAGES = [
  {
    slug: 'concepts/phase0',
    type: 'concept' as const,
    title: 'Phase 0',
    compiled_truth: 'Phase 0 defines the execution envelope and baseline harness for contract-surface verification.',
    frontmatter: {
      contract_surface: 'phase0',
      execution_envelope: 'local_offline',
    },
    tags: ['redesign'],
    timeline: [
      {
        date: '2026-04-19',
        detail: 'The execution envelope became the Phase 0 baseline contract.',
        source: 'implementation-plan',
        summary: 'Execution envelope defined',
      },
    ],
  },
  {
    slug: 'concepts/local-offline',
    type: 'concept' as const,
    title: 'Local Offline Contract',
    compiled_truth: 'Local offline mode keeps the contract surface honest when cloud file storage is unsupported.',
    frontmatter: {
      contract_surface: 'local_offline',
      execution_envelope: 'local_path',
    },
    tags: ['local-path'],
    timeline: [
      {
        date: '2026-04-20',
        detail: 'Local-path semantics must report file/storage limits explicitly.',
        source: 'implementation-plan',
        summary: 'Contract surface documented',
      },
    ],
  },
] as const;

const EXPECTED_SNAPSHOT: WorkflowSnapshot = {
  pages: {
    'concepts/local-offline': {
      type: 'concept',
      title: 'Local Offline Contract',
      compiled_truth: 'Local offline mode keeps the contract surface honest when cloud file storage is unsupported.',
      frontmatter: {
        contract_surface: 'local_offline',
        execution_envelope: 'local_path',
      },
    },
    'concepts/phase0': {
      type: 'concept',
      title: 'Phase 0',
      compiled_truth: 'Phase 0 defines the execution envelope and baseline harness for contract-surface verification.',
      frontmatter: {
        contract_surface: 'phase0',
        execution_envelope: 'local_offline',
      },
    },
  },
  lists: {
    concepts: ['concepts/local-offline', 'concepts/phase0'],
    redesign: ['concepts/phase0'],
  },
  search: {
    contractSurface: ['concepts/local-offline'],
    executionEnvelope: ['concepts/phase0'],
  },
  tags: {
    'concepts/local-offline': ['local-path'],
    'concepts/phase0': ['redesign'],
  },
  timeline: {
    'concepts/local-offline': [
      {
        date: '2026-04-20',
        detail: 'Local-path semantics must report file/storage limits explicitly.',
        source: 'implementation-plan',
        summary: 'Contract surface documented',
      },
    ],
    'concepts/phase0': [
      {
        date: '2026-04-19',
        detail: 'The execution envelope became the Phase 0 baseline contract.',
        source: 'implementation-plan',
        summary: 'Execution envelope defined',
      },
    ],
  },
};

function normalizeDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function seedSharedWorkflow(engine: SharedWorkflowEngine): Promise<void> {
  for (const fixture of FIXTURE_PAGES) {
    const page = await engine.putPage(fixture.slug, {
      type: fixture.type,
      title: fixture.title,
      compiled_truth: fixture.compiled_truth,
      frontmatter: fixture.frontmatter,
    });

    await ensurePageChunks(engine as BrainEngine, page);

    for (const tag of fixture.tags) {
      await engine.addTag(fixture.slug, tag);
      await engine.addTag(fixture.slug, tag);
    }

    for (const entry of fixture.timeline) {
      await engine.addTimelineEntry(fixture.slug, entry);
    }
  }
}

async function collectWorkflowSnapshot(engine: SharedWorkflowEngine): Promise<WorkflowSnapshot> {
  const pages = Object.fromEntries(
    (await Promise.all(FIXTURE_PAGES.map(async (fixture) => {
      const page = await engine.getPage(fixture.slug);
      expect(page).not.toBeNull();
      return [
        fixture.slug,
        {
          type: page!.type,
          title: page!.title,
          compiled_truth: page!.compiled_truth,
          frontmatter: page!.frontmatter,
        },
      ] as const;
    }))).sort(([left], [right]) => left.localeCompare(right)),
  );

  const tags = Object.fromEntries(
    (await Promise.all(FIXTURE_PAGES.map(async (fixture) => {
      const pageTags = await engine.getTags(fixture.slug);
      return [fixture.slug, [...pageTags].sort()] as const;
    }))).sort(([left], [right]) => left.localeCompare(right)),
  );

  const timeline = Object.fromEntries(
    (await Promise.all(FIXTURE_PAGES.map(async (fixture) => {
      const entries = await engine.getTimeline(fixture.slug);
      return [
        fixture.slug,
        entries.map((entry) => ({
          date: normalizeDate(entry.date),
          detail: entry.detail,
          source: entry.source,
          summary: entry.summary,
        })),
      ] as const;
    }))).sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    pages,
    lists: {
      concepts: (await engine.listPages({ type: 'concept' })).map((page) => page.slug).sort(),
      redesign: (await engine.listPages({ tag: 'redesign' })).map((page) => page.slug).sort(),
    },
    search: {
      contractSurface: (await engine.searchKeyword('cloud file storage unsupported')).map((result) => result.slug).sort(),
      executionEnvelope: (await engine.searchKeyword('execution envelope baseline harness')).map((result) => result.slug).sort(),
    },
    tags,
    timeline,
  };
}

async function seedTaskResumeScenario(engine: BrainEngine, taskId: string): Promise<TaskResumeSnapshot> {
  await engine.createTaskThread({
    id: taskId,
    scope: 'work',
    title: 'Phase 1 MVP',
    goal: 'Ship operational memory',
    status: 'blocked',
    repo_path: '/repo',
    branch_name: 'docs/mbrain-redesign-doc-set',
    current_summary: 'Shared operations exist, parity coverage is landing',
  });

  await engine.upsertTaskWorkingSet({
    task_id: taskId,
    active_paths: ['src/core/operations.ts'],
    active_symbols: ['operations', 'buildTaskResumeCard'],
    blockers: ['phase1 parity coverage missing'],
    open_questions: ['should resume include retrieval trace ids'],
    next_steps: ['add parity coverage'],
    verification_notes: ['working set refreshed against current branch'],
    last_verified_at: new Date('2026-04-19T01:00:00.000Z'),
  });

  await engine.recordTaskAttempt({
    id: `${taskId}-attempt-failed`,
    task_id: taskId,
    summary: 'Skipped parity coverage in initial Phase 1 pass',
    outcome: 'failed',
    applicability_context: { surface: 'phase1' },
    evidence: ['reviewer found missing parity test'],
  });
  await engine.recordTaskAttempt({
    id: `${taskId}-attempt-partial`,
    task_id: taskId,
    summary: 'Shipped task resume without refresh operation',
    outcome: 'partial',
    applicability_context: { surface: 'phase1' },
    evidence: ['resume output existed but freshness could not advance'],
  });

  await engine.recordTaskDecision({
    id: `${taskId}-decision-1`,
    task_id: taskId,
    summary: 'Keep task working set canonical in the database',
    rationale: 'Resume must read persisted state before raw-source expansion',
    consequences: ['freshness and parity can be tested at the contract boundary'],
    validity_context: { phase: 'phase1' },
  });

  await engine.putRetrievalTrace({
    id: `${taskId}-trace-1`,
    task_id: taskId,
    scope: 'work',
    route: ['task_thread', 'working_set', 'attempts', 'decisions'],
    source_refs: [`task-thread:${taskId}`],
    verification: ['working set refreshed'],
    outcome: 'resume path assembled',
  });

  const resume = await buildTaskResumeCard(engine, taskId);
  return {
    title: resume.title,
    status: resume.status,
    active_paths: resume.active_paths,
    active_symbols: resume.active_symbols,
    blockers: resume.blockers,
    open_questions: resume.open_questions,
    next_steps: resume.next_steps,
    failed_attempts: resume.failed_attempts,
    active_decisions: resume.active_decisions,
    latest_trace_route: resume.latest_trace_route,
    stale: resume.stale,
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function buildSchemaScopedDatabaseUrl(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schemaName},public`);
  return url.toString();
}

const root = mkdtempSync(join(tmpdir(), 'mbrain-phase0-parity-'));
const sqlite = new SQLiteEngine();
const pglite = new PGLiteEngine();

beforeAll(async () => {
  await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
  await sqlite.initSchema();
  await seedSharedWorkflow(sqlite);

  await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
  await pglite.initSchema();
  await seedSharedWorkflow(pglite);
});

afterAll(async () => {
  await sqlite.disconnect();
  await pglite.disconnect();
  rmSync(root, { recursive: true, force: true });
});

describe('phase0 contract parity', () => {
  test('sqlite and pglite agree on shared operation-backed workflows', async () => {
    const sqliteSnapshot = await collectWorkflowSnapshot(sqlite);
    const pgliteSnapshot = await collectWorkflowSnapshot(pglite);

    expect(sqliteSnapshot).toEqual(EXPECTED_SNAPSHOT);
    expect(pgliteSnapshot).toEqual(EXPECTED_SNAPSHOT);
    expect(sqliteSnapshot).toEqual(pgliteSnapshot);
  });

  test('sqlite and pglite expose the same unsupported Phase 0 contract surfaces', () => {
    const sqliteEnvelope = buildExecutionEnvelope({
      engine: 'sqlite',
      database_path: join(root, 'brain.db'),
      offline: true,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });
    const pgliteEnvelope = buildExecutionEnvelope({
      engine: 'pglite',
      database_path: join(root, 'brain.pglite'),
      offline: false,
      embedding_provider: 'local',
      query_rewrite_provider: 'heuristic',
    });

    expect(sqliteEnvelope.publicContract.files.status).toBe('unsupported');
    expect(sqliteEnvelope.publicContract.checkUpdate.status).toBe('unsupported');
    expect(pgliteEnvelope.publicContract.files.status).toBe('unsupported');
    expect(pgliteEnvelope.publicContract.checkUpdate.status).toBe('unsupported');
  });

  test('sqlite and pglite agree on task resume semantics', async () => {
    const sqliteResume = await seedTaskResumeScenario(sqlite, 'sqlite-task-1');
    const pgliteResume = await seedTaskResumeScenario(pglite, 'pglite-task-1');

    expect(sqliteResume).toEqual({
      title: 'Phase 1 MVP',
      status: 'blocked',
      active_paths: ['src/core/operations.ts'],
      active_symbols: ['operations', 'buildTaskResumeCard'],
      blockers: ['phase1 parity coverage missing'],
      open_questions: ['should resume include retrieval trace ids'],
      next_steps: ['add parity coverage'],
      failed_attempts: ['Skipped parity coverage in initial Phase 1 pass'],
      active_decisions: ['Keep task working set canonical in the database'],
      latest_trace_route: ['task_thread', 'working_set', 'attempts', 'decisions'],
      stale: false,
    });
    expect(pgliteResume).toEqual(sqliteResume);
  });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    test.skip('postgres parity skipped: DATABASE_URL is not configured', () => {});
    return;
  }

  test('postgres matches the same shared workflow semantics', async () => {
    const schemaName = `phase0_parity_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const admin = postgres(databaseUrl, {
      connect_timeout: 10,
      idle_timeout: 1,
      max: 1,
      types: { bigint: postgres.BigInt },
    });
    const engine = new PostgresEngine();

    try {
      await admin.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await engine.connect({
        engine: 'postgres',
        database_url: buildSchemaScopedDatabaseUrl(databaseUrl, schemaName),
        poolSize: 1,
      });
      await engine.initSchema();
      await seedSharedWorkflow(engine);

      const postgresSnapshot = await collectWorkflowSnapshot(engine);
      const sqliteSnapshot = await collectWorkflowSnapshot(sqlite);

      expect(postgresSnapshot).toEqual(EXPECTED_SNAPSHOT);
      expect(postgresSnapshot).toEqual(sqliteSnapshot);
    } finally {
      await engine.disconnect().catch(() => undefined);
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => undefined);
      await admin.end({ timeout: 0 });
    }
  });

  test('postgres matches the same task resume semantics', async () => {
    const schemaName = `phase1_task_resume_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const admin = postgres(databaseUrl, {
      connect_timeout: 10,
      idle_timeout: 1,
      max: 1,
      types: { bigint: postgres.BigInt },
    });
    const engine = new PostgresEngine();

    try {
      await admin.unsafe(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await engine.connect({
        engine: 'postgres',
        database_url: buildSchemaScopedDatabaseUrl(databaseUrl, schemaName),
        poolSize: 1,
      });
      await engine.initSchema();

      const postgresResume = await seedTaskResumeScenario(engine, 'postgres-task-1');
      const sqliteResume = await seedTaskResumeScenario(sqlite, 'sqlite-task-2');

      expect(postgresResume).toEqual(sqliteResume);
    } finally {
      await engine.disconnect().catch(() => undefined);
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => undefined);
      await admin.end({ timeout: 0 });
    }
  });
});
