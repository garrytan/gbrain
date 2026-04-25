import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildTaskResumeCard } from '../src/core/services/task-memory-service.ts';

test('resume reads task state before raw-source expansion', async () => {
  const calls: string[] = [];
  const engine = {
    getTaskThread: async () => {
      calls.push('thread');
      return {
        id: 'task-1',
        scope: 'work',
        title: 'Phase 1 MVP',
        goal: 'Ship operational memory',
        status: 'blocked',
        repo_path: '/repo',
        branch_name: 'docs/mbrain-redesign-doc-set',
        current_summary: 'Need resume flow',
        created_at: new Date('2026-04-19T00:00:00.000Z'),
        updated_at: new Date('2026-04-19T00:10:00.000Z'),
      };
    },
    getTaskWorkingSet: async () => {
      calls.push('working_set');
      return {
        task_id: 'task-1',
        active_paths: ['src/core/operations.ts'],
        active_symbols: ['operations'],
        blockers: ['task commands missing'],
        open_questions: ['should task resume emit retrieval trace ids'],
        next_steps: ['add shared operations'],
        verification_notes: ['schema verified'],
        last_verified_at: null,
        updated_at: new Date('2026-04-19T00:10:00.000Z'),
      };
    },
    listTaskAttempts: async () => {
      calls.push('attempts');
      return [
        {
          id: 'attempt-1',
          task_id: 'task-1',
          summary: 'CLI-only prototype',
          outcome: 'failed',
          applicability_context: { branch: 'docs/mbrain-redesign-doc-set' },
          evidence: ['would drift from MCP'],
          created_at: new Date('2026-04-19T00:09:00.000Z'),
        },
      ];
    },
    listTaskDecisions: async () => {
      calls.push('decisions');
      return [
        {
          id: 'decision-1',
          task_id: 'task-1',
          summary: 'Keep task surface in operations.ts',
          rationale: 'shared contract first',
          consequences: ['CLI and MCP stay aligned'],
          validity_context: { branch: 'docs/mbrain-redesign-doc-set' },
          created_at: new Date('2026-04-19T00:08:00.000Z'),
        },
      ];
    },
    listRetrievalTraces: async () => {
      calls.push('traces');
      return [
        {
          id: 'trace-1',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_thread', 'working_set', 'attempts', 'decisions'],
          source_refs: ['task-thread:task-1'],
          verification: ['schema verified'],
          outcome: 'resume path assembled',
          created_at: new Date('2026-04-19T00:07:00.000Z'),
        },
      ];
    },
  } as any;

  const resume = await buildTaskResumeCard(engine, 'task-1');

  expect(calls).toEqual(['thread', 'working_set', 'attempts', 'decisions', 'traces']);
  expect(resume.task_id).toBe('task-1');
  expect(resume.failed_attempts).toEqual(['CLI-only prototype']);
  expect(resume.active_decisions).toEqual(['Keep task surface in operations.ts']);
  expect(resume.next_steps).toEqual(['add shared operations']);
  expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
    expect.objectContaining({
      status: 'unverifiable',
      reason: 'repo_missing',
      claim: expect.objectContaining({ path: 'src/core/operations.ts' }),
    }),
    expect.objectContaining({
      status: 'unverifiable',
      reason: 'repo_missing',
      claim: expect.objectContaining({ symbol: 'operations' }),
    }),
  ]));
  expect(resume.stale).toBe(true);
});

test('resume reports branch-sensitive code claim verification from recent traces', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-code-claim-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Branch sensitive task',
        goal: 'Avoid stale code claims',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'branch-b',
        current_summary: 'Historical answer was from branch A',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-latest',
          task_id: 'task-1',
          scope: 'work',
          route: ['code_claim_reverification'],
          source_refs: ['retrieval_trace:trace-source'],
          verification: ['code_claim_result:src/example.ts:stale:branch_mismatch'],
          outcome: 'stale marker',
          created_at: new Date('2026-04-25T00:02:00.000Z'),
        },
      ],
      getRetrievalTrace: async (id: string) => id === 'trace-source' ? {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/example.ts:presentSymbol:branch=branch-a'],
          outcome: 'historical branch A answer',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        } : null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.latest_trace_route).toEqual(['code_claim_reverification']);
    expect(resume.code_claim_verification[0]?.status).toBe('stale');
    expect(resume.code_claim_verification[0]?.reason).toBe('branch_mismatch');
    expect(resume.code_claim_verification[0]?.claim.source_trace_id).toBe('trace-source');
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume reports code claims as unverifiable when the task repo path is missing', async () => {
  const engine = {
    getTaskThread: async () => ({
      id: 'task-1',
      scope: 'work',
      title: 'Missing repo task',
      goal: 'Expose unverifiable claims',
      status: 'active',
      repo_path: null,
      branch_name: 'main',
      current_summary: 'Historical trace has code claims',
      created_at: new Date('2026-04-25T00:00:00.000Z'),
      updated_at: new Date('2026-04-25T00:01:00.000Z'),
    }),
    getTaskWorkingSet: async () => null,
    listTaskAttempts: async () => [],
    listTaskDecisions: async () => [],
    listRetrievalTraces: async () => [
      {
        id: 'trace-source',
        task_id: 'task-1',
        scope: 'work',
        route: ['task_resume'],
        source_refs: ['task-thread:task-1'],
        verification: ['code_claim:src/example.ts:presentSymbol'],
        outcome: 'historical answer referenced code',
        created_at: new Date('2026-04-25T00:01:00.000Z'),
      },
    ],
    getRetrievalTrace: async () => null,
  } as any;

  const resume = await buildTaskResumeCard(engine, 'task-1');

  expect(resume.code_claim_verification[0]?.status).toBe('unverifiable');
  expect(resume.code_claim_verification[0]?.reason).toBe('repo_missing');
  expect(resume.code_claim_verification[0]?.claim.source_trace_id).toBe('trace-source');
});

test('resume preserves working-set facts when code claims are unverifiable because repo context is missing', async () => {
  const engine = {
    getTaskThread: async () => ({
      id: 'task-1',
      scope: 'work',
      title: 'Missing repo context',
      goal: 'Do not erase unverifiable state',
      status: 'active',
      repo_path: '/repo-that-does-not-exist',
      branch_name: 'main',
      current_summary: 'Working set was verified earlier',
      created_at: new Date('2026-04-25T00:00:00.000Z'),
      updated_at: new Date('2026-04-25T00:01:00.000Z'),
    }),
    getTaskWorkingSet: async () => ({
      task_id: 'task-1',
      active_paths: ['src/core/operations.ts'],
      active_symbols: ['operations'],
      blockers: [],
      open_questions: [],
      next_steps: [],
      verification_notes: [],
      last_verified_at: new Date('2026-04-25T00:01:00.000Z'),
      updated_at: new Date('2026-04-25T00:01:00.000Z'),
    }),
    listTaskAttempts: async () => [],
    listTaskDecisions: async () => [],
    listRetrievalTraces: async () => [],
    getRetrievalTrace: async () => null,
  } as any;

  const resume = await buildTaskResumeCard(engine, 'task-1');

  expect(resume.active_paths).toEqual(['src/core/operations.ts']);
  expect(resume.active_symbols).toEqual(['operations']);
  expect(resume.stale).toBe(false);
  expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
    expect.objectContaining({
      status: 'unverifiable',
      reason: 'repo_missing',
      claim: expect.objectContaining({ path: 'src/core/operations.ts' }),
    }),
  ]));
});

test('resume verifies working-set and summary code facts before returning them as current state', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-working-set-claim-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/current.ts'), 'export function currentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Working-set claims',
        goal: 'Do not repeat stale working-set facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'Continue editing src/current.ts after removing src/missing.ts.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => ({
        task_id: 'task-1',
        active_paths: ['src/current.ts', 'src/missing.ts'],
        active_symbols: ['currentSymbol', 'missingSymbol'],
        blockers: [],
        open_questions: [],
        next_steps: [],
        verification_notes: [],
        last_verified_at: new Date('2026-04-25T00:01:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/current.ts:currentSymbol'],
          outcome: 'historical answer referenced current symbol',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        },
      ],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.active_paths).toEqual(['src/current.ts']);
    expect(resume.active_symbols).toEqual(['currentSymbol']);
    expect(resume.current_summary).not.toContain('src/missing.ts');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'stale',
        reason: 'file_missing',
        claim: expect.objectContaining({ path: 'src/missing.ts' }),
      }),
      expect.objectContaining({
        status: 'stale',
        reason: 'symbol_missing',
        claim: expect.objectContaining({ path: 'src/current.ts', symbol: 'missingSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume does not drop a verified path when only a symbol inside it is stale', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-path-symbol-scope-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Path symbol scope',
        goal: 'Keep verified paths even when a symbol is stale',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'Continue editing src/example.ts.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => ({
        task_id: 'task-1',
        active_paths: ['src/example.ts'],
        active_symbols: ['OldSymbol'],
        blockers: [],
        open_questions: [],
        next_steps: [],
        verification_notes: [],
        last_verified_at: new Date('2026-04-25T00:01:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/example.ts:OldSymbol'],
          outcome: 'historical answer referenced old symbol',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        },
      ],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.active_paths).toEqual(['src/example.ts']);
    expect(resume.active_symbols).toEqual([]);
    expect(resume.current_summary).toBe('Continue editing src/example.ts.');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'stale',
        reason: 'symbol_missing',
        claim: expect.objectContaining({ path: 'src/example.ts', symbol: 'OldSymbol' }),
      }),
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/example.ts' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume keeps active symbols that verify inside active paths when no trace located the claim', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-active-symbol-path-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Active symbol path',
        goal: 'Verify working-set symbols against working-set paths',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'Continue editing src/example.ts.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => ({
        task_id: 'task-1',
        active_paths: ['src/example.ts'],
        active_symbols: ['presentSymbol'],
        blockers: [],
        open_questions: [],
        next_steps: [],
        verification_notes: [],
        last_verified_at: new Date('2026-04-25T00:01:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.active_paths).toEqual(['src/example.ts']);
    expect(resume.active_symbols).toEqual(['presentSymbol']);
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/example.ts', symbol: 'presentSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume keeps active symbols verified in active paths despite stale historical claims for the same symbol', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-active-symbol-current-path-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/new.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Active symbol current path',
        goal: 'Current working-set symbols should beat stale historical claims',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'Continue editing src/new.ts.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => ({
        task_id: 'task-1',
        active_paths: ['src/new.ts'],
        active_symbols: ['presentSymbol'],
        blockers: [],
        open_questions: [],
        next_steps: [],
        verification_notes: [],
        last_verified_at: new Date('2026-04-25T00:01:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/old.ts:presentSymbol'],
          outcome: 'historical answer referenced old symbol path',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        },
      ],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.active_paths).toEqual(['src/new.ts']);
    expect(resume.active_symbols).toEqual(['presentSymbol']);
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'stale',
        reason: 'file_missing',
        claim: expect.objectContaining({ path: 'src/old.ts', symbol: 'presentSymbol' }),
      }),
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/new.ts', symbol: 'presentSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume withholds summary path-scoped bare symbol claims when the symbol is missing', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-bare-symbol-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Summary bare symbol claims',
        goal: 'Do not repeat path-scoped stale symbol facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'src/example.ts implements MissingSymbol.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('MissingSymbol');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'stale',
        reason: 'symbol_missing',
        claim: expect.objectContaining({ path: 'src/example.ts', symbol: 'MissingSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume verifies lowercase path-scoped summary symbols before returning the summary', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-lowercase-symbol-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/auth.ts'), 'export function logout() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Lowercase summary symbol claims',
        goal: 'Do not repeat missing lowercase function facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'src/auth.ts exports login.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('login');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'stale',
        reason: 'symbol_missing',
        claim: expect.objectContaining({ path: 'src/auth.ts', symbol: 'login' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume verifies every symbol in a strong path-scoped summary symbol list', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-symbol-list-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/auth.ts'), 'export function login() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Path-scoped summary symbol lists',
        goal: 'Do not repeat unverified symbols in declaration lists',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'src/auth.ts exports login and logout.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('logout');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/auth.ts', symbol: 'login' }),
      }),
      expect.objectContaining({
        status: 'stale',
        reason: 'symbol_missing',
        claim: expect.objectContaining({ path: 'src/auth.ts', symbol: 'logout' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume verifies Oxford-comma path-scoped summary symbol lists', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-oxford-list-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(
      join(repoPath, 'src/auth.ts'),
      'export function login() { return true; }\nexport function logout() { return true; }\n',
    );

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Oxford comma summary symbol lists',
        goal: 'Do not miss symbols after comma-and separators',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'src/auth.ts exports login, logout, and refresh.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('refresh');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/auth.ts', symbol: 'login' }),
      }),
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/auth.ts', symbol: 'logout' }),
      }),
      expect.objectContaining({
        status: 'stale',
        reason: 'symbol_missing',
        claim: expect.objectContaining({ path: 'src/auth.ts', symbol: 'refresh' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume keeps summary path-scoped symbols verified on the referenced path despite stale historical claims', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-current-symbol-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/new.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Summary current symbol',
        goal: 'Current summary claims should beat stale historical claims',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'src/new.ts implements presentSymbol.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/old.ts:presentSymbol'],
          outcome: 'historical answer referenced old symbol path',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        },
      ],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).toBe('src/new.ts implements presentSymbol.');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'stale',
        reason: 'file_missing',
        claim: expect.objectContaining({ path: 'src/old.ts', symbol: 'presentSymbol' }),
      }),
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/new.ts', symbol: 'presentSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume withholds stale path-scoped summary claims even when another path has the same current symbol', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-same-symbol-different-path-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/old.ts'), 'export function oldOnly() { return true; }\n');
    writeFileSync(join(repoPath, 'src/new.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Same symbol different paths',
        goal: 'Do not let current symbols on other paths mask stale path-scoped claims',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'src/old.ts implements presentSymbol. src/new.ts implements presentSymbol.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('src/old.ts');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'stale',
        reason: 'symbol_missing',
        claim: expect.objectContaining({ path: 'src/old.ts', symbol: 'presentSymbol' }),
      }),
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/new.ts', symbol: 'presentSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume keeps path-scoped summary symbols when branch-unknown history is for a different path', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-branch-unknown-different-path-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/new.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Summary branch unknown different path',
        goal: 'Do not let unrelated branch-sensitive history suppress current summary facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: null,
        current_summary: 'src/new.ts implements presentSymbol.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/old.ts:presentSymbol:branch=branch-a'],
          outcome: 'historical branch-specific answer for a different file',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        },
      ],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).toBe('src/new.ts implements presentSymbol.');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'unverifiable',
        reason: 'branch_unknown',
        claim: expect.objectContaining({
          path: 'src/old.ts',
          symbol: 'presentSymbol',
          branch_name: 'branch-a',
        }),
      }),
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/new.ts', symbol: 'presentSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume withholds path-scoped summary symbol claims when branch-sensitive provenance has unknown current branch', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-branch-unknown-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Summary branch unknown',
        goal: 'Unknown task branch should not be masked by current file contents',
        status: 'active',
        repo_path: repoPath,
        branch_name: null,
        current_summary: 'src/example.ts implements presentSymbol on branch-a.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/example.ts:presentSymbol:branch=branch-a'],
          outcome: 'historical branch-specific answer',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        },
      ],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('presentSymbol');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'unverifiable',
        reason: 'branch_unknown',
        claim: expect.objectContaining({
          path: 'src/example.ts',
          symbol: 'presentSymbol',
          branch_name: 'branch-a',
        }),
      }),
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/example.ts', symbol: 'presentSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume withholds branch-mismatched summary text even when the current file still contains the symbol', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-branch-mismatch-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Summary branch mismatch',
        goal: 'Do not repeat stale branch-specific summary facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'branch-b',
        current_summary: 'src/example.ts implements presentSymbol on branch-a.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/example.ts:presentSymbol:branch=branch-a'],
          outcome: 'historical branch-specific answer',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        },
      ],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('branch-a');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'stale',
        reason: 'branch_mismatch',
        claim: expect.objectContaining({
          path: 'src/example.ts',
          symbol: 'presentSymbol',
          branch_name: 'branch-a',
        }),
      }),
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/example.ts', symbol: 'presentSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume withholds summary-only backticked symbol claims that have no located source path', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-symbol-'));

  try {
    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Summary symbol claims',
        goal: 'Do not repeat unlocated symbol facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: '`MissingSymbol` is implemented.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('MissingSymbol');
    expect(resume.code_claim_verification).toEqual([
      expect.objectContaining({
        status: 'unverifiable',
        reason: 'symbol_path_missing',
        claim: expect.objectContaining({ symbol: 'MissingSymbol' }),
      }),
    ]);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume withholds summary-only code claims when repo context is missing', async () => {
  const engine = {
    getTaskThread: async () => ({
      id: 'task-1',
      scope: 'work',
      title: 'Missing repo summary',
      goal: 'Do not repeat unverified summary code facts',
      status: 'active',
      repo_path: null,
      branch_name: null,
      current_summary: '`MissingSymbol` is implemented.',
      created_at: new Date('2026-04-25T00:00:00.000Z'),
      updated_at: new Date('2026-04-25T00:01:00.000Z'),
    }),
    getTaskWorkingSet: async () => null,
    listTaskAttempts: async () => [],
    listTaskDecisions: async () => [],
    listRetrievalTraces: async () => [],
    getRetrievalTrace: async () => null,
  } as any;

  const resume = await buildTaskResumeCard(engine, 'task-1');

  expect(resume.current_summary).not.toContain('MissingSymbol');
  expect(resume.code_claim_verification).toEqual([
    expect.objectContaining({
      status: 'unverifiable',
      reason: 'repo_missing',
      claim: expect.objectContaining({ symbol: 'MissingSymbol' }),
    }),
  ]);
});

test('resume withholds summary-only backticked member symbol claims that have no located source path', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-member-symbol-'));

  try {
    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Summary member claims',
        goal: 'Do not repeat unlocated member symbol facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: '`foo.bar` is implemented.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('foo.bar');
    expect(resume.code_claim_verification).toEqual([
      expect.objectContaining({
        status: 'unverifiable',
        reason: 'symbol_path_missing',
        claim: expect.objectContaining({ symbol: 'foo.bar' }),
      }),
    ]);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume verifies summary-only code paths before returning the summary', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-summary-claim-'));

  try {
    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Summary-only claims',
        goal: 'Do not repeat stale summary facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'The previous answer said src/missing.ts.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('src/missing.ts');
    expect(resume.code_claim_verification).toEqual([
      expect.objectContaining({
        status: 'stale',
        reason: 'file_missing',
        claim: expect.objectContaining({ path: 'src/missing.ts' }),
      }),
    ]);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume verifies extensionless allowlisted root code paths before returning the summary', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-extensionless-root-path-'));

  try {
    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Extensionless root path claims',
        goal: 'Do not repeat stale Dockerfile facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'Dockerfile runs bun test.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('Dockerfile');
    expect(resume.code_claim_verification).toEqual([
      expect.objectContaining({
        status: 'stale',
        reason: 'file_missing',
        claim: expect.objectContaining({ path: 'Dockerfile' }),
      }),
    ]);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume verifies summary-only root code paths before returning the summary', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-root-path-claim-'));

  try {
    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Root path claims',
        goal: 'Do not repeat stale root path facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'main',
        current_summary: 'README.md contains setup instructions.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => null,
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.current_summary).not.toContain('README.md');
    expect(resume.code_claim_verification).toEqual([
      expect.objectContaining({
        status: 'stale',
        reason: 'file_missing',
        claim: expect.objectContaining({ path: 'README.md' }),
      }),
    ]);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume blocks branch-sensitive working-set facts when the task branch is unknown', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-branch-unknown-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Unknown branch',
        goal: 'Do not repeat branch-sensitive facts without branch context',
        status: 'active',
        repo_path: repoPath,
        branch_name: null,
        current_summary: 'Use presentSymbol on branch-a.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => ({
        task_id: 'task-1',
        active_paths: ['src/example.ts'],
        active_symbols: ['presentSymbol'],
        blockers: [],
        open_questions: [],
        next_steps: [],
        verification_notes: [],
        last_verified_at: new Date('2026-04-25T00:01:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/example.ts:presentSymbol:branch=branch-a'],
          outcome: 'historical branch-specific answer',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        },
      ],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.active_paths).toEqual([]);
    expect(resume.active_symbols).toEqual([]);
    expect(resume.current_summary).not.toContain('presentSymbol');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'unverifiable',
        reason: 'branch_unknown',
        claim: expect.objectContaining({
          path: 'src/example.ts',
          symbol: 'presentSymbol',
          branch_name: 'branch-a',
        }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test('resume keeps current working-set facts when same-path historical branch claim mismatches current branch', async () => {
  const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-task-resume-branch-mismatch-current-'));

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

    const engine = {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Branch mismatch current working set',
        goal: 'Do not let branch-A history erase branch-B verified facts',
        status: 'active',
        repo_path: repoPath,
        branch_name: 'branch-b',
        current_summary: 'Continue editing src/example.ts.',
        created_at: new Date('2026-04-25T00:00:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      getTaskWorkingSet: async () => ({
        task_id: 'task-1',
        active_paths: ['src/example.ts'],
        active_symbols: ['presentSymbol'],
        blockers: [],
        open_questions: [],
        next_steps: [],
        verification_notes: [],
        last_verified_at: new Date('2026-04-25T00:01:00.000Z'),
        updated_at: new Date('2026-04-25T00:01:00.000Z'),
      }),
      listTaskAttempts: async () => [],
      listTaskDecisions: async () => [],
      listRetrievalTraces: async () => [
        {
          id: 'trace-source',
          task_id: 'task-1',
          scope: 'work',
          route: ['task_resume'],
          source_refs: ['task-thread:task-1'],
          verification: ['code_claim:src/example.ts:presentSymbol:branch=branch-a'],
          outcome: 'historical branch-specific answer',
          created_at: new Date('2026-04-25T00:01:00.000Z'),
        },
      ],
      getRetrievalTrace: async () => null,
    } as any;

    const resume = await buildTaskResumeCard(engine, 'task-1');

    expect(resume.active_paths).toEqual(['src/example.ts']);
    expect(resume.active_symbols).toEqual(['presentSymbol']);
    expect(resume.current_summary).toBe('Continue editing src/example.ts.');
    expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'stale',
        reason: 'branch_mismatch',
        claim: expect.objectContaining({
          path: 'src/example.ts',
          symbol: 'presentSymbol',
          branch_name: 'branch-a',
        }),
      }),
      expect.objectContaining({
        status: 'current',
        reason: 'ok',
        claim: expect.objectContaining({ path: 'src/example.ts', symbol: 'presentSymbol' }),
      }),
    ]));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});
